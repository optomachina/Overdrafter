// @vitest-environment node
import { createHash, Hash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSyntheticCatalogueReader,
  SYNTHETIC_CATALOGUE_CONTRACT as CONTRACT,
} from "./ovd419-synthetic-catalogue-reader.mjs";

const qualification = () => ({
  mode: "TEST_ONLY",
  acquisitionSourceCommit: "a".repeat(40),
  inputManifestSha256: "b".repeat(64),
  invocationId: "TEST_ONLY_catalogue_1",
});
const payload = () => JSON.stringify([{ evidence: {
  schema: "OVD419-DIAGNOSTIC-CATALOGUE-COMPATIBILITY-NOT-AUTHORITY-v1",
  relationCount: 4,
  rows: [{ kind: "synthetic", identity: "fixture", definition: { description: "inert fixture" } }],
} }]);
const envelope = (request, changes = {}) => JSON.stringify({
  schema: CONTRACT.responseSchema,
  mode: "TEST_ONLY",
  id: "catalogue",
  sequence: 0,
  requestSha256: request.requestSha256,
  provenance: { ...request.provenance },
  complete: true,
  settled: true,
  isError: false,
  payload: payload(),
  ...changes,
});
const reader = (transport, options = {}) => createSyntheticCatalogueReader({
  transport, qualification: qualification(), ...options,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("B1 synthetic catalogue acquisition", () => {
  it("preserves structured definitions from the pinned catalogue query", async () => {
    const structuredPayload = JSON.stringify([{ evidence: {
      schema: "OVD419-DIAGNOSTIC-CATALOGUE-COMPATIBILITY-NOT-AUTHORITY-v1",
      relationCount: 4,
      rows: [{ kind: "relation", identity: "public.work_queue", definition: {
        kind: "r", rls: true, forceRls: false, owner: "TEST_ONLY_RPC_OWNER", acl: null,
      } }],
    } }]);
    const result = await reader(request => envelope(request, { payload: structuredPayload })).read();
    expect(result.payload).toBe(structuredPayload);
    expect(result.payloadSha256).toBe(createHash("sha256").update(structuredPayload).digest("hex"));
    expect(result.compatibilityValidated).toBe(false);
  });

  it.each(["inert fixture", "", null, [], 1, true])("rejects non-object catalogue definitions %#", async definition => {
    const rows = JSON.parse(payload());
    rows[0].evidence.rows[0].definition = definition;
    const transport = vi.fn(request => envelope(request, { payload: JSON.stringify(rows) }));
    const instance = reader(transport);
    await expect(instance.read()).rejects.toThrow("invalid_catalogue");
    await expect(instance.read()).rejects.toThrow("request_budget_exhausted");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate keys inside catalogue definitions", async () => {
    const ambiguous = payload().replace('"description":"inert fixture"', '"description":"inert fixture","description":"other"');
    await expect(reader(request => envelope(request, { payload: ambiguous })).read()).rejects.toThrow("noncanonical_json");
  });

  it("bounds nesting inside catalogue definitions", async () => {
    const rows = JSON.parse(payload());
    let definition = {};
    for (let i = 0; i < 17; i++) definition = { nested: definition };
    rows[0].evidence.rows[0].definition = definition;
    await expect(reader(request => envelope(request, { payload: JSON.stringify(rows) })).read()).rejects.toThrow("json_depth_limit");
  });

  it("preserves exact payload bytes and pins, with immutable non-authority output", async () => {
    const transport = vi.fn(async request => envelope(request));
    const result = await reader(transport).read();
    expect(transport).toHaveBeenCalledTimes(1);
    const [request, context] = transport.mock.calls[0];
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.provenance)).toBe(true);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.maxBytes).toBe(CONTRACT.maxResponseBytes);
    expect(result).toMatchObject({
      mode: "TEST_ONLY", calls: 1, compatibilityValidated: false,
      privateBindingReady: false, sqlRuntimeQualified: false,
      payload: payload(), payloadBytes: Buffer.byteLength(payload()),
      payloadSha256: createHash("sha256").update(payload()).digest("hex"),
    });
    expect(result.provenance).toEqual(request.provenance);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
  });

  it("snapshots the trusted qualification before any request", async () => {
    const pins = qualification();
    const instance = reader(async request => envelope(request), { qualification: pins });
    pins.inputManifestSha256 = "c".repeat(64);
    expect((await instance.read()).provenance.inputManifestSha256).toBe("b".repeat(64));
  });

  it("reserves the only request before awaiting, including concurrent calls", async () => {
    let finish;
    const transport = vi.fn(request => new Promise(resolve => { finish = () => resolve(envelope(request)); }));
    const instance = reader(transport);
    const pending = instance.read();
    await expect(instance.read()).rejects.toThrow("request_budget_exhausted");
    await Promise.resolve();
    finish();
    await pending;
    await expect(instance.read()).rejects.toThrow("request_budget_exhausted");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["throw", "reject", "malformed"])("never retries after %s", async failure => {
    const transport = vi.fn(() => {
      if (failure === "throw") throw new Error("private response details");
      if (failure === "reject") return Promise.reject(new Error("private response details"));
      return "not json";
    });
    const instance = reader(transport);
    await expect(instance.read()).rejects.toThrow(failure === "malformed" ? "invalid_json" : "transport_failed");
    await expect(instance.read()).rejects.toThrow("request_budget_exhausted");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("aborts on timeout and cannot recover from a late response", async () => {
    vi.useFakeTimers();
    let finish, signal;
    const instance = reader((request, context) => {
      signal = context.signal;
      return new Promise(resolve => { finish = () => resolve(envelope(request)); });
    }, { timeoutMs: 5 });
    const pending = expect(instance.read()).rejects.toThrow("read_timeout");
    await vi.advanceTimersByTimeAsync(5);
    await pending;
    expect(signal.aborted).toBe(true);
    finish();
    await expect(instance.read()).rejects.toThrow("request_budget_exhausted");
  });

  it("rejects an overdue response even if the timer has not run", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(20);
    await expect(reader(request => envelope(request), { timeoutMs: 10 }).read()).rejects.toThrow("read_timeout");
  });

  it.each([5, 10, 20])("includes result hashing in the deadline and completion timing at %i ms", async elapsed => {
    vi.useFakeTimers();
    const epoch = Date.UTC(2026, 8, 12);
    vi.setSystemTime(epoch);
    let now = 0;
    let signal;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const digest = Hash.prototype.digest;
    vi.spyOn(Hash.prototype, "digest").mockImplementation(function (...args) {
      now = elapsed;
      vi.setSystemTime(epoch + elapsed);
      return digest.apply(this, args);
    });
    const transport = vi.fn((request, context) => {
      signal = context.signal;
      return envelope(request);
    });
    const instance = reader(transport, { timeoutMs: 10 });
    if (elapsed < 10) {
      const result = await instance.read();
      expect(result.elapsedMs).toBe(elapsed);
      expect(result.completedAt).toBe(new Date(epoch + elapsed).toISOString());
      expect(signal.aborted).toBe(false);
    } else {
      await expect(instance.read()).rejects.toThrow("read_timeout");
      expect(signal.aborted).toBe(true);
    }
    await expect(instance.read()).rejects.toThrow("request_budget_exhausted");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not expose transport exception contents", async () => {
    await expect(reader(() => { throw new Error("sensitive fixture detail"); }).read())
      .rejects.toEqual(new Error("transport_failed"));
  });

  it("requires explicit transport injection", () => {
    expect(() => createSyntheticCatalogueReader()).toThrow("transport_required");
  });

  it("rejects accessors without executing qualification getters", () => {
    const pins = qualification();
    const getter = vi.fn(() => "TEST_ONLY");
    Object.defineProperty(pins, "mode", { get: getter });
    expect(() => reader(vi.fn(), { qualification: pins })).toThrow("invalid_qualification");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ["mode", "LIVE"], ["schema", "unknown"], ["id", "other"], ["sequence", 1],
    ["complete", false], ["settled", false], ["isError", true],
    ["requestSha256", "c".repeat(64)], ["extra", true], ["payload", {}],
  ])("rejects an invalid envelope field %s", async (key, value) => {
    await expect(reader(request => envelope(request, { [key]: value })).read()).rejects.toThrow();
  });

  it.each(["acquisitionSourceCommit", "inputManifestSha256", "invocationId", "diagnosticSourceCommit", "readPlanSha256"])(
    "rejects mismatched provenance %s", async key => {
      await expect(reader(request => envelope(request, {
        provenance: { ...request.provenance, [key]: "wrong" },
      })).read()).rejects.toThrow("provenance_mismatch");
    },
  );

  it("rejects omitted and extra provenance fields", async () => {
    for (const provenance of [{}, { ...qualification(), extra: true }]) {
      await expect(reader(request => envelope(request, { provenance })).read()).rejects.toThrow("provenance_mismatch");
    }
  });

  it.each([
    raw => raw.replace('"mode":"TEST_ONLY"', '"mode":"TEST_ONLY","mode":"TEST_ONLY"'),
    raw => raw.replace('"mode":"TEST_ONLY"', '"mode":"TEST_ONLY","m\\u006fde":"TEST_ONLY"'),
    raw => ` ${raw}`,
    raw => `${raw} trailing`,
    () => ({ complete: true }),
    () => "[".repeat(17) + "0" + "]".repeat(17),
  ])("rejects ambiguous, noncanonical or excessive envelope structure %#", async change => {
    await expect(reader(request => change(envelope(request))).read()).rejects.toThrow();
  });

  it("enforces byte limits rather than character counts", async () => {
    const text = "é".repeat(600);
    await expect(reader(() => JSON.stringify(text), { maxResponseBytes: 1000 }).read()).rejects.toThrow("response_byte_limit");
  });

  it("accepts exactly the response byte ceiling and rejects one byte over", async () => {
    const request = { requestSha256: CONTRACT.requestSha256, provenance: {
      acquisitionSourceCommit: qualification().acquisitionSourceCommit,
      inputManifestSha256: qualification().inputManifestSha256,
      invocationId: qualification().invocationId,
      diagnosticSourceCommit: CONTRACT.diagnosticSourceCommit,
      readPlanSha256: CONTRACT.readPlanSha256,
    } };
    const bytes = Buffer.byteLength(envelope(request));
    await expect(reader(r => envelope(r), { maxResponseBytes: bytes }).read()).resolves.toMatchObject({ responseBytes: bytes });
    await expect(reader(r => envelope(r), { maxResponseBytes: bytes - 1 }).read()).rejects.toThrow("response_byte_limit");
  });

  it("independently bounds payload bytes", async () => {
    const largePayload = JSON.stringify("x".repeat(CONTRACT.maxPayloadBytes));
    await expect(reader(request => envelope(request, { payload: largePayload })).read()).rejects.toThrow("payload_byte_limit");
  });

  it("bounds structural tokens before JSON parsing", async () => {
    const excessive = "[" + "0,".repeat(131073) + "0]";
    await expect(reader(() => excessive).read()).rejects.toThrow("json_structure_limit");
  });

  it.each([
    "[]", "{}", '[{"evidence":{}},{"evidence":{}}]',
    JSON.stringify([{ evidence: { schema: "wrong", relationCount: 4, rows: [] } }]),
    payload().replace('"relationCount":4', '"relationCount":4,"relationCount":4'),
    payload().replace('"kind":"synthetic"', '"kind":null'),
    payload().replace('"relationCount":4', '"relationCount":3'),
    JSON.stringify([{ evidence: { schema: "OVD419-DIAGNOSTIC-CATALOGUE-COMPATIBILITY-NOT-AUTHORITY-v1", relationCount: 4, rows: Array(2001).fill({ kind: "x", identity: "x", definition: {} }) } }]),
  ])("rejects invalid catalogue payload %#", async badPayload => {
    await expect(reader(request => envelope(request, { payload: badPayload })).read()).rejects.toThrow();
  });

  it.each([
    { mode: "LIVE" }, { acquisitionSourceCommit: "short" },
    { inputManifestSha256: "wrong" }, { invocationId: "unmarked" }, { extra: true },
  ])("rejects invalid qualification before requesting %#", change => {
    const transport = vi.fn();
    expect(() => reader(transport, { qualification: { ...qualification(), ...change } })).toThrow("invalid_qualification");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([{ timeoutMs: 30001 }, { timeoutMs: 0 }, { maxResponseBytes: 2162689 }, { maxResponseBytes: NaN }])(
    "permits only tighter positive integer limits %#", options => {
      expect(() => reader(vi.fn(), options)).toThrow("invalid_limits");
    },
  );
});
