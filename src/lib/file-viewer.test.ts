import { describe, expect, it } from "vitest";
import { resolveStoredFileViewerMode } from "./file-viewer";

describe("file-viewer", () => {
  it("selects PDF mode for application/pdf", () => {
    expect(
      resolveStoredFileViewerMode({
        original_name: "drawing.bin",
        mime_type: "application/pdf",
      }),
    ).toBe("pdf");
  });

  it("selects PDF mode for .pdf files even when mime type is missing or wrong", () => {
    expect(
      resolveStoredFileViewerMode({
        original_name: "drawing.pdf",
        mime_type: null,
      }),
    ).toBe("pdf");

    expect(
      resolveStoredFileViewerMode({
        original_name: "drawing.pdf",
        mime_type: "text/plain",
      }),
    ).toBe("pdf");
  });

  it("falls back to image, text, and download modes for non-PDF files", () => {
    expect(
      resolveStoredFileViewerMode({
        original_name: "preview.png",
        mime_type: "image/png",
      }),
    ).toBe("image");

    expect(
      resolveStoredFileViewerMode({
        original_name: "notes.csv",
        mime_type: "text/csv",
      }),
    ).toBe("text");

    expect(
      resolveStoredFileViewerMode({
        original_name: "widget.step",
        mime_type: "model/step",
      }),
    ).toBe("download");
  });
});
