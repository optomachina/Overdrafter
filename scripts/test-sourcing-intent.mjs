/** OVD-570 owned, disposable SQL fixture. No host mounts, ports, or egress. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareSourcingSchemaRestore } from "./prepare-sourcing-schema-restore.mjs";
import { captureCatalogObjectDiffs, fetchCatalogRows } from "./catalog-parity-diff.mjs";

const root = resolve(import.meta.dirname, "..");
const baseContainer = process.env.OVD570_LOCAL_SCHEMA_CONTAINER;
const image = "sha256:965e2dfb5a23a0d6541b6106541e777b303656ebabd4e878746b189d550c0a66";
const owner = "01a0dfe1-4ecc-7692-868d-c093500c04ac";
const suffix = randomUUID().slice(0, 8);
const network = `ovd570-${suffix}`;
const container = `ovd570-db-${suffix}`;
const temporary = mkdtempSync(join(tmpdir(), "ovd570-fixture-"));
const envPath = join(temporary, "db.env");
const started = Date.now();
const deadline = started + 30 * 60 * 1000;
const cleanupDeadline = deadline + 5 * 60 * 1000;
const outputDirectory = join(root, "output");
const testSuites = [
  { path: "supabase/fixtures/sourcing-intent/sourcing_intent_backfill.sql", count: 5 },
  { path: "supabase/tests/sourcing_intent.sql", count: 36 },
  { path: "supabase/tests/quote_lane_eligibility.sql", count: 25 },
  { path: "supabase/tests/xometry_beta_dispatch_permits.sql", count: 63 },
  { path: "supabase/tests/xometry_beta_dispatch_permits_concurrency.sql", count: 3, user: "supabase_admin" },
  { path: "supabase/tests/sourcing_intent_concurrency.sql", count: 13, user: "supabase_admin" },
];
const priorAttempts = readdirSync(outputDirectory).map((name) => /^ovd570-sql-fixture-attempt-(\d+)\.json$/.exec(name)?.[1])
  .filter(Boolean).map(Number);
const attempt = Math.max(3, ...priorAttempts) + 1;
let networkId = null;
let containerId = null;
let result = { status: "failed", phase: "fixture_setup", owner, image, attempt, startedAt: new Date(started).toISOString(), migrationCount: 0, testCount: 0, prechangeMissing: false,
  sourceSha256: Object.fromEntries(["scripts/test-sourcing-intent.mjs", "scripts/catalog-parity-diff.mjs", "scripts/catalog-parity-diff.node-test.mjs", "scripts/prepare-sourcing-schema-restore.mjs", "scripts/prepare-sourcing-schema-restore.node-test.mjs", "scripts/check-sourcing-worker-scope.mjs", "worker/src/quoteScope.ts", "supabase/migrations/20260926225000_confirm_sourcing_intent.sql", "supabase/fixtures/sourcing-intent/sourcing_intent_preexisting.sql", "supabase/fixtures/sourcing-intent/commercial_rollout_defaults.sql", "supabase/fixtures/sourcing-intent/sourcing_worker_scope.sql", ...testSuites.map((suite) => suite.path)]
    .map((name) => [name, createHash("sha256").update(readFileSync(join(root, name))).digest("hex")])) };

function run(command, args, input, timeout = 60_000, cleanup = false) {
  const currentDeadline = cleanup ? cleanupDeadline : deadline;
  if (Date.now() >= currentDeadline) throw new Error(cleanup ? "cleanup_deadline_exceeded" : "fixture_deadline_exceeded");
  const execution = spawnSync(command, args, {
    cwd: root, input, encoding: "utf8", timeout: Math.min(timeout, currentDeadline - Date.now()),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (execution.error || execution.status !== 0) {
    const detail = (execution.stderr || execution.stdout || execution.error?.message || "").slice(-1200);
    const error = new Error(`${command} failed: ${detail}`);
    error.stdout = (execution.stdout ?? "").slice(-65_536);
    error.stderr = (execution.stderr ?? "").slice(-8_192);
    error.exitCode = execution.status;
    throw error;
  }
  return execution.stdout.trim();
}

function docker(...args) { return run("docker", args); }
function cleanupDocker(...args) { return run("docker", args, undefined, 30_000, true); }
function sql(source, database = "postgres", user = "postgres") {
  if (user === "supabase_admin") {
    // The owned container holds this run's random password. Expand it only
    // inside the container so it never enters host command arguments or logs.
    return run("docker", ["exec", "-i", container, "sh", "-c",
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U supabase_admin -d "$1" -w -X -Atq -v ON_ERROR_STOP=1 -P pager=off',
      "fixture-restore", database], source, 120_000);
  }
  return run("docker", ["exec", "-i", container, "psql", "-U", user, "-d", database,
    "-w", "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-P", "pager=off"], source, 120_000);
}
function owned(id, cleanup = false) {
  if (!id) return false;
  const details = JSON.parse((cleanup ? cleanupDocker : docker)("inspect", id, "--format", "{{json .}}"));
  const item = Array.isArray(details) ? details[0] : details;
  return item?.Config?.Labels?.["overdrafter.fixture.owner"] === owner
    || item?.Labels?.["overdrafter.fixture.owner"] === owner;
}

try {
  if (!baseContainer || !/^supabase_db_[a-z0-9.-]+$/.test(baseContainer)) {
    throw new Error("explicit_local_schema_container_required");
  }
  const baseDetails = JSON.parse(docker("inspect", baseContainer, "--format", "{{json .}}"));
  if (baseDetails?.State?.Running !== true
    || baseDetails?.Config?.Image !== "public.ecr.aws/supabase/postgres:17.6.1.095") {
    throw new Error("local_schema_container_identity_mismatch");
  }
  writeFileSync(envPath, `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}\nPOSTGRES_USER=supabase_admin\nPOSTGRES_DB=postgres\n`, { mode: 0o600 });
  networkId = docker("network", "create", "--internal", "--label", `overdrafter.fixture.owner=${owner}`, network);
  containerId = docker("run", "--detach", "--name", container, "--network", network,
    "--label", `overdrafter.fixture.owner=${owner}`,
    "--cpus", "1", "--memory", "1536m", "--pids-limit", "256",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=1100m",
    "--tmpfs", "/tmp:rw,size=128m",
    "--env-file", envPath, image);

  let ready = false;
  for (let readyAttempt = 0; readyAttempt < 180 && Date.now() < deadline; readyAttempt += 1) {
    const checkBudget = Math.max(1, Math.min(5_000, deadline - Date.now()));
    const check = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "postgres"],
      { encoding: "utf8", timeout: checkBudget });
    if (Date.now() >= deadline) break;
    const logBudget = Math.max(1, Math.min(5_000, deadline - Date.now()));
    const init = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: logBudget, maxBuffer: 4 * 1024 * 1024 });
    if (check.status === 0 && `${init.stdout}${init.stderr}`.includes("PostgreSQL init process complete")) {
      ready = true;
      break;
    }
    const pause = Math.min(500, Math.max(0, deadline - Date.now()));
    if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
  }
  if (!ready) throw new Error("database_not_ready_after_init");
  result.adminReady = sql("select current_user, rolsuper from pg_roles where rolname=current_user;", "postgres", "supabase_admin") === "supabase_admin|t";
  if (!result.adminReady) throw new Error("admin_authentication_preflight_failed");

  // The pinned image omits two service-created cluster roles present in the
  // local schema dump. A successful pinned-image replay catalog contains the
  // other 13 roles; both omitted roles own restored objects. Admit only that
  // complete, exact delta. No role password is copied from the local cluster.
  const roleQuery = "select rolname from pg_roles where rolname not like 'pg_%' order by rolname";
  const baselineRoles = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", roleQuery]).split("\n");
  const fixtureRoles = sql(roleQuery).split("\n");
  const missingRoles = baselineRoles.filter((role) => !fixtureRoles.includes(role));
  const extraRoles = fixtureRoles.filter((role) => !baselineRoles.includes(role));
  result.platformRoleDelta = { missingRoles, extraRoles };
  if (JSON.stringify(missingRoles) !== JSON.stringify(["supabase_functions_admin", "supabase_realtime_admin"]) || extraRoles.length > 0) {
    throw new Error("unexpected_platform_role_delta");
  }
  const functionsRole = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c",
    "select format('%s|%s|%s|%s|%s|%s|%s',rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) from pg_roles where rolname='supabase_functions_admin'"]);
  const realtimeRole = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c",
    "select format('%s|%s|%s|%s|%s|%s|%s',rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) from pg_roles where rolname='supabase_realtime_admin'"]);
  const serviceMemberships = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c",
    "select format('%s|%s|%s|%s|%s',parent.rolname,member.rolname,m.admin_option,m.inherit_option,m.set_option) from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member where parent.rolname in ('supabase_functions_admin','supabase_realtime_admin') or member.rolname in ('supabase_functions_admin','supabase_realtime_admin') order by parent.rolname,member.rolname"]);
  const serviceRoleSettings = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c",
    "select format('%s|%s|%s',r.rolname,s.setdatabase,s.setconfig::text) from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname in ('supabase_functions_admin','supabase_realtime_admin') order by r.rolname"]);
  if (functionsRole !== "f|f|t|f|t|f|f" || realtimeRole !== "f|f|f|f|f|f|f"
    || serviceMemberships !== "supabase_functions_admin|postgres|f|t|t\nsupabase_realtime_admin|postgres|f|t|t"
    || serviceRoleSettings !== "supabase_functions_admin|0|{search_path=supabase_functions}") {
    throw new Error("service_role_contract_changed");
  }
  sql(`create role supabase_functions_admin login noinherit nocreatedb createrole nosuperuser noreplication nobypassrls;
    create role supabase_realtime_admin nologin noinherit nocreatedb nocreaterole nosuperuser noreplication nobypassrls;
    grant supabase_functions_admin to postgres with admin false, inherit true, set true;
    grant supabase_realtime_admin to postgres with admin false, inherit true, set true;
    alter role supabase_functions_admin set search_path = supabase_functions;`, "postgres", "supabase_admin");
  result.platformRolesBootstrapped = missingRoles;
  const baselineExtensions = JSON.parse(run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c",
    "select json_agg(json_build_object('name',extname,'version',extversion) order by extname) from pg_extension"]));
  const availableExtensions = JSON.parse(sql("select json_agg(json_build_object('name',name,'version',default_version) order by name) from pg_available_extensions"));
  result.baselineExtensionManifest = baselineExtensions;
  for (const extension of baselineExtensions) {
    if (!availableExtensions.some((candidate) => candidate.name === extension.name && candidate.version === extension.version)) {
      throw new Error(`required_extension_unavailable:${extension.name}`);
    }
  }

  const names = readdirSync(join(root, "supabase/migrations"))
    .filter((name) => name.endsWith(".sql")).sort();
  const target = "20260926225000_confirm_sourcing_intent.sql";
  if (names.at(-1) !== target) throw new Error("migration_head_changed");
  const baselineRows = JSON.parse(run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres",
    "-Atq", "-c", "select json_agg(json_build_object('version',version,'statements',statements) order by version) from supabase_migrations.schema_migrations"]));
  const baselineVersions = new Set(baselineRows.map((row) => row.version));
  const fileVersions = new Set(names.map((name) => name.slice(0, 14)));
  if ([...baselineVersions].some((version) => !fileVersions.has(version))) {
    throw new Error("local_schema_migration_not_in_repository");
  }
  if (baselineVersions.has(target.slice(0, 14))) throw new Error("target_migration_already_in_baseline");
  result.baselineMigrationManifest = [];
  for (const row of baselineRows) {
    const name = names.find((candidate) => candidate.startsWith(row.version));
    const source = readFileSync(join(root, "supabase/migrations", name), "utf8");
    let remaining = source;
    for (const statement of row.statements) {
      const index = remaining.indexOf(statement);
      if (index < 0 || !/^\s*(;\s*)*$/.test(remaining.slice(0, index))) {
        throw new Error(`baseline_migration_source_mismatch:${row.version}`);
      }
      remaining = remaining.slice(index + statement.length);
    }
    if (!/^\s*(;\s*)*$/.test(remaining)) throw new Error(`baseline_migration_source_mismatch:${row.version}`);
    result.baselineMigrationManifest.push({
      version: row.version,
      name,
      statementCount: row.statements.length,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      recordedStatementsSha256: createHash("sha256").update(JSON.stringify(row.statements)).digest("hex"),
    });
  }
  result.baselineSourceParity = true;
  result.baselineManifestSha256 = createHash("sha256").update(JSON.stringify(result.baselineMigrationManifest)).digest("hex");
  result.baseMigrationCount = baselineVersions.size;
  const dump = run("docker", ["exec", baseContainer, "pg_dump", "-U", "postgres", "-d", "postgres",
    "--schema-only"], undefined, 120_000);
  result.baseSchemaSha256 = createHash("sha256").update(dump).digest("hex");
  const graphqlAclContractSql = `select pg_catalog.jsonb_build_object(
    'schemas', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',n.nspname,
      'owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl::text) order by n.nspname)
      from pg_namespace n where n.nspname in ('graphql','graphql_public')),
    'functions', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('signature',p.oid::regprocedure::text,
      'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('graphql','graphql_public')),
    'sequences', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',c.oid::regclass::text,
      'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text) order by c.oid::regclass::text)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='graphql' and c.relkind='S')
  )::text;`;
  const graphqlAclContract = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", graphqlAclContractSql]);
  result.graphqlAclContractSha256 = createHash("sha256").update(graphqlAclContract).digest("hex");
  if (result.graphqlAclContractSha256 !== "35d8b7e30e1b91b6e55c438c8497493deeb251847a7030fd98cc6a355fac4fd4") {
    throw new Error("graphql_acl_contract_changed");
  }
  // The local Supabase event trigger created this pg_graphql wrapper before
  // extension installation, then attached it to pg_graphql. pg_dump omits its
  // body because it is extension-owned, but emits ACLs for it. In a fresh
  // database the event trigger is restored after those ACLs. Recreate exactly
  // the reviewed wrapper before its first ACL, preserving the full dump.
  const graphqlSignature = "graphql_public.graphql(text,text,jsonb,jsonb)";
  const graphqlOwnership = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c",
    `select e.extname from pg_depend d join pg_extension e on e.oid=d.refobjid where d.classid='pg_proc'::regclass and d.objid='${graphqlSignature}'::regprocedure and d.deptype='e'`]);
  if (graphqlOwnership !== "pg_graphql") throw new Error("graphql_wrapper_extension_ownership_changed");
  const graphqlDefinition = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c",
    `select pg_get_functiondef('${graphqlSignature}'::regprocedure)`]);
  result.graphqlWrapperSha256 = createHash("sha256").update(graphqlDefinition).digest("hex");
  if (result.graphqlWrapperSha256 !== "ddab6177be988c010ae565d2a65c18463b10a44be655a0d2354b351a4366aeb6") {
    throw new Error("graphql_wrapper_source_changed");
  }
  const preparedDump = prepareSourcingSchemaRestore(dump, graphqlDefinition, result.graphqlWrapperSha256);
  result.preparedSchemaSha256 = createHash("sha256").update(preparedDump).digest("hex");
  sql("create database ovd570_fixture;");
  sql(preparedDump, "ovd570_fixture", "supabase_admin");
  result.platformReady = sql(`select to_regclass('auth.users') is not null
    and to_regclass('storage.buckets') is not null
    and to_regclass('public.organizations') is not null
    and to_regprocedure('private.quote_lane_candidates(uuid,public.vendor_name[])') is not null;`, "ovd570_fixture") === "t";
  if (!result.platformReady) throw new Error("restored_platform_not_ready");
  const netContractQuery = `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
    select p.oid::regprocedure::text as identity, pg_get_userbyid(p.proowner) as owner,
      p.prosecdef as security_definer, coalesce(p.proconfig='{search_path=net}'::text[],false) as expected_search_path,
      p.proconfig is null as configuration_is_null,
      md5(p.prosrc) as body_md5, e.extname as extension, d.deptype
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    left join pg_depend d on d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
    left join pg_extension e on e.oid=d.refobjid
    where n.nspname='net' and p.proname in ('http_get','http_post')) item;`;
  const sourceNet = JSON.parse(run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", netContractQuery]));
  const expectedNet = [
    { identity: "net.http_get(text,jsonb,jsonb,integer)", owner: "supabase_admin", security_definer: true,
      expected_search_path: true, configuration_is_null: false, body_md5: "7ceed451732f43e56af7605659fb10cc", extension: "pg_net", deptype: "e" },
    { identity: "net.http_post(text,jsonb,jsonb,jsonb,integer)", owner: "supabase_admin", security_definer: true,
      expected_search_path: true, configuration_is_null: false, body_md5: "249e2190ab91f8313d4deec6d6e687be", extension: "pg_net", deptype: "e" },
  ];
  if (JSON.stringify(sourceNet) !== JSON.stringify(expectedNet)) throw new Error("source_pg_net_contract_changed");
  const netTrigger = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c",
    "select md5(pg_get_functiondef(evtfoid)) from pg_event_trigger where evtname='issue_pg_net_access'"]);
  if (netTrigger !== "397e5cbc06c307d43caf104cd97c2e22") throw new Error("source_pg_net_trigger_changed");
  const fixtureNetBefore = JSON.parse(sql(netContractQuery, "ovd570_fixture"));
  if (fixtureNetBefore.length !== 2 || fixtureNetBefore.some((item, index) =>
    item.identity !== expectedNet[index].identity || item.owner !== "supabase_admin"
    || item.body_md5 !== expectedNet[index].body_md5 || item.extension !== "pg_net"
    || item.deptype !== "e" || item.security_definer !== false || item.expected_search_path !== false
    || item.configuration_is_null !== true)) {
    throw new Error("fixture_pg_net_precondition_changed");
  }
  sql(`alter function net.http_get(text,jsonb,jsonb,integer) security definer;
    alter function net.http_post(text,jsonb,jsonb,jsonb,integer) security definer;
    alter function net.http_get(text,jsonb,jsonb,integer) set search_path = net;
    alter function net.http_post(text,jsonb,jsonb,jsonb,integer) set search_path = net;`, "ovd570_fixture", "supabase_admin");
  result.pgNetRestoredContract = JSON.parse(sql(netContractQuery, "ovd570_fixture"));
  if (JSON.stringify(result.pgNetRestoredContract) !== JSON.stringify(sourceNet)) {
    throw new Error("fixture_pg_net_contract_mismatch");
  }
  const relationAclGrants = `coalesce((select string_agg(format('%s:%s:%s:%s',
    case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
    pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable), ','
    order by case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
    from aclexplode(coalesce(c.relacl,acldefault(
      case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a), '')`;
  const functionAclGrants = `coalesce((select string_agg(format('%s:%s:%s:%s',
    case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
    pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable), ','
    order by case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
    from aclexplode(coalesce(p.proacl,acldefault('f'::"char",p.proowner))) a), '')`;
  const catalogQueries = {
    schemas: `select md5(string_agg(format('%s:%s:%s', nspname, pg_get_userbyid(nspowner),
      coalesce(nspacl::text, '')), E'\\n' order by nspname)) from pg_namespace
      where nspname not like 'pg_%' and nspname <> 'information_schema';`,
    relations: `select md5(string_agg(format('%s:%s:%s:%s:%s:%s:%s:%s', n.nspname, c.relname, c.relkind,
      pg_get_userbyid(c.relowner), ${relationAclGrants}, c.relrowsecurity, c.relforcerowsecurity,
      coalesce(c.reloptions::text, '')), E'\\n'
      order by n.nspname, c.relname, c.relkind)) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','S','f');`,
    functions: `select md5(string_agg(format('%s:%s(%s):%s:%s:%s:%s:%s:%s', n.nspname, p.proname,
      pg_get_function_identity_arguments(p.oid), pg_get_userbyid(p.proowner), ${functionAclGrants},
      p.prosecdef, p.prokind, coalesce(p.proconfig::text, ''), md5(p.prosrc)), E'\\n'
      order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname not like 'pg_%' and n.nspname <> 'information_schema';`,
    defaultPrivileges: `select md5(string_agg(format('%s:%s:%s:%s', pg_get_userbyid(d.defaclrole),
      coalesce(n.nspname, ''), d.defaclobjtype, d.defaclacl::text), E'\\n'
      order by pg_get_userbyid(d.defaclrole), coalesce(n.nspname, ''), d.defaclobjtype))
      from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
      where d.defaclnamespace = 0 or (n.nspname not like 'pg_%' and n.nspname <> 'information_schema');`,
    roles: `select md5(string_agg(format('%s:%s:%s:%s:%s:%s:%s:%s', rolname, rolsuper, rolcreatedb,
      rolcreaterole, rolinherit, rolbypassrls, rolcanlogin, rolreplication), E'\\n' order by rolname)) from pg_roles
      where rolname not like 'pg_%';`,
    memberships: `select md5(string_agg(format('%s:%s:%s:%s:%s', parent.rolname, member.rolname,
      m.admin_option, m.inherit_option, m.set_option), E'\\n' order by parent.rolname, member.rolname))
      from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
      join pg_roles member on member.oid=m.member
      where parent.rolname not like 'pg_%' or member.rolname not like 'pg_%';`,
    roleSettings: `select md5(string_agg(format('%s:%s:%s', r.rolname, coalesce(db.datname, '*'),
      s.setconfig::text), E'\\n' order by r.rolname, coalesce(db.datname, '*')))
      from pg_db_role_setting s join pg_roles r on r.oid=s.setrole
      left join pg_database db on db.oid=s.setdatabase
      where r.rolname not like 'pg_%';`,
    policies: `select md5(string_agg(format('%s:%s:%s:%s:%s:%s:%s:%s', schemaname, tablename,
      policyname, permissive, roles::text, cmd, coalesce(qual, ''), coalesce(with_check, '')),
      E'\\n' order by schemaname, tablename, policyname)) from pg_policies
      where schemaname not like 'pg_%' and schemaname <> 'information_schema';`,
    extensions: `select md5(string_agg(format('%s:%s:%s:%s', extname, extversion,
      pg_get_userbyid(extowner), extnamespace::regnamespace::text), E'\\n' order by extname))
      from pg_extension;`,
    extensionFunctions: `select md5(string_agg(format('%s:%s:%s:%s', e.extname,n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid)), E'\\n' order by e.extname,n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid))) from pg_depend d
      join pg_extension e on e.oid=d.refobjid
      join pg_proc p on p.oid=d.objid and d.classid='pg_proc'::regclass
      join pg_namespace n on n.oid=p.pronamespace where d.deptype='e';`,
    extensionRelations: `select md5(string_agg(format('%s:%s:%s:%s', e.extname,n.nspname,c.relname,c.relkind),
      E'\\n' order by e.extname,n.nspname,c.relname,c.relkind)) from pg_depend d
      join pg_extension e on e.oid=d.refobjid
      join pg_class c on c.oid=d.objid and d.classid='pg_class'::regclass
      join pg_namespace n on n.oid=c.relnamespace where d.deptype='e';`,
  };
  result.catalogParity = {};
  const parityFailures = [];
  for (const [name, query] of Object.entries(catalogQueries)) {
    const sourceHash = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", query]);
    const fixtureHash = sql(query, "ovd570_fixture");
    result.catalogParity[name] = { matched: sourceHash === fixtureHash, sourceHash, fixtureHash };
    if (!result.catalogParity[name].matched) parityFailures.push(name);
  }
  const rawAclQueries = {
    relations: catalogQueries.relations.replace(relationAclGrants, "coalesce(c.relacl::text, '')"),
    functions: catalogQueries.functions.replace(functionAclGrants, "coalesce(p.proacl::text, '')"),
  };
  result.rawAclRepresentationParity = {};
  const rawAclDifferences = [];
  for (const [name, query] of Object.entries(rawAclQueries)) {
    const sourceHash = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", query]);
    const fixtureHash = sql(query, "ovd570_fixture");
    result.rawAclRepresentationParity[name] = { matched: sourceHash === fixtureHash, sourceHash, fixtureHash };
    if (sourceHash !== fixtureHash) rawAclDifferences.push(name);
  }
  const diagnosticCategories = [...new Set([...parityFailures, ...rawAclDifferences])];
  if (diagnosticCategories.length > 0) {
    if (parityFailures.length > 0) result.catalogParityFailures = parityFailures;
    const schemaDetails = `select coalesce(json_agg(row_to_json(item) order by item.name), '[]'::json)
      from (select n.nspname as identity, n.nspname as name, pg_get_userbyid(n.nspowner) as owner, n.nspacl::text as acl,
        (select coalesce(json_agg(format('%s:%s:%s:%s',
          case when grant_entry.grantee=0 then 'PUBLIC' else pg_get_userbyid(grant_entry.grantee) end,
          pg_get_userbyid(grant_entry.grantor), grant_entry.privilege_type, grant_entry.is_grantable)
          order by case when grant_entry.grantee=0 then 'PUBLIC' else pg_get_userbyid(grant_entry.grantee) end,
            pg_get_userbyid(grant_entry.grantor), grant_entry.privilege_type, grant_entry.is_grantable), '[]'::json)
          from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) grant_entry) as normalized_grants
      from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema') item;`;
    const objectDetails = {
      schemas: schemaDetails,
      relations: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select json_build_array(n.nspname,c.relname,c.relkind)::text as identity,
          pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
          c.relrowsecurity as row_security, c.relforcerowsecurity as force_row_security,
          c.reloptions::text as options,
          (select coalesce(json_agg(format('%s:%s:%s:%s',
            case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
            pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
            order by case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
              pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable), '[]'::json)
            from aclexplode(coalesce(c.relacl,acldefault(
              case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a) as normalized_grants
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
          and c.relkind in ('r','p','v','m','S','f')) item;`,
      functions: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select json_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))::text as identity,
          pg_get_userbyid(p.proowner) as owner,
          p.proacl::text as acl, p.prosecdef as security_definer, p.prokind as kind,
          md5(coalesce(p.proconfig::text,'')) as configuration_md5, md5(p.prosrc) as body_md5,
          (select coalesce(json_agg(format('%s:%s:%s:%s',
            case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
            pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
            order by case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
              pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable), '[]'::json)
            from aclexplode(coalesce(p.proacl,acldefault('f'::"char",p.proowner))) a) as normalized_grants
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname not like 'pg_%' and n.nspname <> 'information_schema') item;`,
      defaultPrivileges: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select json_build_array(pg_get_userbyid(d.defaclrole),coalesce(n.nspname,''),d.defaclobjtype)::text as identity,
          d.defaclacl::text as acl,
          (select coalesce(json_agg(format('%s:%s:%s:%s',
            case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
            pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable)
            order by case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
              pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable), '[]'::json)
            from aclexplode(d.defaclacl) a) as normalized_grants
        from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
        where d.defaclnamespace=0 or (n.nspname not like 'pg_%' and n.nspname <> 'information_schema')) item;`,
      roles: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select rolname as identity, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
          rolbypassrls, rolcanlogin, rolreplication
        from pg_roles where rolname not like 'pg_%') item;`,
      memberships: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select json_build_array(parent.rolname,member.rolname,grantor.rolname)::text as identity,
          m.admin_option, m.inherit_option, m.set_option
        from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
        join pg_roles member on member.oid=m.member
        join pg_roles grantor on grantor.oid=m.grantor
        where parent.rolname not like 'pg_%' or member.rolname not like 'pg_%') item;`,
      roleSettings: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select json_build_array(r.rolname,coalesce(db.datname,'*'))::text as identity,
          md5(s.setconfig::text) as config_md5
        from pg_db_role_setting s join pg_roles r on r.oid=s.setrole
        left join pg_database db on db.oid=s.setdatabase
        where r.rolname not like 'pg_%') item;`,
      policies: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select json_build_array(schemaname,tablename,policyname)::text as identity,
          permissive, roles::text as roles, cmd, md5(coalesce(qual,'')) as qual_md5,
          md5(coalesce(with_check,'')) as with_check_md5
        from pg_policies where schemaname not like 'pg_%' and schemaname <> 'information_schema') item;`,
      extensions: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select extname as identity, extversion, pg_get_userbyid(extowner) as owner,
          extnamespace::regnamespace::text as schema from pg_extension) item;`,
      extensionFunctions: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select json_build_array(e.extname,n.nspname,p.proname,
          pg_get_function_identity_arguments(p.oid))::text as identity
        from pg_depend d join pg_extension e on e.oid=d.refobjid
        join pg_proc p on p.oid=d.objid and d.classid='pg_proc'::regclass
        join pg_namespace n on n.oid=p.pronamespace where d.deptype='e') item;`,
      extensionRelations: `select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (
        select json_build_array(e.extname,n.nspname,c.relname,c.relkind)::text as identity
        from pg_depend d join pg_extension e on e.oid=d.refobjid
        join pg_class c on c.oid=d.objid and d.classid='pg_class'::regclass
        join pg_namespace n on n.oid=c.relnamespace where d.deptype='e') item;`,
    };
    if (JSON.stringify(Object.keys(objectDetails).sort()) !== JSON.stringify(Object.keys(catalogQueries).sort())) {
      throw new Error("catalog_diagnostic_category_coverage_mismatch");
    }
    const catalogRows = (query, source) => {
      return fetchCatalogRows(query, (page) => {
        const value = source
          ? run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", page])
          : sql(page, "ovd570_fixture");
        return JSON.parse(value);
      });
    };
    result.catalogObjectDiff = captureCatalogObjectDiffs(diagnosticCategories, objectDetails, catalogRows);
    result.rawAclDiagnosticComplete = Object.values(result.catalogObjectDiff).every((item) => !item.diagnosticError);
    if (parityFailures.length > 0) throw new Error(`baseline_catalog_parity_mismatch:${parityFailures.join(',')}`);
  }
  const permissionQuery = `select string_agg(format('%s:%s:%s:%s:%s', c.relname, pg_get_userbyid(c.relowner), c.relrowsecurity,
    c.relforcerowsecurity, has_table_privilege('authenticated', c.oid, 'SELECT')), ',' order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('organizations','parts','approved_part_requirements');`;
  const sourcePermissions = run("docker", ["exec", baseContainer, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-c", permissionQuery]);
  const fixturePermissions = sql(permissionQuery, "ovd570_fixture");
  result.permissionParity = sourcePermissions === fixturePermissions;
  if (!result.permissionParity) throw new Error("baseline_permission_parity_mismatch");
  result.targetMigrationCount = 0;
  result.appliedMigrationSha256 = {};
  result.phase = "migration";
  for (const name of names) {
    if (baselineVersions.has(name.slice(0, 14))) continue;
    if (name === target) {
      result.prechangeMissing = sql("select to_regprocedure('public.api_confirm_sourcing_destination(uuid,jsonb)') is null;", "ovd570_fixture") === "t";
      if (!result.prechangeMissing) throw new Error("prechange_contract_unexpectedly_present");
    }
    const migration = readFileSync(join(root, "supabase/migrations", name), "utf8");
    result.activeMigration = name;
    if (name === target) {
      sql(readFileSync(join(root, "supabase/fixtures/sourcing-intent/sourcing_intent_preexisting.sql"), "utf8"), "ovd570_fixture");
      const beforeScope = sql("select md5(prosrc) from pg_proc where oid='private.build_quote_lane_scope_snapshot(uuid,public.vendor_name,integer)'::regprocedure;", "ovd570_fixture");
      let expectedFailure = false;
      try {
        sql(`begin;\n${migration}\ndo $$begin raise exception 'ovd570_atomicity_probe'; end;$$;\ncommit;`, "ovd570_fixture");
      } catch (error) {
        expectedFailure = (error.stderr ?? "").includes("ovd570_atomicity_probe");
        if (!expectedFailure) throw error;
      }
      const rollbackClean = sql(`select to_regclass('private.sourcing_destination_history') is null
        and to_regclass('private.part_deadline_history') is null
        and to_regprocedure('public.api_confirm_sourcing_destination(uuid,jsonb)') is null
        and (select md5(prosrc) from pg_proc where oid='private.build_quote_lane_scope_snapshot(uuid,public.vendor_name,integer)'::regprocedure)='${beforeScope}'
        and exists(select 1 from public.approved_part_requirements
          where part_id='89000000-0000-4000-8000-000000000005' and requested_by_date=current_date+12);`, "ovd570_fixture") === "t";
      result.atomicityRehearsal = { expectedFailure, rollbackClean, priorScopeBodyMd5: beforeScope };
      if (!expectedFailure || !rollbackClean) throw new Error("target_migration_atomicity_failed");
    }
    try {
      sql(name === target ? `begin;\n${migration}\ncommit;` : migration, "ovd570_fixture");
    } catch (error) {
      result.migrationOutput = error.stdout ?? "";
      result.migrationStderr = error.stderr ?? "";
      result.migrationExitCode = error.exitCode ?? null;
      throw new Error(`migration ${name}: ${error.message}`);
    }
    result.migrationCount += 1;
    result.appliedMigrationSha256[name] = createHash("sha256").update(migration).digest("hex");
    if (name === target) result.targetMigrationCount += 1;
  }
  if (!result.prechangeMissing || result.targetMigrationCount !== 1) throw new Error("target_migration_application_unproved");
  result.phase = "assertion";
  sql(readFileSync(join(root, "supabase/fixtures/sourcing-intent/commercial_rollout_defaults.sql"), "utf8"), "ovd570_fixture");
  sql("create extension if not exists pgtap with schema extensions;", "ovd570_fixture");
  result.testSuites = [];
  for (const suite of testSuites) {
    const receipt = { path: suite.path, expectedCount: suite.count, exitCode: 0, tapOutput: "" };
    try {
      receipt.tapOutput = sql("set search_path=public,extensions; set statement_timeout='30s'; set ovd.test_conninfo='dbname=ovd570_fixture user=postgres';\n"
        + readFileSync(join(root, suite.path), "utf8"), "ovd570_fixture", suite.user ?? "postgres");
    } catch (error) {
      receipt.tapOutput = error.stdout ?? "";
      receipt.exitCode = error.exitCode ?? null;
      receipt.stderr = error.stderr ?? "";
      receipt.error = error.message;
    }
    receipt.tapSha256 = createHash("sha256").update(receipt.tapOutput).digest("hex");
    receipt.passedCount = (receipt.tapOutput.match(/^ok\s+\d+\b/gm) ?? []).length;
    receipt.failedCount = (receipt.tapOutput.match(/^not ok\s+\d+\b/gm) ?? []).length;
    receipt.passed = receipt.exitCode === 0 && !receipt.error && receipt.failedCount === 0
      && receipt.passedCount === suite.count && new RegExp(`^1\\.\\.${suite.count}$`, "m").test(receipt.tapOutput);
    result.testSuites.push(receipt);
  }
  result.testCount = result.testSuites.reduce((total, suite) => total + suite.passedCount, 0);
  result.failedTestCount = result.testSuites.reduce((total, suite) => total + suite.failedCount, 0);
  result.executedTestCount = result.testCount + result.failedTestCount;
  const failedSuites = result.testSuites.filter((suite) => !suite.passed);
  if (failedSuites.length) throw new Error(`pgtap_failure: ${failedSuites.map((suite) => suite.path).join(',')}`);
  result.phase = "worker_scope_parity";
  sql(readFileSync(join(root, "supabase/fixtures/sourcing-intent/sourcing_worker_scope.sql"), "utf8"), "ovd570_fixture");
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const serviceSql = (query) => sql(`set role service_role; set request.jwt.claims='{"role":"service_role"}'; ${query}`, "ovd570_fixture");
  const workerInputQuery = `select jsonb_build_object('part',to_jsonb(part),'cadFile',to_jsonb(cad),
    'drawingFile',to_jsonb(drawing),'requirement',to_jsonb(requirement),'vendor','xometry','requestedQuantity',1)
    from public.parts part join public.approved_part_requirements requirement on requirement.part_id=part.id
    left join public.job_files cad on cad.id=part.cad_file_id
    left join public.job_files drawing on drawing.id=part.drawing_file_id
    where part.id='89000000-0000-4000-8000-000000000005';`;
  const buildWorkerScope = () => {
    const input = JSON.parse(sql(workerInputQuery, "ovd570_fixture"));
    input.sourcingIntent = JSON.parse(serviceSql("select public.api_get_worker_sourcing_intent('89000000-0000-4000-8000-000000000004','89000000-0000-4000-8000-000000000005');"));
    return JSON.parse(run(process.execPath, ["--experimental-strip-types", "scripts/check-sourcing-worker-scope.mjs"], JSON.stringify(input)));
  };
  const worker = buildWorkerScope();
  if (!worker.scope) throw new Error(`worker_scope_build_failed:${worker.error}`);
  const workerScopeSql = `${literal(JSON.stringify(worker.scope))}::jsonb`;
  const parity = JSON.parse(sql(`select jsonb_build_object(
    'semanticEqual',${workerScopeSql}=private.build_quote_lane_scope_snapshot('89000000-0000-4000-8000-000000000005','xometry',1),
    'sqlFingerprint',private.quote_scope_fingerprint(private.build_quote_lane_scope_snapshot('89000000-0000-4000-8000-000000000005','xometry',1)),
    'workerFingerprint',private.quote_scope_fingerprint(${workerScopeSql}));`, "ovd570_fixture"));
  const permit = JSON.parse(sql(`select jsonb_build_object('taskId',p.work_queue_task_id,'resultId',p.vendor_quote_result_id,
    'fingerprint',p.scope_fingerprint,'claimedAt',task.locked_at) from private.xometry_beta_dispatch_permits p
    join public.work_queue task on task.id=p.work_queue_task_id
    where p.part_id='89000000-0000-4000-8000-000000000005';`, "ovd570_fixture"));
  serviceSql(`select public.api_register_quote_request_lane(${literal(permit.resultId)}::uuid,${workerScopeSql});`);
  const authorize = (scope) => JSON.parse(serviceSql(`select public.api_authorize_xometry_beta_worker_dispatch(
    ${literal(permit.taskId)}::uuid,${literal(permit.resultId)}::uuid,${literal(JSON.stringify(scope))}::jsonb,
    'ovd570-parity',${literal(permit.claimedAt)}::timestamptz);`));
  result.workerScopeParity = { ...parity, authorized: authorize(worker.scope) };
  if (!parity.semanticEqual || !result.workerScopeParity.authorized.authorized
    || result.workerScopeParity.authorized.scopeFingerprint !== permit.fingerprint) {
    throw new Error("worker_scope_or_dispatch_parity_failed");
  }
  sql("update public.organizations set shipping_zip='85702' where id='89000000-0000-4000-8000-000000000003';", "ovd570_fixture");
  result.workerScopeParity.afterAddressEdit = { worker: buildWorkerScope(), authorization: authorize(worker.scope) };
  if (!result.workerScopeParity.afterAddressEdit.worker.error
    || result.workerScopeParity.afterAddressEdit.authorization.reasonCode !== "dispatch_current_scope_changed") {
    throw new Error("edited_destination_did_not_block_worker_and_permit");
  }
  sql(`set request.jwt.claims='{"sub":"89000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
    select public.api_confirm_sourcing_destination('89000000-0000-4000-8000-000000000003',
      public.api_get_sourcing_destination('89000000-0000-4000-8000-000000000003')->'address');`, "ovd570_fixture");
  result.workerScopeParity.afterDifferentAddressConfirmation = authorize(worker.scope);
  if (result.workerScopeParity.afterDifferentAddressConfirmation.reasonCode !== "dispatch_current_scope_changed") {
    throw new Error("changed_confirmed_destination_reused_old_permit");
  }
  sql(`update public.organizations set shipping_zip='85701' where id='89000000-0000-4000-8000-000000000003';
    set request.jwt.claims='{"sub":"89000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
    select public.api_confirm_sourcing_destination('89000000-0000-4000-8000-000000000003',
      public.api_get_sourcing_destination('89000000-0000-4000-8000-000000000003')->'address');`, "ovd570_fixture");
  result.workerScopeParity.afterRestoredAddressConfirmation = authorize(worker.scope);
  if (result.workerScopeParity.afterRestoredAddressConfirmation.reasonCode !== "dispatch_current_scope_changed") {
    throw new Error("restored_confirmed_destination_resurrected_old_permit");
  }
  sql(`update public.approved_part_requirements set requested_by_date=current_date+12
      where part_id='89000000-0000-4000-8000-000000000005';
    set request.jwt.claims='{"sub":"89000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
    select public.api_confirm_part_deadline('89000000-0000-4000-8000-000000000005','A',current_date+12);`, "ovd570_fixture");
  const deadlineWorker = buildWorkerScope();
  if (!deadlineWorker.scope) throw new Error("confirmed_deadline_worker_scope_failed");
  result.workerScopeParity.confirmedDeadline = {
    scopeEqual: sql(`select ${literal(JSON.stringify(deadlineWorker.scope))}::jsonb =
      private.build_quote_lane_scope_snapshot('89000000-0000-4000-8000-000000000005','xometry',1);`, "ovd570_fixture") === "t",
    activeDate: deadlineWorker.scope.requirements.requestedDeliveryDate,
    oldPermitDecision: authorize(deadlineWorker.scope),
  };
  if (!result.workerScopeParity.confirmedDeadline.scopeEqual || !result.workerScopeParity.confirmedDeadline.activeDate
    || result.workerScopeParity.confirmedDeadline.oldPermitDecision.authorized !== false) {
    throw new Error("confirmed_deadline_scope_or_permit_binding_failed");
  }
  result.status = "passed";
  result.phase = "complete";
} catch (error) {
  result.error = String(error.message).slice(0, 2500);
  result.failedPhase = result.phase;
  result.failureFamily = result.phase;
} finally {
  result.networkId = networkId;
  result.containerId = containerId;
  result.cleanup = [];
  for (const [kind, id, removeArgs] of [["container", containerId, ["rm", "--force", containerId]],
    ["network", networkId, ["network", "rm", networkId]]]) {
    try {
      if (id && owned(id, true)) {
        cleanupDocker(...removeArgs);
        result.cleanup.push(`${kind}_removed`);
      }
    } catch (error) {
      result.cleanupError = `${result.cleanupError ?? ""} ${kind}:${String(error.message).slice(0, 500)}`.trim();
    }
  }
  rmSync(temporary, { recursive: true, force: true });
  if (result.cleanup.length !== 2) {
    result.validationStatus = result.status;
    result.status = "failed";
    result.failureFamily = "cleanup";
  }
  result.elapsedMs = Date.now() - started;
  result.finishedAt = new Date().toISOString();
  writeFileSync(join(outputDirectory, `ovd570-sql-fixture-attempt-${attempt}.json`), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: result.status, attempt: result.attempt,
    phase: result.phase,
    migrationCount: result.migrationCount, targetMigrationCount: result.targetMigrationCount ?? 0,
    testCount: result.testCount, error: result.error ?? null, failureFamily: result.failureFamily ?? null,
    cleanup: result.cleanup, receipt: `output/ovd570-sql-fixture-attempt-${attempt}.json` }) + "\n");
}
if (result.status !== "passed" || result.cleanup.length !== 2) process.exitCode = 1;
