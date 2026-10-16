#!/usr/bin/env node
/**
 * OVD-873: the one sensitive-path matcher.
 *
 * docs/sensitive-paths.json is the single source of truth:
 *   {version: 1, description?, classes: {<class>: {label, description}}, globs: [{glob, class}]}
 * with exactly the classes in SENSITIVE_CLASSES. AGENTS.md mirrors the globs
 * between the sensitive-paths markers; scripts/validate-agent-contract.mjs
 * checks parity in both directions. The Jev PR screen, triage and the merge
 * gates (OVD-844, OVD-845) import this module and never copy the globs.
 *
 * Globs follow picomatch semantics with {dot: true, nocase: true}: dotfiles
 * and dot directories match, and matching ignores case, so a list built for
 * review routing errs towards matching. The supported syntax is *, **, ? and
 * {a,b} (nesting allowed); anything else is rejected so the semantics stay
 * within what the tests check against picomatch. The module has no
 * dependencies because gates run the base checkout's copy without installing.
 *
 * Gates read the JSON from the base checkout. A change that removes, narrows
 * or reclassifies a glob, or deletes or breaks the file, is gate_loosening
 * (needs a Grok Bot countersign on top of Blaine's card); additions are free.
 * An edit to this module or its report runner (REPORT_RUNNER_PATH, run by
 * `npm run test:portable-node`) is flagged as well. Report only: it never
 * changes the exit code.
 *
 * Usage:
 *   npm run sensitive-paths:report   (HEAD^1..HEAD, what CI reports)
 *   node scripts/lib/sensitive-paths.mjs classify [--base-ref <ref>] [--json] <path> ...
 *   node scripts/lib/sensitive-paths.mjs report --changed-files-from <name-status.txt> --base-ref HEAD^1 [--json-out <path>]
 * Options: --root <dir> (repository root, default cwd).
 * Exit codes: 0 (report mode), 2 usage or input error.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SENSITIVE_PATHS_FILE = "docs/sensitive-paths.json";
export const SENSITIVE_PATHS_VERSION = 1;
export const MATCHER_PATH = "scripts/lib/sensitive-paths.mjs";
// Runs the report inside `npm run test:portable-node` (CI runs it; no workflow of its own).
export const REPORT_RUNNER_PATH = "scripts/sensitive-paths-report.node-test.mjs";
// Not in the repository: a dedicated workflow that runs the base copy of this
// module is a future card item (Blaine's card). Listed so that adding it later
// is free and any edit after that is flagged.
export const PLANNED_WORKFLOW_PATH = ".github/workflows/sensitive-paths-report.yml";
export const REPORT_SCHEMA = "sensitive-paths-report.v1";
export const SENSITIVE_CLASSES = ["schema", "migrations", "auth", "payments", "provider_dispatch", "secrets", "infra_ci", "deps"];
export const AGENTS_BEGIN = "<!-- sensitive-paths:begin -->";
export const AGENTS_END = "<!-- sensitive-paths:end -->";

export const GATE_LOOSENING_REQUIRES = ["grokbot_countersign", "blaine_card"];
export const GATE_LOOSENING_LINE = "GATE LOOSENING: needs Grok Bot countersign + Blaine's card";
export const LOOSENING_GLOB_REMOVED = "glob_removed";
export const LOOSENING_GLOB_NARROWED = "glob_narrowed";
export const LOOSENING_GLOB_RECLASSIFIED = "glob_reclassified";
export const LOOSENING_CONFIG_REMOVED = "config_removed";
export const LOOSENING_CONFIG_INVALID = "config_invalid";
export const LOOSENING_MATCHER_CHANGED = "matcher_changed";
const MATCHER_FILES = [MATCHER_PATH, REPORT_RUNNER_PATH, PLANNED_WORKFLOW_PATH];

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

const GLOB_CHARS = /^[A-Za-z0-9._\-/*?{},]+$/;

/** Expand {a,b} groups (nested allowed). Throws on unbalanced or comma-less braces. */
export function expandBraces(glob) {
  const open = glob.indexOf("{");
  if (open === -1) {
    if (glob.includes("}")) throw new Error(`unbalanced } in ${glob}`);
    return [glob];
  }
  if (glob.slice(0, open).includes("}")) throw new Error(`unbalanced } in ${glob}`);
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let k = open; k < glob.length; k += 1) {
    if (glob[k] === "{") depth += 1;
    else if (glob[k] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = k;
        break;
      }
    } else if (glob[k] === "," && depth === 1) commas.push(k);
  }
  if (close === -1) throw new Error(`unbalanced { in ${glob}`);
  if (commas.length === 0) throw new Error(`brace group without a comma in ${glob}`);
  const bounds = [open, ...commas, close];
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  const out = [];
  for (let k = 0; k < bounds.length - 1; k += 1) {
    for (const expanded of expandBraces(`${head}${glob.slice(bounds[k] + 1, bounds[k + 1])}${tail}`)) out.push(expanded);
  }
  return out;
}

