// @vitest-environment node
import { createHash, Hash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compatibilityFixture } from "./ovd419-acquisition-test-fixtures.mjs";
import { createSyntheticAcquisitionPrefix, SYNTHETIC_PREFIX_CONTRACT as CONTRACT } from "./ovd419-synthetic-acquisition-prefix.mjs";
import { SYNTHETIC_CATALOGUE_CONTRACT } from "./ovd419-synthetic-catalogue-reader.mjs";

import { prefixEgressFixtures } from "./ovd419-reader-test-fixtures.mjs";
const { compliantEgress } = prefixEgressFixtures;
const sha = value => createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);

function fixture({ roleCount = 1, changeEgress = () => {}, changeResponse = () => {}, hangAt = null } = {}) {
  const compatibility = compatibilityFixture(); const evidence = compliantEgress(roleCount); changeEgress(evidence);
  const catalogue = compatibility.input.observations[0].payload; const containment = compatibility.input.observations[1].payload;
  const calls = []; let active = 0; let maximumActive = 0;
  let signalHungStart;
  const hungStarted = new Promise(resolve => { signalHungStart = resolve; });
  const byPrefix = new Map([
    ["run services describe", evidence.service], ["run jobs describe", evidence.job], ["run services get-iam-policy", evidence.iamPolicy],
    ["run jobs get-iam-policy", evidence.jobIamPolicy], ["projects get-iam-policy", evidence.projectIamPolicy], ["compute networks describe", evidence.network],
    ["compute networks subnets describe", evidence.subnet], ["compute routers describe", evidence.router], ["compute routers nats describe", evidence.nat],
    ["compute addresses describe", evidence.address], ["compute routes list", evidence.routes], ["network-connectivity policy-based-routes list", evidence.policyBasedRoutes],
    ["compute routers get-nat-mapping-info", evidence.natMappings], ["run jobs executions list", evidence.jobExecutions],
  ]);
  const qualification = { mode: "TEST_ONLY", acquisitionSourceCommit: compatibility.qualification.acquisitionSourceCommit, inputManifestSha256: compatibility.qualification.inputManifestSha256, invocationId: "TEST_ONLY_prefix" };
  const transport = vi.fn(async (request) => {
    calls.push(request); active += 1; maximumActive = Math.max(maximumActive, active);
    try {
      if (request.id === hangAt) {
        signalHungStart();
        return await new Promise(() => {});
      }
      let payload;
      if (request.id === "catalogue") payload = catalogue;
      else if (request.id === "containmentOpening") payload = containment;
      else if (request.id.startsWith("IAM")) payload = JSON.stringify({ includedPermissions: request.id === "IAM01" ? ["run.jobs.get", "run.executions.list"] : [`test.permission${request.id}`] });
      else {
        const match = [...byPrefix.entries()].find(([prefix]) => request.args.join(" ").startsWith(prefix));
        if (!match) throw new Error("TEST_ONLY_unexpected_command"); payload = JSON.stringify(clone(match[1]));
      }
      const response = request.id === "catalogue"
        ? { ...request, schema: SYNTHETIC_CATALOGUE_CONTRACT.responseSchema, complete: true, settled: true, isError: false, payload }
        : { schema: CONTRACT.responseSchema, mode: "TEST_ONLY", id: request.id, sequence: request.sequence, requestSha256: request.requestSha256, provenance: request.provenance, complete: true, settled: true, isError: false, payload };
      changeResponse(response, request); return JSON.stringify(response);
    } finally { active -= 1; }
  });
  return { calls, hungStarted, qualification, transport, get maximumActive() { return maximumActive; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("synthetic acquisition prefix", () => {
  it("reads the exact 21-call minimum serially and stops before full resources", async () => {
    const f = fixture(); const reader = createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification });
    const result = await reader.read();
    expect(result.schema).toBe(CONTRACT.resultSchema); expect(result.usage).toEqual(expect.objectContaining({ calls: 21, sqlCalls: 2, cloudCalls: 19 }));
    expect(result.observations.map(item => item.sequence)).toEqual([...Array(21).keys()]);
    expect(result.observations.slice(2, 20).map(item => item.id)).toEqual(Array.from({ length: 18 }, (_, index) => `E${String(index + 1).padStart(2, "0")}`));
    expect(result.observations.at(-1).id).toBe("IAM01");
    expect(result.observations.at(-1).args).toEqual(["iam", "roles", "describe", "roles/run.viewer", "--format=json(includedPermissions)"]);
    expect(result.usage.receivedBytes).toBe(result.observations.reduce((total, item) => total + item.payloadBytes, 0));
    for (const item of result.observations) { expect(item.responseSha256).toBe(sha(item.responseRaw)); expect(item.payloadSha256).toBe(sha(item.payload)); expect(item.complete).toBe(true); expect(item.settled).toBe(true); }
    expect(result).toMatchObject({ prefixQualified: true, transportQualified: false, fullAcquisitionQualified: false, privateBindingReady: false });
    expect(result.egressCatalogueSha256).toBe("8bfe1fb3b1499e2ed3b5983719e1e0fd132b9298574aeeeb6db64a8dd52197ba");
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.observations)).toBe(true); expect(Object.isFrozen(result.usage)).toBe(true); expect(f.maximumActive).toBe(1);
    expect(f.calls.some(request => ["fullJob", "fullService", "completedExecution"].includes(request.id))).toBe(false);
    await expect(reader.read()).rejects.toThrow("request_budget_exhausted"); expect(f.transport).toHaveBeenCalledTimes(21);
  });

  it("accepts exactly 50 selected roles for the 70-call maximum", async () => {
    const f = fixture({ roleCount: 50 }); const result = await createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification }).read();
    expect(result.usage).toEqual(expect.objectContaining({ calls: 70, sqlCalls: 2, cloudCalls: 68 })); expect(result.observations.at(-1).sequence).toBe(69); expect(f.maximumActive).toBe(1);
  });

  it("consumes the attempt after an attributable envelope mismatch", async () => {
    const f = fixture({ changeResponse: (response, request) => { if (request.id === "containmentOpening") response.sequence += 1; } });
    const reader = createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification });
    await expect(reader.read()).rejects.toThrow("invalid_prefix_response"); await expect(reader.read()).rejects.toThrow("request_budget_exhausted"); expect(f.transport).toHaveBeenCalledTimes(2);
  });

  it("terminates before IAM when stable-egress rejects", async () => {
    const f = fixture({ changeEgress: evidence => { evidence.service.spec.template.metadata.annotations["run.googleapis.com/vpc-access-egress"] = "private-ranges-only"; } });
    const reader = createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification });
    await expect(reader.read()).rejects.toThrow("stable_egress_rejected"); await expect(reader.read()).rejects.toThrow("request_budget_exhausted"); expect(f.transport).toHaveBeenCalledTimes(20);
  });

  it("aborts a hung read at the tightened deadline and never retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const f = fixture({ hangAt: "containmentOpening" });
    const reader = createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification, perReadMs: 10, totalDurationMs: 100 });
    const outcome = reader.read().catch(error => error.message);
    const firstSettled = await Promise.race([f.hungStarted.then(() => "second_read"), outcome.then(() => "early_failure")]);
    expect(firstSettled).toBe("second_read");
    expect(f.transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBe("read_timeout"); await expect(reader.read()).rejects.toThrow("request_budget_exhausted"); expect(f.transport).toHaveBeenCalledTimes(2); expect(f.transport.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it("counts response validation and observation hashes inside each read deadline", async () => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const update = Hash.prototype.update;
    vi.spyOn(Hash.prototype, "update").mockImplementation(function (data, ...args) {
      if (typeof data === "string" && data.includes("OVD419-PREFLIGHT-CONTAINMENT-NOT-AUTHORITY")) now = 35;
      return update.call(this, data, ...args);
    });
    const reader = createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification, perReadMs: 30, totalDurationMs: 1000 });
    await expect(reader.read()).rejects.toThrow("read_timeout");
    await expect(reader.read()).rejects.toThrow("request_budget_exhausted");
    expect(f.transport).toHaveBeenCalledTimes(2);
  });

  it("counts catalogue observation metadata inside the catalogue deadline", async () => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const update = Hash.prototype.update;
    vi.spyOn(Hash.prototype, "update").mockImplementation(function (data, ...args) {
      if (typeof data === "string" && data.includes(SYNTHETIC_CATALOGUE_CONTRACT.requestSchema)) now = 35;
      return update.call(this, data, ...args);
    });
    const reader = createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification, perReadMs: 30, totalDurationMs: 1000 });
    await expect(reader.read()).rejects.toThrow("read_timeout");
    await expect(reader.read()).rejects.toThrow("request_budget_exhausted");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it("counts final result fingerprint work inside the shared deadline", async () => {
    const f = fixture(); let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const update = Hash.prototype.update;
    vi.spyOn(Hash.prototype, "update").mockImplementation(function (data, ...args) {
      if (typeof data === "string" && data.startsWith("{\"policy\":") && data.includes("\"permissions\":")) now = 1001;
      return update.call(this, data, ...args);
    });
    const reader = createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification, totalDurationMs: 1000 });
    await expect(reader.read()).rejects.toThrow("prefix_total_timeout");
    await expect(reader.read()).rejects.toThrow("request_budget_exhausted");
    expect(f.transport).toHaveBeenCalledTimes(21);
  });

  it("requires injected transport and only tighter fixed budgets", () => {
    const f = fixture(); expect(() => createSyntheticAcquisitionPrefix({ qualification: f.qualification })).toThrow("transport_required");
    expect(() => createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification, perReadMs: 30001 })).toThrow("invalid_prefix_limits");
    expect(() => createSyntheticAcquisitionPrefix({ transport: f.transport, qualification: f.qualification, totalDurationMs: 900001 })).toThrow("invalid_prefix_limits");
  });

  it("rejects unknown budget and option names before calling transport", () => {
    const f = fixture();
    expect(() => createSyntheticAcquisitionPrefix({
      transport: f.transport,
      qualification: f.qualification,
      perReadMS: 10,
    })).toThrow("invalid_prefix_options");
    expect(() => createSyntheticAcquisitionPrefix({
      transport: f.transport,
      qualification: f.qualification,
      unexpectedOption: true,
    })).toThrow("invalid_prefix_options");
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("rejects hidden and symbol-named budget options before calling transport", () => {
    const f = fixture();
    const hiddenTypo = { transport: f.transport, qualification: f.qualification };
    Object.defineProperty(hiddenTypo, "perReadMS", { value: 10 });
    expect(() => createSyntheticAcquisitionPrefix(hiddenTypo)).toThrow("invalid_prefix_options");
    expect(() => createSyntheticAcquisitionPrefix({
      transport: f.transport,
      qualification: f.qualification,
      [Symbol("perReadMs")]: 10,
    })).toThrow("invalid_prefix_options");
    expect(f.transport).not.toHaveBeenCalled();
  });
});
