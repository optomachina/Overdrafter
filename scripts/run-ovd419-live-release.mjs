#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { collectOperationalEnvelope } from "./collect-ovd410-operational-envelope.mjs";
import { buildAuthProbeJobManifest } from "./configure-xometry-auth-probe-job.mjs";
import { buildWorkerEgressManifest } from "./configure-xometry-worker-egress.mjs";
import {
  OVD419_DIGEST_CONTRACT,
  isDirectCli,
  isImmutableImage,
  isObject,
  parseDigestRecord,
} from "./ovd419-digest-contract.mjs";
import {
  promoteDigest,
  runNoUploadProbes,
} from "./run-ovd419-final-digest-release.mjs";
import {
  collectStableEgressEvidence,
  evaluateStableEgressEvidence,
} from "./verify-xometry-stable-egress.mjs";
import { OVD410_PRODUCTION_CONTRACT } from "./xometry-stable-egress-contract.mjs";

const execFileAsync = promisify(execFile);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9+/_=-]{1,256}$/;
const MAX_EXECUTIONS = 10_000;
const READ_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15 * 60_000;
const NAT_QUIESCENCE_INTERVAL_MS = 30_000;
const NAT_QUIESCENCE_TIMEOUT_MS = 20 * 60_000;
const NAT_QUIESCENCE_MAX_OBSERVATIONS =
  Math.ceil(NAT_QUIESCENCE_TIMEOUT_MS / NAT_QUIESCENCE_INTERVAL_MS) + 1;
const NAT_QUIESCENCE_FAILURES = new Set([
  "nat_mapping_inventory_not_quiescent",
  "nat_mapping_inventory_multiple",
]);
const AUTHORIZATION_ACTION =
  "promote-final-digest-and-run-two-no-upload-probes";
const AUTHORIZATION_MAX_LIFETIME_MS = 4 * 60 * 60_000;
const PROMOTION_FAILURE_CODES = new Set([
  "active_execution_present",
  "containment_operation_failed",
  "execution_inventory_changed",
  "execution_inventory_invalid",
  "final_containment_failed",
  "internal_contract_error",
  "job_configuration_observation_invalid",
  "job_execution_started_during_promotion",
  "job_image_readback_failed",
  "job_queue_not_empty",
  "job_readback_failed",
  "job_replacement_operation_failed",
  "job_resource_version_changed",
  "job_resource_version_invalid",
  "job_resource_version_unchanged",
  "live_observation_invalid",
  "live_observation_not_verified",
  "observation_operation_failed",
  "observation_phase_invalid",
  "observation_snapshot_failed",
  "observation_verifier_operation_failed",
  "pre_service_observation_changed",
  "rollout_not_disabled",
  "service_image_changed_before_promotion",
  "service_image_readback_failed",
  "service_queue_not_empty",
  "service_readback_failed",
  "service_replacement_operation_failed",
  "service_resource_version_changed",
  "service_resource_version_invalid",
  "service_resource_version_unchanged",
  "snapshot_version_invalid",
  "stable_egress_observation_invalid",
]);
const PROMOTION_FAILURE_STAGES = new Set([
  "unknown",
  "observe_before_job",
  "evaluate_before_job",
  "replace_job",
  "observe_after_job",
  "verify_after_job",
  "observe_before_service",
  "evaluate_before_service",
  "replace_service",
  "observe_after_service",
  "verify_after_service",
  "verify_final_containment",
]);
const LIVE_USAGE =
  "usage: node scripts/run-ovd419-live-release.mjs --execute --authorization-file <private.json> --bundle-file <bundle.json> --evidence-file <private.json>\n";

