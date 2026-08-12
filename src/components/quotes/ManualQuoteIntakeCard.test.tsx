import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PartAggregate } from "@/features/quotes/types";
import {
  ManualQuoteIntakeCard,
  type ManualQuoteCompletionTarget,
} from "./ManualQuoteIntakeCard";

const adminApiMock = vi.hoisted(() => ({
  completeAdminManualQuoteRequest: vi.fn(),
}));

const internalReviewApiMock = vi.hoisted(() => ({
  recordManualVendorQuote: vi.fn(),
  removeUnregisteredManualQuoteEvidence: vi.fn(),
  uploadManualQuoteEvidence: vi.fn(),
}));

vi.mock("@/features/quotes/api/manual-quote-admin-api", () => ({
  completeAdminManualQuoteRequest: adminApiMock.completeAdminManualQuoteRequest,
}));

vi.mock("@/features/quotes/api/internal-review", () => ({
  recordManualVendorQuote: internalReviewApiMock.recordManualVendorQuote,
  removeUnregisteredManualQuoteEvidence:
    internalReviewApiMock.removeUnregisteredManualQuoteEvidence,
  uploadManualQuoteEvidence: internalReviewApiMock.uploadManualQuoteEvidence,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makePart(overrides: Partial<PartAggregate> = {}): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "Bracket",
    normalized_key: "bracket",
    cad_file_id: null,
    drawing_file_id: null,
    quantity: 10,
    created_at: "2026-07-30T10:00:00.000Z",
    updated_at: "2026-07-30T10:00:00.000Z",
    cadFile: null,
    drawingFile: null,
    extraction: null,
    approvedRequirement: null,
    vendorQuotes: [],
    ...overrides,
  };
}

function makeCompletionTarget(
  overrides: Partial<ManualQuoteCompletionTarget> = {},
): ManualQuoteCompletionTarget {
  return {
    requestId: "request-1",
    quoteRunId: "run-1",
    jobId: "job-1",
    requestStatus: "queued",
    quoteRunStatus: "running",
    jobStatus: "awaiting_vendor_manual_review",
    partIds: ["part-1"],
    isStale: false,
    staleReason: null,
    hasAal2: true,
    ...overrides,
  };
}

function renderCard(completionTarget: ManualQuoteCompletionTarget) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ManualQuoteIntakeCard
        jobId="job-1"
        parts={[makePart()]}
        completionTarget={completionTarget}
      />
    </QueryClientProvider>,
  );
}

describe("ManualQuoteIntakeCard exact completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    adminApiMock.completeAdminManualQuoteRequest.mockResolvedValue({
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
    internalReviewApiMock.uploadManualQuoteEvidence.mockResolvedValue([]);
    internalReviewApiMock.removeUnregisteredManualQuoteEvidence.mockResolvedValue(undefined);
  });

  it("submits the exact request/run/job lineage with a stable idempotency key", async () => {
    const uploadedArtifact = {
      artifactType: "uploaded_evidence",
      storageBucket: "quote-artifacts",
      storagePath: "manual-completions/request-1/run-1/job-1/quote.pdf",
    };
    internalReviewApiMock.uploadManualQuoteEvidence.mockResolvedValue([uploadedArtifact]);
    const { container } = renderCard(makeCompletionTarget());
    const evidenceFile = new File(["quote"], "Quote.PDF", { type: "application/pdf" });

    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [evidenceFile] },
    });

    fireEvent.change(screen.getByLabelText("Operator reason"), {
      target: { value: "Reviewed supplier reply" },
    });
    fireEvent.change(screen.getByPlaceholderText("1250.00"), {
      target: { value: "1499.50" },
    });
    fireEvent.change(screen.getByLabelText("Or valid for (days)"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Original validity terms"), {
      target: { value: "Pricing valid for 30 calendar days" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete exact request" }));

    await waitFor(() => {
      expect(adminApiMock.completeAdminManualQuoteRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          quoteRequestId: "request-1",
          quoteRunId: "run-1",
          jobId: "job-1",
          partId: "part-1",
          vendor: "xometry",
          status: "official_quote_received",
          reason: "Reviewed supplier reply",
          idempotencyKey: "manual-quote-request:request-1",
          offers: [
            expect.objectContaining({
              laneLabel: "Primary offer",
              totalPriceUsd: 1499.5,
              validityDurationDays: 30,
              validitySource: "operator_duration",
              validityTerms: "Pricing valid for 30 calendar days",
            }),
          ],
        }),
      );
    });
    expect(internalReviewApiMock.uploadManualQuoteEvidence).toHaveBeenCalledWith(
      "job-1",
      [evidenceFile],
      {
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
      },
    );
    expect(internalReviewApiMock.recordManualVendorQuote).not.toHaveBeenCalled();
  });

  it("cleans up unregistered evidence when exact completion is rejected", async () => {
    const uploadedArtifact = {
      artifactType: "uploaded_evidence",
      storageBucket: "quote-artifacts",
      storagePath: "manual-completions/request-1/run-1/job-1/quote.pdf",
    };
    internalReviewApiMock.uploadManualQuoteEvidence.mockResolvedValue([uploadedArtifact]);
    adminApiMock.completeAdminManualQuoteRequest.mockRejectedValue(
      new Error("This manual quote request is no longer active."),
    );
    const { container } = renderCard(makeCompletionTarget());

    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: {
        files: [new File(["quote"], "Quote.PDF", { type: "application/pdf" })],
      },
    });
    fireEvent.change(screen.getByLabelText("Operator reason"), {
      target: { value: "Reviewed supplier reply" },
    });
    fireEvent.change(screen.getByPlaceholderText("1250.00"), {
      target: { value: "1499.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete exact request" }));

    await waitFor(() => {
      expect(
        internalReviewApiMock.removeUnregisteredManualQuoteEvidence,
      ).toHaveBeenCalledWith([uploadedArtifact]);
    });
  });

  it("blocks an AAL1 operator and explains that MFA is required", () => {
    renderCard(makeCompletionTarget({ hasAal2: false }));

    expect(
      screen.getByText("MFA is required before this completion can be submitted."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Complete exact request" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Operator reason")).toBeDisabled();
    expect(adminApiMock.completeAdminManualQuoteRequest).not.toHaveBeenCalled();
  });

  it("keeps a stale request disabled and surfaces the stale reason", () => {
    renderCard(
      makeCompletionTarget({
        isStale: true,
        staleReason: "This request is already canceled.",
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This request is already canceled.",
    );
    expect(
      screen.getByRole("button", { name: "Complete exact request" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Operator reason")).toBeDisabled();
    expect(adminApiMock.completeAdminManualQuoteRequest).not.toHaveBeenCalled();
  });
});
