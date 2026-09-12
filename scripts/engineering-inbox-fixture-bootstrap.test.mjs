// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEngineeringInboxFixturePlan } from "./engineering-inbox-fixture-plan.mjs";
import { createEngineeringInboxFixtureBootstrap } from "./engineering-inbox-fixture-bootstrap.mjs";

const uuid = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-7${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const ids = { network: "6".repeat(64), database: "7".repeat(64), postgrest: "8".repeat(64) };
const migrations = [
  { path: "supabase/migrations/20260910045917_engineering_durable_inbox.sql", sha256: "5".repeat(64) },
  { path: "supabase/migrations/20260910055556_engineering_ordered_changes.sql", sha256: "6".repeat(64) },
];

function fakePlan() {
  return createEngineeringInboxFixturePlan({ sourceRevision: "a".repeat(40), ownerTaskId: uuid("1"), runId: uuid("2"),
    databaseImage: `sha256:${"3".repeat(64)}`, postgrestImage: `sha256:${"4".repeat(64)}`, migrations });
}

function fixture() {
  const plan = fakePlan();
  let time = 1;
  const next = () => time++;
  const resources = new Map();
  const calls = [];
  const lifecycleAdapter = {
    inventory: vi.fn(() => ({ settled: true, completedAtMs: next(), resources: [] })),
    create: vi.fn((spec) => {
      calls.push(`create:${spec.labels.role}`);
      const resource = { ...structuredClone(spec), id: ids[spec.labels.role] };
      resources.set(resource.id, resource);
      return { settled: true, completedAtMs: next(), id: resource.id };
    }),
    inspect: vi.fn((id) => ({ settled: true, completedAtMs: next(), resource: resources.get(id) ?? null })),
    remove: vi.fn((id) => {
      calls.push(`remove:${resources.get(id)?.labels.role}`);
      resources.delete(id);
      return { settled: true, completedAtMs: next(), removed: true };
    }),
  };
  const bootstrapAdapter = {
    prerequisites: vi.fn((request) => {
      calls.push("prerequisites");
      return { ...structuredClone(request), databaseReady: true, postgrestReady: true,
        settled: true, completedAtMs: next() };
    }),
    migration: vi.fn((request) => {
      calls.push(`migration:${request.index}`);
      return { applied: true, completedAtMs: next(), index: request.index, path: request.path,
        previousSha256: request.previousSha256, settled: true, sha256: request.sha256 };
    }),
    suite: vi.fn((request) => {
      calls.push("suite");
      return { ...structuredClone(request), outcome: "passed", settled: true, completedAtMs: next() };
    }),
  };
  return { plan, lifecycleAdapter, bootstrapAdapter, resources, calls,
    advanceTo: (value) => { time = value; } };
}

function run(value = fixture(), options = {}) {
  return createEngineeringInboxFixtureBootstrap({ plan: value.plan,
    lifecycleAdapter: value.lifecycleAdapter, bootstrapAdapter: value.bootstrapAdapter, ...options }).run();
}

describe("engineering inbox fixture bootstrap composition", () => {
  it("composes prerequisites, exact migrations and the symbolic suite before proved cleanup", () => {
    const value = fixture();
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "passed", qualification: "source_contract_only",
      bootstrapFailure: null, lifecycleOperationFailure: null, cleanupStatus: "cleanup_complete",
      suite: { suite: "test:engineering-inbox", outcome: "passed", accessAssertions: 34,
        concurrentDuplicateSends: 5, conflictingSends: 2, conflictWinners: 1, revokedWaitingSend: "denied" } });
    expect(receipt.migrations).toEqual(migrations.map((entry, index) => ({ index, ...entry })));
    expect(value.calls).toEqual(["create:network", "create:database", "create:postgrest", "prerequisites",
      "migration:0", "migration:1", "suite", "remove:postgrest", "remove:database", "remove:network"]);
    expect(value.resources.size).toBe(0);
    expect(Object.isFrozen(receipt.migrations)).toBe(true);
  });

  it("never starts bootstrap until all three resources are proven-owned", () => {
    const value = fixture();
    value.lifecycleAdapter.inspect.mockImplementationOnce(() => ({ settled: true, completedAtMs: 3, resource: null }));
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "bootstrap_not_started",
      lifecycleOperationFailure: "post_create_identity_mismatch", cleanupStatus: "cleanup_unproved" });
    expect(value.bootstrapAdapter.prerequisites).not.toHaveBeenCalled();
  });

  it.each([
    ["source", (result) => { result.sourceRevision = "b".repeat(40); }],
    ["image", (result) => { result.databaseImage = `sha256:${"9".repeat(64)}`; }],
    ["resource", (result) => { result.databaseResourceId = "9".repeat(64); }],
    ["manifest", (result) => { result.manifest[0].sha256 = "9".repeat(64); }],
  ])("fails closed on prerequisite %s mismatch and still cleans", (_label, mutate) => {
    const value = fixture();
    const normal = value.bootstrapAdapter.prerequisites.getMockImplementation();
    value.bootstrapAdapter.prerequisites.mockImplementationOnce((request) => {
      const result = normal(request);
      mutate(result);
      return result;
    });
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "prerequisites_identity_mismatch",
      lifecycleOperationFailure: "operation_failed", cleanupStatus: "cleanup_complete" });
    expect(value.bootstrapAdapter.migration).not.toHaveBeenCalled();
    expect(value.resources.size).toBe(0);
  });

  it.each([
    ["throw", () => { throw new Error("private prerequisite canary"); }, "prerequisites_adapter_error"],
    ["promise", () => Promise.resolve({}), "prerequisites_unsettled_or_late"],
    ["thenable", () => ({ then() {}, settled: true, completedAtMs: 8 }), "prerequisites_unsettled_or_late"],
    ["malformed", () => ({ settled: false, completedAtMs: 8 }), "prerequisites_unsettled_or_late"],
  ])("contains %s prerequisite outcomes without retries or cleanup suppression", (_label, outcome, failure) => {
    const value = fixture();
    value.bootstrapAdapter.prerequisites.mockImplementationOnce(outcome);
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: failure,
      lifecycleOperationFailure: "operation_failed", cleanupStatus: "cleanup_complete" });
    expect(value.bootstrapAdapter.prerequisites).toHaveBeenCalledTimes(1);
    expect(value.bootstrapAdapter.migration).not.toHaveBeenCalled();
    expect(value.resources.size).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain("private prerequisite canary");
  });

  it("consumes a native rejected prerequisite Promise without exposing its rejection", async () => {
    const value = fixture();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      value.bootstrapAdapter.prerequisites.mockImplementationOnce(() => Promise.reject(new Error("rejection canary")));
      const receipt = run(value);
      await new Promise((resolve) => setImmediate(resolve));
      expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "prerequisites_unsettled_or_late",
        cleanupStatus: "cleanup_complete" });
      expect(unhandled).not.toHaveBeenCalled();
      expect(JSON.stringify(receipt)).not.toContain("rejection canary");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each(["migration", "suite"])("consumes a native rejected %s Promise and still cleans", async (stage) => {
    const value = fixture();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      value.bootstrapAdapter[stage].mockImplementationOnce(() => Promise.reject(new Error(`${stage} rejection canary`)));
      const receipt = run(value);
      await new Promise((resolve) => setImmediate(resolve));
      expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: `${stage}_unsettled_or_late`,
        cleanupStatus: "cleanup_complete" });
      expect(unhandled).not.toHaveBeenCalled();
      expect(value.resources.size).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("rejects an exotic prerequisite Promise without invoking its constructor accessor", () => {
    const value = fixture();
    const consulted = vi.fn();
    const promise = Promise.resolve("safe");
    Object.defineProperty(promise, "constructor", { get: () => { consulted(); throw new Error("constructor canary"); } });
    value.bootstrapAdapter.prerequisites = () => promise;
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "prerequisites_unsettled_or_late",
      cleanupStatus: "cleanup_complete" });
    expect(consulted).not.toHaveBeenCalled();
  });

  it("rejects a prerequisite Promise proxy before invoking any proxy trap", () => {
    const value = fixture();
    const trapped = vi.fn();
    const promise = new Proxy(Promise.resolve("safe"), {
      get: () => { trapped(); throw new Error("get trap canary"); },
      getOwnPropertyDescriptor: () => { trapped(); throw new Error("descriptor trap canary"); },
      getPrototypeOf: () => { trapped(); throw new Error("prototype trap canary"); },
      ownKeys: () => { trapped(); throw new Error("keys trap canary"); },
    });
    value.bootstrapAdapter.prerequisites = () => promise;
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "prerequisites_unsettled_or_late",
      cleanupStatus: "cleanup_complete" });
    expect(trapped).not.toHaveBeenCalled();
  });

  it("never reads a hostile bootstrap then accessor", () => {
    const value = fixture();
    const consulted = vi.fn();
    value.bootstrapAdapter.prerequisites.mockImplementationOnce(() => {
      const result = { settled: true, completedAtMs: 8 };
      Object.defineProperty(result, "then", { enumerable: true, get: () => { consulted(); throw new Error("then canary"); } });
      return result;
    });
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "prerequisites_unsettled_or_late",
      cleanupStatus: "cleanup_complete" });
    expect(consulted).not.toHaveBeenCalled();
  });

  it("does not invoke a throwing prerequisite accessor", () => {
    const value = fixture();
    const normal = value.bootstrapAdapter.prerequisites.getMockImplementation();
    value.bootstrapAdapter.prerequisites.mockImplementationOnce((request) => {
      const result = normal(request);
      Object.defineProperty(result, "sourceRevision", { enumerable: true,
        get: () => { throw new Error("accessor canary"); } });
      return result;
    });
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "prerequisites_unsettled_or_late",
      cleanupStatus: "cleanup_complete" });
    expect(JSON.stringify(receipt)).not.toContain("accessor canary");
    expect(value.resources.size).toBe(0);
  });

  it.each(["nested proxy", "cycle"])("rejects a %s in the prerequisite graph without retaining aliases", (kind) => {
    const value = fixture();
    const normal = value.bootstrapAdapter.prerequisites.getMockImplementation();
    const trapped = vi.fn();
    value.bootstrapAdapter.prerequisites.mockImplementationOnce((request) => {
      const result = normal(request);
      if (kind === "nested proxy") {
        result.manifest[0] = new Proxy(result.manifest[0], {
          get: () => { trapped(); throw new Error("nested trap canary"); },
          getOwnPropertyDescriptor: () => { trapped(); throw new Error("nested descriptor canary"); },
          getPrototypeOf: () => { trapped(); throw new Error("nested prototype canary"); },
          ownKeys: () => { trapped(); throw new Error("nested keys canary"); },
        });
      } else result.manifest[0].cycle = result.manifest[0];
      return result;
    });
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "prerequisites_unsettled_or_late",
      cleanupStatus: "cleanup_complete" });
    expect(trapped).not.toHaveBeenCalled();
    expect(value.resources.size).toBe(0);
  });

  it.each([
    ["index", (result) => { result.index = 1; }],
    ["path", (result) => { result.path = migrations[1].path; }],
    ["hash", (result) => { result.sha256 = "9".repeat(64); }],
    ["previous hash", (result) => { result.previousSha256 = "9".repeat(64); }],
    ["applied", (result) => { result.applied = false; }],
  ])("rejects migration %s mismatch, stops, and never runs the suite", (_label, mutate) => {
    const value = fixture();
    const normal = value.bootstrapAdapter.migration.getMockImplementation();
    value.bootstrapAdapter.migration.mockImplementationOnce((request) => {
      const result = normal(request);
      mutate(result);
      return result;
    });
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "migration_identity_mismatch",
      cleanupStatus: "cleanup_complete" });
    expect(value.bootstrapAdapter.migration).toHaveBeenCalledTimes(1);
    expect(value.bootstrapAdapter.suite).not.toHaveBeenCalled();
    expect(value.resources.size).toBe(0);
  });

  it("passes exact ordered previous-hash identity to every synthetic migration", () => {
    const value = fixture();
    run(value);
    expect(value.bootstrapAdapter.migration.mock.calls.map(([request]) => request.previousSha256))
      .toEqual([null, migrations[0].sha256]);
    expect(value.bootstrapAdapter.migration.mock.calls.map(([request]) => request.path))
      .toEqual(migrations.map(({ path }) => path));
  });

  it.each([
    ["outcome", (result) => { result.outcome = "failed"; }],
    ["assertion count", (result) => { result.accessAssertions = 33; }],
    ["head hash", (result) => { result.headSha256 = "9".repeat(64); }],
  ])("rejects symbolic suite %s mismatch without claiming qualification", (_label, mutate) => {
    const value = fixture();
    const normal = value.bootstrapAdapter.suite.getMockImplementation();
    value.bootstrapAdapter.suite.mockImplementationOnce((request) => {
      const result = normal(request);
      mutate(result);
      return result;
    });
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", qualification: "source_contract_only",
      bootstrapFailure: "suite_contract_mismatch", cleanupStatus: "cleanup_complete", suite: null });
  });

  it("advances a late bootstrap result and preserves the independent cleanup budget", () => {
    const value = fixture();
    const normal = value.bootstrapAdapter.prerequisites.getMockImplementation();
    value.bootstrapAdapter.prerequisites.mockImplementationOnce((request) => {
      const result = normal(request);
      result.completedAtMs = 1_800_001;
      value.advanceTo(1_800_002);
      return result;
    });
    const receipt = run(value);
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "prerequisites_unsettled_or_late",
      lifecycleOperationFailure: "operation_unsettled_or_late", cleanupStatus: "cleanup_complete" });
    expect(value.resources.size).toBe(0);
  });

  it("lets abort prevent bootstrap start without suppressing lifecycle cleanup", () => {
    const value = fixture();
    const signal = { aborted: false };
    const normalInspect = value.lifecycleAdapter.inspect.getMockImplementation();
    let acceptedInspections = 0;
    value.lifecycleAdapter.inspect.mockImplementation((id) => {
      const result = normalInspect(id);
      if (++acceptedInspections === 3) signal.aborted = true;
      return result;
    });
    const receipt = run(value, { signal });
    expect(receipt).toMatchObject({ status: "failed", bootstrapFailure: "bootstrap_not_started",
      lifecycleOperationFailure: "operation_aborted", cleanupStatus: "cleanup_complete" });
    expect(value.bootstrapAdapter.prerequisites).not.toHaveBeenCalled();
    expect(value.resources.size).toBe(0);
  });

  it("preserves bootstrap and cleanup failures as separate sanitized evidence", () => {
    const value = fixture();
    value.bootstrapAdapter.prerequisites.mockImplementationOnce(() => { throw new Error("bootstrap canary"); });
    value.lifecycleAdapter.remove.mockImplementationOnce(() => { throw new Error("cleanup canary"); });
    const receipt = run(value);
    expect(receipt.bootstrapFailure).toBe("prerequisites_adapter_error");
    expect(receipt.lifecycleOperationFailure).toBe("operation_failed");
    expect(receipt.cleanupFailures[0].family).toBe("cleanup_remove_adapter_error");
    expect(JSON.stringify(receipt)).not.toMatch(/bootstrap canary|cleanup canary/);
  });

  it("keeps successful bootstrap separate from cleanup failure", () => {
    const value = fixture();
    value.lifecycleAdapter.remove.mockImplementationOnce(() => { throw new Error("cleanup canary"); });
    const receipt = run(value);
    expect(receipt.status).toBe("failed");
    expect(receipt.bootstrapFailure).toBeNull();
    expect(receipt.cleanupStatus).toBe("cleanup_unproved");
    expect(receipt.cleanupFailures[0].family).toBe("cleanup_remove_adapter_error");
    expect(JSON.stringify(receipt)).not.toContain("cleanup canary");
  });

  it("is single-use and rejects extra bootstrap adapter capability before lifecycle calls", () => {
    const value = fixture();
    const composition = createEngineeringInboxFixtureBootstrap({ plan: value.plan,
      lifecycleAdapter: value.lifecycleAdapter, bootstrapAdapter: value.bootstrapAdapter });
    composition.run();
    expect(() => composition.run()).toThrow("bootstrap_already_consumed");
    const second = fixture();
    expect(() => createEngineeringInboxFixtureBootstrap({ plan: second.plan, lifecycleAdapter: second.lifecycleAdapter,
      bootstrapAdapter: { ...second.bootstrapAdapter, transport: vi.fn() } })).toThrow("invalid_bootstrap_adapter");
    expect(second.lifecycleAdapter.inventory).not.toHaveBeenCalled();
  });
});
