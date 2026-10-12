import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  declareExistingJobExportStatus,
  getJobExportControlStatus,
  isJobExportDispatchHeld,
  parseJobExportControlStatus,
  requestExportControlRescan,
} from "./export-control-api";
import { EXPORT_CONTROL_TERMS_VERSION } from "@/features/quotes/export-control";

// OVD-723 existing-job path: declare on an existing job and request a rescan.

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: rpcMock },
}));

describe("existing-job export control API", () => {
  beforeEach(() => rpcMock.mockReset());

  it("reads a backfilled job as held", async () => {
    rpcMock.mockResolvedValue({
      data: { jobId: "job-1", latestAnswer: "missing", exportReviewState: "clear", partsMissingScan: 2, rescansPending: 0 },
      error: null,
    });
    const status = await getJobExportControlStatus("job-1");
    expect(rpcMock).toHaveBeenCalledWith("api_get_job_export_control_status", { p_job_id: "job-1" });
    expect(status).toEqual({
      jobId: "job-1",
      latestAnswer: "missing",
      reviewState: "clear",
      partsMissingScan: 2,
      rescansPending: 0,
    });
    expect(isJobExportDispatchHeld(status)).toBe(true);
  });

  it("fails closed on an unparseable status", () => {
    const status = parseJobExportControlStatus("job-1", { latestAnswer: "bogus", exportReviewState: "?" });
    expect(status).toMatchObject({ latestAnswer: "missing", reviewState: "blocked_pending_review", partsMissingScan: 1 });
    expect(isJobExportDispatchHeld(status)).toBe(true);
    expect(isJobExportDispatchHeld(parseJobExportControlStatus("job-1", null))).toBe(true);
  });

  it("is not held only with a clean answer, no review, and every part scanned", () => {
    const clean = parseJobExportControlStatus("job-1", {
      latestAnswer: "not_controlled",
      exportReviewState: "clear",
      partsMissingScan: 0,
    });
    expect(isJobExportDispatchHeld(clean)).toBe(false);
    expect(isJobExportDispatchHeld({ ...clean, partsMissingScan: 1 })).toBe(true);
    expect(isJobExportDispatchHeld({ ...clean, reviewState: "confirmed_controlled" })).toBe(true);
    expect(isJobExportDispatchHeld({ ...clean, latestAnswer: "unsure" })).toBe(true);
  });

  it.each(["not_controlled", "controlled", "unsure"] as const)(
    "declares %s on the existing job through the upload declaration RPC",
    async (answer) => {
      rpcMock.mockResolvedValue({
        data: { declarationId: "decl-1", answer, uploadAllowed: answer === "not_controlled" },
        error: null,
      });
      const result = await declareExistingJobExportStatus("job-1", answer);
      expect(rpcMock).toHaveBeenCalledWith("api_declare_job_export_status", {
        p_job_id: "job-1",
        p_answer: answer,
        p_terms_version: EXPORT_CONTROL_TERMS_VERSION,
      });
      expect(result).toEqual({ answer, declarationClean: answer === "not_controlled" });
    },
  );

  it("rejects an invalid answer without calling the server", async () => {
    await expect(declareExistingJobExportStatus("job-1", "missing" as never)).rejects.toThrow(
      "export_declaration_invalid",
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("throws on a declaration error or an unexpected response", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "export_declaration_forbidden" } });
    await expect(declareExistingJobExportStatus("job-1", "not_controlled")).rejects.toMatchObject({
      message: "export_declaration_forbidden",
    });
    rpcMock.mockResolvedValueOnce({ data: { declarationId: "decl-1", answer: "unsure" }, error: null });
    await expect(declareExistingJobExportStatus("job-1", "not_controlled")).rejects.toThrow(
      "export_declaration_missing",
    );
  });

  it("requests a rescan and checks the response", async () => {
    rpcMock.mockResolvedValueOnce({ data: { jobId: "job-1", tasksQueued: 3, requestedAs: "member" }, error: null });
    await expect(requestExportControlRescan("job-1")).resolves.toEqual({ tasksQueued: 3 });
    expect(rpcMock).toHaveBeenCalledWith("api_request_export_control_rescan", { p_job_id: "job-1" });

    rpcMock.mockResolvedValueOnce({ data: { jobId: "other", tasksQueued: 3 }, error: null });
    await expect(requestExportControlRescan("job-1")).rejects.toThrow("export_rescan_failed");
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "export_rescan_forbidden" } });
    await expect(requestExportControlRescan("job-1")).rejects.toMatchObject({ message: "export_rescan_forbidden" });
  });
});