class LiveReleaseError extends Error {
  constructor(code) {
    super(`OVD-419 live release ${code}`);
    this.name = "LiveReleaseError";
    this.code = code;
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(code) {
  throw new LiveReleaseError(code);
}

export function createTerminationState() {
  let requestedSignal;
  let mutationAttempted = false;
  let qualificationPassed = false;
  return Object.freeze({
    request(signal) {
      if (!["SIGINT", "SIGTERM"].includes(signal)) {
        fail("termination_signal_invalid");
      }
      requestedSignal ??= signal;
    },
    throwIfRequested() {
      if (requestedSignal) fail("termination_requested");
    },
    markMutationAttempted() {
      mutationAttempted = true;
    },
    markQualificationPassed() {
      qualificationPassed = true;
    },
    isRequested: () => requestedSignal !== undefined,
    mutationAttempted: () => mutationAttempted,
    qualificationPassed: () => qualificationPassed,
  });
}

export function installDeferredTerminationHandlers({
  terminationState,
  processObject = process,
}) {
  if (
    !terminationState ||
    typeof terminationState.request !== "function" ||
    typeof processObject?.on !== "function" ||
    typeof processObject?.off !== "function"
  ) {
    fail("termination_dependencies_invalid");
  }
  const onSigint = () => terminationState.request("SIGINT");
  const onSigterm = () => terminationState.request("SIGTERM");
  processObject.on("SIGINT", onSigint);
  processObject.on("SIGTERM", onSigterm);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    processObject.off("SIGINT", onSigint);
    processObject.off("SIGTERM", onSigterm);
  };
}

const NO_TERMINATION = Object.freeze({
  throwIfRequested: () => undefined,
  markMutationAttempted: () => undefined,
  markQualificationPassed: () => undefined,
  isRequested: () => false,
  mutationAttempted: () => false,
  qualificationPassed: () => false,
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256Json(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function serviceContainer(service) {
  const containers = service?.spec?.template?.spec?.containers;
  return Array.isArray(containers) && containers.length === 1
    ? containers[0]
    : null;
}

function jobContainer(job) {
  const containers = job?.spec?.template?.spec?.template?.spec?.containers;
  return Array.isArray(containers) && containers.length === 1
    ? containers[0]
    : null;
}

function resourceImage(resource, kind) {
  const container =
    kind === "job" ? jobContainer(resource) : serviceContainer(resource);
  return container?.image ?? null;
}

function serviceBuildVersion(service) {
  const matches = serviceContainer(service)?.env?.filter(
    (entry) => entry?.name === "WORKER_BUILD_VERSION",
  );
  return Array.isArray(matches) && matches.length === 1
    ? matches[0]?.value
    : null;
}

function configurationFingerprint(job) {
  if (
    !isObject(job?.spec) ||
    job?.metadata?.name !== OVD419_DIGEST_CONTRACT.job
  ) {
    fail("job_configuration_invalid");
  }
  return sha256Json({ name: job.metadata.name, spec: job.spec });
}

function executionName(execution) {
  const raw = execution?.metadata?.name;
  return typeof raw === "string" ? raw.split("/").at(-1) : null;
}

function executionInventoryFromList(executions) {
  if (!Array.isArray(executions) || executions.length >= MAX_EXECUTIONS) {
    fail("execution_inventory_invalid");
  }
  const ids = executions.map(executionName);
  if (
    ids.some((id) => !TOKEN_PATTERN.test(id ?? "")) ||
    new Set(ids).size !== ids.length
  ) {
    fail("execution_inventory_invalid");
  }
  const activeCount = executions.filter(
    (execution) =>
      typeof execution?.status?.completionTime !== "string" ||
      Number(execution?.status?.runningCount ?? 0) > 0,
  ).length;
  const completedExecutionIds = [...ids].sort(compareText);
  return Object.freeze({
    totalCount: completedExecutionIds.length,
    activeCount,
    completedExecutionIds,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(completedExecutionIds))
      .digest("hex"),
  });
}

function snapshotVersion(metadata) {
  const normalizeVersion = (value) => {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
    return "";
  };
  const generation = normalizeVersion(metadata?.generation);
  const metageneration = normalizeVersion(metadata?.metageneration);
  if (
    !/^[1-9]\d{0,19}$/.test(generation) ||
    !/^[1-9]\d{0,19}$/.test(metageneration) ||
    !TOKEN_PATTERN.test(metadata?.etag ?? "")
  ) {
    fail("snapshot_metadata_invalid");
  }
  return Object.freeze({
    generation,
    metageneration,
    etag: metadata.etag,
  });
}

function productionExpectations(env) {
  const expectations = {
    ...OVD410_PRODUCTION_CONTRACT,
    project: env.GOOGLE_CLOUD_PROJECT,
    region: env.CLOUD_RUN_REGION,
    network: env.CLOUD_RUN_NETWORK,
    subnet: env.CLOUD_RUN_SUBNET,
    subnetRange: env.CLOUD_RUN_SUBNET_RANGE,
    router: env.CLOUD_RUN_ROUTER,
    nat: env.CLOUD_RUN_NAT,
    address: env.CLOUD_RUN_NAT_ADDRESS,
    addressId: env.CLOUD_RUN_NAT_ADDRESS_ID,
    service: env.SERVICE_NAME,
    job: env.XOMETRY_AUTH_PROBE_JOB_NAME,
    serviceAccount: env.CLOUD_RUN_SERVICE_ACCOUNT,
  };
  const contractMatches = Object.entries(OVD410_PRODUCTION_CONTRACT).every(
    ([key, value]) => expectations[key] === value,
  );
  if (
    !contractMatches ||
    env.CLOUD_RUN_VPC_EGRESS !== "all-traffic" ||
    typeof env.XOMETRY_PROFILE_SNAPSHOT_BUCKET !== "string" ||
    env.XOMETRY_PROFILE_SNAPSHOT_BUCKET.length === 0 ||
    typeof env.XOMETRY_PROFILE_SNAPSHOT_OBJECT !== "string" ||
    env.XOMETRY_PROFILE_SNAPSHOT_OBJECT.length === 0 ||
    !/^[1-9]\d*$/.test(env.XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES ?? "") ||
    typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" ||
    env.SUPABASE_SERVICE_ROLE_KEY.length === 0
  ) {
    fail("live_configuration_invalid");
  }
  return Object.freeze(expectations);
}

function sameSnapshotVersion(left, right) {
  return (
    left?.generation === right?.generation &&
    left?.metageneration === right?.metageneration &&
    left?.etag === right?.etag
  );
}

function isPendingNatOnly(result) {
  return (
    result?.ok === false &&
    result?.invalid === false &&
    Array.isArray(result.failures) &&
    result.failures.length === 1 &&
    NAT_QUIESCENCE_FAILURES.has(result.failures[0])
  );
}

async function defaultInspectProcess(pid) {
  const sessionField = process.platform === "darwin" ? "sess=" : "sid=";
  const { stdout } = await execFileAsync(
    "ps",
    ["-o", `pid=,ppid=,pgid=,${sessionField},tpgid=,stat=`, "-p", String(pid)],
    { encoding: "utf8", timeout: READ_TIMEOUT_MS },
  );
  const fields = stdout.trim().split(/\s+/);
  if (fields.length !== 6) fail("owner_process_invalid");
  const [
    observedPid,
    parentPid,
    processGroupId,
    sessionId,
    terminalGroupId,
    state,
  ] = fields;
  if (
    Number(observedPid) !== pid ||
    ![parentPid, processGroupId, sessionId, terminalGroupId].every((value) =>
      /^-?\d+$/.test(value),
    ) ||
    Number(parentPid) < 1 ||
    Number(processGroupId) < 1 ||
    state.includes("Z")
  ) {
    fail("owner_process_invalid");
  }
  const terminalPgid = Number(terminalGroupId);
  const foreground =
    terminalPgid < 1 || terminalPgid === Number(processGroupId);
  if (!foreground) fail("owner_process_not_foreground");
  return Object.freeze({
    pid,
    parentPid: Number(parentPid),
    processGroupId: Number(processGroupId),
    sessionId: Number(sessionId),
    terminalGroupId: terminalPgid,
  });
}

export async function acquireLiveOwnerLock({
  lockPath,
  repositoryRoot,
  inspectProcess = defaultInspectProcess,
} = {}) {
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath)) {
    fail("owner_lock_path_invalid");
  }
  const [rootPath, temporaryRoot] = await Promise.all([
    realpath(repositoryRoot),
    realpath(tmpdir()),
  ]);
  const resolvedParent = await realpath(path.dirname(lockPath));
  if (
    resolvedParent !== temporaryRoot ||
    lockPath === rootPath ||
    lockPath.startsWith(`${rootPath}${path.sep}`)
  ) {
    fail("owner_lock_path_invalid");
  }
  const processIdentity = await inspectProcess(process.pid);
  const owner = Object.freeze({
    schema: "ovd419-live-owner-v1",
    pid: processIdentity.pid,
    processGroupId: processIdentity.processGroupId,
    sessionId: processIdentity.sessionId,
  });
  let directoryCreated = false;
  try {
    await mkdir(lockPath, { mode: 0o700 });
    directoryCreated = true;
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    if (directoryCreated) {
      await rm(lockPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    fail("owner_lock_unavailable");
  }
  let released = false;
  const assertOwnership = async () => {
    if (released) fail("owner_lock_lost");
    const [directoryMetadata, fileMetadata, currentProcess, ownerSource] =
      await Promise.all([
        stat(lockPath),
        stat(path.join(lockPath, "owner.json")),
        inspectProcess(process.pid),
        readFile(path.join(lockPath, "owner.json"), "utf8"),
      ]);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.uid !== process.getuid() ||
      (directoryMetadata.mode & 0o077) !== 0 ||
      !fileMetadata.isFile() ||
      fileMetadata.uid !== process.getuid() ||
      (fileMetadata.mode & 0o077) !== 0 ||
      currentProcess.processGroupId !== owner.processGroupId ||
      currentProcess.sessionId !== owner.sessionId ||
      ownerSource !== JSON.stringify(owner)
    ) {
      fail("owner_lock_lost");
    }
  };
  const release = async () => {
    await assertOwnership();
    released = true;
    await rm(lockPath, { recursive: true, force: false });
  };
  return Object.freeze({ assertOwnership, release });
}

export function validateLiveAuthorization(
  authorization,
  record,
  now = Date.now(),
) {
  if (!isObject(authorization)) fail("authorization_invalid");
  const allowed = new Set([
    "issue",
    "action",
    "image",
    "sourceCommit",
    "authorized",
    "authorizePromotion",
    "authorizeProviderReadOnlyProbes",
    "issuedAt",
    "expiresAt",
    "nonce",
  ]);
  if (Object.keys(authorization).some((key) => !allowed.has(key))) {
    fail("authorization_invalid");
  }
  const issuedAt = Date.parse(authorization.issuedAt ?? "");
  const expiresAt = Date.parse(authorization.expiresAt ?? "");
  if (
    authorization.issue !== "OVD-419" ||
    authorization.action !== AUTHORIZATION_ACTION ||
    authorization.image !== record.image ||
    authorization.sourceCommit !== record.commit ||
    authorization.authorized !== true ||
    authorization.authorizePromotion !== true ||
    authorization.authorizeProviderReadOnlyProbes !== true ||
    !TOKEN_PATTERN.test(authorization.nonce ?? "") ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now ||
    expiresAt <= now ||
    expiresAt - issuedAt > AUTHORIZATION_MAX_LIFETIME_MS
  ) {
    fail("authorization_invalid");
  }
  return Object.freeze({
    issue: "OVD-419",
    expiresAt: authorization.expiresAt,
  });
}

export async function consumeLiveAuthorization({
  authorization,
  repositoryRoot,
  stateRoot = path.join(
    homedir(),
    ".local",
    "state",
    "overdrafter",
    "ovd419-authorizations",
  ),
  now = new Date().toISOString(),
} = {}) {
  if (typeof authorization?.nonce !== "string") fail("authorization_invalid");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const [statePath, rootPath] = await Promise.all([
    realpath(stateRoot),
    realpath(repositoryRoot),
  ]);
  const metadata = await stat(statePath);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o077) !== 0 ||
    statePath === rootPath ||
    statePath.startsWith(`${rootPath}${path.sep}`)
  ) {
    fail("authorization_state_invalid");
  }
  const nonceHash = createHash("sha256")
    .update(authorization.nonce)
    .digest("hex");
  try {
    await writeFile(
      path.join(statePath, `${nonceHash}.json`),
      `${JSON.stringify({
        issue: "OVD-419",
        action: AUTHORIZATION_ACTION,
        nonceHash,
        consumedAt: now,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST") fail("authorization_replayed");
    fail("authorization_state_invalid");
  }
}

async function defaultRunCommand(gcloudBin, args, timeoutMs = READ_TIMEOUT_MS) {
  const { stdout } = await execFileAsync(gcloudBin, args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return JSON.parse(stdout);
}

async function defaultReplaceManifest(gcloudBin, args, manifest, timeoutMs) {
  const directory = await mkdtemp(path.join(tmpdir(), "ovd419-live-release-"));
  const manifestPath = path.join(directory, "manifest.json");
  try {
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const [group, resource, replace, ...flags] = args;
    if (
      group !== "run" ||
      !["jobs", "services"].includes(resource) ||
      replace !== "replace"
    ) {
      fail("replace_command_invalid");
    }
    await execFileAsync(
      gcloudBin,
      [group, resource, replace, manifestPath, ...flags, "--quiet"],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function commandArgs(expectations, resource, action, extra = []) {
  const noun = resource === "job" ? ["run", "jobs"] : ["run", "services"];
  return [
    ...noun,
    action,
    expectations[resource],
    "--project",
    expectations.project,
    "--region",
    expectations.region,
    ...extra,
  ];
}

function createCloudReader({ expectations, gcloudBin, runCommand }) {
  const readResource = (resource) =>
    runCommand(
      gcloudBin,
      commandArgs(expectations, resource, "describe", ["--format=json"]),
    );
  const executionInventory = async () => {
    const executions = await runCommand(gcloudBin, [
      "run",
      "jobs",
      "executions",
      "list",
      "--job",
      expectations.job,
      "--project",
      expectations.project,
      "--region",
      expectations.region,
      `--limit=${MAX_EXECUTIONS}`,
      "--format=json(metadata.name,status.completionTime,status.runningCount,status.succeededCount,status.failedCount)",
    ]);
    return executionInventoryFromList(executions);
  };
  return { readResource, executionInventory };
}

function buildProbeGuardSource() {
  return `
const fail = () => { throw new Error("OVD-419 in-job precondition failed"); };
const expected = JSON.parse(Buffer.from(process.env.OVD419_EXPECTED_PRECONDITIONS_B64, "base64url").toString("utf8"));
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])])) : value;
const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value)))))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
const guardState = { executed: false };
globalThis[Symbol.for("overdrafter.xometryAuthProbe.preNetworkGuard")] = async () => {
  const tokenResponse = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  if (!tokenResponse.ok) fail();
  const token = (await tokenResponse.json()).access_token;
  if (typeof token !== "string" || token.length === 0) fail();
  const headers = { Authorization: \`Bearer \${token}\` };
  const json = async (url) => { const response = await fetch(url, { headers }); if (!response.ok) fail(); return response.json(); };
  const objectUrl = \`https://storage.googleapis.com/storage/v1/b/\${encodeURIComponent(process.env.XOMETRY_PROFILE_SNAPSHOT_BUCKET)}/o/\${encodeURIComponent(process.env.XOMETRY_PROFILE_SNAPSHOT_OBJECT)}\`;
  const snapshot = await json(objectUrl);
  if (await hash({ generation: snapshot.generation, metageneration: snapshot.metageneration, etag: snapshot.etag }) !== expected.snapshotFingerprint) fail();
  const jobUrl = \`https://run.googleapis.com/apis/run.googleapis.com/v1/namespaces/\${expected.project}/jobs/\${expected.job}\`;
  const job = await json(jobUrl);
  if (job.metadata?.resourceVersion !== expected.jobIdentity.resourceVersion || await hash({ name: job.metadata?.name, spec: job.spec }) !== expected.jobIdentity.configurationFingerprint) fail();
  let pageToken = "";
  const ids = [];
  let activeCount = 0;
  do {
    const page = await json(\`https://run.googleapis.com/apis/run.googleapis.com/v1/namespaces/\${expected.project}/jobs/\${expected.job}/executions?pageSize=1000&pageToken=\${encodeURIComponent(pageToken)}\`);
    for (const execution of page.items ?? []) {
      const id = String(execution.metadata?.name ?? "").split("/").at(-1);
      if (!id) fail();
      ids.push(id);
      if (typeof execution.status?.completionTime !== "string" || Number(execution.status?.runningCount ?? 0) > 0) activeCount += 1;
    }
    pageToken = page.metadata?.continue ?? "";
    if (ids.length >= ${MAX_EXECUTIONS}) fail();
  } while (pageToken);
  const currentExecution = process.env.CLOUD_RUN_EXECUTION;
  if (!currentExecution || activeCount !== 1 || !ids.includes(currentExecution)) fail();
  const priorIds = ids.filter((id) => id !== currentExecution).sort(compare);
  if (priorIds.length !== expected.executionInventory.totalCount || await hash(priorIds) !== expected.executionInventory.fingerprint) fail();
  guardState.executed = true;
};
let probeEvidence;
const originalLog = console.log;
console.log = (value) => { try { probeEvidence = JSON.parse(String(value)); } catch { fail(); } };
await import("file:///app/dist/tools/probeXometryProfileAuth.js");
console.log = originalLog;
if (!guardState.executed || process.exitCode || !probeEvidence?.authenticated || probeEvidence.reason !== "authenticated_dashboard") fail();
originalLog(JSON.stringify({ ...probeEvidence, preconditionsEnforcedBeforeBrowserNetworkActivation: true }));
`;
}

function probeExpectedEnvironment(input, expectations) {
  const payload = {
    project: expectations.project,
    job: expectations.job,
    snapshotFingerprint: sha256Json(input.expectedSnapshot),
    jobIdentity: input.expectedJobIdentity,
    executionInventory: {
      totalCount: input.expectedExecutionInventory.totalCount,
      fingerprint: input.expectedExecutionInventory.fingerprint,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function parseProbeLog(entries) {
  if (!Array.isArray(entries)) fail("probe_log_invalid");
  const candidates = [];
  for (const entry of entries) {
    const value = entry?.textPayload ?? entry?.jsonPayload?.message;
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value);
      if (
        parsed?.preconditionsEnforcedBeforeBrowserNetworkActivation === true
      ) {
        candidates.push(parsed);
      }
    } catch {
      // Non-JSON platform logs are intentionally ignored.
    }
  }
  if (candidates.length !== 1) fail("probe_log_invalid");
  return candidates[0];
}

function requireMutationBaseline({
  rollback,
  resource,
  expectedResourceVersion,
  mutationBaselines,
  rollbackBaselines,
}) {
  const baseline = rollback
    ? rollbackBaselines.get(resource)
    : mutationBaselines.get(resource);
  if (!baseline || baseline.resourceVersion !== expectedResourceVersion) {
    fail("mutation_baseline_missing");
  }
  return baseline;
}

function mutationPreconditionsMatch({
  current,
  currentJob,
  envelope,
  inventory,
  currentSnapshot,
  baseline,
  expectedResourceVersion,
}) {
  return (
    current?.metadata?.resourceVersion === expectedResourceVersion &&
    envelope.controls.every((control) => control.enabled === false) &&
    envelope.workQueue.activeCount === 0 &&
    envelope.quoteRequests.activeCount === 0 &&
    inventory.activeCount === 0 &&
    inventory.totalCount === baseline.inventory.totalCount &&
    inventory.fingerprint === baseline.inventory.fingerprint &&
    currentSnapshot.generation === baseline.snapshot.generation &&
    currentSnapshot.metageneration === baseline.snapshot.metageneration &&
    currentSnapshot.etag === baseline.snapshot.etag &&
    configurationFingerprint(currentJob) ===
      baseline.jobConfigurationFingerprint
  );
}

function buildReplacementManifest({
  resource,
  current,
  image,
  buildVersion,
  rollbackBuildVersion,
  configuredExpectations,
  expectedBuildVersionByImage,
}) {
  if (resource === "job") {
    const manifest = buildAuthProbeJobManifest(current, configuredExpectations);
    jobContainer(manifest).image = image;
    return manifest;
  }
  const manifest = buildWorkerEgressManifest(current, configuredExpectations);
  const container = serviceContainer(manifest);
  container.image = image;
  const envVars = Array.isArray(container.env) ? container.env : [];
  const currentBuildVersion = envVars.filter(
    (entry) => entry?.name === "WORKER_BUILD_VERSION",
  );
  if (currentBuildVersion.length !== 1) fail("service_build_version_invalid");
  const requestedBuildVersion = buildVersion ?? rollbackBuildVersion;
  if (
    typeof requestedBuildVersion !== "string" ||
    requestedBuildVersion.length === 0
  ) {
    fail("service_build_version_invalid");
  }
  currentBuildVersion[0].value = requestedBuildVersion;
  expectedBuildVersionByImage.set(image, requestedBuildVersion);
  return manifest;
}

function guardLiveMutation(rollback, terminationState, markAttempt = false) {
  if (rollback) return;
  terminationState.throwIfRequested();
  if (markAttempt) terminationState.markMutationAttempted();
}

/** Classify one live readback failure without retaining provider or session data. */
function classifyLiveObservationFailure(observed, phase) {
  const allowedFailures = new Set(
    ["after-job", "before-service"].includes(phase)
      ? ["service_job_image_mismatch"]
      : [],
  );
  const stableEgressResult = observed?.stableEgressResult;
  const failures = stableEgressResult?.failures;
  const expectedStableEgressOkay = allowedFailures.size === 0;
  const egressOkay =
    (phase === "after-service" && isPendingNatOnly(stableEgressResult)) ||
    (stableEgressResult?.ok === expectedStableEgressOkay &&
      Array.isArray(failures) &&
      stableEgressResult?.invalid === false &&
      failures.every((failure) => allowedFailures.has(failure)) &&
      failures.length === allowedFailures.size);
  if (!egressOkay) return "stable_egress_observation_invalid";
  if (observed?.phase !== phase) return "observation_phase_invalid";
  if (observed?.rollout?.disabled !== true) return "rollout_not_disabled";
  if (observed?.queueDepthJob !== 0) return "job_queue_not_empty";
  if (observed?.queueDepthService !== 0) return "service_queue_not_empty";
  if (observed?.executionCount !== 0) return "active_execution_present";
  if (
    !Number.isSafeInteger(observed?.executionInventoryCount) ||
    observed.executionInventoryCount < 0 ||
    !HASH_PATTERN.test(observed?.executionInventoryFingerprint ?? "")
  ) {
    return "execution_inventory_invalid";
  }
  if (!HASH_PATTERN.test(observed?.jobConfigurationFingerprint ?? "")) {
    return "job_configuration_observation_invalid";
  }
  if (
    typeof observed?.snapshot?.generation !== "string" ||
    typeof observed?.snapshot?.metageneration !== "string" ||
    typeof observed?.snapshot?.etag !== "string"
  ) {
    return "snapshot_version_invalid";
  }
  return null;
}

export function createOvd419LiveOperations({
  env,
  expectations = productionExpectations(env),
  runCommand = defaultRunCommand,
  replaceManifest = defaultReplaceManifest,
  fetchImpl = fetch,
  collectEnvelope = collectOperationalEnvelope,
  collectStableEgress = collectStableEgressEvidence,
  evaluateStableEgress = evaluateStableEgressEvidence,
  assertOwnership,
  terminationState = NO_TERMINATION,
  now = Date.now,
  waitFor = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    typeof assertOwnership !== "function" ||
    typeof now !== "function" ||
    typeof waitFor !== "function" ||
    typeof terminationState?.throwIfRequested !== "function" ||
    typeof terminationState?.markMutationAttempted !== "function"
  ) {
    fail("live_dependencies_invalid");
  }
  const gcloudBin = env.GCLOUD_BIN ?? "gcloud";
  const configuredExpectations = Object.freeze({
    ...expectations,
    snapshotBucket: env.XOMETRY_PROFILE_SNAPSHOT_BUCKET,
    snapshotObject: env.XOMETRY_PROFILE_SNAPSHOT_OBJECT,
    snapshotMaxBytes: env.XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES,
  });
  const reader = createCloudReader({ expectations, gcloudBin, runCommand });
  let rollbackImage;
  let rollbackBuildVersion;
  let expectedContainmentSnapshot;
  const expectedBuildVersionByImage = new Map();
  const mutationBaselines = new Map();
  const rollbackBaselines = new Map();

  const collectEnvelopeFresh = () =>
    collectEnvelope({
      serviceRoleSecret: env.SUPABASE_SERVICE_ROLE_KEY,
      createClientImpl: (url, key, options) =>
        createClient(url, key, {
          ...options,
          global: { ...options?.global, fetch: fetchImpl },
        }),
    });

  const collectSnapshotFresh = async () => {
    const metadata = await runCommand(gcloudBin, [
      "storage",
      "objects",
      "describe",
      `gs://${configuredExpectations.snapshotBucket}/${configuredExpectations.snapshotObject}`,
      "--format=json(generation,metageneration,etag)",
    ]);
    return snapshotVersion(metadata);
  };

  const verifyRuntimeGuardPermissions = async () => {
    const policy = await runCommand(gcloudBin, [
      "projects",
      "get-iam-policy",
      expectations.project,
      "--format=json",
    ]);
    const member = `serviceAccount:${expectations.serviceAccount}`;
    const roles = (policy?.bindings ?? [])
      .filter(
        (binding) =>
          Array.isArray(binding?.members) && binding.members.includes(member),
      )
      .map((binding) => binding.role)
      .filter((role) => typeof role === "string");
    const permissions = new Set();
    for (const role of roles) {
      const args = ["iam", "roles", "describe", role, "--format=json"];
      if (role.startsWith(`projects/${expectations.project}/roles/`)) {
        args.push("--project", expectations.project);
      }
      const description = await runCommand(gcloudBin, args);
      for (const permission of description?.includedPermissions ?? []) {
        permissions.add(permission);
      }
    }
    if (
      !permissions.has("run.jobs.get") ||
      !permissions.has("run.executions.list")
    ) {
      fail("runtime_guard_permissions_missing");
    }
  };

  const observe = async ({ phase }) => {
    const [envelope, stable, inventory, snapshot, currentJob, currentService] =
      await Promise.all([
        collectEnvelopeFresh(),
        collectStableEgress(expectations, { gcloudBin, runCommand }),
        reader.executionInventory(),
        collectSnapshotFresh(),
        reader.readResource("job"),
        reader.readResource("service"),
      ]);
    const jobImage = resourceImage(currentJob, "job");
    const serviceImage = resourceImage(currentService, "service");
    if (
      stable.job?.metadata?.resourceVersion !==
        currentJob?.metadata?.resourceVersion ||
      stable.service?.metadata?.resourceVersion !==
        currentService?.metadata?.resourceVersion ||
      resourceImage(stable.job, "job") !== jobImage ||
      resourceImage(stable.service, "service") !== serviceImage
    ) {
      fail("live_resource_readback_mismatch");
    }
    if (phase === "before-job") rollbackImage = serviceImage;
    if (phase === "before-job") {
      expectedContainmentSnapshot = snapshot;
      const buildVersions = serviceContainer(currentService)?.env?.filter(
        (entry) => entry?.name === "WORKER_BUILD_VERSION",
      );
      if (
        !Array.isArray(buildVersions) ||
        buildVersions.length !== 1 ||
        typeof buildVersions[0]?.value !== "string" ||
        buildVersions[0].value.length === 0
      ) {
        fail("service_build_version_invalid");
      }
      rollbackBuildVersion = buildVersions[0].value;
      expectedBuildVersionByImage.set(rollbackImage, rollbackBuildVersion);
    }
    const observed = {
      phase,
      rollout: {
        disabled: envelope.controls.every(
          (control) => control.enabled === false,
        ),
      },
      queueDepthJob: envelope.workQueue.activeCount,
      queueDepthService: envelope.quoteRequests.activeCount,
      executionCount: inventory.activeCount,
      executionInventoryCount: inventory.totalCount,
      executionInventoryFingerprint: inventory.fingerprint,
      jobResourceVersion: currentJob?.metadata?.resourceVersion,
      serviceResourceVersion: currentService?.metadata?.resourceVersion,
      jobImage,
      serviceImage,
      rollbackImage,
      stableEgressResult: evaluateStableEgress(stable, expectations),
      snapshot,
      jobConfigurationFingerprint: configurationFingerprint(currentJob),
    };
    let resource = null;
    if (phase === "before-job") {
      resource = "job";
    } else if (phase === "before-service") {
      resource = "service";
    }
    if (resource) {
      mutationBaselines.set(resource, {
        resourceVersion:
          resource === "job"
            ? observed.jobResourceVersion
            : observed.serviceResourceVersion,
        inventory,
        snapshot,
        jobConfigurationFingerprint: observed.jobConfigurationFingerprint,
      });
    }
    return observed;
  };

  const verifyObservation = async ({ observed, phase }) => {
    const failure = classifyLiveObservationFailure(observed, phase);
    return {
      ok: failure === null,
      failures: failure === null ? [] : [failure],
    };
  };

  const replaceResource = async ({
    resource,
    image,
    expectedResourceVersion,
    buildVersion,
    rollback = false,
  }) => {
    await assertOwnership();
    guardLiveMutation(rollback, terminationState);
    const baseline = requireMutationBaseline({
      rollback,
      resource,
      expectedResourceVersion,
      mutationBaselines,
      rollbackBaselines,
    });
    const [current, currentJob, envelope, inventory, currentSnapshot] =
      await Promise.all([
        reader.readResource(resource),
        reader.readResource("job"),
        collectEnvelopeFresh(),
        reader.executionInventory(),
        collectSnapshotFresh(),
      ]);
    if (
      !mutationPreconditionsMatch({
        current,
        currentJob,
        envelope,
        inventory,
        currentSnapshot,
        baseline,
        expectedResourceVersion,
      })
    ) {
      fail("resource_version_changed");
    }
    const manifest = buildReplacementManifest({
      resource,
      current,
      image,
      buildVersion,
      rollbackBuildVersion,
      configuredExpectations,
      expectedBuildVersionByImage,
    });
    await assertOwnership();
    guardLiveMutation(rollback, terminationState, true);
    await replaceManifest(
      gcloudBin,
      [
        "run",
        resource === "job" ? "jobs" : "services",
        "replace",
        "--project",
        expectations.project,
        "--region",
        expectations.region,
      ],
      manifest,
      MUTATION_TIMEOUT_MS,
    );
    guardLiveMutation(rollback, terminationState);
  };

  const observeRollbackResource = async ({ resource }) => {
    const [current, currentJob, envelope, inventory, currentSnapshot] =
      await Promise.all([
        reader.readResource(resource),
        reader.readResource("job"),
        collectEnvelopeFresh(),
        reader.executionInventory(),
        collectSnapshotFresh(),
      ]);
    if (
      !envelope.controls.every((control) => control.enabled === false) ||
      envelope.workQueue.activeCount !== 0 ||
      envelope.quoteRequests.activeCount !== 0 ||
      inventory.activeCount !== 0
    ) {
      fail("rollback_preconditions_invalid");
    }
    rollbackBaselines.set(resource, {
      resourceVersion: current?.metadata?.resourceVersion,
      inventory,
      snapshot: currentSnapshot,
      jobConfigurationFingerprint: configurationFingerprint(currentJob),
    });
    return {
      resource,
      image: resourceImage(current, resource),
      resourceVersion: current?.metadata?.resourceVersion,
    };
  };

  const collectContainmentObservation = async (input) => {
    await assertOwnership();
    const [envelope, stable, inventory, currentSnapshot] = await Promise.all([
      collectEnvelopeFresh(),
      collectStableEgress(expectations, { gcloudBin, runCommand }),
      reader.executionInventory(),
      collectSnapshotFresh(),
    ]);
    await assertOwnership();
    const stableResult = evaluateStableEgress(stable, expectations);
    const expectedInventory = input.expectedExecutionInventory;
    const inventoryMatches =
      expectedInventory !== undefined &&
      inventory.totalCount ===
        (expectedInventory.totalCount ?? expectedInventory.count) &&
      inventory.fingerprint === expectedInventory.fingerprint &&
      inventory.activeCount === 0;
    const imageMatches =
      resourceImage(stable.job, "job") === input.expectedImage &&
      resourceImage(stable.service, "service") === input.expectedImage;
    const buildVersionMatches =
      typeof expectedBuildVersionByImage.get(input.expectedImage) ===
        "string" &&
      serviceBuildVersion(stable.service) ===
        expectedBuildVersionByImage.get(input.expectedImage);
    const admissionBlocked =
      envelope.controls.every((control) => control.enabled === false) &&
      envelope.workQueue.activeCount === 0 &&
      envelope.quoteRequests.activeCount === 0;
    const snapshotMatches =
      expectedContainmentSnapshot !== undefined &&
      sameSnapshotVersion(currentSnapshot, expectedContainmentSnapshot);
    const stableReady =
      stableResult?.ok === true &&
      stableResult?.invalid === false &&
      Array.isArray(stableResult.failures) &&
      stableResult.failures.length === 0;
    const nonNatInvariantsPass =
      inventoryMatches &&
      imageMatches &&
      buildVersionMatches &&
      admissionBlocked &&
      snapshotMatches;
    let state = "blocked";
    if (stableReady && nonNatInvariantsPass) {
      state = "ready";
    } else if (isPendingNatOnly(stableResult) && nonNatInvariantsPass) {
      state = "pending_nat_quiescence";
    }
    return {
      state,
      admissionBlocked,
      jobResourceVersion: stable.job?.metadata?.resourceVersion,
      jobConfigurationFingerprint: configurationFingerprint(stable.job),
    };
  };

  const verifyContainment = async (input) => {
    const startedAt = now();
    const deadline = startedAt + NAT_QUIESCENCE_TIMEOUT_MS;
    if (!Number.isFinite(startedAt)) fail("containment_clock_invalid");
    for (
      let observation = 1;
      observation <= NAT_QUIESCENCE_MAX_OBSERVATIONS;
      observation += 1
    ) {
      const verdict = await collectContainmentObservation(input);
      const observedAt = now();
      if (verdict.state === "ready") {
        if (!Number.isFinite(observedAt) || observedAt > deadline) {
          return {
            ok: false,
            admissionBlocked: verdict.admissionBlocked,
            failures: ["containment_invalid"],
            jobResourceVersion: verdict.jobResourceVersion,
            jobConfigurationFingerprint:
              verdict.jobConfigurationFingerprint,
          };
        }
        return {
          ok: true,
          admissionBlocked: verdict.admissionBlocked,
          failures: [],
          jobResourceVersion: verdict.jobResourceVersion,
          jobConfigurationFingerprint: verdict.jobConfigurationFingerprint,
        };
      }
      if (verdict.state !== "pending_nat_quiescence") {
        return {
          ok: false,
          admissionBlocked: verdict.admissionBlocked,
          failures: ["containment_invalid"],
          jobResourceVersion: verdict.jobResourceVersion,
          jobConfigurationFingerprint: verdict.jobConfigurationFingerprint,
        };
      }
      const remaining = deadline - observedAt;
      if (
        !Number.isFinite(remaining) ||
        remaining <= 0 ||
        observation === NAT_QUIESCENCE_MAX_OBSERVATIONS
      ) {
        return {
          ok: false,
          admissionBlocked: verdict.admissionBlocked,
          failures: ["containment_invalid"],
          jobResourceVersion: verdict.jobResourceVersion,
          jobConfigurationFingerprint: verdict.jobConfigurationFingerprint,
        };
      }
      await waitFor(Math.min(NAT_QUIESCENCE_INTERVAL_MS, remaining));
    }
    fail("containment_observation_limit_invalid");
  };

  const snapshot = collectSnapshotFresh;

  const observeProbeJob = async () => {
    const job = await reader.readResource("job");
    return {
      resourceVersion: job?.metadata?.resourceVersion,
      configurationFingerprint: configurationFingerprint(job),
    };
  };

  const executeProbe = async (input) => {
    await assertOwnership();
    terminationState.throwIfRequested();
    const guard = Buffer.from(buildProbeGuardSource()).toString("base64");
    const expression = `await import("data:text/javascript;base64,${guard}")`;
    const environment = probeExpectedEnvironment(input, configuredExpectations);
    const execution = await runCommand(
      gcloudBin,
      [
        "run",
        "jobs",
        "execute",
        expectations.job,
        "--project",
        expectations.project,
        "--region",
        expectations.region,
        "--wait",
        "--tasks=1",
        "--command=node",
        `--args=^~^--input-type=module~-e~${expression}`,
        `--update-env-vars=OVD419_EXPECTED_PRECONDITIONS_B64=${environment}`,
        "--format=json",
      ],
      PROBE_TIMEOUT_MS,
    );
    terminationState.markMutationAttempted();
    terminationState.throwIfRequested();
    const id = executionName(execution);
    if (
      !TOKEN_PATTERN.test(id ?? "") ||
      execution?.status?.failedCount > 0 ||
      execution?.status?.succeededCount !== 1 ||
      execution?.spec?.taskCount !== 1
    ) {
      fail("probe_execution_invalid");
    }
    const logs = await runCommand(gcloudBin, [
      "logging",
      "read",
      `resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="${id}"`,
      "--project",
      expectations.project,
      "--limit=100",
      "--format=json(textPayload,jsonPayload.message)",
    ]);
    terminationState.throwIfRequested();
    const evidence = parseProbeLog(logs);
    return {
      executionId: id,
      image: input.image,
      taskCount: 1,
      maxRetries: 0,
      freshInstance: true,
      preconditionsEnforcedBeforeBrowserNetworkActivation:
        evidence.preconditionsEnforcedBeforeBrowserNetworkActivation,
      evidence: {
        authenticated: evidence.authenticated,
        reason: evidence.reason,
        browserEngine: evidence.browserEngine,
        snapshotGeneration: evidence.snapshotGeneration,
        snapshotPersisted: evidence.snapshotPersisted,
        fileSelectionPerformed: evidence.fileSelectionPerformed,
        userInputInteractionPerformed: evidence.userInputInteractionPerformed,
        screenshotCaptured: evidence.screenshotCaptured,
        domCaptured: evidence.domCaptured,
        traceCaptured: evidence.traceCaptured,
        providerMutationObserved: evidence.providerMutationObserved,
        dashboardInteraction: evidence.dashboardInteraction,
        blockedNonReadMethods: evidence.blockedNonReadMethods,
      },
    };
  };

  const rollbackAfterProbeFailure = async () => {
    await assertOwnership();
    if (!isImmutableImage(rollbackImage)) fail("rollback_image_invalid");
    const expectedInventory = await reader.executionInventory();
    const results = [];
    for (const resource of ["service", "job"]) {
      const before = await observeRollbackResource({ resource });
      if (before.image !== rollbackImage) {
        await replaceResource({
          resource,
          image: rollbackImage,
          expectedResourceVersion: before.resourceVersion,
          rollback: true,
        });
      }
      const after = await observeRollbackResource({ resource });
      const versionIsValid =
        before.image === rollbackImage
          ? after.resourceVersion === before.resourceVersion
          : after.resourceVersion !== before.resourceVersion;
      results.push(after.image === rollbackImage && versionIsValid);
    }
    const contained = await verifyContainment({
      expectedImage: rollbackImage,
      expectedExecutionInventory: expectedInventory,
      stage: "probe-failure-rollback",
    });
    if (results.some((result) => !result) || contained.ok !== true) {
      fail("probe_failure_rollback_invalid");
    }
  };

  return Object.freeze({
    promotion: Object.freeze({
      observe,
      verifyObservation,
      replaceJob: ({ image, expectedResourceVersion, execute }) => {
        if (execute !== false) fail("job_execute_not_false");
        return replaceResource({
          resource: "job",
          image,
          expectedResourceVersion,
        });
      },
      replaceService: ({ image, buildVersion, expectedResourceVersion }) =>
        replaceResource({
          resource: "service",
          image,
          buildVersion,
          expectedResourceVersion,
        }),
      observeRollbackResource,
      rollbackResource: ({ resource, image, expectedResourceVersion }) =>
        replaceResource({
          resource,
          image,
          expectedResourceVersion,
          buildVersion: undefined,
          rollback: true,
        }),
      readbackRollbackResource: observeRollbackResource,
      verifyContainment,
    }),
    probes: Object.freeze({
      snapshot,
      executionInventory: reader.executionInventory,
      observeProbeJob,
      executeProbe,
      verifyContainment,
    }),
    rollbackAfterProbeFailure,
    verifyRuntimeGuardPermissions,
  });
}

function requireUninterruptedBeforeMutation(terminationState) {
  if (terminationState.isRequested()) fail("interrupted_before_mutation");
}

async function failAfterInterruptedRollback(operations) {
  try {
    await operations.rollbackAfterProbeFailure();
  } catch {
    fail("interrupted_rollback_failed");
  }
  fail("interrupted_rolled_back");
}

async function runPromotionWithInterruptionSafety({
  promote,
  recordSource,
  buildEvidence,
  operations,
  terminationState,
}) {
  let promotion;
  try {
    promotion = await promote({
      recordSource,
      buildEvidence,
      operations: operations.promotion,
      execute: true,
    });
    terminationState.throwIfRequested();
    return promotion;
  } catch (error) {
    if (!terminationState.isRequested()) throw error;
    if (!terminationState.mutationAttempted()) {
      fail("interrupted_before_mutation");
    }
    if (promotion) await failAfterInterruptedRollback(operations);
    if (error?.code === "promotion_failed_rolled_back") {
      fail("interrupted_rolled_back");
    }
    fail("interrupted_rollback_failed");
  }
}

async function failAfterProbeRollback(operations, interrupted) {
  try {
    await operations.rollbackAfterProbeFailure();
  } catch {
    fail(
      interrupted
        ? "interrupted_rollback_failed"
        : "probe_failed_rollback_failed",
    );
  }
  fail(interrupted ? "interrupted_rolled_back" : "probe_failed_rolled_back");
}

async function runProbesWithInterruptionSafety({
  runProbes,
  image,
  operations,
  terminationState,
}) {
  try {
    const probes = await runProbes({
      image,
      operations: operations.probes,
      execute: true,
    });
    terminationState.throwIfRequested();
    return probes;
  } catch {
    await failAfterProbeRollback(operations, terminationState.isRequested());
  }
}

export async function runAuthorizedLiveRelease({
  recordSource,
  buildEvidence,
  authorization,
  env = process.env,
  now = Date.now(),
  dependencies = {},
  assertOwnership,
  terminationState = NO_TERMINATION,
} = {}) {
  const record = parseDigestRecord(recordSource);
  validateLiveAuthorization(authorization, record, now);
  const expectations = productionExpectations(env);
  if (typeof assertOwnership !== "function") fail("owner_lock_missing");
  await assertOwnership();
  requireUninterruptedBeforeMutation(terminationState);
  const consumeAuthorization =
    dependencies.consumeAuthorization ?? consumeLiveAuthorization;
  await consumeAuthorization({
    authorization,
    repositoryRoot: dependencies.repositoryRoot ?? process.cwd(),
    stateRoot: dependencies.authorizationStateRoot,
  });
  requireUninterruptedBeforeMutation(terminationState);
  const createOperations =
    dependencies.createOperations ?? createOvd419LiveOperations;
  const promote = dependencies.promote ?? promoteDigest;
  const runProbes = dependencies.runProbes ?? runNoUploadProbes;
  const operations = createOperations({
    env,
    expectations,
    ...dependencies,
    assertOwnership,
    terminationState,
  });
  try {
    await operations.verifyRuntimeGuardPermissions();
  } catch {
    fail("promotion_failed_before_mutation");
  }
  requireUninterruptedBeforeMutation(terminationState);
  const promotion = await runPromotionWithInterruptionSafety({
    promote,
    recordSource,
    buildEvidence,
    operations,
    terminationState,
  });
  const probes = await runProbesWithInterruptionSafety({
    runProbes,
    image: record.image,
    operations,
    terminationState,
  });
  terminationState.markQualificationPassed();
  return Object.freeze({
    schema: "ovd419-live-release-v1",
    status: "passed",
    issue: "OVD-419",
    promotion,
    probes,
    uploadPerformed: false,
    quoteRequested: false,
    orderActionPerformed: false,
  });
}

async function readPrivateAuthorization(filePath, repositoryRoot) {
  const [authorizationPath, rootPath] = await Promise.all([
    realpath(filePath),
    realpath(repositoryRoot),
  ]);
  const metadata = await stat(authorizationPath);
  if (
    !metadata.isFile() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o077) !== 0 ||
    authorizationPath === rootPath ||
    authorizationPath.startsWith(`${rootPath}${path.sep}`)
  ) {
    fail("authorization_file_invalid");
  }
  return JSON.parse(await readFile(authorizationPath, "utf8"));
}

function parseCliArgs(args) {
  if (args.length !== 7 || args[0] !== "--execute") return null;
  const authorizationIndex = args.indexOf("--authorization-file");
  const bundleIndex = args.indexOf("--bundle-file");
  const evidenceIndex = args.indexOf("--evidence-file");
  if (
    authorizationIndex < 1 ||
    bundleIndex < 1 ||
    evidenceIndex < 1 ||
    !args[authorizationIndex + 1] ||
    !args[bundleIndex + 1] ||
    !args[evidenceIndex + 1]
  ) {
    return null;
  }
  return {
    authorizationFile: args[authorizationIndex + 1],
    bundleFile: args[bundleIndex + 1],
    evidenceFile: args[evidenceIndex + 1],
  };
}

async function reservePrivateEvidence(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    fail("evidence_file_invalid");
  }
  const [parentPath, temporaryRoot] = await Promise.all([
    realpath(path.dirname(filePath)),
    realpath(tmpdir()),
  ]);
  if (parentPath !== temporaryRoot) fail("evidence_file_invalid");
  return open(filePath, "wx", 0o600);
}

