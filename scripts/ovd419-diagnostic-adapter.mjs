import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { createClient } from "@supabase/supabase-js";
import { createPrivateManifest } from "./ovd419-diagnostic-manifest.mjs";
import { diagnosticStageLimits, runWithinBudget, unsettledOperation } from "./ovd419-diagnostic-budget.mjs";
import { compareCodeUnits, digest, projectClassification, TARGET } from "./ovd419-job-diagnostic.mjs";
import { readBoundFile } from "./ovd419-diagnostic-bindings.mjs";
import { collectOperationalEnvelope } from "./collect-ovd410-operational-envelope.mjs";
import { collectStableEgressEvidence, evaluateStableEgressEvidence } from "./verify-xometry-stable-egress.mjs";
import { OVD410_PRODUCTION_CONTRACT, OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS } from "./xometry-stable-egress-contract.mjs";

const exec = promisify(execFile);
// Per complete observation: 18 egress + at most 50 roles + 8 other cloud reads
// + one initial secret access; four at-most-100-page scans + seven RPC/count reads.
const MAX_OBSERVATION_CLOUD_READS = 18 + 50 + 8 + 1;
const MAX_OBSERVATION_HTTP_READS = 4 * 100 + 7;
const EGRESS = Object.freeze({ ...OVD410_PRODUCTION_CONTRACT, natTcpEstablishedIdleTimeoutSeconds: OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS });
function reject() { throw new Error("diagnostic_adapter_rejected"); }
function container(resource, job) {
  const values = job ? resource?.spec?.template?.spec?.template?.spec?.containers : resource?.spec?.template?.spec?.containers;
  if (!Array.isArray(values) || values.length !== 1) reject();
  return values[0];
}
function env(containerValue) {
  const entries = containerValue?.env;
  if (!Array.isArray(entries) || new Set(entries.map((e) => e.name)).size !== entries.length) reject();
  return Object.fromEntries(entries.map((entry) => [entry.name, entry]));
}
function identify(resource) {
  return { uid: resource?.metadata?.uid, generation: resource?.metadata?.generation,
    resourceVersion: resource?.metadata?.resourceVersion,
    configuration: digest({ name: resource?.metadata?.name, spec: resource?.spec }) };
}
function normalizedSnapshot(value) {
  const result = { generation: String(value?.generation), metageneration: String(value?.metageneration), etag: value?.etag };
  if (!/^[1-9]\d{0,19}$/.test(result.generation) || !/^[1-9]\d{0,19}$/.test(result.metageneration) || !/^[A-Za-z0-9+/_=-]{1,256}$/.test(result.etag)) reject();
  return result;
}
function normalizedTask(value) {
  const task = structuredClone(value);
  if (!Array.isArray(task?.containers) || task.containers.length !== 1) reject();
  // Environment order is not semantic; duplicate names are rejected by env().
  env(task.containers[0]);
  task.containers[0].env.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return task;
}

/** Consume the HTTP body inside the same read deadline, with a fixed memory bound. */
async function bufferedResponse(response) {
  if (!response.body) return response;
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) reject();
      chunks.push(value);
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally { if (!complete) await reader.cancel(); }
}

function classificationPayload(payload, executionId, binding) {
  if (payload?.reason === "ovd419_guard_failed") {
    if (payload.packetSha256 !== binding.packetSha256 || payload.executionId !== executionId || payload.executionUid !== binding.executionUid || payload.runtimeModuleSha256 !== binding.runtimeModuleSha256) reject();
    if (payload.stage !== "probe_result" || payload.httpStatus !== undefined) reject();
    const value = projectClassification({ reason: payload.probeReason, authenticated: false });
    if (!value) reject();
    return value;
  } else if (payload?.preconditionsEnforcedBeforeBrowserNetworkActivation === true) {
    if (payload.packetSha256 !== binding.packetSha256 || payload.executionId !== executionId || payload.executionUid !== binding.executionUid || payload.runtimeModuleSha256 !== binding.runtimeModuleSha256) reject();
    const value = projectClassification(payload); if (!value) reject();
    return value;
  }
}

