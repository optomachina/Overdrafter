#!/usr/bin/env node
/**
 * Production logical backup with an integrity check (Blaine's card: "Backups:
 * adapt the script in a reviewed PR"). Runs the reference dump commands in
 * docs/release/window-2/README.md step 5 without putting the database password
 * in an argument, and checks the files it wrote. The supabase CLI still gets
 * the host and user (not the password) in --db-url, so `ps` shows those.
 *
 * The connection string (for example the session pooler URL) is read from the
 * environment variable NAMED by --url-env (default OVD_BACKUP_DB_URL). No secret
 * is ever an argument, a file in the repo, or printed:
 *   - schema.sql and data.sql come from `supabase db dump --db-url <URL without
 *     password>`, the exact format the window 1 restore drill passed on (it
 *     keeps grants, leaves out `CREATE SCHEMA public` and Supabase's own
 *     bookkeeping tables). The password goes to the CLI as PGPASSWORD.
 *   - counts.prod.json and storage-policies.sql come from psql with the URL
 *     split into PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE.
 * Binaries are absolute paths (OVD_SUPABASE / OVD_PSQL, else standard install
 * locations); there is no PATH lookup.
 *
 * Output (outside the repo, new directory, mode 700, files mode 600):
 *   schema.sql, data.sql, counts.prod.json, storage-policies.sql, manifest.json,
 *   SHA256SUMS.
 * Integrity check (always after a dump, or alone with --verify <dir>): every
 * file present and non-empty, schema has CREATE TABLE in each app schema, row
 * counts from the COPY blocks in data.sql equal counts.prod.json for the tables
 * that scripts/window-1/smoke-counts.sql lists, and every file
 * matches SHA256SUMS. It does NOT prove the dump restores:
 * scripts/window-1/restore-check.mjs stays mandatory. The live counts are read
 * after the data dump, so run it in the quiet window (README items 6 and 7).
 *
 *   node scripts/prod-backup.mjs --out <dir> [--url-env NAME] [--dry-run]
 *   node scripts/prod-backup.mjs --verify <dir>
 *
 * Exit 0 pass, 1 dump or verification failure, 2 usage error.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePsql } from "./window-1/restore-check.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_URL_ENV = "OVD_BACKUP_DB_URL";
export const APP_SCHEMAS = ["public", "private", "engineering_private"];
export const REQUIRED_FILES = ["schema.sql", "data.sql", "counts.prod.json", "storage-policies.sql", "manifest.json", "SHA256SUMS"];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const END_OF_COPY = String.raw`\.`;

// Standard supabase CLI install locations (Homebrew, npm global, Linux packages). No PATH lookup.
export const SUPABASE_CANDIDATES = [
  "/opt/homebrew/bin/supabase", "/usr/local/bin/supabase", "/usr/bin/supabase",
];

export class UsageError extends Error {}

const VALUE_FLAGS = { "--out": "out", "--verify": "verify", "--url-env": "urlEnv" };
const BOOL_FLAGS = { "--dry-run": "dryRun", "--help": "help", "-h": "help" };

function validateArgs(opts) {
  if (!ENV_NAME.test(opts.urlEnv)) throw new UsageError("--url-env takes an environment variable NAME, not a value");
  if (opts.out && opts.verify) throw new UsageError("use --out or --verify, not both");
  if (!opts.out && !opts.verify) throw new UsageError("--out <dir> or --verify <dir> is required");
  if (opts.verify && opts.dryRun) throw new UsageError("--dry-run applies to --out only");
}

export function parseArgs(argv) {
  const opts = { out: null, verify: null, urlEnv: DEFAULT_URL_ENV, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS[a]) {
      opts[BOOL_FLAGS[a]] = true;
      continue;
    }
    if (!VALUE_FLAGS[a]) throw new UsageError(`unknown argument: ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    opts[VALUE_FLAGS[a]] = v;
  }
  if (!opts.help) validateArgs(opts);
  return opts;
}

/** Host-free description of a connection string, safe to print. */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    const user = u.username ? "<user>" : "";
    const password = u.password ? ":***" : "";
    return `${u.protocol}//${user}${password}@<host hidden>/${u.pathname.slice(1) || "<db>"}`;
  } catch {
    return "<unparseable connection string, hidden>";
  }
}

