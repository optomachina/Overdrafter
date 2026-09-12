import { pathToFileURL } from "node:url";

const INPUT_LIMIT_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const MIGRATION = /^supabase\/migrations\/[0-9]{14}_[a-z0-9_]+\.sql$/;
const INPUT_KEYS = ["databaseImage", "migrations", "ownerTaskId", "postgrestImage", "runId", "sourceRevision"];
const MIGRATION_KEYS = ["path", "sha256"];

export const ENGINEERING_INBOX_FIXTURE_PLAN_SCHEMA = "overdrafter.engineering-inbox-fixture-plan.v1";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(code);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateInput(input) {
  exactKeys(input, INPUT_KEYS, "invalid_input_shape");
  if (typeof input.sourceRevision !== "string" || !SHA.test(input.sourceRevision)) fail("invalid_source_revision");
  if (typeof input.ownerTaskId !== "string" || !UUID.test(input.ownerTaskId)) fail("invalid_owner_task_id");
  if (typeof input.runId !== "string" || !UUID.test(input.runId) || input.runId === input.ownerTaskId) fail("invalid_run_id");
  if (typeof input.databaseImage !== "string" || typeof input.postgrestImage !== "string"
    || !IMAGE.test(input.databaseImage) || !IMAGE.test(input.postgrestImage)
    || input.databaseImage === input.postgrestImage) fail("invalid_image_identity");
  if (!Array.isArray(input.migrations) || input.migrations.length < 1 || input.migrations.length > 512) {
    fail("invalid_migration_manifest");
  }
  let previous = "";
  const seen = new Set();
  for (const migration of input.migrations) {
    exactKeys(migration, MIGRATION_KEYS, "invalid_migration_entry");
    if (typeof migration.path !== "string" || typeof migration.sha256 !== "string"
      || !MIGRATION.test(migration.path) || !/^[0-9a-f]{64}$/.test(migration.sha256)
      || migration.path <= previous || seen.has(migration.path)) fail("invalid_migration_entry");
    previous = migration.path;
    seen.add(migration.path);
  }
}

/** Build a value-free policy plan. This function performs no I/O and accepts no executor. */
export function createEngineeringInboxFixturePlan(input) {
  validateInput(input);
  return deepFreeze({
    schema: ENGINEERING_INBOX_FIXTURE_PLAN_SCHEMA,
    mode: "plan_only",
    qualification: "not_run",
    identity: {
      sourceRevision: input.sourceRevision,
      ownerTaskId: input.ownerTaskId,
      runId: input.runId,
      runIdFreshness: "unverified",
    },
    images: {
      database: { id: input.databaseImage, verification: "unverified" },
      postgrest: { id: input.postgrestImage, verification: "unverified" },
    },
    migrations: input.migrations.map((entry) => ({ ...entry, verification: "unverified" })),
    resourcePolicy: {
      maxContainers: 2,
      maxNetworks: 1,
      network: "exclusive_internal",
      portPublication: "explicit_loopback_only",
      persistentVolumes: 0,
      retryAttempts: 0,
      runnerDeadlineMs: 30 * 60 * 1000,
      cleanupDeadlineMs: 5 * 60 * 1000,
      containers: {
        database: { cpuCount: 1, memoryBytes: 1024 ** 3, pids: 256, readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/lib/postgresql/data"] },
        postgrest: { cpuCount: 1, memoryBytes: 256 * 1024 ** 2, pids: 64, readOnlyRoot: true,
          tmpfs: ["/tmp"] },
      },
      prohibited: ["image_pull", "image_build", "image_tag", "external_egress", "host_network",
        "privileged_container", "docker_socket_mount", "host_mount", "persistent_volume",
        "non_loopback_publication", "automatic_retry", "caller_output_path"],
    },
    futureStages: ["admission", "local_image_inspection", "resource_creation", "database_readiness",
      "platform_prerequisite_verification", "migration_replay", "schema_access_checks",
      "existing_inbox_suite", "http_checks", "cleanup", "final_receipt"],
    receiptPolicy: {
      destination: "stdout_only",
      content: "value_free",
      successRequiresCleanupComplete: true,
      preCleanupReceipt: "provisional_only",
    },
    unverifiedClaims: ["run_id_freshness", "source_checkout", "cached_images", "platform_prerequisites",
      "migration_bytes", "docker_ownership", "resource_limits", "database_readiness", "schema_catalog",
      "grants_rls", "application_behavior", "http_transport", "cleanup"],
  });
}

async function readBounded(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > INPUT_LIMIT_BYTES) fail("input_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runEngineeringInboxFixturePlanCli({ argv, stdin, stdout }) {
  if (argv.includes("--execute")) fail("execution_unavailable_in_plan_slice");
  if (argv.length !== 1 || argv[0] !== "--plan") fail("invalid_cli_arguments");
  let input;
  try {
    input = JSON.parse(await readBounded(stdin));
  } catch (error) {
    if (error?.code === "input_too_large") throw error;
    fail("invalid_json_input");
  }
  const plan = createEngineeringInboxFixturePlan(input);
  stdout.write(`${JSON.stringify(plan)}\n`);
  return plan;
}

async function main() {
  try {
    await runEngineeringInboxFixturePlanCli({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout });
  } catch (error) {
    process.stderr.write(`engineering_inbox_fixture_plan_error:${error?.code ?? "invalid_request"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
