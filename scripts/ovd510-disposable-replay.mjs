/**
 * Replay the pinned repository migrations in one exclusively owned disposable
 * Supabase PostgreSQL container. This collects catalog metadata only and never
 * accepts a database URL, host mount, existing container, or real credential.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planExactGrants } from "./ovd510-plan-exact-grants.mjs";
import { allowedVerifierSignatures, buildAuthorityProofSql } from "./ovd510-build-authority-proof.mjs";
import { catalogSql } from "./ovd510-catalog-sql.mjs";
import { durableBehaviorSql } from "./ovd510-durable-behavior-sql.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const compareNames = (a, b) => a.localeCompare(b);
const dockerExecutable = [
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
].find((path) => existsSync(path));
if (!dockerExecutable) throw new Error("docker_executable_unavailable");
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
  const run = spawnSync(dockerExecutable, args, {
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

const behaviorFixtures = [
  { name: "anon_auth", role: "anon", statement: "select public.current_user_has_verified_auth();" },
  { name: "signed_in_auth", role: "authenticated", statement: "select public.current_user_has_verified_auth();" },
  { name: "signed_in_engineering", role: "authenticated",
    statement: "select public.api_get_quote_run_readiness(null::uuid);" },
  { name: "service_publication", role: "service_role",
    statement: "select public.api_publish_quote_package(null::uuid,null::uuid,null::text,false);" },
  { name: "service_worker_gateway", role: "service_role",
    statement: "select public.api_native_attempt_eligibility(null::uuid,null::text,null::uuid,null::uuid,null::uuid,null::bigint);" },
  { name: "auth_uid", role: "authenticated", statement: "select auth.uid();" },
  { name: "storage_read_helper", role: "service_role",
    statement: "select storage.get_level('folder/file'::text);" },
];

function captureBehavior() {
  return behaviorFixtures.map(({ name, role, statement }) => {
    const run = call(["exec", "-i", "-e", `PGPASSWORD=${fixturePassword}`, container,
      "psql", "-U", "supabase_admin", "-d", "postgres", "-X", "-Atq",
      "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], {
      input: `begin read only;\nset role ${role};\nset request.jwt.claim.role = '${role}';\n${statement}\nrollback;`,
      timeout: 30_000, allowFailure: true,
    });
    const error = run.stderr.match(/ERROR:\s+([A-Z0-9]{5}):\s+([^\n]+)/);
    if (run.status !== 0 && !error) throw new Error(`behavior_fixture_unclassified:${name}`);
    return { name, role, status: run.status === 0 ? "returned" : "error",
      value: run.status === 0 ? run.stdout.trim() : null,
      sqlstate: error?.[1] ?? null, error: error?.[2] ?? null };
  });
}

const compatibilitySuites = ["engineering_inbox", "engineering_native_ownership",
  "quote_publication_helper_privileges", "mobile_auth_bridge", "cad_preview_storage_policy"];
function runCompatibilitySuites(phase) {
  return compatibilitySuites.map((name) => {
    const source = readFileSync(join(root, "supabase", "tests", `${name}.sql`), "utf8");
    const tempHelperAccess = `begin;
create temporary table ovd558_suite_temp_namespace(id integer) on commit drop;
do $ovd558_suite$ begin
  execute format('alter default privileges for role postgres in schema %I grant execute on functions to anon, authenticated, service_role',
    (select nspname from pg_namespace where oid = pg_my_temp_schema()));
end $ovd558_suite$;`;
    let sql = source.replace(/^begin;/i, tempHelperAccess);
    if (!/create extension if not exists pgtap/i.test(source)) {
      sql = sql.replace(tempHelperAccess,
        `${tempHelperAccess}\ncreate extension if not exists pgtap with schema extensions;`);
    }
    const transcript = psql(sql, 240_000);
    writeFileSync(join(output, `compatibility-${phase}-${name}.txt`), `${transcript}\n`);
    const planned = Number(transcript.match(/^1\.\.(\d+)$/m)?.[1]);
    const passed = transcript.match(/^ok\b/gm)?.length ?? 0;
    const failed = transcript.match(/^not ok\b/gm)?.length ?? 0;
    if (!Number.isInteger(planned) || planned <= 0 || failed !== 0 || passed !== planned) {
      throw new Error(`compatibility_suite_failed:${phase}:${name}:${passed}/${planned}:${failed}`);
    }
    return { name, planned, passed, failed, transcriptSha256: sha(Buffer.from(transcript)) };
  });
}

try {
  stage = "pinning_source";
  const source = call(["version", "--format", "{{.Server.Version}}"]);
  const revision = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (revision.status !== 0) throw new Error("git_revision_unavailable");
  const files = readdirSync(join(root, "supabase", "migrations"))
    .filter((name) => /^\d+_.+\.sql$/.test(name)).sort(compareNames);
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
    .filter((name) => /^\d+_.+\.up\.sql$/.test(name)).sort(compareNames);
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
  const catalogText = raw.split("\n").find((line) => line.startsWith("{"));
  const catalog = JSON.parse(catalogText);
  save("catalog.json", catalog);
  save("catalog-canonical-digest.json", {
    sha256: sha(Buffer.from(catalogText)),
    encoding: "PostgreSQL jsonb text in UTF-8",
  });
  const durableForward = process.argv.includes("--durable-forward-probe")
    || process.argv.includes("--durable-migration");
  const beforeBehavior = durableForward ? captureBehavior() : null;
  if (beforeBehavior) save("behavior-before.json", beforeBehavior);
  const beforeSuites = process.argv.includes("--durable-migration")
    ? runCompatibilitySuites("before") : null;
  if (beforeSuites) save("compatibility-before.json", beforeSuites);
  if (process.argv.includes("--grant-plan-probe") || process.argv.includes("--authority-proof")
      || durableForward) {
    stage = "grant_plan_probe";
    const reviewedBytes = readFileSync(join(root, "docs", "release",
      "ovd-510-prechange-compatibility-manifest.json"));
    const reviewed = JSON.parse(reviewedBytes);
    const plan = planExactGrants(reviewed, sha(reviewedBytes));
    if (reviewed.fixture.catalogSha256 !== sha(Buffer.from(JSON.stringify(catalog)))
      || reviewed.fixture.migrationManifestSha256 !== sha(Buffer.from(JSON.stringify(manifest)))
      || reviewed.fixture.postgresImageId !== imageId
      || reviewed.fixture.authImageId !== authImageId
      || reviewed.fixture.storageImageId !== storageImageId
      || JSON.stringify(reviewed.catalog) !== JSON.stringify(catalog)) {
      throw new Error("reviewed_prechange_catalog_or_toolchain_drift");
    }
    const catalogSelect = catalogSql.replace(/^begin read only;\n/, "")
      .replace(/\ncommit;$/, "");
    const probeSql = `begin;
set local statement_timeout = '180s';
select pg_advisory_xact_lock(510, 1);
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role supabase_storage_admin revoke execute on functions from public;
alter default privileges for role postgres in schema private, extensions grant execute on functions to public;
revoke execute on all functions in schema public, engineering_private, storage from public;
${plan.sql}
${catalogSelect}
rollback;`;
    const probeRaw = psql(probeSql, 240_000, "supabase_admin");
    const post = JSON.parse(probeRaw.split("\n").find((line) => line.startsWith("{")));
    const beforeFunctions = new Map(catalog.functions.map((fn) =>
      [`${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`, fn]));
    if (post.functions.length !== catalog.functions.length) {
      throw new Error("grant_probe_function_count_drift");
    }
    let latentExecuteRemoved = 0;
    for (const fn of post.functions) {
      const identity = `${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`;
      const before = beforeFunctions.get(identity);
      if (!before || fn.owner !== before.owner || fn.body_md5 !== before.body_md5
        || fn.definition_md5 !== before.definition_md5) {
        throw new Error(`grant_probe_source_drift:${identity}`);
      }
      for (const [role, prior] of Object.entries(before.callers)) {
        const current = fn.callers[role];
        if (!current || current.schemaUsage !== prior.schemaUsage
          || (current.schemaUsage && current.functionExecute) !==
            (prior.schemaUsage && prior.functionExecute)
          || (!prior.schemaUsage && !prior.functionExecute && current.functionExecute)) {
          throw new Error(`grant_probe_effective_caller_drift:${identity}:${role}`);
        }
        if (!prior.schemaUsage && prior.functionExecute && !current.functionExecute) {
          latentExecuteRemoved++;
        }
      }
      if (["public", "engineering_private", "storage"].includes(fn.schema_name)
        && fn.public_execute) {
        throw new Error(`grant_probe_public_execute_remains:${identity}`);
      }
    }
    const restored = JSON.parse(psql(catalogSql).split("\n").find((line) => line.startsWith("{")));
    if (JSON.stringify(restored) !== JSON.stringify(catalog)) {
      throw new Error("grant_probe_rollback_drift");
    }
    save("grant-plan-probe.json", { status: "passed", counts: plan.counts,
      sqlSha256: sha(Buffer.from(plan.sql)), reviewedManifestSha256: sha(reviewedBytes),
      prechangeCatalogSha256: reviewed.fixture.catalogSha256,
      postCatalogSha256: sha(Buffer.from(JSON.stringify(post))),
      latentExecuteWithoutSchemaUsageRemoved: latentExecuteRemoved,
      rolledBackCatalogSha256: sha(Buffer.from(JSON.stringify(restored))) });
    if (durableForward) {
      stage = "durable_forward";
      const adminRaw = psql(catalogSql, 90_000, "supabase_admin")
        .split("\n").find((line) => line.startsWith("{"));
      save("durable-preflight-catalog-digest.json", {
        postgresSha256: sha(Buffer.from(catalogText)),
        adminSha256: sha(Buffer.from(adminRaw)),
        equal: adminRaw === catalogText,
      });
      const forwardPath = join(root, "docs", "release", "ovd-558-verifier-authority-forward.sql");
      const forwardBytes = readFileSync(forwardPath);
      const forwardSql = forwardBytes.toString("utf8");
      if (process.argv.includes("--durable-migration")) {
        stage = "durable_prechange_drift";
        psql(`set role postgres;
create function public.ovd558_drift_probe() returns integer
  language sql as $body$ select 1; $body$;`, 90_000, "supabase_admin");
        let driftRejected = false;
        try { psql(forwardSql, 240_000, "supabase_admin"); }
        catch (error) { driftRejected = String(error).includes("ovd558_prechange_catalog_mismatch");
          if (!driftRejected) throw error; }
        if (!driftRejected) throw new Error("durable_prechange_drift_not_rejected");
        psql("set role postgres; drop function public.ovd558_drift_probe() restrict;",
          90_000, "supabase_admin");
        const afterDriftProbe = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
        if (JSON.stringify(JSON.parse(afterDriftProbe)) !== JSON.stringify(catalog)) {
          throw new Error("durable_drift_probe_cleanup_mismatch");
        }
        save("durable-prechange-drift.json", { status: "rejected_before_mutation",
          restoredCatalogSha256: sha(Buffer.from(afterDriftProbe)) });
        stage = "durable_injected_failure";
        const revokeMarker = "revoke execute on all functions in schema public, engineering_private, storage from public;";
        if (forwardSql.split(revokeMarker).length !== 2) throw new Error("forward_revoke_marker_drift");
        const injectedSql = forwardSql.replace(revokeMarker, `${revokeMarker}\n` +
          "do $ovd558_injected$ begin raise exception 'ovd558_injected_failure'; end $ovd558_injected$;");
        let expectedFailure = false;
        try { psql(injectedSql, 240_000, "supabase_admin"); }
        catch (error) { expectedFailure = String(error).includes("ovd558_injected_failure");
          if (!expectedFailure) throw error; }
        if (!expectedFailure) throw new Error("durable_injection_did_not_fail");
        const afterFailure = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
        if (JSON.stringify(JSON.parse(afterFailure)) !== JSON.stringify(catalog)) {
          throw new Error("durable_injected_failure_catalog_drift");
        }
        save("durable-injected-failure.json", { status: "passed", baselineCatalogSha256: sha(Buffer.from(afterFailure)) });
        stage = "durable_forward";
      }
      psql(forwardSql, 240_000, "supabase_admin");
      const postRaw = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
      const postCatalog = JSON.parse(postRaw);
      const adminPostRaw = psql(catalogSql, 90_000, "supabase_admin")
        .split("\n").find((line) => line.startsWith("{"));
      const afterBehavior = captureBehavior();
      save("behavior-after-forward.json", afterBehavior);
      if (JSON.stringify(afterBehavior) !== JSON.stringify(beforeBehavior)) {
        throw new Error("durable_behavior_compatibility_drift");
      }
      if (beforeSuites) {
        const afterSuites = runCompatibilitySuites("after-forward");
        save("compatibility-after-forward.json", afterSuites);
        if (JSON.stringify(afterSuites.map(({ name, planned, passed, failed }) =>
          ({ name, planned, passed, failed }))) !== JSON.stringify(beforeSuites.map(({ name, planned, passed, failed }) =>
          ({ name, planned, passed, failed })))) {
          throw new Error("durable_compatibility_suite_verdict_drift");
        }
      }
      save("durable-forward-catalog.json", postCatalog);
      save("durable-forward.json", { status: "passed", forwardSha256: sha(forwardBytes),
        catalogSha256: sha(Buffer.from(JSON.stringify(postCatalog))),
        canonicalCatalogSha256: sha(Buffer.from(postRaw)),
        adminCanonicalCatalogSha256: sha(Buffer.from(adminPostRaw)) });
      if (process.argv.includes("--durable-migration")) {
        stage = "durable_authority_assertions";
        const verifier = "engineering_native_verifier";
        const priorFunctions = new Map(catalog.functions.map((fn) =>
          [`${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`, fn]));
        const signature = (fn) => `${fn.schema_name}.${fn.function_name}(${fn.identity_arguments
          .split(",").map((arg) => arg.trim().split(/\s+/).at(-1)).join(",")})`;
        const callable = postCatalog.functions.filter((fn) => fn.callers[verifier]?.schemaUsage
          && fn.callers[verifier]?.functionExecute).map(signature).sort(compareNames);
        if (callable.join("|") !== [...allowedVerifierSignatures].sort(compareNames).join("|")) {
          throw new Error(`durable_verifier_callable_mismatch:${callable.join("|")}`);
        }
        const newFunctions = postCatalog.functions.filter((fn) =>
          !priorFunctions.has(`${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`));
        if (postCatalog.functions.some((fn) =>
          ["api_load_native_preview", "api_complete_native_preview",
            "native_preview_can_read"].includes(fn.function_name))) {
          throw new Error("durable_preview_entrypoint_present");
        }
        if (newFunctions.length !== 7 || newFunctions.some((fn) =>
          fn.owner !== "postgres" || fn.public_execute
          || fn.explicit_grants.some((grant) => !["postgres", verifier].includes(grant.grantee)))) {
          throw new Error("durable_verifier_function_shape_mismatch");
        }
        for (const fn of postCatalog.functions) {
          const before = priorFunctions.get(`${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`);
          if (before) {
            if (fn.owner !== before.owner || fn.body_md5 !== before.body_md5
                || fn.definition_md5 !== before.definition_md5) {
              throw new Error(`durable_existing_function_drift:${fn.schema_name}.${fn.function_name}`);
            }
            for (const [name, access] of Object.entries(before.callers)) {
              const after = fn.callers[name];
              if (!after || after.schemaUsage !== access.schemaUsage
                || (after.schemaUsage && after.functionExecute) !==
                  (access.schemaUsage && access.functionExecute)) {
                throw new Error(`durable_caller_matrix_drift:${fn.schema_name}.${fn.function_name}:${name}`);
              }
            }
          }
          if (["public", "engineering_private", "storage"].includes(fn.schema_name)
              && fn.public_execute) throw new Error("durable_public_execute_leak");
        }
        const role = postCatalog.roles.find((entry) => entry.rolname === verifier);
        const incoming = postCatalog.memberships.filter((edge) => edge.granted_role === verifier
          && edge.member_role !== "postgres");
        if (!role || role.rolsuper || role.rolcanlogin || role.rolinherit || role.rolcreatedb
            || role.rolcreaterole || role.rolreplication || role.rolbypassrls
            || incoming.length !== 1 || incoming[0].member_role !== "authenticator"
            || incoming[0].inherit_option || !incoming[0].set_option || incoming[0].admin_option
            || postCatalog.memberships.some((edge) => edge.member_role === verifier)) {
          throw new Error("durable_role_membership_mismatch");
        }
        save("durable-authority.json", { status: "passed", callable,
          existingFunctionCount: priorFunctions.size, preservedRoleCount: catalog.roles.length,
          newFunctionCount: newFunctions.length });
        stage = "durable_direct_behavior";
        psql(durableBehaviorSql, 240_000, "supabase_admin");
        const afterDirectBehavior = psql(catalogSql).split("\n")
          .find((line) => line.startsWith("{"));
        if (afterDirectBehavior !== postRaw) throw new Error("durable_direct_behavior_catalog_drift");
        save("durable-direct-behavior.json", { status: "passed",
          sqlSha256: sha(Buffer.from(durableBehaviorSql)), registeredReadCount: 1,
          approvedEntryCalls: 4, deniedDirectFunctionCalls: 8,
          deniedStorageDml: 3, rolledBackCatalogSha256: sha(Buffer.from(afterDirectBehavior)) });
        const escalation = [];
        for (const roleName of ["anon", "authenticated", "service_role"]) {
          const denied = call(["exec", "-i", "-e", `PGPASSWORD=${fixturePassword}`, container,
            "psql", "-U", "supabase_admin", "-d", "postgres", "-X", "-Atq",
            "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], {
            input: `begin read only;\nset session authorization ${roleName};\nset role engineering_native_verifier;`,
            timeout: 30_000, allowFailure: true,
          });
          if (denied.status === 0 || !/ERROR:\s+42501:/.test(denied.stderr)) {
            throw new Error(`durable_role_escalation_not_denied:${roleName}`);
          }
          escalation.push({ role: roleName, sqlstate: "42501" });
        }
        save("durable-role-escalation.json", { status: "passed", attempts: escalation });
        stage = "durable_second_application";
        let secondRejected = false;
        try { psql(forwardSql, 240_000, "supabase_admin"); }
        catch (error) { secondRejected = String(error).includes("ovd558_runner_or_object_preflight_mismatch");
          if (!secondRejected) throw error; }
        if (!secondRejected) throw new Error("durable_second_application_not_rejected");
        const afterSecond = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
        if (afterSecond !== postRaw) throw new Error("durable_second_application_catalog_drift");
        save("durable-second-application.json", { status: "rejected_before_mutation",
          catalogSha256: sha(Buffer.from(afterSecond)) });
        if (process.argv.includes("--ovd560")) {
          stage = "ovd560_forward";
          const forward560 = readFileSync(join(root, "docs/release/ovd-560-result-registry-forward.sql"));
          const reverse560 = readFileSync(join(root, "docs/release/ovd-560-result-registry-reverse.sql"));
          psql(forward560.toString("utf8"), 90_000, "postgres");
          const catalog560 = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
          let second560Rejected = false;
          try { psql(forward560.toString("utf8"), 90_000, "postgres"); }
          catch (error) { second560Rejected = String(error).includes("ovd560_requires_empty_ovd558_registry_owned_by_postgres");
            if (!second560Rejected) throw error; }
          if (!second560Rejected) throw new Error("ovd560_second_application_not_rejected");
          if (psql(catalogSql).split("\n").find((line) => line.startsWith("{")) !== catalog560) {
            throw new Error("ovd560_second_application_catalog_drift");
          }
          stage = "ovd560_behavior";
          const ownership = readFileSync(join(root, "supabase/tests/engineering_native_ownership.sql"), "utf8");
          const marker = "select is((select verification_state from public.engineering_tasks where id=pg_temp.task(1,31))";
          if (ownership.split(marker).length !== 2) throw new Error("ovd560_ownership_fixture_marker_drift");
          const proof = readFileSync(join(root, "docs/release/ovd-560-result-registry-proof.sql"));
          const tempAccess = `begin;
create temporary table ovd560_temp_namespace(id integer) on commit drop;
do $ovd560_temp$ begin
  execute format('alter default privileges for role postgres in schema %I grant execute on functions to anon, authenticated, service_role',
    (select nspname from pg_namespace where oid = pg_my_temp_schema()));
end $ovd560_temp$;`;
          const fixturePrefix = ownership.split(marker)[0].replace(/^begin;/i, tempAccess);
          const behavior = psql(`${fixturePrefix}\nselect 'ovd560-proof-start';\n${proof.toString("utf8")}\nrollback;`, 240_000, "postgres");
          writeFileSync(join(output, "ovd560-behavior.txt"), `${behavior}\n`);
          const proofOutput = behavior.split("ovd560-proof-start")[1];
          const proofPassed = proofOutput?.match(/^ok\b/gm)?.length ?? 0;
          if (/not ok|Looks like you failed/i.test(behavior) || proofPassed !== 11) {
            throw new Error(`ovd560_behavior_assertion_failed:${proofPassed}/11`);
          }
          const afterBehavior560 = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
          if (afterBehavior560 !== catalog560) throw new Error("ovd560_behavior_rollback_drift");
          stage = "ovd560_reverse";
          psql(reverse560.toString("utf8"), 90_000, "postgres");
          const restored560 = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
          if (restored560 !== postRaw) {
            save("ovd560-reverse-drift.json", {
              before: JSON.parse(postRaw), after: JSON.parse(restored560) });
            throw new Error("ovd560_reverse_catalog_drift");
          }
          psql(forward560.toString("utf8"), 90_000, "postgres");
          psql(reverse560.toString("utf8"), 90_000, "postgres");
          if (psql(catalogSql).split("\n").find((line) => line.startsWith("{")) !== postRaw) {
            throw new Error("ovd560_reapply_reverse_catalog_drift");
          }
          save("ovd560-result-registry-proof.json", { status: "passed",
            forwardSha256: sha(forward560), reverseSha256: sha(reverse560), proofSha256: sha(proof),
            sourceRevision: revision.stdout.trim(), fixtureId,
            catalogSha256: sha(Buffer.from(catalog560)),
            restoredCatalogSha256: sha(Buffer.from(restored560)),
            proofAssertionsPassed: proofPassed, secondApplicationRejected: true,
            reverseThenReapplyPassed: true });
        }
        stage = "durable_reverse";
        const reversePath = join(root, "docs", "release", "ovd-558-verifier-authority-reverse.sql");
        const reverseBytes = readFileSync(reversePath);
        const reverseSql = reverseBytes.toString("utf8");
        if (!reverseSql.includes(`Exact forward SQL SHA-256: ${sha(forwardBytes)}`)) {
          throw new Error("reverse_forward_digest_mismatch");
        }
        const postAdminSha = sha(Buffer.from(adminPostRaw));
        if (!reverseSql.includes(`'${postAdminSha}'`)) throw new Error("reverse_post_catalog_pin_mismatch");
        let unknownRejected = false;
        try { psql(reverseSql.replace(`'${postAdminSha}'`, `'${"0".repeat(64)}'`),
          240_000, "supabase_admin"); }
        catch (error) { unknownRejected = String(error).includes("ovd558_unknown_postchange_catalog");
          if (!unknownRejected) throw error; }
        if (!unknownRejected) throw new Error("reverse_unknown_state_not_rejected");
        const afterUnknown = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
        if (afterUnknown !== postRaw) throw new Error("reverse_unknown_state_catalog_drift");
        psql(reverseSql, 240_000, "supabase_admin");
        const restoredRaw = psql(catalogSql).split("\n").find((line) => line.startsWith("{"));
        const restoredCatalog = JSON.parse(restoredRaw);
        save("durable-reverse-catalog.json", restoredCatalog);
        const restoredBehavior = captureBehavior();
        save("behavior-after-reverse.json", restoredBehavior);
        if (JSON.stringify(restoredBehavior) !== JSON.stringify(beforeBehavior)) {
          throw new Error("reverse_behavior_compatibility_drift");
        }
        const restoredSuites = runCompatibilitySuites("after-reverse");
        save("compatibility-after-reverse.json", restoredSuites);
        if (JSON.stringify(restoredSuites.map(({ name, planned, passed, failed }) =>
          ({ name, planned, passed, failed }))) !== JSON.stringify(beforeSuites.map(({ name, planned, passed, failed }) =>
          ({ name, planned, passed, failed })))) {
          throw new Error("reverse_compatibility_suite_verdict_drift");
        }
        for (const fn of restoredCatalog.functions) {
          const prior = priorFunctions.get(`${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`);
          if (prior?.schema_name === "storage" && prior.acl === null) {
            fn.acl = null;
            fn.explicit_grants = [];
          }
        }
        if (JSON.stringify(restoredCatalog) !== JSON.stringify(catalog)) {
          throw new Error("durable_reverse_normalized_catalog_drift");
        }
        save("durable-reverse.json", { status: "passed", reverseSha256: sha(reverseBytes),
          forwardSha256: sha(forwardBytes), postCatalogSha256: postAdminSha,
          unknownState: "rejected_before_mutation", normalizedCatalogSha256: sha(Buffer.from(JSON.stringify(restoredCatalog))),
          rawStorageAclNormalizationCount: catalog.functions.filter((fn) =>
            fn.schema_name === "storage" && fn.acl === null).length });
      }
    }
    if (process.argv.includes("--authority-proof")) {
      stage = "authority_proof";
      const injectedSql = buildAuthorityProofSql(plan.sql, catalogSelect,
        { injectFailureAfterRevokes: true });
      let expectedFailure = false;
      try {
        psql(injectedSql, 240_000, "supabase_admin");
      } catch (error) {
        expectedFailure = String(error).includes("ovd510_injected_failure");
        if (!expectedFailure) throw error;
      }
      if (!expectedFailure) throw new Error("authority_injected_failure_did_not_fail");
      const afterInjection = JSON.parse(psql(catalogSql).split("\n")
        .find((line) => line.startsWith("{")));
      if (JSON.stringify(afterInjection) !== JSON.stringify(catalog)) {
        throw new Error("authority_injected_failure_rollback_drift");
      }
      const authoritySql = buildAuthorityProofSql(plan.sql, catalogSelect);
      const authorityRaw = psql(authoritySql, 240_000, "supabase_admin");
      const authority = JSON.parse(authorityRaw.split("\n").find((line) => line.startsWith("{")));
      save("authority-defaults-and-policies.json", {
        defaults: authority.defaults.filter((entry) =>
          ["postgres", "supabase_storage_admin"].includes(entry.owner)),
        verifierPolicies: authority.policies.filter((entry) =>
          entry.roles.includes("engineering_native_verifier")),
      });
      const verifier = "engineering_native_verifier";
      const role = authority.roles.find((entry) => entry.rolname === verifier);
      if (!role || role.rolsuper || role.rolcanlogin || role.rolinherit
        || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls) {
        throw new Error("verifier_role_attributes_mismatch");
      }
      const incoming = authority.memberships.filter((edge) => edge.granted_role === verifier
        && edge.member_role !== "postgres");
      if (incoming.length !== 1 || incoming[0].member_role !== "authenticator"
        || incoming[0].inherit_option || !incoming[0].set_option || incoming[0].admin_option) {
        throw new Error("verifier_membership_mismatch");
      }
      if (authority.memberships.some((edge) => edge.member_role === verifier)) {
        throw new Error("verifier_inherited_membership_mismatch");
      }
      const defaultKey = (entry) => `${entry.owner}|${entry.schema_name}|${entry.object_type}`;
      const beforeDefaults = new Map(catalog.defaults.map((entry) => [defaultKey(entry), entry]));
      const expectedNewDefaults = new Map([
        ["postgres|*|f", "{postgres=X/postgres}"],
        ["postgres|extensions|f", "{=X/postgres}"],
        ["postgres|private|f", "{=X/postgres}"],
        ["supabase_storage_admin|*|f", "{supabase_storage_admin=X/supabase_storage_admin}"],
      ]);
      if (authority.defaults.length !== catalog.defaults.length + expectedNewDefaults.size) {
        throw new Error("authority_default_acl_count_mismatch");
      }
      for (const entry of authority.defaults) {
        const key = defaultKey(entry);
        const prior = beforeDefaults.get(key);
        if (prior) {
          if (JSON.stringify(entry) !== JSON.stringify(prior)) {
            throw new Error(`authority_existing_default_acl_drift:${key}`);
          }
        } else if (entry.acl !== expectedNewDefaults.get(key)) {
          throw new Error(`authority_new_default_acl_mismatch:${key}`);
        }
      }
      const policyKey = (entry) => `${entry.schema_name}.${entry.table_name}.${entry.policy_name}`;
      const beforePolicies = new Map(catalog.policies.map((entry) => [policyKey(entry), entry]));
      const expectedPolicyNames = new Set(["ovd510_verifier_registered_permissive",
        "ovd510_verifier_registered_restrictive"]);
      if (authority.policies.length !== catalog.policies.length + expectedPolicyNames.size) {
        throw new Error("authority_policy_count_mismatch");
      }
      for (const entry of authority.policies) {
        const key = policyKey(entry);
        const prior = beforePolicies.get(key);
        if (prior) {
          if (JSON.stringify(entry) !== JSON.stringify(prior)) {
            save("authority-policy-drift.json", { key, prior, entry });
            throw new Error(`authority_existing_policy_drift:${key}`);
          }
          continue;
        }
        if (entry.schema_name !== "storage" || entry.table_name !== "objects"
          || !expectedPolicyNames.has(entry.policy_name)
          || entry.permissive !== (entry.policy_name.endsWith("permissive")
            ? "PERMISSIVE" : "RESTRICTIVE")
          || entry.cmd !== "SELECT"
          || JSON.stringify(entry.roles) !== JSON.stringify([verifier])
          || entry.qual !== "engineering_private.native_verifier_can_read_object(bucket_id, name)"
          || entry.with_check !== null) {
          throw new Error(`authority_verifier_policy_mismatch:${key}`);
        }
      }
      const signature = (fn) => `${fn.schema_name}.${fn.function_name}(${fn.identity_arguments
        .split(",").map((arg) => arg.trim().split(/\s+/).at(-1)).join(",")})`;
      const callable = authority.functions.filter((fn) => fn.callers[verifier]?.schemaUsage
        && fn.callers[verifier]?.functionExecute).map(signature).sort(compareNames);
      const expectedVerifierBodies = new Map([
        ["engineering_private.complete_native_verification(uuid,text)", "9e2e7bc168a0015408589a1f20fedf8c"],
        ["engineering_private.load_native_verification(uuid,uuid)", "9e2e7bc168a0015408589a1f20fedf8c"],
        ["engineering_private.native_verifier_can_read_object(text,text)", "e962af21395a82d673270c43090036fd"],
        ["engineering_private.reject_native_verification(uuid,jsonb)", "9e2e7bc168a0015408589a1f20fedf8c"],
        ["public.api_complete_native_verification(uuid,text)", "4601708f669e304fa1a6dd4b77d97bac"],
        ["public.api_load_native_verification(uuid,uuid)", "fa3a4ec42b0736db56dc555da6065f93"],
        ["public.api_reject_native_verification(uuid,jsonb)", "d314d95417dbb4c88448df463e2a2501"],
      ]);
      const expectedProofOnly = [
        "engineering_private.ovd510_future_private()",
        "engineering_private.ovd510_unlisted_private()",
        "extensions.ovd510_future_extensions()",
        "private.ovd510_future_nonverifier()",
        "public.ovd510_future_public()",
        "public.ovd510_unlisted_definer()",
        "public.ovd510_unlisted_plain()",
        "storage.ovd510_future_storage()",
      ];
      const expectedNew = [...expectedVerifierBodies.keys(), ...expectedProofOnly].sort(compareNames);
      const newFunctions = authority.functions.filter((fn) =>
        !beforeFunctions.has(`${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`));
      if (newFunctions.map(signature).sort(compareNames).join("|") !== expectedNew.join("|")) {
        throw new Error("authority_new_function_set_mismatch");
      }
      for (const fn of newFunctions) {
        const name = signature(fn);
        if (!expectedVerifierBodies.has(name)) continue;
        const isDefiner = name.startsWith("engineering_private.");
        if (fn.owner !== "postgres" || fn.security_definer !== isDefiner
          || JSON.stringify(fn.configuration) !== JSON.stringify(["search_path=\"\""])
          || fn.body_md5 !== expectedVerifierBodies.get(name)) {
          throw new Error(`authority_verifier_definition_mismatch:${name}`);
        }
        const unwantedGrant = fn.explicit_grants.some((grant) =>
          grant.privilege === "EXECUTE" && grant.grantee !== fn.owner && grant.grantee !== verifier);
        const unintendedCaller = catalog.roles.some((role) =>
          role.rolname !== fn.owner && !role.rolsuper && fn.callers[role.rolname]?.functionExecute);
        if (fn.public_execute || unwantedGrant || unintendedCaller) {
          throw new Error(`authority_verifier_function_leak:${name}`);
        }
      }
      if (callable.join("|") !== [...allowedVerifierSignatures].sort(compareNames).join("|")) {
        throw new Error(`verifier_callable_allowlist_mismatch:${callable.join("|")}`);
      }
      for (const fn of authority.functions) {
        const identity = `${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`;
        const before = beforeFunctions.get(identity);
        if (before) {
          if (fn.owner !== before.owner || fn.body_md5 !== before.body_md5
            || fn.definition_md5 !== before.definition_md5) {
            throw new Error(`authority_existing_function_source_drift:${identity}`);
          }
          for (const [name, prior] of Object.entries(before.callers)) {
            const current = fn.callers[name];
            if (!current || current.schemaUsage !== prior.schemaUsage
              || (current.schemaUsage && current.functionExecute) !==
                (prior.schemaUsage && prior.functionExecute)
              || (!prior.schemaUsage && !prior.functionExecute && current.functionExecute)) {
              throw new Error(`authority_existing_function_caller_drift:${identity}:${name}`);
            }
          }
        }
        if (["public", "engineering_private", "storage"].includes(fn.schema_name)
          && fn.public_execute) {
          throw new Error(`authority_public_execute_remains:${identity}`);
        }
        if (fn.function_name.startsWith("ovd510_future_")) {
          const expectedPublic = ["private", "extensions"].includes(fn.schema_name);
          if (fn.public_execute !== expectedPublic
            || (fn.callers[verifier].schemaUsage && fn.callers[verifier].functionExecute)) {
            throw new Error(`authority_future_default_mismatch:${identity}`);
          }
        }
      }
      for (const relation of authority.relations) {
        const access = relation.callers[verifier];
        const schema = authority.schemas.find((entry) => entry.schema_name === relation.schema_name);
        const usable = schema?.usage[verifier];
        const registeredTable = relation.schema_name === "storage"
          && relation.relation_name === "objects";
        if (!access || typeof usable !== "boolean"
          || (usable && access.select) !== registeredTable
          || (usable && (access.insert || access.update || access.delete))) {
          throw new Error(`verifier_relation_access_mismatch:${relation.schema_name}.${relation.relation_name}`);
        }
      }
      for (const sequence of authority.sequences) {
        const access = sequence.callers[verifier];
        const schema = authority.schemas.find((entry) => entry.schema_name === sequence.schema_name);
        const usable = schema?.usage[verifier];
        if (!access || typeof usable !== "boolean"
          || (usable && (access.usage || access.select || access.update))) {
          throw new Error(`verifier_sequence_access_mismatch:${sequence.schema_name}.${sequence.sequence_name}`);
        }
      }
      const authorityRestored = JSON.parse(psql(catalogSql).split("\n")
        .find((line) => line.startsWith("{")));
      if (JSON.stringify(authorityRestored) !== JSON.stringify(catalog)) {
        throw new Error("authority_proof_rollback_drift");
      }
      save("authority-proof.json", { status: "passed", sqlSha256: sha(Buffer.from(authoritySql)),
        callable, allowedRpcChecks: 3, helperChecks: 2, deniedFunctionChecks: 3,
        registeredStorageReadCount: 1,
        injectedFailureAfterRevokes: "rolled_back_to_prechange_catalog",
        prechangeCatalogSha256: reviewed.fixture.catalogSha256,
        authorityCatalogSha256: sha(Buffer.from(JSON.stringify(authority))),
        rolledBackCatalogSha256: sha(Buffer.from(JSON.stringify(authorityRestored))) });
    }
  }
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
