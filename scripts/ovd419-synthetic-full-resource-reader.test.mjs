// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const validators = vi.hoisted(() => {
  const snapshotScope = { bucket: "TEST_ONLY-bucket", object: "TEST_ONLY/object", maxBytes: "1000" };
  const resources = { cpu: "2", memory: "4Gi", taskSeconds: 600, retries: 0 };
  return {
    job: vi.fn(raw => ({
      sha256: raw,
      projection: {
        identity: { uid: "TEST_ONLY-job-uid" },
        latestCompletedExecution: { name: "overdrafter-xometry-auth-probe-test-only" },
        image: "TEST_ONLY-image",
        snapshotScope,
        resources,
        taskFingerprint: "TEST_ONLY-task",
      },
    })),
    service: vi.fn(raw => ({
      sha256: raw,
      projection: { image: "TEST_ONLY-image", snapshotScope },
    })),
    inventory: vi.fn(raw => {
      const changed = raw.includes("changed");
      const name = changed
        ? "overdrafter-xometry-auth-probe-changed"
        : "overdrafter-xometry-auth-probe-test-only";
      return { sha256: raw, ids: [name], selected: { name, uid: "TEST_ONLY-execution-uid" } };
    }),
    execution: vi.fn(raw => ({
      sha256: raw,
      projection: {
        ownerJob: { uid: "TEST_ONLY-job-uid" },
        image: "TEST_ONLY-image",
        snapshotScope,
        resources,
        taskFingerprint: "TEST_ONLY-task",
      },
    })),
  };
});

vi.mock("./ovd419-acquisition-job.mjs", () => ({
  validateSyntheticFullJob: validators.job,
}));
vi.mock("./ovd419-acquisition-service.mjs", () => ({
  validateSyntheticFullService: validators.service,
}));
vi.mock("./ovd419-acquisition-inventory.mjs", () => ({
  validateSyntheticAcquisitionInventory: validators.inventory,
}));
vi.mock("./ovd419-acquisition-execution.mjs", () => ({
  validateSyntheticCompletedExecution: validators.execution,
}));

import {
  createSyntheticFullResourceReader,
  isSyntheticFullResourceHandoff,
  SYNTHETIC_FULL_RESOURCE_READER_CONTRACT as CONTRACT,
} from "./ovd419-synthetic-full-resource-reader.mjs";

const packet = Object.freeze({ mode: "TEST_ONLY-packet" });
const projectNumber = "123456789";

function envelope(request, payload) {
  return JSON.stringify({
    schema: CONTRACT.responseSchema,
    mode: "TEST_ONLY",
    id: request.id,
    sequence: request.sequence,
    requestSha256: request.requestSha256,
    complete: true,
    settled: true,
    isError: false,
    payload,
  });
}

