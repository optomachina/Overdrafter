#!/usr/bin/env node
import { resolveFixedBinary } from "./lib/fixed-binaries.mjs";
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
 * "Absent" means the default skill directory or its SKILL.md is missing; a skill without
 * features/ is drift. An explicit --root or --skill-dir that does not exist is exit 2.
 */
import { isEntryPoint } from "./lib/entry-point.mjs";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_SKILL_DIR = ".agents/skills/verify-overdrafter";
export const APP_ROUTES_FILE = "src/App.tsx";
export const E2E_DIR = "e2e";
export const IGNORE_FILE = "drift-ignore.json";
export const MAINTENANCE_BRANCH = "chore/verify-skill-maintenance";
export const MAINTENANCE_LABEL = "verify-skill-maintenance";

/** Code-unit order, identical to the default `Array#sort` for strings. */
function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Fixed, root-owned binary directories. The caller's PATH is never consulted. */
const SAFE_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"];
const SAFE_ENV = { ...process.env, PATH: SAFE_BIN_DIRS.join(":") };

/** Absolute path of `name` in the first SAFE_BIN_DIRS entry that has it. */
export function resolveBinary(name, options = {}) {
  return resolveFixedBinary(name, { dirs: SAFE_BIN_DIRS, ...options });
}

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

/** Absolute filesystem paths (`/tmp/out`, `/usr/bin`) are not app routes. */
const FILESYSTEM_ROOTS = /^\/(?:tmp|usr|bin|sbin|etc|var|opt|home|dev|proc|private|Users)(?:\/|$)/;

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/** A backtick fence's info string cannot contain a backtick, so "```x``` text" is inline code. */
const fenceOpener = (line) => {
  const m = FENCE_OPEN.exec(line);
  return m && !(m[1][0] === "`" && m[2].includes("`")) ? m[1] : null;
};

/** Closes on the same character, at least as long as the opener, with nothing after it. */
const closesFence = (line, fence) => {
  const m = FENCE_CLOSE.exec(line);
  return Boolean(m) && m[1][0] === fence[0] && m[1].length >= fence.length;
};

/** Index of the line that closes a fence opened at `start`, or -1 (not an opener, or unclosed). */
function fenceEnd(lines, start) {
  const fence = fenceOpener(lines[start]);
  if (!fence) return -1;
  for (let j = start + 1; j < lines.length; j += 1) {
    if (closesFence(lines[j], fence)) return j;
  }
  return -1;
}

/**
 * Drops fenced code blocks at any indent (list items indent them). Line-based, not a regex,
 * so an inline "```x```" cannot open a block. An unclosed fence is kept and still scanned:
 * a typo must not hide the rest of the file from the detector.
 */
export function stripFences(markdown) {
  const lines = markdown.split(/\r?\n/);
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const end = fenceEnd(lines, i);
    if (end === -1) kept.push(lines[i]);
    i = end === -1 ? i + 1 : end + 1;
  }
  return kept.join("\n");
}

const inlineCode = (markdown) => [...stripFences(markdown).matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());

