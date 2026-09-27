// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseExactStepReview } from "./exact-step-review";

const taskId = "11111111-1111-4111-8111-000000000001";
const candidateSnapshotId = "11111111-1111-4111-8111-000000000002";
const sourceSnapshotId = "11111111-1111-4111-8111-000000000003";
const bundle = JSON.parse(readFileSync("server/engineering/fixtures/preview-7mm/preview.json", "utf8"));
function ready() {
  return {
    status: "ready", taskId, attemptId: "11111111-1111-4111-8111-000000000004",
    sourceSnapshotId, candidateSnapshotId, candidateContextSha256: "a".repeat(64),
    resultSha256: "b".repeat(64), exportId: "11111111-1111-4111-8111-000000000005",
    sourceCommit: "c".repeat(40), reportSha256: "d".repeat(64),
    stepSha256: bundle.step.sha256, stepBytes: bundle.step.bytes,
    stepBase64: bundle.step.base64,
  };
}
const expected = { taskId, candidateSnapshotId };

describe("authenticated exact STEP response", () => {
  it("hands the renderer only measured bytes bound to the selected candidate", async () => {
    const result = await parseExactStepReview(ready(), expected);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("No STEP");
    const bytes = await result.review.source.loadStepBuffer();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(bundle.step.sha256);
    expect(result.review.source.cacheKey).toContain(candidateSnapshotId);
    bytes[0] = 0;
    expect((await result.review.source.loadStepBuffer())[0]).not.toBe(0);
  });
  it("keeps missing and unverified geometry unavailable", async () => {
    expect(await parseExactStepReview({ status: "unavailable", reason: "not_exported" }, expected))
      .toEqual({ status: "unavailable", reason: "not_exported" });
    expect(await parseExactStepReview({ status: "unavailable", reason: "not_verified" }, expected))
      .toEqual({ status: "unavailable", reason: "not_verified" });
  });
  it("rejects stale, substituted, or malformed bytes before rendering", async () => {
    await expect(parseExactStepReview(ready(), { ...expected, candidateSnapshotId: sourceSnapshotId }))
      .rejects.toThrow(/binding/);
    await expect(parseExactStepReview({ ...ready(), stepSha256: "e".repeat(64) }, expected))
      .rejects.toThrow(/bytes differ/);
    await expect(parseExactStepReview({ ...ready(), stepBase64: bundle.step.base64.slice(4) }, expected))
      .rejects.toThrow();
    await expect(parseExactStepReview({ ...ready(), taskId: sourceSnapshotId }, expected))
      .rejects.toThrow(/binding/);
  });
});
