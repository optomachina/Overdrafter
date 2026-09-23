// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const prefix = vi.hoisted(() => vi.fn());
const validators = vi.hoisted(() => {
  const snapshotScope = { bucket: "test-only-bucket", object: "profiles/test-only.tgz", maxBytes: "1000" };
  const resources = { cpu: "2", memory: "4Gi", taskSeconds: 600, retries: 0 };
  const selected = { name: "overdrafter-xometry-auth-probe-test-only", uid: "TEST_ONLY_execution" };
  return {
    snapshotScope, resources, selected,
    principal: vi.fn(raw => ({ sha256: raw, projection: { principal: JSON.parse(raw)[0].account } })),
    snapshot: vi.fn(raw => ({ sha256: raw, projection: JSON.parse(raw) })),
    secret: vi.fn(raw => ({ sha256: raw, projection: { secretVersion: JSON.parse(raw).name.split("/").at(-1) } })),
    containment: vi.fn(raw => ({ fingerprint: raw, controls: "TEST_ONLY_controls" })),
    job: vi.fn(raw => ({ sha256: raw, projection: { identity: { uid: "TEST_ONLY_job" },
      latestCompletedExecution: { name: selected.name }, image: "TEST_ONLY_image", snapshotScope, resources,
      taskFingerprint: "TEST_ONLY_task" } })),
    service: vi.fn(raw => ({ sha256: raw, projection: { image: "TEST_ONLY_image", snapshotScope,
      secretReference: { name: "supabase-service-role-key", key: "latest" } } })),
    inventory: vi.fn(raw => {
      if (raw === "truncated") throw new Error("acquisition_inventory_rejected");
      return { sha256: raw, ids: [selected.name], selected };
    }),
    execution: vi.fn(raw => ({ sha256: raw, projection: { ownerJob: { uid: "TEST_ONLY_job" },
      image: "TEST_ONLY_image", snapshotScope, resources, taskFingerprint: "TEST_ONLY_task" } })),
  };
});

vi.mock("./ovd419-synthetic-acquisition-prefix.mjs", () => ({
  SYNTHETIC_PREFIX_CONTRACT: { responseSchema: "OVD419-SYNTHETIC-ACQUISITION-PREFIX-RESPONSE-v1" },
  createSyntheticAcquisitionPrefix: prefix,
}));
vi.mock("./ovd419-acquisition-metadata.mjs", () => ({
  validateSyntheticPrincipal: validators.principal,
  validateSyntheticSnapshotMetadata: validators.snapshot,
  validateSyntheticSecretVersionMetadata: validators.secret,
}));
vi.mock("./ovd419-acquisition-compatibility.mjs", async importOriginal => {
  const original = await importOriginal();
  return { ...original, validateContainmentCompatibility: validators.containment };
});
vi.mock("./ovd419-acquisition-job.mjs", () => ({ validateSyntheticFullJob: validators.job }));
vi.mock("./ovd419-acquisition-service.mjs", () => ({ validateSyntheticFullService: validators.service }));
vi.mock("./ovd419-acquisition-inventory.mjs", () => ({ validateSyntheticAcquisitionInventory: validators.inventory }));
vi.mock("./ovd419-acquisition-execution.mjs", () => ({ validateSyntheticCompletedExecution: validators.execution }));

import { digest } from "./ovd419-job-diagnostic.mjs";
import {
  createSyntheticAcquisitionReader,
  isSyntheticAcquisitionHandoff,
  SYNTHETIC_ACQUISITION_READER_CONTRACT as CONTRACT,
} from "./ovd419-synthetic-acquisition-reader.mjs";

const provenance = Object.freeze({
  acquisitionSourceCommit: "a".repeat(40), diagnosticSourceCommit: "b".repeat(40),
  inputManifestSha256: "c".repeat(64), readPlanSha256: "d".repeat(64), invocationId: "TEST_ONLY_complete",
});
const qualification = Object.freeze({ mode: "TEST_ONLY", acquisitionSourceCommit: provenance.acquisitionSourceCommit,
  inputManifestSha256: provenance.inputManifestSha256, invocationId: provenance.invocationId });
const snapshot = Object.freeze({ generation: "1", metageneration: "2", etag: "TEST_ONLY_etag" });
const packet = Object.freeze({ baseline: Object.freeze({
  account: digest({ ...validators.snapshotScope, principal: "TEST_ONLY_operator@example.invalid" }),
  snapshot: digest(snapshot), secretVersion: "7",
}) });