async function writePrivateEvidence(fileHandle, evidence) {
  await fileHandle.truncate(0);
  await fileHandle.writeFile(`${JSON.stringify(evidence)}\n`, {
    encoding: "utf8",
  });
  await fileHandle.sync();
}

/** Reduce a live failure to the fixed owner-only evidence vocabulary. */
function boundedFailureEvidence(error) {
  const containmentByTerminalCode = {
    promotion_failed_before_mutation: "not_required",
    promotion_failed_rollback_unverified: "rollback_unverified",
    promotion_failed_rolled_back: "baseline_restored",
    probe_failed_rolled_back: "baseline_restored",
    probe_failed_rollback_failed: "rollback_unverified",
    interrupted_before_mutation: "not_required",
    interrupted_rolled_back: "baseline_restored",
    interrupted_rollback_failed: "rollback_unverified",
  };
  const terminalCode = Object.hasOwn(containmentByTerminalCode, error?.code)
    ? error.code
    : "failed_closed";
  const containment =
    containmentByTerminalCode[terminalCode] ?? "not_verified";
  const promotionFailure =
    [
      "promotion_failed_rolled_back",
      "promotion_failed_rollback_unverified",
    ].includes(terminalCode) &&
    PROMOTION_FAILURE_CODES.has(error?.promotionFailureCode) &&
    PROMOTION_FAILURE_STAGES.has(error?.promotionFailureStage)
      ? {
          promotionFailureCode: error.promotionFailureCode,
          promotionFailureStage: error.promotionFailureStage,
        }
      : {};
  return Object.freeze({
    schema: "ovd419-live-release-v1",
    status: "failed",
    issue: "OVD-419",
    terminalCode,
    containment,
    ...promotionFailure,
    retryAuthorized: false,
  });
}

