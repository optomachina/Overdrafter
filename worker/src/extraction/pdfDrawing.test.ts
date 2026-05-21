// @vitest-environment node

import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Derive test paths from the OS temp dir rather than hardcoding "/tmp" so the
// fixtures match the production code (which uses os.tmpdir()) and so static
// analysis does not flag publicly-writable directory literals.
const TEST_TMP = os.tmpdir();
const EXAMPLE_PDF = path.join(TEST_TMP, "example.pdf");
const REGRESSION_PDF = path.join(TEST_TMP, "1093-05589-02.pdf");
const OCR_RUN_DIR = path.join(TEST_TMP, "overdrafter-pdf-ocr-test");
const OUTPUT_DIR = path.join(TEST_TMP, "output");

const { mockExecFileAsync, mockAccess, mockMkdtemp, mockRename } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockAccess: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockRename: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: mockAccess,
    mkdtemp: mockMkdtemp,
    rename: mockRename,
  },
}));

import { extractPdfText, inferDrawingSignalsFromPdf, renderPdfPreviewAssets } from "./pdfDrawing";

const PRIMARY_REGRESSION_FIXTURE = {
  pageCount: 1,
  pages: [
    {
      page: 1,
      text: [
        "                                                                  REVISIONS",
        "                                                           REV   DESCRIPTION          ENGINEER   EC/DATE",
        "                                                           C2    CHANGED HOLE SIZE    TIM        11/18/2013",
        "",
        "87654321",
        "",
        "MATERIAL      6061 ALLOY",
        "FINISH        ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
        "",
        "                                                          4D Technology Corporation",
        "                                                          TITLE:",
        "                                                          ROUND, CARBON FIBER END ATTACHMENTS",
        "                                                          BONDED",
        "                                                SIZE      B     DWG. NO.              REV",
        "                                                              1093-05589             02",
        "                                                SCALE: 1:1                         SHEET 1 OF 1",
      ].join("\n"),
    },
  ],
} as const;