function installPrefix() {
  prefix.mockImplementation(({ transport }) => ({
    async read() {
      for (let sequence = 0; sequence < 21; sequence += 1) {
        const id = sequence === 0 ? "catalogue" : sequence === 1 ? "containmentOpening" :
          sequence === 14 ? "E13" : sequence === 20 ? "IAM01" : `E${String(sequence - 1).padStart(2, "0")}`;
        const request = Object.freeze({ schema: "PREFIX_REQUEST", mode: "TEST_ONLY", id, sequence,
          requestSha256: `TEST_ONLY_hash_${sequence}`, provenance,
          ...(id === "catalogue" ? {} : {
            args: id.startsWith("E") || id.startsWith("IAM") ? Object.freeze(["TEST_ONLY", id]) : null,
          }) });
        const response = JSON.parse(await transport(request,
          Object.freeze({ signal: new AbortController().signal, maxBytes: 4194304 })));
        if (Object.hasOwn(response, "args")) throw new Error("TEST_ONLY_internal_response_leaked_args");
      }
      return Object.freeze({ provenance, usage: Object.freeze({ calls: 21, cloudCalls: 19, sqlCalls: 2 }),
        containmentFingerprint: "containment", controlsFingerprint: "TEST_ONLY_controls",
        catalogueFingerprint: "TEST_ONLY_catalogue", iamFingerprint: "TEST_ONLY_iam",
        egressFingerprint: "TEST_ONLY_egress", prefixQualified: true, fullAcquisitionQualified: false });
    },
  }));
}

function payloadFor(request, { changeResource, truncateInventory } = {}) {
  if (request.id === "principalOpening" || request.id === "principalClosing") {
    return JSON.stringify([{ account: "TEST_ONLY_operator@example.invalid", status: "ACTIVE" }]);
  }
  if (request.id === "snapshotOpening" || request.id === "snapshotClosing") return JSON.stringify(snapshot);
  if (request.id === "secretVersionOpening" || request.id === "secretVersionClosing") {
    return JSON.stringify({ name: "projects/123456789/secrets/supabase-service-role-key/versions/7", state: "ENABLED" });
  }
  if (request.id === "containmentOpening" || request.id === "containmentClosing") return "containment";
  if (request.id === "E13" || request.id === "closingE13") return "[]";
  if (truncateInventory && request.id === "fullInventoryPass2") return "truncated";
  if (changeResource === request.id) return `${request.id}-changed`;
  return request.id.replace(/Pass[12]$/, "");
}

