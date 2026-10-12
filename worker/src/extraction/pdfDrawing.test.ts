// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFileAsync, mockAccess, mockMkdtemp, mockRename, mockRm } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockAccess: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockRename: vi.fn(),
  mockRm: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: mockAccess,
    mkdtemp: mockMkdtemp,
    rename: mockRename,
    rm: mockRm,
  },
}));

import {
  extractPdfText,
  inferDrawingSignalsFromPdf,
  PDF_OCR_MAX_PAGES,
  PDF_OCR_MAX_PIXELS,
  PDF_OCR_MIN_DPI,
  PDF_OCR_PAGE_TIMEOUT_MS,
  PDF_OCR_TOTAL_TIMEOUT_MS,
  PDF_TOOL_TIMEOUT_MS,
  PDF_OCR_UNAVAILABLE_WARNING_CODE,
  renderPdfFirstPagePreview,
  renderPdfPreviewAssets,
} from "./pdfDrawing";

const TEST_INPUT_PDF_PATH = "/safe-test/input/example.pdf";
const TEST_QB00002_PDF_PATH = "/safe-test/input/1093-05589-02.pdf";
const TEST_OUTPUT_DIR = "/safe-test/output";
const TEST_OCR_DIR = "/safe-test/work/overdrafter-pdf-ocr-test";