/** Inline-code tokens that look like app routes (`/parts/<id>`) or repo paths (`e2e/auth.mjs`). */
export function extractMarkdownReferences(markdown) {
  const routes = new Set();
  const paths = new Set();
  for (const token of inlineCode(markdown)) {
    if (/\s|[*$?]/.test(token) || /^(?:https?:|@)/.test(token)) continue;
    if (/^\/[\w\-/:<>]*$/.test(token)) {
      if (FILESYSTEM_ROOTS.test(token)) continue;
      routes.add(token);
    } else if (/^[\w.@-]+(?:\/[\w.@-]+)+\/?$/.test(token) && !/^e2e\/.+\.spec\.ts$/.test(token)) {
      paths.add(token.replace(/^\.\//, ""));
    }
  }
  return { routes: [...routes].sort(compareCodeUnits), paths: [...paths].sort(compareCodeUnits) };
}

/** `runtimePaths`: cited paths that exist only at run time; present when gitignored. */
const IGNORE_KINDS = ["routes", "specs", "paths", "runtimePaths"];

export function readIgnore(raw) {
  const config = raw ? JSON.parse(raw) : {};
  const out = {};
  for (const kind of IGNORE_KINDS) {
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

export const matches = (value, patterns) =>
  patterns.some((p) => (p.endsWith("*") ? value.startsWith(p.slice(0, -1)) : value === p));

/** Route ignores match in normalized form, so `/parts/<id>` and `/parts/:jobId` are one entry. */
const matchesRoute = (route, patterns) => matches(normalizeRoute(route), patterns.map(normalizeRoute));

/**
 * Pure comparison. `skill.files` is `[{ name, text }]` relative to the skill dir;
 * `app` carries the app's routes, spec paths and a path-existence predicate.
 */
function checkIndex(markdown, add) {
  const features = markdown.filter((f) => /^features\/[^/]+\.md$/.test(f.name) && f.name !== "features/README.md");
  const index = markdown.find((f) => f.name === "features/README.md");
  if (!index) {
    const detail = features.length ? "feature map has no README index" : "skill has no features/ directory or it is empty";
    add("missing-index", "features/README.md", "features/", detail);
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
    if (!appRoutes.has(key) && !matchesRoute(route, ignore.routes)) add("stale-route", route, file.name, `no route in ${APP_ROUTES_FILE}`);
  }
  for (const ref of refs.paths) {
    if (!matches(ref, ignore.paths) && !app.pathExists(ref, path.posix.dirname(file.name))) {
      add("missing-path", ref, file.name, "referenced path not found from repo root, skill dir or the citing file");
    }
  }
}

function checkUnmapped({ app, appRoutes, ignore, mappedRoutes, mappedSpecs }, add) {
  for (const [key, route] of appRoutes) {
    if (!mappedRoutes.has(key) && !matchesRoute(route, ignore.routes)) add("unmapped-route", route, APP_ROUTES_FILE, "app route not covered by any feature file");
  }
  for (const spec of app.specs) {
    if (!mappedSpecs.has(spec) && !matches(spec, ignore.specs)) add("unmapped-spec", spec, E2E_DIR, "e2e spec not named by the feature map");
  }
}

export function detectDrift({ skill, app, ignore = { routes: [], specs: [], paths: [], runtimePaths: [] } }) {
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
    .sort((a, b) => compareCodeUnits(`${a.kind}|${a.item}|${a.source}`, `${b.kind}|${b.item}|${b.source}`));
  const counts = {};
  for (const f of unique) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return {
    status: unique.length ? "drift" : "clean",
    counts,
    checked: { featureFiles: features.length, appRoutes: app.routes.length, e2eSpecs: app.specs.length },
    findings: unique,
  };
}

/** `--prs` rows must look like `gh pr list --json` output, so a mangled merge fails closed. */
export function validatePrList(openPrs) {
  if (!Array.isArray(openPrs)) throw new Error("expected a JSON array of PRs");
  for (const pr of openPrs) {
    if (!Number.isInteger(pr?.number) || typeof pr?.headRefName !== "string") {
      throw new Error(`every PR needs an integer "number" and a string "headRefName"; got ${JSON.stringify(pr)}`);
    }
  }
  return openPrs;
}

/**
 * At most one maintenance PR per run. Only an open same-repo PR whose head is the fixed
 * branch is ours to update; the label is optional. Any other PR carrying the label or the
 * branch name (another author's branch, a fork) is listed in `foreign` and never touched.
 * Only `changed` runs ever push or create.
 */
export function selectMaintenancePr({ outcome, openPrs = [] }) {
  if (!["clean", "changed", "blocked"].includes(outcome)) throw new Error(`unknown outcome: ${outcome}`);
  const labelNames = (pr) => (pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const open = [...new Map(validatePrList(openPrs).map((pr) => [pr.number, pr])).values()]
    .filter((pr) => (pr.state ?? "OPEN").toUpperCase() === "OPEN")
    .sort((a, b) => a.number - b.number);
  const ours = (pr) => pr.headRefName === MAINTENANCE_BRANCH && !pr.isCrossRepository;
  const [existing, ...duplicates] = open.filter(ours);
  const extra = {
    duplicates: duplicates.map((pr) => pr.number),
    foreign: open
      .filter((pr) => !ours(pr) && (pr.headRefName === MAINTENANCE_BRANCH || labelNames(pr).includes(MAINTENANCE_LABEL)))
      .map((pr) => pr.number),
  };
  if (outcome !== "changed") {
    return { action: "none", reason: `outcome ${outcome}: nothing to ship`, existing: existing?.number ?? null, ...extra };
  }
  if (existing) {
    return { action: "update", pr: existing.number, branch: MAINTENANCE_BRANCH, label: MAINTENANCE_LABEL, reason: "reuse the open maintenance PR", ...extra };
  }
  return { action: "create", branch: MAINTENANCE_BRANCH, label: MAINTENANCE_LABEL, reason: "no open maintenance PR", ...extra };
}

/** Table cell as inline code; pipes and backticks would break the row. */
const cell = (value) => `\`${value.replace(/[|`]/g, (c) => (c === "|" ? "\\|" : "'"))}\``;

export function renderMarkdown(report) {
  const lines = ["# verify-overdrafter feature-map drift", "", `Status: **${report.status}**`, ""];
  if (report.status === "absent" || report.status === "error") {
    lines.push(report.message, "");
    return lines.join("\n");
  }
  const { featureFiles, appRoutes, e2eSpecs } = report.checked;
  lines.push(`Checked ${featureFiles} feature files against ${appRoutes} app routes and ${e2eSpecs} e2e specs in \`${report.skillDir}\`.`, "");
  if (!report.findings.length) return [...lines, "No drift found.", ""].join("\n");
  lines.push("| Kind | Item | Source | Detail |", "| --- | --- | --- | --- |");
  for (const f of report.findings) lines.push(`| ${f.kind} | ${cell(f.item)} | ${cell(f.source)} | ${f.detail} |`);
  return [...lines, ""].join("\n");
}

function listFiles(dir, pattern, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, pattern, base);
    return pattern.test(entry.name) ? [path.relative(base, full).split(path.sep).join("/")] : [];
  }).sort(compareCodeUnits);
}

