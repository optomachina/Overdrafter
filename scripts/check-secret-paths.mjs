#!/usr/bin/env node
/**
 * OVD-872: secret path block.
 *
 * Flags added, modified or type-changed files in a diff whose path matches a
 * sensitive pattern (private keys, certificate bundles, .env files, Playwright
 * storage state). `.env.example` is always allowed. `.envrc` is allowed only
 * when every line is blank, a comment, or a bare `source` / `source_env` /
 * `dotenv` of a file, so it cannot carry values itself.
 *
 * Fail closed on odd names: any such path containing a control character
 * (line feed, carriage return, tab, ...) or a Unicode line separator is
 * blocked whatever its name, and printed with those characters escaped.
 *
 * Fail closed on odd file types: a sensitive path (including `.env.example`
 * and `.envrc`) that is a symlink or a gitlink is blocked. The exemptions
 * above apply to regular files only; `git show` of a symlink returns its
 * target, not a file to check.
 *
 * Any added, modified or deleted `.gitleaks.toml` or `.gitleaksignore`, in
 * any directory, is reported as gate_loosening ({ detected, reasons[],
 * requires }, the same shape as check-rls-deny-coverage; Grok Bot countersign
 * plus Blaine's card). A `.gitleaksignore` line the base does not have gets its
 * own reason kind, gitleaksignore_lines_added: exemptions come only from the
 * base branch's root `.gitleaksignore`, and inline `gitleaks:allow` is never
 * honoured. That report never changes the exit code.
 *
 * The diff is merge-base(base, head)..head (`base...head` semantics), so
 * commits that land on the base after the branch point are not counted.
 *
 * Usage:
 *   node scripts/check-secret-paths.mjs [--base-ref <ref>] [--head-ref <ref>]
 *                                       [--enforce] [--json]
 *
 * --base-ref defaults to HEAD^1 and --head-ref to HEAD. Report mode is the
 * default: findings are printed and the exit code is 0. --enforce exits 1 when
 * there are findings. Only paths, rule ids and reasons are printed, never file
 * contents. Git is the only input; nothing touches the network.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GIT_BIN = "/usr/bin/git";
export const REPORT_SCHEMA = "ovd872.secret-paths.v1";
export const DEFAULT_BASE_REF = "HEAD^1";
export const DEFAULT_HEAD_REF = "HEAD";
export const GITLEAKS_CONFIG = ".gitleaks.toml";
export const GITLEAKS_IGNORE = ".gitleaksignore";
export const GATE_LOOSENING_REQUIRES = ["grokbot_countersign", "blaine_card"];

/**
 * The one list of blocked path patterns, matched case-insensitively against the
 * file's basename. OVD-873's docs/sensitive-paths.json landed in PR #818;
 * moving this list onto it is a follow-up, so keep the two in sync until then.
 */
export const SENSITIVE_PATH_RULES = Object.freeze([
  { id: "pem", glob: "*.pem" },
  { id: "key", glob: "*.key" },
  { id: "p12", glob: "*.p12" },
  { id: "id_rsa", glob: "id_rsa*" },
  { id: "env", glob: ".env*" },
  { id: "storage_state", glob: "*storage-state*.json" },
]);

/** Basenames exempt from the `env` rule. `.envrc` also needs a content check. */
export const ALLOWED_ENV_BASENAMES = Object.freeze([".env.example", ".envrc"]);