/** Parse exactly one attributable fixed result, including unsuccessful guard output. */
export function readFixedClassification(entries, executionId, binding) {
  if (!Array.isArray(entries) || entries.length >= 100 || !/^[a-z][a-z0-9-]{0,62}$/.test(executionId)) reject();
  if (!binding || binding.executionId !== executionId || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.executionUid) || !/^[0-9a-f]{64}$/.test(binding.packetSha256) || !/^[0-9a-f]{64}$/.test(binding.runtimeModuleSha256)) reject();
  const found = [];
  for (const entry of entries) {
    if (entry?.labels?.["run.googleapis.com/execution_name"] !== executionId || entry?.resource?.type !== "cloud_run_job" || entry?.resource?.labels?.job_name !== TARGET.job || entry?.resource?.labels?.project_id !== TARGET.project || entry?.resource?.labels?.location !== TARGET.region) reject();
    let payload = entry.jsonPayload;
    try { if (typeof entry.textPayload === "string") payload = JSON.parse(entry.textPayload); }
    catch { continue; }
    const value = classificationPayload(payload, executionId, binding);
    if (value) found.push(value);
  }
  if (found.length !== 1) reject();
  return { executionId, executionUid: binding.executionUid, packetSha256: binding.packetSha256, runtimeModuleSha256: binding.runtimeModuleSha256, ...found[0] };
}

/**
 * Construct the supported Job-only cloud adapter. No operation occurs on creation.
 * All commands are explicit, bounded, shell-free, and injectable for offline tests.
 */