export function gitIgnored(root, rel, { binary = resolveBinary("git"), run = spawnSync } = {}) {
  const result = run(binary, ["check-ignore", "-q", "--no-index", rel], { cwd: root, env: SAFE_ENV, encoding: "utf8" });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`git check-ignore failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  return result.status === 0;
}

const insideRoot = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Filesystem layer: gather inputs, then delegate to detectDrift. */
export function runDetector({ root, skillDir = DEFAULT_SKILL_DIR, isIgnored = gitIgnored }) {
  const absSkill = path.resolve(root, skillDir);
  if (!existsSync(path.join(absSkill, "SKILL.md"))) {
    return {
      status: "absent",
      skillDir,
      message: `No skill at ${skillDir} (no SKILL.md; verify-overdrafter lands with OVD-842). Nothing to compare; exiting 0.`,
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
    if (candidates.some((c) => insideRoot(root, c) && existsSync(c))) return true;
    return insideRoot(root, path.resolve(root, ref)) && matches(ref, ignore.runtimePaths) && isIgnored(root, ref);
  };
  const result = detectDrift({ skill: { files }, app: { routes: extractAppRoutes(appSource), specs, pathExists }, ignore });
  return { skillDir, ...result };
}

const DETECT_FLAGS = ["root", "skill-dir", "json", "markdown"];
const SELECT_FLAGS = ["outcome", "prs"];

/**
 * `--flag value` pairs. Unknown flags, a missing or empty value, and a value that is itself a
 * flag (`--root --json`) are usage errors, so a typo cannot fall back to defaults.
 */
export function parseArgs(argv, allowed) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--")) throw new Error(`bad argument: ${flag}`);
    const name = flag.slice(2);
    if (!allowed.includes(name)) throw new Error(`unknown flag: ${flag} (allowed: ${allowed.map((f) => `--${f}`).join(", ")})`);
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    opts[name] = value;
  }
  return opts;
}

const isDirectory = (dir) => existsSync(dir) && statSync(dir).isDirectory();

/**
 * "Absent" (exit 0) applies only to the default skill path. A `--root` or `--skill-dir`
 * given explicitly must exist (and the skill dir must hold SKILL.md), or it is a config error.
 */
export function resolveTargets(opts) {
  const root = path.resolve(opts.root ?? ".");
  if (opts.root !== undefined && !isDirectory(root)) throw new Error(`--root ${opts.root}: no such directory`);
  const skillDir = opts["skill-dir"] ?? DEFAULT_SKILL_DIR;
  if (opts["skill-dir"] !== undefined && !existsSync(path.join(path.resolve(root, skillDir), "SKILL.md"))) {
    throw new Error(`--skill-dir ${skillDir}: no SKILL.md under ${root}`);
  }
  return { root, skillDir };
}

function writeReport(report, opts) {
  const markdown = renderMarkdown(report);
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.markdown) writeFileSync(opts.markdown, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(markdown);
}

const SCHEMA = "ovd858.verify-skill-drift.v1";

function main(argv) {
  if (argv[0] === "select-pr") {
    const opts = parseArgs(argv.slice(1), SELECT_FLAGS);
    if (!opts.prs) throw new Error("select-pr needs --prs FILE (gh pr list JSON); refusing to assume no open PRs");
    const openPrs = JSON.parse(readFileSync(opts.prs, "utf8"));
    try {
      validatePrList(openPrs);
    } catch (error) {
      throw new Error(`--prs ${opts.prs}: ${error.message}`);
    }
    console.log(JSON.stringify(selectMaintenancePr({ outcome: opts.outcome, openPrs }), null, 2));
    return 0;
  }
  const opts = parseArgs(argv, DETECT_FLAGS);
  let report;
  try {
    report = { schema: SCHEMA, ...runDetector(resolveTargets(opts)) };
  } catch (error) {
    // Config errors still leave a report behind for the maintenance agent.
    writeReport({ schema: SCHEMA, status: "error", skillDir: opts["skill-dir"] ?? DEFAULT_SKILL_DIR, message: error.message }, opts);
    throw error;
  }
  writeReport(report, opts);
  return report.status === "drift" ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-skill-drift: ${error.message}`);
    process.exitCode = 2;
  }
}
