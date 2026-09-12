// Synthetic in-memory fixtures only. No authority, lock, secret, or provider operation.
import { digest, approvalSentence, runDiagnostic, TARGET, PROPOSAL } from "./ovd419-job-diagnostic.mjs";
const H = "a".repeat(64);
const C = "b".repeat(40);
const BASE = `${TARGET.repository}@sha256:3dd67a3ce58817417d94da3b580c1eb99cdfdf9aa9d9ed2317c535ad69bf0daf`;
const IMAGE = `${TARGET.repository}@sha256:c22a51beb8207f8ddf9448f5a0fbe0a0cc6e27474dc63b16c577c6f3a5413722`;
export const NOW = Date.parse("2026-09-10T16:00:00.000Z");

export function packet() {
  return {
    schema: "ovd419-job-diagnostic-v2", evidencePath: "/fixture/TEST-ONLY-evidence.jsonl", proposalSha256: PROPOSAL, candidateConfiguration: digest({ candidate: true }),
    ownerTask: TARGET.ownerTask, sourceCommit: C, target: TARGET,
    image: IMAGE, baselineImage: BASE, baselineBuild: "25452595367f81d7b46bda960020ecd6aefb153e",
    attempts: 1, retries: 0, dependencyRiskAccepted: true,
    expiresAt: "2026-09-10T16:30:00.000Z",
    limits: { cpu: "2", memory: "4Gi", taskSeconds: 600, readMs: 30000,
      mutationMs: 600000, executionMs: 900000, preflightMs: 300000,
      recoveryMs: 3035000, pollMs: 30000, maxReads: 500, observationMs: 120000, preparationMs: 150000, maxObservations: 100 },
    baseline: { job: { uid: "job-uid", generation: 1, resourceVersion: "j1", configuration: H },
      service: { uid: "service-uid", generation: 2, resourceVersion: "s1", configuration: H },
      snapshot: H, account: H, secretVersion: "1", inventory: ["old-execution"],
      controls: H, egress: H },
    artifacts: Object.fromEntries(["proposal", "bundle", "controller", "launcher", "runtimeModule", "resultReader", "node", "gcloud", "rootLock", "workerLock", "python", "audit"].map((key) => [key, { path: `/fixture/${key}`, sha256: key === "proposal" ? PROPOSAL : H }])),
    trees: Object.fromEntries(["scripts", "dependencies", "gcloud", "python"].map((key) => [key, { path: `/fixture/${key}`, sha256: key === "proposal" ? PROPOSAL : H }])),
  };
}

export function observation(p, phase = "baseline", ids = p.baseline.inventory) {
  return {
    startedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString(),
    job: { ...p.baseline.job }, service: { ...p.baseline.service },
    jobImage: phase === "candidate" ? p.image : p.baselineImage,
    serviceImage: p.baselineImage, serviceBuild: p.baselineBuild,
    snapshot: p.baseline.snapshot, account: p.baseline.account,
    secretVersion: p.baseline.secretVersion, controls: p.baseline.controls,
    egress: p.baseline.egress, activeQueues: 0, controlsDisabled: true,
    activeExecutions: 0, natMappings: 0, inventory: [...ids],
    resources: { cpu: p.limits.cpu, memory: p.limits.memory, taskSeconds: p.limits.taskSeconds, tasks: 1, parallelism: 1, retries: 0 },
  };
}

