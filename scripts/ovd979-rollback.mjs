#!/usr/bin/env node
// OVD-979 rollback generator: re-run each replaced function's previous CREATE
// statement, taken byte for byte from the latest earlier migration that defines
// it, so the rollback is never a second copy of those bodies. Triggers, functions
// and indexes the migration creates are dropped first; columns are never dropped. A search_path that does not start with pg_catalog is restored as
// "pg_catalog, <old path>": lint-security-definer rejects a public-first path, and
// pg_proc.prosrc (the md5 the proof compares) is unchanged. The migration's own
// revoke/grant statements for each function follow it, so ACLs stay as deployed.
//
//   node scripts/ovd979-rollback.mjs <migration.sql>                   print the rollback
//   node scripts/ovd979-rollback.mjs <migration.sql> --prove --db-url URL
//
// --prove runs one transaction on a local database that already has the migration
// applied, and always rolls it back: rollback, md5(prosrc) equals the prior body and
// the path starts with pg_catalog, created objects are gone and indexed tables' rows
// are unchanged, rollback again, re-apply the migration, md5, ACL, config and created
// objects equal the applied ones. Only loopback URLs are accepted.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prosrcMd5, scanFunctionEvents } from "./check-migration-function-collisions.mjs";
import { findPsql } from "./seed-dev.mjs";
import { assertLocalDatabaseUrl } from "./supabase-target-guard.mjs";

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
  return statement.replace(/^(set\s+search_path\s*(?:=|to)\s*)(.+)$/im,
    (line, prefix, path) => (/^'?pg_catalog\b/i.test(path) ? line : `${prefix}pg_catalog, ${path}`));
}

const aclStatements = (sql, name) => sql.split("\n")
  .filter((line) => /^(revoke|grant)\b/i.test(line) && line.toLowerCase().includes(` function ${name}(`));

const ident = String.raw`(?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?`;

/** Triggers and indexes the migration creates, as `{ kind, name, table }`. */
export function createdObjects(migration) {
  const sql = read(join(migrationsDir, migration));
  const triggers = [...sql.matchAll(new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?trigger\s+(${ident})\s[\s\S]*?\bon\s+(${ident})`, "gim"))]
    .map(([, name, table]) => ({ kind: "trigger", name, table }));
  const indexes = [...sql.matchAll(new RegExp(String.raw`create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${ident})\s+on\s+(?:only\s+)?(${ident})`, "gi"))]
    .map(([, name, table]) => ({ kind: "index", name: name.includes(".") ? name : `${table.split(".")[0]}.${name}`, table }));
  return [...triggers, ...indexes];
}

/** For each function the migration defines: its prior definition and source file, or `created`. */
export function priorDefinitions(migration) {
  const earlier = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql") && name < migration).sort();
  return scanFunctionEvents(read(join(migrationsDir, migration)))
    .filter((event) => event.action === "define")
    .map(({ signature }) => {
      for (const file of [...earlier].reverse()) {
        const sql = read(join(migrationsDir, file));
        const prior = scanFunctionEvents(sql).filter((event) => event.signature === signature).at(-1);
        if (prior?.action === "define") return { signature, file, body: prior.body, statement: statementText(sql, prior) };
        if (prior) break;
      }
      return { signature, created: true };
    });
}

export function rollbackSql(migration) {
  const forward = read(join(migrationsDir, migration));
  const definitions = priorDefinitions(migration);
  const drops = [
    ...createdObjects(migration).filter(({ kind }) => kind === "trigger")
      .map(({ name, table }) => `drop trigger if exists ${name} on ${table};`),
    ...definitions.filter(({ created }) => created).map(({ signature }) => `drop function if exists ${signature};`),
    ...createdObjects(migration).filter(({ kind }) => kind === "index").map(({ name }) => `drop index if exists ${name};`),
  ];
  const parts = definitions.filter(({ created }) => !created).map(({ signature, file, statement }) => {
    const name = signature.slice(0, signature.indexOf("("));
    return [`-- ${signature} from ${file}`, pinCatalogFirst(statement), ...aclStatements(forward, name)].join("\n");
  });
  const dropped = drops.length ? `${drops.join("\n")}\n\n` : "";
  return `-- Generated by scripts/ovd979-rollback.mjs from ${migration}; do not edit.\n\n${dropped}${parts.join("\n\n")}\n`;
}

function proofSql(migration) {
  const definitions = priorDefinitions(migration);
  const priors = definitions.filter(({ created }) => !created);
  const created = createdObjects(migration);
  const literal = (text) => `'${text.replaceAll("'", "''")}'`;
  const present = [
    ...definitions.filter((d) => d.created).map(({ signature }) => `to_regprocedure(${literal(signature)}) is not null`),
    ...created.filter(({ kind }) => kind === "index").map(({ name }) => `to_regclass(${literal(name)}) is not null`),
    ...created.filter(({ kind }) => kind === "trigger").map(({ name, table }) =>
      `exists (select 1 from pg_catalog.pg_trigger where tgrelid = to_regclass(${literal(table)}) and tgname = ${literal(name.replaceAll('"', ""))})`),
  ];
  const tables = [...new Set(created.map(({ table }) => table))];
  const rowsHash = tables.map((table) => `(select md5(coalesce(string_agg(t::text, '' order by t::text), '')) from ${table} t)`).join(" || ");
  const oids = priors.map(({ signature }) => `'${signature}'::regprocedure`).join(", ");
  const expected = priors.map(({ signature, body }) => `('${signature}'::regprocedure, '${prosrcMd5(body)}')`).join(",\n  ");
  const check = (label, predicate) => `select '${label}: ' || case when ${predicate} then 'PASS' else 'FAIL' end;`;
  const restored = `(select bool_and(md5(p.prosrc) = e.md5 and p.proconfig[1] like 'search_path=pg_catalog%')
    from pg_catalog.pg_proc p join ovd979_expected e on e.oid = p.oid)`;
  const rollback = rollbackSql(migration);
  return [
    "\\set ON_ERROR_STOP on",
    "begin;",
    `create temp table ovd979_applied as select oid, prosrc, proacl, proconfig from pg_catalog.pg_proc where oid in (${oids});`,
    `create temp table ovd979_expected (oid oid, md5 text);\ninsert into ovd979_expected values\n  ${expected};`,
    check("applied migration differs from the prior bodies", `(select bool_and(md5(p.prosrc) <> e.md5) from pg_catalog.pg_proc p join ovd979_expected e on e.oid = p.oid)`),
    rollback,
    tables.length ? `create temp table ovd979_rows as select ${rowsHash} as hash;` : "",
    check(`rollback restores md5(prosrc) of ${priors.length} prior bodies, path pg_catalog first`, restored),
    present.length ? check(`rollback drops ${present.length} created objects`, present.map((p) => `not ${p}`).join(" and ")) : "",
    tables.length ? check(`rollback leaves rows of ${tables.join(", ")} unchanged`, `(select hash from ovd979_rows) = ${rowsHash}`) : "",
    check("rollback keeps the applied ACLs", "(select bool_and(p.proacl is not distinct from a.proacl) from pg_catalog.pg_proc p join ovd979_applied a using (oid))"),
    rollback,
    check("second rollback is a no-op", restored),
    read(join(migrationsDir, migration)),
    check("re-apply restores the applied bodies, ACLs and config", "(select bool_and(p.prosrc = a.prosrc and p.proacl is not distinct from a.proacl and p.proconfig is not distinct from a.proconfig) from pg_catalog.pg_proc p join ovd979_applied a using (oid))"),
    present.length ? check(`re-apply recreates ${present.length} created objects`, present.join(" and ")) : "",
    tables.length ? check(`re-apply leaves rows of ${tables.join(", ")} unchanged`, `(select hash from ovd979_rows) = ${rowsHash}`) : "",
    "rollback;",
  ].filter(Boolean).join("\n");
}

function main(argv) {
  const migration = argv[0] && basename(argv[0]);
  if (!migration) throw new Error("usage: ovd979-rollback.mjs <migration.sql> [--prove --db-url URL]");
  if (!argv.includes("--prove")) {
    process.stdout.write(rollbackSql(migration));
    return 0;
  }
  const url = argv[argv.indexOf("--db-url") + 1];
  assertLocalDatabaseUrl(url);
  // A fixed-directory psql (or SEED_PSQL_PATH), never a PATH lookup.
  const psql = findPsql();
  if (!psql) throw new Error("psql was not found in a fixed system directory or at SEED_PSQL_PATH.");
  const run = spawnSync(psql, [url, "-X", "-q", "-At", "-f", "-"], { input: proofSql(migration), encoding: "utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  const failed = run.status !== 0 || / FAIL$/m.test(run.stdout) || !/ PASS$/m.test(run.stdout);
  console.log(failed ? "ovd979 rollback proof: FAIL" : `ovd979 rollback proof: PASS (${migration})`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
