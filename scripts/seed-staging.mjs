#!/usr/bin/env node
// OVD-837: apply the synthetic staging seed (supabase/seed/staging.sql) to the
// staging Supabase project, and nothing else.
//
// Allowlist guard: every project ref the runner can see (--ref, SUPABASE_URL,
// STAGING_DATABASE_URL) must agree and must be exactly the staging ref. The
// production ref, any other ref, a database URL whose ref cannot be derived,
// and no ref at all are refused with exit 1 before psql is ever started.
//
// Usage:
//   STAGING_DATABASE_URL=... node scripts/seed-staging.mjs            counts, seed, counts, smoke
//   STAGING_DATABASE_URL=... node scripts/seed-staging.mjs --counts   read-only counts
//   STAGING_DATABASE_URL=... node scripts/seed-staging.mjs --smoke    read-only OVD-813 history select
//   node scripts/seed-staging.mjs --ref <ref> --check-target          guard only (before an MCP execute_sql)
//
// The database URL is never printed: it is split into libpq environment
// variables for psql and kept out of every message and argument list.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGING_PROJECT_REF = "ldmambwtksfvqdufhaam";
export const PRODUCTION_PROJECT_REF = "ozuatdcakezjtevztjlr";
export const DATABASE_URL_ENV = "STAGING_DATABASE_URL";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_FILES = {
  seed: path.join(repoRoot, "supabase/seed/staging.sql"),
  counts: path.join(repoRoot, "supabase/seed/staging-counts.sql"),
  smoke: path.join(repoRoot, "supabase/seed/staging-smoke.sql"),
};
const PROJECT_REF = /^[a-z0-9]{20}$/;
const MODES = new Set(["--counts", "--smoke", "--check-target"]);

/** `https://<ref>.supabase.co` -> ref; anything else -> null. */
export function refFromSupabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
  return match && PROJECT_REF.test(match[1]) ? match[1] : null;
}

/**
 * Direct host `db.<ref>.supabase.co` or pooler user `postgres.<ref>`; both
 * must agree when both are present. Returns null when no ref can be derived.
 */
export function refFromDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  const hostRef = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1] ?? null;
  const userRef = /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(url.username))?.[1] ?? null;
  if (hostRef && userRef && hostRef !== userRef) return null;
  const ref = hostRef ?? userRef;
  return ref && PROJECT_REF.test(ref) ? ref : null;
}

/** Parses argv into a mode and an optional --ref; returns { error } on bad usage. */
export function parseArgs(argv) {
  let mode = "seed";
  let ref = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ref") {
      ref = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--ref=")) {
      ref = arg.slice("--ref=".length);
    } else if (MODES.has(arg) && mode === "seed") {
      mode = arg.slice(2);
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  return { mode, ref };
}

/**
 * The allowlist guard. Pure: reads only the given values.
 * @returns {{ ok: true, ref: string } | { ok: false, reason: string }}
 */
export function resolveTargetRef({ ref = null, env = {} } = {}) {
  const sources = [];
  if (ref !== null) sources.push(["--ref", ref.trim()]);
  if (env.SUPABASE_URL) {
    const derived = refFromSupabaseUrl(env.SUPABASE_URL);
    if (!derived) return { ok: false, reason: "cannot derive a project ref from SUPABASE_URL" };
    sources.push(["SUPABASE_URL", derived]);
  }
  if (env[DATABASE_URL_ENV]) {
    const derived = refFromDatabaseUrl(env[DATABASE_URL_ENV]);
    if (!derived) return { ok: false, reason: `cannot derive a project ref from ${DATABASE_URL_ENV}` };
    sources.push([DATABASE_URL_ENV, derived]);
  }
  if (sources.length === 0) {
    return { ok: false, reason: `no target: pass --ref, SUPABASE_URL or ${DATABASE_URL_ENV}` };
  }
  const production = sources.find(([, value]) => value === PRODUCTION_PROJECT_REF);
  if (production) return { ok: false, reason: `${production[0]} targets PRODUCTION (${PRODUCTION_PROJECT_REF}); refusing` };
  const refs = new Set(sources.map(([, value]) => value));
  if (refs.size > 1) {
    return { ok: false, reason: `target refs disagree (${sources.map(([name, value]) => `${name}=${value || "empty"}`).join(", ")})` };
  }
  const [target] = refs;
  if (target !== STAGING_PROJECT_REF) {
    return { ok: false, reason: `ref ${target || "empty"} is not the staging ref ${STAGING_PROJECT_REF}; refusing` };
  }
  return { ok: true, ref: target };
}

/** libpq environment for psql, so the URL and password never reach argv or output. */
export function libpqEnv(databaseUrl) {
  const url = new URL(databaseUrl);
  const params = url.searchParams;
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    PGSSLMODE: params.get("sslmode") || "require",
  };
}

function runPsqlFile(file, databaseUrl, { singleTransaction = false } = {}) {
  const args = ["-X", "-v", "ON_ERROR_STOP=1", ...(singleTransaction ? ["--single-transaction", "-q"] : []), "-f", file];
  const result = spawnSync("psql", args, {
    stdio: "inherit",
    env: { PATH: process.env.PATH ?? "", ...libpqEnv(databaseUrl) },
  });
  if (result.error) throw new Error(`psql could not start (${result.error.code ?? "error"})`);
  return result.status ?? 1;
}

/** Returns the process exit code: 0 ok, 1 refused or failed, 2 usage. */
export function main(argv, env, { runPsql = runPsqlFile, log = console.log, error = console.error } = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    error(`seed-staging: ${args.error}`);
    return 2;
  }
  const target = resolveTargetRef({ ref: args.ref, env });
  if (!target.ok) {
    error(`seed-staging: ${target.reason}`);
    return 1;
  }
  if (args.mode === "check-target") {
    log(`seed-staging: target ${target.ref} is the staging project`);
    return 0;
  }
  const databaseUrl = env[DATABASE_URL_ENV];
  if (!databaseUrl) {
    error(`seed-staging: ${DATABASE_URL_ENV} is required to connect`);
    return 1;
  }
  const steps = {
    counts: [["counts", SEED_FILES.counts]],
    smoke: [["smoke", SEED_FILES.smoke]],
    seed: [["counts before", SEED_FILES.counts], ["seed", SEED_FILES.seed], ["counts after", SEED_FILES.counts], ["smoke", SEED_FILES.smoke]],
  }[args.mode];
  for (const [label, file] of steps) {
    log(`seed-staging: ${label} (${target.ref})`);
    const status = runPsql(file, databaseUrl, { singleTransaction: label === "seed" });
    if (status !== 0) {
      error(`seed-staging: ${label} failed (psql exit ${status})`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (caught) {
    console.error(`seed-staging: stopped: ${caught instanceof Error ? caught.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