describe("pdfDrawing", () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
    mockAccess.mockReset();
    mockMkdtemp.mockReset();
    mockRename.mockReset();
    mockAccess.mockResolvedValue(undefined);
    mockMkdtemp.mockResolvedValue(OCR_RUN_DIR);
    mockRename.mockResolvedValue(undefined);
  });

  it("extracts page count and page text via poppler tools", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "Title: Test\nPages: 2\n" })
      .mockResolvedValueOnce({ stdout: "PAGE 1 TEXT" })
      .mockResolvedValueOnce({ stdout: "PAGE 2 TEXT" });

    await expect(extractPdfText(EXAMPLE_PDF)).resolves.toEqual({
      pageCount: 2,
      pages: [
        { page: 1, text: "PAGE 1 TEXT" },
        { page: 2, text: "PAGE 2 TEXT" },
      ],
    });

    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      1,
      "pdfinfo",
      [EXAMPLE_PDF],
      expect.any(Object),
    );
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      2,
      "pdftotext",
      ["-layout", "-enc", "UTF-8", "-f", "1", "-l", "1", EXAMPLE_PDF, "-"],
      expect.any(Object),
    );
  });

  it("falls back to OCR text when poppler text extraction is unavailable", async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("pdfinfo missing"))
      .mockRejectedValueOnce(new Error("pdftoppm missing"))
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({
        stdout: [
          "ROUND, CARBON FIBER END ATTACHMENTS",
          "BONDED",
          "MATERIAL rinsH ANODIZE, BLACK, MIL-A-8625F, TYPE II -",
          "6061 Alloy CLASS 2 1093-05589 02",
          "THREE PLACE DECIMAL +.005",
        ].join("\n"),
      });

    await expect(extractPdfText(REGRESSION_PDF)).resolves.toEqual({
      pageCount: 1,
      pages: [
        {
          page: 1,
          text: [
            "ROUND, CARBON FIBER END ATTACHMENTS",
            "BONDED",
            "MATERIAL rinsH ANODIZE, BLACK, MIL-A-8625F, TYPE II -",
            "6061 Alloy CLASS 2 1093-05589 02",
            "THREE PLACE DECIMAL +.005",
          ].join("\n"),
        },
      ],
    });

    expect(mockMkdtemp).toHaveBeenCalledWith(expect.stringContaining("overdrafter-pdf-ocr-"));
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      3,
      "qlmanage",
      ["-t", "-s", "3000", "-o", OCR_RUN_DIR, REGRESSION_PDF],
      expect.any(Object),
    );
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      4,
      "tesseract",
      [path.join(OCR_RUN_DIR, "drawing-page-1.png"), "stdout", "--psm", "4"],
      expect.any(Object),
    );
  });

  it("renders a thumbnail plus one full-page preview per page on linux-safe tooling", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    await expect(renderPdfPreviewAssets(EXAMPLE_PDF, OUTPUT_DIR, 2)).resolves.toEqual([
      {
        localPath: path.join(OUTPUT_DIR, "drawing-thumbnail.png"),
        pageNumber: 1,
        kind: "thumbnail",
        width: null,
        height: null,
        contentType: "image/png",
      },
      {
        localPath: path.join(OUTPUT_DIR, "drawing-page-1.png"),
        pageNumber: 1,
        kind: "page",
        width: null,
        height: null,
        contentType: "image/png",
      },
      {
        localPath: path.join(OUTPUT_DIR, "drawing-page-2.png"),
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
        EXAMPLE_PDF,
        path.join(OUTPUT_DIR, "drawing-thumbnail"),
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
        EXAMPLE_PDF,
        path.join(OUTPUT_DIR, "drawing-page-2"),
      ],
      expect.any(Object),
    );
    expect(mockAccess).toHaveBeenCalledTimes(3);
  });

  it("extracts title-block values from the 1093-05589 regression layout", () => {
    const result = inferDrawingSignalsFromPdf({
      baseName: "1093-05589-02",
      pdfText: PRIMARY_REGRESSION_FIXTURE,
    });

    expect(result.partNumber.value).toBe("1093-05589");
    expect(result.revision.value).toBe("02");
    expect(result.description.value).toBe("ROUND, CARBON FIBER END ATTACHMENTS BONDED");
    expect(result.finish.value).toBe("ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2");
    expect(result.quoteDescription).toBe("BONDED, CARBON FIBER END ATTACHMENT");
    expect(result.quoteFinish).toBe("Black Anodize, Type II");
    expect(result.partNumber.reviewNeeded).toBe(false);
    expect(result.revision.reviewNeeded).toBe(false);
    expect(result.description.reviewNeeded).toBe(false);
    expect(result.finish.reviewNeeded).toBe(false);
    expect(result.reviewFields).not.toContain("partNumber");
    expect(result.reviewFields).not.toContain("revision");
    expect(result.reviewFields).not.toContain("description");
    expect(result.reviewFields).not.toContain("finish");
    expect(result.reviewFields).not.toContain("process");
  });

  it("rejects finish specs and approval text as part number and finish winners", () => {
    const result = inferDrawingSignalsFromPdf({
      baseName: "1093-05589-02",
      pdfText: PRIMARY_REGRESSION_FIXTURE,
    });

    expect(result.partNumber.value).not.toBe("MIL-A-8625F");
    expect(result.finish.value).not.toBe("TIM 11/18/2013");
    expect(result.description.value).not.toBe("87654321");
    expect(result.debugCandidates.partNumber[0]?.reasons).not.toContain("rejected_spec_string");
  });

  it("rescues title-block fields and tolerance from OCR text when layout anchors are noisy", () => {
    const result = inferDrawingSignalsFromPdf({
      baseName: "1093-05589-02",
      pdfText: {
        pageCount: 1,
        pages: [
          {
            page: 1,
            text: [
              "ROUND, CARBON FIBER END ATTACHMENTS",
              "BONDED",
              "MATERIAL rinsH ANODIZE, BLACK, MIL-A-8625F, TYPE II -",
              "6061 Alloy CLASS 2 1093-05589 02",
              "THREE PLACE DECIMAL +.005",
            ].join("\n"),
          },
        ],
      },
    });

    expect(result.partNumber.value).toBe("1093-05589");
    expect(result.revision.value).toBe("02");
    expect(result.description.value).toBe("ROUND, CARBON FIBER END ATTACHMENTS BONDED");
    expect(result.material.value).toBe("6061 Alloy");
    expect(result.finish.value).toBe("ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2");
    expect(result.tightestTolerance).toBe("±0.005");
    expect(result.threads).toEqual([]);
    expect(result.quoteDescription).toBe("BONDED, CARBON FIBER END ATTACHMENT");
    expect(result.quoteFinish).toBe("Black Anodize, Type II");
    expect(result.reviewFields).toEqual([]);
  });
});
