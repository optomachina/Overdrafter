import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeAdminManualQuoteRequest,
  fetchAdminManualQuoteRequests,
  fetchManualQuoteOperatorAccess,
} from "./manual-quote-admin-api";

const { callUntypedRpcMock } = vi.hoisted(() => ({
  callUntypedRpcMock: vi.fn(),
}));

vi.mock("./shared/rpc", () => ({
  callUntypedRpc: callUntypedRpcMock,
}));

describe("manual-quote-admin-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads billing-admin capability and AAL2 independently", async () => {
    callUntypedRpcMock
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });

    await expect(fetchManualQuoteOperatorAccess()).resolves.toEqual({
      hasCapability: true,
      hasAal2: false,
    });
    expect(callUntypedRpcMock).toHaveBeenNthCalledWith(
      1,
      "current_user_has_commercial_capability",
      { p_capability: "billing_admin" },
    );
    expect(callUntypedRpcMock).toHaveBeenNthCalledWith(
      2,
      "current_user_has_aal2",
    );
  });

  it("loads and normalizes an opaque-cursor inbox page", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        items: [
          {
            requestId: "request-1",
            organizationId: "org-1",
            organizationName: "Apex",
            projectId: "project-1",
            projectName: "Gearbox",
            jobId: "job-1",
            jobTitle: "Bracket",
            jobStatus: "awaiting_vendor_manual_review",
            quoteRunId: "run-1",
            quoteRunStatus: "queued",
            requestStatus: "queued",
            requestedByUserId: "user-1",
            requestedByEmail: "buyer@example.com",
            partCount: 1,
            partIds: ["part-1", 42],
            createdAt: "2026-07-30T10:00:00Z",
            updatedAt: "2026-07-30T10:00:00Z",
            requestAgeSeconds: "120",
            isStale: false,
            staleReason: null,
          },
        ],
        nextCursor: "opaque-cursor",
      },
      error: null,
    });

    const result = await fetchAdminManualQuoteRequests({
      cursor: "prior-cursor",
      limit: 10,
    });

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_list_manual_quote_requests",
      {
        p_cursor: "prior-cursor",
        p_limit: 10,
      },
    );
    expect(result).toEqual({
      items: [
        {
          requestId: "request-1",
          organizationId: "org-1",
          organizationName: "Apex",
          projectId: "project-1",
          projectName: "Gearbox",
          jobId: "job-1",
          jobTitle: "Bracket",
          jobStatus: "awaiting_vendor_manual_review",
          quoteRunId: "run-1",
          quoteRunStatus: "queued",
          requestStatus: "queued",
          requestedByUserId: "user-1",
          requestedByEmail: "buyer@example.com",
          partCount: 1,
          partIds: ["part-1"],
          createdAt: "2026-07-30T10:00:00Z",
          updatedAt: "2026-07-30T10:00:00Z",
          requestAgeSeconds: 120,
          isStale: false,
          staleReason: null,
        },
      ],
      nextCursor: "opaque-cursor",
    });
  });

  it("sends the default cursor and page size", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: { items: [], nextCursor: null },
      error: null,
    });

    await fetchAdminManualQuoteRequests();

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_list_manual_quote_requests",
      {
        p_cursor: null,
        p_limit: 25,
      },
    );
  });

  it("passes exact lineage and idempotency intent to completion", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
        jobId: "job-1",
        partId: "part-1",
        vendorQuoteResultId: "result-1",
        requestStatus: "received",
        quoteRunStatus: "completed",
        jobStatus: "internal_review",
        eventId: "event-1",
        replayed: false,
      },
      error: null,
    });

    const result = await completeAdminManualQuoteRequest({
      quoteRequestId: "request-1",
      quoteRunId: "run-1",
      jobId: "job-1",
      partId: "part-1",
      vendor: "xometry",
      reason: "Reviewed supplier quote",
      idempotencyKey: "request-1-completion",
      summaryNote: "Ready for review",
      offers: [
        {
          laneLabel: "Standard",
          requestedQuantity: 10,
          totalPriceUsd: 125,
        },
      ],
    });

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_complete_manual_quote_request",
      {
        p_quote_request_id: "request-1",
        p_quote_run_id: "run-1",
        p_job_id: "job-1",
        p_part_id: "part-1",
        p_vendor: "xometry",
        p_reason: "Reviewed supplier quote",
        p_idempotency_key: "request-1-completion",
        p_status: "official_quote_received",
        p_summary_note: "Ready for review",
        p_source_text: null,
        p_quote_url: null,
        p_offers: [
          {
            laneLabel: "Standard",
            requestedQuantity: 10,
            totalPriceUsd: 125,
          },
        ],
        p_artifacts: [],
      },
    );
    expect(result).toEqual({
      quoteRequestId: "request-1",
      quoteRunId: "run-1",
      jobId: "job-1",
      partId: "part-1",
      vendorQuoteResultId: "result-1",
      requestStatus: "received",
      quoteRunStatus: "completed",
      jobStatus: "internal_review",
      eventId: "event-1",
      replayed: false,
    });
  });

  it("fails closed when the server returns an unexpected lifecycle", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
        jobId: "job-1",
        partId: "part-1",
        vendorQuoteResultId: "result-1",
        requestStatus: "requesting",
        quoteRunStatus: "running",
        jobStatus: "awaiting_vendor_manual_review",
        eventId: "event-1",
        replayed: false,
      },
      error: null,
    });

    await expect(
      completeAdminManualQuoteRequest({
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
        jobId: "job-1",
        partId: "part-1",
        vendor: "xometry",
        reason: "Reviewed supplier quote",
        idempotencyKey: "request-1-completion",
        offers: [
          {
            laneLabel: "Standard",
            totalPriceUsd: 125,
          },
        ],
      }),
    ).rejects.toThrow(
      "Manual quote completion returned an unexpected lifecycle state.",
    );
  });
});
