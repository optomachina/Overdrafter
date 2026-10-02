/** Synthetic executor/backup proof in the parent-owned isolated container; no hosted access. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rehearseCliRestore } from "./ovd570-cli-rehearsal.mjs";
import { createHash } from "node:crypto";

export function rehearseExecutor({ call, container, psql, root, save, manifest, password, cli = false, network, fixtureId, image, output }) {
  const exec = (args, input, allowFailure = false) => call(["exec", "-i", "-e", `PGPASSWORD=${password}`, container, ...args],
    { input, timeout: 120000, allowFailure });
  const query = (database, text, allowFailure = false) => exec(["psql", "-U", "supabase_admin", "-d", database,
    "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", text], undefined, allowFailure);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const result = { scope: "synthetic isolated cluster only", executor: "psql single-query implicit transaction; CLI RESET ALL semantics reproduced, not actual CLI invocation", checks: [] };
  const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
  psql("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text); alter schema supabase_migrations owner to postgres; alter table supabase_migrations.schema_migrations owner to postgres;", 30000, "supabase_admin");
  // Batch deterministic fixture ledger setup instead of 112 Docker round trips.
  psql("begin;" + manifest.map((entry) => `insert into supabase_migrations.schema_migrations values (${literal(entry.name.split("_")[0])},array[]::text[],${literal(entry.name)});`).join("\n") + "commit;",30000,"supabase_admin");
  psql("create role ovd570_backup_probe nologin; comment on role ovd570_backup_probe is 'synthetic role restore probe'; create table public.ovd570_backup_probe(id integer primary key, value text); insert into public.ovd570_backup_probe values(1,'synthetic-only'); comment on table public.ovd570_backup_probe is 'OVD570 schema comment preserved'; grant select on public.ovd570_backup_probe to ovd570_backup_probe;",30000,"supabase_admin");
  const roles = exec(["pg_dumpall","-U","supabase_admin","--roles-only","--no-role-passwords"]).stdout;
  assert(!/PASSWORD '/.test(roles),"role_password_in_dump");
  // Restore the dedicated role from the actual globals dump; platform roles already exist in this cluster.
  const roleSql = roles.split("\n").filter(line => /^(CREATE ROLE|ALTER ROLE|COMMENT ON ROLE) ovd570_backup_probe\b/.test(line)).join("\n");
  assert(roleSql.includes("CREATE ROLE"),"role_dump_missing");
  const dump = exec(["pg_dump","-U","supabase_admin","-d","postgres","--schema=public","--schema=private","--schema=auth","--schema=storage","--schema=supabase_migrations","--schema=extensions","--no-publications","--no-subscriptions"]).stdout;
  result.backup = {sha256:createHash("sha256").update(dump).digest("hex"),bytes:Buffer.byteLength(dump),rolesSha256:createHash("sha256").update(roles).digest("hex"),rolePasswordsExcluded:true};
  if (cli) return rehearseCliRestore({ call, container, root, save, manifest, password, network, fixtureId, image, output, roles, dump });
  // A fresh template0 database tests the complete selected schema/data/ledger dump, including comments.
  query("postgres","create database ovd570_restore template template0;");
  try {
    query("ovd570_restore", "drop schema public;");
    exec(["psql","-U","supabase_admin","-d","ovd570_restore","-Xq","-v","ON_ERROR_STOP=1"],dump);
    assert(query("ovd570_restore","select count(*) from supabase_migrations.schema_migrations;").stdout.trim()==="112","restored_ledger_mismatch");
    assert(query("ovd570_restore","select value from public.ovd570_backup_probe;").stdout.trim()==="synthetic-only","restored_data_mismatch");
    assert(query("ovd570_restore","select obj_description('public.ovd570_backup_probe'::regclass);").stdout.trim()==="OVD570 schema comment preserved","restored_comment_mismatch");
    query("postgres", "revoke select on public.ovd570_backup_probe from ovd570_backup_probe;");
    query("ovd570_restore", "revoke select on public.ovd570_backup_probe from ovd570_backup_probe;");
    query("postgres", "drop role ovd570_backup_probe;" + roleSql);
    query("ovd570_restore", "grant select on public.ovd570_backup_probe to ovd570_backup_probe;");
    assert(query("ovd570_restore", "select has_table_privilege('ovd570_backup_probe','public.ovd570_backup_probe','select');").stdout.trim()==="t", "restored_role_grant_missing");
    result.checks.push("selected schema/data/112 ledger restore", "table comment and synthetic row preserved", "dedicated role recreated from password-free globals dump; grant verified");
    const migration=readFileSync(join(root,"supabase/migrations/20260926225000_confirm_sourcing_intent.sql"),"utf8");
    const ledger="insert into supabase_migrations.schema_migrations values ('20260926225000',array[]::text[],'confirm_sourcing_intent');";
    const failed=query("ovd570_restore",migration+ledger+"select 1/0;",true);
    assert(failed.status!==0 && /division by zero/.test(failed.stderr),"failure_not_injected");
    assert(query("ovd570_restore","select count(*)=112 and to_regclass('private.sourcing_destination_history') is null from supabase_migrations.schema_migrations;").stdout.trim()==="t","migration_ledger_not_atomic");
    const timeout=query("ovd570_restore","set statement_timeout='100ms'; reset all; select current_setting('statement_timeout'); set statement_timeout='100ms'; select pg_sleep(1);",true);
    assert(timeout.status!==0 && /statement timeout/.test(timeout.stderr) && timeout.stdout.trim()==="0","reset_all_timeout_contract_failed");
    exec(["sh", "-c", "PGAPPNAME=ovd570-lock-holder psql -U supabase_admin -d ovd570_restore -Xq -v ON_ERROR_STOP=1 -c 'begin; lock table public.ovd570_backup_probe in access exclusive mode; select pg_sleep(3); commit;' >/tmp/ovd570-lock-holder.log 2>&1 &"]);
    let held = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      held = query("ovd570_restore", "select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='ovd570-lock-holder' and l.mode='AccessExclusiveLock' and l.granted);").stdout.trim()==="t";
      if (held) break;
      query("ovd570_restore", "select pg_sleep(0.05);");
    }
    assert(held,"lock_holder_not_observed");
    const lockTimeout=query("ovd570_restore", "set lock_timeout='100ms'; select * from public.ovd570_backup_probe;", true);
    assert(lockTimeout.status!==0 && /lock timeout/.test(lockTimeout.stderr),"lock_timeout_not_observed");
    query("ovd570_restore", "select pg_sleep(3.1);");
    assert(query("ovd570_restore", "select count(*) from pg_stat_activity where application_name='ovd570-lock-holder';").stdout.trim()==="0","lock_holder_session_remains");
    result.checks.push("100ms lock timeout rejects concurrent held lock; holder commits and closes session");
    query("ovd570_restore",migration+ledger);
    assert(query("ovd570_restore","select count(*) from supabase_migrations.schema_migrations;").stdout.trim()==="113","target_ledger_mismatch");
    result.checks.push("implicit batch rolls migration and ledger back on failure", "RESET ALL clears session timeout; explicit post-reset timeout cancels sleep", "successful migration plus ledger produces 113");
  } finally {
    query("postgres","drop database ovd570_restore;");
  }
  assert(query("postgres","select count(*) from pg_stat_activity where datname='ovd570_restore';").stdout.trim()==="0","restore_sessions_remain");
  psql("drop table public.ovd570_backup_probe; drop role ovd570_backup_probe;",30000,"supabase_admin");
  result.checks.push("restore database removed normally; zero remaining restore sessions");
  result.limitations=["not actual Supabase CLI execution", "same-cluster platform roles, not complete independent-cluster role restoration", "no production TLS or recovery claim"];
  save("ovd570-executor-proof.json",result);
  return result;
}
