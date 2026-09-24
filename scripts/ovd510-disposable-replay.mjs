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
const fixtureId = randomUUID();
const shortId = fixtureId.slice(0, 8);
const network = `ovd510-${shortId}`;
const container = `ovd510-db-${shortId}`;
const output = join(root, "output", `ovd510-replay-${shortId}`);
const deadline = Date.now() + 30 * 60_000;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
let networkId = null;
let containerId = null;
let cleanup = { container: "not_created", network: "not_created" };
let stage = "starting";
let result = null;
mkdirSync(join(root, "output"), { recursive: true });
mkdirSync(output, { recursive: false });

function call(args, { input, timeout = 30_000, allowFailure = false } = {}) {
  if (Date.now() >= deadline) throw new Error("fixture_deadline_exceeded");
  const run = spawnSync("docker", args, {
    cwd: root, encoding: "utf8", input, timeout, maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error || (run.status !== 0 && !allowFailure)) {
    const detail = (run.stderr || run.error?.message || "unknown Docker failure").trim();
    throw new Error(`docker_${args[0]}_failed: ${detail.slice(0, 1200)}`);
  }
  return run;
}

function owned(kind, name) {
  const format = kind === "container"
    ? "{{ index .Config.Labels \"overdrafter.fixture-id\" }}"
    : "{{ index .Labels \"overdrafter.fixture-id\" }}";
  const inspect = call([kind === "container" ? "inspect" : "network", "inspect",
    "--format", format, name], { allowFailure: true });
  return inspect.status === 0 && inspect.stdout.trim() === fixtureId;
}

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function save(name, data) { writeFileSync(join(output, name), `${JSON.stringify(data, null, 2)}\n`); }
function psql(sql, timeout = 90_000) {
  return call(["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
  { input: sql, timeout }).stdout.trim();
}

const catalogSql = `begin read only;
with selected_roles(role_name) as (
  values ('anon'), ('authenticated'), ('service_role'), ('authenticator')
), functions as (
  select n.nspname as schema_name, p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
    p.prokind as kind, p.proacl::text as acl, md5(p.prosrc) as body_md5,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'schemaUsage', has_schema_privilege(r.role_name, n.oid, 'USAGE'),
      'functionExecute', has_function_privilege(r.role_name, p.oid, 'EXECUTE')))
      from selected_roles r) as callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'engineering_private', 'storage')
), defaults as (
  select pg_get_userbyid(d.defaclrole) as owner,
    coalesce(n.nspname, '*') as schema_name, d.defaclobjtype as object_type,
    d.defaclacl::text as acl
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
), schemas as (
  select n.nspname as schema_name, pg_get_userbyid(n.nspowner) as owner,
    n.nspacl::text as acl,
    (select jsonb_object_agg(r.role_name,
      has_schema_privilege(r.role_name, n.oid, 'USAGE')) from selected_roles r) as usage
  from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), roles as (
  select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
    rolreplication, rolbypassrls from pg_roles
  where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'engineering_native_verifier')
), memberships as (
  select parent.rolname as granted_role, member.rolname as member_role,
    m.admin_option, m.inherit_option, m.set_option
  from pg_auth_members m join pg_roles parent on parent.oid = m.roleid
    join pg_roles member on member.oid = m.member
  where parent.rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'engineering_native_verifier')
    or member.rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'engineering_native_verifier')
)
select jsonb_build_object(
  'databaseVersion', current_setting('server_version'),
  'functions', (select coalesce(jsonb_agg(to_jsonb(f) order by schema_name,function_name,identity_arguments), '[]'::jsonb) from functions f),
  'defaults', (select coalesce(jsonb_agg(to_jsonb(d) order by owner,schema_name,object_type), '[]'::jsonb) from defaults d),
  'schemas', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name), '[]'::jsonb) from schemas s),
  'roles', (select coalesce(jsonb_agg(to_jsonb(r) order by rolname), '[]'::jsonb) from roles r),
  'memberships', (select coalesce(jsonb_agg(to_jsonb(m) order by granted_role,member_role), '[]'::jsonb) from memberships m)
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
  save("manifest.json", { fixtureId, sourceRevision: revision.stdout.trim(), image, imageId,
    dockerVersion: source.stdout.trim(), manifest });

  stage = "creating_network";
  networkId = call(["network", "create", "--driver", "bridge", "--internal",
    "--label", `overdrafter.fixture-id=${fixtureId}`, network]).stdout.trim();
  if (!owned("network", network)) throw new Error("network_ownership_unproved");
  stage = "creating_database";
  const password = randomBytes(24).toString("hex");
  containerId = call(["run", "--detach", "--name", container, "--network", network,
    "--cpus", "2", "--memory", "4g", "--pids-limit", "256",
    "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=2048m",
    "--tmpfs", "/tmp:rw,nosuid,size=512m",
    "--label", `overdrafter.fixture-id=${fixtureId}`,
    "-e", `POSTGRES_PASSWORD=${password}`, image]).stdout.trim();
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
    imageId, migrationCount: applied.length, functionCount: catalog.functions.length,
    schemaCount: catalog.schemas.length, catalogSha256: sha(Buffer.from(JSON.stringify(catalog))) };
} catch (error) {
  result = { status: "failed", stage, fixtureId, error: String(error).slice(0, 1600) };
  if (containerId && owned("container", container)) {
    const logs = call(["logs", "--tail", "200", container], { allowFailure: true });
    writeFileSync(join(output, "database-log.txt"), (logs.stdout + logs.stderr).slice(-20_000));
  }
} finally {
  if (containerId && owned("container", container)) {
    const removed = call(["rm", "--force", container], { allowFailure: true });
    cleanup.container = removed.status === 0 ? "removed_owned" : "remove_failed";
  }
  if (networkId && owned("network", network)) {
    const removed = call(["network", "rm", network], { allowFailure: true });
    cleanup.network = removed.status === 0 ? "removed_owned" : "remove_failed";
  }
  save("result.json", { ...result, cleanup, completedAt: new Date().toISOString() });
  process.stdout.write(`${output}/result.json\n`);
  if (result.status !== "passed" || cleanup.container !== "removed_owned"
    || cleanup.network !== "removed_owned") process.exitCode = 1;
}