export function createDiagnosticAdapter(packet, { verifyBindings, assertOwnership, beforeMutation, runCommand, createManifest = createPrivateManifest, collectEnvelope = collectOperationalEnvelope, collectEgress = collectStableEgressEvidence, evaluateEgress = evaluateStableEgressEvidence, fetchImpl = fetch, now = Date.now } = {}) {
  if (typeof verifyBindings !== "function" || typeof assertOwnership !== "function" || typeof beforeMutation !== "function") reject();
  let baselineJob, latest, secret, reads = 0, replaced = false, dispatched = false, restored = false;
  let attemptedTask, attemptedAnnotations, attemptedExpected, attributedExecution;
  let observations = 0, poisoned = false, observationReads = null;
  const manifests = [];
  const deadlines = new WeakMap();
  const stages = diagnosticStageLimits(packet.limits);
  const scoped = async (input, timeoutMs, fn) => {
    if (poisoned) throw unsettledOperation();
    try {
      return await runWithinBudget(async (signal, ms, deadlineAt) => {
        deadlines.set(signal, deadlineAt);
        return fn(signal, ms);
      }, { timeoutMs, signal: input?.signal, deadlineAt: Math.min(input?.deadlineAt ?? Infinity, deadlines.get(input?.signal) ?? Infinity), now,
        onUnsettled: () => { poisoned = true; } });
    } catch (error) {
      if (poisoned) throw unsettledOperation();
      throw error;
    }
  };
  const spendRead = (signal, kind) => {
    if (poisoned || signal?.aborted) throw unsettledOperation();
    if (++reads > packet.limits.maxReads) reject();
    if (observationReads && ++observationReads[kind] > (kind === "cloud" ? MAX_OBSERVATION_CLOUD_READS : MAX_OBSERVATION_HTTP_READS)) reject();
  };
  const environment = {
    HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
    CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
    CLOUDSDK_PYTHON: packet.artifacts.python.path, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
  };
  const command = async (args, signal, { raw = false, mutation = false, timeout = packet.limits.readMs, verifyInput } = {}) => {
    if (!mutation) spendRead(signal, "cloud");
    return scoped({ signal }, timeout, async (childSignal, remainingMs) => {
      await scoped({ signal: childSignal }, packet.limits.readMs, () => assertOwnership());
      if (verifyInput) await scoped({ signal: childSignal }, packet.limits.readMs, verifyInput);
      if (childSignal.aborted || poisoned) throw unsettledOperation();
      try {
        if (runCommand) return await runCommand(packet.artifacts.gcloud.path, args, { signal: childSignal, timeout: remainingMs, raw, env: environment });
        const { stdout } = await exec(packet.artifacts.gcloud.path, args, { signal: childSignal, timeout: remainingMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: environment });
        return raw ? stdout : JSON.parse(stdout);
      } catch { throw new Error("diagnostic_cloud_operation_failed"); }
    });
  };
  const regional = ["--project", TARGET.project, "--region", TARGET.region];
  const readJob = (signal) => command(["run", "jobs", "describe", TARGET.job, ...regional, "--format=json"], signal);
  const readService = (signal) => command(["run", "services", "describe", TARGET.service, ...regional, "--format=json"], signal);
  const readInventory = async (signal) => {
    const entries = await command(["run", "jobs", "executions", "list", "--job", TARGET.job, ...regional, "--limit=10000", "--format=json(metadata.name,metadata.labels,status.completionTime,status.runningCount)"], signal);
    if (!Array.isArray(entries) || entries.length >= 10000) reject();
    const ids = []; let active = 0;
    for (const item of entries) {
      const id = item?.metadata?.name;
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(id) || ids.includes(id) || item.metadata?.labels?.["run.googleapis.com/job"] !== TARGET.job || !item.status) reject();
      const running = item.status.runningCount ?? 0;
      if (!Number.isSafeInteger(running) || running < 0 || item.status.completionTime !== undefined && !Number.isFinite(Date.parse(item.status.completionTime))) reject();
      ids.push(id); if (!item.status.completionTime || running > 0) active += 1;
    }
    ids.sort(compareCodeUnits);
    return { ids, active };
  };
  const replace = async (prepareManifest, signal, recovery) => {
    if (manifests.length >= 2) reject();
    const evidence = { stage: recovery ? "restoration" : "candidate", validated: false, directoryCreated: false, fileCreated: false, verifiedBeforeCommand: false, cleanup: "not_created" };
    manifests.push(evidence); let file, failure;
    try {
      await scoped({ signal }, packet.limits.preparationMs, async (preparationSignal) => {
        const value = await prepareManifest(preparationSignal);
        file = await createManifest(value, packet, { signal: preparationSignal, deadlineAt: deadlines.get(signal), now, evidence });
        await scoped({ signal: preparationSignal }, packet.limits.readMs, () => beforeMutation(recovery));
      });
      await command(["run", "jobs", "replace", file.path, ...regional, "--quiet", "--format=json"], signal, {
        mutation: true, timeout: packet.limits.mutationMs,
        verifyInput: async () => { await file.verify(); evidence.verifiedBeforeCommand = true; },
      });
    } catch (error) { failure = error; }
    let removed = !file;
    if (file) { try { removed = await file.dispose(); } catch { removed = false; } }
    if (!removed || evidence.directoryCreated && evidence.cleanup !== "removed") {
      poisoned = true; throw unsettledOperation();
    }
    if (failure) throw failure;
  };
  const manifest = (raw, version) => {
    const value = structuredClone(raw);
    value.metadata = { name: TARGET.job, resourceVersion: version,
      labels: raw.metadata.labels ?? {}, annotations: { ...raw.metadata.annotations } };
    for (const key of ["run.googleapis.com/creator", "run.googleapis.com/lastModifier"]) delete value.metadata.annotations[key];
    delete value.status;
    return value;
  };
  const requireQuietFresh = async (signal, expectedVersion, configuration, ids) => {
    const o = await observe({ signal });
    if (o.job.resourceVersion !== expectedVersion || o.job.configuration !== configuration || digest(o.inventory) !== digest([...ids].sort(compareCodeUnits)) || o.activeExecutions !== 0 || o.activeQueues !== 0 || !o.controlsDisabled || o.snapshot !== packet.baseline.snapshot || o.account !== packet.baseline.account || o.controls !== packet.baseline.controls || o.egress !== packet.baseline.egress || digest(o.service) !== digest(packet.baseline.service)) reject();
    return o;
  };
  const verifyObservationPermissions = async (stable, signal) => {
    const bindings = stable.projectIamPolicy?.bindings;
    if (!Array.isArray(bindings)) reject();
    const roles = bindings.filter((binding) => binding.members?.includes(`serviceAccount:${EGRESS.serviceAccount}`));
    if (roles.length > 50) reject();
    const permissions = new Set();
    for (const binding of roles) {
      if (binding.condition || typeof binding.role !== "string" || !/^(roles\/|projects\/overdrafter-worker-9133\/roles\/)[A-Za-z0-9_.-]+$/.test(binding.role)) reject();
      const args = ["iam", "roles", "describe", binding.role, "--format=json(includedPermissions)"];
      if (binding.role.startsWith("projects/")) args.push("--project", TARGET.project);
      const role = await command(args, signal);
      if (!Array.isArray(role?.includedPermissions)) reject();
      for (const permission of role.includedPermissions) permissions.add(permission);
    }
    if (!permissions.has("run.jobs.get") || !permissions.has("run.executions.list")) reject();
  };
  const readEnvelope = async (signal) => {
    return scoped({ signal }, Math.min(packet.limits.observationMs, 120000), (envelopeSignal, remainingMs) => collectEnvelope({
        serviceRoleSecret: secret, overallTimeoutMs: Math.floor(remainingMs), requestTimeoutMs: Math.min(10000, packet.limits.readMs),
        createClientImpl: (url, key, options) => createClient(url, key, { ...options, global: { fetch: (url, init) => {
          spendRead(envelopeSignal, "http");
          const requestParent = AbortSignal.any([envelopeSignal, init?.signal].filter(Boolean));
          return scoped({ signal: requestParent, deadlineAt: deadlines.get(envelopeSignal) }, Math.min(10000, packet.limits.readMs), async (requestSignal) =>
            bufferedResponse(await fetchImpl(url, { ...init, signal: requestSignal })));
        } } }),
      }));
  };
  const observe = async (input) => scoped(input, packet.limits.observationMs, async (signal) => {
    if (++observations > packet.limits.maxObservations || observationReads) reject();
    observationReads = { cloud: 0, http: 0 };
    try {
      const startedAt = new Date(now()).toISOString();
      const stable = await collectEgress(EGRESS, { gcloudBin: packet.artifacts.gcloud.path, runCommand: (_, args) => command(args, signal) });
      const verdict = evaluateEgress(stable, EGRESS);
      const allowed = new Set(["service_job_image_mismatch", "nat_mapping_inventory_not_quiescent", "nat_mapping_inventory_multiple", "job_execution_inventory_not_quiescent"]);
      if (verdict.invalid !== false || !Array.isArray(verdict.failures) || verdict.failures.some((code) => !allowed.has(code))) reject();
      await verifyObservationPermissions(stable, signal);
      const job = await readJob(signal), service = await readService(signal);
      if (job.metadata?.resourceVersion !== stable.job?.metadata?.resourceVersion || service.metadata?.resourceVersion !== stable.service?.metadata?.resourceVersion) reject();
      const jobEnv = env(container(job, true)), serviceEnv = env(container(service, false));
      const scope = {
        bucket: jobEnv.XOMETRY_PROFILE_SNAPSHOT_BUCKET?.value,
        object: jobEnv.XOMETRY_PROFILE_SNAPSHOT_OBJECT?.value,
        maxBytes: jobEnv.XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES?.value,
      };
      if (typeof scope.bucket !== "string" || !/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(scope.bucket) || typeof scope.object !== "string" || scope.object.length === 0 || scope.object.length > 1024 || /[\r\n\0]/.test(scope.object) || !/^[1-9]\d{0,9}$/.test(scope.maxBytes)) reject();
      const principal = await command(["auth", "list", "--filter=status:ACTIVE", "--format=json(account,status)"], signal);
      if (!Array.isArray(principal) || principal.length !== 1 || principal[0].status !== "ACTIVE" || typeof principal[0].account !== "string") reject();
      const account = digest({ ...scope, principal: principal[0].account });
      if (account !== packet.baseline.account) reject();
      const secretRef = serviceEnv.SUPABASE_SERVICE_ROLE_KEY?.valueFrom?.secretKeyRef;
      if (secretRef?.name !== "supabase-service-role-key" || !["latest", packet.baseline.secretVersion].includes(secretRef.key) || jobEnv.SUPABASE_SERVICE_ROLE_KEY) reject();
      const version = await command(["secrets", "versions", "describe", secretRef.key, "--secret=supabase-service-role-key", "--project", TARGET.project, "--format=json(name,state)"], signal);
      if (version?.state !== "ENABLED" || version.name?.split("/").at(-1) !== packet.baseline.secretVersion) reject();
      if (!secret) {
        secret = await command(["secrets", "versions", "access", packet.baseline.secretVersion, "--secret=supabase-service-role-key", "--project", TARGET.project], signal, { raw: true });
        if (typeof secret !== "string" || !secret.trim() || /[\r\n]/.test(secret.trim())) reject();
        secret = secret.trim();
      }
      const envelope = await readEnvelope(signal);
      const snapshot = normalizedSnapshot(await command(["storage", "objects", "describe", `gs://${scope.bucket}/${scope.object}`, "--format=json(generation,metageneration,etag)"], signal));
      const executions = await readInventory(signal);
      const task = job.spec.template.spec.template.spec;
      const immutableEgress = Object.fromEntries(Object.entries(stable).filter(([key]) => !["job", "service", "confirmJob", "confirmService", "natMappings", "jobExecutions"].includes(key)));
      const value = {
        job: identify(job), service: identify(service), jobImage: container(job, true).image, serviceImage: container(service, false).image,
        serviceBuild: serviceEnv.WORKER_BUILD_VERSION?.value, snapshot: digest(snapshot), account, secretVersion: packet.baseline.secretVersion,
        controls: digest(envelope.controls), controlsDisabled: envelope.controls.length === 4 && envelope.controls.every((c) => c.enabled === false),
        activeQueues: envelope.workQueue.activeCount + envelope.quoteRequests.activeCount,
        inventory: executions.ids, activeExecutions: executions.active, natMappings: stable.natMappings.length, egress: digest(immutableEgress),
        resources: { cpu: task.containers[0].resources?.limits?.cpu, memory: task.containers[0].resources?.limits?.memory, taskSeconds: Number(task.timeoutSeconds), tasks: job.spec.template.spec.taskCount, parallelism: job.spec.template.spec.parallelism ?? 1, retries: task.maxRetries },
      };
      const confirmed = await readJob(signal), confirmedService = await readService(signal);
      if (digest(identify(confirmed)) !== digest(value.job) || digest(identify(confirmedService)) !== digest(value.service)) reject();
      if (!baselineJob && value.job.configuration === packet.baseline.job.configuration) baselineJob = structuredClone(job);
      value.startedAt = startedAt; value.completedAt = new Date(now()).toISOString();
      latest = { value, job, snapshot };
      return value;
    } finally { observationReads = null; }
  });
  const operations = {
    verifyBindings, observe,
    async replaceJob({ expectedResourceVersion, signal }) {
      if (replaced || !baselineJob) reject();
      replaced = true;
      await replace(async (preparationSignal) => {
        await requireQuietFresh(preparationSignal, expectedResourceVersion, packet.baseline.job.configuration, packet.baseline.inventory);
        const candidate = manifest(baselineJob, expectedResourceVersion); container(candidate, true).image = packet.image;
        if (identify(candidate).configuration !== packet.candidateConfiguration) reject();
        return candidate;
      }, signal, false);
      return identify(await readJob(signal));
    },
    async executeJob({ expectedJob, expectedInventory, signal }) {
      if (!replaced || dispatched) reject();
      try {
        let expression;
        await scoped({ signal }, packet.limits.preparationMs, async (preparationSignal) => {
          await requireQuietFresh(preparationSignal, expectedJob.resourceVersion, expectedJob.configuration, expectedInventory);
          if (latest.value.job.uid !== expectedJob.uid || latest.value.job.generation !== expectedJob.generation || latest.value.jobImage !== packet.image || latest.value.natMappings !== 0) reject();
          const moduleBytes = await readBoundFile(packet.artifacts.runtimeModule.path);
          if (createHash("sha256").update(moduleBytes).digest("hex") !== packet.artifacts.runtimeModule.sha256) reject();
          const expected = { project: TARGET.project, region: TARGET.region, job: TARGET.job, packetSha256: digest(packet), runtimeModuleSha256: packet.artifacts.runtimeModule.sha256, expiresAt: packet.expiresAt,
            snapshotFingerprint: digest(latest.snapshot), jobIdentity: { uid: expectedJob.uid, generation: expectedJob.generation, configurationFingerprint: expectedJob.configuration },
            executionInventory: { totalCount: expectedInventory.length, fingerprint: digest([...expectedInventory].sort(compareCodeUnits)) } };
          expression = `await import("data:text/javascript;base64,${moduleBytes.toString("base64")}")`;
          await scoped({ signal: preparationSignal }, packet.limits.readMs, () => beforeMutation(false));
          attemptedExpected = Buffer.from(JSON.stringify(expected)).toString("base64url");
          attemptedTask = structuredClone(latest.job.spec.template.spec.template.spec);
          attemptedTask.containers[0].args = ["--input-type=module", "-e", expression];
          if (env(attemptedTask.containers[0]).OVD419_EXPECTED_PRECONDITIONS_B64) reject();
          attemptedTask.containers[0].env.push({ name: "OVD419_EXPECTED_PRECONDITIONS_B64", value: attemptedExpected });
          attemptedAnnotations = structuredClone(latest.job.spec.template.metadata?.annotations ?? {});
        });
        if (signal.aborted || poisoned) throw unsettledOperation();
        dispatched = true;
        const execution = await command(["run", "jobs", "execute", TARGET.job, ...regional, "--wait", "--tasks=1", `--args=^~^--input-type=module~-e~${expression}`, `--update-env-vars=OVD419_EXPECTED_PRECONDITIONS_B64=${attemptedExpected}`, "--format=json"], signal, { mutation: true, timeout: packet.limits.executionMs });
        return { executionId: execution?.metadata?.name };
      } catch (error) {
        if (poisoned || error?.message === "diagnostic_operation_unsettled") throw unsettledOperation();
        // Only errors before invoking the command are provably not submitted.
        // A transport error after this point never asserts server rejection.
        if (!dispatched) return { submission: "not_submitted" };
        throw new Error("diagnostic_dispatch_acceptance_unknown");
      }
    },
    async inspectExecution({ executionId, signal }) {
      if (!dispatched || !attemptedTask || !/^[a-z][a-z0-9-]{0,62}$/.test(executionId)) reject();
      const execution = await command(["run", "jobs", "executions", "describe", executionId, ...regional, "--format=json"], signal);
      if (execution?.kind !== "Execution" || execution.apiVersion !== "run.googleapis.com/v1" || execution.metadata?.name !== executionId || !/^[A-Za-z0-9_-]{1,128}$/.test(execution.metadata?.uid) || execution.metadata?.labels?.["run.googleapis.com/job"] !== TARGET.job || execution.spec?.taskCount !== 1 || execution.spec?.parallelism !== 1 || execution.spec?.delayExecution === true) reject();
      const actualTask = normalizedTask(execution.spec?.template?.spec);
      if (digest(actualTask) !== digest(normalizedTask(attemptedTask)) || actualTask.containers[0].image !== packet.image || env(actualTask.containers[0]).OVD419_EXPECTED_PRECONDITIONS_B64?.value !== attemptedExpected) reject();
      for (const [key, value] of Object.entries(attemptedAnnotations)) if (execution.metadata?.annotations?.[key] !== value) reject();
      const provenanceAnnotations = new Set(["run.googleapis.com/creator", "run.googleapis.com/lastModifier", "run.googleapis.com/client-name", "run.googleapis.com/client-version", "run.googleapis.com/operation-id"]);
      if (Object.keys(execution.metadata?.annotations ?? {}).some((key) => !(key in attemptedAnnotations) && !provenanceAnnotations.has(key))) reject();
      const status = execution.status;
      if (!status || !Number.isSafeInteger(status.runningCount ?? 0) || (status.runningCount ?? 0) < 0) reject();
      const completedAt = status.completionTime === undefined ? null : new Date(status.completionTime).toISOString();
      const active = completedAt === null || (status.runningCount ?? 0) > 0;
      const createdAt = new Date(execution.metadata?.creationTimestamp).toISOString();
      const binding = { executionId, executionUid: execution.metadata.uid, packetSha256: digest(packet), runtimeModuleSha256: packet.artifacts.runtimeModule.sha256, image: actualTask.containers[0].image,
        jobConfigurationFingerprint: packet.candidateConfiguration, taskConfigurationFingerprint: digest(actualTask), createdAt, observedAt: new Date(now()).toISOString(), completedAt, active };
      if (attributedExecution && (attributedExecution.executionUid !== binding.executionUid || attributedExecution.executionId !== executionId || attributedExecution.taskConfigurationFingerprint !== binding.taskConfigurationFingerprint)) reject();
      attributedExecution = binding;
      return binding;
    },
    async readClassification({ executionId, signal }) {
      if (!dispatched || !/^[a-z][a-z0-9-]{0,62}$/.test(executionId)) reject();
      const entries = await command(["logging", "read", `resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="${executionId}"`, "--project", TARGET.project, "--limit=100", "--format=json(labels,resource,textPayload,jsonPayload)"], signal);
      return readFixedClassification(entries, executionId, attributedExecution);
    },
    async restoreJob({ expectedResourceVersion, expectedConfiguration, expectedInventory, signal }) {
      if (!baselineJob || restored) reject();
      restored = true;
      await replace(async (preparationSignal) => {
        await requireQuietFresh(preparationSignal, expectedResourceVersion, expectedConfiguration, expectedInventory);
        if (latest.value.job.uid !== packet.baseline.job.uid || latest.value.job.generation !== packet.baseline.job.generation + 1 || latest.value.jobImage !== packet.image || expectedConfiguration !== packet.candidateConfiguration) reject();
        return manifest(baselineJob, expectedResourceVersion);
      }, signal, true);
    },
  };
  return Object.freeze({
    verifyBindings, observe,
    manifestEvidence: () => manifests.map((entry) => ({ stage: entry.stage, validated: entry.validated === true,
      directoryCreated: entry.directoryCreated === true, fileCreated: entry.fileCreated === true,
      verifiedBeforeCommand: entry.verifiedBeforeCommand === true,
      cleanup: ["not_created", "removed"].includes(entry.cleanup) ? entry.cleanup : "unproved" })),
    replaceJob: (input) => scoped(input, stages.replaceMs, (signal) => operations.replaceJob({ ...input, signal })),
    executeJob: (input) => scoped(input, stages.executeMs, (signal) => operations.executeJob({ ...input, signal })),
    restoreJob: (input) => scoped(input, stages.restoreMs, (signal) => operations.restoreJob({ ...input, signal })),
    inspectExecution: (input) => scoped(input, packet.limits.readMs, (signal) => operations.inspectExecution({ ...input, signal })),
    readClassification: (input) => scoped(input, packet.limits.readMs, (signal) => operations.readClassification({ ...input, signal })),
  });
}
