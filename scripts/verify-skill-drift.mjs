#!/usr/bin/env node
/**
 * OVD-858: read-only drift detector for the verify-overdrafter feature map.
 *
 * Compares the skill's feature map (SKILL.md, features/*.md, helper scripts) to the app:
 * React Router routes in src/App.tsx, Playwright specs under e2e/, and repo paths the map
 * cites. It never edits anything. The weekly maintain-verification-skill run reads the
 * report (docs/runbooks/verify-skill-maintenance.md).
 *
 *   node scripts/verify-skill-drift.mjs [--root DIR] [--skill-dir DIR] [--json FILE] [--markdown FILE]
 *   node scripts/verify-skill-drift.mjs select-pr --outcome clean|changed|blocked --prs FILE
 *
 * Exit codes: 0 no drift (or skill absent), 1 drift, 2 usage or config error.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SKILL_DIR = ".agents/skills/verify-overdrafter";
export const APP_ROUTES_FILE = "src/App.tsx";
export const E2E_DIR = "e2e";
export const IGNORE_FILE = "drift-ignore.json";
export const MAINTENANCE_BRANCH = "chore/verify-skill-maintenance";
export const MAINTENANCE_LABEL = "verify-skill-maintenance";

/** Code-unit order, identical to the default `Array#sort` for strings. */
const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const stripTrailingSlashes = (route) => {
  if (route.length <= 1) return route;
  let end = route.length;
  while (end > 0 && route[end - 1] === "/") end -= 1;
  return route.slice(0, end);
};

/** `/parts/:jobId` and `/parts/<id>` both become `/parts/:param`. */
export function normalizeRoute(route) {
  return stripTrailingSlashes(route).replace(/\/(?::[\w-]+|<[^>/]+>)/g, "/:param");
}

