/** Actual installed CLI and independent-cluster restore, exclusively synthetic/owned. */
import { readFileSync } from "node:fs";
import { transferCliInput } from "./ovd570-cli-input.mjs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function rehearseCliRestore({ call, container, root, save, manifest, password, network, fixtureId, image, roles, dump }) {
  const restore = `${container}-restore`;
  const receipt = { scope: "synthetic only", checks: [], cleanup: "not_created" };
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const exec = (target,args,input,allowFailure=false) => call(["exec","-i","-e",`PGPASSWORD=${password}`,target,...args],{input,allowFailure,timeout:120000});
  const sql = (target,db,text) => exec(target,["psql","-U","supabase_admin","-d",db,"-XAtq","-v","ON_ERROR_STOP=1"],text).stdout.trim();
  let created = false;
  receipt.inputs = [];
  const transfer = (path, bytes) => receipt.inputs.push(transferCliInput(exec, container, path, bytes));
  try {
    call(["run","--detach","--name",restore,"--network",network,"--cpus","2","--memory","4g","--pids-limit","256","--tmpfs","/var/lib/postgresql/data:rw,nosuid,size=2048m","--tmpfs","/tmp:rw,nosuid,size=512m","--label",`overdrafter.fixture-id=${fixtureId}`,"-e",`POSTGRES_PASSWORD=${password}`,image]);
    created=true;
    let ready=false;
    for(let i=0;i<60;i++) { if(call(["inspect","--format","{{.State.Health.Status}}",restore]).stdout.trim()==="healthy") {ready=true;break;} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000); }
    assert(ready,"independent_restore_not_ready");
    const existing=new Set(sql(restore,"postgres","select rolname from pg_roles;").split("\n"));
    // Retain all ALTER/COMMENT/GRANT statements; skip only CREATE for pinned-image roles already present.
    const restoredRoles=roles.split("\n").filter(line=>{const m=line.match(/^CREATE ROLE (?:"([^"]+)"|([^ ;]+));$/);return !m || !existing.has(m[1]??m[2]);}).join("\n");
    sql(restore,"postgres",restoredRoles);
    const roleProjection="select jsonb_agg(x order by rolname)::text from (select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolconfig from pg_roles where rolname !~ '^pg_') x;";
    assert(sql(container,"postgres",roleProjection)===sql(restore,"postgres",roleProjection),"role_attributes_restore_mismatch");
    const memberships="select coalesce(jsonb_agg(x order by roleid,member,grantor),'[]'::jsonb)::text from (select r.rolname roleid,m.rolname member,g.rolname grantor,a.admin_option,a.inherit_option,a.set_option from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor) x;";
    assert(sql(container,"postgres",memberships)===sql(restore,"postgres",memberships),"role_membership_restore_mismatch");
    sql(restore,"postgres","create database ovd570_restore template template0;");
    sql(restore,"ovd570_restore","drop schema public;");
    sql(restore,"ovd570_restore",dump);
    assert(sql(restore,"ovd570_restore","select count(*) from supabase_migrations.schema_migrations;")==="112","independent_ledger_mismatch");
    assert(sql(restore,"ovd570_restore","select value || ':' || obj_description('public.ovd570_backup_probe'::regclass) || ':' || has_table_privilege('ovd570_backup_probe','public.ovd570_backup_probe','select') from public.ovd570_backup_probe;")==="synthetic-only:OVD570 schema comment preserved:true","independent_data_comment_acl_mismatch");
    receipt.checks.push("independent cluster restores role attributes/memberships, selected schemas/data/ledger, comment and grant");
    exec(container,["mkdir","-p","/opt/ovd570-project/supabase/migrations"]);
    transfer("/opt/ovd570-project/supabase/config.toml", 'project_id = "ovd570-synthetic"\n[db]\nmajor_version = 17\n');
    for(const entry of manifest) transfer(`/opt/ovd570-project/supabase/migrations/${entry.name}`,readFileSync(join(root,"supabase","migrations",entry.name)));
    const name="20260926225000_confirm_sourcing_intent.sql";
    const migration=readFileSync(join(root,"supabase","migrations",name),"utf8");
    assert(createHash("sha256").update(migration).digest("hex")==="249815c28c9255044413ff2e9bd2a726a0e0728cb117895b25c3bbc91c9d8ffc","target_hash_drift");
    const target=`/opt/ovd570-project/supabase/migrations/${name}`;
    const archive=join(root,"..","evidence","ovd570-linux-cli","supabase_linux_arm64.tar.gz");
    const archiveBytes=readFileSync(archive);
    const archiveHash=createHash("sha256").update(archiveBytes).digest("hex");
    assert(archiveHash==="b3d941c1aefbe469db17af1a12373c8a9176e24b9f9499bd509477e5be598501","linux_cli_archive_hash_mismatch");
    transfer("/opt/ovd570-cli.tar.gz",archiveBytes);
    exec(container,["mkdir","/opt/ovd570-cli"]);
    exec(container,["tar","-xzf","/opt/ovd570-cli.tar.gz","-C","/opt/ovd570-cli"]);
    receipt.cliVersion=exec(container,["/opt/ovd570-cli/supabase","--version"]).stdout.trim();
    assert(receipt.cliVersion==="2.78.1","linux_cli_version_mismatch");
    receipt.cliArchiveSha256=archiveHash;
    let variant = migration;
    const cli=(extra=[])=> {
      transfer(target, variant);
      return exec(container,["env","PGSSLMODE=disable","/opt/ovd570-cli/supabase","db","push","--db-url","postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable","--workdir","/opt/ovd570-project","--yes",...extra],undefined,true);
    };
    const pristine=()=>assert(sql(container,"postgres","select count(*)=112 and to_regclass('private.sourcing_destination_history') is null from supabase_migrations.schema_migrations;")==="t","cli_failure_not_atomic");
    variant=migration+"\nselect 1/0;\n";
    let run=cli();
    assert(run.status!==0 && /division by zero/.test(run.stdout+run.stderr),"cli_injected_failure_not_observed:"+(run.stderr??"").slice(-600)); pristine();
    receipt.checks.push("actual CLI failed migration leaves 112 ledger and no target table");
    sql(container,"postgres","alter table supabase_migrations.schema_migrations add constraint ovd570_reject_target check (version <> '20260926225000');");
    variant=migration;
    run=cli(); assert(run.status!==0 && /ovd570_reject_target/.test(run.stdout+run.stderr),"cli_ledger_failure_not_observed"); pristine();
    sql(container,"postgres","alter table supabase_migrations.schema_migrations drop constraint ovd570_reject_target;");
    receipt.checks.push("actual CLI ledger insert failure rolls back preceding migration schema changes");

    sql(container,"postgres","alter role postgres in database postgres set statement_timeout='100ms';");
    variant=migration+"\nselect pg_sleep(1);\n";
    run=cli(); assert(run.status!==0 && /statement timeout/.test(run.stdout+run.stderr),"cli_statement_timeout_not_observed"); pristine();
    sql(container,"postgres","alter role postgres in database postgres reset statement_timeout;");
    receipt.checks.push("actual CLI RESET ALL retains connection role/database default statement timeout; failure rolls back migration and ledger");
    variant=migration;
    sql(container,"postgres","alter role postgres in database postgres set lock_timeout='100ms';");
    exec(container,["sh","-c","PGAPPNAME=ovd570-cli-lock psql -U supabase_admin -d postgres -Xq -v ON_ERROR_STOP=1 -c 'begin; lock table public.organizations in access exclusive mode; select pg_sleep(8); commit;' >/tmp/ovd570-cli-lock.log 2>&1 &"]);
    let held=false;
    for(let i=0;i<20;i++) { held=sql(container,"postgres","select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='ovd570-cli-lock' and l.mode='AccessExclusiveLock' and l.granted);")==="t"; if(held)break; sql(container,"postgres","select pg_sleep(0.05);"); }
    assert(held,"cli_lock_not_held");
    run=cli(); assert(run.status!==0 && /lock timeout/.test(run.stdout+run.stderr),"cli_lock_timeout_not_observed"); pristine();
    sql(container,"postgres","select pg_sleep(8.1); alter role postgres in database postgres reset lock_timeout;");
    assert(sql(container,"postgres","select count(*) from pg_stat_activity where application_name='ovd570-cli-lock';")==="0","cli_lock_session_remains");
    receipt.checks.push("actual CLI unchanged migration obeys role/database lock timeout; holder and CLI sessions close");
    run=cli(["--dry-run"]); assert(run.status===0 && (run.stdout+run.stderr).includes(name),"cli_dry_run_failed");
    run=cli(); assert(run.status===0,"cli_pristine_apply_failed:"+(run.stderr??"").slice(-600));
    assert(sql(container,"postgres","select count(*) from supabase_migrations.schema_migrations;")==="113","cli_final_ledger_count");
    assert(sql(container,"postgres","select cardinality(statements)>0 from supabase_migrations.schema_migrations where version='20260926225000';")==="t","cli_statement_ledger_missing");
    receipt.checks.push("actual CLI dry-run and unchanged migration succeed; 113 ledger with stored statements");
    assert(sql(container,"postgres","select count(*) from pg_stat_activity where backend_type='client backend' and pid<>pg_backend_pid() and usename='postgres';")==="0","cli_sessions_remain");
    sql(restore,"postgres","drop database ovd570_restore;");
    receipt.checks.push("CLI sessions closed and independent restore database removed normally");
    receipt.limitations=["no production TLS/credentials/backup evidence", "role/database timeout defaults altered only in synthetic fixture; production configuration requires explicit disposition"];
  } finally {
    // A failed/timed-out run may have created the resource before losing its reply.
    const observed=call(["inspect","--format",'{{ index .Config.Labels "overdrafter.fixture-id" }}',restore],{allowFailure:true,allowAfterDeadline:true});
    if(observed.status===0) {
      assert(observed.stdout.trim()===fixtureId,"restore_cleanup_ownership_mismatch");
      call(["rm","--force",restore],{allowAfterDeadline:true}); receipt.cleanup="removed_owned";
    } else {
      receipt.cleanup=!created && /No such (object|container)/i.test(observed.stderr??"") ? "not_created" : "unproved";
    }
    save("ovd570-cli-proof.json",receipt);
    assert(receipt.cleanup!=="unproved","restore_cleanup_unproved");
  }
  return receipt;
}
