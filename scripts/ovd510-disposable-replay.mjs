/**
 * Replay the pinned repository migrations in one exclusively owned disposable
 * Supabase PostgreSQL container. This collects catalog metadata only and never
 * accepts a database URL, host mount, existing container, or real credential.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const image = "public.ecr.aws/supabase/postgres:17.6.1.095";
const storageImage = "public.ecr.aws/supabase/storage-api:v1.41.8";
const authImage = "public.ecr.aws/supabase/gotrue:v2.187.0";
const fixtureId = randomUUID();
const shortId = fixtureId.slice(0, 8);
const network = `ovd510-${shortId}`;
const container = `ovd510-db-${shortId}`;
const storageSourceContainer = `ovd510-storage-source-${shortId}`;
const authSourceContainer = `ovd510-auth-source-${shortId}`;
const output = join(root, "output", `ovd510-replay-${shortId}`);
const deadline = Date.now() + 30 * 60_000;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
let networkId = null;
let containerId = null;
let storageSourceId = null;
let authSourceId = null;
let fixturePassword = null;
let cleanup = { container: "not_created", network: "not_created", storageSource: "not_created", authSource: "not_created" };
let stage = "starting";
let result = null;
mkdirSync(join(root, "output"), { recursive: true });
mkdirSync(output, { recursive: false });

function call(args, { input, timeout = 30_000, allowFailure = false, allowAfterDeadline = false } = {}) {
  if (!allowAfterDeadline && Date.now() >= deadline) throw new Error("fixture_deadline_exceeded");
  const run = spawnSync("docker", args, {
    cwd: root, encoding: "utf8", input, timeout, maxBuffer: 8 * 1024 * 1024,
  });
  if ((run.error || run.status !== 0) && !allowFailure) {
    const detail = (run.stderr || run.error?.message || "unknown Docker failure").trim();
    throw new Error(`docker_${args[0]}_failed: ${detail.slice(0, 1200)}`);
  }
  return run;
}

function owned(kind, name) {
  const format = kind === "container"
    ? "{{ index .Config.Labels \"overdrafter.fixture-id\" }}"
    : "{{ index .Labels \"overdrafter.fixture-id\" }}";
  const args = kind === "container"
    ? ["inspect", "--format", format, name]
    : ["network", "inspect", "--format", format, name];
  const inspect = call(args, { allowFailure: true, allowAfterDeadline: true });
  return inspect.status === 0 && inspect.stdout.trim() === fixtureId;
}

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function save(name, data) { writeFileSync(join(output, name), `${JSON.stringify(data, null, 2)}\n`); }
function psql(sql, timeout = 90_000, role = "postgres") {
  return call(["exec", "-i", "-e", `PGPASSWORD=${fixturePassword}`, container,
    "psql", "-U", role, "-d", "postgres", "-X", "-Atq",
    "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
  { input: sql, timeout }).stdout.trim();
}

const catalogSql = `begin read only;
with selected_roles(role_name) as (
  select rolname from pg_roles where rolname not like 'pg_%'
), functions as (
  select n.nspname as schema_name, p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
    p.prokind as kind, p.proacl::text as acl, p.proconfig as configuration,
    md5(p.prosrc) as body_md5,
    md5(pg_get_functiondef(p.oid)) as definition_md5,
    (select coalesce(jsonb_agg(jsonb_build_object(
      'grantor', pg_get_userbyid(a.grantor),
      'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege', a.privilege_type, 'grantable', a.is_grantable)
      order by a.grantee, a.grantor, a.privilege_type), '[]'::jsonb)
      from aclexplode(p.proacl) a) as explicit_grants,
    exists (select 1 from pg_depend dep where dep.classid = 'pg_proc'::regclass
      and dep.objid = p.oid and dep.deptype = 'e') as extension_owned,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'schemaUsage', has_schema_privilege(r.role_name, n.oid, 'USAGE'),
      'functionExecute', has_function_privilege(r.role_name, p.oid, 'EXECUTE')))
      from selected_roles r) as callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), defaults as (
  select pg_get_userbyid(d.defaclrole) as owner,
    coalesce(n.nspname, '*') as schema_name, d.defaclobjtype as object_type,
    d.defaclacl::text as acl
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
), schemas as (
  select n.nspname as schema_name, pg_get_userbyid(n.nspowner) as owner,
    n.nspacl::text as acl,
    exists (select 1 from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      where a.grantee = 0 and a.privilege_type = 'USAGE') as public_usage,
    (select jsonb_object_agg(r.role_name,
      has_schema_privilege(r.role_name, n.oid, 'USAGE')) from selected_roles r) as usage
    , (select jsonb_object_agg(o.role_name, jsonb_build_object(
      'usage', has_schema_privilege(o.role_name, n.oid, 'USAGE'),
      'create', has_schema_privilege(o.role_name, n.oid, 'CREATE')))
      from (values ('postgres'), ('supabase_storage_admin')) o(role_name)) as owner_capabilities
  from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), roles as (
  select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
    rolreplication, rolbypassrls from pg_roles
  where rolname not like 'pg_%'
), memberships as (
  select parent.rolname as granted_role, member.rolname as member_role,
    m.admin_option, m.inherit_option, m.set_option
  from pg_auth_members m join pg_roles parent on parent.oid = m.roleid
    join pg_roles member on member.oid = m.member
  where parent.rolname not like 'pg_%' or member.rolname not like 'pg_%'
), policies as (
  select schemaname as schema_name, tablename as table_name, policyname as policy_name,
    permissive, roles, cmd, qual, with_check from pg_policies
  where schemaname not like 'pg_%' and schemaname <> 'information_schema'
), relations as (
  select n.nspname as schema_name, c.relname as relation_name, c.relkind as kind,
    pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
    c.relrowsecurity as row_security, c.relforcerowsecurity as force_row_security,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'select', has_table_privilege(r.role_name, c.oid, 'SELECT'),
      'insert', has_table_privilege(r.role_name, c.oid, 'INSERT'),
      'update', has_table_privilege(r.role_name, c.oid, 'UPDATE'),
      'delete', has_table_privilege(r.role_name, c.oid, 'DELETE')))
      from selected_roles r) as callers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind in ('r','p','v','m')
), sequences as (
  select n.nspname as schema_name, c.relname as sequence_name,
    pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'usage', has_sequence_privilege(r.role_name, c.oid, 'USAGE'),
      'select', has_sequence_privilege(r.role_name, c.oid, 'SELECT'),
      'update', has_sequence_privilege(r.role_name, c.oid, 'UPDATE')))
      from selected_roles r) as callers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind = 'S'
)
select jsonb_build_object(
  'databaseVersion', current_setting('server_version'),
  'functions', (select coalesce(jsonb_agg(to_jsonb(f) order by schema_name,function_name,identity_arguments), '[]'::jsonb) from functions f),
  'defaults', (select coalesce(jsonb_agg(to_jsonb(d) order by owner,schema_name,object_type), '[]'::jsonb) from defaults d),
  'schemas', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name), '[]'::jsonb) from schemas s),
  'roles', (select coalesce(jsonb_agg(to_jsonb(r) order by rolname), '[]'::jsonb) from roles r),
  'memberships', (select coalesce(jsonb_agg(to_jsonb(m) order by granted_role,member_role), '[]'::jsonb) from memberships m),
  'policies', (select coalesce(jsonb_agg(to_jsonb(p) order by schema_name,table_name,policy_name), '[]'::jsonb) from policies p),
  'relations', (select coalesce(jsonb_agg(to_jsonb(t) order by schema_name,relation_name), '[]'::jsonb) from relations t),
  'sequences', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name,sequence_name), '[]'::jsonb) from sequences s)
)::text;
commit;`;

try {
  stage = "pinning_source";
  const source = call(["version", "--format", "{{.Server.Version}}"]);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (revision.status !== 0) throw new Error("git_revision_unavailable");
  const files = readdirSync(join(root, "supabase", "migrations"))
    .filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  if (files.length < 100) throw new Error("migration_manifest_incomplete");
  const manifest = files.map((name) => ({ name,
    sha256: sha(readFileSync(join(root, "supabase", "migrations", name))) }));
  const imageId = call(["image", "inspect", image, "--format", "{{.Id}}"]).stdout.trim();
  const storageImageId = call(["image", "inspect", storageImage, "--format", "{{.Id}}"]).stdout.trim();
  const authImageId = call(["image", "inspect", authImage, "--format", "{{.Id}}"]).stdout.trim();
  const runnerSha256 = sha(readFileSync(fileURLToPath(import.meta.url)));
  save("manifest.json", { fixtureId, sourceRevision: revision.stdout.trim(), runnerSha256, image, imageId,
    storageImage, storageImageId, authImage, authImageId, dockerVersion: source.stdout.trim(), manifest });

  stage = "extracting_storage_platform_migrations";
  storageSourceId = call(["create", "--name", storageSourceContainer,
    "--label", `overdrafter.fixture-id=${fixtureId}`, storageImage]).stdout.trim();
  if (!owned("container", storageSourceContainer)) throw new Error("storage_source_ownership_unproved");
  call(["cp", `${storageSourceContainer}:/app/migrations/tenant`, join(output, "storage-platform")]);
  const storageNames = readdirSync(join(output, "storage-platform"))
    .filter((name) => /^\d+-.+\.sql$/.test(name))
    .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
  if (storageNames.length < 50) throw new Error("storage_platform_manifest_incomplete");
  const storageManifest = storageNames.map((name) => ({ name,
    sha256: sha(readFileSync(join(output, "storage-platform", name))) }));
  save("storage-manifest.json", { image: storageImage, imageId: storageImageId,
    executionRole: "supabase_storage_admin", searchPath: "storage,public,extensions",
    settings: { installRoles: false, multitenant: false, anonRole: "anon",
      authenticatedRole: "authenticated", serviceRole: "service_role", superUser: "postgres" },
    files: storageManifest });
  const sourceRemoved = call(["rm", storageSourceContainer], { allowFailure: true });
  if (sourceRemoved.status !== 0) throw new Error("storage_source_cleanup_failed");
  cleanup.storageSource = "removed_owned";
  storageSourceId = null;

  stage = "extracting_auth_platform_migrations";
  authSourceId = call(["create", "--name", authSourceContainer,
    "--label", `overdrafter.fixture-id=${fixtureId}`, authImage]).stdout.trim();
  if (!owned("container", authSourceContainer)) throw new Error("auth_source_ownership_unproved");
  call(["cp", `${authSourceContainer}:/usr/local/etc/auth/migrations`, join(output, "auth-platform")]);
  const authNames = readdirSync(join(output, "auth-platform"))
    .filter((name) => /^\d+_.+\.up\.sql$/.test(name)).sort();
  if (authNames.length < 60) throw new Error("auth_platform_manifest_incomplete");
  const authManifest = authNames.map((name) => ({ name,
    sha256: sha(readFileSync(join(output, "auth-platform", name))) }));
  for (const entry of authManifest) {
    const rawSql = readFileSync(join(output, "auth-platform", entry.name), "utf8");
    const expanded = rawSql.replaceAll(/\{\{\s*index \.Options "Namespace"\s*\}\}/g, "auth");
    if (expanded.includes("{{")) throw new Error(`auth_template_unresolved:${entry.name}`);
  }
  save("auth-manifest.json", { image: authImage, imageId: authImageId,
    executionRole: "supabase_auth_admin", searchPath: "auth,public,extensions",
    files: authManifest });
  const authRemoved = call(["rm", authSourceContainer], { allowFailure: true });
  if (authRemoved.status !== 0) throw new Error("auth_source_cleanup_failed");
  cleanup.authSource = "removed_owned";
  authSourceId = null;

  stage = "creating_network";
  networkId = call(["network", "create", "--driver", "bridge", "--internal",
    "--label", `overdrafter.fixture-id=${fixtureId}`, network]).stdout.trim();
  if (!owned("network", network)) throw new Error("network_ownership_unproved");
  stage = "creating_database";
  fixturePassword = randomBytes(24).toString("hex");
  containerId = call(["run", "--detach", "--name", container, "--network", network,
    "--cpus", "2", "--memory", "4g", "--pids-limit", "256",
    "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=2048m",
    "--tmpfs", "/tmp:rw,nosuid,size=512m",
    "--label", `overdrafter.fixture-id=${fixtureId}`,
    "-e", `POSTGRES_PASSWORD=${fixturePassword}`, image]).stdout.trim();
  if (!owned("container", container)) throw new Error("container_ownership_unproved");
  save("resources.json", { fixtureId, network, networkId, container, containerId,
    caps: { cpus: 2, memory: "4g", pids: 256, pgdataTmpfs: "2048m", tmpTmpfs: "512m" },
    externalEgress: false, publishedPorts: [] });

  stage = "database_readiness";
  let ready = false;
  for (let i = 0; i < 90 && Date.now() < deadline; i++) {
    const health = call(["inspect", "--format", "{{.State.Health.Status}}", container],
      { allowFailure: true });
    if (health.status === 0 && health.stdout.trim() === "healthy") { ready = true; break; }
    Atomics.wait(sleepArray, 0, 0, 2000);
  }
  if (!ready) throw new Error("database_readiness_timeout");
  psql("select 1;");

  stage = "platform_preflight";
  const preflightSql = `select jsonb_build_object(
    'currentRole', current_user,
    'isSuperuser', (select rolsuper from pg_roles where rolname = current_user),
    'hasBaseRoles', (select count(*) = 6 from pg_roles where rolname in
      ('postgres','supabase_admin','supabase_auth_admin','supabase_storage_admin','anon','authenticator')),
    'hasBaseSchemas', (select count(*) = 2 from pg_namespace where nspname in ('auth','storage')),
    'authUsersAbsent', to_regclass('auth.users') is null,
    'storageBucketsAbsent', to_regclass('storage.buckets') is null
  )::text;`;
  const preflight = JSON.parse(psql(preflightSql, 90_000, "supabase_admin"));
  save("platform-preflight.json", preflight);
  if (preflight.currentRole !== "supabase_admin" || !preflight.isSuperuser
    || !preflight.hasBaseRoles || !preflight.hasBaseSchemas
    || !preflight.storageBucketsAbsent) {
    throw new Error("platform_preflight_mismatch");
  }
  const platformRoles = {
    auth: psql("set role supabase_auth_admin; select current_user;", 90_000, "supabase_admin").split("\n").at(-1),
    storage: psql("set role supabase_storage_admin; select current_user;", 90_000, "supabase_admin").split("\n").at(-1),
  };
  save("platform-execution-roles.json", platformRoles);
  if (platformRoles.auth !== "supabase_auth_admin"
    || platformRoles.storage !== "supabase_storage_admin") {
    throw new Error("platform_execution_role_mismatch");
  }

  stage = "auth_platform_bootstrap";
  const authApplied = [];
  for (const entry of authManifest) {
    if (Date.now() >= deadline) throw new Error("fixture_deadline_exceeded");
    const rawSql = readFileSync(join(output, "auth-platform", entry.name), "utf8");
    const sql = rawSql.replaceAll(/\{\{\s*index \.Options "Namespace"\s*\}\}/g, "auth");
    try { psql(`set role supabase_auth_admin;\nset search_path = auth,public,extensions;\n${sql}`,
      90_000, "supabase_admin"); }
    catch (error) {
      save("auth-failure.json", { entry, index: authApplied.length, error: String(error) });
      throw error;
    }
    authApplied.push(entry);
  }
  save("auth-applied.json", { count: authApplied.length, files: authApplied });

  stage = "storage_platform_bootstrap";
  const storageApplied = [];
  for (const entry of storageManifest) {
    if (Date.now() >= deadline) throw new Error("fixture_deadline_exceeded");
    const sql = readFileSync(join(output, "storage-platform", entry.name), "utf8");
    // Match the pinned Storage service's role, search path, and single-tenant
    // migration settings. The database image already installs platform roles.
    const bootstrapSql = `set role supabase_storage_admin;
set search_path = storage,public,extensions;
set storage.install_roles = 'false';
set storage.multitenant = 'false';
set storage.anon_role = 'anon';
set storage.authenticated_role = 'authenticated';
set storage.service_role = 'service_role';
set storage.super_user = 'postgres';
set storage.iceberg_default_shard = '';
set storage.iceberg_shards = '{}';
${sql}`;
    try { psql(bootstrapSql, 90_000, "supabase_admin"); }
    catch (error) {
      save("storage-failure.json", { entry, index: storageApplied.length, error: String(error) });
      throw error;
    }
    storageApplied.push(entry);
  }
  save("storage-applied.json", { count: storageApplied.length, files: storageApplied });
  const platform = JSON.parse(psql(`select jsonb_build_object(
    'authUsersPresent', to_regclass('auth.users') is not null,
    'storageBucketsPresent', to_regclass('storage.buckets') is not null,
    'authUsersOwner', (select pg_get_userbyid(relowner) from pg_class where oid = to_regclass('auth.users')),
    'storageBucketsOwner', (select pg_get_userbyid(relowner) from pg_class where oid = to_regclass('storage.buckets')),
    'storagePublicColumn', exists (select 1 from information_schema.columns
      where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public'),
    'postgresIsAuthenticatorMember', pg_has_role('postgres','authenticator','MEMBER')
  )::text;`, 90_000, "supabase_admin"));
  save("platform-postcheck.json", platform);
  if (!platform.authUsersPresent || !platform.storageBucketsPresent
    || platform.authUsersOwner !== "supabase_auth_admin"
    || platform.storageBucketsOwner !== "supabase_storage_admin"
    || !platform.storagePublicColumn || !platform.postgresIsAuthenticatorMember) {
    throw new Error("platform_postcheck_mismatch");
  }

  stage = "migration_replay";
  const applied = [];
  for (const entry of manifest) {
    if (Date.now() >= deadline) throw new Error("fixture_deadline_exceeded");
    const sql = readFileSync(join(root, "supabase", "migrations", entry.name), "utf8");
    try { psql(sql); }
    catch (error) {
      save("migration-failure.json", { entry, index: applied.length, error: String(error) });
      throw error;
    }
    applied.push(entry);
  }
  save("applied.json", { count: applied.length, files: applied });

  stage = "catalog_inventory";
  const raw = psql(catalogSql);
  const catalog = JSON.parse(raw.split("\n").find((line) => line.startsWith("{")));
  save("catalog.json", catalog);
  result = { status: "passed", stage, fixtureId, sourceRevision: revision.stdout.trim(),
    runnerSha256, imageId, migrationCount: applied.length,
    functionCount: catalog.functions.length, schemaCount: catalog.schemas.length,
    policyCount: catalog.policies.length, relationCount: catalog.relations.length,
    sequenceCount: catalog.sequences.length,
    catalogSha256: sha(Buffer.from(JSON.stringify(catalog))) };
} catch (error) {
  result = { status: "failed", stage, fixtureId, error: String(error).slice(0, 1600) };
  if (containerId && owned("container", container)) {
    const logs = call(["logs", "--tail", "200", container],
      { allowFailure: true, allowAfterDeadline: true });
    writeFileSync(join(output, "database-log.txt"), (logs.stdout + logs.stderr).slice(-20_000));
  }
} finally {
  if (authSourceId && owned("container", authSourceContainer)) {
    const removed = call(["rm", "--force", authSourceContainer],
      { allowFailure: true, allowAfterDeadline: true });
    cleanup.authSource = removed.status === 0 ? "removed_owned" : "remove_failed";
  }
  if (storageSourceId && owned("container", storageSourceContainer)) {
    const removed = call(["rm", "--force", storageSourceContainer],
      { allowFailure: true, allowAfterDeadline: true });
    cleanup.storageSource = removed.status === 0 ? "removed_owned" : "remove_failed";
  }
  if (containerId && owned("container", container)) {
    const removed = call(["rm", "--force", container],
      { allowFailure: true, allowAfterDeadline: true });
    cleanup.container = removed.status === 0 ? "removed_owned" : "remove_failed";
  }
  if (networkId && owned("network", network)) {
    const removed = call(["network", "rm", network],
      { allowFailure: true, allowAfterDeadline: true });
    cleanup.network = removed.status === 0 ? "removed_owned" : "remove_failed";
  }
  save("result.json", { ...result, cleanup, completedAt: new Date().toISOString() });
  process.stdout.write(`${output}/result.json\n`);
  if (result.status !== "passed" || cleanup.container !== "removed_owned"
    || cleanup.network !== "removed_owned" || cleanup.storageSource !== "removed_owned"
    || cleanup.authSource !== "removed_owned") process.exitCode = 1;
}
