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
 * review routing errs towards matching. One deliberate difference: ** also
 * crosses names that contain a newline (picomatch's ** does not), so such a
 * name cannot slip past. The supported syntax is *, **, ? and {a,b} (nesting
 * allowed); anything else is rejected so the semantics stay within what the
 * tests check against picomatch. The module has no dependencies because gates
 * run the base checkout's copy without installing.
 *
 * Paths are git's "/"-separated names; a backslash is a literal file-name
 * character, never a separator, and reports keep the name as git spells it.
 * A path is sensitive when the name as given or any of its other readings
 * matches (pathCandidates: trimmed, backslashes read as separators, ./ and ..
 * resolved, git's C-style quoting undone), so no spelling hides a file.
 *
 * Gates read the JSON from the base checkout. A change that removes, narrows
 * or reclassifies a glob, or deletes or breaks the file, is gate_loosening
 * (needs a Grok Bot countersign on top of Blaine's card); additions are free.
 * An edit to the code that applies the list (GATE_CODE_FILES: this module, its
 * report runner, run by `npm run test:portable-node`, the Jev screen, the
 * AGENTS.md parity check, the shared fixture and the planned workflow) is
 * flagged as well. Report only: it never changes the exit code. The report
 * runner runs the head copy of this module; running the base copy is the job
 * of the planned workflow (a card draft). The list also covers these control
 * files (infra_ci), so a PR that edits them is sensitive on its own.
 *
 * A base ref, when given (even as ""), must resolve to a commit or the call
 * fails (BaseRefError, CLI exit 2); the head copy of the list is used only
 * when the base commit exists and has no docs/sensitive-paths.json (the PR
 * that introduces it), and the report then says "config from head".
 *
 * Usage:
 *   npm run sensitive-paths:report   (HEAD^1..HEAD, what CI reports)
 *   node scripts/lib/sensitive-paths.mjs classify [--base-ref <ref>] [--json] <path> ...
 *   node scripts/lib/sensitive-paths.mjs report --changed-files-from <name-status> --base-ref HEAD^1 [--json-out <path>]
 * <name-status> is `git diff --name-status -z --no-renames <base> <head>` output
 * (NUL-separated, so names git would quote come through as is); newline text
 * with git's quoted names, or bare paths, is accepted too.
 * Options: --root <dir> (repository root, default cwd).
 * Exit codes: 0 (report mode), 2 usage or input error, including a --base-ref
 * that does not resolve to a commit.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
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
/** Code that applies the list; editing or deleting one is matcher_changed. */
export const GATE_CODE_FILES = Object.freeze([
  MATCHER_PATH,
  REPORT_RUNNER_PATH,
  PLANNED_WORKFLOW_PATH,
  "scripts/jev-pr-screen.mjs",
  "scripts/validate-agent-contract.mjs",
  "scripts/fixtures/sensitive-paths/paths.json",
]);
/** Error code on a BaseRefError: an explicitly requested base ref cannot be read. */
export const BASE_REF_UNAVAILABLE = "BASE_REF_UNAVAILABLE";
const GIT = "/usr/bin/git";

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
  // "s": the .* that ** compiles to also crosses newlines in names.
  return new RegExp(`^(?:${expandBraces(glob).map(expansionSource).join("|")})$`, "is");
}

/**
 * The name reported for a path: git's spelling with any leading ./ or /
 * removed. A backslash is a literal file-name character and stays.
 */
export function normalizePath(file) {
  return String(file).replace(/^(?:\.?\/)+/, "");
}

// path.posix.normalize resolves ., .. and repeated slashes; "" would become ".".
const resolvedForm = (text) => (text === "" ? "" : normalizePath(path.posix.normalize(text)));

/**
 * Every spelling a path is matched under: the name as given, its reported
 * form, trimmed, with backslashes read as separators, with ., .. and repeated
 * slashes resolved, and with git's C-style quoting undone. A path is sensitive
 * when any of them matches, so a spelling cannot hide a file (fail safe).
 */
export function pathCandidates(file) {
  const raw = String(file);
  const trimmed = raw.trim();
  const bases = [raw, trimmed];
  try {
    const unquoted = unquoteGitPath(trimmed);
    if (unquoted !== trimmed) bases.push(unquoted);
  } catch {
    // Not valid git quoting: the name is matched as given.
  }
  const out = new Set();
  for (const base of bases) {
    for (const form of [base, normalizePath(base), resolvedForm(base), resolvedForm(base.replaceAll("\\", "/"))]) {
      if (form !== "") out.add(form);
    }
  }
  return [...out];
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

/** An explicitly requested base ref that cannot be read; error.code is BASE_REF_UNAVAILABLE. */
export class BaseRefError extends Error {
  constructor(message) {
    super(message);
    this.name = "BaseRefError";
    this.code = BASE_REF_UNAVAILABLE;
  }
}

const runGit = (root, args) => execFileSync(GIT, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** The commit a ref names. Throws BaseRefError for an empty, option-like or unresolvable ref. */
export function resolveCommit(root, ref) {
  if (typeof ref !== "string" || ref.trim() === "") throw new BaseRefError("base ref is empty (an unset variable?)");
  // A ref that looks like an option would be read by git as one.
  if (ref.startsWith("-")) throw new BaseRefError(`base ref ${JSON.stringify(ref)} looks like an option`);
  let commit = "";
  try {
    commit = runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    commit = "";
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new BaseRefError(`base ref ${JSON.stringify(ref)} does not resolve to a commit in ${root}`);
  return commit;
}

/** The file at a resolved commit, or null when the commit has no such file. Throws BaseRefError otherwise. */
function readRefFile(root, ref, file) {
  const commit = resolveCommit(root, ref);
  try {
    if (runGit(root, ["ls-tree", "--full-tree", "-z", commit, "--", file]) === "") return null;
    return runGit(root, ["show", `${commit}:${file}`]);
  } catch {
    throw new BaseRefError(`cannot read ${file} at base ref ${JSON.stringify(ref)} (${commit})`);
  }
}

/**
 * Read the config text from the working tree, or from a git ref (the base
 * checkout for gates). Returns null when the file does not exist there. A ref
 * that is given (any value but null or undefined, "" included) must resolve
 * to a commit, or this throws BaseRefError; it never falls back to the
 * working tree.
 */
export function readSensitivePathsText({ root = process.cwd(), ref = null, file = SENSITIVE_PATHS_FILE } = {}) {
  if (ref !== null && ref !== undefined) return readRefFile(root, ref, file);
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
  if (text === null) throw new Error(`${options.file ?? SENSITIVE_PATHS_FILE} not found${options.ref == null ? "" : ` at ${options.ref}`}`);
  return parseSensitivePaths(text);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Build a matcher from a validated config. */
export function createMatcher(config) {
  const compiled = parseSensitivePaths(config).globs.map((entry) => ({ ...entry, regex: compileGlob(entry.glob) }));
  // A glob matches when it matches any spelling of the path (pathCandidates).
  const match = (file) => {
    const candidates = pathCandidates(file);
    return compiled.filter((entry) => candidates.some((candidate) => entry.regex.test(candidate))).map(({ glob, class: name }) => ({ glob, class: name }));
  };
  const classify = (file) => SENSITIVE_CLASSES.filter((name) => match(file).some((entry) => entry.class === name));
  return { match, classify, isSensitive: (file) => match(file).length > 0 };
}

/**
 * Classify a set of paths. Each file's path is its reported name (normalizePath);
 * its classes come from every spelling of it (pathCandidates).
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
  for (const { status, file } of changedFiles) if (GATE_CODE_FILES.includes(file) && status !== "A") edited.set(file, status);
  for (const [file, status] of [...edited].sort(([a], [b]) => a.localeCompare(b))) {
    reasons.push({ code: LOOSENING_MATCHER_CHANGED, file, status, message: `${file} ${status === "D" ? "deleted" : "edited"}; needs review` });
  }
  return { detected: reasons.length > 0, reasons, requires: [...GATE_LOOSENING_REQUIRES] };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const STATUS_FIELD = /^([A-Z])(?:\d{1,3})?$/;
const NAME_STATUS_LINE = /^([A-Z])(?:\d{1,3})?\t(.+)$/;
const QUOTE_ESCAPES = new Map([["a", 7], ["b", 8], ["t", 9], ["n", 10], ["v", 11], ["f", 12], ["r", 13], ['"', 34], ["\\", 92]]);

/** Undo git's C-style quoting of a path ("caf\303\251.yml", "tab\tname"); other text is returned as is. */
export function unquoteGitPath(text) {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const encoder = new TextEncoder();
  const bytes = [];
  const body = text.slice(1, -1);
  for (let k = 0; k < body.length; k += 1) {
    if (body[k] !== "\\") {
      const char = String.fromCodePoint(body.codePointAt(k));
      bytes.push(...encoder.encode(char));
      k += char.length - 1;
      continue;
    }
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(k + 1, k + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      k += 3;
    } else if (QUOTE_ESCAPES.has(body[k + 1])) {
      bytes.push(QUOTE_ESCAPES.get(body[k + 1]));
      k += 1;
    } else {
      throw new Error(`bad escape in quoted path ${text}`);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

// As --no-renames reports them: a rename is its source deleted plus its target added, a copy is its target added.
function changesFor(status, paths) {
  if (status === "R" && paths.length > 1) return [{ status: "D", file: paths[0] }, { status: "A", file: paths[1] }];
  if (status === "C" && paths.length > 1) return [{ status: "A", file: paths[1] }];
  return [{ status, file: paths.at(-1) }];
}

function parseNulFields(text) {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let k = 0; k < fields.length; ) {
    const status = STATUS_FIELD.exec(fields[k])?.[1];
    if (!status) throw new Error(`name-status -z: expected a status at field ${k + 1}, got ${JSON.stringify(fields[k])}`);
    const count = status === "R" || status === "C" ? 2 : 1;
    const paths = fields.slice(k + 1, k + 1 + count);
    if (paths.length < count) throw new Error(`name-status -z: ${status} at field ${k + 1} is missing its path`);
    changes.push(...changesFor(status, paths));
    k += 1 + count;
  }
  return changes;
}

function parseLines(text) {
  const changes = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const match = NAME_STATUS_LINE.exec(line.trimStart());
    if (match) changes.push(...changesFor(match[1], match[2].split("\t").map(unquoteGitPath)));
    else changes.push({ status: "M", file: unquoteGitPath(line.trim()) });
  }
  return changes;
}

/**
 * Parse `git diff --name-status -z --no-renames` output (NUL-separated: status,
 * then the path, or two paths for R and C) into {status, file}. Text without a
 * NUL is read as newline output, where git quotes names with non-ASCII, tab,
 * newline, quote or backslash characters; those are unquoted, and a bare path
 * counts as modified.
 */
export function parseNameStatus(nameStatusText) {
  const text = String(nameStatusText);
  const changes = text.includes("\0") ? parseNulFields(text) : parseLines(text);
  return changes.map((change) => ({ ...change, file: normalizePath(change.file) })).filter((change) => change.file);
}

/**
 * Build the report: changed files classified with the base config, gate
 * loosening between base and head, and AGENTS.md parity at the head.
 * baseText null means the base commit has no copy (the PR that introduces
 * it), so the head copy classifies and config_source is "head"; a base that
 * could not be read must fail before this (readSensitivePathsText throws).
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
    // An explicit --base-ref, even "" from an unset variable, must resolve (BaseRefError, exit 2).
    const baseText = options.baseRef === undefined ? null : readSensitivePathsText({ root, ref: options.baseRef });
    if (options.command === "classify") {
      const result = classifyPaths(options.paths, parseSensitivePaths(baseText ?? headText ?? "null"));
      if (options.json) stdout(JSON.stringify({ config_source: baseText === null ? "head" : "base", ...result }, null, 2));
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

/**
 * True when node was asked to run this file. Realpaths are compared because
 * node runs a script given through a symlinked path (macOS /tmp, for example)
 * from its real path, so comparing the given path skipped the CLI silently.
 */
function invokedAsScript(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  process.exitCode = main();
}
