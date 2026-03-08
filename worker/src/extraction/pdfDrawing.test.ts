// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFileAsync, mockAccess, mockRename } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockAccess: vi.fn(),
  mockRename: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: mockAccess,
    rename: mockRename,
  },
}));

import { extractPdfText, renderPdfPreviewAssets } from "./pdfDrawing";

describe("pdfDrawing", () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
    mockAccess.mockReset();
    mockRename.mockReset();
    mockAccess.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
  });

  it("extracts page count and page text via poppler tools", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "Title: Test\nPages: 2\n" })
      .mockResolvedValueOnce({ stdout: "PAGE 1 TEXT" })
      .mockResolvedValueOnce({ stdout: "PAGE 2 TEXT" });

    await expect(extractPdfText("/tmp/example.pdf")).resolves.toEqual({
      pageCount: 2,
      pages: [
        { page: 1, text: "PAGE 1 TEXT" },
        { page: 2, text: "PAGE 2 TEXT" },
      ],
    });

    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      1,
      "pdfinfo",
      ["/tmp/example.pdf"],
      expect.any(Object),
    );
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      2,
      "pdftotext",
      ["-layout", "-enc", "UTF-8", "-f", "1", "-l", "1", "/tmp/example.pdf", "-"],
      expect.any(Object),
    );
  });

  it("renders a thumbnail plus one full-page preview per page on linux-safe tooling", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    await expect(renderPdfPreviewAssets("/tmp/example.pdf", "/tmp/output", 2)).resolves.toEqual([
      {
        localPath: "/tmp/output/drawing-thumbnail.png",
        pageNumber: 1,
        kind: "thumbnail",
        width: null,
        height: null,
        contentType: "image/png",
      },
      {
        localPath: "/tmp/output/drawing-page-1.png",
        pageNumber: 1,
        kind: "page",
        width: null,
        height: null,
        contentType: "image/png",
      },
      {
        localPath: "/tmp/output/drawing-page-2.png",
        pageNumber: 2,
        kind: "page",
        width: null,
        height: null,
        contentType: "image/png",
      },
    ]);

    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      1,
      "pdftoppm",
      [
        "-png",
        "-f",
        "1",
        "-l",
        "1",
        "-singlefile",
        "-scale-to",
        "320",
        "/tmp/example.pdf",
        "/tmp/output/drawing-thumbnail",
      ],
      expect.any(Object),
    );
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      3,
      "pdftoppm",
      [
        "-png",
        "-f",
        "2",
        "-l",
        "2",
        "-singlefile",
        "-scale-to",
        "1600",
        "/tmp/example.pdf",
        "/tmp/output/drawing-page-2",
      ],
      expect.any(Object),
    );
    expect(mockAccess).toHaveBeenCalledTimes(3);
  });
});
