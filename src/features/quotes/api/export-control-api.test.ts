import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ callUntypedRpc: vi.fn() }));
vi.mock("./shared/rpc", () => rpc);

import {
  declareJobExportStatus,
  fetchJobExportControlStatus,
  parseJobExportControlStatus,
} from "./export-control-api";

describe("export-control api", () => {
  beforeEach(() => rpc.callUntypedRpc.mockReset());

  it("parses the status strictly", () => {
    expect(
      parseJobExportControlStatus({ jobId: "j", latestAnswer: "missing", latestDeclaredAt: null, exportReviewState: "clear" }),
    ).toEqual({ jobId: "j", latestAnswer: "missing", exportReviewState: "clear" });
    expect(parseJobExportControlStatus({ jobId: "j", exportReviewState: "blocked_pending_review" }).latestAnswer).toBeNull();
    for (const bad of [null, [], { jobId: "j", latestAnswer: "maybe", exportReviewState: "clear" }, { jobId: "j", exportReviewState: "open" }]) {
      expect(() => parseJobExportControlStatus(bad)).toThrow();
    }
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
