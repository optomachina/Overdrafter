import { createHash } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { readFile, realpath, writeFile, chmod, stat, rm } from "node:fs/promises";
import path from "node:path";
import { createPrivateManifest } from "./ovd419-diagnostic-manifest.mjs";
import { collectOperationalEnvelope } from "./collect-ovd410-operational-envelope.mjs";
import { createDiagnosticAdapter, readFixedClassification } from "./ovd419-diagnostic-adapter.mjs";
import { packet, manifestFixture, NOW } from "./ovd419-diagnostic-test-fixtures.mjs";
import { digest, approvalSentence, runDiagnostic, TARGET } from "./ovd419-job-diagnostic.mjs";

const TEST_BINDING = { executionId: "test-execution", executionUid: "test-execution-uid", packetSha256: "a".repeat(64), runtimeModuleSha256: "b".repeat(64) };
const principal = "synthetic-operator@example.invalid";
function log(reason = "login_required", executionId = "test-execution", binding = TEST_BINDING) {
  return { labels: { "run.googleapis.com/execution_name": executionId }, resource: { type: "cloud_run_job", labels: { job_name: TARGET.job, project_id: TARGET.project, location: TARGET.region } },
    jsonPayload: { reason: "ovd419_guard_failed", stage: "probe_result", probeReason: reason, ...binding, executionId } };
}
function identity(raw) { return { uid: raw.metadata.uid, generation: raw.metadata.generation, resourceVersion: raw.metadata.resourceVersion, configuration: digest({ name: raw.metadata.name, spec: raw.spec }) }; }

afterEach(() => vi.useRealTimers());

