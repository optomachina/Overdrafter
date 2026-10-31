// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { autoApproveJobRequirements } from "./autoApprove.js";

type Client = Parameters<typeof autoApproveJobRequirements>[0];

function clientReturning(
  result: { data: unknown; error: unknown },
  approval = { data: { id: "approval-123" } as { id: string } | null, error: null as unknown },
) {
  const rpc = vi.fn().mockResolvedValue(result);
  const maybeSingle = vi.fn().mockResolvedValue(approval);
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle,
  };
  const from = vi.fn().mockReturnValue(query);
  return { rpc, from, query, client: { rpc, from } as unknown as Client };
}

describe("autoApproveJobRequirements", () => {
  it("calls the auto-approval RPC and returns the approved part count", async () => {
    const { rpc, from, query, client } = clientReturning({ data: 2, error: null });

    await expect(autoApproveJobRequirements(client, "job-123", "part-123", "org-123")).resolves.toEqual({
      approvedCount: 2,
      reviewHold: false,
    });

    expect(rpc).toHaveBeenCalledWith("api_auto_approve_job_requirements", {
      p_job_id: "job-123",
    });
    expect(from).toHaveBeenCalledWith("approved_part_requirements");
    expect(query.select).toHaveBeenCalledWith("id");
    expect(query.eq).toHaveBeenCalledWith("organization_id", "org-123");
    expect(query.eq).toHaveBeenCalledWith("part_id", "part-123");
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(query.maybeSingle).toHaveBeenCalledOnce();
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(from.mock.invocationCallOrder[0]);
  });

  it.each([0, 1])("reports a review hold without this part's approval when RPC returns %i", async (data) => {
    const { client } = clientReturning({ data, error: null }, { data: null, error: null });

    await expect(autoApproveJobRequirements(client, "job-123", "part-123", "org-123")).resolves.toEqual({
      approvedCount: data,
      reviewHold: true,
    });
  });

  it("throws the part approval read error instead of trusting the job-wide count", async () => {
    const approvalError = { message: "approval read failed" };
    const { client } = clientReturning({ data: 1, error: null }, { data: null, error: approvalError });

    await expect(autoApproveJobRequirements(client, "job-123", "part-123", "org-123")).rejects.toBe(approvalError);
  });

  it("uses an existing part approval even when the RPC returns 0 new approvals", async () => {
    const { client } = clientReturning({ data: 0, error: null });

    await expect(autoApproveJobRequirements(client, "job-123", "part-123", "org-123")).resolves.toEqual({
      approvedCount: 0,
      reviewHold: false,
    });
  });

  it("accepts a numeric string count from PostgREST", async () => {
    const { client } = clientReturning({ data: "3", error: null });

    await expect(autoApproveJobRequirements(client, "job-123", "part-123", "org-123")).resolves.toEqual({
      approvedCount: 3,
      reviewHold: false,
    });
  });

  it("throws the RPC error", async () => {
    const rpcError = { message: "permission denied", code: "42501" };
    const { client, from } = clientReturning({ data: null, error: rpcError });

    await expect(autoApproveJobRequirements(client, "job-123", "part-123", "org-123")).rejects.toBe(rpcError);
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["a negative count", -1],
    ["a fractional count", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a non-numeric string", "abc"],
    ["an empty string", ""],
    ["an object", { approved: 1 }],
    ["a boolean", true],
  ])("fails closed on %s instead of treating it as a review hold", async (_label, data) => {
    const { client, from } = clientReturning({ data, error: null });

    await expect(autoApproveJobRequirements(client, "job-123", "part-123", "org-123")).rejects.toThrow(
      "Auto-approval returned an invalid approved requirement count for job job-123.",
    );
    expect(from).not.toHaveBeenCalled();
  });
});
