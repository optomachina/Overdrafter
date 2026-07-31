import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  removeUnregisteredManualQuoteEvidence,
  uploadManualQuoteEvidence,
} from "./uploads-api";

const storageMock = vi.hoisted(() => ({
  from: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: storageMock.from,
    },
  },
}));

describe("manual quote evidence uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:34:56.000Z"));
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "11111111-2222-4333-8444-555555555555"),
    });
    storageMock.from.mockReturnValue({
      remove: storageMock.remove,
      upload: storageMock.upload,
    });
    storageMock.remove.mockResolvedValue({ error: null });
    storageMock.upload.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves the legacy manual-quotes path and returns artifact metadata", async () => {
    const file = new File(["quote"], "RFQ #12.PDF", {
      type: "application/pdf",
    });

    await expect(
      uploadManualQuoteEvidence("job-321", [file]),
    ).resolves.toEqual([
      {
        artifactType: "uploaded_evidence",
        storageBucket: "quote-artifacts",
        storagePath:
          "manual-quotes/job-321/1785414896000-11111111-2222-4333-8444-555555555555-rfq-12.pdf",
        metadata: {
          originalName: "RFQ #12.PDF",
          mimeType: "application/pdf",
          sizeBytes: file.size,
          uploadedAt: "2026-07-30T12:34:56.000Z",
        },
      },
    ]);
    expect(storageMock.from).toHaveBeenCalledWith("quote-artifacts");
    expect(storageMock.upload).toHaveBeenCalledWith(
      "manual-quotes/job-321/1785414896000-11111111-2222-4333-8444-555555555555-rfq-12.pdf",
      file,
      {
        upsert: false,
        contentType: "application/pdf",
      },
    );
  });

  it("scopes completion evidence to the exact request, run, and job", async () => {
    const file = new File(["quote"], "Vendor Quote (Final).PDF", {
      type: "application/pdf",
    });

    const artifacts = await uploadManualQuoteEvidence("job-1", [file], {
      quoteRequestId: "request-1",
      quoteRunId: "run-1",
    });

    expect(artifacts).toEqual([
      expect.objectContaining({
        storageBucket: "quote-artifacts",
        storagePath:
          "manual-completions/request-1/run-1/job-1/1785414896000-11111111-2222-4333-8444-555555555555-vendor-quote-final-.pdf",
        metadata: expect.objectContaining({
          originalName: "Vendor Quote (Final).PDF",
          mimeType: "application/pdf",
          sizeBytes: file.size,
          uploadedAt: "2026-07-30T12:34:56.000Z",
        }),
      }),
    ]);
  });

  it("removes only quote-artifacts paths and no-ops when there are none", async () => {
    await removeUnregisteredManualQuoteEvidence([
      {
        artifactType: "uploaded_evidence",
        storageBucket: "quote-artifacts",
        storagePath: "manual-completions/request-1/run-1/job-1/quote.pdf",
        metadata: {},
      },
      {
        artifactType: "uploaded_evidence",
        storageBucket: "another-bucket",
        storagePath: "must-not-be-removed.pdf",
        metadata: {},
      },
    ]);

    expect(storageMock.from).toHaveBeenCalledTimes(1);
    expect(storageMock.from).toHaveBeenCalledWith("quote-artifacts");
    expect(storageMock.remove).toHaveBeenCalledWith([
      "manual-completions/request-1/run-1/job-1/quote.pdf",
    ]);

    vi.clearAllMocks();
    await expect(
      removeUnregisteredManualQuoteEvidence([]),
    ).resolves.toBeUndefined();
    expect(storageMock.from).not.toHaveBeenCalled();
    expect(storageMock.remove).not.toHaveBeenCalled();
  });

  it("cleans up a partial completion upload without masking its failure", async () => {
    const uploadError = new Error("second upload failed");
    const cleanupError = new Error("cleanup failed");
    const firstFile = new File(["first"], "first.pdf", {
      type: "application/pdf",
    });
    const secondFile = new File(["second"], "second.pdf", {
      type: "application/pdf",
    });
    storageMock.upload
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: uploadError });
    storageMock.remove.mockResolvedValueOnce({ error: cleanupError });

    await expect(
      uploadManualQuoteEvidence("job-1", [firstFile, secondFile], {
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
      }),
    ).rejects.toBe(uploadError);

    expect(storageMock.remove).toHaveBeenCalledWith([
      "manual-completions/request-1/run-1/job-1/1785414896000-11111111-2222-4333-8444-555555555555-first.pdf",
    ]);
  });
});
