#!/usr/bin/env node
// Static check for the OVD-979 canonical lock order (docs/ovd979-lock-order.md).
// For each audited function it reads the latest CREATE definition in supabase/migrations
// and lists its lock steps in source order: advisory locks, SELECT ... FOR <lock> (resolved
// through FROM/JOIN aliases at the query level the clause belongs to), UPDATE, DELETE and
// INSERT (including INSERT ... ON CONFLICT DO UPDATE) and LOCK TABLE. Every call to another
// audited function is expanded at the call site; calls to other migration-defined functions
// must be listed in KNOWN_UNAUDITED_CALLEES and take no L0-L5 lock. The check fails closed:
// an unparsable latest definition, a lock on a table outside LEVELS, an unresolvable lock
// target, a callee chain deeper than MAX_DEPTH, a stale or misspelled key in a known list, or
// any inversion pair not listed exactly in KNOWN_INVERSIONS is an error.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LEVELS = {
  advisory: 0,
  jobs: 1,
  parts: 2,
  approved_part_requirements: 3,
  drawing_extractions: 4,
  work_queue: 5,
};

export const MAX_DEPTH = 3;

export const DEFAULT_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
);

export const AUDITED_FUNCTIONS = [
  "api_auto_approve_job_requirements",
  "load_editable_project_part_context",
  "api_update_client_part_request",
  "api_reset_client_part_property_overrides",
  "api_approve_job_requirements",
  "api_request_extraction",
  "api_request_debug_extraction",
  "api_reconcile_job_parts",
  "api_reuse_trusted_part_version_artifacts",
  "api_reuse_trusted_part_version_artifacts_for_attempt",
  "api_save_drawing_extraction_for_attempt",
  "reset_job_after_manual_quote_cancellation",
  "api_admin_complete_manual_quote_request",
  "api_claim_next_task",
];

// Exact inversion pairs ("<higher table already held> > <lower table taken after>") present on
// main today. A listed function fails if it gains a new pair or loses a listed one, so each
// fixing PR must delete its entries. Keys must be audited functions.
export const KNOWN_INVERSIONS = {
  // U2 takes L1 first, so this trailing jobs update re-locks a row it already holds and
  // never waits. Redesign PR 5 removes the pair by writing jobs before the queue.
  api_request_extraction: ["work_queue > jobs"],
};

// Locks on tables outside LEVELS that exist on main today, per function (direct statements
// only, not via callees). Any other table outside LEVELS is an error, and the list must match
// exactly: a listed table the function no longer locks fails too. These tables are not ordered
// against L0-L5; Lead/Architect decide whether any of them joins the order.
export const KNOWN_UNORDERED_LOCKS = {
  api_reconcile_job_parts: ["job_files"],
  api_request_debug_extraction: ["debug_extraction_runs"],
  api_reuse_trusted_part_version_artifacts: [
    "cad_preview_assets",
    "drawing_preview_assets",
  ],
  api_admin_complete_manual_quote_request: [
    "quote_requests",
    "quote_runs",
    "vendor_quote_artifacts",
    "vendor_quote_offers",
    "vendor_quote_results",
  ],
};