export function extractAppRoutes(source) {
  const routes = [...source.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  return [...new Set(routes.filter((r) => r.startsWith("/")))].sort(compareCodeUnits);
}

export function extractSpecPaths(text) {
  return [...new Set([...text.matchAll(/\be2e\/[\w./-]+\.spec\.ts\b/g)].map((m) => m[0]))].sort(compareCodeUnits);
}

const stripFences = (markdown) => markdown.replace(/^```[\s\S]*?^```/gm, "");
const inlineCode = (markdown) => [...stripFences(markdown).matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());

/** Inline-code tokens that look like app routes (`/parts/<id>`) or repo paths (`e2e/auth.mjs`). */
export function extractMarkdownReferences(markdown) {
  const routes = new Set();
  const paths = new Set();
  for (const token of inlineCode(markdown)) {
    if (/\s|[*$?]/.test(token) || /^(?:https?:|@)/.test(token)) continue;
    if (/^\/[\w\-/:<>]*$/.test(token)) {
      routes.add(token);
    } else if (/^[\w.@-]+(?:\/[\w.@-]+)+\/?$/.test(token) && !/^e2e\/.+\.spec\.ts$/.test(token)) {
      paths.add(token.replace(/^\.\//, ""));
    }
  }
  return { routes: [...routes].sort(compareCodeUnits), paths: [...paths].sort(compareCodeUnits) };
}

export function readIgnore(raw) {
  const config = raw ? JSON.parse(raw) : {};
  const out = {};
  for (const kind of ["routes", "specs", "paths"]) {
    const entries = config[kind] ?? [];
    if (!Array.isArray(entries)) throw new Error(`${IGNORE_FILE}: "${kind}" must be an array`);
    for (const entry of entries) {
      if (typeof entry?.pattern !== "string" || typeof entry?.reason !== "string" || !entry.reason.trim()) {
        throw new Error(`${IGNORE_FILE}: every ${kind} entry needs a "pattern" and a non-empty "reason"`);
      }
    }
    out[kind] = entries.map((e) => e.pattern);
  }
  return out;
}

const matches = (value, patterns) =>
  patterns.some((p) => (p.endsWith("*") ? value.startsWith(p.slice(0, -1)) : value === p));

/**
 * Pure comparison. `skill.files` is `[{ name, text }]` relative to the skill dir;
 * `app` carries the app's routes, spec paths and a path-existence predicate.
 */
function checkIndex(markdown, add) {
  const features = markdown.filter((f) => /^features\/[^/]+\.md$/.test(f.name) && f.name !== "features/README.md");
  const index = markdown.find((f) => f.name === "features/README.md");
  if (!index) {
    add("missing-index", "features/README.md", "features/", "feature map has no README index");
    return features;
  }
  const linked = [...index.text.matchAll(/\]\(\.\/([\w.-]+\.md)\)/g)].map((m) => `features/${m[1]}`);
  for (const link of new Set(linked)) {
    if (!features.some((f) => f.name === link)) add("dead-index-link", link, "features/README.md", "index links a feature file that does not exist");
  }
  for (const f of features) {
    if (!linked.includes(f.name)) add("unindexed-feature", f.name, f.name, "feature file is not linked from features/README.md");
  }
  return features;
}

function checkSpecs(file, app, mappedSpecs, add) {
  for (const spec of extractSpecPaths(file.text)) {
    mappedSpecs.add(spec);
    if (!app.specs.includes(spec)) add("stale-spec", spec, file.name, "map names an e2e spec that does not exist");
  }
}

function checkMarkdownRefs(file, { app, appRoutes, ignore, mappedRoutes }, add) {
  const refs = extractMarkdownReferences(file.text);
  for (const route of refs.routes) {
    const key = normalizeRoute(route);
    mappedRoutes.add(key);
    if (!appRoutes.has(key) && !matches(route, ignore.routes)) add("stale-route", route, file.name, `no route in ${APP_ROUTES_FILE}`);
  }
  for (const ref of refs.paths) {
    if (!matches(ref, ignore.paths) && !app.pathExists(ref, path.posix.dirname(file.name))) {
      add("missing-path", ref, file.name, "referenced path not found from repo root, skill dir or the citing file");
    }
  }
}

function checkUnmapped({ app, appRoutes, ignore, mappedRoutes, mappedSpecs }, add) {
  for (const [key, route] of appRoutes) {
    if (!mappedRoutes.has(key) && !matches(route, ignore.routes)) add("unmapped-route", route, APP_ROUTES_FILE, "app route not covered by any feature file");
  }
  for (const spec of app.specs) {
    if (!mappedSpecs.has(spec) && !matches(spec, ignore.specs)) add("unmapped-spec", spec, E2E_DIR, "e2e spec not named by the feature map");
  }
}

export function detectDrift({ skill, app, ignore = { routes: [], specs: [], paths: [] } }) {
  const findings = [];
  const add = (kind, item, source, detail) => findings.push({ kind, item, source, detail });
  const features = checkIndex(skill.files.filter((f) => f.name.endsWith(".md")), add);

  const ctx = {
    app,
    appRoutes: new Map(app.routes.map((r) => [normalizeRoute(r), r])),
    ignore,
    mappedRoutes: new Set(),
    mappedSpecs: new Set(),
  };
  for (const file of skill.files) {
    checkSpecs(file, app, ctx.mappedSpecs, add);
    if (file.name.endsWith(".md")) checkMarkdownRefs(file, ctx, add);
  }
  checkUnmapped(ctx, add);

  const seen = new Set();
  const unique = findings
    .filter((f) => (seen.has(`${f.kind}|${f.item}|${f.source}`) ? false : seen.add(`${f.kind}|${f.item}|${f.source}`)))
    .sort((a, b) => `${a.kind}|${a.item}|${a.source}`.localeCompare(`${b.kind}|${b.item}|${b.source}`));
  const counts = {};
  for (const f of unique) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return {
    status: unique.length ? "drift" : "clean",
    counts,
    checked: { featureFiles: features.length, appRoutes: app.routes.length, e2eSpecs: app.specs.length },
    findings: unique,
  };
}

/**
 * At most one maintenance PR per run. Reuse an open same-repo PR on the fixed branch
 * (preferred) or carrying the label; only `changed` runs ever push or create.
 */
export function selectMaintenancePr({ outcome, openPrs = [] }) {
  if (!["clean", "changed", "blocked"].includes(outcome)) throw new Error(`unknown outcome: ${outcome}`);
  const labelNames = (pr) => (pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const candidates = openPrs
    .filter((pr) => (pr.state ?? "OPEN").toUpperCase() === "OPEN" && !pr.isCrossRepository)
    .filter((pr) => pr.headRefName === MAINTENANCE_BRANCH || labelNames(pr).includes(MAINTENANCE_LABEL))
    .sort((a, b) => Number(b.headRefName === MAINTENANCE_BRANCH) - Number(a.headRefName === MAINTENANCE_BRANCH) || a.number - b.number);
  const [existing, ...duplicates] = candidates;
  const extra = { duplicates: duplicates.map((pr) => pr.number) };
  if (outcome !== "changed") {
    return { action: "none", reason: `outcome ${outcome}: nothing to ship`, existing: existing?.number ?? null, ...extra };
  }
  if (existing) {
    return { action: "update", pr: existing.number, branch: existing.headRefName, label: MAINTENANCE_LABEL, reason: "reuse the open maintenance PR", ...extra };
  }
  return { action: "create", branch: MAINTENANCE_BRANCH, label: MAINTENANCE_LABEL, reason: "no open maintenance PR", ...extra };
}

export function renderMarkdown(report) {
  const lines = ["# verify-overdrafter feature-map drift", "", `Status: **${report.status}**`, ""];
  if (report.status === "absent") {
    lines.push(report.message, "");
    return lines.join("\n");
  }
  const { featureFiles, appRoutes, e2eSpecs } = report.checked;
  lines.push(`Checked ${featureFiles} feature files against ${appRoutes} app routes and ${e2eSpecs} e2e specs in \`${report.skillDir}\`.`, "");
  if (!report.findings.length) return [...lines, "No drift found.", ""].join("\n");
  lines.push("| Kind | Item | Source | Detail |", "| --- | --- | --- | --- |");
  for (const f of report.findings) lines.push(`| ${f.kind} | \`${f.item}\` | \`${f.source}\` | ${f.detail} |`);
  return [...lines, ""].join("\n");
}

function listFiles(dir, pattern, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, pattern, base);
    return pattern.test(entry.name) ? [path.relative(base, full).split(path.sep).join("/")] : [];
  }).sort(compareCodeUnits);
}

