import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ callUntypedRpc: vi.fn() }));
vi.mock("./shared/rpc", () => rpc);

import {
  declareJobExportStatus,
  fetchJobExportControlStatus,
  parseJobExportControlStatus,
  requestExportMarkingRescan,
} from "./export-control-api";

describe("export-control api", () => {
  beforeEach(() => rpc.callUntypedRpc.mockReset());

  it("parses the status strictly", () => {
    expect(
      parseJobExportControlStatus({ jobId: "j", latestAnswer: "missing", latestDeclaredAt: null, exportReviewState: "clear" }),
    ).toEqual({ jobId: "j", latestAnswer: "missing", exportReviewState: "clear", scanState: null });
    expect(parseJobExportControlStatus({ jobId: "j", exportReviewState: "blocked_pending_review" }).latestAnswer).toBeNull();
    for (const bad of [null, [], { jobId: "j", latestAnswer: "maybe", exportReviewState: "clear" }, { jobId: "j", exportReviewState: "open" }]) {
      expect(() => parseJobExportControlStatus(bad)).toThrow();
    }
  });

  it("parses the scan state strictly", () => {
    expect(parseJobExportControlStatus({ jobId: "j", latestAnswer: "not_controlled", exportReviewState: "clear", scanState: "missing" }).scanState)
      .toBe("missing");
    expect(() => parseJobExportControlStatus({ jobId: "j", exportReviewState: "clear", scanState: "done" })).toThrow();
    // Review round 9: the final OCR limit states and the recheck cap.
    for (const scanState of ["drawing_too_many_pages", "drawing_sheet_too_large", "drawing_recheck_limit"]) {
      expect(parseJobExportControlStatus({ jobId: "j", exportReviewState: "clear", scanState }).scanState).toBe(scanState);
    }
  });

  it("requeues rescans through the owner RPC", async () => {
    rpc.callUntypedRpc.mockResolvedValueOnce({ data: 2, error: null });
    await expect(requestExportMarkingRescan("job-1")).resolves.toBe(2);
    expect(rpc.callUntypedRpc).toHaveBeenCalledWith("api_request_export_marking_rescan", { p_job_id: "job-1" });
    rpc.callUntypedRpc.mockResolvedValueOnce({ data: null, error: { message: "export_rescan_not_allowed" } });
    await expect(requestExportMarkingRescan("job-1")).rejects.toMatchObject({ message: "export_rescan_not_allowed" });
  });

  it("reads the status and declares with the current terms version", async () => {
    rpc.callUntypedRpc.mockResolvedValueOnce({
      data: { jobId: "job-1", latestAnswer: null, exportReviewState: "clear" },
      error: null,
    });
    await expect(fetchJobExportControlStatus("job-1")).resolves.toMatchObject({ latestAnswer: null });
    expect(rpc.callUntypedRpc).toHaveBeenCalledWith("api_get_job_export_control_status", { p_job_id: "job-1" });

    rpc.callUntypedRpc.mockResolvedValueOnce({ data: { declarationId: "d" }, error: null });
    await declareJobExportStatus("job-1", "unsure");
    expect(rpc.callUntypedRpc).toHaveBeenLastCalledWith("api_declare_job_export_status", {
      p_job_id: "job-1",
      p_answer: "unsure",
      p_terms_version: "ovd-beta-export-control.v1",
    });

    rpc.callUntypedRpc.mockResolvedValueOnce({ data: null, error: { message: "export_declaration_forbidden" } });
    await expect(declareJobExportStatus("job-1", "not_controlled")).rejects.toMatchObject({
      message: "export_declaration_forbidden",
    });
  });
});