// Calls from an audited function to other functions defined in supabase/migrations that are
// not themselves audited. Their locks are not expanded. On main they only write outside L0-L5
// (audit/event logging, property seeding) or are read-only, and the check verifies that each
// listed callee takes no L0-L5 lock directly. The list must match exactly: a new unaudited callee,
// or a listed one that is no longer called, fails the check. Filled from the main audit.
export const KNOWN_UNAUDITED_CALLEES = {
  api_auto_approve_job_requirements: [
    "log_audit_event",
    "normalize_positive_integer_array",
    "normalize_primary_service_kind",
    "normalize_requested_service_kinds",
  ],
  load_editable_project_part_context: [
    "require_verified_auth",
    "user_can_edit_job",
  ],
  api_update_client_part_request: [
    "build_project_part_property_snapshot",
    "log_audit_event",
    "normalize_positive_integer_array",
    "normalize_primary_service_kind",
    "normalize_requested_service_kinds",
    "resolve_project_part_property_values",
    "seed_project_part_property_defaults",
  ],
  api_reset_client_part_property_overrides: [
    "build_project_part_property_snapshot",
    "log_audit_event",
    "resolve_project_part_property_values",
    "seed_project_part_property_defaults",
  ],
  api_approve_job_requirements: [
    "is_internal_user",
    "log_audit_event",
    "normalize_positive_integer_array",
    "require_verified_auth",
    "to_vendor_name_array",
  ],
  api_request_extraction: [
    "log_audit_event",
    "require_verified_auth",
    "user_can_edit_job",
  ],
  api_request_debug_extraction: [
    "is_internal_user",
    "log_audit_event",
    "require_verified_auth",
  ],
  api_reconcile_job_parts: [
    "job_part_file_set",
    "log_audit_event",
    "require_verified_auth",
    "user_can_access_org",
    "user_can_edit_job",
  ],
  api_reuse_trusted_part_version_artifacts: ["log_audit_event"],
  api_admin_complete_manual_quote_request: [
    "append_commercial_admin_audit_event",
    "log_audit_event",
    "require_commercial_admin_capability",
  ],
};

export class LockOrderError extends Error {}

const IDENT = "[a-z_][a-z0-9_]*";
const ORDERED_SCHEMAS = new Set(["public", "private"]);
const QUALIFIED = String.raw`(?:"?(?:public|private)"?\.)?"?(${IDENT})"?`;
const LOCK_CLAUSE =
  /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/gi;
const OF_LIST = /^\s+of\s+([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)/i;
const ADVISORY = /\bpg_(?:try_)?advisory(?:_xact)?_lock(?:_shared)?\s*\(/gi;
const CLAUSE_WORDS = [
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "outer",
  "on",
  "using",
  "for",
  "group",
  "order",
  "limit",
  "offset",
  "returning",
  "set",
  "union",
  "except",
  "intersect",
  "having",
  "window",
  "into",
  "lateral",
  "natural",
  "and",
  "or",
  "fetch",
  "tablesample",
  "with",
  "values",
  "select",
];
// Alias group that never consumes a clause keyword (e.g. the bare JOIN in "from jobs join parts").
const ALIAS = String.raw`(?:\s+(?:as\s+)?(?!(?:${CLAUSE_WORDS.join("|")})\b)(${IDENT}))?`;

const byCodePoint = (a, b) => (a < b ? -1 : Number(a > b));

// ---- Quote-aware SQL scanner -------------------------------------------------------------
// One pass over the text that knows PostgreSQL quoting: '...' strings ('' escapes, and
// backslash escapes in E'...'), "..." identifiers ("" escapes) and $tag$...$tag$ literals.
// `--` and `/* */` (nested) are comments only outside those. Comments become a single space.

const DOLLAR_TAG = /\$(?:[a-z_\u0080-\uffff][a-z0-9_\u0080-\uffff]*)?\$/iy;
const WORD_CHAR = /[a-z0-9_$\u0080-\uffff]/i;

function blockCommentEnd(sql, i) {
  let depth = 0;
  let j = i;
  while (j < sql.length) {
    const two = sql.slice(j, j + 2);
    if (two === "/*") depth++;
    else if (two === "*/") depth--;
    else {
      j++;
      continue;
    }
    j += 2;
    if (depth === 0) return j;
  }
  throw new LockOrderError("unterminated /* comment");
}

function quotedEnd(sql, i, quote, backslashEscapes) {
  let j = i + 1;
  while (j < sql.length) {
    const c = sql[j];
    if (backslashEscapes && c === "\\") j += 2;
    else if (c !== quote) j++;
    else if (sql[j + 1] === quote) j += 2;
    else return j + 1;
  }
  throw new LockOrderError(`unterminated ${quote} literal`);
}

const isEscapeString = (sql, i) =>
  i > 0 && /e/i.test(sql[i - 1]) && !(i > 1 && WORD_CHAR.test(sql[i - 2]));

function dollarTagAt(sql, i) {
  if (i > 0 && WORD_CHAR.test(sql[i - 1])) return null; // $1 params, identifiers with $
  DOLLAR_TAG.lastIndex = i;
  return DOLLAR_TAG.exec(sql)?.[0] ?? null;
}

// The token starting at `i`: { kind, end, text? }, or null for an ordinary character.
function tokenAt(sql, i) {
  const two = sql.slice(i, i + 2);
  if (two === "--") {
    const nl = sql.indexOf("\n", i);
    return { kind: "comment", end: nl < 0 ? sql.length : nl };
  }
  if (two === "/*") return { kind: "comment", end: blockCommentEnd(sql, i) };
  const c = sql[i];
  if (c === "'")
    return {
      kind: "string",
      end: quotedEnd(sql, i, "'", isEscapeString(sql, i)),
    };
  if (c === '"') return { kind: "ident", end: quotedEnd(sql, i, '"', false) };
  const tag = c === "$" ? dollarTagAt(sql, i) : null;
  if (!tag) return null;
  const close = sql.indexOf(tag, i + tag.length);
  if (close < 0) throw new LockOrderError(`unterminated ${tag} literal`);
  return {
    kind: "dollar",
    end: close + tag.length,
    text: sql.slice(i + tag.length, close),
  };
}

// Rewrites `sql`: comments -> " ", strings -> onString(raw), dollar literals -> onDollar(body).
export function scanSql(sql, { onString, onDollar }) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const token = tokenAt(sql, i);
    if (!token) {
      out += sql[i++];
      continue;
    }
    const raw = sql.slice(i, token.end);
    if (token.kind === "comment") out += " ";
    else if (token.kind === "string") out += onString(raw);
    else if (token.kind === "dollar") out += onDollar(token.text);
    else out += raw;
    i = token.end;
  }
  return out;
}