function decodePart(value, what) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new UsageError(`the connection string has a malformed % escape in its ${what}`);
  }
}

/**
 * Splits a postgres URL into libpq environment variables and a password-free
 * URL for the supabase CLI. Only the sslmode query parameter is supported; any
 * other one is refused rather than silently dropped.
 */
export function parseDbUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new UsageError("the connection string variable does not hold a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new UsageError("the connection string must start with postgres:// or postgresql://");
  if (!u.hostname) throw new UsageError("the connection string has no host");
  const unsupported = [...u.searchParams.keys()].filter((k) => k !== "sslmode");
  if (unsupported.length) throw new UsageError(`the connection string has unsupported query parameters: ${unsupported.join(", ")} (only sslmode)`);
  const pgEnv = {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodePart(u.username || "postgres", "user name"),
    PGDATABASE: decodePart(u.pathname.slice(1) || "postgres", "database name"),
    PGSSLMODE: u.searchParams.get("sslmode") || "require",
  };
  if (u.password) pgEnv.PGPASSWORD = decodePart(u.password, "password");
  const safe = new URL(u.href);
  safe.password = "";
  if (!safe.username) safe.username = "postgres";
  safe.port = pgEnv.PGPORT;
  safe.searchParams.set("sslmode", pgEnv.PGSSLMODE);
  return { pgEnv, cliUrl: safe.href };
}

export function resolveSource({ env, urlEnv }) {
  const url = (env[urlEnv] || "").trim();
  if (!url) return { kind: "none", reason: `${urlEnv} is not set; use the manual commands in docs/release/window-2/README.md step 5` };
  return { kind: "db-url", urlEnv, ...parseDbUrl(url), label: describeUrl(url) };
}

/** Absolute supabase CLI path: OVD_SUPABASE if set (must be absolute), else the first standard location that exists. */
export function resolveSupabase(env = process.env, exists = existsSync) {
  if (env.OVD_SUPABASE) {
    if (!isAbsolute(env.OVD_SUPABASE) || !exists(env.OVD_SUPABASE)) throw new Error("OVD_SUPABASE must be an absolute path to the supabase CLI");
    return env.OVD_SUPABASE;
  }
  const found = SUPABASE_CANDIDATES.find((p) => exists(p));
  if (!found) throw new Error(`supabase CLI not found in ${SUPABASE_CANDIDATES.join(", ")}; set OVD_SUPABASE to its absolute path`);
  return found;
}

export function buildPlan(source, outDir, bins) {
  if (source.kind !== "db-url") throw new Error(`no credential path: ${source.reason}`);
  const f = (name) => join(outDir, name);
  const cliEnv = source.pgEnv.PGPASSWORD ? { PGPASSWORD: source.pgEnv.PGPASSWORD } : {};
  const dump = (extra, file) => ["db", "dump", "--db-url", source.cliUrl, ...extra, "-f", f(file)];
  const psql = (sql, file) => ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-f", join(ROOT, "scripts/window-1", sql), "-o", f(file)];
  return [
    { name: "schema", cmd: bins.supabase, args: dump([], "schema.sql"), env: cliEnv },
    { name: "data", cmd: bins.supabase, args: dump(["--data-only", "--use-copy"], "data.sql"), env: cliEnv },
    { name: "counts", cmd: bins.psql, args: psql("smoke-counts.sql", "counts.prod.json"), env: source.pgEnv },
    { name: "storage-policies", cmd: bins.psql, args: psql("storage-policies.sql", "storage-policies.sql"), env: source.pgEnv },
  ];
}

