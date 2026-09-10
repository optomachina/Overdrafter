import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createDiagnosticAdapter, readFixedClassification } from "./ovd419-diagnostic-adapter.mjs";
import { packet, NOW } from "./ovd419-diagnostic-test-fixtures.mjs";
import { digest, approvalSentence, runDiagnostic, TARGET } from "./ovd419-job-diagnostic.mjs";

const principal = "synthetic-operator@example.invalid";
function log(reason = "login_required", executionId = "test-execution") {
  return { labels: { "run.googleapis.com/execution_name": executionId }, resource: { type: "cloud_run_job", labels: { job_name: TARGET.job, project_id: TARGET.project, location: TARGET.region } },
    jsonPayload: { reason: "ovd419_guard_failed", stage: "probe_result", probeReason: reason } };
}
function identity(raw) { return { uid: raw.metadata.uid, generation: raw.metadata.generation, resourceVersion: raw.metadata.resourceVersion, configuration: digest({ name: raw.metadata.name, spec: raw.spec }) }; }

async function fixture() {
  const p = packet();
  p.artifacts.runtimeModule.path = await realpath(path.resolve("scripts/ovd419-diagnostic-runtime.mjs"));
  p.artifacts.runtimeModule.sha256 = createHash("sha256").update(await readFile(p.artifacts.runtimeModule.path)).digest("hex");
  let job = { apiVersion: "run.googleapis.com/v1", kind: "Job", metadata: { name: TARGET.job, uid: "job-uid", generation: 1, resourceVersion: "j1" },
    spec: { template: { spec: { taskCount: 1, parallelism: 1, template: { spec: { maxRetries: 0, timeoutSeconds: "600", serviceAccountName: "fixture-runner", containers: [{ image: p.baselineImage, command: ["node"], args: ["dist/tools/probeXometryProfileAuth.js"], resources: { limits: { cpu: "2", memory: "4Gi" } }, env: [
      { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: "fixture-bucket" }, { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: "fixture/profile.tar.gz" }, { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "1000" },
    ] }] } } } } } };
  const originalJob = structuredClone(job);
  const service = { metadata: { name: TARGET.service, uid: "service-uid", generation: 2, resourceVersion: "s1" }, spec: { template: { spec: { containers: [{ image: p.baselineImage, env: [
    { name: "WORKER_BUILD_VERSION", value: p.baselineBuild }, { name: "SUPABASE_SERVICE_ROLE_KEY", valueFrom: { secretKeyRef: { name: "supabase-service-role-key", key: "latest" } } },
  ] }] } } } };
  const controls = ["automatic_quote_collection", "commercial_admin_mutations", "order_administration", "promotion_codes"].map((key) => ({ key, enabled: false }));
  const snapshot = { generation: "1", metageneration: "1", etag: "test-etag" };
  const staticEgress = { projectIamPolicy: { bindings: [{ role: "roles/run.viewer", members: ["serviceAccount:overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com"] }] } };
  p.baseline = { ...p.baseline, job: identity(job), service: identity(service), snapshot: digest(snapshot), account: digest({ bucket: "fixture-bucket", object: "fixture/profile.tar.gz", maxBytes: "1000", principal }), controls: digest(controls), egress: digest(staticEgress) };
  const candidate = structuredClone(job); candidate.spec.template.spec.template.spec.containers[0].image = p.image;
  p.candidateConfiguration = identity(candidate).configuration;
  let ids = [...p.baseline.inventory], replacements = 0, dispatches = 0, owned = false, consumed = false;
  const calls = [], mutations = [];
  let dispatchFailure = false, versionDrift = false, missingPermission = false;
  const runCommand = async (_, args) => {
    calls.push(args);
    if (args[0] === "iam") return { includedPermissions: missingPermission ? [] : ["run.jobs.get", "run.executions.list"] };
    if (args[0] === "auth") return [{ account: principal, status: "ACTIVE" }];
    if (args[0] === "secrets") {
      if (args[2] === "describe") return { name: `projects/123/secrets/supabase-service-role-key/versions/${versionDrift ? "2" : "1"}`, state: "ENABLED" };
      return "sb_secret_TEST_ONLY_NOT_A_REAL_SECRET";
    }
    if (args[0] === "storage") return snapshot;
    if (args[0] === "logging") return [log()];
    if (args[0] !== "run") throw Error("unexpected fixture command");
    if (args[1] === "services") { if (args[2] !== "describe") throw Error("SERVICE WRITE FORBIDDEN"); return structuredClone(service); }
    if (args[2] === "describe") return structuredClone(job);
    if (args[2] === "executions") return ids.map((id) => ({ metadata: { name: id, labels: { "run.googleapis.com/job": TARGET.job } }, status: { completionTime: "2026-09-10T16:01:00Z", runningCount: 0 } }));
    if (args[2] === "replace") {
      replacements += 1; mutations.push(args);
      const next = JSON.parse(await readFile(args[3], "utf8"));
      expect(next.metadata.resourceVersion).toBe(job.metadata.resourceVersion);
      next.metadata.uid = job.metadata.uid; next.metadata.generation = job.metadata.generation + 1; next.metadata.resourceVersion = `j${next.metadata.generation}`;
      job = next; return {};
    }
    if (args[2] === "execute") {
      dispatches += 1; mutations.push(args); ids.push("test-execution");
      if (dispatchFailure) throw Error("TEST ONLY ambiguous response");
      return { metadata: { name: "test-execution" } };
    }
    throw Error("unexpected fixture command");
  };
  const gate = {
    async acquire() { if (owned) throw Error("busy"); owned = true; },
    async assert() { if (!owned) throw Error("not owned"); },
    async consume() { if (consumed) throw Error("replay"); consumed = true; },
    async release() { owned = false; },
  };
  const ops = createDiagnosticAdapter(p, { verifyBindings: async () => {}, assertOwnership: () => gate.assert(), beforeMutation: async () => gate.assert(), runCommand,
    collectEgress: async () => ({ ...staticEgress, job: structuredClone(job), service: structuredClone(service), natMappings: [] }),
    evaluateEgress: () => ({ invalid: false, failures: [] }),
    collectEnvelope: async () => ({ controls, workQueue: { activeCount: 0 }, quoteRequests: { activeCount: 0 } }),
  });
  const approval = { packetSha256: digest(p), issuedAt: new Date(NOW).toISOString(), expiresAt: p.expiresAt, ownerTask: TARGET.ownerTask,
    transcript: { role: "user", threadId: TARGET.ownerTask, timestamp: new Date(NOW).toISOString(), text: approvalSentence(p), prefixSha256: "a".repeat(64) } };
  return { p, calls, mutations, ops, gate, originalJob, state: () => ({ job, service, replacements, dispatches, owned }),
    ambiguous: () => { dispatchFailure = true; }, drift: () => { versionDrift = true; }, missingPermission: () => { missingPermission = true; },
    run: () => runDiagnostic({ packet: p, approval, operations: { ...ops, persist: async () => {} }, admission: gate, now: () => NOW, wait: async () => {}, interrupted: () => false }) };
}