function interruptedSuccessEvidence(result) {
  return Object.freeze({
    ...result,
    terminalCode: "passed_interrupted_after_qualification",
    retryAuthorized: false,
  });
}

async function syncSuccessfulEvidence({
  result,
  terminationState,
  evidenceHandle,
  writeEvidence,
}) {
  let evidence = terminationState.isRequested()
    ? interruptedSuccessEvidence(result)
    : result;
  await writeEvidence(evidenceHandle, evidence);
  if (
    terminationState.isRequested() &&
    evidence.terminalCode !== "passed_interrupted_after_qualification"
  ) {
    evidence = interruptedSuccessEvidence(result);
    await writeEvidence(evidenceHandle, evidence);
  }
  return evidence;
}

async function closeEvidence(evidenceHandle) {
  await evidenceHandle?.close().catch(() => undefined);
}

async function releaseOwner(ownerLock) {
  if (!ownerLock) return "not_acquired";
  try {
    await ownerLock.release();
    return "completed";
  } catch {
    return "unverified";
  }
}

async function completeSuccessfulCliRelease({
  result,
  terminationState,
  evidenceHandle,
  writeEvidence,
  ownerLock,
  output,
  errorOutput,
}) {
  const evidence = await syncSuccessfulEvidence({
    result,
    terminationState,
    evidenceHandle,
    writeEvidence,
  });
  await closeEvidence(evidenceHandle);
  const ownerRelease = await releaseOwner(ownerLock);
  if (ownerRelease !== "completed") {
    errorOutput.write(
      "OVD-419 live release passed_owner_lock_release_failed; private bounded success evidence recorded; retry not authorized.\n",
    );
    return 3;
  }
  const interruptedAfterQualification =
    evidence.terminalCode === "passed_interrupted_after_qualification";
  output.write(
    interruptedAfterQualification
      ? "OVD-419 live release passed_interrupted_after_qualification; private bounded success evidence recorded; retry not authorized.\n"
      : "OVD-419 live release passed; private bounded evidence recorded.\n",
  );
  return 0;
}