function fixture({ changeInventory = false, changeResource = null, changeResponse = () => {}, hangAt = null } = {}) {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const transport = vi.fn(async (request, context) => {
    calls.push({ request, context });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (request.id === hangAt) return await new Promise(() => {});
      let kind = request.id.replace(/Pass[12]$/, "");
      if (changeInventory && request.id === "fullInventoryPass2") kind += "-changed";
      if (request.id === changeResource) kind += "-changed";
      const response = JSON.parse(envelope(request, kind));
      changeResponse(response, request);
      return JSON.stringify(response);
    } finally {
      active -= 1;
    }
  });
  const reader = () => createSyntheticFullResourceReader({ transport, packet, projectNumber });
  return { calls, reader, transport, get maximumActive() { return maximumActive; } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("synthetic full-resource reader", () => {
  it("validates exactly two stable passes and returns only an opaque handoff receipt", async () => {
    const f = fixture();
    const reader = f.reader();
    const result = await reader.read();

    expect(f.calls.map(({ request }) => request.id)).toEqual([
      "fullJobPass1", "fullServicePass1", "fullInventoryPass1", "completedExecutionPass1",
      "fullJobPass2", "fullServicePass2", "fullInventoryPass2", "completedExecutionPass2",
    ]);
    expect(f.calls.map(({ request }) => request.sequence)).toEqual([...Array(8).keys()]);
    expect(f.calls[3].request.args).toContain("overdrafter-xometry-auth-probe-test-only");
    expect(f.calls[7].request.args).toContain("overdrafter-xometry-auth-probe-test-only");
    expect(f.calls.every(({ request }) => Object.isFrozen(request) && Object.isFrozen(request.args))).toBe(true);
    expect(f.calls.every(({ context }) => context.maxBytes === 4194304)).toBe(true);
    expect(f.maximumActive).toBe(1);
    expect(validators.job).toHaveBeenCalledTimes(2);
    expect(validators.service).toHaveBeenCalledTimes(2);
    expect(validators.inventory).toHaveBeenCalledTimes(2);
    expect(validators.execution).toHaveBeenCalledTimes(2);
    expect(validators.execution).toHaveBeenNthCalledWith(1, "completedExecution", {
      mode: "TEST_ONLY",
      packet,
      projectNumber,
      selected: {
        name: "overdrafter-xometry-auth-probe-test-only",
        uid: "TEST_ONLY-execution-uid",
      },
    });
    expect(result).toMatchObject({
      schema: CONTRACT.handoffSchema,
      mode: "TEST_ONLY",
      usage: { calls: 8 },
      fullResourceShapeQualified: true,
      transportQualified: false,
      fullAcquisitionQualified: false,
      privateBindingReady: false,
    });
    expect(Object.keys(result).sort()).toEqual([
      "fullAcquisitionQualified", "fullResourceShapeQualified", "handoffSha256", "mode",
      "privateBindingReady", "schema", "transportQualified", "usage",
    ]);
    expect(JSON.stringify(result)).not.toContain("completedExecution");
    expect(JSON.stringify(result)).not.toContain(projectNumber);
    expect(isSyntheticFullResourceHandoff(result)).toBe(true);
    expect(isSyntheticFullResourceHandoff({ ...result })).toBe(false);
    await expect(reader.read()).rejects.toThrow("full_resource_request_budget_exhausted");
    expect(f.transport).toHaveBeenCalledTimes(8);
  });

  it("stops before the second Execution when the inventory changes", async () => {
    const f = fixture({ changeInventory: true });
    const reader = f.reader();
    await expect(reader.read()).rejects.toThrow("full_resource_inventory_changed_between_passes");
    expect(f.transport).toHaveBeenCalledTimes(7);
    await expect(reader.read()).rejects.toThrow("full_resource_request_budget_exhausted");
  });

  it("stops at the first full resource that differs between passes", async () => {
    const f = fixture({ changeResource: "fullServicePass2" });
    await expect(f.reader().read()).rejects.toThrow("full_resource_changed_between_passes");
    expect(f.transport).toHaveBeenCalledTimes(6);
  });

  it("rejects an attributable envelope mismatch and consumes the attempt", async () => {
    const f = fixture({
      changeResponse: (response, request) => {
        if (request.id === "fullServicePass1") response.sequence += 1;
      },
    });
    const reader = f.reader();
    await expect(reader.read()).rejects.toThrow("invalid_full_resource_response");
    expect(f.transport).toHaveBeenCalledTimes(2);
    await expect(reader.read()).rejects.toThrow("full_resource_request_budget_exhausted");
  });

  it("aborts a hung read at the tightened deadline without retrying", async () => {
    vi.useFakeTimers();
    const f = fixture({ hangAt: "fullJobPass1" });
    const reader = createSyntheticFullResourceReader({
      transport: f.transport,
      packet,
      projectNumber,
      perReadMs: 10,
      totalDurationMs: 100,
    });
    const outcome = reader.read().catch(error => error.message);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBe("full_resource_read_timeout");
    expect(f.calls[0].context.signal.aborted).toBe(true);
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it("rejects misspelled options and widened limits before transport", () => {
    const transport = vi.fn();
    for (const input of [
      { transport, packet, projectNumber, perReadMS: 10 },
      { transport, packet, projectNumber, perReadMs: 30001 },
      { transport, packet, projectNumber, totalDurationMs: 900001 },
      { transport, packet, projectNumber: "overdrafter-worker-9133" },
    ]) expect(() => createSyntheticFullResourceReader(input)).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