const ENVRC_COMMENT_OR_BLANK = /^\s*(?:#.*)?$/;
// Each argument is a plain word: no shell metacharacters that could chain an
// assignment, substitution or second command onto the line.
const ENVRC_LOAD_LINE = /^\s*(?:source|source_env|dotenv)(?:\s+[^\s;&|`$()<>=]+)*\s*$/;

/** C0/C1 control characters plus U+2028/U+2029, which also end a line. */
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u;
const CONTROL_CHARS_ALL = /[\p{Cc}\u2028\u2029]/gu;

/** Git statuses whose head-side path is checked: added, modified, type change. */
const CHECKED_STATUSES = new Set(["A", "M", "T"]);

/** Head-side git modes that are not a regular file, by the rule id they get. */
const SPECIAL_MODES = Object.freeze({ "120000": "symlink", "160000": "gitlink" });

/** One `git diff --raw -z` record: ":<old mode> <new mode> <old oid> <new oid> <status>". */
const RAW_RECORD = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/;

// `s` (dotAll) lets `*` match any character, including a line feed, so a
// name such as "a<LF>.pem" cannot slip past `*.pem`.
function globToRegExp(glob) {
  const body = glob.split("*").map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)).join(".*");
  return new RegExp(`^${body}$`, "is");
}

const COMPILED_RULES = SENSITIVE_PATH_RULES.map((rule) => ({ ...rule, re: globToRegExp(rule.glob) }));

export function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Rule ids whose glob matches the path's basename. */
export function matchSensitiveRules(path) {
  const name = basename(path);
  return COMPILED_RULES.filter((rule) => rule.re.test(name)).map((rule) => rule.id);
}

/** True when the path contains a control character or a line separator. */
export function hasControlChars(path) {
  return CONTROL_CHARS.test(path);
}

/** The path with every control character or line separator shown as \uXXXX. */
export function displayPath(path) {
  return path.replaceAll(CONTROL_CHARS_ALL, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`);
}

/** True when every `.envrc` line is blank, a comment, or a bare source/dotenv. */
export function envrcLoadsOnly(text) {
  return text.split(/\r?\n/).every((line) => ENVRC_COMMENT_OR_BLANK.test(line) || ENVRC_LOAD_LINE.test(line));
}

function git(cwd, args, binary = GIT_BIN) {
  if (process.platform === "win32") throw new Error("git on Windows requires WSL");
  return execFileSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function readRefFile(cwd, ref, path, { binary = GIT_BIN } = {}) {
  const entry = git(cwd, ["ls-tree", "--full-tree", "-z", "--end-of-options", ref, "--", `:(top,literal)${path}`], binary);
  if (!entry) return null;
  const blob = /^[0-7]{6} blob ([0-9a-f]{40}|[0-9a-f]{64})\t[^\0]+\0$/.exec(entry);
  if (!blob) throw new Error(`Expected a single blob for ${ref}:${path}`);
  return git(cwd, ["cat-file", "blob", "--end-of-options", blob[1]], binary);
}

export function refExists(cwd, ref, { binary = GIT_BIN } = {}) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], binary);
    return true;
  } catch (error) {
    if (error.status === 1 && !error.signal && !String(error.stderr ?? "").trim()) return false;
    throw error;
  }
}

/**
 * The merge-base commit of the two refs, or null when they share no history.
 * CI's full-depth fetch (fetch-depth: 0) prevents a shallow clone's clean exit 1
 * from being mistaken for "no shared history"; callers must provide full history.
 */
export function mergeBase(cwd, baseRef, headRef, { binary = GIT_BIN } = {}) {
  try {
    return git(cwd, ["merge-base", "--end-of-options", baseRef, headRef], binary).trim() || null;
  } catch (error) {
    if (error.status === 1 && !error.signal && !String(error.stderr ?? "").trim()) return null;
    throw error;
  }
}

/**
 * [{ status, path, mode }] for every change between the refs, renames split
 * into D + A. `mode` is the head-side git mode ("000000" for a delete).
 * Anything that is not a well-formed record throws, so the caller fails.
 */
export function listChanges(cwd, baseRef, headRef) {
  const fields = git(cwd, ["diff", "--raw", "--no-renames", "--no-abbrev", "-z", "--end-of-options", baseRef, headRef, "--"]).split("\0");
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const record = RAW_RECORD.exec(fields[i]);
    if (!record) throw new Error("unexpected git diff --raw output");
    changes.push({ status: record[3], path: fields[i + 1], mode: record[2] });
  }
  return changes;
}

const ignoreLines = (text) => new Set((text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));

/**
 * One gate_loosening reason for a change, or null. readRef(ref, path) returns
 * a file's text at "base" or "head" (null when absent). A `.gitleaksignore`
 * entry that the base does not have is an exemption the PR grants itself, so
 * every added fingerprint line is a reason of its own kind. Only counts are
 * reported, never the lines.
 */
function gateLooseningReason({ status, path }, readRef) {
  const name = basename(path);
  if (name === GITLEAKS_CONFIG) {
    return { kind: "gitleaks_config_changed", path, status, message: `${displayPath(path)} (${status}): allowlist config edited` };
  }
  if (name !== GITLEAKS_IGNORE) return null;
  if (status !== "D" && readRef) {
    const before = ignoreLines(status === "A" ? "" : readRef("base", path));
    const added = [...ignoreLines(readRef("head", path))].filter((l) => !before.has(l)).length;
    if (added > 0) {
      return { kind: "gitleaksignore_lines_added", path, status, added_lines: added, message: `${displayPath(path)} (${status}): adds ${added} fingerprint exemption line(s)` };
    }
  }
  return { kind: "gitleaksignore_changed", path, status, message: `${displayPath(path)} (${status}): fingerprint ignore list edited` };
}

function pathFinding({ path, mode }, readFile) {
  const rules = matchSensitiveRules(path);
  if (hasControlChars(path)) {
    return { path, rules: ["control_char", ...rules], reason: "path contains a control character or line separator" };
  }
  if (rules.length === 0) return null;
  const special = SPECIAL_MODES[mode];
  if (special) return { path, rules: [special, ...rules], reason: `sensitive path is a ${special}, not a regular file` };
  const name = basename(path);
  if (name === ".env.example") return null;
  if (name === ".envrc") {
    return envrcLoadsOnly(readFile(path)) ? null : { path, rules, reason: ".envrc does more than source/source_env/dotenv" };
  }
  return { path, rules, reason: "blocked sensitive path" };
}