/** Problem with a glob's syntax, or null when supported. */
export function globProblem(glob) {
  if (typeof glob !== "string" || glob === "") return "glob must be a non-empty string";
  if (!GLOB_CHARS.test(glob)) return `unsupported character in ${glob} (allowed: letters, digits, . _ - / * ? { } ,)`;
  let expansions;
  try {
    expansions = expandBraces(glob);
  } catch (error) {
    return error.message;
  }
  for (const expansion of expansions) {
    const segments = expansion.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return `empty, . or .. segment in ${glob} (expansion ${expansion || "<empty>"})`;
    }
  }
  return null;
}

const escapeRegExp = (text) => text.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");

function segmentSource(segment) {
  // ** inside a segment acts like * (picomatch).
  return escapeRegExp(segment).replaceAll(/\*+/g, "[^/]*").replaceAll("?", "[^/]");
}

function expansionSource(expansion) {
  const segments = expansion.split("/").filter((segment, k, all) => !(segment === "**" && all[k - 1] === "**"));
  let source = "";
  segments.forEach((segment, k) => {
    if (segment === "**") {
      if (k === 0) source += segments.length === 1 ? ".*" : "(?:.*/)?";
      else source += "(?:/.*)?";
      return;
    }
    if (k > 0 && !(k === 1 && segments[0] === "**")) source += "/";
    source += segmentSource(segment);
  });
  return source;
}

/** Compile one glob to a RegExp with picomatch {dot: true, nocase: true} semantics. */
export function compileGlob(glob) {
  const problem = globProblem(glob);
  if (problem) throw new Error(problem);
  return new RegExp(`^(?:${expandBraces(glob).map(expansionSource).join("|")})$`, "i");
}

