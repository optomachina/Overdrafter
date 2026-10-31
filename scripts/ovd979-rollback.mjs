#!/usr/bin/env node
// OVD-979 rollback for a migration that only replaces functions: re-run each
// function's previous CREATE statement, taken byte for byte from the latest
// earlier migration that defines it, so the rollback is never a second copy of
// those bodies. A search_path that does not start with pg_catalog is restored as
// "pg_catalog, <old path>": lint-security-definer rejects a public-first path, and
// pg_proc.prosrc (the md5 the proof compares) is unchanged. So prosrc and ACLs are
// restored exactly, but search_path is hardened, not reverted. The migration's own
// revoke/grant statements for each function follow it, so ACLs stay as deployed.
//
//   node scripts/ovd979-rollback.mjs <migration.sql>                   print the rollback
//   node scripts/ovd979-rollback.mjs <migration.sql> --prove --db-url URL
//
// --prove runs one transaction on a local database that already has the migration
// applied, and always rolls it back: rollback, md5(prosrc) equals the prior body and
// the path starts with pg_catalog, rollback again, re-apply the migration, md5, ACL
// and config equal the applied ones. Only a loopback host or a local socket directory is
// accepted (see assertProofDatabaseUrl), and psql runs with no PG* variables.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prosrcMd5, scanFunctionEvents } from "./check-migration-function-collisions.mjs";
import { findPsql } from "./seed-dev.mjs";
import { PRODUCTION_PROJECT_REF, TargetRefusedError } from "./supabase-target-guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");
const read = (file) => readFileSync(file, "utf8");

/** The CREATE statement of `event` in `sql`, from its line through the `;` after its body. */
function statementText(sql, event) {
  const start = sql.split("\n").slice(0, event.line - 1).join("\n").length + (event.line > 1 ? 1 : 0);
  const bodyAt = sql.indexOf(event.body, start);
  const end = sql.indexOf(";", bodyAt + event.body.length);
  if (bodyAt === -1 || end === -1) throw new Error(`cannot locate ${event.signature} at line ${event.line}`);
  return sql.slice(start, end + 1);
}

