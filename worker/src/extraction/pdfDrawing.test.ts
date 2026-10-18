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
  PDF_TEXT_LAYER_MAX_PAGES,
  PDF_TEXT_LAYER_TOTAL_TIMEOUT_MS,
  PDF_TOOL_TIMEOUT_MS,
  PDF_OCR_UNAVAILABLE_WARNING_CODE,
  renderPdfFirstPagePreview,
  renderPdfPreviewAssets,
  renderPdfTitleBlockCrop,
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
      drawingFullyRead: true,
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
    expect(result?.drawingFullyRead).toBe(false);
    expect(tesseractPageCalls()).toHaveLength(PDF_OCR_MAX_PAGES);
    expect(result?.pages.slice(0, PDF_OCR_MAX_PAGES).every((page) => page.ocrStatus === "ok")).toBe(true);
    expect(result?.pages.slice(PDF_OCR_MAX_PAGES)).toEqual([
      { page: PDF_OCR_MAX_PAGES + 1, text: "", ocrText: "", ocrStatus: "not_read", ocrLimit: "page_cap" },
      { page: PDF_OCR_MAX_PAGES + 2, text: "", ocrText: "", ocrStatus: "not_read", ocrLimit: "page_cap" },
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
      drawingFullyRead: false,
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
    expect(result?.drawingFullyRead).toBe(false);
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
    expect(result?.drawingFullyRead).toBe(false);
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

  it("renders the CropBox, the same box pdfinfo reports and the pixel cap is checked against", async () => {
    mockPopplerAndTesseract({ pages: 1, ocrText: () => "OCR" });
    await extractPdfText(TEST_INPUT_PDF_PATH);

    const render = mockExecFileAsync.mock.calls.find(([command]) => command === "pdftoppm");
    expect(render?.[1]).toContain("-cropbox");
  });

  it("caps the pixel budget near 70 MP so an E size sheet at the DPI floor still fits", async () => {
    expect(PDF_OCR_MAX_PIXELS).toBe(70_000_000);
    // E size is 44 x 34 in, about 60 MP at 200 DPI.
    mockPopplerAndTesseract({
      pages: 1,
      pageSize: [44 * 72, 34 * 72],
      ocrText: () => "OCR",
    });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["ok"]);
  });

  it("runs tesseract with a single OpenMP thread", async () => {
    mockPopplerAndTesseract({ pages: 1, ocrText: () => "OCR" });
    await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(tesseractPageCalls()[0][2]).toMatchObject({
      env: expect.objectContaining({ OMP_THREAD_LIMIT: "1" }),
    });
  });

  it("reports every page unavailable when the tesseract version probe times out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockPopplerAndTesseract({ pages: 2, layerText: () => "LAYER" });
    const base = mockExecFileAsync.getMockImplementation()!;
    mockExecFileAsync.mockImplementation(async (command: string, args: string[], ...rest: unknown[]) => {
      if (command === "tesseract" && args[0] === "--version") {
        throw Object.assign(new Error("timed out"), {
          killed: true,
          signal: "SIGTERM",
        });
      }
      return base(command, args, ...rest);
    });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    const probe = mockExecFileAsync.mock.calls.find(
      ([command, args]) => command === "tesseract" && args[0] === "--version",
    );
    expect(probe?.[2]).toMatchObject({ timeout: PDF_TOOL_TIMEOUT_MS });
    expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["unavailable", "unavailable"]);
    expect(result?.drawingFullyRead).toBe(false);
    expect(tesseractPageCalls()).toHaveLength(0);
    warn.mockRestore();
  });

  it("counts the version probe against the total OCR budget", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      mockPopplerAndTesseract({ pages: 1, ocrText: () => "OCR" });
      const base = mockExecFileAsync.getMockImplementation()!;
      mockExecFileAsync.mockImplementation(async (command: string, args: string[], ...rest: unknown[]) => {
        if (command === "tesseract" && args[0] === "--version") {
          now += PDF_OCR_TOTAL_TIMEOUT_MS;
        }
        return base(command, args, ...rest);
      });

      const result = await extractPdfText(TEST_INPUT_PDF_PATH);

      expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["not_read"]);
      // No pdfinfo page size call, render, or tesseract run starts once the budget is gone.
      expect(mockExecFileAsync.mock.calls.some(([command, args]) => command === "pdfinfo" && args.includes("-f"))).toBe(
        false,
      );
      expect(mockExecFileAsync.mock.calls.some(([command]) => command === "pdftoppm")).toBe(false);
      expect(tesseractPageCalls()).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("skips tesseract and reports the page not_read when the render uses up the budget", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      mockPopplerAndTesseract({ pages: 1, ocrText: () => "OCR" });
      const base = mockExecFileAsync.getMockImplementation()!;
      mockExecFileAsync.mockImplementation(async (command: string, args: string[], ...rest: unknown[]) => {
        if (command === "pdftoppm") {
          now += PDF_OCR_TOTAL_TIMEOUT_MS;
        }
        return base(command, args, ...rest);
      });

      const result = await extractPdfText(TEST_INPUT_PDF_PATH);

      expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["not_read"]);
      expect(tesseractPageCalls()).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("gives the page size pdfinfo call only the OCR time left", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      mockPopplerAndTesseract({
        pages: 2,
        ocrText: () => "OCR",
        onTesseractPage: () => (now += 110_000),
      });

      await extractPdfText(TEST_INPUT_PDF_PATH);

      const sizeCalls = mockExecFileAsync.mock.calls.filter(
        ([command, args]) => command === "pdfinfo" && args.includes("-f"),
      );
      expect(sizeCalls[0][2]).toMatchObject({ timeout: PDF_TOOL_TIMEOUT_MS });
      expect(sizeCalls[1][2]).toMatchObject({
        timeout: PDF_OCR_TOTAL_TIMEOUT_MS - 110_000,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("does not read the text layer past its page cap and is then not fully read", async () => {
    const totalPages = PDF_TEXT_LAYER_MAX_PAGES + 1;
    mockPopplerAndTesseract({
      pages: totalPages,
      layerText: () => "LAYER",
      ocrText: () => "OCR",
    });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(mockExecFileAsync.mock.calls.filter(([command]) => command === "pdftotext")).toHaveLength(
      PDF_TEXT_LAYER_MAX_PAGES,
    );
    expect(result?.pages[PDF_TEXT_LAYER_MAX_PAGES].text).toBe("");
    expect(result?.drawingFullyRead).toBe(false);
  });

  it("stops the text layer loop at its total budget", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      mockPopplerAndTesseract({ pages: 3, ocrText: () => "OCR" });
      const base = mockExecFileAsync.getMockImplementation()!;
      mockExecFileAsync.mockImplementation(async (command: string, args: string[], ...rest: unknown[]) => {
        if (command === "pdftotext") {
          now += PDF_TEXT_LAYER_TOTAL_TIMEOUT_MS / 2;
          return { stdout: "LAYER" };
        }
        return base(command, args, ...rest);
      });

      const result = await extractPdfText(TEST_INPUT_PDF_PATH);

      const textCalls = mockExecFileAsync.mock.calls.filter(([command]) => command === "pdftotext");
      expect(textCalls).toHaveLength(2);
      expect(textCalls[1][2]).toMatchObject({ timeout: PDF_TOOL_TIMEOUT_MS });
      expect(result?.pages.map((page) => page.text)).toEqual(["LAYER", "LAYER", ""]);
      expect(result?.drawingFullyRead).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("is not fully read when pdftotext fails on a page", async () => {
    mockPopplerAndTesseract({ pages: 1, ocrText: () => "OCR" });
    const base = mockExecFileAsync.getMockImplementation()!;
    mockExecFileAsync.mockImplementation(async (command: string, args: string[], ...rest: unknown[]) => {
      if (command === "pdftotext") {
        throw new Error("pdftotext failed");
      }
      return base(command, args, ...rest);
    });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["ok"]);
    expect(result?.drawingFullyRead).toBe(false);
  });

  it("bounds the preview render and returns null when it times out", async () => {
    mockExecFileAsync.mockImplementation(async (command: string) => {
      if (command === "pdftoppm") {
        throw Object.assign(new Error("timed out"), {
          killed: true,
          signal: "SIGTERM",
        });
      }
      return { stdout: "" };
    });
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await expect(renderPdfFirstPagePreview(TEST_INPUT_PDF_PATH, `${TEST_OUTPUT_DIR}/p.png`)).resolves.toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
    const render = mockExecFileAsync.mock.calls.find(([command]) => command === "pdftoppm");
    expect(render?.[2]).toMatchObject({ timeout: PDF_OCR_PAGE_TIMEOUT_MS });
  });

  it("renders the title block crop from the CropBox with a bounded pdftoppm timeout", async () => {
    mockExecFileAsync.mockImplementation(async (command: string) =>
      command === "pdfinfo" ? { stdout: "Page    1 size:      612 x 792 pts (letter)\n" } : { stdout: "" },
    );

    const crop = await renderPdfTitleBlockCrop(TEST_INPUT_PDF_PATH, `${TEST_OUTPUT_DIR}/crop.png`);

    // The size line ends in "(letter)"; it still parses.
    expect(crop).toMatchObject({ width: 663, height: 694 });
    const render = mockExecFileAsync.mock.calls.find(([command]) => command === "pdftoppm");
    expect(render?.[1]).toContain("-cropbox");
    expect(render?.[2]).toMatchObject({ timeout: PDF_OCR_PAGE_TIMEOUT_MS });
  });

  it("reports a page failed when the DPI floor would exceed the pixel cap", async () => {
    // A square page just over the cap at the DPI floor.
    const side = Math.ceil(Math.sqrt(PDF_OCR_MAX_PIXELS) * (72 / PDF_OCR_MIN_DPI)) + 10;
    mockPopplerAndTesseract({ pages: 1, pageSize: [side, side], ocrText: () => "OCR" });

    const result = await extractPdfText(TEST_INPUT_PDF_PATH);

    expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["failed"]);
    expect(result?.pages.map((page) => page.ocrLimit)).toEqual(["pixel_cap"]);
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
    // A timeout is not a fixed limit: a recheck of the same bytes may read it.
    expect(result?.pages.map((page) => page.ocrLimit)).toEqual([undefined, undefined]);
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

describe("pdfDrawing tightest tolerance units (OVD-976)", () => {
  function tolerance(lines: string[]) {
    const result = inferDrawingSignalsFromPdf({
      baseName: "1000-00001-A",
      pdfText: { pageCount: 1, pages: [{ page: 1, text: ["MATERIAL 6061-T6", ...lines].join("\n") }] },
    });
    return {
      raw: result.tightestTolerance,
      valueInch: result.tightestToleranceValueInch,
      unit: result.tightestToleranceUnit,
      drawingUnits: result.tightestToleranceDrawingUnits,
    };
  }

  it("converts a bare tolerance on a millimeter drawing instead of reading it as inches", () => {
    const result = tolerance(["DIMENSIONS ARE IN MILLIMETERS", "UNLESS OTHERWISE SPECIFIED TOLERANCES ±0.1"]);
    expect(result.valueInch).toBe(0.0039);
    expect(result.valueInch).toBe(0.0039); // floored to the 4 decimals of numeric(10,4), never rounded up
    expect(result.valueInch).not.toBe(0.1);
    expect(result.unit).toBe("mm");
    expect(result.drawingUnits).toBe("metric");
    expect(result.raw).toBe("±0.1 mm");
  });

  it.each([
    ["DIMENSIONS IN MM", "TOLERANCE +/- 0.1"],
    ["METRIC", "TOLERANCE ±0.1"],
  ])("recognizes metric drawing markers (%s)", (marker, line) => {
    expect(tolerance([marker, line]).valueInch).toBe(0.0039);
  });

  it("converts explicit mm, micron and mil suffixes", () => {
    expect(tolerance(["TOLERANCES ±0.05 mm"]).valueInch).toBe(0.0019);
    expect(tolerance(["TOLERANCE ±25 µm"]).valueInch).toBe(0.0009);
    expect(tolerance(["TOLERANCE ±25 um"]).valueInch).toBe(0.0009);
    expect(tolerance(["TOLERANCE ±5 mil"]).valueInch).toBe(0.005);
    expect(tolerance(["TOLERANCE ±5 mil"]).unit).toBe("mil");
  });

  it("takes the tightest value across mixed per-value units", () => {
    const result = tolerance(["DIMENSIONS IN MM", "GENERAL TOLERANCE ±0.2", "Ø12 H7 ±0.05"]);
    expect(result.valueInch).toBe(0.0019);
  });

  it("ignores angular tolerances", () => {
    expect(tolerance(["DIMENSIONS ARE IN INCHES", "ANGULAR ±.005°", "LINEAR ±.010"]).valueInch).toBe(0.01);
    expect(tolerance(["DIMENSIONS ARE IN INCHES", "ANGULAR ±0.5 DEG", "LINEAR ±.010"]).valueInch).toBe(0.01);
    expect(tolerance(["DIMENSIONS ARE IN INCHES", "ANGULAR ±.005", "LINEAR ±.010"]).valueInch).toBe(0.01);
  });

  it("ignores a degree sign even without an ANGULAR label", () => {
    expect(tolerance(["DIMENSIONS ARE IN INCHES", "ALL BENDS ±.005°", "LINEAR ±.010"]).valueInch).toBe(0.01);
  });

  it("reports no tolerance when only angular values are present", () => {
    const result = tolerance(["ANGULAR ±0.5°"]);
    expect(result.raw).toBeNull();
    expect(result.valueInch ?? null).toBeNull();
  });

  it("keeps inch controls unchanged", () => {
    expect(tolerance(["TOLERANCES ±.005"])).toMatchObject({ raw: "±0.005", valueInch: 0.005, unit: "in" });
    expect(tolerance(["TOLERANCES ±0.005 IN"])).toMatchObject({ raw: "±0.005", valueInch: 0.005, unit: "in" });
    expect(tolerance(["DIMENSIONS ARE IN INCHES", "TOLERANCES ±.010"])).toMatchObject({
      valueInch: 0.01,
      drawingUnits: "inch",
    });
    expect(tolerance(["TWO PLACE DECIMAL +.01", "THREE PLACE DECIMAL +.005"])).toMatchObject({
      raw: "±0.005",
      valueInch: 0.005,
    });
    expect(tolerance(["DIMENSIONS ARE IN INCHES", "TWO PLACE DECIMAL ±.01"]).valueInch).toBe(0.01);
  });

  it("reads decimal-place lines as inches even when the drawing also mentions millimeters", () => {
    expect(tolerance(["DIMENSIONS IN INCHES [MILLIMETERS]", "THREE PLACE DECIMAL +.005"])).toMatchObject({
      valueInch: 0.005,
      unit: "in",
      drawingUnits: "mixed",
    });
  });

  it("reads a consistent dual-dimension tolerance as one value, never looser than either side", () => {
    const result = tolerance(["TOLERANCES ±0.1 mm [±.004 in]"]);
    expect(result.valueInch).toBe(0.0039);
    expect(result.unit).toBe("mm");
  });

  it("fails closed when units cannot be resolved", () => {
    // No unit signal and a value that is not plausible as inches.
    const implausible = tolerance(["TOLERANCES ±1"]);
    expect(implausible.valueInch).toBeNull();
    expect(implausible.raw).toBe("±1");
    expect(implausible.unit).toBe("unknown");

    // Conflicting drawing-level unit signals with a bare value.
    const mixed = tolerance(["DIMENSIONS IN INCHES [MILLIMETERS]", "TOLERANCES ±.005"]);
    expect(mixed.valueInch).toBeNull();
    expect(mixed.raw).toBe("±0.005");
    expect(mixed.drawingUnits).toBe("mixed");
  });

  it("does not resolve to a value when any tolerance is unresolved", () => {
    expect(
      tolerance(["DIMENSIONS IN INCHES [MILLIMETERS]", "TOLERANCES ±.005", "NOTE ±.001 mm"]).valueInch,
    ).toBeNull();
  });

  it("leaves ISO 2768 class callouts without a plus-minus value unset", () => {
    const result = tolerance(["DIMENSIONS IN MM", "GENERAL TOLERANCES ISO 2768-m"]);
    expect(result.raw).toBeNull();
    expect(result.valueInch ?? null).toBeNull();
  });

  it("treats an ISO 2768 callout as a metric drawing signal", () => {
    expect(tolerance(["TOLERANCES PER ISO 2768-m", "Ø12 H7 ±0.05"]).valueInch).toBe(0.0019);
  });

  it("accepts an inch value above the unlabelled plausibility bound when the drawing declares inches", () => {
    expect(tolerance(["UNITS: IN", "TOLERANCES ±0.25"])).toMatchObject({ valueInch: 0.25, drawingUnits: "inch" });
    expect(tolerance(["DIMENSIONS ARE IN INCHES", "TOLERANCES ±0.25"]).valueInch).toBe(0.25);
    expect(tolerance(["TOLERANCES ±0.25"]).valueInch).toBeNull();
  });

  it("ignores an angular value on a metric drawing and converts the linear one", () => {
    expect(tolerance(["DIMENSIONS IN MM", "ANGULAR ±0.5°", "LINEAR ±0.2"]).valueInch).toBe(0.0078);
  });

  describe("repair round 1 (adversarial review)", () => {
    // B1: a bracketed bare value is adopted as inches only when it matches the mm value.
    it("B1 H03: does not adopt an unrelated bracketed value as the inch counterpart", () => {
      const result = tolerance(["DIMENSIONS IN MM", "BORE ±0.02 mm (±0.1 BEFORE PLATING)"]);
      expect(result.valueInch).not.toBeNull();
      expect(result.valueInch as number).toBeGreaterThan(0);
      expect(result.valueInch as number).toBeLessThanOrEqual(0.00079);
    });

    it("B1 H28: '±0.05mm [±0.5]' never stores 0.5", () => {
      const result = tolerance(["BORE ±0.05mm [±0.5]"]);
      expect(result.valueInch as number).toBeLessThanOrEqual(0.00197);
      expect(result.valueInch as number).toBeGreaterThan(0);
    });

    it("B1 H04: an inconsistent '±0.1 mm [±.04 in]' pair keeps the tighter converted value", () => {
      const result = tolerance(["TOLERANCES ±0.1 mm [±.04 in]"]);
      expect(result.valueInch as number).toBeLessThanOrEqual(0.00394);
      expect(result.valueInch as number).toBeGreaterThan(0);
    });

    it("B1: a consistent '±0.1 mm [±.004 in]' pair gives the tighter of the two", () => {
      for (const line of ["TOLERANCES ±0.1 mm [±.004 in]", "TOLERANCES ±0.1 mm [±.004]"]) {
        const result = tolerance([line]);
        expect(result.valueInch as number).toBeLessThanOrEqual(0.004);
        expect(result.valueInch as number).toBeGreaterThanOrEqual(0.0039);
      }
    });

    it("B1: on a mixed drawing an inconsistent bracketed bare value stays unresolved", () => {
      const result = tolerance(["DIMENSIONS IN INCHES [MILLIMETERS]", "BORE ±0.05 mm [±0.5]"]);
      expect(result.valueInch).toBeNull();
      expect(result.unit).toBe("unknown");
      // The same pair with a consistent inch counterpart resolves.
      expect(tolerance(["DIMENSIONS IN INCHES [MILLIMETERS]", "BORE ±0.05 mm [±0.002]"]).valueInch).toBe(0.0019);
    });

    it("B1 H22: an inch-first '±.004 [±0.1 mm]' dual is not read as 0.004 mm", () => {
      const result = tolerance(["TOLERANCES ±.004 [±0.1 mm]"]);
      expect(result.valueInch as number).toBeLessThanOrEqual(0.004);
      expect(result.valueInch as number).toBeGreaterThanOrEqual(0.0039);
    });

    // B2: decimal commas and zero values.
    it("B2 H07/H08: a decimal comma is unresolved, never 0", () => {
      for (const lines of [
        ["DIMENSIONS IN MM", "TOLERANCES ±0,05"],
        ["TOLERANCES ±0,1"],
        ["TOLERANCES ±0,05 mm"],
      ]) {
        const result = tolerance(lines);
        expect(result.valueInch).toBeNull();
        expect(result.unit).toBe("unknown");
        expect(result.raw).not.toBeNull();
      }
    });

    it("B2: a decimal comma after a decimal-place phrase is unresolved and keeps its raw text", () => {
      const result = tolerance(["DIMENSIONS ARE IN INCHES", "TWO PLACE DECIMAL +0,1"]);
      expect(result.valueInch).toBeNull();
      expect(result.unit).toBe("unknown");
      expect(result.raw).toBe("±0,1");
    });

    it("B2: a zero or non-positive tolerance is unresolved, never stored as 0", () => {
      for (const lines of [["DIMENSIONS ARE IN INCHES", "TOLERANCES ±0"], ["TOLERANCES ±0.000"], ["TWO PLACE DECIMAL +0"]]) {
        const result = tolerance(lines);
        expect(result.valueInch).toBeNull();
        expect(result.unit).toBe("unknown");
      }
    });

    // H1: numeric(10,4) rounds half up, so converted values are floored to 4 decimals.
    it("H1: a converted value never rounds up across the 0.005 gate", () => {
      const result = tolerance(["TOLERANCES ±0.126 mm"]);
      expect(result.valueInch).toBe(0.0049);
    });

    it("H1: a micron tolerance never collapses to 0", () => {
      const result = tolerance(["TOLERANCES ±1 µm"]);
      expect(result.valueInch).toBe(0.0001);
    });

    // H2: decimal-place phrases obey the plausibility bound on mixed drawings.
    it("H2 H06: a TWO PLACE DECIMAL +0.1 on a mixed drawing is unresolved", () => {
      const result = tolerance(["DIMENSIONS IN MILLIMETERS", "NOTE: 1 INCH = 25.4", "TWO PLACE DECIMAL +0.1"]);
      expect(result.valueInch).toBeNull();
      expect(result.unit).toBe("unknown");
    });

    // H3: the English word IN is not an inch suffix on metric or mixed drawings.
    it("H3 H02: '±0.1 IN ALL DIRECTIONS' on a metric drawing is not 0.1 inch", () => {
      const result = tolerance(["DIMENSIONS IN MM", "PROFILE ±0.1 IN ALL DIRECTIONS"]);
      expect(result.valueInch).toBe(0.0039);
    });

    it("H3: an explicit inch marker still counts on a metric drawing", () => {
      expect(tolerance(["DIMENSIONS IN MM", "BORE ±.001\""]).valueInch).toBe(0.001);
      expect(tolerance(["DIMENSIONS IN MM", "BORE ±.002 INCH"]).valueInch).toBe(0.002);
      expect(tolerance(["DIMENSIONS IN MM", "BORE ±.005 IN"]).valueInch).toBe(0.005);
    });

    // H4: glued units are metric signals; bare mu is microns; percent is not a tolerance.
    it("H4 H01: a glued millimeter unit makes the drawing metric", () => {
      const result = tolerance(["Ø12mm THRU", "TOLERANCES ±0.05"]);
      expect(result.drawingUnits).toBe("metric");
      expect(result.valueInch).toBe(0.0019);
    });

    it("H4 H11: a bare micro sign is microns", () => {
      const result = tolerance(["DIMENSIONS IN MM", "BORE ±5μ"]);
      expect(result.unit).toBe("um");
      expect(result.valueInch).toBe(0.0001);
    });

    it("H4 H20: a percent value is not a length tolerance", () => {
      const result = tolerance(["DIMENSIONS ARE IN INCHES", "SPRING RATE ±10%"]);
      expect(result.raw).toBeNull();
      expect(result.valueInch ?? null).toBeNull();
    });

    it("H4: a microinch value is unresolved, never read as inches", () => {
      const result = tolerance(["DIMENSIONS ARE IN INCHES", "FINISH ±32 µin", "BORE ±.002"]);
      expect(result.valueInch).toBeNull();
    });

    // H5: MM counts as a metric signal only in unit contexts.
    it("H5 H17/H34: MM in a date template or part number does not make an inch drawing metric", () => {
      expect(tolerance(["DATE YYYY-MM-DD", "TOLERANCES ±.005"])).toMatchObject({ valueInch: 0.005, drawingUnits: "unspecified" });
      expect(tolerance(["DATE MM/DD/YY", "TOLERANCES ±.005"]).valueInch).toBe(0.005);
      expect(tolerance(["DATE FORMAT IN MM/DD/YY", "TOLERANCES ±.005"]).valueInch).toBe(0.005);
      expect(tolerance(["FORMAT IN MM-DD-YYYY", "TOLERANCES ±.005"]).valueInch).toBe(0.005);
      expect(tolerance(["PART NO MM-1234", "TOLERANCES ±.005"]).valueInch).toBe(0.005);
    });

    it("H5: MM still counts after a unit introducer or beside a number", () => {
      expect(tolerance(["UNITS: MM", "TOLERANCES ±0.2"]).valueInch).toBe(0.0078);
      expect(tolerance(["ALL DIMENSIONS ARE IN MILLIMETERS", "TOLERANCES ±0.2"]).valueInch).toBe(0.0078);
      expect(tolerance(["OVERALL 12 MM", "TOLERANCES ±0.2"]).valueInch).toBe(0.0078);
    });
  });
});
