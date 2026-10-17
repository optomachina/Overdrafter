#!/usr/bin/env node
/**
 * OVD-872: secret path block.
 *
 * Flags added or modified files in a diff whose path matches a sensitive
 * pattern (private keys, certificate bundles, .env files, Playwright storage
 * state). `.env.example` is always allowed. `.envrc` is allowed only when every
 * line is blank, a comment, or a bare `source` / `source_env` / `dotenv` of a
 * file, so it cannot carry values itself.
 *
 * Any added, modified or deleted `.gitleaks.toml` or `.gitleaksignore`, in
 * any directory, is reported as gate_loosening (Grok Bot countersign plus
 * Blaine's card). That report never changes the exit code.
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

function globToRegExp(glob) {
  const body = glob.split("*").map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, "i");
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

/** True when every `.envrc` line is blank, a comment, or a bare source/dotenv. */
export function envrcLoadsOnly(text) {
  return text.split(/\r?\n/).every((line) => ENVRC_COMMENT_OR_BLANK.test(line) || ENVRC_LOAD_LINE.test(line));
}

function git(cwd, args) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function refExists(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The merge-base commit of the two refs, or null when they share no history. */
export function mergeBase(cwd, baseRef, headRef) {
  try {
    return git(cwd, ["merge-base", baseRef, headRef]).trim() || null;
  } catch {
    return null;
  }
}

/** [{ status, path }] for every change between the refs, renames split into D + A. */
export function listChanges(cwd, baseRef, headRef) {
  const fields = git(cwd, ["diff", "--name-status", "--no-renames", "-z", baseRef, headRef, "--"]).split("\0");
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i]) changes.push({ status: fields[i][0], path: fields[i + 1] });
  }
  return changes;
}

/**
 * Evaluate a change list. readFile(path) returns the head copy of a file; it
 * is only called for `.envrc` and its result never reaches the report.
 */
export function evaluateChanges(changes, readFile) {
  const findings = [];
  const gateLoosening = [];
  for (const { status, path } of changes) {
    if (basename(path) === GITLEAKS_CONFIG) {
      gateLoosening.push({ path, status, reason: "allowlist config edited", requires: [...GATE_LOOSENING_REQUIRES] });
    } else if (basename(path) === GITLEAKS_IGNORE) {
      gateLoosening.push({ path, status, reason: "fingerprint ignore list edited", requires: [...GATE_LOOSENING_REQUIRES] });
    }
    if (status !== "A" && status !== "M") continue;
    const rules = matchSensitiveRules(path);
    if (rules.length === 0) continue;
    const name = basename(path);
    if (name === ".env.example") continue;
    if (name === ".envrc") {
      if (envrcLoadsOnly(readFile(path))) continue;
      findings.push({ path, rules, reason: ".envrc does more than source/source_env/dotenv" });
      continue;
    }
    findings.push({ path, rules, reason: "blocked sensitive path" });
  }
  return { findings, gateLoosening };
}

export function buildReport({ cwd = process.cwd(), baseRef = DEFAULT_BASE_REF, headRef = DEFAULT_HEAD_REF } = {}) {
  const base = mergeBase(cwd, baseRef, headRef);
  if (!base) throw new Error(`no merge-base for ${baseRef} and ${headRef}`);
  const changes = listChanges(cwd, base, headRef);
  const { findings, gateLoosening } = evaluateChanges(changes, (path) => git(cwd, ["show", `${headRef}:${path}`]));
  return {
    schema: REPORT_SCHEMA,
    base_ref: baseRef,
    head_ref: headRef,
    merge_base: base,
    checked_paths: changes.filter((c) => c.status === "A" || c.status === "M").length,
    ok: findings.length === 0,
    findings,
    gate_loosening: gateLoosening,
  };
}

export function formatReport(report) {
  const lines = [
    `secret-paths: ${report.base_ref}...${report.head_ref} (merge-base ${report.merge_base.slice(0, 12)}), ${report.checked_paths} added/modified path(s)`,
  ];
  for (const f of report.findings) lines.push(`  BLOCKED ${f.path} [${f.rules.join(",")}]: ${f.reason}`);
  for (const g of report.gate_loosening) {
    lines.push(`  gate_loosening ${g.path} (${g.status}): ${g.reason}; requires ${g.requires.join(" + ")}`);
  }
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
