import { createHash } from "node:crypto";
import { diagnosticStageLimits, runWithinBudget } from "./ovd419-diagnostic-budget.mjs";

export const PROPOSAL = "7ab0649abe5fef7ac4ce4b6dfd5a0d205872b542169c1ae908b8911763ecf0b7";
export const TARGET = Object.freeze({
  project: "overdrafter-worker-9133", region: "us-west1",
  job: "overdrafter-xometry-auth-probe", service: "overdrafter-cad-worker",
  repository: "us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/overdrafter-cad-worker",
  ownerTask: "01a07d04-7c70-7260-a383-d5d4e21018e9",
});
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const REASONS = new Set(["authenticated_dashboard", "captcha", "login_required", "anonymous_quote_home", "provider_error", "authenticated_dashboard_not_confirmed"]);
const ROLES = ["proposal", "bundle", "controller", "launcher", "runtimeModule", "resultReader", "node", "gcloud", "rootLock", "workerLock", "python", "audit"];

/** Stable JSON digest for immutable, JSON-only contract values. */
export function digest(value) {
  const canonical = (v) => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(canonical);
    if (v && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
    }
    throw new Error("diagnostic_invalid_json");
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function fail() { throw new Error("diagnostic_contract_rejected"); }
function requireValue(value) { if (!value) fail(); }
function keys(value, names) {
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype);
  requireValue(Object.keys(value).sort().join("|") === [...names].sort().join("|"));
}
function integer(value, min, max) { requireValue(Number.isSafeInteger(value) && value >= min && value <= max); }
function timestamp(value) {
  const n = Date.parse(value);
  requireValue(Number.isFinite(n) && new Date(n).toISOString() === value);
  return n;
}
function identity(value) {
  keys(value, ["uid", "generation", "resourceVersion", "configuration"]);
  requireValue(TOKEN.test(value.uid) && typeof value.resourceVersion === "string" && /^[A-Za-z0-9+/_=-]{1,256}$/.test(value.resourceVersion) && HASH.test(value.configuration));
  integer(value.generation, 1, Number.MAX_SAFE_INTEGER - 2);
}
function inventory(ids) {
  requireValue(Array.isArray(ids) && ids.length < 10000 && ids.every((id) => /^[a-z][a-z0-9-]{0,62}$/.test(id)) && new Set(ids).size === ids.length);
  return [...ids].sort();
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Require every future operational fact explicitly; there are no production defaults. */
export function validatePacket(packet, now) {
  keys(packet, ["schema", "proposalSha256", "ownerTask", "sourceCommit", "target", "image", "baselineImage", "baselineBuild", "attempts", "retries", "dependencyRiskAccepted", "expiresAt", "limits", "baseline", "artifacts", "trees", "candidateConfiguration", "evidencePath"]);
  requireValue(packet.schema === "ovd419-job-diagnostic-v2" && packet.proposalSha256 === PROPOSAL && packet.ownerTask === TARGET.ownerTask && digest(packet.target) === digest(TARGET));
  requireValue(SHA.test(packet.sourceCommit) && SHA.test(packet.baselineBuild) && HASH.test(packet.candidateConfiguration));
  for (const image of [packet.image, packet.baselineImage]) requireValue(typeof image === "string" && image.startsWith(`${TARGET.repository}@sha256:`) && HASH.test(image.slice(`${TARGET.repository}@sha256:`.length)));
  requireValue(packet.image === `${TARGET.repository}@sha256:c22a51beb8207f8ddf9448f5a0fbe0a0cc6e27474dc63b16c577c6f3a5413722` && packet.baselineImage === `${TARGET.repository}@sha256:3dd67a3ce58817417d94da3b580c1eb99cdfdf9aa9d9ed2317c535ad69bf0daf` && packet.baselineBuild === "25452595367f81d7b46bda960020ecd6aefb153e" && packet.attempts === 1 && packet.retries === 0 && packet.dependencyRiskAccepted === true);
  requireValue(Number.isFinite(now) && timestamp(packet.expiresAt) > now);
  requireValue(typeof packet.evidencePath === "string" && packet.evidencePath.startsWith("/") && packet.evidencePath.endsWith(".jsonl") && !packet.evidencePath.includes("\0"));
  keys(packet.limits, ["cpu", "memory", "taskSeconds", "readMs", "mutationMs", "executionMs", "preflightMs", "recoveryMs", "pollMs", "maxReads", "observationMs", "preparationMs", "maxObservations"]);
  requireValue(typeof packet.limits.cpu === "string" && /^(1|2|4|8)$/.test(packet.limits.cpu));
  requireValue(typeof packet.limits.memory === "string" && /^([1-9]|[12][0-9]|3[0-2])Gi$/.test(packet.limits.memory));
  integer(packet.limits.taskSeconds, 1, 900);
  integer(packet.limits.readMs, 1, 30000); integer(packet.limits.mutationMs, 1, 600000);
  integer(packet.limits.executionMs, packet.limits.taskSeconds * 1000, 900000);
  integer(packet.limits.preflightMs, 1, 300000); integer(packet.limits.recoveryMs, 1, 3035000);
  integer(packet.limits.pollMs, 1, 30000); integer(packet.limits.maxReads, 1, 10000);
  integer(packet.limits.observationMs, packet.limits.readMs, 300000);
  integer(packet.limits.preparationMs, packet.limits.observationMs, 300000);
  integer(packet.limits.maxObservations, 1, 1000);
  keys(packet.baseline, ["job", "service", "snapshot", "account", "secretVersion", "inventory", "controls", "egress"]);
  identity(packet.baseline.job); identity(packet.baseline.service);
  for (const field of ["snapshot", "account", "controls", "egress"]) requireValue(HASH.test(packet.baseline[field]));
  requireValue(/^[1-9]\d{0,18}$/.test(packet.baseline.secretVersion)); inventory(packet.baseline.inventory);
  keys(packet.artifacts, ROLES); keys(packet.trees, ["scripts", "dependencies", "gcloud", "python"]);
  for (const artifact of [...Object.values(packet.artifacts), ...Object.values(packet.trees)]) {
    keys(artifact, ["path", "sha256"]);
    requireValue(typeof artifact.path === "string" && artifact.path.startsWith("/") && !artifact.path.includes("\0") && HASH.test(artifact.sha256));
  }
  requireValue(packet.artifacts.proposal.sha256 === PROPOSAL);
  return freeze(structuredClone(packet));
}

/** Exact future action-time sentence; generic approval never matches this action. */
export function approvalSentence(packet) {
  return `I, Blaine Wilson, approve one OVD-419 Job-only authentication diagnostic under packet ${digest(packet)} and proposal ${PROPOSAL}, owned by ${TARGET.ownerTask}, in ${TARGET.project}/${TARGET.region}, expiring ${packet.expiresAt}; zero retries, unchanged Service, automatic Job restoration, and the disclosed dependency risk and bounded costs accepted.`;
}

/** Validate already acquired direct-user transcript provenance, never a caller boolean. */
export function validateApproval(approval, packet, now) {
  keys(approval, ["packetSha256", "issuedAt", "expiresAt", "ownerTask", "transcript"]);
  keys(approval.transcript, ["role", "threadId", "timestamp", "text", "prefixSha256"]);
  const issued = timestamp(approval.issuedAt), expires = timestamp(approval.expiresAt);
  requireValue(approval.packetSha256 === digest(packet) && approval.ownerTask === TARGET.ownerTask && approval.expiresAt === packet.expiresAt);
  requireValue(issued <= now && expires > now && expires - issued <= 30 * 60000 && expires > issued);
  requireValue(approval.transcript.role === "user" && approval.transcript.threadId === TARGET.ownerTask && approval.transcript.timestamp === approval.issuedAt && approval.transcript.text === approvalSentence(packet) && HASH.test(approval.transcript.prefixSha256));
  return digest({ packet: approval.packetSha256, transcript: approval.transcript.prefixSha256, issuedAt: approval.issuedAt });
}

/** Project a fixed classification before any persistence; never return source payloads. */
export function projectClassification(value) {
  if (!value || !REASONS.has(value.reason) || typeof value.authenticated !== "boolean" || value.authenticated !== (value.reason === "authenticated_dashboard")) return null;
  return Object.freeze({ reason: value.reason, authenticated: value.authenticated });
}

function stable(observed, p) {
  requireValue(observed && observed.serviceImage === p.baselineImage && observed.serviceBuild === p.baselineBuild);
  requireValue(digest(observed.service) === digest(p.baseline.service));
  for (const key of ["snapshot", "account", "secretVersion", "controls", "egress"]) requireValue(observed[key] === p.baseline[key]);
  requireValue(observed.activeQueues === 0 && observed.controlsDisabled === true);
  requireValue(digest(observed.resources) === digest({ cpu: p.limits.cpu, memory: p.limits.memory, taskSeconds: p.limits.taskSeconds, tasks: 1, parallelism: 1, retries: 0 }));
  identity(observed.job); inventory(observed.inventory);
  integer(observed.activeExecutions, 0, 1); integer(observed.natMappings, 0, Number.MAX_SAFE_INTEGER);
}
function sameDesiredJob(actual, expected) {
  return actual.uid === expected.uid && actual.generation === expected.generation && actual.configuration === expected.configuration;
}
function baseline(observed, p, initial) {
  stable(observed, p);
  requireValue(observed.jobImage === p.baselineImage && observed.job.uid === p.baseline.job.uid && observed.job.configuration === p.baseline.job.configuration);
  requireValue(observed.activeExecutions === 0 && observed.natMappings === 0);
  if (initial) requireValue(digest(observed.job) === digest(p.baseline.job) && digest(inventory(observed.inventory)) === digest(inventory(p.baseline.inventory)));
}

/**
 * Run one bounded Job lifecycle through explicit capabilities. There are no default
 * I/O, credential, authority-store, Service-write, or network implementations here.
 * A timed-out capability is unresolved: retain ownership and never race a rollback.
 */
export async function runDiagnostic({ packet, approval, operations, admission, now, wait, interrupted }) {
  const p = validatePacket(packet, now());
  const a = freeze(structuredClone(approval));
  const approvalId = validateApproval(a, p, now());
  for (const name of ["verifyBindings", "observe", "replaceJob", "executeJob", "inspectExecution", "readClassification", "restoreJob", "persist"]) requireValue(typeof operations?.[name] === "function");
  for (const name of ["acquire", "assert", "consume", "release"]) requireValue(typeof admission?.[name] === "function");
  requireValue(typeof wait === "function" && typeof interrupted === "function");
  let owned = false, mutated = false, dispatched = false, unsettled = false;
  let replacementAccepted = false;
  let candidate, result = null, executionId = null, observations = 0, lastNow = now();
  let submission = "not_attempted", executionAttribution = null;
  let initialObservation = null, lastObservation = null, finalObservation = null;
  const clock = () => { const n = now(); requireValue(Number.isFinite(n) && n >= lastNow); lastNow = n; return n; };
  const deadline = Math.min(clock() + p.limits.preflightMs, timestamp(p.expiresAt));
  let phaseDeadline = deadline;
  const stages = diagnosticStageLimits(p.limits);
  const startedAt = new Date(lastNow).toISOString();
  const bounded = async (fn, ms) => {
    try {
      return await runWithinBudget(fn, { timeoutMs: ms, deadlineAt: phaseDeadline, now: clock,
        onUnsettled: () => { unsettled = true; } });
    } catch (error) {
      if (error?.message === "diagnostic_operation_unsettled") unsettled = true;
      throw error;
    }
  };
  const check = async (recovery = false) => {
    await bounded(() => admission.assert(), p.limits.readMs);
    await bounded(() => operations.verifyBindings(), p.limits.readMs);
    if (!recovery) { validateApproval(a, p, clock()); requireValue(!interrupted()); }
  };
  const observe = async () => {
    requireValue(++observations <= p.limits.maxObservations);
    const requestedAt = clock();
    const value = structuredClone(await bounded((signal) => operations.observe({ signal, deadlineAt: phaseDeadline }), p.limits.observationMs));
    requireValue(timestamp(value.startedAt) >= requestedAt && timestamp(value.completedAt) >= timestamp(value.startedAt) && timestamp(value.completedAt) <= clock());
    return value;
  };
  const summarize = (o) => freeze({
    startedAt: o.startedAt, completedAt: o.completedAt,
    activeQueues: o.activeQueues, activeExecutions: o.activeExecutions,
    natMappings: o.natMappings, executionCount: o.inventory.length,
    inventoryFingerprint: digest(inventory(o.inventory)), snapshotFingerprint: o.snapshot,
    jobConfigurationFingerprint: o.job.configuration, serviceConfigurationFingerprint: o.service.configuration,
    jobIdentity: { ...o.job }, serviceIdentity: { ...o.service },
    controlsFingerprint: o.controls, egressFingerprint: o.egress,
  });
  const attribute = async (id, recoveryDeadline) => {
    const value = await bounded((signal) => operations.inspectExecution({ executionId: id, signal }), Math.min(p.limits.readMs, recoveryDeadline - clock()));
    keys(value, ["executionId", "executionUid", "packetSha256", "image", "runtimeModuleSha256", "jobConfigurationFingerprint", "taskConfigurationFingerprint", "createdAt", "observedAt", "completedAt", "active"]);
    requireValue(value.executionId === id && typeof value.executionUid === "string" && TOKEN.test(value.executionUid) && value.packetSha256 === digest(p) && value.image === p.image && value.runtimeModuleSha256 === p.artifacts.runtimeModule.sha256 && value.jobConfigurationFingerprint === p.candidateConfiguration && HASH.test(value.taskConfigurationFingerprint));
    requireValue(timestamp(value.createdAt) >= timestamp(a.issuedAt) && timestamp(value.createdAt) < timestamp(p.expiresAt) && timestamp(value.createdAt) <= timestamp(value.observedAt) && timestamp(value.observedAt) <= clock());
    requireValue(typeof value.active === "boolean");
    if (value.completedAt !== null) requireValue(timestamp(value.completedAt) >= timestamp(value.createdAt) && timestamp(value.completedAt) <= timestamp(value.observedAt));
    if (!value.active) requireValue(value.completedAt !== null);
    if (executionAttribution) {
      for (const key of ["executionId", "executionUid", "taskConfigurationFingerprint", "createdAt"]) requireValue(value[key] === executionAttribution[key]);
    }
    executionAttribution = freeze(structuredClone(value)); executionId = id; submission = "accepted_bound_execution";
  };
  const added = (o) => {
    const before = inventory(p.baseline.inventory), after = inventory(o.inventory);
    requireValue(before.every((id) => after.includes(id)));
    const extra = after.filter((id) => !before.includes(id));
    requireValue(extra.length <= (dispatched ? 1 : 0));
    if (executionId) requireValue(extra.length === 1 && extra[0] === executionId);
    return extra;
  };
  const receipt = (status, containment) => freeze({
    schema: "ovd419-job-diagnostic-result-v3", status, containment,
    packetSha256: digest(p), reason: result?.reason ?? "inconclusive",
    authenticated: result?.authenticated ?? false, executionId,
    startedAt, completedAt: new Date(clock()).toISOString(), submission,
    initialObservation, lastObservation, finalObservation, executionAttribution,
    temporaryManifests: operations.manifestEvidence?.() ?? [],
    attempts: Number(dispatched), retryAuthorized: false, releaseQualified: false,
    serviceMutationPerformed: false, uploadPerformed: false, quoteRequested: false, orderActionPerformed: false,
  });
  try {
    await bounded(() => operations.verifyBindings(), p.limits.readMs);
    requireValue(!interrupted() && clock() < deadline);
    await bounded(() => admission.acquire(), p.limits.readMs); owned = true;
    await check(); const before = await observe(); baseline(before, p, true);
    initialObservation = summarize(before); lastObservation = initialObservation;
    requireValue(clock() < deadline);
    await bounded(() => admission.consume(approvalId), p.limits.readMs);
    await check(); const immediatelyBefore = await observe(); baseline(immediatelyBefore, p, true);
    requireValue(clock() < deadline);
    validateApproval(a, p, clock()); requireValue(!interrupted());
    phaseDeadline = timestamp(p.expiresAt);
    mutated = true; // The request may mutate even if its response is lost.
    candidate = structuredClone(await bounded((signal) => operations.replaceJob({ expectedResourceVersion: immediatelyBefore.job.resourceVersion, signal, deadlineAt: phaseDeadline }), stages.replaceMs));
    identity(candidate);
    requireValue(candidate.uid === p.baseline.job.uid && candidate.generation === p.baseline.job.generation + 1 && candidate.configuration === p.candidateConfiguration);
    replacementAccepted = true;
    await check(); const ready = await observe(); stable(ready, p);
    requireValue(ready.jobImage === p.image && sameDesiredJob(ready.job, candidate) && ready.activeExecutions === 0 && ready.natMappings === 0 && added(ready).length === 0);
    await check();
    dispatched = true; submission = "acceptance_unknown"; // Invocation is never retried.
    try {
      const value = await bounded((signal) => operations.executeJob({ expectedJob: ready.job, expectedInventory: p.baseline.inventory, signal, deadlineAt: phaseDeadline }), stages.executeMs);
      if (value?.submission === "not_submitted" && Object.keys(value).length === 1) submission = "not_submitted";
      else if (value?.executionId) { inventory([value.executionId]); executionId = value.executionId; }
    } catch { /* Inventory observation below is the only allowed disambiguation. */ }
  } catch {
    if (!mutated) {
      if (owned && !unsettled) await bounded(() => admission.release(), p.limits.readMs);
      throw new Error("diagnostic_rejected_before_mutation");
    }
  }
  if (unsettled) return receipt("containment_unproved", "unproved");
  const recoveryDeadline = clock() + p.limits.recoveryMs;
  phaseDeadline = recoveryDeadline;
  const maxPolls = Math.ceil(p.limits.recoveryMs / p.limits.pollMs) + 1;
  let restored = false;
  try {
    for (let poll = 0; poll < maxPolls && clock() < recoveryDeadline; poll += 1) {
      await check(true); const observed = await observe(); stable(observed, p);
      lastObservation = summarize(observed);
      const extra = added(observed);
      if (extra.length === 1) {
        requireValue(dispatched && submission !== "not_submitted");
        await attribute(extra[0], recoveryDeadline);
        if (observed.activeExecutions === 1 && !executionAttribution.active) {
          // Completion between sequential inventory and detail reads is legitimate.
          // Refresh the whole observation before using it to authorize restoration.
          await bounded(() => wait(p.limits.pollMs), Math.min(p.limits.pollMs + 1000, recoveryDeadline - clock()));
          continue;
        }
        requireValue(executionAttribution.active === (observed.activeExecutions === 1));
      } else if (submission === "acceptance_unknown") {
        // Absence from a possibly delayed inventory is not proof of server rejection.
        await bounded(() => wait(p.limits.pollMs), Math.min(p.limits.pollMs + 1000, recoveryDeadline - clock()));
        continue;
      }
      requireValue(observed.job.uid === p.baseline.job.uid);
      const atBaseline = observed.job.configuration === p.baseline.job.configuration && observed.jobImage === p.baselineImage;
      const atCandidate = observed.job.configuration === p.candidateConfiguration && observed.jobImage === p.image && observed.job.generation === p.baseline.job.generation + 1;
      requireValue(atBaseline || atCandidate);
      if (atCandidate) replacementAccepted = true;
      if (!replacementAccepted) {
        // An old Job observation cannot settle a replacement whose reply was lost.
        // Await the exact candidate under the existing recovery budget; never retry.
        await bounded(() => wait(p.limits.pollMs), Math.min(p.limits.pollMs + 1000, recoveryDeadline - clock()));
        continue;
      }
      if (observed.activeExecutions !== 0) {
        requireValue(dispatched && extra.length === 1);
        await bounded(() => wait(p.limits.pollMs), Math.min(p.limits.pollMs + 1000, recoveryDeadline - clock())); continue;
      }
      if (!restored) {
        if (executionId && !interrupted()) {
          try {
            const raw = await bounded((signal) => operations.readClassification({ executionId, signal }), Math.min(p.limits.readMs, recoveryDeadline - clock()));
            if (raw?.executionId === executionId && raw?.executionUid === executionAttribution?.executionUid && raw?.packetSha256 === digest(p) && raw?.runtimeModuleSha256 === p.artifacts.runtimeModule.sha256) result = projectClassification(raw);
          } catch { result = null; }
        }
        if (unsettled) return receipt("containment_unproved", "unproved");
        await check(true);
        if (!atBaseline) await bounded((signal) => operations.restoreJob({ expectedResourceVersion: observed.job.resourceVersion, expectedConfiguration: observed.job.configuration, expectedInventory: observed.inventory, signal, deadlineAt: phaseDeadline }), stages.restoreMs);
        restored = true;
        continue;
      }
      if (observed.natMappings === 0) {
        baseline(observed, p, false);
        requireValue(atBaseline && (observed.job.generation === p.baseline.job.generation || observed.job.generation === p.baseline.job.generation + 2));
        finalObservation = summarize(observed);
        const terminal = receipt(result ? "diagnostic_succeeded" : "inconclusive", "baseline_restored");
        await bounded(() => operations.persist({ ...terminal, evidenceStage: "before_owner_release" }), p.limits.readMs);
        try {
          await bounded(() => admission.release(), p.limits.readMs);
        } catch {
          await bounded(() => operations.persist({ schema: "ovd419-job-diagnostic-owner-v1", packetSha256: digest(p), ownerRelease: "unproved", retryAuthorized: false }), p.limits.readMs);
          return receipt("containment_unproved", "unproved");
        }
        try {
          await bounded(() => operations.persist({ schema: "ovd419-job-diagnostic-owner-v1", packetSha256: digest(p), ownerRelease: "released", retryAuthorized: false }), p.limits.readMs);
        } catch {
          return receipt("owner_receipt_unwritten", "baseline_restored");
        }
        return terminal;
      }
      await bounded(() => wait(p.limits.pollMs), Math.min(p.limits.pollMs + 1000, recoveryDeadline - clock()));
    }
  } catch { /* Preserve the owner sentinel; do not repeat a failed restoration. */ }
  return receipt("containment_unproved", "unproved");
}
