// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEngineeringInboxFixturePlan } from "./engineering-inbox-fixture-plan.mjs";
import { createEngineeringInboxFixtureApplication } from "./engineering-inbox-fixture-application.mjs";

const uuid = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-7${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const ids = { network: "a".repeat(64), database: "b".repeat(64), postgrest: "c".repeat(64) };
const manifest = { organizationId: uuid("3"), projectId: uuid("4"), conversationId: uuid("5"),
  inputSnapshotId: uuid("6"), idempotencyKey: uuid("7"), expectedRevision: 4,
  body: "Set depth to 8 mm", expectedMessageId: uuid("8"), expectedRequestId: uuid("9") };
function fixture() {
  const plan = createEngineeringInboxFixturePlan({ sourceRevision: "d".repeat(40), ownerTaskId: uuid("1"), runId: uuid("2"),
    databaseImage: `sha256:${"3".repeat(64)}`, postgrestImage: `sha256:${"4".repeat(64)}`,
    migrations: [{ path: "supabase/migrations/20260910045917_engineering_durable_inbox.sql", sha256: "5".repeat(64) }] });
  let time = 1;
  const next = () => time++;
  const resources = new Map();
  const calls = [];
  const lifecycleAdapter = {
    inventory: vi.fn(() => ({ completedAtMs: next(), resources: [], settled: true })),
    create: vi.fn((spec) => { calls.push(`create:${spec.labels.role}`); const resource = { ...structuredClone(spec), id: ids[spec.labels.role] };
      resources.set(resource.id, resource); return { completedAtMs: next(), id: resource.id, settled: true }; }),
    inspect: vi.fn((id) => ({ completedAtMs: next(), resource: resources.get(id) ?? null, settled: true })),
    remove: vi.fn((id) => { calls.push(`remove:${resources.get(id)?.labels.role}`); resources.delete(id);
      return { completedAtMs: next(), removed: true, settled: true }; }),
  };
  const bootstrapAdapter = {
    prerequisites: vi.fn((request) => ({ ...structuredClone(request), databaseReady: true, postgrestReady: true,
      completedAtMs: next(), settled: true })),
    migration: vi.fn((request) => ({ applied: true, completedAtMs: next(), index: request.index, path: request.path,
      previousSha256: request.previousSha256, settled: true, sha256: request.sha256 })),
    suite: vi.fn((request) => ({ ...structuredClone(request), outcome: "passed", completedAtMs: next(), settled: true })),
  };
  const transport = {
    readiness: vi.fn((request) => { calls.push("readiness"); return { completedAtMs: next(), settled: true, status: 200,
      body: { ready: true, sourceRevision: request.sourceRevision, databaseResourceId: request.databaseResourceId,
        postgrestResourceId: request.postgrestResourceId } }; }),
    request: vi.fn((request) => { calls.push("request"); return { completedAtMs: next(), settled: true, status: 200,
      body: { conversationId: request.body.p_conversation_id, inputSnapshotId: request.body.p_input_snapshot_id,
        messageId: manifest.expectedMessageId, requestId: manifest.expectedRequestId,
        revision: request.body.p_expected_revision + 1 } }; }),
  };
  return { plan, lifecycleAdapter, bootstrapAdapter, transport, resources, calls,
    advanceTo: (value) => { time = value; } };
}
function create(value = fixture(), overrides = {}) {
  return createEngineeringInboxFixtureApplication({ plan: value.plan, lifecycleAdapter: value.lifecycleAdapter,
    bootstrapAdapter: value.bootstrapAdapter, transport: value.transport, manifest, ...overrides });
}

describe("engineering inbox fixture application composition", () => {
  it("checks readiness and one exact RPC receipt before cleanup and emits value-free success", () => {
    const value = fixture();
    const receipt = create(value).run();
    expect(receipt).toMatchObject({ status: "passed", readinessStatus: "passed", applicationStatus: "recorded",
      applicationFailure: null, cleanupStatus: "cleanup_complete", qualification: "source_contract_only" });
    expect(value.calls).toEqual(["create:network", "create:database", "create:postgrest", "readiness", "request",
      "remove:postgrest", "remove:database", "remove:network"]);
    expect(value.transport.request.mock.calls[0][0]).toEqual({ kind: "engineering_inbox_rpc", method: "POST",
      path: "/rest/v1/rpc/api_submit_engineering_message", body: { p_organization_id: manifest.organizationId,
        p_project_id: manifest.projectId, p_conversation_id: manifest.conversationId,
        p_input_snapshot_id: manifest.inputSnapshotId, p_expected_revision: 4,
        p_idempotency_key: manifest.idempotencyKey, p_body: manifest.body } });
    const serialized = JSON.stringify(receipt);
    for (const value of Object.values(manifest)) if (typeof value === "string") expect(serialized).not.toContain(value);
    expect(receipt).not.toHaveProperty("identity");
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("pins and freezes the validated manifest before caller mutation", () => {
    const value = fixture();
    const mutable = { ...manifest };
    const composition = create(value, { manifest: mutable });
    mutable.body = "";
    mutable.expectedRequestId = mutable.expectedMessageId;
    const receipt = composition.run();
    expect(receipt.status).toBe("passed");
    expect(value.transport.request.mock.calls[0][0].body.p_body).toBe(manifest.body);
  });

  it("does not let a transport callback change the pinned expected revision", () => {
    const value = fixture();
    const mutable = { ...manifest };
    const normal = value.transport.request.getMockImplementation();
    value.transport.request.mockImplementationOnce((request) => {
      mutable.expectedRevision = 5;
      return normal(request);
    });
    const receipt = create(value, { manifest: mutable }).run();
    expect(receipt.status).toBe("passed");
    expect(value.transport.request.mock.calls[0][0].body.p_expected_revision).toBe(4);
  });

  it("omits lifecycle UUIDs even when a manifest identity overlaps them", () => {
    const value = fixture();
    const overlap = { ...manifest, organizationId: value.plan.identity.ownerTaskId };
    const receipt = create(value, { manifest: overlap }).run();
    expect(receipt.status).toBe("passed");
    expect(JSON.stringify(receipt)).not.toContain(overlap.organizationId);
    expect(receipt).not.toHaveProperty("identity");
  });

  it("stops before submit when readiness identity is wrong and still cleans", () => {
    const value = fixture();
    const normal = value.transport.readiness.getMockImplementation();
    value.transport.readiness.mockImplementationOnce((request) => {
      const result = normal(request);
      return { ...result, body: { ...result.body, sourceRevision: "e".repeat(40) } };
    });
    const receipt = create(value).run();
    expect(receipt).toMatchObject({ status: "failed", applicationFailure: "readiness_mismatch",
      applicationStatus: "not_run", cleanupStatus: "cleanup_complete" });
    expect(value.transport.request).not.toHaveBeenCalled();
  });

  it.each([
    ["conversation", (body) => { body.conversationId = manifest.projectId; }],
    ["snapshot", (body) => { body.inputSnapshotId = manifest.projectId; }],
    ["message", (body) => { body.messageId = manifest.projectId; }],
    ["request", (body) => { body.requestId = manifest.projectId; }],
    ["revision", (body) => { body.revision = 6; }],
    ["extra", (body) => { body.executed = true; }],
  ])("keeps a mismatched %s receipt delivery-unknown without retry", (_label, mutate) => {
    const value = fixture();
    const normal = value.transport.request.getMockImplementation();
    value.transport.request.mockImplementationOnce((request) => { const result = normal(request); mutate(result.body); return result; });
    const receipt = create(value).run();
    expect(receipt).toMatchObject({ status: "failed", applicationFailure: "application_delivery_unknown",
      applicationStatus: "delivery_unknown", cleanupStatus: "cleanup_complete" });
    expect(value.transport.request).toHaveBeenCalledTimes(1);
  });

  it.each([409, 400, 500])("does not assert write absence for HTTP-like status %i", (status) => {
    const value = fixture();
    value.transport.request.mockImplementationOnce(() => ({ body: { code: "private", message: "canary" },
      completedAtMs: 11, settled: true, status }));
    const receipt = create(value).run();
    expect(receipt.applicationFailure).toBe("application_delivery_unknown");
    expect(receipt.applicationStatus).toBe("delivery_unknown");
    expect(receipt).not.toHaveProperty("writeAbsent");
    expect(JSON.stringify(receipt)).not.toMatch(/private|canary/);
  });

  it("contains thrown transport errors, performs no retry, and cleans", () => {
    const value = fixture();
    value.transport.request.mockImplementationOnce(() => { throw new Error("transport canary"); });
    const receipt = create(value).run();
    expect(receipt).toMatchObject({ status: "failed", applicationFailure: "application_adapter_error",
      applicationStatus: "delivery_unknown", cleanupStatus: "cleanup_complete" });
    expect(value.transport.request).toHaveBeenCalledTimes(1);
    expect(value.resources.size).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain("transport canary");
  });

  it("consumes ordinary rejected transport Promises without an unhandled event", async () => {
    const value = fixture();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      value.transport.readiness.mockImplementationOnce(() => Promise.reject(new Error("promise canary")));
      const receipt = create(value).run();
      await new Promise((resolve) => setImmediate(resolve));
      expect(receipt).toMatchObject({ applicationFailure: "readiness_unsettled_or_late", cleanupStatus: "cleanup_complete" });
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("rejects transport proxies before invoking traps", () => {
    const value = fixture();
    const trapped = vi.fn();
    value.transport.readiness = () => new Proxy({ body: {}, completedAtMs: 8, settled: true, status: 200 }, {
      get: () => { trapped(); throw new Error("trap"); }, getPrototypeOf: () => { trapped(); return Object.prototype; },
      ownKeys: () => { trapped(); return []; }, getOwnPropertyDescriptor: () => { trapped(); return undefined; } });
    const receipt = create(value).run();
    expect(receipt).toMatchObject({ applicationFailure: "readiness_unsettled_or_late", cleanupStatus: "cleanup_complete" });
    expect(trapped).not.toHaveBeenCalled();
  });

  it("abort after readiness prevents submit but not cleanup", () => {
    const value = fixture();
    const signal = { aborted: false };
    const normal = value.transport.readiness.getMockImplementation();
    value.transport.readiness.mockImplementationOnce((request) => { const result = normal(request); signal.aborted = true; return result; });
    const receipt = create(value, { signal }).run();
    expect(receipt).toMatchObject({ status: "failed", readinessStatus: "passed",
      applicationFailure: "application_aborted", applicationStatus: "not_run", cleanupStatus: "cleanup_complete",
      stages: ["readiness_passed"] });
    expect(value.transport.request).not.toHaveBeenCalled();
    expect(value.resources.size).toBe(0);
  });

  it("advances a late readiness result and preserves the independent cleanup budget", () => {
    const value = fixture();
    const normal = value.transport.readiness.getMockImplementation();
    value.transport.readiness.mockImplementationOnce((request) => {
      const result = normal(request);
      result.completedAtMs = 1_800_001;
      value.advanceTo(1_800_002);
      return result;
    });
    const receipt = create(value).run();
    expect(receipt).toMatchObject({ status: "failed", applicationFailure: "readiness_unsettled_or_late",
      bootstrapFailure: "application_unsettled_or_late", cleanupStatus: "cleanup_complete" });
    expect(value.resources.size).toBe(0);
  });

  it("keeps application and cleanup failures separate", () => {
    const value = fixture();
    value.transport.request.mockImplementationOnce(() => { throw new Error("application canary"); });
    value.lifecycleAdapter.remove.mockImplementationOnce(() => { throw new Error("cleanup canary"); });
    const receipt = create(value).run();
    expect(receipt.applicationFailure).toBe("application_adapter_error");
    expect(receipt.cleanupFailureFamilies).toContain("cleanup_remove_adapter_error");
    expect(JSON.stringify(receipt)).not.toMatch(/application canary|cleanup canary/);
  });

  it("rejects invalid synthetic identity and transport shape before lifecycle calls", () => {
    const value = fixture();
    expect(() => create(value, { manifest: { ...manifest, expectedRequestId: manifest.expectedMessageId } })).toThrow("invalid_application_manifest");
    expect(value.lifecycleAdapter.inventory).not.toHaveBeenCalled();
    expect(() => create(value, { transport: { ...value.transport, retry: vi.fn() } })).toThrow("invalid_application_transport");
  });

  it("is single-use", () => {
    const composition = create();
    composition.run();
    expect(() => composition.run()).toThrow("application_already_consumed");
  });
});
