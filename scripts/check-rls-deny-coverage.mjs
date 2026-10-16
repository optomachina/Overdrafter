#!/usr/bin/env node
/**
 * OVD-847: RLS deny-case coverage check.
 *
 * Every RLS policy a PR creates, alters or drops (and every table whose row
 * level security it enables) needs a supabase/tests/**\/*.sql file with tagged
 * pgTAP deny cases for three callers: anon, another authenticated user
 * (other_user) and the role boundary (role_boundary). Disabling RLS always
 * fails. The tag convention is documented in docs/rls-deny-coverage.md.
 *
 * Modes:
 *   --base-ref <ref> --head-ref <ref>  diff mode (CI): check policies changed
 *                                      in supabase/migrations between the refs,
 *                                      and that the baseline did not grow.
 *   --all                              full-tree mode: check every policy in
 *                                      the final migration state against the
 *                                      baseline.
 *   --write-baseline                   full-tree mode that rewrites
 *                                      scripts/rls-deny-baseline.json.
 *
 * Report mode is the default: findings are printed and the exit code is 0.
 * --enforce exits 1 when there are findings. --json prints the JSON report on
 * stdout instead of the human report; --json-out <file> writes it to a file.
 *
 * Diff mode runs from the base copy of this script in CI, so a PR cannot edit
 * the checker to skip itself, and it reads files from git, never the network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DENY_CASES = ["anon", "other_user", "role_boundary"];
export const MIGRATIONS_DIR = "supabase/migrations";
export const TESTS_DIR = "supabase/tests";
export const BASELINE_PATH = "scripts/rls-deny-baseline.json";
export const BASELINE_SCHEMA = "ovd847.rls-deny-baseline.v1";
export const REPORT_SCHEMA = "ovd847.rls-deny-coverage.v1";
/** Table-level entry key for ENABLE ROW LEVEL SECURITY with no named policy. */
export const RLS_TABLE_ENTRY = null;

const CASE_HINT = {
  anon: "an anon caller is denied",
  other_user: "another authenticated user (non-owner / other org) is denied",
  role_boundary: "the role boundary holds (authenticated vs service_role, or non-admin vs admin)",
};

// ---------------------------------------------------------------------------
// SQL tokenizer
// ---------------------------------------------------------------------------

/**
 * Blank out comments, string literals and dollar-quoted bodies so policy text
 * inside a function body or a string is never read as a statement. Double
 * quoted identifiers are kept verbatim. Returns statements split on `;`.
 */
