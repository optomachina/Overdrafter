/** Before/after repair proof on the exact immutable expiry baseline; no arbitrary SQL admission. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const migrationPath = "supabase/migrations/20261002053133_align_selection_and_publication_sources.sql";
const fixturePath = "supabase/tests/quote_selection_publication_contract.sql";
const privilegesPath = "supabase/tests/quote_publication_helper_privileges.sql";
const pins = {
  [migrationPath]: "70359183621feca322414cd4a2968c3611578ac7b571cbbf455603cd272aa3bf",
  [fixturePath]: "d475456aa12381a33037f77ce0e1075f8048ad1653f90b1e137648bc8c0cca3d",
  [privilegesPath]: "66e3569ba12896520782a889446b06dd973d7db191106040dd7bbdad761cf36b",
};
const digest = (text) => createHash("sha256").update(text).digest("hex");
const read = (root, path) => readFileSync(join(root, path), "utf8");
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export function admitPublicationContract(root) {
  for (const [path, pin] of Object.entries(pins)) assert(digest(read(root, path)) === pin, `publication_input_drift:${path}`);
}
const inspectSql = `select jsonb_build_object(
  'helper', (select jsonb_build_object('owner',pg_get_userbyid(proowner),'securityDefiner',prosecdef,
    'acl',proacl,'definition',pg_get_functiondef(oid)) from pg_proc
    where oid='public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)'::regprocedure),
  'tableAcl',(select relacl from pg_class where oid='public.client_selections'::regclass),
  'columnAcl',(select jsonb_agg(jsonb_build_object('name',attname,'acl',attacl) order by attnum)
    from pg_attribute where attrelid='public.client_selections'::regclass and attnum>0 and not attisdropped),
  'effective',(select jsonb_agg(jsonb_build_object('role',rolname,
    'tableUpdate',has_table_privilege(rolname,'public.client_selections','UPDATE'),
    'columnUpdate',has_any_column_privilege(rolname,'public.client_selections','UPDATE'),
    'helperExecute',has_function_privilege(rolname,'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)','EXECUTE')) order by rolname)
    from pg_roles where rolname in ('anon','authenticated','service_role','postgres')));`;
const rollbackSql = `select count(*) from public.organizations where id in
  ('ec420002-1002-4000-8000-000000000002','ec420002-1002-4000-8000-000000000020','00000000-0000-4000-8000-000000004193');`;
function tapCounts(tap, count) {
  assert(tap.split("\n").includes(`1..${count}`), "publication_fixture_plan_mismatch");
  const assertions = tap.split("\n").filter((line) => /^(?:not )?ok\b/.test(line));
  assert(assertions.length === count, "publication_fixture_incomplete");
  return { passed: assertions.filter((line) => /^ok\b/.test(line)).length,
    failed: assertions.filter((line) => /^not ok\b/.test(line)) };
}
export function rehearsePublicationContract({ root, psql, save, sourceRevision, sourceManifestSha256 }) {
  const report = { sourceRevision, sourceManifestSha256, syntheticOnly: true, pins,
    baseline: "112 pinned source migrations plus unchanged expiry migration; publication repair not yet applied" };
  const fixture = read(root, fixturePath);
  report.beforeAcl = JSON.parse(psql(inspectSql));
  const beforeTap = psql(fixture);
  report.before = { ...tapCounts(beforeTap, 45), tap: beforeTap };
  save("selection-publication-proof.json", report);
  const requiredFailures = ["service_role has no table UPDATE grant",
    "service_role cannot rewrite an existing selection to an expired option",
    "helper rejects a result with no source offers",
    "internal parent rejects no-offer result after starting republication",
    "omitted source rejects multiple variants even when only one matches commercial fields"];
  assert(requiredFailures.every((label) => report.before.failed.some((line) => line.includes(` - ${label}`))), "publication_failure_before_not_reproduced");
  assert(psql(rollbackSql) === "0", "publication_before_fixture_rollback_failed");
  report.before.rollbackProved = true;

  // Deliberately add a column grant in this owned fixture so table-only revocation cannot pass.
  psql("grant update (note) on public.client_selections to service_role;");
  const beforeMigration = psql(inspectSql);
  report.columnGrantProbe = JSON.parse(beforeMigration);
  assert(report.columnGrantProbe.columnAcl.some((column) => column.name === "note" && JSON.stringify(column.acl).includes("service_role")), "column_grant_probe_missing");
  const migration = read(root, migrationPath);
  assert(migration.startsWith("begin;") && /commit;\s*$/.test(migration), "publication_transaction_wrapper_drift");
  const body = migration.replace(/^begin;/, "").replace(/commit;\s*$/, "");
  let rolledBack = false;
  try { psql(`begin;${body}\ndo $$begin raise exception 'publication_contract_rollback_probe'; end$$; commit;`); }
  catch (error) { if (!String(error).includes("publication_contract_rollback_probe")) throw error; rolledBack = true; }
  assert(rolledBack && psql(inspectSql) === beforeMigration, "publication_migration_rollback_mismatch");
  report.migrationRollbackProved = true;
  psql(migration);
  report.afterAcl = JSON.parse(psql(inspectSql));
  assert(report.afterAcl.helper.owner === "postgres" && report.afterAcl.helper.securityDefiner, "publication_helper_owner_drift");
  assert(report.afterAcl.effective.every((role) => role.role === "postgres"
    ? role.helperExecute : !role.tableUpdate && !role.columnUpdate && !role.helperExecute), "publication_effective_acl_mismatch");
  save("selection-publication-proof.json", report);
  for (const [name, path, count] of [["after", fixturePath, 45], ["publicationPrivileges", privilegesPath, 14]]) {
    const tap = psql(read(root, path));
    report[name] = { ...tapCounts(tap, count), tap };
    save("selection-publication-proof.json", report);
    assert(report[name].failed.length === 0 && !/Looks like you failed/i.test(tap), `publication_suite_failed:${name}`);
    assert(psql(rollbackSql) === "0", `publication_fixture_rollback_failed:${name}`);
    report[name].rollbackProved = true;
  }
  report.status = "passed";
  save("selection-publication-proof.json", report);
}