export function harness(reason = "login_required") {
  const p = packet();
  let current = observation(p);
  let consumed = false;
  let owned = false;
  const calls = [];
  const candidate = { uid: "job-uid", generation: 2, resourceVersion: "j2", configuration: digest({ candidate: true }) };
  const gate = {
    async acquire() { if (owned) { throw new Error("busy"); }
      owned = true; calls.push("acquire"); },
    async assert() { if (!owned) throw new Error("lost"); },
    async consume() { if (consumed) { throw new Error("replay"); }
      consumed = true; calls.push("consume"); },
    async release() { owned = false; calls.push("release"); },
  };
  const ops = {
    async persist() { calls.push("persist"); },
    async verifyBindings() { calls.push("bindings"); },
    async observe() { return structuredClone(current); },
    async replaceJob({ expectedResourceVersion }) {
      if (expectedResourceVersion !== current.job.resourceVersion) throw new Error("fixture stale version");
      calls.push("replace"); current = observation(p, "candidate"); current.job = candidate;
      return structuredClone(candidate);
    },
    async executeJob() {
      calls.push("execute"); current.inventory = [...p.baseline.inventory, "new-execution"];
      return { executionId: "new-execution" };
    },
    async inspectExecution({ executionId }) {
      if (executionId !== "new-execution") throw new Error("TEST ONLY foreign execution");
      return { executionId, executionUid: "new-execution-uid", packetSha256: digest(p), image: p.image, runtimeModuleSha256: p.artifacts.runtimeModule.sha256,
        jobConfigurationFingerprint: p.candidateConfiguration, taskConfigurationFingerprint: H, createdAt: new Date(NOW).toISOString(), observedAt: new Date(NOW).toISOString(), active: current.activeExecutions === 1, completedAt: current.activeExecutions === 1 ? null : new Date(NOW).toISOString() };
    },
    async readClassification({ executionId }) {
      return { executionId, executionUid: "new-execution-uid", packetSha256: digest(p), runtimeModuleSha256: p.artifacts.runtimeModule.sha256, reason, authenticated: reason === "authenticated_dashboard" };
    },
    async restoreJob() {
      calls.push("restore"); const ids = current.inventory;
      current = observation(p, "baseline", ids); current.job.generation = 3; current.job.resourceVersion = "j3";
    },
  };
  const approval = { packetSha256: digest(p), issuedAt: "2026-09-10T16:00:00.000Z", expiresAt: p.expiresAt, ownerTask: TARGET.ownerTask,
    transcript: { role: "user", threadId: TARGET.ownerTask, timestamp: "2026-09-10T16:00:00.000Z", text: approvalSentence(p), prefixSha256: H } };
  return { p, ops, gate, calls, approval, current: () => current,
    run: () => runDiagnostic({ packet: p, approval, operations: ops, admission: gate, now: () => NOW, wait: async () => {}, interrupted: () => false }) };
}


/** Complete synthetic, credential-free Job shape for strict manifest tests. */
export function manifestFixture(p) {
  return { apiVersion: "run.googleapis.com/v1", kind: "Job", metadata: { name: TARGET.job, resourceVersion: "j1", labels: {}, annotations: {} },
    spec: { template: { metadata: { annotations: { "run.googleapis.com/network-interfaces": JSON.stringify([{ network: "overdrafter-xometry-egress", subnetwork: "overdrafter-xometry-egress-us-west1" }]), "run.googleapis.com/vpc-access-egress": "all-traffic" } }, spec: { taskCount: 1, parallelism: 1, template: { spec: { maxRetries: 0, timeoutSeconds: String(p.limits.taskSeconds), serviceAccountName: "overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com", containers: [{ image: p.baselineImage, command: ["node"], args: ["dist/tools/probeXometryProfileAuth.js"], resources: { limits: { cpu: p.limits.cpu, memory: p.limits.memory } }, env: [
      { name: "WORKER_MODE", value: "simulate" }, { name: "WORKER_TEMP_DIR", value: "/root/.cache/overdrafter-worker" }, { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
      { name: "PLAYWRIGHT_HEADLESS", value: "true" }, { name: "PLAYWRIGHT_BROWSER_TIMEOUT_MS", value: "45000" }, { name: "PLAYWRIGHT_DISABLE_SANDBOX", value: "true" }, { name: "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", value: "true" },
      { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: "fixture-bucket" }, { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: "fixture/profile.tar.gz" }, { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "1000" },
    ] }] } } } } } };
}
