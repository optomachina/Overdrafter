import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPORT_CONTROL_CHECKING_REFETCH_MS,
  exportControlStatusRefetchInterval,
  getExportControlNoticeCopy,
} from "@/features/quotes/export-control-notice";
import { ExportControlStatusNotice } from "./ExportControlStatusNotice";

const api = vi.hoisted(() => ({
  fetchJobExportControlStatus: vi.fn(),
  declareJobExportStatus: vi.fn(),
  requestExportMarkingRescan: vi.fn(),
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

  // Window 1 does not gate manual quote requests (the contract does), so no
  // hold may claim that nothing is quoted by hand; each asks the owner not to.
  it("never promises that a held part cannot be quoted by hand", () => {
    const held = [
      { latestAnswer: "not_controlled", exportReviewState: "blocked_pending_review" },
      { latestAnswer: "not_controlled", exportReviewState: "confirmed_controlled" },
      { latestAnswer: "controlled", exportReviewState: "clear" },
      { latestAnswer: "unsure", exportReviewState: "clear" },
    ] as const;
    for (const status of held) {
      const copy = getExportControlNoticeCopy({ jobId: "j", ...status });
      expect(copy?.detail).not.toMatch(/by hand|will not be sent to any supplier/);
      expect(copy?.detail).toContain("Do not request a manual quote for this part while it is held.");
    }
  });

  // Review round 4: a clean answer whose files still lack a scan of record
  // shows what holds the part and the one action that can release it.
  it("offers a recheck only for files that wait for a check", () => {
    const base = { jobId: "j", latestAnswer: "not_controlled", exportReviewState: "clear" } as const;
    const missing = getExportControlNoticeCopy({ ...base, scanState: "missing" });
    expect(missing).toMatchObject({ action: "Recheck files", actionKind: "rescan" });
    expect(missing?.detail).toContain("Do not request a manual quote for this part while it is held.");
    for (const scanState of [
      "pending",
      "drawing_unread",
      "drawing_too_many_pages",
      "drawing_sheet_too_large",
      "drawing_recheck_limit",
      "step_header_incomplete",
    ] as const) {
      const copy = getExportControlNoticeCopy({ ...base, scanState });
      expect(copy?.action).toBeNull();
      expect(copy?.detail).toMatch(/supplier automatically/);
    }
    expect(getExportControlNoticeCopy({ ...base, scanState: "drawing_unread" })?.detail).toMatch(/replace the drawing/);
    expect(getExportControlNoticeCopy({ ...base, scanState: "drawing_too_many_pages" })?.title).toBe("Drawing has more than 12 pages");
    expect(getExportControlNoticeCopy({ ...base, scanState: "drawing_too_many_pages" })?.detail).toMatch(/Split it/);
    expect(getExportControlNoticeCopy({ ...base, scanState: "drawing_sheet_too_large" })?.title).toBe("A sheet is too large to read");
    expect(getExportControlNoticeCopy({ ...base, scanState: "drawing_recheck_limit" })?.detail).toMatch(/Replace the drawing/);
  });

  // Review round 9: OCR reads every page, so selectable text alone does not
  // release a drawing; the copy must not say it does.
  it("tells the owner what every page needs instead of promising selectable text", () => {
    const base = { jobId: "j", latestAnswer: "not_controlled", exportReviewState: "clear" } as const;
    const detail = getExportControlNoticeCopy({ ...base, scanState: "drawing_unread" })?.detail ?? "";
    expect(detail).not.toMatch(/selected|selectable/);
    expect(detail).toContain("Every page needs upright, readable text: remove blank pages, rotate sideways sheets, and split drawings over 12 pages.");
    expect(getExportControlNoticeCopy({ ...base, scanState: "complete" })).toBeNull();
  });

  it("lets a controlled or unsure answer be changed", () => {
    for (const latestAnswer of ["controlled", "unsure"] as const) {
      expect(getExportControlNoticeCopy({ jobId: "j", latestAnswer, exportReviewState: "clear" })?.action).toBe("Change answer");
    }
  });
});

describe("ExportControlStatusNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    api.fetchJobExportControlStatus.mockReset();
    api.declareJobExportStatus.mockReset();
    api.requestExportMarkingRescan.mockReset();
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

  it("requeues the rescan of a held part whose files wait for a check", async () => {
    api.fetchJobExportControlStatus
      .mockResolvedValueOnce({ jobId: "job-1", latestAnswer: "not_controlled", exportReviewState: "clear", scanState: "missing" })
      .mockResolvedValue({ jobId: "job-1", latestAnswer: "not_controlled", exportReviewState: "clear", scanState: "pending" });
    api.requestExportMarkingRescan.mockResolvedValue(1);

    renderNotice();
    fireEvent.click(await screen.findByRole("button", { name: "Recheck files" }));

    await waitFor(() => expect(api.requestExportMarkingRescan).toHaveBeenCalledWith("job-1"));
    expect(prompt.requestExportControlAnswer).not.toHaveBeenCalled();
    expect(api.declareJobExportStatus).not.toHaveBeenCalled();
    expect(await screen.findByText("Checking files for export-control markings")).toBeTruthy();
  });

  // Review round 6: a running check clears on its own, without a focus
  // change or reload.
  it("polls only while the files are being checked", () => {
    const base = { jobId: "j", latestAnswer: "not_controlled", exportReviewState: "clear" } as const;
    expect(exportControlStatusRefetchInterval({ ...base, scanState: "pending" })).toBe(EXPORT_CONTROL_CHECKING_REFETCH_MS);
    for (const scanState of [
      "complete",
      "missing",
      "drawing_unread",
      "drawing_too_many_pages",
      "drawing_sheet_too_large",
      "drawing_recheck_limit",
      "step_header_incomplete",
      null,
    ] as const) {
      expect(exportControlStatusRefetchInterval({ ...base, scanState })).toBe(false);
    }
    expect(exportControlStatusRefetchInterval(undefined)).toBe(false);
  });

  it("clears the checking notice once the check finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchJobExportControlStatus
      .mockResolvedValueOnce({ jobId: "job-1", latestAnswer: "not_controlled", exportReviewState: "clear", scanState: "pending" })
      .mockResolvedValue({ jobId: "job-1", latestAnswer: "not_controlled", exportReviewState: "clear", scanState: "complete" });

    renderNotice();
    expect(await screen.findByText("Checking files for export-control markings")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(EXPORT_CONTROL_CHECKING_REFETCH_MS + 100));

    await waitFor(() => expect(screen.queryByRole("status", { name: "Export control" })).toBeNull());
    expect(api.fetchJobExportControlStatus).toHaveBeenCalledTimes(2);
  });

  it("renders nothing when the status cannot be read", async () => {
    api.fetchJobExportControlStatus.mockRejectedValue(new Error("missing function"));

    renderNotice();

    await waitFor(() => expect(api.fetchJobExportControlStatus).toHaveBeenCalled());
    expect(screen.queryByRole("status", { name: "Export control" })).toBeNull();
  });
});