async function fixture(options = {}) {
  const p = packet();
  Object.assign(p.limits, options.limits);
  p.artifacts.runtimeModule.path = await realpath(path.resolve("scripts/ovd419-diagnostic-runtime.mjs"));
  p.artifacts.runtimeModule.sha256 = createHash("sha256").update(await readFile(p.artifacts.runtimeModule.path)).digest("hex");
  let job = manifestFixture(p);
  Object.assign(job.metadata, { uid: "job-uid", generation: 1, resourceVersion: "j1" });
  options.mutateJob?.(job);
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
  const calls = [], mutations = [], commandOptions = [];
  let dispatchFailure = false, versionDrift = false, missingPermission = false, preDispatchRejection = false;
  let executionResource, mutateExecution = () => {}, resultBinding = null, visibilityDelay = 0, inventoryReadsAfterDispatch = 0;
  const runCommand = async (_, args, commandInput) => {
    commandOptions.push(commandInput);
    await options.beforeCommand?.(args, commandInput);
    calls.push(args);
    if (args[0] === "iam") return { includedPermissions: missingPermission ? [] : ["run.jobs.get", "run.executions.list"] };
    if (args[0] === "auth") return [{ account: principal, status: "ACTIVE" }];
    if (args[0] === "secrets") {
      if (args[2] === "describe") return { name: `projects/123/secrets/supabase-service-role-key/versions/${versionDrift ? "2" : "1"}`, state: "ENABLED" };
      return "sb_secret_TEST_ONLY_NOT_A_REAL_SECRET";
    }
    if (args[0] === "storage") return snapshot;
    if (args[0] === "logging") return [log("login_required", "test-execution", resultBinding ?? { ...TEST_BINDING, packetSha256: digest(p), runtimeModuleSha256: p.artifacts.runtimeModule.sha256 })];
    if (args[0] !== "run") throw Error("unexpected fixture command");
    if (args[1] === "services") { if (args[2] !== "describe") throw Error("SERVICE WRITE FORBIDDEN"); return structuredClone(service); }
    if (args[2] === "describe") return structuredClone(job);
    if (args[2] === "executions" && args[3] === "describe") {
      const value = structuredClone(executionResource); mutateExecution(value); return value;
    }
    if (args[2] === "executions") {
      if (dispatches && visibilityDelay && ++inventoryReadsAfterDispatch === visibilityDelay) ids.push("test-execution");
      return ids.map((id) => ({ metadata: { name: id, labels: { "run.googleapis.com/job": TARGET.job } }, status: { completionTime: "2026-09-10T16:01:00Z", runningCount: 0 } }));
    }
    if (args[2] === "replace") {
      replacements += 1; mutations.push(args);
      const next = JSON.parse(await readFile(args[3], "utf8"));
      expect(next.metadata.resourceVersion).toBe(job.metadata.resourceVersion);
      next.metadata.uid = job.metadata.uid; next.metadata.generation = job.metadata.generation + 1; next.metadata.resourceVersion = `j${next.metadata.generation}`;
      job = next; return {};
    }
    if (args[2] === "execute") {
      dispatches += 1; mutations.push(args);
      if (!visibilityDelay) ids.push("test-execution");
      const task = structuredClone(job.spec.template.spec.template.spec);
      task.containers[0].args = args.find((arg) => arg.startsWith("--args=")).slice("--args=^~^".length).split("~");
      task.containers[0].env.push({ name: "OVD419_EXPECTED_PRECONDITIONS_B64", value: args.find((arg) => arg.startsWith("--update-env-vars=")).slice("--update-env-vars=OVD419_EXPECTED_PRECONDITIONS_B64=".length) });
      executionResource = { apiVersion: "run.googleapis.com/v1", kind: "Execution", metadata: { name: "test-execution", uid: "test-execution-uid", creationTimestamp: new Date(NOW).toISOString(), labels: { "run.googleapis.com/job": TARGET.job }, annotations: structuredClone(job.spec.template.metadata.annotations) }, spec: { taskCount: 1, parallelism: 1, template: { spec: task } }, status: { completionTime: new Date(NOW).toISOString(), runningCount: 0 } };
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
  const ops = createDiagnosticAdapter(p, { createManifest: async (...args) => { const file = await createPrivateManifest(...args); options.manifestCreated?.(file.path); return file; }, verifyBindings: async () => {}, assertOwnership: () => gate.assert(), beforeMutation: async (recovery) => { await options.beforeMutation?.(recovery); await gate.assert(); if (!recovery && replacements === 1 && preDispatchRejection) throw Error("TEST ONLY rejected before command"); }, runCommand, now: () => NOW,
    collectEgress: async (_, transport) => {
      for (let i = 0; i < (options.egressReads ?? 0); i += 1) await transport.runCommand("TEST ONLY", ["auth", "list"]);
      return { ...staticEgress, job: structuredClone(job), service: structuredClone(service), natMappings: [] };
    },
    evaluateEgress: () => ({ invalid: false, failures: [] }),
    collectEnvelope: options.collectEnvelope ?? (async () => ({ controls, workQueue: { activeCount: 0 }, quoteRequests: { activeCount: 0 } })),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const approval = { packetSha256: digest(p), issuedAt: new Date(NOW).toISOString(), expiresAt: p.expiresAt, ownerTask: TARGET.ownerTask,
    transcript: { role: "user", threadId: TARGET.ownerTask, timestamp: new Date(NOW).toISOString(), text: approvalSentence(p), prefixSha256: "a".repeat(64) } };
  return { p, calls, mutations, commandOptions, ops, gate, originalJob, state: () => ({ job, service, replacements, dispatches, owned }),
    ambiguous: () => { dispatchFailure = true; }, rejectBeforeDispatch: () => { preDispatchRejection = true; }, mutateExecution: (fn) => { mutateExecution = fn; }, delayed: (count) => { visibilityDelay = count; dispatchFailure = true; }, wrongResult: (binding) => { resultBinding = binding; }, drift: () => { versionDrift = true; }, missingPermission: () => { missingPermission = true; },
    run: () => runDiagnostic({ packet: p, approval, operations: { ...ops, persist: async () => {} }, admission: gate, now: () => NOW, wait: async () => {}, interrupted: () => false }) };
}

describe("Job-only adapter with synthetic command transport", () => {
  it("disables Python bytecode creation in every production child environment", async () => {
    const f = await fixture(); await f.run();
    expect(f.commandOptions.length).toBeGreaterThan(0);
    for (const { env } of f.commandOptions) {
      expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
      expect(env.PYTHONNOUSERSITE).toBe("1");
      expect(env.CLOUDSDK_PYTHON).toBe(f.p.artifacts.python.path);
    }
  });
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
  it.each([
    ["foreign image", (e) => { e.spec.template.spec.containers[0].image = "foreign-image"; }],
    ["different module", (e) => { e.spec.template.spec.containers[0].args[2] = "foreign-module"; }],
    ["different packet overrides", (e) => { e.spec.template.spec.containers[0].env.find((v) => v.name === "OVD419_EXPECTED_PRECONDITIONS_B64").value = "foreign-packet"; }],
    ["different resources", (e) => { e.spec.template.spec.containers[0].resources.limits.cpu = "4"; }],
    ["missing UID", (e) => { delete e.metadata.uid; }],
    ["wrong Job", (e) => { e.metadata.labels["run.googleapis.com/job"] = "foreign-job"; }],
    ["extra environment", (e) => { e.spec.template.spec.containers[0].env.push({ name: "UNAPPROVED", value: "TEST ONLY" }); }],
    ["extra execution routing", (e) => { e.metadata.annotations["run.googleapis.com/vpc-access-connector"] = "foreign-connector"; }],
    ["inconsistent active state", (e) => { delete e.status.completionTime; e.status.runningCount = 1; }],
  ])("rejects singleton %s after a lost response", async (_, mutate) => {
    const f = await fixture(); f.ambiguous(); f.mutateExecution(mutate);
    expect((await f.run()).status).toBe("containment_unproved");
    expect(f.state().replacements).toBe(1); expect(f.state().dispatches).toBe(1); expect(f.state().owned).toBe(true);
  });
  it("holds while inventory is empty, then attributes the delayed exact Execution", async () => {
    const f = await fixture(); f.delayed(3);
    expect((await f.run()).status).toBe("diagnostic_succeeded");
    expect(f.state().dispatches).toBe(1); expect(f.state().replacements).toBe(2);
  });
  it("empty inventory beyond the bound never proves rejection", async () => {
    const f = await fixture(); f.delayed(10000);
    expect((await f.run()).status).toBe("containment_unproved");
    expect(f.state().dispatches).toBe(1); expect(f.state().replacements).toBe(1); expect(f.state().owned).toBe(true);
  });
  it("proves a local pre-submission failure without claiming a rejected cloud request", async () => {
    const f = await fixture(); f.rejectBeforeDispatch(); const result = await f.run();
    expect(result.status).toBe("inconclusive"); expect(result.submission).toBe("not_submitted");
    expect(f.state().dispatches).toBe(0); expect(f.state().replacements).toBe(2); expect(f.state().owned).toBe(false);
  });
  it("a wrong packet in the result cannot qualify an otherwise matching Execution", async () => {
    const f = await fixture(); f.wrongResult(TEST_BINDING);
    expect((await f.run()).status).toBe("inconclusive");
    expect(f.state().dispatches).toBe(1); expect(f.state().replacements).toBe(2);
  });
});

describe("fixed result reader", () => {
  it.each(["captcha", "login_required", "anonymous_quote_home", "provider_error", "authenticated_dashboard_not_confirmed"])("captures unsuccessful %s", (reason) => {
    expect(readFixedClassification([log(reason)], "test-execution", TEST_BINDING)).toEqual({ ...TEST_BINDING, reason, authenticated: false });
  });
  it("projects authenticated success without raw fields", () => {
    const entry = log(); entry.jsonPayload = { reason: "authenticated_dashboard", authenticated: true, preconditionsEnforcedBeforeBrowserNetworkActivation: true, cookie: "private", ...TEST_BINDING };
    expect(readFixedClassification([entry], "test-execution", TEST_BINDING)).toEqual({ ...TEST_BINDING, reason: "authenticated_dashboard", authenticated: true });
  });
  it.each([[], [log(), log()], [log("unrecognized")], [log("captcha", "other-execution")]])("rejects absent, repeated, unknown, or foreign evidence", (entries) => {
    expect(() => readFixedClassification(entries, "test-execution", TEST_BINDING)).toThrow();
  });
  it("rejects saturated logs and non-probe guard failure", () => {
    expect(() => readFixedClassification(Array(100).fill(log()), "test-execution", TEST_BINDING)).toThrow();
    const entry = log(); entry.jsonPayload.stage = "job_generation";
    expect(() => readFixedClassification([entry], "test-execution", TEST_BINDING)).toThrow();
  });
  it.each(["executionId", "executionUid", "packetSha256", "runtimeModuleSha256"])("requires matching %s inside the result, separately from logging labels", (key) => {
    const entry = log(); delete entry.jsonPayload[key];
    expect(() => readFixedClassification([entry], "test-execution", TEST_BINDING)).toThrow();
    entry.jsonPayload[key] = "wrong";
    expect(() => readFixedClassification([entry], "test-execution", TEST_BINDING)).toThrow();
  });
});


describe("adapter nested read and preparation budgets", () => {
  it("counts the complete cloud sequence including all repeated preparations", async () => {
    const f = await fixture({ egressReads: 18 }); await f.run();
    // Eight full observations; one IAM role; one secret access; post-replace read,
    // two Execution attributions and one log read. Three mutations are separate.
    expect(f.calls).toHaveLength(224);
    expect(f.mutations).toHaveLength(3);
    expect(f.calls.filter((c) => c[0] === "secrets" && c[2] === "access")).toHaveLength(1);
  });
  it("slow individually valid reads complete within the aggregate observation budget", async () => {
    const f = await fixture({ egressReads: 18, limits: { readMs: 50, observationMs: 1000, preparationMs: 1100 }, beforeCommand: async () => new Promise((r) => setTimeout(r, 5)) });
    vi.useFakeTimers(); await f.gate.acquire(); const pending = f.ops.observe({});
    await vi.runAllTimersAsync(); const observed = await pending;
    expect(observed.activeQueues).toBe(0); expect(f.calls).toHaveLength(28);
  });
  it("a hung subread aborts before the whole observation budget and prevents late follow-up", async () => {
    const f = await fixture({ limits: { readMs: 20, observationMs: 100, preparationMs: 150 }, beforeCommand: async () => new Promise(() => {}) });
    vi.useFakeTimers(); await f.gate.acquire();
    const pending = f.ops.observe({}).catch((e) => e.message); await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBe("diagnostic_operation_unsettled"); expect(f.commandOptions).toHaveLength(1);
    expect(f.commandOptions[0].signal.aborted).toBe(true);
    await expect(f.ops.observe({})).rejects.toThrow("diagnostic_operation_unsettled"); expect(f.mutations).toEqual([]);
  });
  it("exhausting the aggregate observation stops before another read", async () => {
    const f = await fixture({ egressReads: 18, limits: { readMs: 50, observationMs: 70, preparationMs: 100 }, beforeCommand: async () => new Promise((r) => setTimeout(r, 40)) });
    vi.useFakeTimers(); await f.gate.acquire(); const pending = f.ops.observe({}).catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(70); expect(await pending).toBe("diagnostic_operation_unsettled");
    expect(f.commandOptions).toHaveLength(2); await vi.advanceTimersByTimeAsync(100); expect(f.commandOptions).toHaveLength(2);
  });
  it("counts nested fresh observations against one adapter-wide cap", async () => {
    const f = await fixture({ limits: { maxObservations: 2 } });
    expect((await f.run()).status).toBe("containment_unproved"); expect(f.mutations).toHaveLength(0);
  });
  it("caps commands globally without resetting the budget for each observation", async () => {
    const f = await fixture({ egressReads: 18, limits: { maxReads: 30 } });
    await expect(f.run()).rejects.toThrow(); expect(f.calls).toHaveLength(30); expect(f.mutations).toHaveLength(0);
  });
  it("a hung repeated beforeMutation check cannot dispatch or race restoration", async () => {
    let checks = 0;
    const f = await fixture({ limits: { readMs: 100, observationMs: 1000, preparationMs: 1500 }, beforeMutation: async () => { if (++checks === 2) return new Promise(() => {}); } });
    const running = f.run(); // Real temporary-file I/O must settle before fake timers.
    const result = await running;
    expect(result.status).toBe("containment_unproved"); expect(f.state().dispatches).toBe(0); expect(f.state().replacements).toBe(1); expect(f.state().owned).toBe(true);
  });
});


describe("HTTP reads participate in the same finite budget", () => {
  it("includes response-body stalls in the per-read timeout even if the RPC hides the error", async () => {
    let requestSignal;
    const f = await fixture({ limits: { readMs: 20, observationMs: 100, preparationMs: 150 }, collectEnvelope: collectOperationalEnvelope,
      fetchImpl: async (_, init) => { requestSignal = init.signal; return new Response(new ReadableStream({ start() {} }), { status: 200 }); } });
    vi.useFakeTimers(); await f.gate.acquire(); const pending = f.ops.observe({}).catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(20); expect(await pending).toBe("diagnostic_operation_unsettled"); expect(requestSignal.aborted).toBe(true);
    await expect(f.ops.observe({})).rejects.toThrow("diagnostic_operation_unsettled"); expect(f.mutations).toEqual([]);
  });
  it("counts every actual HTTP request toward the shared read cap", async () => {
    let requests = 0;
    const f = await fixture({ limits: { maxReads: 7 }, collectEnvelope: collectOperationalEnvelope,
      fetchImpl: async () => { requests += 1; return new Response(JSON.stringify({ controls: ["automatic_quote_collection", "commercial_admin_mutations", "order_administration", "promotion_codes"].map((capability) => ({ capability, enabled: false })) }), { status: 200, headers: { "Content-Type": "application/json" } }); } });
    await f.gate.acquire(); await expect(f.ops.observe({})).rejects.toThrow();
    // Six cloud reads before the envelope, then one RPC. The next HTTP read is denied.
    expect(f.calls).toHaveLength(6); expect(requests).toBe(1); expect(f.mutations).toEqual([]);
  });
});


describe("complete operational-envelope transport", () => {
  it("counts all eleven real collector requests for empty queues", async () => {
    const requests = [];
    const f = await fixture({ egressReads: 18, collectEnvelope: collectOperationalEnvelope,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), method: init.method });
        if (String(url).includes("/rpc/")) return new Response(JSON.stringify({ controls: ["automatic_quote_collection", "commercial_admin_mutations", "order_administration", "promotion_codes"].map((capability) => ({ capability, enabled: false })) }), { status: 200, headers: { "Content-Type": "application/json" } });
        const body = init.method === "HEAD" ? null : "[]";
        return new Response(body, { status: 200, headers: { "Content-Range": "*/0", "Content-Type": "application/json" } });
      } });
    await f.gate.acquire(); const observation = await f.ops.observe({});
    expect(observation.activeQueues).toBe(0); expect(f.calls).toHaveLength(28); expect(requests).toHaveLength(11);
    expect(requests.filter((r) => r.method === "HEAD")).toHaveLength(2);
  });
});