async function handleSuccessfulEvidenceFailure({
  evidenceHandle,
  ownerLock,
  errorOutput,
}) {
  await closeEvidence(evidenceHandle);
  const ownerRelease = await releaseOwner(ownerLock);
  errorOutput.write(
    `OVD-419 live release passed_evidence_write_failed; owner lock release ${ownerRelease}; retry not authorized.\n`,
  );
  return 4;
}

async function recordFailureEvidence({
  evidenceHandle,
  failure,
  writeEvidence,
}) {
  if (!evidenceHandle) return false;
  try {
    await writeEvidence(evidenceHandle, failure);
    return true;
  } catch {
    return false;
  }
}

async function failureOwnerDisposition(ownerLock, containment) {
  if (!ownerLock) return "not_acquired";
  if (["not_verified", "rollback_unverified"].includes(containment)) {
    return "retained";
  }
  return releaseOwner(ownerLock);
}

async function handleFailedCliRelease({
  error,
  evidenceHandle,
  ownerLock,
  writeEvidence,
  errorOutput,
}) {
  const failure = boundedFailureEvidence(error);
  const recorded = await recordFailureEvidence({
    evidenceHandle,
    failure,
    writeEvidence,
  });
  await closeEvidence(evidenceHandle);
  const ownerRelease = await failureOwnerDisposition(
    ownerLock,
    failure.containment,
  );
  errorOutput.write(
    `OVD-419 live release ${failure.terminalCode}; private bounded failure evidence ${recorded ? "recorded" : "not recorded"}; owner lock release ${ownerRelease}.\n`,
  );
  return 1;
}