// Function body text with comments removed and every literal blanked to ''.
export const stripNoise = (sql) =>
  scanSql(sql, { onString: () => "''", onDollar: () => "''" });

// Top level of a migration file: comments removed, strings blanked, and each dollar-quoted
// literal replaced by $<n>$ (not a valid tag, so unambiguous) with its body kept in `bodies`.
function scanFile(sql) {
  const bodies = [];
  const text = scanSql(sql, {
    onString: () => "''",
    onDollar: (body) => `$${bodies.push(body) - 1}$`,
  });
  return { text, bodies };
}

// Every CREATE FUNCTION header outside literals and comments. The dollar-quoted body must
// appear inside the same CREATE statement (before its first ";"); otherwise the definition is
// unparsable (single-quoted body, BEGIN ATOMIC, ...) and that is an error, never a fallback.
// A function in a schema other than public/private is recorded as an error, so calling it
// from an audited function fails closed.
function* functionDefinitions(sql, file) {
  const { text, bodies } = scanFile(sql);
  const header = new RegExp(
    String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?(${IDENT})"?\s*\.\s*)?"?(${IDENT})"?\s*\(`,
    "gi",
  );
  for (const match of text.matchAll(header)) {
    const schema = (match[1] ?? "public").toLowerCase();
    const name = match[2].toLowerCase();
    if (!ORDERED_SCHEMAS.has(schema)) {
      yield {
        name,
        file,
        error: `${schema}.${name} in ${file}: functions outside the public and private schemas are not audited`,
      };
      continue;
    }
    const tag = /\bas\s+\$(\d+)\$|;/i.exec(text.slice(match.index));
    if (!tag?.[1]) {
      yield {
        name,
        file,
        error: `${name} in ${file}: cannot parse function body (no dollar-quoted AS block in its CREATE statement)`,
      };
      continue;
    }
    yield { name, file, body: bodies[Number(tag[1])] };
  }
}

export function latestDefinitions(migrationsDir, { withAll = false } = {}) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(byCodePoint);
  const defs = new Map();
  const all = new Map(); // every function: latest definition or parse error
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    let found;
    try {
      found = [...functionDefinitions(sql, file)];
    } catch (error) {
      if (error instanceof LockOrderError)
        throw new LockOrderError(`${file}: ${error.message}`);
      throw error;
    }
    for (const def of found) {
      all.set(def.name, def);
      if (!AUDITED_FUNCTIONS.includes(def.name)) continue;
      if (def.error) throw new LockOrderError(def.error);
      defs.set(def.name, { file: def.file, body: def.body });
    }
  }
  return withAll ? { defs, all } : defs;
}

