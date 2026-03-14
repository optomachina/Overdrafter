import { describe, expect, it, vi } from "vitest";
import { autoApproveJobRequirements } from "./autoApprove.js";

describe("autoApproveJobRequirements", () => {
  it("calls the auto-approval RPC and returns the approved part count", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: 2,
      error: null,
    });

    await expect(
      autoApproveJobRequirements({ rpc } as unknown as Parameters<typeof autoApproveJobRequirements>[0], "job-123"),
    ).resolves.toBe(2);

    expect(rpc).toHaveBeenCalledWith("api_auto_approve_job_requirements", {
      p_job_id: "job-123",
    });
  });

  it("fails closed when the RPC does not approve any parts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: 0,
      error: null,
    });

    await expect(
      autoApproveJobRequirements({ rpc } as unknown as Parameters<typeof autoApproveJobRequirements>[0], "job-123"),
    ).rejects.toThrow("Auto-approval did not persist any approved requirements for job job-123.");
  });
});