export async function runCli({
  args = process.argv.slice(2),
  env = process.env,
  output = process.stdout,
  errorOutput = process.stderr,
  repositoryRoot = process.cwd(),
  runRelease = runAuthorizedLiveRelease,
  acquireOwner = acquireLiveOwnerLock,
  reserveEvidence = reservePrivateEvidence,
  writeEvidence = writePrivateEvidence,
  createTermination = createTerminationState,
  installTermination = installDeferredTerminationHandlers,
} = {}) {
  const parsed = parseCliArgs(args);
  if (!parsed) {
    errorOutput.write(LIVE_USAGE);
    return 2;
  }
  const terminationState = createTermination();
  const removeTerminationHandlers = installTermination({ terminationState });
  let evidenceHandle;
  let ownerLock;
  let releasePassed = false;
  try {
    const [authorization, bundleSource] = await Promise.all([
      readPrivateAuthorization(parsed.authorizationFile, repositoryRoot),
      readFile(parsed.bundleFile, "utf8"),
    ]);
    const bundle = JSON.parse(bundleSource);
    evidenceHandle = await reserveEvidence(parsed.evidenceFile);
    if (terminationState.isRequested()) fail("interrupted_before_mutation");
    ownerLock = await acquireOwner({
      lockPath: env.OVD419_OWNER_LOCK_PATH,
      repositoryRoot,
    });
    const result = await runRelease({
      recordSource: JSON.stringify(bundle.record),
      buildEvidence: bundle.buildEvidence,
      authorization,
      env,
      assertOwnership: ownerLock.assertOwnership,
      terminationState,
    });
    releasePassed = true;
    const exitCode = await completeSuccessfulCliRelease({
      result,
      terminationState,
      evidenceHandle,
      writeEvidence,
      ownerLock,
      output,
      errorOutput,
    });
    return exitCode;
  } catch (error) {
    if (releasePassed) {
      const exitCode = await handleSuccessfulEvidenceFailure({
        evidenceHandle,
        ownerLock,
        errorOutput,
      });
      return exitCode;
    }
    const exitCode = await handleFailedCliRelease({
      error,
      evidenceHandle,
      ownerLock,
      writeEvidence,
      errorOutput,
    });
    return exitCode;
  } finally {
    removeTerminationHandlers();
  }
}

if (isDirectCli(import.meta.url)) process.exitCode = await runCli();