export function splitSqlStatements(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth += 1; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth -= 1; i += 2; continue; }
        i += 1;
      }
      out += " ";
      continue;
    }
    if (ch === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "");
      i += 1;
      while (i < n) {
        if (escapes && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += "''";
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        out += "$$ $$";
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out.split(";").map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const CREATE_POLICY = new RegExp(String.raw`^create\s+policy\s+(${IDENT})\s+on\s+(${QUALIFIED})`, "i");
const DROP_POLICY = new RegExp(String.raw`^drop\s+policy\s+(?:if\s+exists\s+)?(${IDENT})\s+on\s+(${QUALIFIED})`, "i");
const ALTER_POLICY = new RegExp(String.raw`^alter\s+policy\s+(${IDENT})\s+on\s+(${QUALIFIED})(?:\s+rename\s+to\s+(${IDENT}))?`, "i");
const ALTER_TABLE = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s+(.*)$`, "i");
const RLS_ACTION = /\b(enable|disable|no\s+force|force)\s+row\s+level\s+security\b/gi;

export function normalizeIdent(raw) {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
}

export function normalizeTable(raw) {
  const parts = raw.match(new RegExp(IDENT, "g")).map(normalizeIdent);
  return parts.length === 1 ? `public.${parts[0]}` : `${parts[0]}.${parts[1]}`;
}

/**
 * Parse RLS-relevant operations from one migration file, in order.
 * Each op: { op, table, policy, newPolicy?, file, statement }.
 * op is create | alter | drop | rename | enable_rls | disable_rls | force_rls | no_force_rls.
 */
export function parseRlsOperations(sql, file = "<sql>") {
  const ops = [];
  for (const statement of splitSqlStatements(sql)) {
    let m;
    if ((m = CREATE_POLICY.exec(statement))) {
      ops.push({ op: "create", table: normalizeTable(m[2]), policy: normalizeIdent(m[1]), file });
    } else if ((m = DROP_POLICY.exec(statement))) {
      ops.push({ op: "drop", table: normalizeTable(m[2]), policy: normalizeIdent(m[1]), file });
    } else if ((m = ALTER_POLICY.exec(statement))) {
      const op = { op: m[3] ? "rename" : "alter", table: normalizeTable(m[2]), policy: normalizeIdent(m[1]), file };
      if (m[3]) op.newPolicy = normalizeIdent(m[3]);
      ops.push(op);
    } else if ((m = ALTER_TABLE.exec(statement))) {
      for (const action of m[2].matchAll(RLS_ACTION)) {
        const kind = action[1].toLowerCase().replace(/\s+/g, "_");
        ops.push({ op: `${kind}_rls`, table: normalizeTable(m[1]), policy: RLS_TABLE_ENTRY, file });
      }
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Test-file deny tags
// ---------------------------------------------------------------------------

const TAG_LINE = /^\s*--\s*deny:\s*(\S+)\s+(\S+)\s*$/i;
const END_LINE = /^\s*--\s*end\s+deny\b/i;
const THROW_ASSERT = /\b(?:throws_ok|throws_like|throws_ilike|throws_matching|throws_imatching|is_empty)\s*\(/i;
const RESULT_ASSERT = /\b(?:results_eq|set_eq|bag_eq|is)\s*\(/gi;

function stripLineComments(text) {
  return text.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
}

/** True when a block holds a pgTAP deny assertion (throws / empty / zero rows). */
export function hasDenyAssertion(block) {
  const code = stripLineComments(block);
  if (THROW_ASSERT.test(code)) return true;
  for (const match of code.matchAll(RESULT_ASSERT)) {
    const end = code.indexOf(";", match.index);
    const call = code.slice(match.index, end === -1 ? code.length : end);
    const zeroRows = /\bcount\s*\(/i.test(call) && /(?:,|\()\s*(?:0|'0')(?:::\s*\w+)?\s*(?:,|\))|values\s*\(\s*0\b|select\s+0\b/i.test(call);
    const emptySet = /array\s*\[\s*\]|'\{\}'|\bwhere\s+false\b/i.test(call);
    if (zeroRows || emptySet) return true;
  }
  return false;
}

/**
 * Collect deny coverage from one pgTAP file. A run of consecutive
 * `-- deny: <case> <schema.table>` lines opens a block that ends at the next
 * tag run, a `-- end deny` line, or end of file. The tag counts only when the
 * block holds a deny assertion and the file's SQL references the table.
 * Returns { coverage: Map<table, Set<case>>, problems: [] }.
 */
export function parseDenyTags(text, file = "<test>") {
  const lines = text.split("\n");
  const code = stripLineComments(text).toLowerCase();
  const coverage = new Map();
  const problems = [];
  let i = 0;
  while (i < lines.length) {
    if (!TAG_LINE.test(lines[i])) { i += 1; continue; }
    const tags = [];
    while (i < lines.length && TAG_LINE.test(lines[i])) {
      const [, kase, table] = TAG_LINE.exec(lines[i]);
      tags.push({ kase: kase.toLowerCase(), table: table.toLowerCase(), line: i + 1 });
      i += 1;
    }
    const start = i;
    while (i < lines.length && !TAG_LINE.test(lines[i]) && !END_LINE.test(lines[i])) i += 1;
    const block = lines.slice(start, i).join("\n");
    const asserted = hasDenyAssertion(block);
    for (const tag of tags) {
      const where = `${file}:${tag.line}`;
      if (!DENY_CASES.includes(tag.kase)) {
        problems.push({ file, line: tag.line, message: `${where}: unknown deny case "${tag.kase}" (use ${DENY_CASES.join(" | ")})` });
        continue;
      }
      if (!/^[a-z_][\w$]*\.[a-z_][\w$]*$/.test(tag.table)) {
        problems.push({ file, line: tag.line, message: `${where}: deny tag table must be schema-qualified, got "${tag.table}"` });
        continue;
      }
      if (!asserted) {
        problems.push({ file, line: tag.line, message: `${where}: "-- deny: ${tag.kase} ${tag.table}" block has no throws_ok / is_empty / zero-row results_eq assertion` });
        continue;
      }
      const bare = tag.table.split(".")[1];
      if (!new RegExp(String.raw`(?<![\w$])${bare.replace(/\$/g, "\\$")}(?![\w$])`).test(code)) {
        problems.push({ file, line: tag.line, message: `${where}: deny tag names ${tag.table} but the file's SQL never references it` });
        continue;
      }
      if (!coverage.has(tag.table)) coverage.set(tag.table, new Set());
      coverage.get(tag.table).add(tag.kase);
    }
  }
  return { coverage, problems };
}