let probing = false;

function levelOf(table, where) {
  if (table in LEVELS) return LEVELS[table];
  if (probing) return null;
  if ((KNOWN_UNORDERED_LOCKS[where] ?? []).includes(table)) return null;
  throw new LockOrderError(
    `${where}: lock on table "${table}" outside the canonical order`,
  );
}

// Start of the query level containing `pos`: just after the innermost unmatched "(".
function levelStart(statement, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = statement[i];
    if (c === ")") depth++;
    else if (c === "(" && depth === 0) return i + 1;
    else if (c === "(") depth--;
  }
  return 0;
}

// End of the query level containing `pos`: the innermost unmatched ")".
function levelEnd(statement, pos) {
  let depth = 0;
  for (let i = pos; i < statement.length; i++) {
    const c = statement[i];
    if (c === "(") depth++;
    else if (c === ")" && depth === 0) return i;
    else if (c === ")") depth--;
  }
  return statement.length;
}

// Text of the query level containing `pos`: the innermost enclosing parentheses (or the
// whole statement), with nested parenthesised subqueries blanked out.
function queryLevel(statement, pos) {
  let text = "";
  let depth = 0;
  for (const c of statement.slice(
    levelStart(statement, pos),
    levelEnd(statement, pos),
  )) {
    if (c === "(") depth++;
    text += depth === 0 ? c : " ";
    if (c === ")") depth--;
  }
  return text;
}

const FROM_END =
  /\b(?:where|group|order|limit|offset|for|having|window|union|except|intersect|returning|fetch)\b/i;
const FROM_HEAD = new RegExp(
  String.raw`^\s*(?:only\s+)?${QUALIFIED}${ALIAS}\s*(?!\s*\()`,
  "i",
);
const JOIN_ITEM = new RegExp(
  String.raw`\bjoin\s+(?:lateral\s+)?(?:only\s+)?${QUALIFIED}${ALIAS}`,
  "gi",
);
const OPENS_CALL = /^\s*\(/;

// Plain tables in one comma-separated FROM item: its head and every JOIN. A blanked subquery
// or a function call holds no row locks of its own and is skipped.
function itemTables(item, add) {
  const head = FROM_HEAD.exec(item);
  const headIsTable =
    head &&
    !OPENS_CALL.test(item.slice(head[0].length)) &&
    !CLAUSE_WORDS.includes(head[1].toLowerCase());
  if (headIsTable) add(head[1], head[2]);
  for (const j of item.matchAll(JOIN_ITEM)) {
    const callInJoin = OPENS_CALL.test(item.slice(j.index + j[0].length));
    if (!callInJoin || j[2]) add(j[1], j[2]);
  }
}

// Tables in every FROM clause of one query level: comma-separated items and JOINs.
export function fromTables(levelText) {
  const tables = new Map(); // alias -> table
  const order = [];
  const add = (table, alias) => {
    const t = table.toLowerCase();
    tables.set(t, t);
    if (alias) tables.set(alias.toLowerCase(), t);
    order.push(t);
  };
  for (const from of levelText.matchAll(/\bfrom\b/gi)) {
    const tail = levelText.slice(from.index + from[0].length);
    const stop = tail.search(FROM_END);
    const clause = stop < 0 ? tail : tail.slice(0, stop);
    for (const item of clause.split(",")) itemTables(item, add);
  }
  return { tables, order };
}

function selectLocks(statement, where) {
  const steps = [];
  for (const m of statement.matchAll(LOCK_CLAUSE)) {
    const { tables, order } = fromTables(queryLevel(statement, m.index));
    const of = OF_LIST.exec(statement.slice(m.index + m[0].length));
    const ofList = of
      ? of[1].split(",").map((s) => s.trim().toLowerCase())
      : [];
    const targets = ofList.length
      ? ofList.map((alias) => {
          const table = tables.get(alias);
          if (!table)
            throw new LockOrderError(
              `${where}: cannot resolve FOR ... OF ${alias} to a table`,
            );
          return table;
        })
      : order;
    if (!targets.length)
      throw new LockOrderError(
        `${where}: cannot resolve the table locked by "${m[0].trim()}"`,
      );
    for (const table of targets)
      steps.push({
        pos: m.index,
        table,
        level: levelOf(table, where),
        kind: "select",
      });
  }
  return steps;
}

function writeLocks(statement, where) {
  const steps = [];
  const re = new RegExp(
    String.raw`\b(update|delete\s+from|insert\s+into)\s+(?:only\s+)?${QUALIFIED}`,
    "gi",
  );
  for (const m of statement.matchAll(re)) {
    const before = statement.slice(0, m.index);
    // "for update", "for no key update", "do update set" are not UPDATE statements.
    if (/\b(?:for(?:\s+no\s+key)?|do)\s*$/i.test(before)) continue;
    const table = m[2].toLowerCase();
    const kind = m[1].split(/\s/)[0].toLowerCase();
    steps.push({ pos: m.index, table, level: levelOf(table, where), kind });
  }
  return steps;
}

const LOCK_TABLE = /\block\s+(?:table\s+)?/gi;
const LOCK_TARGET = new RegExp(
  String.raw`^(?:only\s+)?${QUALIFIED}\s*\*?$`,
  "i",
);

// LOCK [TABLE] [ONLY] t [, t2 ...] [IN ... MODE] [NOWAIT]
function tableLocks(statement, where) {
  const steps = [];
  for (const m of statement.matchAll(LOCK_TABLE)) {
    const rest = statement.slice(m.index + m[0].length);
    const stop = rest.search(/\b(?:in|nowait)\b/i);
    const names = (stop < 0 ? rest : rest.slice(0, stop))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length)
      throw new LockOrderError(`${where}: cannot resolve LOCK TABLE target`);
    for (const raw of names) {
      const t = LOCK_TARGET.exec(raw);
      if (!t)
        throw new LockOrderError(
          `${where}: cannot resolve LOCK TABLE target "${raw}"`,
        );
      const table = t[1].toLowerCase();
      steps.push({
        pos: m.index,
        table,
        level: levelOf(table, where),
        kind: "lock",
      });
    }
  }
  return steps;
}

