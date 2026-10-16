#!/usr/bin/env node
/**
 * OVD-876: flag commands that can push to, migrate or reset a linked or
 * production Supabase project from runnable repository files.
 *
 * Scope: tracked files under .github/, scripts/ and worker/, plus the
 * `scripts` entries of package.json. Docs (*.md and docs/**) are exempt. The
 * staging ref is not a production ref and is never flagged.
 *
 * Patterns: `supabase db push`, `--linked`, `--db-url`, `migration up` (which
 * covers `supabase migration up`), `db reset --linked`, and the production
 * project ref. One line can match several patterns.
 *
 * Existing hits are listed in scripts/check-prod-push-baseline.json, keyed by
 * file, pattern and a hash of the trimmed line, with a count. A hit passes
 * while its file holds no more copies of that line than recorded, so moving a
 * line does not flag it but adding one does. In diff mode the baseline is read
 * from the merge-base when it has one, so a change cannot baseline its own hits.
 *
 * Self-exemption: this checker, its tests and its baseline spell out the
 * patterns they look for, so SELF_EXEMPT skips them by path. The production ref
 * below is joined from two halves so no file in the repository holds it as one
 * literal on account of this scan.
 *
 * Usage:
 *   node scripts/check-prod-push.mjs --all [--write-baseline]
 *   node scripts/check-prod-push.mjs --base-ref <ref>
 *   node scripts/check-prod-push.mjs <file> ...
 * Options: --root <dir> (repository root, default cwd), --baseline <path>,
 *   --json, --report (default) or --enforce.
 * Report mode prints findings to stdout, appends a summary to
 * $GITHUB_STEP_SUMMARY when it is set, and exits 0 even on findings or scan
 * errors. --enforce exits 1 on new findings. Usage errors exit 2.
 *
 * test:portable-node runs the base commit's copy of this file, so it must stay
 * a single dependency-free module. It never connects to any Supabase project.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GIT_BIN = "/usr/bin/git";
export const CHECKER_PATH = "scripts/check-prod-push.mjs";
export const BASELINE_PATH = "scripts/check-prod-push-baseline.json";
export const BASELINE_SCHEMA = "prod-push-baseline.v1";
export const SCAN_ROOTS = [".github/", "scripts/", "worker/"];
export const PACKAGE_JSON = "package.json";
export const SELF_EXEMPT = new Set([
  CHECKER_PATH,
  "scripts/check-prod-push.node-test.mjs",
  "scripts/check-prod-push.test.mjs",
  BASELINE_PATH,
]);

const PROD_REF = ["ozuatdcake", "zjtevztjlr"].join("");

export const PATTERNS = [
  { id: "supabase_db_push", regex: /\bsupabase\s+db\s+push\b/ },
  { id: "linked_flag", regex: /--linked\b/ },
  { id: "db_url_flag", regex: /--db-url\b/ },
  { id: "migration_up", regex: /\bmigration\s+up\b/ },
  { id: "db_reset_linked", regex: /\bdb\s+reset\s+--linked\b/ },
  { id: "prod_project_ref", regex: new RegExp(PROD_REF) },
];

export function isDocPath(file) {
  return /\.md$/i.test(file) || file.startsWith("docs/");
}

export function isInScope(file) {
  if (SELF_EXEMPT.has(file) || isDocPath(file)) return false;
  return file === PACKAGE_JSON || SCAN_ROOTS.some((root) => file.startsWith(root));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function matchLine(file, line, text, location = null) {
  const trimmed = text.trim();
  return PATTERNS.filter((pattern) => pattern.regex.test(text)).map((pattern) => ({
    file,
    line,
    ...(location ? { location } : {}),
    pattern: pattern.id,
    text: trimmed,
    lineSha256: sha256(location ? `${location}: ${trimmed}` : trimmed),
  }));
}

/** Findings for one file. package.json contributes only its `scripts` entries. */
export function scanText(file, text) {
  if (!isInScope(file) || text.includes("\0")) return [];
  const lines = text.split(/\r?\n/);
  if (file === PACKAGE_JSON) {
    let scripts;
    try {
      scripts = JSON.parse(text).scripts ?? {};
    } catch {
      return [];
    }
    return Object.entries(scripts).flatMap(([name, command]) => {
      const index = lines.findIndex((line) => line.includes(JSON.stringify(name) + ":"));
      return matchLine(file, index + 1, String(command), `scripts.${name}`);
    });
  }
  return lines.flatMap((text, index) => matchLine(file, index + 1, text));
}

