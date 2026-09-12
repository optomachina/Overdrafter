// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEngineeringInboxFixturePlan } from "./engineering-inbox-fixture-plan.mjs";
import { createEngineeringInboxFixtureLifecycle } from "./engineering-inbox-fixture-lifecycle.mjs";

const uuid = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-7${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const input = () => ({ sourceRevision: "a".repeat(40), ownerTaskId: uuid("1"), runId: uuid("2"),
  databaseImage: `sha256:${"3".repeat(64)}`, postgrestImage: `sha256:${"4".repeat(64)}`,
  migrations: [{ path: "supabase/migrations/20260910045917_engineering_durable_inbox.sql", sha256: "5".repeat(64) }] });
const ids = { network: "6".repeat(64), database: "7".repeat(64), postgrest: "8".repeat(64) };

function fakePlan() { return createEngineeringInboxFixturePlan(input()); }
function adapterFixture(plan = fakePlan()) {
  let time = 1;
  const resources = new Map();
  const calls = [];
  const result = (extra) => ({ settled: true, completedAtMs: time++, ...extra });
  const adapter = {
    inventory: vi.fn(() => result({ resources: [] })),
    create: vi.fn((spec) => {
      calls.push(`create:${spec.labels.role}`);
      const resource = { ...structuredClone(spec), id: ids[spec.labels.role] };
      resources.set(resource.id, resource);
      return result({ id: resource.id });
    }),
    inspect: vi.fn((id) => result({ resource: resources.get(id) ?? null })),
    remove: vi.fn((id) => { calls.push(`remove:${resources.get(id)?.labels.role}`); resources.delete(id); return result({ removed: true }); }),
  };
  return { adapter, calls, resources, result, plan, advanceTo: (value) => { time = value; } };
}
function run(fixture = adapterFixture(), options = {}) {
  return createEngineeringInboxFixtureLifecycle({ plan: fixture.plan, adapter: fixture.adapter, ...options }).run();
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("engineering inbox fixture resource lifecycle", () => {
  it("records exact ownership and proves reverse-order cleanup before final success", () => {
    const fixture = adapterFixture();
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "passed", cleanupStatus: "cleanup_complete",
      operationFailure: null, qualification: "source_contract_only",
      provisional: { status: "provisional", acceptedResourceCount: 3, possibleCreatedCount: 0 },
      timing: { deadlinesAreSimulated: true } });
    expect(fixture.calls).toEqual(["create:network", "create:database", "create:postgrest",
      "remove:postgrest", "remove:database", "remove:network"]);
    expect(receipt.stages.at(-1)).toBe("removed:network");
    expect(fixture.resources.size).toBe(0);
    expect(Object.isFrozen(receipt.cleanupFailures)).toBe(true);
  });

  it("rejects an invalid plan or adapter with zero calls", () => {
    const fixture = adapterFixture();
    const invalidPlan = Object.freeze({ ...fixture.plan, unexpected: true });
    expect(() => createEngineeringInboxFixtureLifecycle({ plan: invalidPlan, adapter: fixture.adapter })).toThrow("invalid_plan");
    expect(fixture.adapter.inventory).not.toHaveBeenCalled();
    expect(() => createEngineeringInboxFixtureLifecycle({ plan: fixture.plan,
      adapter: { ...fixture.adapter, execute: vi.fn() } })).toThrow("invalid_adapter");
    expect(fixture.adapter.inventory).not.toHaveBeenCalled();
  });

  it("rejects a frozen plan that widens a fixed resource cap", () => {
    const fixture = adapterFixture();
    const widened = structuredClone(fixture.plan);
    widened.resourcePolicy.maxContainers = 3;
    expect(() => createEngineeringInboxFixtureLifecycle({ plan: freeze(widened), adapter: fixture.adapter })).toThrow("invalid_plan");
    expect(fixture.adapter.inventory).not.toHaveBeenCalled();
  });

  it("rejects a widened plan even when a serialization hook hides the change", () => {
    const fixture = adapterFixture();
    const widened = structuredClone(fixture.plan);
    widened.resourcePolicy.containers.database.cpuCount = 100;
    Object.defineProperty(widened, "toJSON", { value: () => fixture.plan, enumerable: false });
    expect(() => createEngineeringInboxFixtureLifecycle({ plan: freeze(widened), adapter: fixture.adapter })).toThrow("invalid_plan");
    expect(fixture.adapter.inventory).not.toHaveBeenCalled();
  });

  it.each(["same run", "planned name"])("stops an inventory %s collision before create", (kind) => {
    const fixture = adapterFixture();
    const collision = { id: "9".repeat(64), type: "network", name: kind === "planned name"
      ? `ovd496-${fixture.plan.identity.runId}-network` : "other", caps: {},
      labels: { contract: fixture.plan.schema, ownerTaskId: uuid("3"), role: "network",
        runId: kind === "same run" ? fixture.plan.identity.runId : uuid("3"), sourceRevision: "b".repeat(40) } };
    fixture.adapter.inventory.mockImplementationOnce(() => fixture.result({ resources: [collision] }));
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "inventory_collision", cleanupStatus: "cleanup_complete" });
    expect(fixture.adapter.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing id", { id: undefined }], ["malformed id", { id: "name" }],
    ["unsettled id", { id: ids.network, settled: false }], ["late id", { id: ids.network, completedAtMs: 1_800_001 }],
  ])("keeps ambiguous create as possible residue without guessing cleanup for %s", (_label, override) => {
    const fixture = adapterFixture();
    fixture.adapter.create.mockImplementationOnce((spec) => {
      const created = fixture.result({ id: ids[spec.labels.role] });
      return { ...created, ...override };
    });
    const receipt = run(fixture);
    expect(receipt.status).toBe("failed");
    expect(receipt.cleanupStatus).toBe("cleanup_unproved");
    expect(receipt.possibleCreated).toHaveLength(1);
    expect(fixture.adapter.remove).not.toHaveBeenCalled();
  });

  it("does not coerce an array-wrapped create ID into owned identity", () => {
    const fixture = adapterFixture();
    fixture.adapter.create.mockImplementationOnce(() => fixture.result({ id: [ids.network] }));
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "create_ambiguous_identity",
      cleanupStatus: "cleanup_unproved", possibleCreated: [{ role: "network", id: null }] });
    expect(fixture.adapter.inspect).not.toHaveBeenCalled();
    expect(fixture.adapter.remove).not.toHaveBeenCalled();
  });

  it("contains a throwing create-result ID accessor and still cleans accepted predecessors", () => {
    const fixture = adapterFixture();
    const normalCreate = fixture.adapter.create.getMockImplementation();
    fixture.adapter.create.mockImplementationOnce(normalCreate).mockImplementationOnce(() => {
      const value = { settled: true, completedAtMs: 3 };
      Object.defineProperty(value, "id", { enumerable: true, get: () => { throw new Error("id canary"); } });
      return value;
    });
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "create_unsettled_or_late",
      cleanupStatus: "cleanup_unproved", possibleCreated: [{ role: "database", id: null }] });
    expect(fixture.calls).toContain("remove:network");
    expect(JSON.stringify(receipt)).not.toContain("id canary");
  });

  it("keeps a failed post-create inspection out of the owned ledger and cleanup", () => {
    const fixture = adapterFixture();
    fixture.adapter.inspect.mockImplementationOnce(() => fixture.result({ resource: null }));
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "post_create_identity_mismatch",
      cleanupStatus: "cleanup_unproved", resources: [] });
    expect(receipt.possibleCreated).toEqual([{ role: "network", id: ids.network }]);
    expect(fixture.adapter.remove).not.toHaveBeenCalled();
  });

  it("accepts equivalent inspected metadata regardless of property insertion order", () => {
    const fixture = adapterFixture();
    const normalInspect = fixture.adapter.inspect.getMockImplementation();
    fixture.adapter.inspect.mockImplementationOnce((id) => {
      const value = normalInspect(id);
      const labels = Object.fromEntries(Object.entries(value.resource.labels).reverse());
      return { ...value, resource: { ...value.resource, labels } };
    });
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "passed", cleanupStatus: "cleanup_complete", operationFailure: null });
  });

  it("treats an extra create-result field as ambiguous possible residue", () => {
    const fixture = adapterFixture();
    fixture.adapter.create.mockImplementationOnce((spec) => ({ ...fixture.result({ id: ids[spec.labels.role] }), raw: "canary" }));
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "create_unsettled_or_late",
      cleanupStatus: "cleanup_unproved" });
    expect(JSON.stringify(receipt)).not.toContain("canary");
    expect(fixture.adapter.remove).not.toHaveBeenCalled();
  });

  it("never adopts or removes a duplicate returned resource ID", () => {
    const fixture = adapterFixture();
    const create = fixture.adapter.create.getMockImplementation();
    fixture.adapter.create.mockImplementationOnce(create)
      .mockImplementationOnce(() => fixture.result({ id: ids.network }));
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "create_ambiguous_identity",
      cleanupStatus: "cleanup_unproved" });
    expect(receipt.possibleCreated).toEqual([{ role: "database", id: ids.network }]);
    expect(fixture.calls.filter((call) => call === "remove:network")).toHaveLength(1);
  });

  it("cleans accepted predecessors after a later create failure", () => {
    const fixture = adapterFixture();
    fixture.adapter.create.mockImplementationOnce(fixture.adapter.create.getMockImplementation())
      .mockImplementationOnce(() => { throw new Error("raw secret canary"); });
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "create_adapter_error",
      cleanupStatus: "cleanup_unproved" });
    expect(fixture.calls).toContain("remove:network");
    expect(JSON.stringify(receipt)).not.toContain("raw secret canary");
  });

  it("contains malformed inspection caps and still cleans accepted predecessors", () => {
    const fixture = adapterFixture();
    const normalInspect = fixture.adapter.inspect.getMockImplementation();
    fixture.adapter.inspect.mockImplementationOnce(normalInspect).mockImplementationOnce((id) => {
      const value = normalInspect(id);
      return { ...value, resource: { ...value.resource, caps: { bytes: 1n } } };
    });
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "post_create_identity_mismatch",
      cleanupStatus: "cleanup_unproved", possibleCreated: [{ role: "database", id: ids.database }] });
    expect(fixture.calls).toContain("remove:network");
    expect(receipt.cleanupFailures).toEqual([]);
  });

  it("advances simulated time after a late create and still cleans accepted predecessors", () => {
    const fixture = adapterFixture();
    const normalCreate = fixture.adapter.create.getMockImplementation();
    fixture.adapter.create.mockImplementationOnce(normalCreate).mockImplementationOnce((spec) => {
      fixture.advanceTo(1_800_002);
      return { settled: true, completedAtMs: 1_800_001, id: ids[spec.labels.role] };
    });
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "create_unsettled_or_late",
      cleanupStatus: "cleanup_unproved", possibleCreated: [{ role: "database", id: ids.database }] });
    expect(fixture.calls).toContain("remove:network");
    expect(receipt.cleanupFailures).toEqual([]);
  });

  it("refuses cleanup on identity drift but continues accepted sibling cleanup", () => {
    const fixture = adapterFixture();
    const normalInspect = fixture.adapter.inspect.getMockImplementation();
    fixture.adapter.inspect.mockImplementationOnce(normalInspect).mockImplementationOnce(normalInspect)
      .mockImplementationOnce(normalInspect).mockImplementationOnce((id) => {
        const value = normalInspect(id);
        return { ...value, resource: { ...value.resource, name: "drifted" } };
      });
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", cleanupStatus: "cleanup_unproved" });
    expect(receipt.cleanupFailures).toEqual(expect.arrayContaining([{ id: ids.postgrest, family: "cleanup_identity_drift" }]));
    expect(fixture.calls).toEqual(expect.arrayContaining(["remove:database", "remove:network"]));
    expect(fixture.calls).not.toContain("remove:postgrest");
  });

  it("preserves operation failure separately when sibling cleanup also fails", () => {
    const fixture = adapterFixture();
    const create = fixture.adapter.create.getMockImplementation();
    fixture.adapter.create.mockImplementationOnce(create).mockImplementationOnce(() => { throw new Error("operation canary"); });
    fixture.adapter.remove.mockImplementationOnce(() => { throw new Error("cleanup canary"); });
    const receipt = run(fixture);
    expect(receipt.operationFailure).toBe("create_adapter_error");
    expect(receipt.cleanupFailures[0].family).toBe("cleanup_remove_adapter_error");
    expect(JSON.stringify(receipt)).not.toMatch(/operation canary|cleanup canary/);
  });

  it("treats removal residue as failed cleanup", () => {
    const fixture = adapterFixture();
    fixture.adapter.remove.mockImplementation((id) => fixture.result({ removed: true }));
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", cleanupStatus: "cleanup_unproved" });
    expect(receipt.cleanupFailures.some(({ family }) => family === "cleanup_residue")).toBe(true);
  });

  it("models late and unsettled operations as failure without claiming cancellation", () => {
    const fixture = adapterFixture();
    fixture.adapter.inventory.mockReturnValueOnce({ settled: false, completedAtMs: 1, resources: [] });
    const receipt = run(fixture);
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "inventory_unsettled_or_late",
      timing: { deadlinesAreSimulated: true } });
    expect(fixture.adapter.create).not.toHaveBeenCalled();
  });

  it("checks abort only at deterministic boundaries and performs no real wait", () => {
    const fixture = adapterFixture();
    const signal = { aborted: true };
    const receipt = run(fixture, { signal });
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "inventory_aborted", callCount: 0 });
  });

  it("does not let operation abort suppress cleanup of proven-owned resources", () => {
    const fixture = adapterFixture();
    const signal = { aborted: false };
    const normalInspect = fixture.adapter.inspect.getMockImplementation();
    fixture.adapter.inspect.mockImplementationOnce((id) => {
      const value = normalInspect(id);
      signal.aborted = true;
      return value;
    });
    const receipt = run(fixture, { signal });
    expect(receipt).toMatchObject({ status: "failed", operationFailure: "create_aborted",
      cleanupStatus: "cleanup_complete", possibleCreated: [] });
    expect(fixture.calls).toContain("remove:network");
    expect(fixture.resources.size).toBe(0);
  });

  it("is single-use and never retries", () => {
    const fixture = adapterFixture();
    const lifecycle = createEngineeringInboxFixtureLifecycle({ plan: fixture.plan, adapter: fixture.adapter });
    lifecycle.run();
    expect(() => lifecycle.run()).toThrow("lifecycle_already_consumed");
    expect(fixture.adapter.inventory).toHaveBeenCalledTimes(1);
  });
});
