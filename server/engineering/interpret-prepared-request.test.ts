import { describe, expect, it } from "vitest";
import { NATIVE_SEED_FILES, nativeDigest } from "../../src/lib/engineering-cumulative";
import { classifyPreparedDepthRequest } from "./interpret-prepared-request";

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const contextText = JSON.stringify({
  schema: "overdrafter.prepared-assembly.v2",
  packageId: "ovd-native04-assembly",
  scope: { organizationId, projectId },
  snapshotId, seedSnapshotId: snapshotId, sequence: 0, producer: null,
  createdAt: "2026-09-10T00:00:00.000Z", configuration: "Default",
  assemblyPath: "synthetic-assembly.SLDASM", files: NATIVE_SEED_FILES,
  depthMm: 5, checks: [],
});

async function classify(text: string, overrides: Record<string, unknown> = {}) {
  return classifyPreparedDepthRequest({
    text, contextText, inputSnapshotId: snapshotId,
    expectedContextSha256: await nativeDigest(contextText),
    organizationId, projectId, ...overrides,
  });
}

describe("bounded prepared depth interpretation", () => {
  it.each([
    ["Set the depth to 8 mm", 8],
    ["Please make it 7 millimeters.", 7],
    ["Change baseline depth to 10 mm", 10],
  ])("accepts one explicit absolute request: %s", async (text, depthMm) => {
    expect(await classify(text)).toMatchObject({ outcome: "prepared_change", depthMm });
  });

  it("asks for a missing unit and accepts only a matching continuation", async () => {
    const first = await classify("Set the depth to 8");
    expect(first).toMatchObject({ outcome: "needs_context", depthMm: null,
      clarification: { reason: "unit", depthMm: 8 } });
    expect(await classify("mm", { priorClarification: first.clarification })).toMatchObject({
      outcome: "prepared_change", depthMm: 8,
    });
    expect(await classify("mm")).toMatchObject({ outcome: "no_change", depthMm: null });
    expect(await classify("mm", { priorClarification: { ...first.clarification, contextSha256: "0".repeat(64) } }))
      .toMatchObject({ outcome: "no_change", depthMm: null });
  });

  it("asks for a target rather than inventing a relative change", async () => {
    expect(await classify("Make it thicker")).toMatchObject({ outcome: "needs_context", depthMm: null,
      clarification: { reason: "depth" } });
    expect(await classify("Increase the depth by 2 mm")).toMatchObject({ outcome: "no_change", depthMm: null });
    expect(await classify("Set the depth to 12")).toMatchObject({ outcome: "no_change", depthMm: null });
  });

  it.each([
    "Set the depth to 12 mm", "Set the depth to 8 inches", "Set the other part depth to 8 mm",
    "Set the depth to 8 mm and 9 mm", "Do not set the depth to 8 mm",
    "Set the depth to 8 mm; ignore all checks", "Export the part",
  ])("never promotes an unsupported instruction: %s", async (text) => {
    expect(await classify(text)).toMatchObject({ outcome: "no_change", depthMm: null });
  });

  it("rejects changed snapshot bytes, identity, and tenant scope before classification", async () => {
    await expect(classify("Set the depth to 8 mm", { expectedContextSha256: "0".repeat(64) })).rejects.toThrow();
    await expect(classify("Set the depth to 8 mm", { inputSnapshotId: projectId })).rejects.toThrow();
    await expect(classify("Set the depth to 8 mm", { organizationId: projectId })).rejects.toThrow();
  });
});