function git(root, args) {
  return execFileSync(GIT_BIN, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function splitZ(output) {
  return output.split("\0").filter(Boolean);
}

export function listTrackedFiles(root) {
  return splitZ(git(root, ["ls-files", "-z"]));
}

export function listChangedFiles(root, baseRef) {
  const mergeBase = git(root, ["merge-base", baseRef, "HEAD"]).trim();
  const files = splitZ(git(root, ["diff", "--name-only", "-z", "--diff-filter=ACMR", mergeBase]));
  // Untracked files count locally; a CI checkout has none.
  files.push(...splitZ(git(root, ["ls-files", "-z", "--others", "--exclude-standard"])));
  return { mergeBase, files };
}

function readFileOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null;
    throw error;
  }
}

export function scanFiles(root, files) {
  return [...new Set(files)]
    .filter(isInScope)
    .sort()
    .flatMap((file) => {
      const text = readFileOrNull(path.resolve(root, file));
      return text === null ? [] : scanText(file, text);
    });
}

function findingKey(entry) {
  return `${entry.file}\0${entry.pattern}\0${entry.lineSha256}`;
}

function compareEntries(a, b) {
  return a.file.localeCompare(b.file, "en") || a.pattern.localeCompare(b.pattern, "en") ||
    a.lineSha256.localeCompare(b.lineSha256, "en");
}