/**
 * Evaluate a change list. readFile(path) returns the head copy of a file; it
 * is only called for a regular `.envrc` and its result never reaches the
 * report. A change with no `mode` is taken as a regular file.
 */
export function evaluateChanges(changes, readFile, readRef) {
  const findings = [];
  const reasons = [];
  for (const change of changes) {
    const reason = gateLooseningReason(change, readRef);
    if (reason) reasons.push(reason);
    if (!CHECKED_STATUSES.has(change.status)) continue;
    const finding = pathFinding(change, readFile);
    if (finding) findings.push(finding);
  }
  return { findings, gateLoosening: { detected: reasons.length > 0, reasons, requires: [...GATE_LOOSENING_REQUIRES] } };
}

export function buildReport({ cwd = process.cwd(), baseRef = DEFAULT_BASE_REF, headRef = DEFAULT_HEAD_REF } = {}) {
  const base = mergeBase(cwd, baseRef, headRef);
  if (!base) throw new Error(`no merge-base for ${baseRef} and ${headRef}`);
  const changes = listChanges(cwd, base, headRef);
  const show = (ref, path) => git(cwd, ["show", `${ref}:${path}`]);
  const readRef = (side, path) => {
    return readRefFile(cwd, side === "base" ? base : headRef, path);
  };
  const { findings, gateLoosening } = evaluateChanges(changes, (path) => show(headRef, path), readRef);
  return {
    schema: REPORT_SCHEMA,
    base_ref: baseRef,
    head_ref: headRef,
    merge_base: base,
    checked_paths: changes.filter((c) => CHECKED_STATUSES.has(c.status)).length,
    ok: findings.length === 0,
    findings,
    gate_loosening: gateLoosening,
  };
}

export function formatReport(report) {
  const lines = [
    `secret-paths: ${report.base_ref}...${report.head_ref} (merge-base ${report.merge_base.slice(0, 12)}), ${report.checked_paths} added/modified path(s)`,
  ];
  // Escaped, so a PR-chosen name cannot start a line of its own (for example
  // a fake "secret-paths: OK" or a closing code fence in the step summary).
  for (const f of report.findings) lines.push(`  BLOCKED ${displayPath(f.path)} [${f.rules.join(",")}]: ${f.reason}`);
  const gate = report.gate_loosening;
  for (const r of gate.reasons) lines.push(`  gate_loosening ${r.kind} ${r.message}; requires ${gate.requires.join(" + ")}`);
  lines.push(report.ok ? "secret-paths: OK" : `secret-paths: ${report.findings.length} blocked path(s)`);
  return lines.join("\n") + "\n";
}

export function parseArgs(argv) {
  const opts = { baseRef: DEFAULT_BASE_REF, headRef: DEFAULT_HEAD_REF, enforce: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--enforce") opts.enforce = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--base-ref" || arg === "--head-ref") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      opts[arg === "--base-ref" ? "baseRef" : "headRef"] = value;
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** CLI entry. Returns the exit code: 0 ok/report mode, 1 enforced findings, 2 usage, missing ref or no merge-base. */
export function run(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    stderr.write(`secret-paths: ${error.message}\n`);
    return 2;
  }
  for (const ref of [opts.baseRef, opts.headRef]) {
    if (!refExists(cwd, ref)) {
      stderr.write(`secret-paths: ref not found: ${ref}${opts.enforce ? "" : " (skipped, report mode)"}\n`);
      return opts.enforce ? 2 : 0;
    }
  }
  if (!mergeBase(cwd, opts.baseRef, opts.headRef)) {
    stderr.write(`secret-paths: no merge-base for ${opts.baseRef} and ${opts.headRef}${opts.enforce ? "" : " (skipped, report mode)"}\n`);
    return opts.enforce ? 2 : 0;
  }
  const report = buildReport({ cwd, baseRef: opts.baseRef, headRef: opts.headRef });
  stdout.write(opts.json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  return opts.enforce && !report.ok ? 1 : 0;
}

/**
 * True when node was started on this very file. Node resolves symlinks in
 * import.meta.url but leaves process.argv[1] as given, so compare real paths.
 * The secret-scan workflow runs a copy from $RUNNER_TEMP; on macOS a copy under
 * /var/folders (a symlink to /private/var) would otherwise print nothing and
 * exit 0. If a path cannot be resolved, fall back to the literal compare.
 */
export function isInvokedDirectly(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(resolve(argv1)).href;
  }
}

if (isInvokedDirectly()) process.exitCode = run(process.argv.slice(2));
