#!/usr/bin/env node
// Static check for the OVD-979 canonical lock order (docs/ovd979-lock-order.md).
// For each audited function it reads the latest CREATE definition in supabase/migrations
// and lists its lock steps in source order: advisory locks, SELECT ... FOR <lock> (resolved
// through FROM/JOIN aliases at the query level the clause belongs to), UPDATE, DELETE and
// INSERT (including INSERT ... ON CONFLICT DO UPDATE). Calls to other audited functions are
// expanded at the call site. The check fails closed: an unparsable latest definition, a lock
// on a table outside LEVELS, an unresolvable lock target, a callee chain deeper than
// MAX_DEPTH, or any inversion pair not listed exactly in KNOWN_INVERSIONS is an error.
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
  "reset_job_after_manual_quote_cancellation",
  "api_admin_complete_manual_quote_request",
  "api_claim_next_task",
];

// Exact inversion pairs ("<higher table already held> > <lower table taken after>") present on
// main today. A listed function fails if it gains a new pair or loses a listed one, so each
// fixing PR must delete its entries.
export const KNOWN_INVERSIONS = {
  // Redesign PR 2 takes L1 first.
  api_approve_job_requirements: [
    "approved_part_requirements > parts",
    "drawing_extractions > jobs",
  ],
  api_auto_approve_job_requirements: [
    "drawing_extractions > approved_part_requirements",
    "drawing_extractions > jobs",
  ],
  api_reset_client_part_property_overrides: [
    "approved_part_requirements > jobs",
    "approved_part_requirements > parts",
  ],
  // Redesign PR 5 takes L0, L1, L2, L5 in order.
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

export class LockOrderError extends Error {}

const IDENT = "[a-z_][a-z0-9_]*";
const QUALIFIED = `(?:"?(?:public|private)"?\\.)?"?(${IDENT})"?`;
const LOCK_CLAUSE =
  /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b((?:\s+of\s+[a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)?)/gi;
const ADVISORY = /\bpg_(?:try_)?advisory(?:_xact)?_lock(?:_shared)?\s*\(/gi;
const RESERVED_ALIAS = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
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
]);

export function latestDefinitions(migrationsDir) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const defs = new Map();
  const header = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+${QUALIFIED}\\s*\\(`,
    "gi",
  );
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const match of sql.matchAll(header)) {
      const name = match[1].toLowerCase();
      if (!AUDITED_FUNCTIONS.includes(name)) continue;
      const rest = sql.slice(match.index);
      const tag = rest.match(/\bas\s+(\$[a-z_]*\$)/i);
      const end = tag ? rest.indexOf(tag[1], tag.index + tag[0].length) : -1;
      if (!tag || end < 0) {
        // Never fall back to an older definition: the latest one is what runs.
        throw new LockOrderError(
          `${name} in ${file}: cannot parse function body (no dollar-quoted AS block)`,
        );
      }
      defs.set(name, {
        file,
        body: rest.slice(tag.index + tag[0].length, end),
      });
    }
  }
  return defs;
}

const stripNoise = (sql) =>
  sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:[^']|'')*'/g, "''");

function levelOf(table, where) {
  if ((KNOWN_UNORDERED_LOCKS[where] ?? []).includes(table)) return null;
  if (!(table in LEVELS)) {
    throw new LockOrderError(
      `${where}: lock on table "${table}" outside the canonical order`,
    );
  }
  return LEVELS[table];
}

// Text of the query level containing `pos`: the innermost enclosing parentheses (or the
// whole statement), with nested parenthesised subqueries blanked out.
function queryLevel(statement, pos) {
  let start = 0;
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (statement[i] === ")") depth++;
    else if (statement[i] === "(") {
      if (depth === 0) {
        start = i + 1;
        break;
      }
      depth--;
    }
  }
  let end = statement.length;
  depth = 0;
  for (let i = pos; i < statement.length; i++) {
    if (statement[i] === "(") depth++;
    else if (statement[i] === ")") {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    }
  }
  let text = "";
  depth = 0;
  for (let i = start; i < end; i++) {
    const c = statement[i];
    if (c === "(") depth++;
    if (depth === 0) text += c;
    else text += " ";
    if (c === ")") depth--;
  }
  return { text, start };
}

function fromTables(levelText) {
  const tables = new Map(); // alias -> table
  const order = [];
  const re = new RegExp(
    `\\b(?:from|join)\\s+(?:only\\s+)?${QUALIFIED}(?:\\s+(?:as\\s+)?(${IDENT}))?`,
    "gi",
  );
  for (const m of levelText.matchAll(re)) {
    const table = m[1].toLowerCase();
    const alias =
      m[2] && !RESERVED_ALIAS.has(m[2].toLowerCase())
        ? m[2].toLowerCase()
        : table;
    tables.set(alias, table);
    tables.set(table, table);
    order.push(table);
  }
  return { tables, order };
}

function selectLocks(statement, where) {
  const steps = [];
  for (const m of statement.matchAll(LOCK_CLAUSE)) {
    const { text } = queryLevel(statement, m.index);
    const { tables, order } = fromTables(text);
    const ofList = m[1]
      .replace(/^\s+of\s+/i, "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
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
    `\\b(update|delete\\s+from|insert\\s+into)\\s+(?:only\\s+)?${QUALIFIED}`,
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

export function lockSequence(
  body,
  defs = new Map(),
  depth = 0,
  where = "body",
) {
  const statements = stripNoise(body).split(";");
  const locks = [];
  for (const statement of statements) {
    const steps = [];
    for (const callee of AUDITED_FUNCTIONS) {
      const def = defs.get(callee);
      const call = new RegExp(`\\b${callee}\\s*\\(`, "i").exec(statement);
      if (!def || !call) continue;
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
    );
    steps.sort((a, b) => a.pos - b.pos);
    locks.push(...steps.map(({ pos, ...l }) => l));
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
  return [...pairs].sort();
}

export function audit(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const defs = latestDefinitions(migrationsDir);
  return AUDITED_FUNCTIONS.map((name) => {
    const def = defs.get(name);
    if (!def) return { name, missing: true };
    const locks = lockSequence(def.body, defs, 0, name);
    const calls = AUDITED_FUNCTIONS.filter(
      (other) =>
        other !== name &&
        new RegExp(`\\b${other}\\s*\\(`, "i").test(stripNoise(def.body)),
    );
    return {
      name,
      file: def.file,
      locks,
      calls,
      inversions: findInversions(locks),
    };
  });
}

export function verify(
  rows,
  known = KNOWN_INVERSIONS,
  unordered = KNOWN_UNORDERED_LOCKS,
) {
  const errors = [];
  for (const row of rows) {
    if (row.missing) {
      errors.push(`${row.name}: no CREATE definition found`);
      continue;
    }
    const expected = [...(known[row.name] ?? [])].sort();
    const actual = row.inversions;
    const unexpected = actual.filter((p) => !expected.includes(p));
    const gone = expected.filter((p) => !actual.includes(p));
    for (const p of unexpected)
      errors.push(`${row.name}: unlisted inversion ${p}`);
    for (const p of gone)
      errors.push(
        `${row.name}: listed inversion ${p} no longer occurs; remove it from KNOWN_INVERSIONS`,
      );
    const direct = new Set(
      row.locks.filter((l) => l.level === null && !l.via).map((l) => l.table),
    );
    for (const t of unordered[row.name] ?? [])
      if (!direct.has(t))
        errors.push(
          `${row.name}: listed unordered lock on ${t} no longer occurs; remove it from KNOWN_UNORDERED_LOCKS`,
        );
  }
  return errors;
}

function main() {
  const dir = process.argv[2]
    ? resolve(process.argv[2])
    : DEFAULT_MIGRATIONS_DIR;
  let rows;
  try {
    rows = audit(dir);
  } catch (error) {
    console.error(`Lock-order check failed:\n- ${error.message}`);
    process.exit(1);
  }
  for (const row of rows.filter((r) => !r.missing)) {
    const seq =
      row.locks
        .map(
          (l) =>
            `${l.level === null ? "unordered" : `L${l.level}`}:${l.table}${l.kind === "select" || l.kind === "advisory" ? "" : `(${l.kind})`}${l.via ? `[via ${l.via}]` : ""}`,
        )
        .join(" -> ") || "(no row locks)";
    const calls = row.calls.length ? ` calls ${row.calls.join(", ")}` : "";
    const inv = row.inversions.length
      ? ` INVERSIONS: ${row.inversions.join(", ")}`
      : "";
    console.log(`${row.name} [${row.file}]: ${seq}${calls}${inv}`);
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