function pinCatalogFirst(statement) {
  // \s* and \S are disjoint, so the match cannot backtrack between prefix and path.
  return statement.replace(/^(set\s+search_path\s*(?:=|to)\s*)(\S.*)$/im,
    (line, prefix, path) => (/^'?pg_catalog\b/i.test(path) ? line : `${prefix}pg_catalog, ${path}`));
}

export function aclStatements(sql, name) {
  const statements = sql.split("\n")
    .filter((line) => /^(revoke|grant)\b/i.test(line) && line.includes(` function ${name}(`));
  // Only single-line statements are recognised; finding none means the rollback would drop the ACLs.
  if (statements.length === 0) throw new Error(`no single-line revoke/grant found for ${name}; refusing to generate a rollback without ACLs`);
  return statements;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SOCKET_DIRS = ["/tmp", "/private/tmp", "/var/run/postgresql", "/run/postgresql"];
// libpq keywords that pick the network destination or load one from a service file; dbname is
// refused too because libpq can expand a dbname value as a second connection string.
const ENDPOINT_PARAMS = new Set(["host", "hostaddr", "service", "servicefile", "dbname"]);

/** The host libpq's URI parser (conninfo_uri_parse_options) reads from `rest`, the text after "scheme://". */
export function libpqHost(rest) {
  const userEnd = rest.search(/[@/]/);
  const start = userEnd !== -1 && rest[userEnd] === "@" ? userEnd + 1 : 0;
  const tail = rest.slice(start);
  if (tail.startsWith("[")) {
    const close = tail.indexOf("]");
    return close === -1 ? tail : tail.slice(0, close + 1);
  }
  return tail.split(/[:/?,]/, 1)[0];
}

function isLocalSocketDir(path) {
  if (!/^\/[A-Za-z0-9_./-]*$/.test(path) || path.split("/").includes("..")) return false;
  return SOCKET_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/**
 * Throws unless `databaseUrl` is one postgres:// URL whose only destination is a loopback host or a
 * unix socket under a local directory. libpq reads the destination from the authority, from
 * host/hostaddr/service query parameters and from PG* environment variables; this guard covers the
 * first two and `proofPsqlEnv` removes the third.
 */
export function assertProofDatabaseUrl(databaseUrl) {
  const refuse = (reason) => { throw new TargetRefusedError(`--prove database URL refused: ${reason}`, undefined); };
  if (typeof databaseUrl !== "string" || databaseUrl === "") refuse("a URL is required");
  // WHATWG URL drops tabs and newlines and knows fragments; libpq does neither, so allow none of them.
  if (!/^[\x21-\x7e]+$/.test(databaseUrl)) refuse("whitespace or non-ASCII characters");
  if (databaseUrl.includes("#")) refuse("fragments are not allowed");
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    refuse("not a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) refuse(`protocol ${url.protocol}`);
  const authority = databaseUrl.slice(url.protocol.length + 2).split(/[/?]/, 1)[0];
  if (!databaseUrl.startsWith(`${url.protocol}//`) || authority.includes(",")) refuse("multi-host lists are not allowed");
  // WHATWG splits user info at the last '@', libpq at the first.
  if (authority.split("@").length > 2) refuse("more than one '@' in the authority");
  for (const key of url.searchParams.keys()) {
    if (ENDPOINT_PARAMS.has(key.toLowerCase())) refuse(`query parameter ${key} overrides the destination`);
  }
  let host;
  let libpqView;
  try {
    host = decodeURIComponent(url.hostname).toLowerCase();
    libpqView = decodeURIComponent(libpqHost(databaseUrl.slice(url.protocol.length + 2))).toLowerCase();
  } catch {
    refuse("host is not valid percent-encoding");
  }
  // libpq ends user info at the first '@' before a '/', even past a '?'; WHATWG ends the authority at '?'.
  if (libpqView !== host) refuse(`libpq would connect to ${JSON.stringify(libpqView)}, not ${JSON.stringify(host)}`);
  if (!LOOPBACK_HOSTS.has(host) && !isLocalSocketDir(host)) refuse(`host ${JSON.stringify(host)} is not loopback or a local socket directory`);
  if (databaseUrl.toLowerCase().includes(PRODUCTION_PROJECT_REF)) refuse(`URL names the production project ${PRODUCTION_PROJECT_REF}`);
  return url;
}

/** The child environment for psql: no PG* variable (libpq would read PGHOST, PGSERVICE and others), fixed PATH. */
export function proofPsqlEnv(env = process.env) {
  const scrubbed = Object.fromEntries(Object.entries(env).filter(([key]) => !/^pg/i.test(key)));
  return { ...scrubbed, PATH: "/usr/bin:/bin" };
}

/** For each function the migration defines: its prior definition and source file. */
export function priorDefinitions(migration) {
  const earlier = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql") && name < migration).sort();
  return scanFunctionEvents(read(join(migrationsDir, migration)))
    .filter((event) => event.action === "define")
    .map(({ signature }) => {
      for (const file of [...earlier].reverse()) {
        const sql = read(join(migrationsDir, file));
        const prior = scanFunctionEvents(sql).findLast((event) => event.signature === signature);
        if (prior?.action === "define") return { signature, file, body: prior.body, statement: statementText(sql, prior) };
        if (prior) break;
      }
      throw new Error(`${signature} has no earlier definition; this generator only restores replaced functions`);
    });
}

export function rollbackSql(migration) {
  const forward = read(join(migrationsDir, migration));
  const parts = priorDefinitions(migration).map(({ signature, file, statement }) => {
    const name = signature.slice(0, signature.indexOf("("));
    return [`-- ${signature} from ${file}`, pinCatalogFirst(statement), ...aclStatements(forward, name)].join("\n");
  });
  return `-- Generated by scripts/ovd979-rollback.mjs from ${migration}; do not edit.\n\n${parts.join("\n\n")}\n`;
}

export function proofSql(migration) {
  const priors = priorDefinitions(migration);
  const oids = priors.map(({ signature }) => `'${signature}'::regprocedure`).join(", ");
  const expected = priors.map(({ signature, body }) => `('${signature}'::regprocedure, '${prosrcMd5(body)}')`).join(",\n  ");
  const check = (label, predicate) => `select '${label}: ' || case when ${predicate} then 'PASS' else 'FAIL' end;`;
  const restored = `(select bool_and(md5(p.prosrc) = e.md5 and p.proconfig[1] like 'search_path=pg_catalog%')
    from pg_catalog.pg_proc p join ovd979_expected e on e.oid = p.oid)`;
  const rollback = rollbackSql(migration);
  return [
    String.raw`\set ON_ERROR_STOP on`,
    "begin;",
    `create temp table ovd979_applied as select oid, prosrc, proacl, proconfig from pg_catalog.pg_proc where oid in (${oids});`,
    `create temp table ovd979_expected (oid oid, md5 text);\ninsert into ovd979_expected values\n  ${expected};`,
    check("applied migration differs from the prior bodies", `(select bool_and(md5(p.prosrc) <> e.md5) from pg_catalog.pg_proc p join ovd979_expected e on e.oid = p.oid)`),
    rollback,
    check(`rollback restores md5(prosrc) of ${priors.length} prior bodies; search_path hardened, not reverted`, restored),
    check("rollback keeps the applied ACLs", "(select bool_and(p.proacl is not distinct from a.proacl) from pg_catalog.pg_proc p join ovd979_applied a using (oid))"),
    rollback,
    check("second rollback is a no-op", restored),
    read(join(migrationsDir, migration)),
    check("re-apply restores the applied bodies, ACLs and config", "(select bool_and(p.prosrc = a.prosrc and p.proacl is not distinct from a.proacl and p.proconfig is not distinct from a.proconfig) from pg_catalog.pg_proc p join ovd979_applied a using (oid))"),
    "rollback;",
  ].join("\n");
}

function main(argv) {
  const migration = argv[0] && basename(argv[0]);
  if (!migration) throw new Error("usage: ovd979-rollback.mjs <migration.sql> [--prove --db-url URL]");
  if (!argv.includes("--prove")) {
    process.stdout.write(rollbackSql(migration));
    return 0;
  }
  const urlAt = argv.indexOf("--db-url");
  const url = urlAt === -1 ? undefined : argv[urlAt + 1];
  assertProofDatabaseUrl(url);
  // A fixed-directory psql (or SEED_PSQL_PATH), never a PATH lookup; the connection comes only from
  // the validated URL because the child gets no PG* variables.
  const psql = findPsql();
  if (!psql) throw new Error("psql was not found in a fixed system directory or at SEED_PSQL_PATH.");
  const run = spawnSync(psql, [url, "-X", "-q", "-At", "-f", "-"], {
    input: proofSql(migration),
    encoding: "utf8",
    env: proofPsqlEnv(),
  });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  const failed = run.status !== 0 || / FAIL$/m.test(run.stdout) || !/ PASS$/m.test(run.stdout);
  console.log(failed ? "ovd979 rollback proof: FAIL" : `ovd979 rollback proof: PASS (${migration})`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