const gitIgnored = (root, rel) =>
  spawnSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: root }).status === 0;

/** Filesystem layer: gather inputs, then delegate to detectDrift. */
export function runDetector({ root, skillDir = DEFAULT_SKILL_DIR, isIgnored = gitIgnored }) {
  const absSkill = path.resolve(root, skillDir);
  if (!existsSync(path.join(absSkill, "features"))) {
    return {
      status: "absent",
      skillDir,
      message: `No feature map at ${skillDir}/features (verify-overdrafter lands with OVD-842). Nothing to compare; exiting 0.`,
    };
  }
  const ignorePath = path.join(absSkill, IGNORE_FILE);
  const ignore = readIgnore(existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "");
  const files = listFiles(absSkill, /\.(md|mjs|sh)$/).map((name) => ({ name, text: readFileSync(path.join(absSkill, name), "utf8") }));
  const appSource = existsSync(path.join(root, APP_ROUTES_FILE)) ? readFileSync(path.join(root, APP_ROUTES_FILE), "utf8") : "";
  const specs = existsSync(path.join(root, E2E_DIR))
    ? listFiles(path.join(root, E2E_DIR), /\.spec\.ts$/).map((f) => `${E2E_DIR}/${f}`)
    : [];
  const pathExists = (ref, citingDir) => {
    const candidates = [path.resolve(root, ref), path.resolve(absSkill, ref), path.resolve(absSkill, citingDir, ref)];
    return candidates.some((c) => existsSync(c)) || isIgnored(root, ref);
  };
  const result = detectDrift({ skill: { files }, app: { routes: extractAppRoutes(appSource), specs, pathExists }, ignore });
  return { skillDir, ...result };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument: ${flag}`);
    i += 1;
    opts[flag.slice(2)] = argv[i];
  }
  return opts;
}

function main(argv) {
  if (argv[0] === "select-pr") {
    const opts = parseArgs(argv.slice(1));
    const openPrs = opts.prs ? JSON.parse(readFileSync(opts.prs, "utf8")) : [];
    console.log(JSON.stringify(selectMaintenancePr({ outcome: opts.outcome, openPrs }), null, 2));
    return 0;
  }
  const opts = parseArgs(argv);
  const report = { schema: "ovd858.verify-skill-drift.v1", ...runDetector({ root: path.resolve(opts.root ?? "."), skillDir: opts["skill-dir"] }) };
  const markdown = renderMarkdown(report);
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.markdown) writeFileSync(opts.markdown, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(markdown);
  return report.status === "drift" ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-skill-drift: ${error.message}`);
    process.exitCode = 2;
  }
}