/** Replaces every secret or identifying value in text, longest first. The default user "postgres" is not secret and is kept. */
export function redact(text, values) {
  const hidden = [...new Set(values.filter((v) => typeof v === "string" && v.length >= 3 && v !== "postgres"))].sort((a, b) => b.length - a.length);
  return hidden.reduce((acc, v) => acc.split(v).join("<hidden>"), text);
}

/** Nearest existing ancestor of abs, resolved through symlinks, plus the missing tail. */
function realTarget(abs) {
  const tail = [];
  let cur = abs;
  while (!existsSync(cur)) {
    tail.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return { abs: join(realpathSync(cur), ...tail), exists: tail.length === 0 };
}

/** The backup holds customer data: refuse paths inside the repo (after symlinks) or that already exist. */
export function checkOutDir(outDir, root = ROOT) {
  const target = realTarget(resolve(outDir));
  const rel = relative(realpathSync(root), target.abs);
  const outside = isAbsolute(rel) || rel.split(sep)[0] === "..";
  if (!outside) throw new UsageError("--out must be outside the repository (the backup holds customer data)");
  if (target.exists) throw new UsageError("--out must not exist yet; pick a new directory");
  return target.abs;
}

/** Creates the parents, then the final directory non-recursively so a directory that appeared meanwhile fails. */
export function createOutDir(abs) {
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(abs, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST") throw new UsageError("--out must not exist yet; pick a new directory");
    throw e;
  }
  chmodSync(abs, 0o700);
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
    } else if (line === END_OF_COPY) table = null;
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

function checkPresence(files, problems) {
  for (const [n, text] of Object.entries(files)) {
    if (text === null) problems.push(`${n} is missing`);
    else if (text.trim() === "") problems.push(`${n} is empty`);
  }
}

function checkSchema(schema, problems) {
  if (!schema) return 0;
  for (const name of APP_SCHEMAS) {
    if (!new RegExp(String.raw`^CREATE TABLE (IF NOT EXISTS )?"?${name}"?\.`, "m").test(schema)) problems.push(`schema.sql has no CREATE TABLE in ${name}`);
  }
  return (schema.match(/^CREATE TABLE /gm) || []).length;
}

function checkData(data, problems) {
  if (!data) return {};
  try {
    const rowCounts = countCopyRows(data);
    if (Object.keys(rowCounts).length === 0) problems.push("data.sql has no COPY blocks");
    return rowCounts;
  } catch (e) {
    problems.push(e.message);
    return {};
  }
}

function checkCounts(countsText, rowCounts, problems) {
  if (!countsText?.trim()) return;
  let live;
  try {
    live = JSON.parse(countsText);
  } catch {
    problems.push("counts.prod.json is not valid JSON");
    return;
  }
  for (const [t, n] of Object.entries(live)) {
    const dumped = rowCounts[t] ?? 0;
    if (n !== null && dumped !== n) problems.push(`row count mismatch for ${t}: live ${n}, dump ${dumped}`);
  }
}

function checkSums(dir, sums, problems) {
  if (!sums) return;
  const listed = new Set();
  for (const line of sums.split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!m) {
      problems.push(`bad SHA256SUMS line: ${line}`);
      continue;
    }
    listed.add(m[2]);
    const path = join(dir, m[2]);
    if (!existsSync(path)) problems.push(`${m[2]} is listed in SHA256SUMS but missing`);
    else if (sha256(readFileSync(path)) !== m[1]) problems.push(`checksum mismatch for ${m[2]}`);
  }
  for (const n of readdirSync(dir)) if (n !== "SHA256SUMS" && !listed.has(n)) problems.push(`${n} is not covered by SHA256SUMS`);
}

export function verifyBackup(dir) {
  const problems = [];
  const files = Object.fromEntries(REQUIRED_FILES.map((n) => [n, existsSync(join(dir, n)) ? readFileSync(join(dir, n), "utf8") : null]));
  checkPresence(files, problems);
  const tables = checkSchema(files["schema.sql"], problems);
  const rowCounts = checkData(files["data.sql"], problems);
  checkCounts(files["counts.prod.json"], rowCounts, problems);
  checkSums(dir, files["SHA256SUMS"], problems);
  return { ok: problems.length === 0, problems, tables, rowCounts };
}

