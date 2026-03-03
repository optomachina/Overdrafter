import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  const storageUpload = vi.fn();
  const storageFrom = vi.fn(() => ({
    upload: storageUpload,
  }));
  const rpc = vi.fn();

  return {
    storageUpload,
    storageFrom,
    rpc,
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: supabaseMock.storageFrom,
    },
    rpc: supabaseMock.rpc,
  },
}));

import {
  inferFileKind,
  uploadFilesToJob,
  uploadManualQuoteEvidence,
} from "./api";

describe("quotes api helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T12:34:56.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("infers CAD, drawing, and other file kinds case-insensitively", () => {
    expect(inferFileKind("assembly.STEP")).toBe("cad");
    expect(inferFileKind("print.PDF")).toBe("drawing");
    expect(inferFileKind("notes.txt")).toBe("other");
  });

  it("uploads job files and registers each attachment with its inferred metadata", async () => {
    supabaseMock.storageUpload.mockResolvedValue({ error: null });
    supabaseMock.rpc.mockResolvedValue({ error: null });

    const now = Date.now();
    const files = [
      new File(["step"], "bracket.step", { type: "model/step" }),
      new File(["drawing"], "bracket.pdf", { type: "application/pdf" }),
    ];

    await uploadFilesToJob("job-123", files);

    expect(supabaseMock.storageFrom).toHaveBeenNthCalledWith(1, "job-files");
    expect(supabaseMock.storageFrom).toHaveBeenNthCalledWith(2, "job-files");
    expect(supabaseMock.storageUpload).toHaveBeenNthCalledWith(
      1,
      `job-123/${now}-bracket.step`,
      files[0],
      { upsert: false },
    );
    expect(supabaseMock.storageUpload).toHaveBeenNthCalledWith(
      2,
      `job-123/${now}-bracket.pdf`,
      files[1],
      { upsert: false },
    );
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(1, "api_attach_job_file", {
      p_job_id: "job-123",
      p_storage_bucket: "job-files",
      p_storage_path: `job-123/${now}-bracket.step`,
      p_original_name: "bracket.step",
      p_file_kind: "cad",
      p_mime_type: "model/step",
      p_size_bytes: files[0].size,
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_attach_job_file", {
      p_job_id: "job-123",
      p_storage_bucket: "job-files",
      p_storage_path: `job-123/${now}-bracket.pdf`,
      p_original_name: "bracket.pdf",
      p_file_kind: "drawing",
      p_mime_type: "application/pdf",
      p_size_bytes: files[1].size,
    });
  });

  it("stops when file storage upload fails", async () => {
    supabaseMock.storageUpload.mockResolvedValueOnce({
      error: new Error("Storage down"),
    });

    await expect(
      uploadFilesToJob("job-123", [new File(["x"], "bad.step", { type: "model/step" })]),
    ).rejects.toThrow("Storage down");

    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });

  it("uploads manual quote evidence with sanitized artifact paths and metadata", async () => {
    supabaseMock.storageUpload.mockResolvedValue({ error: null });
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "uuid-123"),
    });

    const file = new File(["quote"], "RFQ #12.PDF", { type: "application/pdf" });
    const now = Date.now();
    const uploadedAt = new Date(now).toISOString();

    await expect(uploadManualQuoteEvidence("job-321", [file])).resolves.toEqual([
      {
        artifactType: "uploaded_evidence",
        storageBucket: "quote-artifacts",
        storagePath: `manual-quotes/job-321/${now}-uuid-123-rfq-12.pdf`,
        metadata: {
          originalName: "RFQ #12.PDF",
          mimeType: "application/pdf",
          sizeBytes: file.size,
          uploadedAt,
        },
      },
    ]);

    expect(supabaseMock.storageFrom).toHaveBeenCalledWith("quote-artifacts");
    expect(supabaseMock.storageUpload).toHaveBeenCalledWith(
      `manual-quotes/job-321/${now}-uuid-123-rfq-12.pdf`,
      file,
      {
        upsert: false,
        contentType: "application/pdf",
      },
    );
  });
});
