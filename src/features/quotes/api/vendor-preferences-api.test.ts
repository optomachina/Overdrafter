import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchJobVendorPreferenceContext,
  setJobVendorPreferences,
  setProjectVendorPreferences,
} from "./vendor-preferences-api";

const { callUntypedRpcMock } = vi.hoisted(() => ({
  callUntypedRpcMock: vi.fn(),
}));

vi.mock("./shared/rpc", () => ({
  callUntypedRpc: callUntypedRpcMock,
}));

describe("vendor-preferences-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads and normalizes job vendor preference context", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        jobId: "job-1",
        projectId: "project-1",
        organizationId: "org-1",
        availableVendors: ["fictiv", "xometry", "fictiv"],
        projectVendorPreferences: {
          includedVendors: ["xometry"],
          excludedVendors: ["protolabs", "protolabs"],
          updatedAt: "2026-04-08T18:00:00Z",
        },
        jobVendorPreferences: {
          includedVendors: ["fictiv"],
          excludedVendors: [],
          updatedAt: null,
        },
      },
      error: null,
    });

    const result = await fetchJobVendorPreferenceContext("job-1");

    expect(callUntypedRpcMock).toHaveBeenCalledWith("api_get_job_vendor_preferences", {
      p_job_id: "job-1",
    });
    expect(result).toEqual({
      jobId: "job-1",
      projectId: "project-1",
      organizationId: "org-1",
      availableVendors: ["fictiv", "xometry"],
      projectVendorPreferences: {
        includedVendors: ["xometry"],
        excludedVendors: ["protolabs"],
        updatedAt: "2026-04-08T18:00:00Z",
      },
      jobVendorPreferences: {
        includedVendors: ["fictiv"],
        excludedVendors: [],
        updatedAt: null,
      },
    });
  });

  it("persists project and part vendor preferences via RPC", async () => {
    callUntypedRpcMock
      .mockResolvedValueOnce({
        data: {
          includedVendors: ["xometry"],
          excludedVendors: ["fictiv"],
          updatedAt: "2026-04-08T18:00:00Z",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          includedVendors: ["protolabs"],
          excludedVendors: [],
          updatedAt: "2026-04-08T18:10:00Z",
        },
        error: null,
      });

    const projectResult = await setProjectVendorPreferences({
      projectId: "project-1",
      includedVendors: ["xometry"],
      excludedVendors: ["fictiv"],
    });
    const jobResult = await setJobVendorPreferences({
      jobId: "job-1",
      includedVendors: ["protolabs"],
      excludedVendors: [],
    });

    expect(callUntypedRpcMock).toHaveBeenNthCalledWith(1, "api_set_project_vendor_preferences", {
      p_project_id: "project-1",
      p_included_vendors: ["xometry"],
      p_excluded_vendors: ["fictiv"],
    });
    expect(callUntypedRpcMock).toHaveBeenNthCalledWith(2, "api_set_job_vendor_preferences", {
      p_job_id: "job-1",
      p_included_vendors: ["protolabs"],
      p_excluded_vendors: [],
    });

    expect(projectResult).toEqual({
      includedVendors: ["xometry"],
      excludedVendors: ["fictiv"],
      updatedAt: "2026-04-08T18:00:00Z",
    });
    expect(jobResult).toEqual({
      includedVendors: ["protolabs"],
      excludedVendors: [],
      updatedAt: "2026-04-08T18:10:00Z",
    });
  });
});