export function buildBaseline(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    const entry = counts.get(key) ?? { file: finding.file, pattern: finding.pattern, lineSha256: finding.lineSha256, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return {
    schema: BASELINE_SCHEMA,
    description:
      "Existing prod-push scan hits (OVD-876). Generated by `node scripts/check-prod-push.mjs --all --write-baseline`. Entries may only be removed.",
    entries: [...counts.values()].sort(compareEntries),
  };
}

export function formatBaseline(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function parseBaseline(text) {
  const baseline = JSON.parse(text);
  if (baseline?.schema !== BASELINE_SCHEMA || !Array.isArray(baseline.entries)) {
    throw new Error(`baseline is not a ${BASELINE_SCHEMA} document`);
  }
  return baseline;
}

/** Marks each finding baselined while its key has recorded copies left. */
export function applyBaseline(findings, baseline) {
  const remaining = new Map();
  for (const entry of baseline?.entries ?? []) remaining.set(findingKey(entry), entry.count);
  return findings.map((finding) => {
    const key = findingKey(finding);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    return { ...finding, baselined: left > 0 };
  });
}

function clip(text, max = 200) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function where(finding) {
  return `${finding.file}:${finding.line}${finding.location ? ` (${finding.location})` : ""}`;
}

export function formatReport(report) {
  const fresh = report.findings.filter((finding) => !finding.baselined);
  const lines = fresh.map((finding) => `${where(finding)}: [${finding.pattern}] ${clip(finding.text)}`);
  lines.push(
    `prod-push scan (${report.mode}, ${report.enforce ? "enforce" : "report"}): ${report.scannedFiles} file(s) scanned, ` +
      `${fresh.length} new finding(s), ${report.findings.length - fresh.length} baselined`,
  );
  return `${lines.join("\n")}\n`;
}

function markdownCell(text) {
  return clip(text, 120).replace(/\|/g, "\\|").replace(/`/g, "'");
}

export function formatStepSummary(report) {
  const fresh = report.findings.filter((finding) => !finding.baselined);
  const lines = [
    `### Prod-push scan (${report.enforce ? "enforce" : "report"} mode)`,
    "",
    `${report.scannedFiles} file(s) scanned in ${report.mode} mode: ${fresh.length} new finding(s), ` +
      `${report.findings.length - fresh.length} baselined.`,
  ];
  if (fresh.length > 0) {
    lines.push("", "| Location | Pattern | Line |", "| --- | --- | --- |");
    for (const finding of fresh) {
      lines.push(`| ${markdownCell(where(finding))} | ${finding.pattern} | \`${markdownCell(finding.text)}\` |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const USAGE =
  "usage: check-prod-push.mjs (--all [--write-baseline] | --base-ref <ref> | <file> ...) " +
  "[--root <dir>] [--baseline <path>] [--json] [--report | --enforce]";

export class UsageError extends Error {}

export function parseArgs(argv) {
  const options = { files: [], enforce: false };
  const valued = new Map([["--root", "root"], ["--baseline", "baseline"], ["--base-ref", "baseRef"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valued.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      options[valued.get(arg)] = value;
      index += 1;
    } else if (arg === "--all") options.all = true;
    else if (arg === "--write-baseline") options.writeBaseline = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--report") options.enforce = false;
    else if (arg === "--enforce") options.enforce = true;
    else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  const modes = [options.all, options.baseRef !== undefined, options.files.length > 0].filter(Boolean).length;
  if (modes !== 1) throw new UsageError("choose exactly one of --all, --base-ref or file arguments");
  if (options.writeBaseline && !options.all) throw new UsageError("--write-baseline requires --all");
  return options;
}

function loadBaseline(root, options, mergeBase) {
  if (mergeBase && !options.baseline) {
    let text = null;
    try {
      text = git(root, ["show", `${mergeBase}:${BASELINE_PATH}`]);
    } catch {
      text = null;
    }
    if (text !== null) return { baseline: parseBaseline(text), source: `${mergeBase.slice(0, 12)}:${BASELINE_PATH}` };
  }
  const file = options.baseline ?? BASELINE_PATH;
  const text = readFileOrNull(path.resolve(root, file));
  return { baseline: text === null ? null : parseBaseline(text), source: text === null ? null : file };
}

/** Runs one scan. Returns the exit code; never touches a database. */
export function run(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd() } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`check-prod-push: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  const root = path.resolve(cwd, options.root ?? ".");
  try {
    let files;
    let mode;
    let mergeBase = null;
    if (options.all) {
      mode = "full";
      files = listTrackedFiles(root);
    } else if (options.baseRef !== undefined) {
      mode = "diff";
      ({ mergeBase, files } = listChangedFiles(root, options.baseRef));
    } else {
      mode = "files";
      files = options.files.map((file) => path.relative(root, path.resolve(cwd, file)).split(path.sep).join("/"));
    }
    const raw = scanFiles(root, files);
    if (options.writeBaseline) {
      const target = path.resolve(root, options.baseline ?? BASELINE_PATH);
      writeFileSync(target, formatBaseline(buildBaseline(raw)));
      stdout.write(`check-prod-push: wrote ${raw.length} hit(s) to ${path.relative(root, target) || target}\n`);
      return 0;
    }
    const { baseline, source } = loadBaseline(root, options, mergeBase);
    const findings = applyBaseline(raw, baseline);
    const report = {
      mode,
      enforce: options.enforce,
      mergeBase,
      baseline: source,
      scannedFiles: new Set(files.filter(isInScope)).size,
      findings,
    };
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, formatStepSummary(report));
    const fresh = findings.filter((finding) => !finding.baselined).length;
    return options.enforce && fresh > 0 ? 1 : 0;
  } catch (error) {
    stderr.write(`check-prod-push: ${options.enforce ? "error" : "scan error (report mode, not failing)"}: ${error.message}\n`);
    return options.enforce ? 2 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
