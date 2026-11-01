#!/usr/bin/env node
/**
 * Production logical backup with built-in verification (Blaine's card: "Backups:
 * adapt the script in a reviewed PR"). Replaces the hand-typed dump commands in
 * docs/release/window-2/README.md step 5, which need a full "$DB_URL" with the
 * database password or a logged-in, linked supabase CLI, and verify nothing.
 *
 * Credential paths, first match wins. No secret is ever an argument, a file in
 * the repo, or printed:
 *   1. db-url: a connection string (for example the session pooler URL) read
 *      from the environment variable NAMED by --url-env (default
 *      OVD_BACKUP_DB_URL). It is split into PGHOST/PGPORT/PGUSER/PGPASSWORD/
 *      PGDATABASE for pg_dump and psql, so the password never reaches argv.
 *   2. supabase-linked: `supabase db dump --linked`, which uses the CLI login and
 *      the linked project (the CLI asks for, or reads, the database password).
 *      This path cannot run the live count query; row counts come from the dump.
 *
 * Output (outside the repo, new directory, mode 700, files mode 600):
 *   schema.sql, data.sql, storage-policies.sql (db-url only), counts.prod.json
 *   (db-url only), manifest.json, SHA256SUMS.
 * Verification (always after a dump, or alone with --verify <dir>): every file
 * non-empty, schema has CREATE TABLE for the app schemas, row counts per table
 * from the COPY blocks in data.sql, those counts equal counts.prod.json where
 * present, and every file matches SHA256SUMS.
 *
 *   node scripts/prod-backup.mjs --out <dir> [--url-env NAME] [--dry-run]
 *   node scripts/prod-backup.mjs --verify <dir>
 *
 * Exit 0 pass, 1 dump or verification failure, 2 usage error.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_URL_ENV = "OVD_BACKUP_DB_URL";
export const APP_SCHEMAS = ["public", "private", "engineering_private"];
export const DATA_SCHEMAS = [...APP_SCHEMAS, "auth", "storage"];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { out: null, verify: null, urlEnv: DEFAULT_URL_ENV, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--out") opts.out = value();
    else if (a === "--verify") opts.verify = value();
    else if (a === "--url-env") opts.urlEnv = value();
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (opts.help) return opts;
  if (!ENV_NAME.test(opts.urlEnv)) throw new UsageError("--url-env takes an environment variable NAME, not a value");
  if (opts.out && opts.verify) throw new UsageError("use --out or --verify, not both");
  if (!opts.out && !opts.verify) throw new UsageError("--out <dir> or --verify <dir> is required");
  if (opts.verify && opts.dryRun) throw new UsageError("--dry-run applies to --out only");
  return opts;
}

/** Host-free description of a connection string, safe to print. */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? "<user>" : ""}${u.password ? ":***" : ""}@<host hidden>/${u.pathname.slice(1) || "<db>"}`;
  } catch {
    return "<unparseable connection string, hidden>";
  }
}

/** Splits a postgres URL into libpq environment variables (keeps the password out of argv). */
export function urlToPgEnv(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new UsageError("the connection string variable does not hold a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new UsageError("the connection string must start with postgres:// or postgresql://");
  if (!u.hostname) throw new UsageError("the connection string has no host");
  const env = {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username || "postgres"),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1) || "postgres"),
    PGSSLMODE: u.searchParams.get("sslmode") || "require",
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  return env;
}

export function resolveSource({ env, urlEnv, hasCommand }) {
  const url = (env[urlEnv] || "").trim();
  if (url) return { kind: "db-url", urlEnv, pgEnv: urlToPgEnv(url), label: describeUrl(url) };
  if (hasCommand("supabase")) return { kind: "supabase-linked", label: "supabase CLI, linked project" };
  return { kind: "none", reason: `${urlEnv} is not set and the supabase CLI is not on PATH` };
}

const schemaFlags = (list) => list.flatMap((s) => ["-n", s]);

export function buildPlan(source, outDir) {
  const f = (name) => join(outDir, name);
  if (source.kind === "db-url") {
    const psql = ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"];
    return [
      { name: "schema", cmd: "pg_dump", args: ["--schema-only", "--no-owner", "--no-privileges", ...schemaFlags(APP_SCHEMAS), "-f", f("schema.sql")], env: source.pgEnv },
      { name: "data", cmd: "pg_dump", args: ["--data-only", ...schemaFlags(DATA_SCHEMAS), "-f", f("data.sql")], env: source.pgEnv },
      { name: "counts", cmd: "psql", args: [...psql, "-f", join(ROOT, "scripts/window-1/smoke-counts.sql"), "-o", f("counts.prod.json")], env: source.pgEnv },
      { name: "storage-policies", cmd: "psql", args: [...psql, "-f", join(ROOT, "scripts/window-1/storage-policies.sql"), "-o", f("storage-policies.sql")], env: source.pgEnv },
    ];
  }
  if (source.kind === "supabase-linked") {
    return [
      { name: "schema", cmd: "supabase", args: ["db", "dump", "--linked", "-s", APP_SCHEMAS.join(","), "-f", f("schema.sql")], env: {} },
      { name: "data", cmd: "supabase", args: ["db", "dump", "--linked", "--data-only", "--use-copy", "-s", DATA_SCHEMAS.join(","), "-f", f("data.sql")], env: {} },
    ];
  }
  throw new Error(`no credential path: ${source.reason}`);
}

/** The backup holds customer data: refuse paths inside the repo or that already exist. */
export function checkOutDir(outDir, root = ROOT) {
  const abs = resolve(outDir);
  const rel = relative(root, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new UsageError("--out must be outside the repository (the backup holds customer data)");
  if (existsSync(abs)) throw new UsageError("--out must not exist yet; pick a new directory");
  return abs;
}

/** Row counts per table from pg_dump COPY blocks. */
export function countCopyRows(sql) {
  const counts = {};
  let table = null;
  for (const line of sql.split("\n")) {
    if (table === null) {
      const m = /^COPY ((?:"[^"]+"|[\w$]+)\.(?:"[^"]+"|[\w$]+)) .*FROM stdin;$/.exec(line);
      if (m) {
        table = m[1].replaceAll('"', "");
        counts[table] ??= 0;
      }
    } else if (line === "\\.") table = null;
    else counts[table]++;
  }
  if (table !== null) throw new Error(`data.sql ends inside the COPY block for ${table}`);
  return counts;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function writeChecksums(dir, files) {
  const lines = files.map((name) => `${sha256(readFileSync(join(dir, name)))}  ${name}`);
  writeFileSync(join(dir, "SHA256SUMS"), lines.join("\n") + "\n", { mode: 0o600 });
}

export function verifyBackup(dir) {
  const problems = [];
  const has = (n) => existsSync(join(dir, n));
  const read = (n) => readFileSync(join(dir, n), "utf8");
  for (const n of ["schema.sql", "data.sql", "manifest.json", "SHA256SUMS"]) {
    if (!has(n)) problems.push(`${n} is missing`);
    else if (read(n).trim() === "") problems.push(`${n} is empty`);
  }
  for (const n of ["counts.prod.json", "storage-policies.sql"]) if (has(n) && read(n).trim() === "") problems.push(`${n} is empty`);
  let rowCounts = {};
  let tables = 0;
  if (has("schema.sql")) {
    const schema = read("schema.sql");
    tables = (schema.match(/^CREATE TABLE /gm) || []).length;
    if (!/^CREATE TABLE (IF NOT EXISTS )?"?public"?\./m.test(schema)) problems.push("schema.sql has no CREATE TABLE in public");
  }
  if (has("data.sql")) {
    try {
      rowCounts = countCopyRows(read("data.sql"));
      if (Object.keys(rowCounts).length === 0) problems.push("data.sql has no COPY blocks");
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (has("counts.prod.json") && read("counts.prod.json").trim()) {
    try {
      const live = JSON.parse(read("counts.prod.json"));
      for (const [t, n] of Object.entries(live)) {
        if (n === null) continue;
        const dumped = rowCounts[t] ?? 0;
        if (dumped !== n) problems.push(`row count mismatch for ${t}: live ${n}, dump ${dumped}`);
      }
    } catch {
      problems.push("counts.prod.json is not valid JSON");
    }
  }
  if (has("SHA256SUMS")) {
    const listed = new Set();
    for (const line of read("SHA256SUMS").split("\n").filter(Boolean)) {
      const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      if (!m) {
        problems.push(`bad SHA256SUMS line: ${line}`);
        continue;
      }
      listed.add(m[2]);
      if (!has(m[2])) problems.push(`${m[2]} is listed in SHA256SUMS but missing`);
      else if (sha256(readFileSync(join(dir, m[2]))) !== m[1]) problems.push(`checksum mismatch for ${m[2]}`);
    }
    for (const n of readdirSync(dir)) if (n !== "SHA256SUMS" && !listed.has(n)) problems.push(`${n} is not covered by SHA256SUMS`);
  }
  return { ok: problems.length === 0, problems, tables, rowCounts };
}

function defaultHasCommand(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

function defaultRun(step) {
  const r = spawnSync(step.cmd, step.args, { env: { ...process.env, ...step.env }, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  let stderr = r.stderr || "";
  if (step.env?.PGPASSWORD) stderr = stderr.split(step.env.PGPASSWORD).join("***");
  if (step.env?.PGHOST) stderr = stderr.split(step.env.PGHOST).join("<host>");
  return { status: r.error ? 127 : r.status, stderr: r.error ? r.error.message : stderr };
}

const USAGE = "usage: node scripts/prod-backup.mjs --out <new dir outside repo> [--url-env NAME] [--dry-run]\n       node scripts/prod-backup.mjs --verify <dir>";

export function main(argv, deps = {}) {
  const { env = process.env, hasCommand = defaultHasCommand, run = defaultRun, log = console.log, err = console.error, now = () => new Date() } = deps;
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return 0;
    }
    if (opts.verify) return report(verifyBackup(resolve(opts.verify)), log, err);
    const outDir = checkOutDir(opts.out);
    const source = resolveSource({ env, urlEnv: opts.urlEnv, hasCommand });
    if (source.kind === "none") {
      err(`prod-backup: no credential path: ${source.reason}`);
      return 2;
    }
    const plan = buildPlan(source, outDir);
    log(`prod-backup: source ${source.kind} (${source.label})${source.urlEnv ? ` from $${source.urlEnv}` : ""}`);
    if (opts.dryRun) {
      for (const s of plan) log(`  would run ${s.cmd} ${s.args.join(" ")}${Object.keys(s.env).length ? `  [env: ${Object.keys(s.env).join(", ")}]` : ""}`);
      log("prod-backup: dry run, nothing executed and nothing written");
      return 0;
    }
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    chmodSync(outDir, 0o700);
    for (const s of plan) {
      log(`prod-backup: ${s.name} ...`);
      const r = run(s);
      if (r.status !== 0) {
        err(`prod-backup: ${s.name} failed (exit ${r.status})${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
        return 1;
      }
    }
    const dumped = readdirSync(outDir).sort();
    for (const n of dumped) chmodSync(join(outDir, n), 0o600);
    const rowCounts = existsSync(join(outDir, "data.sql")) ? countCopyRows(readFileSync(join(outDir, "data.sql"), "utf8")) : {};
    const manifest = {
      schema: "ovd-prod-backup.v1",
      createdAt: now().toISOString(),
      source: source.kind,
      urlEnv: source.urlEnv ?? null,
      liveCounts: dumped.includes("counts.prod.json"),
      files: Object.fromEntries(dumped.map((n) => [n, { bytes: readFileSync(join(outDir, n)).length, sha256: sha256(readFileSync(join(outDir, n))) }])),
      rowCounts,
    };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    writeChecksums(outDir, [...dumped, "manifest.json"]);
    return report(verifyBackup(outDir), log, err);
  } catch (e) {
    err(`prod-backup: ${e.message}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

function report(result, log, err) {
  const total = Object.values(result.rowCounts).reduce((a, b) => a + b, 0);
  if (!result.ok) {
    for (const p of result.problems) err(`  FAIL ${p}`);
    err("prod-backup: verify FAIL");
    return 1;
  }
  log(`prod-backup: ${result.tables} tables in schema, ${Object.keys(result.rowCounts).length} tables with data, ${total} rows`);
  log("prod-backup: verify PASS");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
