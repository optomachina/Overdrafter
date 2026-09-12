// @vitest-environment node
import { createHash, Hash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyntheticCatalogueAcquisition, createSyntheticCatalogueReader, SYNTHETIC_CATALOGUE_CONTRACT as CONTRACT } from "./ovd419-synthetic-catalogue-reader.mjs";
import { validateCatalogueCompatibility, validateAcquisitionCompatibility } from "./ovd419-acquisition-compatibility.mjs";
import { compatibilityFixture } from "./ovd419-acquisition-test-fixtures.mjs";

function fixture(change = () => {}) {
  const { input, qualification } = compatibilityFixture();
  const rows = JSON.parse(input.observations[0].payload);
  change(rows[0].evidence.rows);
  const payload = JSON.stringify(rows);
  const pins = { mode: "TEST_ONLY", acquisitionSourceCommit: qualification.acquisitionSourceCommit,
    inputManifestSha256: qualification.inputManifestSha256, invocationId: input.provenance.invocationId };
  const transport = vi.fn(request => JSON.stringify({ ...request, schema: CONTRACT.responseSchema,
    complete: true, settled: true, isError: false, payload }));
  return { input, qualification, payload, pins, transport };
}
const hash = value => createHash("sha256").update(value).digest("hex");
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("same-invocation catalogue semantic acquisition", () => {
  it("passes captured bytes through retained catalogue semantics without inventing other observations", async () => {
    const f = fixture();
    const expected = validateAcquisitionCompatibility(JSON.stringify(f.input), f.qualification).catalogueFingerprint;
    const acquired = await createSyntheticCatalogueAcquisition({ transport: f.transport, qualification: f.pins }).read();
    expect(acquired.schema).toBe("OVD419-SYNTHETIC-CATALOGUE-ACQUISITION-NOT-AUTHORITY-v1");
    expect(acquired.catalogueFingerprint).toBe(expected);
    expect(validateCatalogueCompatibility(acquired.payload)).toBe(expected);
    expect(acquired.payload).toBe(f.payload);
    expect(acquired.payloadSha256).toBe(hash(f.payload));
    expect(acquired.payloadBytes).toBe(Buffer.byteLength(f.payload));
    expect(acquired.catalogueCompatibilityValidated).toBe(true);
    expect(acquired.compatibilityValidated).toBe(false);
    expect(acquired.privateBindingReady).toBe(false);
    expect(acquired.sqlRuntimeQualified).toBe(false);
    expect(acquired.provenance).toMatchObject({ acquisitionSourceCommit: f.pins.acquisitionSourceCommit,
      inputManifestSha256: f.pins.inputManifestSha256, invocationId: f.pins.invocationId });
    expect(Object.isFrozen(acquired)).toBe(true);
    expect(Object.isFrozen(acquired.provenance)).toBe(true);
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["UUID column", rows => { rows.find(r => r.identity === "public.work_queue.id").definition.type = "text"; }],
    ["required relation", rows => { rows.splice(rows.findIndex(r => r.kind === "relation"), 1); }],
    ["RPC source", rows => { rows.find(r => r.kind === "diagnostic_rpc_contract").definition.source += " "; }],
    ["private schema usage", rows => { rows.find(r => r.kind === "diagnostic_rpc_owner_visibility").definition.ownerSchemaUsage = false; }],
    ["queue privilege", rows => { rows.find(r => r.kind === "diagnostic_queue_privileges").definition.serviceRoleIdSelect = false; }],
    ["enum order", rows => { rows.find(r => r.kind === "enum").definition.labels.reverse(); }],
    ["duplicate identity", rows => { rows.push(structuredClone(rows[0])); }],
  ])("rejects semantically incompatible %s that the structural reader accepts", async (_, change) => {
    const f = fixture(change);
    await expect(createSyntheticCatalogueReader({ transport: f.transport, qualification: f.pins }).read()).resolves.toMatchObject({ compatibilityValidated: false });
    f.transport.mockClear();
    const acquisition = createSyntheticCatalogueAcquisition({ transport: f.transport, qualification: f.pins });
    await expect(acquisition.read()).rejects.toThrow("acquisition_compatibility_rejected");
    expect(f.transport.mock.calls[0][1].signal.aborted).toBe(true);
    await expect(acquisition.read()).rejects.toThrow("request_budget_exhausted");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each([5, 10, 20])("includes semantic fingerprint work in the original deadline at %i ms", async elapsed => {
    const f = fixture();
    vi.useFakeTimers(); const epoch = Date.UTC(2026, 8, 12); vi.setSystemTime(epoch);
    let now = 0, signal;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const update = Hash.prototype.update;
    vi.spyOn(Hash.prototype, "update").mockImplementation(function (data, ...args) {
      let value;
      try { value = JSON.parse(data); } catch { /* The RPC source is not JSON. */ }
      if (value?.schema === "OVD419-DIAGNOSTIC-CATALOGUE-COMPATIBILITY-NOT-AUTHORITY-v1") {
        now = elapsed; vi.setSystemTime(epoch + elapsed);
      }
      return update.call(this, data, ...args);
    });
    const acquisition = createSyntheticCatalogueAcquisition({ qualification: f.pins, timeoutMs: 10,
      transport: (request, context) => { signal = context.signal; return f.transport(request); } });
    if (elapsed < 10) {
      const result = await acquisition.read();
      expect(result.elapsedMs).toBe(elapsed);
      expect(result.completedAt).toBe(new Date(epoch + elapsed).toISOString());
      expect(signal.aborted).toBe(false);
    } else {
      await expect(acquisition.read()).rejects.toThrow("read_timeout");
      expect(signal.aborted).toBe(true);
    }
    await expect(acquisition.read()).rejects.toThrow("request_budget_exhausted");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("rejects provenance substitution before accepting semantic compatibility", async () => {
    const f = fixture();
    const transport = vi.fn(request => {
      const value = JSON.parse(f.transport(request)); value.provenance.invocationId = "TEST_ONLY_other";
      return JSON.stringify(value);
    });
    await expect(createSyntheticCatalogueAcquisition({ transport, qualification: f.pins }).read()).rejects.toThrow("provenance_mismatch");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
