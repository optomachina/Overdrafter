import { beforeEach, describe, expect, it, vi } from "vitest";

const { storageDownload, createSignedUrl, fetchMock, recordWorkspaceSessionDiagnostic, createObjectURLMock, revokeObjectURLMock } =
  vi.hoisted(() => ({
    storageDownload: vi.fn(),
    createSignedUrl: vi.fn(),
    fetchMock: vi.fn(),
    recordWorkspaceSessionDiagnostic: vi.fn(),
    createObjectURLMock: vi.fn(() => "blob:pdf-preview"),
    revokeObjectURLMock: vi.fn(),
  }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: vi.fn(() => ({
        createSignedUrl,
        download: storageDownload,
      })),
    },
  },
}));

vi.mock("@/lib/workspace-session-diagnostics", () => ({
  recordWorkspaceSessionDiagnostic,
}));

import { downloadStoredFileBlob, loadStoredDrawingPreviewPages, loadStoredPdfObjectUrl } from "./stored-file";

describe("stored-file", () => {
  beforeEach(() => {
    storageDownload.mockReset();
    createSignedUrl.mockReset();
    fetchMock.mockReset();
    recordWorkspaceSessionDiagnostic.mockReset();
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURLMock,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: revokeObjectURLMock,
    });
  });

  it("wraps storage errors in a real Error with a readable message", async () => {
    storageDownload.mockResolvedValue({
      data: null,
      error: {
        name: "StorageApiError",
        code: "403",
        status: 403,
        details: "Access denied",
      },
    });

    await expect(
      downloadStoredFileBlob({
        storage_bucket: "quote-artifacts",
        storage_path: "preview/page-1.png",
        original_name: "drawing.pdf",
      }),
    ).rejects.toMatchObject({
      name: "StorageApiError",
      message: "Access denied",
      code: "403",
      status: 403,
      details: "Access denied",
    });
  });

  it("uses the caller fallback when storage returns an opaque empty-object error", async () => {
    storageDownload.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("{}"), {
        name: "StorageUnknownError",
        originalError: {},
      }),
    });

    await expect(
      downloadStoredFileBlob({
        storage_bucket: "quote-artifacts",
        storage_path: "preview/page-1.png",
        original_name: "drawing.pdf",
      }),
    ).rejects.toMatchObject({
      name: "StorageUnknownError",
      message: "Unable to download drawing.pdf.",
    });
  });

  it("loads PDFs through blob handling instead of text and normalizes the blob mime type", async () => {
    const textSpy = vi.fn();
    const blobSpy = vi.fn(async () => new Blob(["%PDF-1.4"], { type: "text/plain" }));

    createSignedUrl.mockResolvedValue({
      data: {
        signedUrl: "https://example.supabase.co/storage/v1/object/sign/job-files/org/drawing.pdf?token=secret",
      },
      error: null,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "text/plain",
        "content-length": "8",
      }),
      blob: blobSpy,
      text: textSpy,
    });

    await expect(
      loadStoredPdfObjectUrl({
        storage_bucket: "job-files",
        storage_path: "org/drawing.pdf",
        original_name: "drawing.pdf",
        mime_type: "text/plain",
      }),
    ).resolves.toBe("blob:pdf-preview");

    expect(blobSpy).toHaveBeenCalledTimes(1);
    expect(textSpy).not.toHaveBeenCalled();
    expect(createObjectURLMock).toHaveBeenCalledWith(expect.any(Blob));
    const lastCreateObjectUrlCall = createObjectURLMock.mock.lastCall as unknown[] | undefined;
    const pdfBlob = lastCreateObjectUrlCall?.[0] as Blob | undefined;
    expect(pdfBlob).toBeInstanceOf(Blob);
    expect(pdfBlob?.type).toBe("application/pdf");
    expect(recordWorkspaceSessionDiagnostic).toHaveBeenCalledWith(
      "info",
      "stored-file.pdf-preview",
      "Loading PDF preview.",
      expect.objectContaining({
        resolvedUrl: "https://example.supabase.co/storage/v1/object/sign/job-files/org/drawing.pdf",
        viewerMode: "pdf",
      }),
    );
  });

  it("rejects empty PDF blobs with a useful error", async () => {
    createSignedUrl.mockResolvedValue({
      data: {
        signedUrl: "https://example.supabase.co/storage/v1/object/sign/job-files/org/empty.pdf?token=secret",
      },
      error: null,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: vi.fn(async () => new Blob([])),
    });

    await expect(
      loadStoredPdfObjectUrl({
        storage_bucket: "job-files",
        storage_path: "org/empty.pdf",
        original_name: "empty.pdf",
        mime_type: "application/pdf",
      }),
    ).rejects.toThrow("Drawing preview is empty.");
  });

  it("maps expired signed URLs to a graceful preview error", async () => {
    createSignedUrl.mockResolvedValue({
      data: {
        signedUrl: "https://example.supabase.co/storage/v1/object/sign/job-files/org/expired.pdf?token=secret",
      },
      error: null,
    });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      blob: vi.fn(),
    });

    await expect(
      loadStoredPdfObjectUrl({
        storage_bucket: "job-files",
        storage_path: "org/expired.pdf",
        original_name: "expired.pdf",
        mime_type: "application/pdf",
      }),
    ).rejects.toThrow("Drawing preview link expired or is no longer valid. Refresh and try again.");
  });

  it("loads extracted drawing pages as object URLs for image fallback rendering", async () => {
    storageDownload
      .mockResolvedValueOnce({
        data: new Blob(["page-1"]),
        error: null,
      })
      .mockResolvedValueOnce({
        data: new Blob(["page-2"]),
        error: null,
      });
    createObjectURLMock.mockReturnValueOnce("blob:page-1").mockReturnValueOnce("blob:page-2");

    await expect(
      loadStoredDrawingPreviewPages(
        { original_name: "drawing.pdf" },
        [
          {
            pageNumber: 1,
            storageBucket: "quote-artifacts",
            storagePath: "preview/page-1.png",
          },
          {
            pageNumber: 2,
            storageBucket: "quote-artifacts",
            storagePath: "preview/page-2.png",
          },
        ],
      ),
    ).resolves.toEqual([
      { pageNumber: 1, url: "blob:page-1" },
      { pageNumber: 2, url: "blob:page-2" },
    ]);
  });
});
