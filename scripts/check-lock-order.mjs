#!/usr/bin/env node
// Static check for the OVD-979 canonical lock order (docs/ovd979-lock-order.md).
// For each audited function, it reads the latest CREATE definition in supabase/migrations
// and lists its row-lock and advisory-lock statements in source order. It fails when a
// function takes a lower lock level after a higher one, unless that function is listed in
// KNOWN_INVERSIONS. A call to another audited function is expanded in place, so a callee's
// locks count at the point of the call. UPDATE and DELETE count as row locks.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LEVELS = {
  advisory: 0,
  jobs: 1,
  parts: 2,
  approved_part_requirements: 3,
  drawing_extractions: 4,
  work_queue: 5,
};

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

// Inversions present on main today. Each entry must be removed by the PR that fixes it;
// the check fails if a listed function no longer inverts, so the list cannot go stale.
export const KNOWN_INVERSIONS = {
  api_approve_job_requirements:
    "Updates parts and drawing_extractions, then jobs. Redesign PR 2 takes L1 first.",
  api_auto_approve_job_requirements:
    "Updates parts and drawing_extractions, then jobs. Redesign PR 2 takes L1 first.",
  api_reset_client_part_property_overrides:
    "Updates approved_part_requirements, then parts, then jobs. Redesign PR 2 takes L1 first.",
  api_request_extraction:
    "Deletes parts through api_reconcile_job_parts, then updates jobs. Redesign PR 5 takes L0, L1, L2, L5 in order.",
};

const LOCK_CLAUSE = /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/i;
const ADVISORY = /\bpg_(?:try_)?advisory(?:_xact)?_lock\s*\(/i;

export function latestDefinitions(migrationsDir) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const defs = new Map();
  const header =
    /create\s+(?:or\s+replace\s+)?function\s+(?:"?(?:public|private)"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const match of sql.matchAll(header)) {
      const name = match[1].toLowerCase();
      const rest = sql.slice(match.index);
      const tag = rest.match(/\bas\s+(\$[a-z_]*\$)/i);
      if (!tag) continue;
      const start = tag.index + tag[0].length;
      const end = rest.indexOf(tag[1], start);
      if (end < 0) continue;
      defs.set(name, { file, body: rest.slice(start, end) });
    }
  }
  return defs;
}

const stripComments = (sql) =>
  sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

export function lockSequence(body, defs = new Map(), depth = 0) {
  const statements = stripComments(body).split(";");
  const locks = [];
  for (const statement of statements) {
    if (depth < 3) {
      for (const callee of AUDITED_FUNCTIONS) {
        const def = defs.get(callee);
        if (def && new RegExp(`\\b${callee}\\s*\\(`, "i").test(statement)) {
          locks.push(
            ...lockSequence(def.body, defs, depth + 1).map((l) => ({
              ...l,
              via: l.via ?? callee,
            })),
          );
        }
      }
    }
    if (ADVISORY.test(statement))
      locks.push({ table: "advisory", level: 0, kind: "advisory" });
    // UPDATE and DELETE take row locks on every row they touch, so they count like FOR UPDATE.
    const write = statement.match(
      /\b(update|delete\s+from)\s+(?:only\s+)?(?:(?:public|private)\.)?([a-z_][a-z0-9_]*)/i,
    );
    if (write && !LOCK_CLAUSE.test(statement)) {
      const table = write[2].toLowerCase();
      if (table !== "set")
        locks.push({
          table,
          level: LEVELS[table] ?? null,
          kind: write[1].split(/\s/)[0].toLowerCase(),
        });
      continue;
    }
    if (!LOCK_CLAUSE.test(statement)) continue;
    const from = [
      ...statement.matchAll(
        /\bfrom\s+(?:(?:public|private)\.)?([a-z_][a-z0-9_]*)/gi,
      ),
    ];
    const table = from.length ? from[0][1].toLowerCase() : "unknown";
    locks.push({ table, level: LEVELS[table] ?? null, kind: "select" });
  }
  return locks;
}

export function findInversion(locks) {
  let highest = -1;
  let highestTable = null;
  for (const lock of locks) {
    if (lock.level === null) continue;
    if (lock.level < highest) return { after: highestTable, took: lock.table };
    if (lock.level > highest) {
      highest = lock.level;
      highestTable = lock.table;
    }
  }
  return null;
}

export function audit(migrationsDir) {
  const defs = latestDefinitions(migrationsDir);
  return AUDITED_FUNCTIONS.map((name) => {
    const def = defs.get(name);
    if (!def) return { name, missing: true };
    const locks = lockSequence(def.body, defs);
    const calls = AUDITED_FUNCTIONS.filter(
      (other) =>
        other !== name &&
        new RegExp(`\\b${other}\\s*\\(`, "i").test(stripComments(def.body)),
    );
    return {
      name,
      file: def.file,
      locks,
      calls,
      inversion: findInversion(locks),
    };
  });
}

function main() {
  const dir = resolve(process.argv[2] ?? "supabase/migrations");
  const rows = audit(dir);
  const errors = [];
  for (const row of rows) {
    if (row.missing) {
      errors.push(`${row.name}: no CREATE definition found`);
      continue;
    }
    const seq =
      row.locks
        .filter((l) => l.level !== null)
        .map(
          (l) =>
            `L${l.level}:${l.table}${l.kind === "select" || l.kind === "advisory" ? "" : `(${l.kind})`}${l.via ? `[via ${l.via}]` : ""}`,
        )
        .join(" -> ") || "(no row locks)";
    const calls = row.calls.length ? ` calls ${row.calls.join(", ")}` : "";
    console.log(`${row.name} [${row.file}]: ${seq}${calls}`);
    const known = KNOWN_INVERSIONS[row.name];
    if (row.inversion && !known) {
      errors.push(
        `${row.name}: takes ${row.inversion.took} after ${row.inversion.after}`,
      );
    } else if (!row.inversion && known) {
      errors.push(
        `${row.name}: listed in KNOWN_INVERSIONS but no longer inverts; remove the entry`,
      );
    }
  }
  if (errors.length) {
    console.error(`\nLock-order check failed:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nLock-order check passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
