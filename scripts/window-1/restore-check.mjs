#!/usr/bin/env node
/**
 * Window 1 restore check. Restores Blaine's logical dump of production into a
 * disposable LOCAL database and proves it is usable before any migration is
 * applied:
 *   1. the target is local (Unix socket, 127.0.0.1, ::1 or localhost) and has
 *      no application tables yet;
 *   2. the custom roles that repository migrations create (NOLOGIN, no
 *      password) are created on the target, because the dump excludes roles
 *      and its grants name them;
 *   3. in one transaction, stopping at the first error: the target's default
 *      privileges for new objects in public are cleared (otherwise every
 *      restored table and function would pick up Supabase's default grants to
 *      anon and authenticated, which production revoked), then schema.sql,
 *      then data.sql with triggers off (session_replication_role = replica),
 *      then storage-policies.sql (storage.objects policies are not part of an
 *      application schema dump);
 *   4. smoke-counts.sql on the restore equals counts.prod.json exactly;
 *   5. the OVD-602 inventory of the restore equals the pinned baseline.
 *
 *   node scripts/window-1/restore-check.mjs --target <local postgres url> --dump <dir>
 *       [--pin docs/release/window-1/ovd602-pin.main.json]
 *
 * <dir> holds schema.sql, data.sql, storage-policies.sql and counts.prod.json (see the README).
 * Exit 0 only when every check passes. Never connects to a non local host.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { byCodeUnit, diffInventories, isEmptyDiff, parseInventory, renderDiff } from "./ovd602-diff.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLEAR_DEFAULT_PRIVILEGES = [
  "tables", "sequences", "functions",
].map((kind) => `alter default privileges in schema public revoke all on ${kind} from anon, authenticated, service_role;`).join(" ");
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** True only for a socket path or a loopback host. Any other host is refused. */
export function isLocalTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return false;
  // hostaddr or service could redirect the connection away from the named host.
  if (parsed.searchParams.has("hostaddr") || parsed.searchParams.has("service")) return false;
  // libpq uses the last of repeated keys and tries every comma separated host,
  // so either could reach a remote server after a local value passed the check.
  const queryHosts = parsed.searchParams.getAll("host");
  if (queryHosts.length > 1 || queryHosts.some((h) => h.includes(",")) || parsed.hostname.includes(",")) return false;
  const queryHost = queryHosts[0] ?? null;
  if (parsed.hostname === "" && queryHost) return queryHost.startsWith("/");
  if (queryHost && !queryHost.startsWith("/") && !LOCAL_HOSTS.has(queryHost)) return false;
  return LOCAL_HOSTS.has(parsed.hostname);
}

export function compareCounts(prod, restored) {
  const keys = [...new Set([...Object.keys(prod), ...Object.keys(restored)])].sort(byCodeUnit);
  return keys.filter((k) => prod[k] !== restored[k]).map((k) => `${k}: production ${prod[k]} restore ${restored[k]}`);
}

/** `create role name ...` statements in repository migrations, as role names. */
export function repoRoles(migrationsDir = join(ROOT, "supabase/migrations")) {
  const names = new Set();
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql"))) {
    for (const m of readFileSync(join(migrationsDir, f), "utf8").matchAll(/\bcreate role ([a-z0-9_]+)\s+nologin\b/gi)) names.add(m[1].toLowerCase());
  }
  return [...names].sort(byCodeUnit);
}

function parseArgs(argv) {
  const options = { pin: "docs/release/window-1/ovd602-pin.main.json" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!["--target", "--dump", "--pin"].includes(key) || !argv[i + 1]) throw new Error(`bad argument ${key}`);
    options[key.slice(2)] = argv[(i += 1)];
  }
  if (!options.target || !options.dump) throw new Error("--target and --dump are required");
  return options;
}

// Standard psql install locations (apt, Homebrew, libpq, Postgres.app). No PATH lookup.
export const PSQL_CANDIDATES = [
  "/usr/bin/psql", "/usr/local/bin/psql", "/opt/homebrew/bin/psql",
  "/opt/homebrew/opt/libpq/bin/psql", "/usr/local/opt/libpq/bin/psql",
  "/Applications/Postgres.app/Contents/Versions/latest/bin/psql",
];