/** Normalise a repository path: forward slashes, no leading ./ or /. */
export function normalizePath(file) {
  return String(file).trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Validate a parsed or textual config. Throws with every problem listed. */
export function parseSensitivePaths(input) {
  const config = typeof input === "string" ? JSON.parse(input) : input;
  const problems = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${SENSITIVE_PATHS_FILE} must be an object`);
  if (config.version !== SENSITIVE_PATHS_VERSION) problems.push(`version must be ${SENSITIVE_PATHS_VERSION}`);
  const classes = config.classes && typeof config.classes === "object" ? Object.keys(config.classes) : [];
  const missing = SENSITIVE_CLASSES.filter((name) => !classes.includes(name));
  const unknown = classes.filter((name) => !SENSITIVE_CLASSES.includes(name));
  if (missing.length) problems.push(`classes missing: ${missing.join(", ")}`);
  if (unknown.length) problems.push(`unknown classes: ${unknown.join(", ")}`);
  if (!Array.isArray(config.globs) || config.globs.length === 0) problems.push("globs must be a non-empty array");
  const seen = new Set();
  for (const [index, entry] of (Array.isArray(config.globs) ? config.globs : []).entries()) {
    const where = `globs[${index}]`;
    if (!SENSITIVE_CLASSES.includes(entry?.class)) problems.push(`${where}: unknown class ${entry?.class}`);
    const problem = globProblem(entry?.glob);
    if (problem) problems.push(`${where}: ${problem}`);
    if (seen.has(entry?.glob)) problems.push(`${where}: duplicate glob ${entry.glob}`);
    seen.add(entry?.glob);
  }
  if (problems.length) throw new Error(`${SENSITIVE_PATHS_FILE}: ${problems.join("; ")}`);
  return config;
}

function readRefFile(root, ref, file) {
  try {
    return execFileSync("/usr/bin/git", ["show", `${ref}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Read the config text from the working tree, or from a git ref (the base
 * checkout for gates). Returns null when the file does not exist there.
 */
export function readSensitivePathsText({ root = process.cwd(), ref = null, file = SENSITIVE_PATHS_FILE } = {}) {
  if (ref) return readRefFile(root, ref, file);
  try {
    return readFileSync(path.resolve(root, file), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Load and validate the config. Throws when it is missing or invalid. */
export function loadSensitivePaths(options = {}) {
  const text = readSensitivePathsText(options);
  if (text === null) throw new Error(`${options.file ?? SENSITIVE_PATHS_FILE} not found${options.ref ? ` at ${options.ref}` : ""}`);
  return parseSensitivePaths(text);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Build a matcher from a validated config. */
export function createMatcher(config) {
  const compiled = parseSensitivePaths(config).globs.map((entry) => ({ ...entry, regex: compileGlob(entry.glob) }));
  const match = (file) => {
    const normalized = normalizePath(file);
    return compiled.filter((entry) => entry.regex.test(normalized)).map(({ glob, class: name }) => ({ glob, class: name }));
  };
  const classify = (file) => SENSITIVE_CLASSES.filter((name) => match(file).some((entry) => entry.class === name));
  return { match, classify, isSensitive: (file) => match(file).length > 0 };
}

/**
 * Classify a set of paths.
 * @returns {{sensitive: boolean, classes: string[], files: {path: string, classes: string[], globs: string[]}[]}}
 */
export function classifyPaths(paths, config) {
  const matcher = createMatcher(config);
  const files = [...new Set(paths.map(normalizePath))].filter(Boolean).map((file) => {
    const matches = matcher.match(file);
    return { path: file, classes: SENSITIVE_CLASSES.filter((name) => matches.some((entry) => entry.class === name)), globs: matches.map((entry) => entry.glob) };
  });
  const classes = SENSITIVE_CLASSES.filter((name) => files.some((file) => file.classes.includes(name)));
  return { sensitive: classes.length > 0, classes, files };
}

/** Triage route for an issue whose scope touches these paths (AGENTS.md: architect-first). */
export function triageRoute(paths, config) {
  const result = classifyPaths(paths, config);
  return { route: result.sensitive ? "architect_first" : "standard", classes: result.classes };
}

// ---------------------------------------------------------------------------
// AGENTS.md parity
// ---------------------------------------------------------------------------

const AGENTS_LINE = /^- \*\*([a-z_]+)\*\*/;

/**
 * Extract {class, glob} pairs from the AGENTS.md list between the markers.
 * Each list line reads "- **<class>** (<label>): `glob`, `glob`".
 */
export function parseAgentsSensitiveList(markdown) {
  const text = String(markdown);
  const begin = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END);
  if (begin === -1 || end === -1 || end < begin) return { entries: [], problems: [`AGENTS.md is missing the ${AGENTS_BEGIN} / ${AGENTS_END} markers`] };
  const entries = [];
  const problems = [];
  for (const line of text.slice(begin + AGENTS_BEGIN.length, end).split("\n")) {
    if (!line.trim().startsWith("-")) continue;
    const match = AGENTS_LINE.exec(line.trim());
    if (!match || !SENSITIVE_CLASSES.includes(match[1])) {
      problems.push(`AGENTS.md sensitive-paths line has no known class: ${line.trim()}`);
      continue;
    }
    for (const glob of line.matchAll(/`([^`]+)`/g)) entries.push({ class: match[1], glob: glob[1] });
  }
  return { entries, problems };
}

/** Parity errors between AGENTS.md and the JSON, both directions. */
export function checkAgentsParity(markdown, config) {
  const { entries, problems } = parseAgentsSensitiveList(markdown);
  const key = (entry) => `${entry.class}\u0000${entry.glob}`;
  const listed = new Set(entries.map(key));
  const source = new Set(config.globs.map(key));
  const errors = [...problems];
  for (const entry of config.globs) {
    if (!listed.has(key(entry))) errors.push(`sensitive path ${entry.glob} (${entry.class}) is in ${SENSITIVE_PATHS_FILE} but not in the AGENTS.md list`);
  }
  for (const entry of entries) {
    if (!source.has(key(entry))) errors.push(`sensitive path ${entry.glob} (${entry.class}) is in the AGENTS.md list but not in ${SENSITIVE_PATHS_FILE}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Gate loosening
// ---------------------------------------------------------------------------

/**
 * Classify a change to the config (and to the matcher) as gate_loosening.
 * baseText/headText are the raw JSON at the base and head (null when absent).
 * @returns {{detected: boolean, reasons: object[], requires: string[]}}
 */
export function findGateLoosening({ baseText = null, headText = null, changedFiles = [] } = {}) {
  const reasons = [];
  let base = null;
  try {
    base = baseText === null ? null : parseSensitivePaths(baseText);
  } catch {
    base = null; // An invalid base cannot be loosened further; head validity is reported below.
  }
  if (base) {
    let head = null;
    if (headText === null) {
      reasons.push({ code: LOOSENING_CONFIG_REMOVED, file: SENSITIVE_PATHS_FILE, message: `${SENSITIVE_PATHS_FILE} deleted` });
    } else {
      try {
        head = parseSensitivePaths(headText);
      } catch (error) {
        reasons.push({ code: LOOSENING_CONFIG_INVALID, file: SENSITIVE_PATHS_FILE, message: error.message });
      }
    }
    if (head) {
      const headClass = new Map(head.globs.map((entry) => [entry.glob, entry.class]));
      const baseGlobs = new Set(base.globs.map((entry) => entry.glob));
      const addedClasses = new Set(head.globs.filter((entry) => !baseGlobs.has(entry.glob)).map((entry) => entry.class));
      for (const entry of base.globs) {
        const now = headClass.get(entry.glob);
        if (now === entry.class) continue;
        if (now !== undefined) {
          reasons.push({ code: LOOSENING_GLOB_RECLASSIFIED, file: SENSITIVE_PATHS_FILE, glob: entry.glob, class: entry.class, message: `${entry.glob} moved from ${entry.class} to ${now}` });
        } else if (addedClasses.has(entry.class)) {
          // The glob was rewritten: any edit counts, because a superset cannot be proven here.
          reasons.push({ code: LOOSENING_GLOB_NARROWED, file: SENSITIVE_PATHS_FILE, glob: entry.glob, class: entry.class, message: `${entry.glob} (${entry.class}) replaced; narrowing or rewriting a glob loosens the gate` });
        } else {
          reasons.push({ code: LOOSENING_GLOB_REMOVED, file: SENSITIVE_PATHS_FILE, glob: entry.glob, class: entry.class, message: `${entry.glob} (${entry.class}) removed` });
        }
      }
    }
  }
  // Only files with a base copy: adding the matcher does not loosen it.
  const edited = new Map();
  for (const { status, file } of changedFiles) if (MATCHER_FILES.includes(file) && status !== "A") edited.set(file, status);
  for (const [file, status] of [...edited].sort(([a], [b]) => a.localeCompare(b))) {
    reasons.push({ code: LOOSENING_MATCHER_CHANGED, file, status, message: `${file} ${status === "D" ? "deleted" : "edited"}; needs review (the base copy ran)` });
  }
  return { detected: reasons.length > 0, reasons, requires: [...GATE_LOOSENING_REQUIRES] };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const NAME_STATUS_LINE = /^([A-Z])(?:\d{1,3})?\t(.+)$/;

/** Parse `git diff --name-status --no-renames` text into {status, file}; bare paths count as modified. */
export function parseNameStatus(nameStatusText) {
  const changes = [];
  for (const raw of String(nameStatusText).split("\n")) {
    const line = raw.replaceAll("\\", "/").trim();
    if (!line) continue;
    const match = NAME_STATUS_LINE.exec(line);
    changes.push({ status: match ? match[1] : "M", file: normalizePath(match ? match[2].split("\t").pop() : line) });
  }
  return changes;
}

/**
 * Build the report: changed files classified with the base config, gate
 * loosening between base and head, and AGENTS.md parity at the head.
 */
export function buildReport({ changedFiles, baseText, headText, agentsText = null }) {
  const configText = baseText ?? headText;
  const source = baseText !== null ? "base" : "head";
  const config = parseSensitivePaths(configText);
  let parity = [];
  if (agentsText !== null && headText !== null) {
    try {
      parity = checkAgentsParity(agentsText, parseSensitivePaths(headText));
    } catch (error) {
      parity = [error.message];
    }
  }
  return {
    schema: REPORT_SCHEMA,
    config_source: source,
    ...classifyPaths(changedFiles.map((change) => change.file), config),
    parity_errors: parity,
    gate_loosening: findGateLoosening({ baseText, headText, changedFiles }),
  };
}

export function formatReport(report) {
  const lines = [];
  if (report.gate_loosening.detected) {
    lines.push(`${GATE_LOOSENING_LINE} (report only, does not block)`);
    for (const reason of report.gate_loosening.reasons) lines.push(`  gate_loosening ${reason.code}: ${reason.message}`);
  }
  for (const error of report.parity_errors) lines.push(`parity: ${error}`);
  for (const file of report.files.filter((entry) => entry.classes.length)) lines.push(`${file.path}: ${file.classes.join(", ")}`);
  lines.push(
    `sensitive-paths: ${report.files.length} file(s), ${report.files.filter((entry) => entry.classes.length).length} sensitive` +
      (report.classes.length ? ` (${report.classes.join(", ")})` : "") +
      `, config from ${report.config_source}, ${report.parity_errors.length} parity error(s) — report mode`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "classify" && command !== "report") throw new Error("usage: sensitive-paths.mjs classify|report [options]");
  const options = { command, paths: [], json: false };
  const valueFlags = new Map([
    ["--root", "root"],
    ["--base-ref", "baseRef"],
    ["--json-out", "jsonOut"],
    ["--changed-files-from", "changedFilesFrom"],
  ]);
  for (let k = 0; k < rest.length; k += 1) {
    const arg = rest[k];
    if (arg === "--json") options.json = true;
    else if (valueFlags.has(arg)) {
      if (rest[k + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[valueFlags.get(arg)] = rest[k + 1];
      k += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.paths.push(arg);
  }
  if (command === "report" && !options.changedFilesFrom) throw new Error("report needs --changed-files-from");
  return options;
}

export function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  try {
    const options = parseArgs(argv);
    const root = path.resolve(options.root ?? process.cwd());
    const headText = readSensitivePathsText({ root });
    const baseText = options.baseRef ? readSensitivePathsText({ root, ref: options.baseRef }) : null;
    if (options.command === "classify") {
      const result = classifyPaths(options.paths, parseSensitivePaths(baseText ?? headText ?? "null"));
      if (options.json) stdout(JSON.stringify(result, null, 2));
      else for (const file of result.files) stdout(`${file.path}: ${file.classes.join(", ") || "-"}`);
      return 0;
    }
    const changedFiles = parseNameStatus(readFileSync(path.resolve(root, options.changedFilesFrom), "utf8"));
    let agentsText = null;
    try {
      agentsText = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    } catch {
      agentsText = null;
    }
    const report = buildReport({ changedFiles, baseText, headText, agentsText });
    if (options.jsonOut) writeFileSync(path.resolve(root, options.jsonOut), `${JSON.stringify(report, null, 2)}\n`);
    stdout(formatReport(report));
    return 0;
  } catch (error) {
    stderr(`sensitive-paths: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
