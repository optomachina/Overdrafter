import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getExportControlNoticeCopy } from "@/features/quotes/export-control-notice";
import { ExportControlStatusNotice } from "./ExportControlStatusNotice";

const api = vi.hoisted(() => ({
  fetchJobExportControlStatus: vi.fn(),
  declareJobExportStatus: vi.fn(),
}));
const prompt = vi.hoisted(() => ({ requestExportControlAnswer: vi.fn() }));
const extraction = vi.hoisted(() => ({ requestExtraction: vi.fn() }));
vi.mock("@/features/quotes/api/extraction-api", () => extraction);

vi.mock("@/features/quotes/api/export-control-api", () => api);
vi.mock("@/features/quotes/export-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/quotes/export-control")>()),
  requestExportControlAnswer: prompt.requestExportControlAnswer,
}));

function renderNotice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExportControlStatusNotice jobId="job-1" />
    </QueryClientProvider>,
  );
}

describe("getExportControlNoticeCopy", () => {
  it("shows nothing for a clean, unblocked part", () => {
    expect(getExportControlNoticeCopy({ jobId: "j", latestAnswer: "not_controlled", exportReviewState: "clear" })).toBeNull();
  });

  it.each([null, "missing"] as const)("asks for an answer when the latest answer is %s", (latestAnswer) => {
    const copy = getExportControlNoticeCopy({ jobId: "j", latestAnswer, exportReviewState: "clear" });
    expect(copy?.action).toBe("Answer export-control question");
    expect(copy?.detail).toContain("covers every file on the part");
  });

  it("explains a review hold without offering a way around it", () => {
    for (const exportReviewState of ["blocked_pending_review", "confirmed_controlled"] as const) {
      const copy = getExportControlNoticeCopy({ jobId: "j", latestAnswer: "not_controlled", exportReviewState });
      expect(copy?.action).toBeNull();
      expect(copy?.detail).toMatch(/supplier/);
    }
  });

  it("lets a controlled or unsure answer be changed", () => {
    for (const latestAnswer of ["controlled", "unsure"] as const) {
      expect(getExportControlNoticeCopy({ jobId: "j", latestAnswer, exportReviewState: "clear" })?.action).toBe("Change answer");
    }
  });
});

describe("ExportControlStatusNotice", () => {
  beforeEach(() => {
    api.fetchJobExportControlStatus.mockReset();
    api.declareJobExportStatus.mockReset();
    prompt.requestExportControlAnswer.mockReset();
    extraction.requestExtraction.mockReset();
    extraction.requestExtraction.mockResolvedValue(1);
  });

  it("declares a backfilled part without uploading", async () => {
    api.fetchJobExportControlStatus
      .mockResolvedValueOnce({ jobId: "job-1", latestAnswer: "missing", exportReviewState: "clear" })
      .mockResolvedValue({ jobId: "job-1", latestAnswer: "not_controlled", exportReviewState: "clear" });
    api.declareJobExportStatus.mockResolvedValue(undefined);
    prompt.requestExportControlAnswer.mockResolvedValue("not_controlled");

    renderNotice();
    fireEvent.click(await screen.findByRole("button", { name: "Answer export-control question" }));

    await waitFor(() => expect(api.declareJobExportStatus).toHaveBeenCalledWith("job-1", "not_controlled"));
    expect(prompt.requestExportControlAnswer).toHaveBeenCalledWith("declare");
    // Files uploaded before the answer are rescanned so they get a clean scan of record.
    await waitFor(() => expect(extraction.requestExtraction).toHaveBeenCalledWith("job-1"));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Export control" })).toBeNull());
  });

  it("records nothing when the question is dismissed", async () => {
    api.fetchJobExportControlStatus.mockResolvedValue({ jobId: "job-1", latestAnswer: null, exportReviewState: "clear" });
    prompt.requestExportControlAnswer.mockResolvedValue(null);

    renderNotice();
    fireEvent.click(await screen.findByRole("button", { name: "Answer export-control question" }));

    await waitFor(() => expect(prompt.requestExportControlAnswer).toHaveBeenCalled());
    expect(api.declareJobExportStatus).not.toHaveBeenCalled();
    expect(extraction.requestExtraction).not.toHaveBeenCalled();
  });

  it("records an unsure answer without rescanning", async () => {
    api.fetchJobExportControlStatus.mockResolvedValue({ jobId: "job-1", latestAnswer: "missing", exportReviewState: "clear" });
    api.declareJobExportStatus.mockResolvedValue(undefined);
    prompt.requestExportControlAnswer.mockResolvedValue("unsure");

    renderNotice();
    fireEvent.click(await screen.findByRole("button", { name: "Answer export-control question" }));

    await waitFor(() => expect(api.declareJobExportStatus).toHaveBeenCalledWith("job-1", "unsure"));
    expect(extraction.requestExtraction).not.toHaveBeenCalled();
  });

  it("renders nothing when the status cannot be read", async () => {
    api.fetchJobExportControlStatus.mockRejectedValue(new Error("missing function"));

    renderNotice();

    await waitFor(() => expect(api.fetchJobExportControlStatus).toHaveBeenCalled());
    expect(screen.queryByRole("status", { name: "Export control" })).toBeNull();
  });
});