const PRIMARY_REGRESSION_FIXTURE = {
  pageCount: 1,
  pages: [
    {
      page: 1,
      ocrText: "",
      ocrStatus: "ok",
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
        "                                                          ACME Mfg Co.",
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
    mockRm.mockReset();
    mockAccess.mockResolvedValue(undefined);
    mockMkdtemp.mockResolvedValue(TEST_OCR_DIR);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  function mockPopplerAndTesseract(options: {
    pages: number;
    layerText?: (page: number) => string;
    ocrText?: (callIndex: number) => string;
    tesseractMissing?: boolean;
    pdfinfoFails?: boolean;
    /** Page size in points reported by pdfinfo -f N -l N. */
    pageSize?: [number, number];
    onTesseractPage?: () => void;
  }) {
    let ocrCalls = 0;
    mockExecFileAsync.mockImplementation(async (command: string, args: string[]) => {
      if (command === "pdfinfo") {
        if (options.pdfinfoFails) {
          throw new Error("pdfinfo failed");
        }
        const [width, height] = options.pageSize ?? [612, 792];
        const pageArg = args.includes("-f") ? args[args.indexOf("-f") + 1] : null;
        return {
          stdout: pageArg
            ? `Page    ${pageArg} size: ${width} x ${height} pts\n`
            : `Title: Test\nPages: ${options.pages}\n`,
        };
      }
      if (command === "pdftotext") {
        return { stdout: options.layerText?.(Number(args[args.indexOf("-f") + 1])) ?? "" };
      }
      if (command === "tesseract" && args[0] === "--version") {
        if (options.tesseractMissing) {
          throw Object.assign(new Error("spawn tesseract ENOENT"), { code: "ENOENT" });
        }
        return { stdout: "tesseract 5" };
      }
      if (command === "tesseract") {
        ocrCalls += 1;
        options.onTesseractPage?.();
        return { stdout: options.ocrText?.(ocrCalls) ?? "" };
      }
      return { stdout: "" };
    });
  }

  function tesseractPageCalls() {
    return mockExecFileAsync.mock.calls.filter(
      ([command, args]) => command === "tesseract" && args[0] !== "--version",
    );
  }

  it("OCRs every page even when a text layer exists, keeping OCR text separate", async () => {
    mockPopplerAndTesseract({
      pages: 2,
      layerText: (page) => (page === 1 ? "PAGE 1 TEXT" : ""),
      ocrText: (call) => (call === 1 ? "PAGE 1 OCR" : "ITAR CONTROLLED"),
    });

    await expect(extractPdfText(TEST_INPUT_PDF_PATH)).resolves.toEqual({
      pageCount: 2,
      pageCountKnown: true,
      ocr: false,
      pages: [
        { page: 1, text: "PAGE 1 TEXT", ocrText: "PAGE 1 OCR", ocrStatus: "ok" },
        { page: 2, text: "", ocrText: "ITAR CONTROLLED", ocrStatus: "ok" },
      ],
    });

    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      1,
      "pdfinfo",
      [TEST_INPUT_PDF_PATH],
      expect.any(Object),
    );
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      2,
      "pdftotext",
      ["-layout", "-enc", "UTF-8", "-f", "1", "-l", "1", TEST_INPUT_PDF_PATH, "-"],
      expect.any(Object),
    );
    expect(tesseractPageCalls()).toHaveLength(2);
    expect(tesseractPageCalls()[0][2]).toMatchObject({ timeout: PDF_OCR_PAGE_TIMEOUT_MS });
    expect(mockRm).toHaveBeenCalledWith(TEST_OCR_DIR, { recursive: true, force: true });
  });

  it("does not read pages past the OCR page cap", async () => {
    const totalPages = PDF_OCR_MAX_PAGES + 2;
    mockPopplerAndTesseract({ pages: totalPages, ocrText: () => "OCR" });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(result?.pageCount).toBe(totalPages);
    expect(tesseractPageCalls()).toHaveLength(PDF_OCR_MAX_PAGES);
    expect(result?.pages.slice(0, PDF_OCR_MAX_PAGES).every((page) => page.ocrStatus === "ok")).toBe(true);
    expect(result?.pages.slice(PDF_OCR_MAX_PAGES)).toEqual([
      { page: PDF_OCR_MAX_PAGES + 1, text: "", ocrText: "", ocrStatus: "not_read" },
      { page: PDF_OCR_MAX_PAGES + 2, text: "", ocrText: "", ocrStatus: "not_read" },
    ]);
  });

  it("reports every page unavailable, without throwing, when tesseract is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockPopplerAndTesseract({
      pages: 2,
      layerText: (page) => `LAYER ${page}`,
      tesseractMissing: true,
    });

    await expect(extractPdfText(TEST_INPUT_PDF_PATH)).resolves.toEqual({
      pageCount: 2,
      pageCountKnown: true,
      ocr: false,
      pages: [
        { page: 1, text: "LAYER 1", ocrText: "", ocrStatus: "unavailable" },
        { page: 2, text: "LAYER 2", ocrText: "", ocrStatus: "unavailable" },
      ],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(PDF_OCR_UNAVAILABLE_WARNING_CODE);
    expect(tesseractPageCalls()).toHaveLength(0);
    warn.mockRestore();
  });

  it("marks a page failed when tesseract errors or times out on it", async () => {
    mockPopplerAndTesseract({ pages: 2, layerText: () => "LAYER" });
    const base = mockExecFileAsync.getMockImplementation()!;
    let pageCalls = 0;
    mockExecFileAsync.mockImplementation(async (command: string, args: string[], ...rest: unknown[]) => {
      if (command === "tesseract" && args[0] !== "--version") {
        pageCalls += 1;
        if (pageCalls === 2) {
          throw Object.assign(new Error("timed out"), { killed: true });
        }
        return { stdout: "OK TEXT" };
      }
      return base(command, args, ...rest);
    });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(result?.pages.map((page) => [page.ocrStatus, page.ocrText])).toEqual([
      ["ok", "OK TEXT"],
      ["failed", ""],
    ]);
  });

  it("fails closed when pdfinfo fails: the page count is unknown and not fully read", async () => {
    mockPopplerAndTesseract({
      pages: 2,
      pdfinfoFails: true,
      layerText: (page) => (page === 1 ? "PAGE 1 TEXT" : ""),
      ocrText: () => "OCR",
    });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(result?.pageCountKnown).toBe(false);
    expect(result?.pageCount).toBe(1);
    // Without a page size the DPI floor cannot be proven, so the page is not ok.
    expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["failed"]);
    expect(tesseractPageCalls()).toHaveLength(0);
  });

  it("sets ocr only when there is no text layer and OCR produced text", async () => {
    mockPopplerAndTesseract({ pages: 1, ocrText: () => "SCANNED TITLE BLOCK" });
    const scanned = await extractPdfText(TEST_INPUT_PDF_PATH);
    expect(scanned?.ocr).toBe(true);
    expect(scanned?.pages[0].text).toBe("SCANNED TITLE BLOCK");
  });

  it("renders at the DPI floor with a bounded pdftoppm timeout", async () => {
    mockPopplerAndTesseract({ pages: 1, ocrText: () => "OCR" });
    await extractPdfText(TEST_INPUT_PDF_PATH);

    const render = mockExecFileAsync.mock.calls.find(([command]) => command === "pdftoppm");
    expect(render?.[1]).toEqual(expect.arrayContaining(["-r", String(PDF_OCR_MIN_DPI)]));
    expect(render?.[2]).toMatchObject({ timeout: PDF_OCR_PAGE_TIMEOUT_MS });
  });

  it("reports a page failed when the DPI floor would exceed the pixel cap", async () => {
    // 200 DPI on 3000 x 3000 pt is about 69 MP per side squared, over the cap.
    const side = Math.ceil(Math.sqrt(PDF_OCR_MAX_PIXELS) * (72 / PDF_OCR_MIN_DPI)) + 10;
    mockPopplerAndTesseract({ pages: 1, pageSize: [side, side], ocrText: () => "OCR" });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["failed"]);
    expect(mockExecFileAsync.mock.calls.some(([command]) => command === "pdftoppm")).toBe(false);
  });

  it("marks a page failed when the pdftoppm render times out", async () => {
    mockPopplerAndTesseract({ pages: 2, ocrText: () => "OCR" });
    const base = mockExecFileAsync.getMockImplementation()!;
    let renders = 0;
    mockExecFileAsync.mockImplementation(async (command: string, args: string[], ...rest: unknown[]) => {
      if (command === "pdftoppm") {
        renders += 1;
        if (renders === 2) {
          throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
        }
      }
      return base(command, args, ...rest);
    });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["ok", "failed"]);
  });

  it("bounds pdfinfo and pdftotext with a timeout", async () => {
    mockPopplerAndTesseract({ pages: 1, ocrText: () => "OCR" });
    await extractPdfText(TEST_INPUT_PDF_PATH);

    for (const tool of ["pdfinfo", "pdftotext"]) {
      const call = mockExecFileAsync.mock.calls.find(([command]) => command === tool);
      expect(call?.[2]).toMatchObject({ timeout: PDF_TOOL_TIMEOUT_MS });
    }
  });

  it("does not use Quick Look off macOS when the poppler render fails", async () => {
    mockExecFileAsync.mockImplementation(async (command: string) => {
      if (command === "pdftoppm") {
        throw new Error("pdftoppm missing");
      }
      return { stdout: "" };
    });
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await renderPdfFirstPagePreview(TEST_INPUT_PDF_PATH, `${TEST_OUTPUT_DIR}/p.png`);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
    expect(mockExecFileAsync.mock.calls.some(([command]) => command === "qlmanage")).toBe(false);
  });

  it("stops OCR at the total deadline and reports the remaining pages not_read", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      mockPopplerAndTesseract({
        pages: 5,
        ocrText: () => "OCR",
        onTesseractPage: () => {
          now += 50_000;
        },
      });

      const result = await extractPdfText(TEST_INPUT_PDF_PATH);

      expect(PDF_OCR_TOTAL_TIMEOUT_MS).toBe(120_000);
      expect(result?.pages.map((page) => page.ocrStatus)).toEqual([
        "ok",
        "ok",
        "ok",
        "not_read",
        "not_read",
      ]);
      expect(tesseractPageCalls()).toHaveLength(3);
      // The last page that ran was given only the time left, never the full page timeout.
      expect(tesseractPageCalls()[2][2]).toMatchObject({ timeout: 20_000 });
    } finally {
      clock.mockRestore();
    }
  });

  it("renders a thumbnail plus one full-page preview per page on linux-safe tooling", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    await expect(renderPdfPreviewAssets(TEST_INPUT_PDF_PATH, TEST_OUTPUT_DIR, 2)).resolves.toEqual([
      {
        localPath: `${TEST_OUTPUT_DIR}/drawing-thumbnail.png`,
        pageNumber: 1,
        kind: "thumbnail",
        width: null,
        height: null,
        contentType: "image/png",
      },
      {
        localPath: `${TEST_OUTPUT_DIR}/drawing-page-1.png`,
        pageNumber: 1,
        kind: "page",
        width: null,
        height: null,
        contentType: "image/png",
      },
      {
        localPath: `${TEST_OUTPUT_DIR}/drawing-page-2.png`,
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
        TEST_INPUT_PDF_PATH,
        `${TEST_OUTPUT_DIR}/drawing-thumbnail`,
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
        TEST_INPUT_PDF_PATH,
        `${TEST_OUTPUT_DIR}/drawing-page-2`,
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

  // The two cases below reproduce defects found by running the real
  // 1093-05589-02 fixture through the gate, which the idealized synthetic
  // layout above does not expose.

  it("stops a column-bounded value at the end of its own cell", () => {
    // FINISH wraps onto the next row, and the row after that belongs to the
    // adjacent THIRD ANGLE PROJECTION cell, which starts past the FINISH
    // cell's right edge. Falling back to the whole line once the cell had
    // ended used to append "PROJECTION" to the finish.
    const cellEdge = 58;
    const at = (column: number, text: string) => " ".repeat(column) + text;

    const result = inferDrawingSignalsFromPdf({
      baseName: "column-bleed",
      pdfText: {
        pageCount: 1,
        pages: [
          {
            page: 1,
            text: [
              at(50, "ACME Mfg Co."),
              at(50, "TITLE:   MOUNT PLATE"),
              "MATERIAL      6061 ALLOY",
              // SIZE bounds the FINISH cell on the right.
              `${at(0, "FINISH        ANODIZE, BLACK, MIL-A-8625F, TYPE II").padEnd(cellEdge)}SIZE   B`,
              at(28, "CLASS 2"),
              at(cellEdge, "THIRD ANGLE PROJECTION"),
              at(48, "DWG. NO.              REV"),
              at(48, "1093-05589             02"),
              at(48, "SCALE: 1:1                         SHEET 1 OF 1"),
            ].join("\n"),
          },
        ],
      },
    });

    expect(result.finish.value).toBe("ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2");
    expect(result.finish.value).not.toContain("PROJECTION");
  });

  it("reads a full value when its label sits alone on a shorter line", () => {
    // The MATERIAL label is alone above its value. Clipping the value row to
    // the label row's width used to truncate "6061 Alloy" to "6061".
    const result = inferDrawingSignalsFromPdf({
      baseName: "label-above-value",
      pdfText: {
        pageCount: 1,
        pages: [
          {
            page: 1,
            text: [
              "                                                          ACME Mfg Co.",
              "                                                          TITLE:   MOUNT PLATE",
              "          MATERIAL",
              "              6061 Alloy",
              "FINISH        ANODIZE, BLACK, TYPE II",
              "                                                SIZE      B     DWG. NO.              REV",
              "                                                              1093-05589             02",
              "                                                SCALE: 1:1                         SHEET 1 OF 1",
            ].join("\n"),
          },
        ],
      },
    });

    expect(result.material.value).toBe("6061 Alloy");
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

  it("prefers the strict filename identity over structurally invalid OCR title-block values", () => {
    const result = inferDrawingSignalsFromPdf({
      baseName: "1093-05589-02",
      pdfText: {
        pageCount: 1,
        pages: [
          {
            page: 1,
            text: [
              "8 7 6 5 4 3 2 1",
              "REVISIONS",
              "REV DESCRIPTION ENGINEER | EC#/DATE",
              "02 |CHANGED HOLE SIZE TIM 11/18/2013",
              "N",
              "N",
              "x SS 6",
              "ro) nm fo) Q",
              "® .317 THRU ALL",
              "——|",
              "== «",
              "|",
              "-—)",
              "2X R.59",
              "@1.315",
              "——",
              "c",
              "—S",
              "PROPRIETARY AND CONFIDENTIAL UNLESS OTHERWISE SPECIFIED: APPROVALS NAME DATE ACME Mfg Co.",
              "PREUWING WHE SOLE DRObEENY OF DIMENSIONS ARE IN INCHES SURFACE FINSH NS ENGINEER TIM 10/29/2013 TITLE:",
              "ACME MFG CO. ANY Oe each 5° BEND+2° INTERPRET GEOMETRIC DRAWN TIM 10/29/2013 * ROUND, CARBON FIBER END ATTACHMENTS",
              "REPRODUCTION IN PART OR AS A WHOLE * AL £01 TOLERANCING PER: ~ ~ BONDED",
              "WITHOUT THE WRITTEN PERMISSION OF TWO PLACE DECIMAL 2.01 ANSI Y14.5 1994 CHECKED",
              "AD TECHNOLOGY CORPORATION IS THREE PLACE DECIMAL #.005 MFG",
              "PROHIBITED, BREAK SHARP EDGES .003-.007 DO NOT SCALE DRAWING SIZE DWG. NO. REV",
              "QA.",
              "MATERIAL FINISH ANODIZE, BLACK, MIL-A-8625F, TYPE II B",
              "6061 Alloy CLASS 2 THIRD ANGLE 0093-05589 02",
              "Project: SAMPLE - File Name: SAMPLE",
            ].join("\n"),
          },
        ],
      },
    });

    expect(result.partNumber.value).toBe("1093-05589");
    expect(result.revision.value).toBe("02");
    expect(result.description.value).toBe("ROUND, CARBON FIBER END ATTACHMENTS BONDED");
    expect(result.quoteDescription).toBe("BONDED, CARBON FIBER END ATTACHMENT");
    expect(result.description.reasons).toContain("ocr_title_block");
    expect(result.partNumber.reasons).toContain("filename_stem");
    expect(result.revision.reasons).toContain("filename_stem");
  });
});