describe("Job-only adapter with synthetic command transport", () => {
  it.each([false, true])("restores the original full Job spec with ambiguous dispatch=%s", async (ambiguous) => {
    const f = await fixture(); if (ambiguous) f.ambiguous();
    const result = await f.run();
    expect(result.status).toBe("diagnostic_succeeded"); expect(result.reason).toBe("login_required");
    expect(f.state().replacements).toBe(2); expect(f.state().dispatches).toBe(1);
    expect(f.state().job.spec).toEqual(f.originalJob.spec); expect(f.state().owned).toBe(false);
    expect(f.mutations.every((args) => args[1] === "jobs")).toBe(true);
    const dispatch = f.mutations.find((args) => args[2] === "execute");
    expect(dispatch).toContain("--tasks=1"); expect(dispatch.some((arg) => arg.startsWith("--image"))).toBe(false);
    const expected = JSON.parse(Buffer.from(dispatch.find((arg) => arg.startsWith("--update-env-vars=")).split("=").slice(2).join("="), "base64url").toString());
    expect(expected.packetSha256).toBe(digest(f.p)); expect(expected.expiresAt).toBe(f.p.expiresAt);
    expect(expected.jobIdentity.configurationFingerprint).toBe(f.p.candidateConfiguration);
  });
  it("secret-version drift rejects before any secret retrieval or mutation", async () => {
    const f = await fixture(); f.drift(); await expect(f.run()).rejects.toThrow();
    expect(f.mutations).toEqual([]);
    expect(f.calls.some((args) => args[0] === "secrets" && args[2] === "access")).toBe(false);
  });
  it("missing guard permissions reject before mutation", async () => {
    const f = await fixture(); f.missingPermission(); await expect(f.run()).rejects.toThrow(); expect(f.mutations).toEqual([]);
  });
});

describe("fixed result reader", () => {
  it.each(["captcha", "login_required", "anonymous_quote_home", "provider_error", "authenticated_dashboard_not_confirmed"])("captures unsuccessful %s", (reason) => {
    expect(readFixedClassification([log(reason)], "test-execution")).toEqual({ executionId: "test-execution", reason, authenticated: false });
  });
  it("projects authenticated success without raw fields", () => {
    const entry = log(); entry.jsonPayload = { reason: "authenticated_dashboard", authenticated: true, preconditionsEnforcedBeforeBrowserNetworkActivation: true, cookie: "private" };
    expect(readFixedClassification([entry], "test-execution")).toEqual({ executionId: "test-execution", reason: "authenticated_dashboard", authenticated: true });
  });
  it.each([[], [log(), log()], [log("unrecognized")], [log("captcha", "other-execution")]])("rejects absent, repeated, unknown, or foreign evidence", (entries) => {
    expect(() => readFixedClassification(entries, "test-execution")).toThrow();
  });
  it("rejects saturated logs and non-probe guard failure", () => {
    expect(() => readFixedClassification(Array(100).fill(log()), "test-execution")).toThrow();
    const entry = log(); entry.jsonPayload.stage = "job_generation";
    expect(() => readFixedClassification([entry], "test-execution")).toThrow();
  });
});
