// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nativeStopReceipt, NativeStopFailure, type NativeStopRequest } from "./native-stop-admission";

// OVD-575/576 SQL owns evidence validation and atomic occupancy release. These
// tests cover the retained parent's consumer boundary, never worker-made proof.
const request: NativeStopRequest = { workerId: "worker", bootId: "boot", taskId: "task", attemptId: "attempt",
  fence: 4, evidenceId: "evidence", revision: 7, idempotencyKey: "key" };
const receipt = { outcome: "process_stopped", attemptId: "attempt", revision: 8, taskRevision: 10,
  resultEligible: false, phase: "failed", failureCode: "native_failed", verification: "unverified" };
describe("native stop receipt boundary", () => {
  it("preserves stopped but ineligible outcomes without granting result verification", () => {
    expect(nativeStopReceipt(receipt, request)).toEqual(receipt);
  });
  it.each([
    { verification: "verified" }, { resultEligible: true }, { attemptId: "other" },
    { revision: 7 }, { failureCode: "" }, { taskRevision: -1 }, { verdict: "all_owned_processes_exited" },
  ])("treats malformed committed receipt as unknown, not rejected or verified: %j", (patch) => {
    try {
      nativeStopReceipt({ ...receipt, ...patch }, request);
      throw new Error("unexpected acceptance");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeStopFailure);
      expect(error).toMatchObject({ status: 503, code: "stop_outcome_unknown", uncertain: true });
    }
  });
});