// Statements the check can't order. They fail closed instead of being skipped: TRUNCATE
// (takes ACCESS EXCLUSIVE), MERGE (any action may lock), CALL (procedures are not expanded),
// and a write, LOCK TABLE or FOR <lock> query on a table in a schema other than public/private.
const UNSUPPORTED = [
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bmerge\s+into\b/i, "MERGE"],
  [/\bcall\s+[a-z_"]/i, "CALL"],
];
const SCHEMA_WRITE = new RegExp(
  String.raw`\b(?:update|delete\s+from|insert\s+into|lock(?:\s+table)?)\s+(?:only\s+)?"?(${IDENT})"?\s*\.`,
  "gi",
);
const SCHEMA_FROM = new RegExp(
  String.raw`\b(?:from|join)\s+(?:lateral\s+)?(?:only\s+)?"?(${IDENT})"?\s*\.\s*"?${IDENT}"?\s*(?!\s*\()`,
  "gi",
);

function otherSchemas(statement, re) {
  return [...statement.matchAll(re)]
    .map((m) => m[1].toLowerCase())
    .filter((s) => !ORDERED_SCHEMAS.has(s));
}

function rejectUnsupported(statement, where) {
  for (const [re, what] of UNSUPPORTED)
    if (re.test(statement))
      throw new LockOrderError(
        `${where}: ${what} is not supported by the lock-order check`,
      );
  if (probing) return; // unaudited callees may write outside public/private
  const schemas = otherSchemas(statement, SCHEMA_WRITE);
  LOCK_CLAUSE.lastIndex = 0;
  if (LOCK_CLAUSE.test(statement))
    schemas.push(...otherSchemas(statement, SCHEMA_FROM));
  LOCK_CLAUSE.lastIndex = 0;
  if (schemas.length)
    throw new LockOrderError(
      `${where}: lock on a table in schema "${schemas[0]}"; only public and private are ordered`,
    );
}

const callPattern = (name) => new RegExp(String.raw`\b${name}\s*\(`, "gi");

function calleeSteps(statement, defs, depth, where) {
  const steps = [];
  for (const callee of AUDITED_FUNCTIONS) {
    const def = defs.get(callee);
    if (!def) continue;
    for (const call of statement.matchAll(callPattern(callee))) {
      if (depth >= MAX_DEPTH)
        throw new LockOrderError(
          `${where}: call to ${callee} exceeds the expansion depth cap of ${MAX_DEPTH}`,
        );
      const inner = lockSequence(def.body, defs, depth + 1, callee);
      steps.push(
        ...inner.map((l, i) => ({
          ...l,
          pos: call.index + i / 1000,
          via: l.via ?? callee,
        })),
      );
    }
  }
  return steps;
}

export function lockSequence(
  body,
  defs = new Map(),
  depth = 0,
  where = "body",
) {
  const statements = stripNoise(body).split(";");
  const locks = [];
  for (const statement of statements) {
    rejectUnsupported(statement, where);
    const steps = calleeSteps(statement, defs, depth, where);
    for (const m of statement.matchAll(ADVISORY))
      steps.push({
        pos: m.index,
        table: "advisory",
        level: 0,
        kind: "advisory",
      });
    steps.push(
      ...selectLocks(statement, where),
      ...writeLocks(statement, where),
      ...tableLocks(statement, where),
    );
    steps.sort((a, b) => a.pos - b.pos);
    locks.push(...steps.map(({ pos: _pos, ...l }) => l));
  }
  return locks;
}

export function findInversions(locks) {
  let highest = -1;
  let highestTable = null;
  const pairs = new Set();
  for (const lock of locks) {
    if (lock.level === null) continue;
    if (lock.level < highest) pairs.add(`${highestTable} > ${lock.table}`);
    if (lock.level > highest) {
      highest = lock.level;
      highestTable = lock.table;
    }
  }
  return [...pairs].sort(byCodePoint);
}

// Functions defined in the migrations, other than audited ones, that `body` calls.
export function unauditedCallees(body, allFunctions) {
  const text = stripNoise(body);
  return [...allFunctions.keys()]
    .filter((name) => !AUDITED_FUNCTIONS.includes(name))
    .filter((name) => callPattern(name).test(text))
    .sort(byCodePoint);
}

// What an unaudited callee reaches in L0-L5: ordered tables it locks directly, and any audited
// function it calls (whose locks it would take without being expanded). Unaudited callees must
// reach none. An unparsable callee is an error.
export function orderedLocksOf(callee, all) {
  const def = all.get(callee);
  if (def.error) throw new LockOrderError(def.error);
  const text = stripNoise(def.body);
  const audited = AUDITED_FUNCTIONS.filter((name) =>
    callPattern(name).test(text),
  ).map((name) => `calls audited ${name}`);
  probing = true;
  try {
    const tables = lockSequence(def.body, new Map(), MAX_DEPTH, callee)
      .filter((l) => l.level !== null)
      .map((l) => l.table);
    return [...new Set(tables), ...audited];
  } finally {
    probing = false;
  }
}

export function audit(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const { defs, all } = latestDefinitions(migrationsDir, { withAll: true });
  return AUDITED_FUNCTIONS.map((name) => {
    const def = defs.get(name);
    if (!def) return { name, missing: true };
    const locks = lockSequence(def.body, defs, 0, name);
    const text = stripNoise(def.body);
    const calls = AUDITED_FUNCTIONS.filter(
      (other) => other !== name && callPattern(other).test(text),
    );
    const unauditedCalls = unauditedCallees(def.body, all);
    return {
      name,
      file: def.file,
      locks,
      calls,
      unauditedCalls,
      unauditedOrderedLocks: unauditedCalls.flatMap((callee) =>
        orderedLocksOf(callee, all).map((t) => `${callee}: ${t}`),
      ),
      inversions: findInversions(locks),
    };
  });
}

const sorted = (list) => [...list].sort(byCodePoint);
const sameSet = (a, b) => {
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

function listErrors(lists, unordered) {
  const errors = [];
  for (const [list, map] of Object.entries(lists))
    for (const key of Object.keys(map))
      if (!AUDITED_FUNCTIONS.includes(key))
        errors.push(`${list}: key ${key} is not an audited function`);
  for (const [name, list] of Object.entries(unordered))
    for (const table of list)
      if (table in LEVELS)
        errors.push(
          `KNOWN_UNORDERED_LOCKS: ${name} lists ${table}, which is an ordered table (L${LEVELS[table]})`,
        );
  return errors;
}

function inversionErrors(row, known) {
  const expected = sorted(known[row.name] ?? []);
  const actual = row.inversions;
  return [
    ...actual
      .filter((p) => !expected.includes(p))
      .map((p) => `${row.name}: unlisted inversion ${p}`),
    ...expected
      .filter((p) => !actual.includes(p))
      .map(
        (p) =>
          `${row.name}: listed inversion ${p} no longer occurs; remove it from KNOWN_INVERSIONS`,
      ),
  ];
}

function calleeErrors(row, unordered, unaudited) {
  const errors = [];
  const direct = new Set(
    row.locks.filter((l) => l.level === null && !l.via).map((l) => l.table),
  );
  for (const t of unordered[row.name] ?? [])
    if (!direct.has(t))
      errors.push(
        `${row.name}: listed unordered lock on ${t} no longer occurs; remove it from KNOWN_UNORDERED_LOCKS`,
      );
  for (const hit of row.unauditedOrderedLocks ?? [])
    errors.push(
      `${row.name}: unaudited callee locks an ordered table (${hit}); add the callee to AUDITED_FUNCTIONS`,
    );
  const calls = row.unauditedCalls ?? [];
  const listed = unaudited[row.name] ?? [];
  if (!sameSet(calls, listed))
    errors.push(
      `${row.name}: unaudited callees [${calls.join(", ")}] don't match KNOWN_UNAUDITED_CALLEES [${sorted(listed).join(", ")}]`,
    );
  return errors;
}

export function verify(
  rows,
  known = KNOWN_INVERSIONS,
  unordered = KNOWN_UNORDERED_LOCKS,
  unaudited = KNOWN_UNAUDITED_CALLEES,
) {
  const errors = listErrors(
    {
      KNOWN_INVERSIONS: known,
      KNOWN_UNORDERED_LOCKS: unordered,
      KNOWN_UNAUDITED_CALLEES: unaudited,
    },
    unordered,
  );
  for (const row of rows) {
    if (row.missing) errors.push(`${row.name}: no CREATE definition found`);
    else
      errors.push(
        ...inversionErrors(row, known),
        ...calleeErrors(row, unordered, unaudited),
      );
  }
  return errors;
}

function formatLock(l) {
  const level = l.level === null ? "unordered" : "L" + l.level;
  const kind =
    l.kind === "select" || l.kind === "advisory" ? "" : "(" + l.kind + ")";
  const via = l.via ? "[via " + l.via + "]" : "";
  return level + ":" + l.table + kind + via;
}

// Always audits the repository's own supabase/migrations (no path argument).
function main() {
  let rows;
  try {
    rows = audit(DEFAULT_MIGRATIONS_DIR);
  } catch (error) {
    console.error(`Lock-order check failed:\n- ${error.message}`);
    process.exit(1);
  }
  for (const row of rows.filter((r) => !r.missing)) {
    const seq = row.locks.map(formatLock).join(" -> ") || "(no row locks)";
    const calls = row.calls.length ? ` calls ${row.calls.join(", ")}` : "";
    const other = row.unauditedCalls.length
      ? ` unaudited calls ${row.unauditedCalls.join(", ")}`
      : "";
    const inv = row.inversions.length
      ? ` INVERSIONS: ${row.inversions.join(", ")}`
      : "";
    console.log(`${row.name} [${row.file}]: ${seq}${calls}${other}${inv}`);
  }
  const errors = verify(rows);
  if (errors.length) {
    console.error(`\nLock-order check failed:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nLock-order check passed.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();