/** Merge deny coverage across every test file: Map<table, Map<case, file[]>>. */
export function collectCoverage(testFiles) {
  const coverage = new Map();
  const problems = [];
  for (const { path, content } of testFiles) {
    const parsed = parseDenyTags(content, path);
    problems.push(...parsed.problems);
    for (const [table, cases] of parsed.coverage) {
      if (!coverage.has(table)) coverage.set(table, new Map());
      for (const kase of cases) {
        const files = coverage.get(table).get(kase) ?? [];
        files.push(path);
        coverage.get(table).set(kase, files);
      }
    }
  }
  return { coverage, problems };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export const entryKey = ({ table, policy }) => `${table}#${policy ?? ""}`;
const entryLabel = ({ table, policy }) => (policy == null ? `${table} (row level security)` : `${table} policy "${policy}"`);

function missingCases(coverage, table) {
  const cases = coverage.get(table);
  return DENY_CASES.filter((kase) => !cases?.has(kase));
}

/** Unique (table, policy) entries touched by ops, plus RLS weakening findings. */
export function changedEntries(ops) {
  const entries = new Map();
  const weakened = [];
  for (const op of ops) {
    if (op.op === "disable_rls" || op.op === "no_force_rls") {
      weakened.push(op);
      continue;
    }
    const add = (policy) => {
      const entry = { table: op.table, policy };
      const key = entryKey(entry);
      if (!entries.has(key)) entries.set(key, { ...entry, ops: [], files: [] });
      const target = entries.get(key);
      if (!target.ops.includes(op.op)) target.ops.push(op.op);
      if (!target.files.includes(op.file)) target.files.push(op.file);
    };
    add(op.policy);
    if (op.op === "rename") add(op.newPolicy);
  }
  return { entries: [...entries.values()], weakened };
}

/** Final-state policies and RLS-enabled tables after replaying migrations in order. */
export function finalStateEntries(migrations) {
  const state = new Map();
  const weakened = [];
  const sorted = [...migrations].sort((a, b) => a.path.localeCompare(b.path));
  for (const { path, content } of sorted) {
    for (const op of parseRlsOperations(content, path)) {
      const key = entryKey(op);
      if (op.op === "create" || op.op === "alter" || op.op === "enable_rls" || op.op === "force_rls") {
        state.set(key, { table: op.table, policy: op.policy });
      } else if (op.op === "drop") {
        state.delete(key);
      } else if (op.op === "rename") {
        state.delete(key);
        state.set(entryKey({ table: op.table, policy: op.newPolicy }), { table: op.table, policy: op.newPolicy });
      } else if (op.op === "disable_rls") {
        state.delete(key);
        weakened.push(op);
      } else if (op.op === "no_force_rls") {
        weakened.push(op);
      }
    }
  }
  return { entries: sortEntries([...state.values()]), weakened };
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}

function weakenedFinding(op) {
  const action = op.op === "disable_rls" ? "DISABLE ROW LEVEL SECURITY" : "NO FORCE ROW LEVEL SECURITY";
  return {
    kind: "rls_disabled",
    table: op.table,
    policy: null,
    file: op.file,
    message: `${op.table}: ${op.file} runs ALTER TABLE ... ${action}. Weakening row level security always fails this check; it needs Blaine.`,
  };
}

function coverageFindings(entry, coverage, kind) {
  return missingCases(coverage, entry.table).map((kase) => ({
    kind,
    table: entry.table,
    policy: entry.policy,
    case: kase,
    files: entry.files,
    message: `${entryLabel(entry)}${entry.files?.length ? ` (${entry.files.join(", ")})` : ""}: missing deny case "${kase}" — add a supabase/tests/*.sql block tagged "-- deny: ${kase} ${entry.table}" proving ${CASE_HINT[kase]}.`,
  }));
}

/** Baseline growth: head entries that the base baseline does not list. */
export function baselineGrowth(baseBaseline, headBaseline) {
  if (!baseBaseline) return [];
  const base = new Set(baseBaseline.entries.map(entryKey));
  return headBaseline.entries.filter((entry) => !base.has(entryKey(entry))).map((entry) => ({
    kind: "baseline_growth",
    table: entry.table,
    policy: entry.policy,
    message: `${BASELINE_PATH} adds ${entryLabel(entry)}. The baseline can only shrink; add the tagged deny tests instead.`,
  }));
}

/**
 * Diff mode. changedMigrations: [{ path, content }] added or modified in the PR.
 * testFiles: every supabase/tests SQL file at head. Baselines: parsed JSON or null.
 */
export function evaluateDiff({ changedMigrations, testFiles, baseBaseline = null, headBaseline = null }) {
  const ops = changedMigrations.flatMap(({ path, content }) => parseRlsOperations(content, path));
  const { entries, weakened } = changedEntries(ops);
  const { coverage, problems } = collectCoverage(testFiles);
  const findings = [
    ...weakened.map(weakenedFinding),
    ...entries.flatMap((entry) => coverageFindings(entry, coverage, "missing_deny_case")),
    ...(headBaseline ? baselineGrowth(baseBaseline, headBaseline) : []),
  ];
  return report("diff", {
    findings,
    tagProblems: problems,
    checked: entries.map(({ table, policy, ops: entryOps, files }) => ({
      table, policy, ops: entryOps, files, missing: missingCases(coverage, table),
    })),
  });
}

/**
 * Full-tree mode. Every final-state entry must be covered or listed in the
 * baseline. Baseline entries that are now covered (or gone) are reported as
 * stale so the baseline can be shrunk.
 */
export function evaluateAll({ migrations, testFiles, baseline = null }) {
  const { entries, weakened } = finalStateEntries(migrations);
  const { coverage, problems } = collectCoverage(testFiles);
  const listed = new Set((baseline?.entries ?? []).map(entryKey));
  const uncovered = entries.filter((entry) => missingCases(coverage, entry.table).length > 0);
  const uncoveredKeys = new Set(uncovered.map(entryKey));
  const findings = [
    ...weakened.map(weakenedFinding),
    ...uncovered.filter((entry) => !listed.has(entryKey(entry)))
      .flatMap((entry) => coverageFindings(entry, coverage, "missing_deny_case")),
  ];
  const stale = (baseline?.entries ?? []).filter((entry) => !uncoveredKeys.has(entryKey(entry)));
  return report("all", {
    findings,
    tagProblems: problems,
    stats: {
      policies: entries.length,
      covered: entries.length - uncovered.length,
      baselined: uncovered.filter((entry) => listed.has(entryKey(entry))).length,
    },
    staleBaselineEntries: stale.map(({ table, policy }) => ({ table, policy })),
    baseline: buildBaseline(uncovered),
  });
}

export function buildBaseline(uncovered) {
  return {
    schema: BASELINE_SCHEMA,
    description: "Existing RLS policies (and RLS-enabled tables, policy null) without tagged anon/other_user/role_boundary deny tests. Generated by `node scripts/check-rls-deny-coverage.mjs --write-baseline` from the full tree. Entries may only be removed.",
    entries: sortEntries(uncovered.map(({ table, policy }) => ({ table, policy }))),
  };
}

function report(mode, body) {
  return { schema: REPORT_SCHEMA, mode, ok: body.findings.length === 0, ...body };
}

export function formatHuman(result) {
  const lines = [];
  if (result.mode === "diff") {
    lines.push(`RLS deny coverage (diff): ${result.checked.length} changed polic${result.checked.length === 1 ? "y" : "ies"}/table entr${result.checked.length === 1 ? "y" : "ies"} checked.`);
  } else {
    const { policies, covered, baselined } = result.stats;
    lines.push(`RLS deny coverage (full tree): ${policies} entries, ${covered} covered, ${baselined} baselined, ${result.staleBaselineEntries.length} stale baseline entries.`);
  }
  for (const finding of result.findings) lines.push(`FAIL ${finding.message}`);
  for (const problem of result.tagProblems) lines.push(`WARN ${problem.message}`);
  if (result.mode === "all") {
    for (const entry of result.staleBaselineEntries) lines.push(`STALE ${entryLabel(entry)} is covered or gone; remove it from ${BASELINE_PATH}.`);
  }
  lines.push(result.ok ? "OK: no missing deny cases." : `${result.findings.length} finding(s). See docs/rls-deny-coverage.md for the deny tag convention.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Input loading (git refs or working tree)
// ---------------------------------------------------------------------------

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function gitShow(cwd, ref, path) {
  try {
    return git(cwd, ["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function listTree(cwd, ref, dir, pattern) {
  return git(cwd, ["ls-tree", "-r", "--name-only", ref, "--", dir]).split("\n").filter((path) => pattern.test(path));
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const SQL_FILE = /\.sql$/;

function readTreeFiles(root, ref, dir) {
  if (ref) return listTree(root, ref, dir, SQL_FILE).map((path) => ({ path, content: gitShow(root, ref, path) ?? "" }));
  return walk(join(root, dir)).filter((full) => SQL_FILE.test(full))
    .map((full) => ({ path: relative(root, full).split("\\").join("/"), content: readFileSync(full, "utf8") }));
}

function readBaseline(root, ref) {
  const text = ref ? gitShow(root, ref, BASELINE_PATH) : (existsSync(join(root, BASELINE_PATH)) ? readFileSync(join(root, BASELINE_PATH), "utf8") : null);
  if (text == null) return null;
  const parsed = JSON.parse(text);
  if (parsed.schema !== BASELINE_SCHEMA || !Array.isArray(parsed.entries)) throw new Error(`${BASELINE_PATH} is not a ${BASELINE_SCHEMA} document`);
  return parsed;
}

export function loadDiffInputs(root, baseRef, headRef) {
  const status = git(root, ["diff", "--name-status", "--no-renames", baseRef, headRef, "--", MIGRATIONS_DIR]);
  const changedMigrations = status.split("\n").filter(Boolean).map((line) => line.split("\t"))
    .filter(([code, path]) => code !== "D" && SQL_FILE.test(path) && path.startsWith(`${MIGRATIONS_DIR}/`))
    .map(([, path]) => ({ path, content: gitShow(root, headRef, path) ?? "" }));
  return {
    changedMigrations,
    testFiles: readTreeFiles(root, headRef, TESTS_DIR),
    baseBaseline: readBaseline(root, baseRef),
    headBaseline: readBaseline(root, headRef),
  };
}

export function loadAllInputs(root, ref = null) {
  return {
    migrations: readTreeFiles(root, ref, MIGRATIONS_DIR),
    testFiles: readTreeFiles(root, ref, TESTS_DIR),
    baseline: readBaseline(root, ref),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { enforce: false, json: false, all: false, writeBaseline: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--enforce") args.enforce = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--write-baseline") { args.all = true; args.writeBaseline = true; }
    else if (arg === "--json-out") args.jsonOut = value();
    else if (arg === "--base-ref") args.baseRef = value();
    else if (arg === "--head-ref") args.headRef = value();
    else if (arg === "--ref") args.ref = value();
    else if (arg === "--root") args.root = resolve(value());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.all && !(args.baseRef && args.headRef)) throw new Error("use --base-ref <ref> --head-ref <ref> (diff mode) or --all (full tree)");
  if (args.all && (args.baseRef || args.headRef)) throw new Error("--all cannot be combined with --base-ref/--head-ref");
  return args;
}

export function run(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`check-rls-deny-coverage: ${error.message}\n`);
    return 2;
  }
  let result;
  if (args.all) {
    const inputs = loadAllInputs(args.root, args.ref ?? null);
    result = evaluateAll(inputs);
    if (args.writeBaseline) {
      writeFileSync(join(args.root, BASELINE_PATH), `${JSON.stringify(result.baseline, null, 2)}\n`);
      stderr.write(`Wrote ${BASELINE_PATH} with ${result.baseline.entries.length} entries.\n`);
      result = evaluateAll({ ...inputs, baseline: result.baseline });
    }
  } else {
    result = evaluateDiff(loadDiffInputs(args.root, args.baseRef, args.headRef));
  }
  const { baseline: _omit, ...publicResult } = result;
  const json = `${JSON.stringify(publicResult, null, 2)}\n`;
  if (args.jsonOut) writeFileSync(args.jsonOut, json);
  stdout.write(args.json ? json : `${formatHuman(result)}\n`);
  if (!result.ok && !args.enforce) stdout.write(args.json ? "" : "Report mode: not failing the build (pass --enforce to fail).\n");
  return !result.ok && args.enforce ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