const PASS_ENV = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"];

function defaultRun(step) {
  // Absolute binary; the docker-related names pass through only because the supabase CLI starts docker.
  const env = { PGCONNECT_TIMEOUT: "10" };
  for (const name of PASS_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, step.env);
  const r = spawnSync(step.cmd, step.args, { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const secrets = step.secrets ?? [];
  if (r.stdout) process.stdout.write(redact(r.stdout, secrets));
  if (r.error) return { status: r.error.code === "ENOENT" ? 127 : 1, stderr: redact(r.error.message, secrets) };
  return { status: r.status, stderr: redact(r.stderr || "", secrets) };
}

const USAGE = "usage: node scripts/prod-backup.mjs --out <new dir outside repo> [--url-env NAME] [--dry-run]\n       node scripts/prod-backup.mjs --verify <dir>";

function printPlan(plan, source, log) {
  for (const s of plan) {
    const args = s.args.map((a) => (a === source.cliUrl ? source.label : a)).join(" ");
    const envNames = Object.keys(s.env);
    const envNote = envNames.length ? `  [env: ${envNames.join(", ")}]` : "";
    log(`  would run ${s.cmd} ${args}${envNote}`);
  }
  log("prod-backup: dry run, nothing executed and nothing written");
}

function writeManifest(outDir, source, now) {
  const dumped = readdirSync(outDir).sort((a, b) => (a < b ? -1 : Number(a > b)));
  for (const n of dumped) chmodSync(join(outDir, n), 0o600);
  const fileInfo = (n) => {
    const buf = readFileSync(join(outDir, n));
    return [n, { bytes: buf.length, sha256: sha256(buf) }];
  };
  const manifest = {
    schema: "ovd-prod-backup.v2",
    createdAt: now().toISOString(),
    source: source.kind,
    urlEnv: source.urlEnv,
    files: Object.fromEntries(dumped.map(fileInfo)),
    rowCounts: countCopyRows(readFileSync(join(outDir, "data.sql"), "utf8")),
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  writeChecksums(outDir, [...dumped, "manifest.json"]);
}

function runDump(opts, { env, run, log, err, now, bins }) {
  const outDir = checkOutDir(opts.out);
  const source = resolveSource({ env, urlEnv: opts.urlEnv });
  if (source.kind === "none") {
    err(`prod-backup: no credential path: ${source.reason}`);
    return 2;
  }
  const plan = buildPlan(source, outDir, bins());
  const secrets = [source.cliUrl, source.pgEnv.PGPASSWORD, source.pgEnv.PGHOST, source.pgEnv.PGUSER];
  log(`prod-backup: source ${source.kind} (${source.label}) from $${source.urlEnv}`);
  if (opts.dryRun) {
    printPlan(plan, source, log);
    return 0;
  }
  createOutDir(outDir);
  for (const s of plan) {
    log(`prod-backup: ${s.name} ...`);
    const r = run({ ...s, secrets });
    if (r.status !== 0) {
      const detail = r.stderr ? `: ${redact(r.stderr.trim(), secrets)}` : "";
      err(`prod-backup: ${s.name} failed (exit ${r.status})${detail}`);
      err(`prod-backup: ${outDir} holds a partial dump with customer data; delete it before retrying`);
      return 1;
    }
  }
  writeManifest(outDir, source, now);
  return report(verifyBackup(outDir), log, err);
}

const defaultBins = () => ({ supabase: resolveSupabase(), psql: resolvePsql() });

export function main(argv, deps = {}) {
  const { env = process.env, run = defaultRun, log = console.log, err = console.error, now = () => new Date(), bins = defaultBins } = deps;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return 0;
    }
    if (opts.verify) return report(verifyBackup(resolve(opts.verify)), log, err);
    return runDump(opts, { env, run, log, err, now, bins });
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
  log("prod-backup: verify PASS (integrity only; run scripts/window-1/restore-check.mjs next)");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