function fixture({ changeResource, truncateInventory, hangAt, clock } = {}) {
  installPrefix();
  const calls = [];
  const transport = vi.fn(async (request, context) => {
    calls.push({ request, context });
    if (request.id === hangAt) return await new Promise(() => {});
    const payload = payloadFor(request, { changeResource, truncateInventory });
    return JSON.stringify({ schema: CONTRACT.responseSchema, mode: "TEST_ONLY", id: request.id,
      sequence: request.sequence, requestSha256: request.requestSha256, provenance: request.provenance,
      complete: true, settled: true, isError: false, payload });
  });
  const reader = () => createSyntheticAcquisitionReader({ transport, qualification, packet,
    projectNumber: "123456789", snapshotScope: validators.snapshotScope,
    secretReference: { name: "supabase-service-role-key", key: "latest" }, ...(clock ? { clock } : {}) });
  return { calls, reader, transport };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("complete synthetic acquisition reader", () => {
  it("attributes the complete finite acquisition and returns only an opaque TEST_ONLY receipt", async () => {
    const f = fixture();
    const reader = f.reader();
    const result = await reader.read();
    expect(f.calls).toHaveLength(37);
    expect(f.calls.map(({ request }) => request.sequence)).toEqual([...Array(37).keys()]);
    expect(f.calls.slice(21).map(({ request }) => request.id)).toEqual([
      "principalOpening", "snapshotOpening", "secretVersionOpening", "principalClosing",
      "snapshotClosing", "secretVersionClosing", "containmentClosing", "fullJobPass1",
      "fullServicePass1", "fullInventoryPass1", "completedExecutionPass1", "fullJobPass2",
      "fullServicePass2", "fullInventoryPass2", "completedExecutionPass2", "closingE13",
    ]);
    for (const { request } of f.calls.slice(21).filter(({ request }) => request.args !== null)) {
      expect(request.requestSha256).toBe(createHash("sha256")
        .update(JSON.stringify(request.args)).digest("hex"));
    }
    expect(result).toMatchObject({ schema: CONTRACT.handoffSchema, mode: "TEST_ONLY",
      usage: { calls: 37, cloudCalls: 34, sqlCalls: 3 }, completeAcquisitionQualified: true,
      transportQualified: false, privateBindingReady: false });
    expect(JSON.stringify(result)).not.toContain("TEST_ONLY_operator");
    expect(JSON.stringify(result)).not.toContain("payload");
    expect(isSyntheticAcquisitionHandoff(result)).toBe(true);
    expect(isSyntheticAcquisitionHandoff({ ...result })).toBe(false);
    await expect(reader.read()).rejects.toThrow("acquisition_request_budget_exhausted");
  });

  it("rejects a changed full resource and a truncated inventory", async () => {
    await expect(fixture({ changeResource: "fullServicePass2" }).reader().read())
      .rejects.toThrow("acquisition_resource_changed");
    await expect(fixture({ truncateInventory: true }).reader().read())
      .rejects.toThrow("acquisition_inventory_rejected");
  });

  it("aborts a timed-out response and rejects a response that settles late", async () => {
    vi.useFakeTimers();
    const hung = fixture({ hangAt: "principalOpening" });
    const outcome = createSyntheticAcquisitionReader({ transport: hung.transport, qualification, packet,
      projectNumber: "123456789", snapshotScope: validators.snapshotScope,
      secretReference: { name: "supabase-service-role-key", key: "latest" }, perReadMs: 10,
      totalDurationMs: 100 }).read().catch(error => error.message);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBe("acquisition_read_timeout");
    expect(hung.calls.at(-1).context.signal.aborted).toBe(true);
    vi.useRealTimers();

    let now = 0;
    const late = fixture({ clock: Object.freeze({ now: () => now }) });
    late.transport.mockImplementation(async request => {
      if (request.id === "principalOpening") now = 31;
      const payload = payloadFor(request);
      return JSON.stringify({ schema: CONTRACT.responseSchema, mode: "TEST_ONLY", id: request.id,
        sequence: request.sequence, requestSha256: request.requestSha256, provenance: request.provenance,
        complete: true, settled: true, isError: false, payload });
    });
    await expect(createSyntheticAcquisitionReader({ transport: late.transport, qualification, packet,
      projectNumber: "123456789", snapshotScope: validators.snapshotScope,
      secretReference: { name: "supabase-service-role-key", key: "latest" }, perReadMs: 30,
      totalDurationMs: 1000, clock: Object.freeze({ now: () => now }) }).read())
      .rejects.toThrow("acquisition_read_timeout");
  });

  it("rejects incomplete envelopes and caller-forged readiness fields", async () => {
    const f = fixture();
    f.transport.mockImplementation(async request => JSON.stringify({ schema: CONTRACT.responseSchema,
      mode: "TEST_ONLY", id: request.id, sequence: request.sequence, requestSha256: request.requestSha256,
      provenance: request.provenance, complete: request.id !== "fullInventoryPass1", settled: true,
      isError: false, payload: payloadFor(request) }));
    await expect(f.reader().read()).rejects.toThrow("invalid_acquisition_response");
    expect(() => createSyntheticAcquisitionReader({ transport: vi.fn(), qualification, packet,
      projectNumber: "123456789", snapshotScope: validators.snapshotScope,
      secretReference: { name: "supabase-service-role-key", key: "latest" }, fullAcquisitionQualified: true }))
      .toThrow("invalid_acquisition_options");
  });

  it("enforces the real per-call payload bound", async () => {
    const f = fixture();
    f.transport.mockImplementation(async request => JSON.stringify({ schema: CONTRACT.responseSchema,
      mode: "TEST_ONLY", id: request.id, sequence: request.sequence, requestSha256: request.requestSha256,
      provenance: request.provenance, complete: true, settled: true, isError: false,
      payload: request.id === "fullJobPass1" ? "x".repeat(4194305) : payloadFor(request) }));
    await expect(f.reader().read()).rejects.toThrow("invalid_acquisition_response");
  });

  it("rejects an oversized per-call envelope before parsing it", async () => {
    const f = fixture();
    let oversizedResponse;
    f.transport.mockImplementation(async (request, context) => {
      const payload = request.id === "fullJobPass1" ? "x".repeat(context.maxBytes) : payloadFor(request);
      const raw = JSON.stringify({ schema: CONTRACT.responseSchema, mode: "TEST_ONLY",
        id: request.id, sequence: request.sequence, requestSha256: request.requestSha256,
        provenance: request.provenance, complete: true, settled: true, isError: false, payload });
      if (request.id === "fullJobPass1") {
        expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(context.maxBytes);
        oversizedResponse = raw;
      }
      return raw;
    });
    const parse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((...args) => parse(...args));
    try {
      await expect(f.reader().read()).rejects.toThrow("invalid_acquisition_response");
      expect(parseSpy.mock.calls.some(([raw]) => raw === oversizedResponse)).toBe(false);
      expect(f.transport.mock.calls.at(-1)[0].id).toBe("fullJobPass1");
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("still parses an envelope exactly at the per-call byte limit", async () => {
    const f = fixture();
    let boundaryResponse;
    f.transport.mockImplementation(async (request, context) => {
      const response = { schema: CONTRACT.responseSchema, mode: "TEST_ONLY",
        id: request.id, sequence: request.sequence, requestSha256: request.requestSha256,
        provenance: request.provenance, complete: true, settled: true, isError: false,
        payload: payloadFor(request) };
      if (request.id === "fullJobPass1") {
        const emptyBytes = Buffer.byteLength(JSON.stringify({ ...response, payload: "" }), "utf8");
        response.payload = "x".repeat(context.maxBytes - emptyBytes);
        boundaryResponse = JSON.stringify(response);
        expect(Buffer.byteLength(boundaryResponse, "utf8")).toBe(context.maxBytes);
        return boundaryResponse;
      }
      return JSON.stringify(response);
    });
    const parse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((...args) => parse(...args));
    try {
      await expect(f.reader().read()).rejects.toThrow("invalid_acquisition_response");
      expect(parseSpy.mock.calls.some(([raw]) => raw === boundaryResponse)).toBe(true);
    } finally {
      parseSpy.mockRestore();
    }
  });
});
