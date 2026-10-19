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
      valueInch: result.tightestToleranceValueInch ?? null,
      unit: result.tightestToleranceUnit ?? null,
      drawingUnits: result.tightestToleranceDrawingUnits ?? null,
    };
  }

  const INCH = "DIMENSIONS ARE IN INCHES";
  const METRIC = "DIMENSIONS IN MM";

  it("converts a bare tolerance on a millimeter drawing instead of reading it as inches", () => {
    expect(tolerance(["DIMENSIONS ARE IN MILLIMETERS", "UNLESS OTHERWISE SPECIFIED TOLERANCES ±0.1"])).toEqual({
      raw: "±0.1 mm",
      valueInch: 0.0039,
      unit: "mm",
      drawingUnits: "metric",
    });
  });

  it("converts explicit mm, micron and mil suffixes", () => {
    expect(tolerance(["TOLERANCES ±0.05 mm"]).valueInch).toBe(0.0019);
    expect(tolerance(["TOLERANCE ±25 µm"]).valueInch).toBe(0.0009);
    expect(tolerance(["TOLERANCE ±25 um"]).valueInch).toBe(0.0009);
    expect(tolerance(["TOLERANCE ±5 mil"])).toMatchObject({ valueInch: 0.005, unit: "mil" });
  });

  it("takes the tightest value across mixed per-value units", () => {
    expect(tolerance([METRIC, "GENERAL TOLERANCE ±0.2", "Ø12 H7 ±0.05"]).valueInch).toBe(0.0019);
  });

  it("reports no tolerance when there is no plus-minus value", () => {
    expect(tolerance([METRIC, "GENERAL TOLERANCES ISO 2768-m"])).toMatchObject({ raw: null, valueInch: null });
  });

  // P1: units come only from explicit declarations.
  describe("P1 drawing unit declarations", () => {
    it.each([
      ["DIMENSIONS ARE IN MILLIMETERS"],
      ["ALL DIMENSIONS ARE IN MILLIMETRES"],
      ["DIMENSIONS IN MM"],
      ["UNITS: MM"],
      ["UNIT: mm"],
      ["SCALE 1:1  UNIT mm"],
      ["DIMENSIONS [mm]"],
      ["UNITS [MM]"],
      ["DIMENSIONS IN [mm]"],
      ["ALL DIMENSIONS (mm)"],
      ["UNITS - MM"],
      ["DIMENSIONS ARE METRIC"],
      ["METRIC"],
      ["[mm]"],
      ["GENERAL TOLERANCES ISO 2768-mK"],
      ["TOLERANCES IN ACCORDANCE WITH ISO 2768-m"],
      ["GENERAL TOLERANCES DIN 7168-m"],
      ["GENERAL TOLERANCES JIS B 0405-m"],
      ["GENERAL TOLERANCES EN 22768-m"],
      ["DIMENSIONS IN rnm"],
      ["DIMENSIONS IN мм"],
      ["DIMENSIONS IN ΜΜ"],
      ["DIMENSIONS IN ｍｍ"],
      ["DIMENSIONS IN ㎜"],
      ["DIMENSIONS: IN MM"],
      ["Maße in mm"],
      ["COTES EN MM"],
    ])("reads %s as a metric declaration", (declaration) => {
      expect(tolerance([declaration, "BORE ±0.05"])).toMatchObject({
        valueInch: 0.0019,
        unit: "mm",
        drawingUnits: "metric",
      });
    });

    it.each([
      ["DIMENSIONS ARE IN INCHES"],
      ["ALL DIMENSIONS ARE IN INCHES"],
      ["UNITS: IN"],
      ["UNITS: INCH"],
      ["SCALE: FULL  UNITS: INCH"],
      ["DIMENSIONS IN IN"],
      ["DIMENSIONS ARE IN IN."],
      ["UNITS (INCHES)"],
      ["INCHES"],
    ])("reads %s as an inch declaration", (declaration) => {
      expect(tolerance([declaration, "BORE ±0.05"])).toMatchObject({
        valueInch: 0.05,
        unit: "in",
        drawingUnits: "inch",
      });
    });

    it("treats a declaration of both systems as mixed and leaves bare values unresolved", () => {
      for (const declaration of [
        "DIMENSIONS IN INCHES [MILLIMETERS]",
        "DIMENSIONS ARE IN MM (INCHES)",
        "DIMENSIONS IN INCHES AND MILLIMETERS",
      ]) {
        expect(tolerance([declaration, "TOLERANCES ±.005"])).toEqual({
          raw: "±0.005",
          valueInch: null,
          unit: "unknown",
          drawingUnits: "mixed",
        });
      }
      // Two pages, one declared in each system.
      expect(tolerance([INCH, "TOLERANCES ±.005", METRIC, "VENDOR ITEM ±0.1"]).valueInch).toBeNull();
    });

    it("does not read the preposition IN as an inch declaration", () => {
      // "IN ACCORDANCE" and a line that wraps after "IN" are not unit words.
      expect(tolerance(["TOLERANCES IN ACCORDANCE WITH ASME Y14.5M", "BORE ±0.05"]).drawingUnits).toBe("unspecified");
      expect(tolerance(["DIMENSIONS ARE IN", "MILLIMETERS UNLESS OTHERWISE SPECIFIED", "BORE ±0.05"])).toMatchObject({
        valueInch: null,
        drawingUnits: "unspecified",
      });
    });
  });

  // P2: incidental unit tokens are not declarations.
  describe("P2 incidental unit tokens", () => {
    it.each([
      ["Ø12mm THRU"],
      ["ITEM 3  6 MM DOWEL PIN"],
      ["SURFACE Ra 0.8 µm"],
      ["REV B CHANGED 10mm TO 12mm"],
      ["USE METRIC HARDWARE"],
      ["SHEET 279 X 216 MM"],
      ["SHEET 279 X 216 (MM)"],
      ["OVERALL 12 MM"],
      ["DATE YYYY-MM-DD"],
      ["DATE FORMAT IN MM/DD/YY"],
      ["PART NO MM-1234"],
      ["FINISH PER MIL-A-8625 TYPE II"],
      ["NOTE: 1 INCH = 25.4 MM"],
      ["INCH EQUIVALENTS FOR REFERENCE ONLY"],
      ["TITLE: SPACER, 10MM"],
    ])("%s does not declare units", (incidental) => {
      // Undeclared, so a two-decimal bare value is unresolved rather than read in either system.
      expect(tolerance([incidental, "BORE ±0.05"])).toMatchObject({ valueInch: null, drawingUnits: "unspecified" });
      // An inch declaration is never flipped by the incidental token.
      expect(tolerance([INCH, incidental, "TOLERANCES ±.005"])).toMatchObject({
        valueInch: 0.005,
        unit: "in",
        drawingUnits: "inch",
      });
      // Nor is a metric declaration.
      expect(tolerance([METRIC, incidental, "TOLERANCES ±0.1"])).toMatchObject({
        valueInch: 0.0039,
        drawingUnits: "metric",
      });
    });

    it("keeps a metric declaration metric when an inch conversion note is present (F3)", () => {
      expect(
        tolerance(["DIMENSIONS IN MILLIMETERS", "NOTE: 1 INCH = 25.4 MM", "TWO PLACE DECIMAL +0.05"]),
      ).toMatchObject({ valueInch: 0.0019, unit: "mm", drawingUnits: "metric" });
    });
  });

  // P3: a unit written on the value, on the same line, wins.
  describe("P3 value suffixes", () => {
    it.each([
      ["BORE ±0.05 mm", 0.0019, "mm"],
      ["BORE ±0.05mm", 0.0019, "mm"],
      ["BORE ±0.05 MM", 0.0019, "mm"],
      ["BORE ±0.05 millimetres", 0.0019, "mm"],
      ["BORE ±0.05 [mm]", 0.0019, "mm"],
      ["BORE ±0.05 (mm)", 0.0019, "mm"],
      ["BORE ±0.05 rnm", 0.0019, "mm"],
      ["BORE ±0.05 мм", 0.0019, "mm"],
      ["BORE ±0.05 ｍｍ", 0.0019, "mm"],
      ["BORE ±25 µm", 0.0009, "um"],
      ["BORE ±25 μm", 0.0009, "um"],
      ["BORE ±25 um", 0.0009, "um"],
      ["BORE ±25 UM", 0.0009, "um"],
      ["BORE ±25 microns", 0.0009, "um"],
      ["BORE ±25 ΜM", 0.0009, "um"],
      ["BORE ±5 mil", 0.005, "mil"],
      ["BORE ±2 mils", 0.002, "mil"],
      ["BORE ±.005 IN", 0.005, "in"],
      ["BORE ±.25 INCHES", 0.25, "in"],
      ['BORE ±.005"', 0.005, "in"],
      ["BORE ±0.05″", 0.05, "in"],
    ])("%s resolves by its suffix", (line, valueInch, unit) => {
      expect(tolerance([line])).toMatchObject({ valueInch, unit });
    });

    it("lets a suffix beat the drawing declaration", () => {
      expect(tolerance([INCH, "BORE ±0.05 mm", "GENERAL ±.010"])).toMatchObject({ valueInch: 0.0019, unit: "mm" });
      expect(tolerance([METRIC, 'BORE ±.001"'])).toMatchObject({ valueInch: 0.001, unit: "in" });
      expect(tolerance([METRIC, "BORE ±.002 INCH"])).toMatchObject({ valueInch: 0.002, unit: "in" });
    });

    it("never reads a unit from the next line (F2)", () => {
      expect(tolerance([METRIC, "TOLERANCE ±0.05", "INCH EQUIVALENTS FOR REFERENCE ONLY"]).valueInch).toBe(0.0019);
      expect(tolerance([METRIC, "FLATNESS ±0.05", "IN. ZONE A"]).valueInch).toBe(0.0019);
      expect(tolerance([INCH, "TOLERANCES ±.005", "MIL-A-8625 TYPE II CL 2"]).valueInch).toBe(0.005);
      expect(tolerance(["TOLERANCES ±.005", "MM-1234 FIXTURE"]).valueInch).toBe(0.005);
      expect(tolerance(["TOLERANCES ±.005", "mils"]).valueInch).toBe(0.005);
    });

    it("does not read part numbers or specifications as units", () => {
      expect(tolerance(["MARK PER ±.005 MIL-STD-130"])).toMatchObject({ valueInch: 0.005, unit: "in" });
      expect(tolerance(["TOLERANCES ±.005 MM-1234 FIXTURE"])).toMatchObject({ valueInch: 0.005, unit: "in" });
    });

    it("reads the word IN as inches only when it ends the callout, and not on a metric drawing", () => {
      expect(tolerance([METRIC, "PROFILE ±0.1 IN ALL DIRECTIONS"])).toMatchObject({ valueInch: 0.0039, unit: "mm" });
      expect(tolerance([METRIC, "FLATNESS ±0.05 IN", "ZONE A"])).toMatchObject({ valueInch: null, unit: "unknown" });
      expect(tolerance([METRIC, "BORE ±.005 IN"])).toMatchObject({ valueInch: null, unit: "unknown" });
      expect(tolerance(["TOLERANCES ±0.005 IN"])).toMatchObject({ raw: "±0.005", valueInch: 0.005, unit: "in" });
      expect(tolerance([INCH, "BORE ±.05 IN."]).valueInch).toBe(0.05);
    });

    it.each([
      [["DIMENSIONS ARE IN INCHES", "SPRING RATE ±10%"], "±10%"],
      [["STRAIGHTNESS ±0.1 mm/m"], "±0.1 mm/m"],
      [["DIMENSIONS ARE IN INCHES", "FINISH ±32 µin"], "±32 µin"],
      [["DIMENSIONS ARE IN INCHES", "FINISH ±32 microinch"], "±32 microinch"],
      [["DIMENSIONS ARE IN INCHES", "BORE ±1e-3 IN"], "±1"],
      [["BORE ±5E-3"], "±5"],
    ])("leaves %j unresolved", (lines, raw) => {
      expect(tolerance(lines)).toMatchObject({ raw, valueInch: null, unit: "unknown" });
    });
  });

  // P4: a bare value on an undeclared drawing is inches only with three or more decimals.
  describe("P4 bare values on an undeclared drawing", () => {
    it.each([
      ["TOLERANCES ±.005", 0.005],
      ["TOLERANCES ±0.005", 0.005],
      ["BORE ±.0005", 0.0005],
      ["BORE ±.001", 0.001],
      ["THREE PLACE DECIMAL +.005", 0.005],
      ["TITLE: SHAFT ±.002", 0.002],
    ])("%s is read as inches", (line, valueInch) => {
      expect(tolerance([line])).toMatchObject({ valueInch, unit: "in", drawingUnits: "unspecified" });
    });

    it.each([
      ["TOLERANCES ±0.05"],
      ["TOLERANCES ±.05"],
      ["TOLERANCES ±0.1"],
      ["TOLERANCES ±1"],
      ["TWO PLACE DECIMAL +.01"],
      ["TWO PLACE DECIMAL", ".01"],
      ["TOLERANCES ±0.125"],
      ["FRACTIONS ±1/64"],
    ])("%s is unresolved", (...lines) => {
      expect(tolerance(lines)).toMatchObject({ valueInch: null, unit: "unknown", drawingUnits: "unspecified" });
    });

    it("follows the declaration for bare values and decimal-place phrases", () => {
      expect(tolerance([INCH, "TOLERANCES ±0.25"]).valueInch).toBe(0.25);
      expect(tolerance([INCH, "TWO PLACE DECIMAL ±.01"]).valueInch).toBe(0.01);
      expect(tolerance([INCH, "FRACTIONS ±1/64"])).toMatchObject({ raw: "±1/64", valueInch: 0.0156, unit: "in" });
      expect(tolerance([METRIC, "TWO PLACE DECIMAL ±.05"]).valueInch).toBe(0.0019);
      expect(tolerance([METRIC, "THREE PLACE DECIMAL ±.005"]).valueInch).toBe(0.0001);
      expect(tolerance(["DIMENSIONS IN INCHES [MILLIMETERS]", "THREE PLACE DECIMAL +.005"]).valueInch).toBeNull();
    });
  });

  // P5: kept from round 1.
  describe("P5 angular values, dual dimensions and bad numbers", () => {
    it.each([
      [[INCH, "ANGULAR ±.005°", "LINEAR ±.010"]],
      [[INCH, "ANGULAR ±0.5 DEG", "LINEAR ±.010"]],
      [[INCH, "ANGULAR ±.005", "LINEAR ±.010"]],
      [[INCH, "ALL BENDS ±.005°", "LINEAR ±.010"]],
      [[INCH, "ANGULAR TOLERANCE ±0.5 DEGREES", "LINEAR ±.010"]],
      [[INCH, "ANGULAR DIMENSIONS ±.25", "LINEAR ±.010"]],
      [[INCH, "ANGLES UNLESS NOTED ±.5", "LINEAR ±.010"]],
      [[INCH, "ANGULAR ±0.5  LINEAR ±.010"]],
      [[INCH, "BEND ±30'", "LINEAR ±.010"]],
      [[INCH, "BEND ±1/2°", "LINEAR ±.010"]],
      [[INCH, "ANGLE ±0°30'", "LINEAR ±.010"]],
      [[INCH, "90º ±.5", "LINEAR ±.010"]],
    ])("ignores the angular value in %j", (lines) => {
      expect(tolerance(lines)).toMatchObject({ raw: "±0.01", valueInch: 0.01 });
    });

    it("does not skip a linear value whose label only mentions an angle earlier on its line", () => {
      expect(tolerance([INCH, "CSK 90° X Ø.500 ±.002", "GENERAL ±.010"]).valueInch).toBe(0.002);
      expect(tolerance([INCH, "ANGULAR AND LINEAR ±.005", "GENERAL ±.010"]).valueInch).toBe(0.005);
      expect(tolerance([INCH, "ANGLE BRACKET LENGTH ±.005", "GENERAL ±.010"]).valueInch).toBe(0.005);
    });

    it("ignores an angular value on a metric drawing and converts the linear one", () => {
      expect(tolerance([METRIC, "ANGULAR ±0.5°", "LINEAR ±0.2"]).valueInch).toBe(0.0078);
    });

    it("reports no tolerance when only angular values are present", () => {
      expect(tolerance(["ANGULAR ±0.5°"])).toMatchObject({ raw: null, valueInch: null });
      expect(tolerance(["ANGULAR TOLERANCE ±0.5 DEGREES"])).toMatchObject({ raw: null, valueInch: null });
    });

    it("adopts a bracketed bare value as inches only when it matches the mm value", () => {
      expect(tolerance(["TOLERANCES ±0.1 mm [±.004]"]).valueInch).toBe(0.0039);
      expect(tolerance(["TOLERANCES ±.004 [±0.1 mm]"]).valueInch).toBe(0.0039);
      expect(tolerance(["BORE ±0.13 mm [±.005]"]).valueInch).toBe(0.005);
      // Without the pairing these bare values would be millimeters (metric drawing) or unresolved.
      expect(tolerance([METRIC, "BORE ±0.1 mm [±.004]"])).toMatchObject({ valueInch: 0.0039, unit: "mm" });
      expect(tolerance(["BORE ±2.5 mm [±.1]"])).toMatchObject({ valueInch: 0.0984, unit: "mm" });
      expect(tolerance(["BORE ±.1 [±2.5 mm]"])).toMatchObject({ valueInch: 0.0984, unit: "mm" });
      // Inconsistent pairs keep both readings; the tighter converted value wins or it stays unresolved.
      expect(tolerance(["TOLERANCES ±0.1 mm [±.04 in]"]).valueInch).toBe(0.0039);
      expect(tolerance(["BORE ±0.05mm [±0.5]"]).valueInch).toBe(0.0019);
      expect(tolerance(["TOLERANCES ±0.02 mm [±.01]"]).valueInch).toBeNull();
      expect(tolerance([METRIC, "BORE ±0.02 mm (±0.1 BEFORE PLATING)"]).valueInch).toBe(0.0007);
    });

    it("leaves a decimal comma, zero or a non-finite value unresolved, never 0", () => {
      for (const lines of [
        [METRIC, "TOLERANCES ±0,05"],
        ["TOLERANCES ±0,1"],
        ["TOLERANCES ±0,05 mm"],
        ["BORE ±1,000 µm"],
        [INCH, "TWO PLACE DECIMAL +0,1"],
        [INCH, "TOLERANCES ±0"],
        ["TOLERANCES ±0.000"],
        ["TWO PLACE DECIMAL +0"],
        [INCH, `NOTE ±${"9".repeat(320)}`],
      ]) {
        const result = tolerance(lines);
        expect(result.valueInch).toBeNull();
        expect(result.unit).toBe("unknown");
        expect(result.raw).not.toBeNull();
      }
      expect(tolerance([INCH, "TWO PLACE DECIMAL +0,1"]).raw).toBe("±0,1");
    });

    it("leaves a value too large for numeric(10,4) unresolved", () => {
      expect(tolerance([INCH, "NOTE ±1000000"])).toMatchObject({ valueInch: null, unit: "unknown" });
      expect(tolerance(["ENVELOPE ±1000 mm"]).valueInch).toBe(39.37);
    });
  });

  // P6: an unresolved value blocks the result unless it is looser in both readings.
  describe("P6 unresolved values that could be tighter", () => {
    it("blocks when an unresolved value could be tighter in either unit", () => {
      // .1 and .01 read as millimeters (0.0039 in, 0.0003 in) would be tighter than .005 in.
      expect(tolerance([".X ±.1", ".XX ±.01", ".XXX ±.005"])).toMatchObject({ valueInch: null, unit: "unknown" });
      expect(tolerance(["TWO PLACE DECIMAL +.01", "THREE PLACE DECIMAL +.005"]).valueInch).toBeNull();
      expect(tolerance(["DIMENSIONS ARE IN INCHES", "FINISH ±32 µin", "BORE ±.002"]).valueInch).toBeNull();
      expect(tolerance(["FRACTIONS ±1/32  .XXX ±.005"]).valueInch).toBeNull();
      expect(tolerance([INCH, "DATUM ±0", "TOLERANCES ±.005"]).valueInch).toBeNull();
      // 1e-3 in is tighter than ±.010; scientific notation is never read, so nothing is stored.
      expect(tolerance([INCH, "BORE ±1e-3 IN", "GENERAL ±.010"]).valueInch).toBeNull();
      expect(tolerance([INCH, "NOTE ±0/0", "BORE ±.005"]).valueInch).toBeNull();
      expect(tolerance([INCH, `NOTE ±${"9".repeat(320)} mm/m`, "BORE ±.005"]).valueInch).toBeNull();
    });

    it("resolves the same block when the drawing declares inches", () => {
      expect(tolerance([INCH, ".X ±.1", ".XX ±.01", ".XXX ±.005"])).toMatchObject({ valueInch: 0.005, unit: "in" });
    });

    it("ignores an unresolved value that is looser in both readings", () => {
      // ±.3 is 0.3 in or 0.0118 in, both looser than ±0.1 mm.
      expect(tolerance(["DIMENSIONS IN INCHES [MILLIMETERS]", "TOLERANCES ±0.1 mm", "GENERAL ±.3"]).valueInch).toBe(
        0.0039,
      );
      expect(tolerance(["DIMENSIONS IN INCHES [MILLIMETERS]", "BORE ±0.05 mm [±0.5]"]).valueInch).toBe(0.0019);
      expect(tolerance([INCH, "SPRING RATE ±10%", "TOLERANCES ±.005"]).valueInch).toBe(0.005);
      expect(tolerance(["TOLERANCES ±0.1 mm", "NOTE ±1"]).valueInch).toBe(0.0039);
    });
  });

  // P7: values are floored to the 4 decimals of numeric(10,4) and never rounded up.
  describe("P7 stored precision", () => {
    it.each([
      [[INCH, "BORE ±.005"], 0.005],
      [[INCH, "BORE ±.00499"], 0.0049],
      [[INCH, "BORE ±.0050001"], 0.005],
      [[INCH, "BORE ±.00499999995"], 0.0049],
      [[INCH, "BORE ±.0049999999999999"], 0.0049],
      [[INCH, "BORE ±.0039"], 0.0039],
      [[INCH, "BORE ±0.0001"], 0.0001],
      [[INCH, "BORE ±0.00015"], 0.0001],
      [["BORE ±0.126 mm"], 0.0049],
      [["BORE ±0.127 mm"], 0.005],
      [["BORE ±0.1270001 mm"], 0.005],
      [["BORE ±0.12699 mm"], 0.0049],
      [["BORE ±0.12699999999 mm"], 0.0049],
      [["BORE ±127 µm"], 0.005],
      [["BORE ±126.9 µm"], 0.0049],
      [["BORE ±5 mil"], 0.005],
      [["BORE ±4.99 mil"], 0.0049],
    ])("%j stores %s", (lines, valueInch) => {
      expect(tolerance(lines).valueInch).toBe(valueInch);
    });

    it.each([[[INCH, "BORE ±.0000394"]], [[INCH, "BORE ±0.00001"]], [["BORE ±1 µm"]], [[METRIC, "BORE ±5μ", "±0.8 µm"]]])(
      "%j is below 0.0001 in and is unresolved instead of rounded up",
      (lines) => {
        expect(tolerance(lines)).toMatchObject({ valueInch: null, unit: "unknown" });
      },
    );
  });
});