/** Absolute psql path: OVD_PSQL if set (must be absolute), else the first standard location that exists. */
export function resolvePsql(env = process.env, exists = existsSync) {
  if (env.OVD_PSQL) {
    if (!isAbsolute(env.OVD_PSQL) || !exists(env.OVD_PSQL)) throw new Error("OVD_PSQL must be an absolute path to psql");
    return env.OVD_PSQL;
  }
  const found = PSQL_CANDIDATES.find((p) => exists(p));
  if (!found) throw new Error(`psql not found in ${PSQL_CANDIDATES.join(", ")}; set OVD_PSQL to its absolute path`);
  return found;
}

function psql(target, args, { input } = {}) {
  // The URL is passed as an argument, so inherited PG* settings cannot redirect it.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PGCONNECT_TIMEOUT: "10" };
  const r = spawnSync(resolvePsql(), [target, "-X", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8", env, input, maxBuffer: 1_000_000_000 });
  return { rc: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const results = [];
  const check = (name, pass, detail = "") => {
    results.push(pass);
    process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}\n`);
    return pass;
  };
  if (!check("target is a local database", isLocalTarget(o.target))) return 1;
  const dump = resolve(o.dump);
  const files = ["schema.sql", "data.sql", "counts.prod.json", "storage-policies.sql"].map((f) => join(dump, f));
  if (!check("dump directory has schema.sql, data.sql, storage-policies.sql, counts.prod.json", files.every((f) => existsSync(f)))) return 1;

  const empty = psql(o.target, ["-At", "-c",
    "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema','auth','storage','extensions','realtime','vault','graphql','graphql_public','supabase_functions','supabase_migrations','pgsodium','net','cron','_realtime','_analytics','pgbouncer')"]);
  if (!check("target has no application tables yet", empty.rc === 0 && empty.stdout.trim() === "0", empty.stdout.trim() || empty.stderr.trim())) return 1;

  const roles = repoRoles();
  const roleSql = roles.map((r) => `do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin noinherit; end if; end $$;`).join("\n");
  const made = roles.length ? psql(o.target, ["-q", "-c", roleSql]) : { rc: 0 };
  if (!check("repository NOLOGIN roles exist on the target", made.rc === 0, roles.join(", ") || "none")) return 1;

  const started = Date.now();
  const restore = psql(o.target, ["--single-transaction", "-q", "-c", CLEAR_DEFAULT_PRIVILEGES, "-f", files[0],
    "-c", "set session_replication_role = replica", "-f", files[1], "-c", "set session_replication_role = origin", "-f", files[3]]);
  if (!check("schema, data and storage policies restore in one transaction", restore.rc === 0,
    restore.rc === 0 ? `${Math.round((Date.now() - started) / 1000)} s` : restore.stderr.trim().split("\n").slice(-3).join(" | "))) return 1;

  const counts = psql(o.target, ["-A", "-t", "-q", "-f", join(ROOT, "scripts/window-1/smoke-counts.sql")]);
  const mismatches = counts.rc === 0
    ? compareCounts(JSON.parse(readFileSync(files[2], "utf8")), JSON.parse(counts.stdout.trim()))
    : [counts.stderr.trim()];
  check("row counts of key tables equal production", mismatches.length === 0, mismatches.join("; ") || counts.stdout.trim());

  const inv = psql(o.target, ["-A", "-t", "-q", "-f", join(ROOT, "scripts/window-1/ovd602-inventory.sql")]);
  if (inv.rc === 0) {
    const diff = diffInventories(parseInventory(readFileSync(resolve(ROOT, o.pin), "utf8"), o.pin), parseInventory(inv.stdout.trim(), "restore"));
    if (!isEmptyDiff(diff)) process.stdout.write(renderDiff(diff));
    check("OVD-602 inventory of the restore equals the pin", isEmptyDiff(diff));
  } else {
    check("OVD-602 inventory of the restore equals the pin", false, inv.stderr.trim());
  }
  const pass = results.every(Boolean);
  process.stdout.write(`restore check ${pass ? "PASS" : "FAIL"}\n`);
  return pass ? 0 : 1;
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (direct) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`restore-check: ${error.message}\n`);
    process.exitCode = 2;
  }
}
