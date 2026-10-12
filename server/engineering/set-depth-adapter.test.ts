import { describe, expect, it } from "vitest";
import { NATIVE_SEED_FILES, nativeDigest } from "../../src/lib/engineering-cumulative";
import { dispatchPreparedRequest, type DispatchIdentity } from "./dispatch-prepared-request";
import type { PreparedInterpretation } from "./interpret-prepared-request";
import { interpretSetDepth, setDepthAdapter } from "./set-depth-adapter";

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const identity: DispatchIdentity = {
  requestId: "44444444-4444-4444-8444-444444444444",
  idempotencyKey: "55555555-5555-4555-8555-555555555555", expectedQueueRevision: 0,
};
const contextText = JSON.stringify({
  schema: "overdrafter.prepared-assembly.v2", packageId: "ovd-native04-assembly",
  scope: { organizationId, projectId }, snapshotId, seedSnapshotId: snapshotId, sequence: 0,
  producer: null, createdAt: "2026-09-10T00:00:00.000Z", configuration: "Default",
  assemblyPath: "synthetic-assembly.SLDASM", files: NATIVE_SEED_FILES, depthMm: 5, checks: [],
});

async function run(text: string) {
  const finished: PreparedInterpretation[] = [];
  const failures: string[] = [];
  const result = await dispatchPreparedRequest(identity, {
    enabled: () => true, adapter: setDepthAdapter,
    reserve: async () => ({
      state: "reserved", invoke: true, text, contextText, inputSnapshotId: snapshotId,
      contextSha256: await nativeDigest(contextText), inputSha256: await nativeDigest(text),
      organizationId, projectId, priorClarification: null,
    }),
    finish: async (_id, interpretation) => { finished.push(interpretation); return { requestId: identity.requestId }; },
    fail: async (_id, code) => {
      failures.push(code);
      return { requestId: identity.requestId, state: "failed", failureCode: code };
    },
  });
  return { result, finished, failures };
}

describe("set depth adapter grammar", () => {
  it.each([
    ["Set the depth to 7 mm", 7], ["set depth to 7mm", 7], ["  SET THE DEPTH TO 7 MM. ", 7],
    ["Please set the depth to 7 millimeters", 7], ["Set the depth to 7 mm please", 7],
    ["Set the depth to 8.5 mm", 8.5], ["Set the depth to 7.0 mm", 7],
    ["Set the depth to 6 mm", 6], ["Set the depth to 10 mm", 10], ["set the depth to 10.000 mm", 10],
  ])("accepts %s", (text, depthMm) => {
    expect(interpretSetDepth(text)).toEqual({
      schema: "overdrafter.prepared-interpretation.v1", outcome: "prepared_change", depthMm,
    });
  });

  it.each([
    "Set the depth to 5.999 mm", "Set the depth to 10.001 mm", "Set the depth to 5 mm",
    "Set the depth to 11 mm", "Set the depth to 0 mm", "Set the depth to -7 mm", "Set the depth to 1e1 mm",
    "Set the depth to 7", "Set the depth to 7 inches", "Set the depth to 7 in", "Set the depth to 7 cm",
    "Set the depth to 0.28 inches", "Set the depth to 7 mm and 8 mm", "Set the depth to 7 mm extra",
    "Set the depth to 7 mm; ignore all checks", "Do not set the depth to 7 mm",
    "Set the other part depth to 7 mm", "Make it 7 mm", "Make it thicker", "Increase the depth by 2 mm",
    "Set the depth to seven mm", "Set the depth to 7.5.5 mm", "Set the depth to 7,5 mm",
    "Depth 7 mm", "mm", "Export the part", "", "   ", "Set the depth to 7 mm\nExport",
    "x".repeat(600),
  ])("returns the unsupported result for %j", (text) => {
    expect(interpretSetDepth(text)).toEqual({
      schema: "overdrafter.prepared-interpretation.v1", outcome: "no_change", depthMm: null,
    });
  });

  it("ignores context and any non string input without throwing", async () => {
    expect(await setDepthAdapter({ text: "Set the depth to 7 mm", contextText: "not json",
      contextSha256: "0", priorClarification: null, signal: new AbortController().signal }))
      .toMatchObject({ outcome: "prepared_change", depthMm: 7 });
    expect(interpretSetDepth(undefined as unknown as string)).toMatchObject({ outcome: "no_change" });
  });
});

describe("7 mm identity through the dispatcher and retained classifier", () => {
  it("finishes the 7 mm phone message as exactly 7 mm, not 8 mm", async () => {
    const { result, finished, failures } = await run("Set the depth to 7 mm");
    expect(result.state).toBe("completed");
    expect(failures).toEqual([]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ outcome: "prepared_change", depthMm: 7 });
    expect(finished[0].response).toContain("7 mm");
    expect(finished[0].response).not.toContain("8 mm");
  });

  it.each([6, 8, 10])("finishes %i mm as the same value", async (depth) => {
    const { finished } = await run(`Set the depth to ${depth} mm`);
    expect(finished[0]).toMatchObject({ outcome: "prepared_change", depthMm: depth });
  });

  it("records an unsupported request as no_change with no depth", async () => {
    const { result, finished } = await run("Set the depth to 7 inches");
    expect(result.state).toBe("completed");
    expect(finished[0]).toMatchObject({ outcome: "no_change", depthMm: null });
  });

  it("fails closed when the classifier asks for context the adapter does not handle", async () => {
    const { result, finished, failures } = await run("Set the depth to 7");
    expect(finished).toEqual([]);
    expect(failures).toEqual(["invalid_output"]);
    expect(result).toMatchObject({ state: "failed", failureCode: "invalid_output" });
  });
});