describe("temporary manifest command boundary", () => {
  it("records both verified files removed before releasing ownership", async () => {
    const f = await fixture(); const result = await f.run();
    expect(result.status).toBe("diagnostic_succeeded"); expect(result.temporaryManifests).toHaveLength(2);
    for (const record of result.temporaryManifests) expect(record).toMatchObject({ validated: true, directoryCreated: true, fileCreated: true, verifiedBeforeCommand: true, cleanup: "removed" });
    expect(JSON.stringify(result.temporaryManifests)).not.toContain("fixture-bucket");
  });
  it("rejects bytes changed during beforeMutation and records cleanup", async () => {
    let file;
    const f = await fixture({ manifestCreated: (p) => { file = p; }, beforeMutation: async () => writeFile(file, "TEST_ONLY_REPLACEMENT") });
    const result = await f.run();
    expect(f.mutations).toHaveLength(0); expect(result.temporaryManifests[0]).toMatchObject({ verifiedBeforeCommand: false, cleanup: "removed" });
  });
  it("retains ownership if private-directory substitution prevents safe cleanup", async () => {
    let file;
    const f = await fixture({ manifestCreated: (p) => { file = p; }, beforeMutation: async () => chmod(path.dirname(file), 0o755) });
    try {
      const result = await f.run(); expect(result.status).toBe("containment_unproved"); expect(f.state().owned).toBe(true);
      expect(f.mutations).toHaveLength(0); expect(result.temporaryManifests[0].cleanup).toBe("unproved");
      expect((await stat(path.dirname(file))).isDirectory()).toBe(true);
    } finally { if (file) await rm(path.dirname(file), { recursive: true, force: true }); }
  });
});


describe("manifest admission adversarial regressions", () => {
  it("rejects an unknown nested field before persistence even with matching bindings", async () => {
    let files = 0;
    const f = await fixture({ mutateJob: (job) => { job.spec.template.spec.template.spec.containers[0].env[0].TEST_ONLY_TOKEN = "TEST_ONLY_NOT_A_REAL_SECRET"; }, manifestCreated: () => { files += 1; } });
    await f.run(); expect(f.mutations).toHaveLength(0); expect(files).toBe(0);
  });
  it("cleans the restoration file after a local restoration check fails", async () => {
    const f = await fixture({ beforeMutation: async (recovery) => { if (recovery) throw Error("TEST_ONLY_RESTORATION_CHECK_FAILURE"); } });
    const result = await f.run(); expect(result.status).toBe("containment_unproved");
    expect(f.state().dispatches).toBe(1); expect(f.state().replacements).toBe(1); expect(f.state().owned).toBe(true);
    expect(result.temporaryManifests[1]).toMatchObject({ stage: "restoration", fileCreated: true, verifiedBeforeCommand: false, cleanup: "removed" });
  });
});
