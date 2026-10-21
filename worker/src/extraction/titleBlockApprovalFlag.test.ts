// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { minimalPdf, type MinimalPdfOptions, type PdfTextItem } from "../../test-support/minimalPdf";
import { bboxMarkup, phrase, withMonospaceGeometry } from "../../test-support/pdfWordBoxes";
import { pdfTextOf } from "../../test-support/titleBlockSheet";
import { loadConfig } from "../config";
import type { JobFileRecord, PartRecord } from "../types";
import { finalizeExtractionApproval } from "./extractionApproval";
import { runHybridExtraction } from "./hybridExtraction";
import type { DrawingModelExtractionResult } from "./modelFallback";
import { extractPdfText, inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";
import { MAX_WORDS_PER_PAGE, parseBboxWords } from "./pdfWords";
import { buildStoredExtractionPayload } from "./sharedResult";

const reason = "title_block_approval_disabled";
const baseConfig = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-key" };
const config = (enabled?: boolean) => loadConfig({ ...baseConfig,
  DRAWING_EXTRACTION_TITLE_BLOCK_APPROVAL: enabled === undefined ? undefined : enabled ? "1" : "0" });
const infer = (pdfText: PdfTextExtraction, enabled?: boolean) => inferDrawingSignalsFromPdf({
  baseName: "upload", pdfText, titleBlockApprovalEnabled: enabled,
});
const hybrid = (pdfText: PdfTextExtraction, enabled?: boolean) => runHybridExtraction({
  part: { id: "part-1", name: "sample" } as PartRecord, cadFile: null,
  drawingFile: { original_name: "upload.pdf" } as JobFileRecord, pdfText, config: config(enabled),
});

it.each([undefined, "", "0", "true", "yes", "01", " 1", "1 ", "1"])("only the exact environment value 1 enables approval (%s)", (value) => {
  expect(loadConfig({ ...baseConfig, DRAWING_EXTRACTION_TITLE_BLOCK_APPROVAL: value }).titleBlockApprovalEnabled).toBe(value === "1");
});

const cells = [
  ["partNumber", "PART NUMBER", "ABC-123"], ["revision", "REV", "B"],
  ["material", "MATERIAL", "AL 6061-T6"], ["finish", "FINISH", "AS MACHINED"],
] as const;
for (const [field, label, value] of cells) {
  it.each([undefined, false, true])(`${field} retains its suggestion with approval enabled=%s`, async (enabled) => {
    const text = `${label}\n${value}`;
    const pdfText: PdfTextExtraction = { pageCount: 1, pageCountKnown: true, drawingFullyRead: true,
      pages: [{ page: 1, text, ocrText: text, ocrStatus: "ok", wordGeometryComplete: true,
        vectorGeometry: { complete: true, issues: [] }, words: [...phrase(label, 100, 100), ...phrase(value, 100, 120)] }] };
    const signal = infer(pdfText, enabled)[field];
    expect(signal).toMatchObject({ value, reviewNeeded: enabled !== true });
    expect(signal.reasons).toContain("title_block_cell_proven");
    expect(signal.reasons.includes(reason)).toBe(enabled !== true);
    const result = await hybrid(pdfText, enabled);
    const merged = field === "partNumber" ? result.extractedPartNumberRaw : field === "revision" ? result.extractedRevisionRaw : result[field];
    expect(merged).toMatchObject({ reviewNeeded: enabled !== true });
    expect(merged.reasons.includes(reason)).toBe(enabled !== true);
    expect(result.reviewFields.includes(field)).toBe(enabled !== true);
  });
}

it.each([undefined, false, true])("table tolerance retains its suggestion with approval enabled=%s", async (enabled) => {
  const pdfText = withMonospaceGeometry(pdfTextOf("DIMENSIONS ARE IN INCHES\nTWO PLACE DECIMAL .01\nTHREE PLACE DECIMAL .005\n.18\n.656\n.089"));
  const signal = infer(pdfText, enabled);
  expect(signal.tightestTolerance).toBe("±0.005");
  expect(signal.tightestToleranceValueInch).toBe(0.005);
  const result = await hybrid(pdfText, enabled);
  expect(result.tightestTolerance.raw).toBe("±0.005");
  if (!enabled) {
    expect(result.tightestTolerance).toMatchObject({ reviewNeeded: true, reasons: [reason], valueInch: 0.005 });
    expect(buildStoredExtractionPayload(result, 1, "test").tolerances).toMatchObject({ reviewNeeded: true, reasons: [reason], valueInch: 0.005 });
    expect(result.status).toBe("needs_review");
  } else expect(result.tightestTolerance.valueInch).toBe(0.005);
});

it("leaves explicit feature tolerances unchanged", async () => {
  const pdfText = withMonospaceGeometry(pdfTextOf("DIMENSIONS ARE IN INCHES\n1.25 ±.005"));
  expect(infer(pdfText).tightestToleranceValueInch).toBe(0.005);
  expect((await hybrid(pdfText)).tightestTolerance).toEqual((await hybrid(pdfText, true)).tightestTolerance);
});

describe("suggest-only evidence and main parity", () => {
  const inches = "DIMENSIONS ARE IN INCHES\n.18\n.656\n.089\n1.375";
  const table = "TWO PLACE DECIMAL ±.01\nFOUR PLACE DECIMAL ±.0005";
  for (const [name, text, value] of [
    ["general note wins", `${inches}\nUNLESS OTHERWISE SPECIFIED TOLERANCES ±.010\nFOUR PLACE DECIMAL ±.0005`, 0.01],
    ["feature wins", `${inches}\n${table}\n3.000 ±.005`, 0.005],
    ["table row wins", `${inches}\n${table}`, 0.01],
    ["feature tighter than the general row wins", `${inches}\n${table}\n3.000 ±.001`, 0.001],
  ] as const) {
    it.each([false, true])(`${name}: filtered evidence reaches storage and warnings (enabled=%s)`, async (enabled) => {
      const result = await hybrid(withMonospaceGeometry(pdfTextOf(text)), enabled);
      const stored = buildStoredExtractionPayload(result, 1, "test");
      expect(stored.tolerances).toMatchObject({ valueInch: value, reviewNeeded: true });
      expect(stored.tolerances.reasons).toContain("tolerance_rows_filtered");
      expect(stored.tolerances.reasons).toContain("tolerance_differs_from_tightest_read");
      expect(stored.tolerances.reasons?.includes(reason)).toBe(!enabled);
      expect(result.warnings).toContain("General-tolerance rows were excluded by applicability filtering; review the suggested tolerance.");
      expect(result.warnings).toContain("The suggested tolerance differs from the tightest tolerance read; review it before approval.");
      expect(result.warnings.includes("Title-block tolerance approval is disabled; review the suggested tolerance.")).toBe(!enabled);
    });
  }
  it.each([false, true])("marks a dropped row even when a tighter feature wins (enabled=%s)", async (enabled) => {
    const result = await hybrid(withMonospaceGeometry(pdfTextOf(`${inches}\nFOUR PLACE DECIMAL ±.005\n3.000 ±.001`)), enabled);
    expect(result.tightestTolerance).toMatchObject({ valueInch: 0.001, reviewNeeded: true });
    expect(result.tightestTolerance.reasons).toContain("tolerance_rows_filtered");
    expect(result.tightestTolerance.reasons).not.toContain("tolerance_differs_from_tightest_read");
  });
  for (const rows of ["FOUR PLACE DECIMAL ±.0005", ".XXXX ±.0005", "THREE PLACE DECIMAL ±.005\nFOUR PLACE DECIMAL ±.0005"]) {
    it.each([undefined, false, true])(`keeps the tightest suggestion when all rows are filtered: ${rows} (enabled=%s)`, async (enabled) => {
      const pdfText = withMonospaceGeometry(pdfTextOf(`DIMENSIONS ARE IN INCHES\n.1\n.6\n.8\n1.3\n${rows}`));
      const signal = infer(pdfText, enabled);
      expect(signal).toMatchObject({ tightestTolerance: "±0.0005", tightestToleranceValueInch: 0.0005,
        tightestToleranceReviewNeeded: true });
      expect(signal.tightestToleranceReasons).toContain("tolerance_rows_filtered");
      const result = await hybrid(pdfText, enabled);
      expect(buildStoredExtractionPayload(result, 1, "test").tolerances).toMatchObject({ tightest: "±0.0005",
        valueInch: 0.0005, unit: "in", reviewNeeded: true, reasons: expect.arrayContaining(["tolerance_rows_filtered"]) });
      expect(result.tightestTolerance.reasons?.includes(reason)).toBe(enabled !== true);
      expect(result.warnings).toContain("General-tolerance rows were excluded by applicability filtering; review the suggested tolerance.");
    });
  }
  it.each([false, true])("retains discarded table evidence from independent OCR (enabled=%s)", async (enabled) => {
    const pdfText = withMonospaceGeometry(pdfTextOf(`${inches}\n3.000 ±.005`));
    pdfText.pages[0]!.ocrText = table;
    const result = await hybrid(pdfText, enabled);
    expect(buildStoredExtractionPayload(result, 1, "test").tolerances).toMatchObject({ valueInch: 0.005, reviewNeeded: true });
    expect(result.tightestTolerance.reasons).toContain("tolerance_rows_filtered");
    expect(result.tightestTolerance.reasons).toContain("tolerance_differs_from_tightest_read");
    expect(result.tightestTolerance.reasons?.includes(reason)).toBe(!enabled);
  });
  it.each([
    "TOLERANCES\n.XXX\n±.005", "TOLERANCES\n.XX .XXX\n±.01 ±.005",
    "X.XXX = ±.005", "UNLESS OTHERWISE SPECIFIED TOLERANCES ±.005",
  ])("gates tolerance evidence independently of row layout: %s", async (text) => {
    const pdfText = withMonospaceGeometry(pdfTextOf(`DIMENSIONS ARE IN INCHES\n${text}`));
    expect((await hybrid(pdfText)).tightestTolerance).toMatchObject({ valueInch: 0.005, reviewNeeded: true, reasons: [reason] });
    expect((await hybrid(pdfText, true)).tightestTolerance.reviewNeeded).toBeUndefined();
  });
  it.each([false, true])("preserves geometry-free feature values without title-block review reasons (ocr=%s)", async (ocr) => {
    const pdfText = pdfTextOf("DIMENSIONS ARE IN INCHES\n1.25 ±.005", { ocr });
    for (const enabled of [undefined, false, true]) {
      const result = await hybrid(pdfText, enabled);
      const stored = buildStoredExtractionPayload(result, 1, "test");
      expect(stored.tolerances).toMatchObject({ valueInch: 0.005, unit: "in" });
      expect(stored.tolerances.reviewNeeded).toBeUndefined();
      expect(stored.tolerances.reasons).toBeUndefined();
      expect(result.warnings).not.toContain("Tolerance word geometry is unproven; review the suggested tolerance.");
      expect(result.warnings).not.toContain("Title-block tolerance approval is disabled; review the suggested tolerance.");
    }
  });
  for (const [name, filler] of [
    ["line cap", Array.from({ length: 420 }, (_, index) => `NOTE ${index}`).join("\n")],
    ["long-line cap", "X".repeat(2100)],
  ]) {
    it.each([false, true])(`cell-reader ${name} leaves feature tolerance intact (geometry=%s)`, async (geometry) => {
      const raw = pdfTextOf(`DIMENSIONS ARE IN INCHES\n1.25 ±.005\n${filler}`);
      const pdfText = geometry ? withMonospaceGeometry(raw) : raw;
      // Also exercise the independent cell-reader cap, without an OCR contradiction.
      pdfText.pages[0]!.ocrText = pdfText.pages[0]!.text;
      for (const enabled of [undefined, false, true]) {
        expect(infer(pdfText, enabled).tightestToleranceValueInch).toBe(0.005);
        const result = await hybrid(pdfText, enabled);
        const stored = buildStoredExtractionPayload(result, 1, "test").tolerances;
        expect(stored).toMatchObject({ valueInch: 0.005, unit: "in" });
        expect(stored.reviewNeeded).toBeUndefined();
        expect(stored.reasons).toBeUndefined();
      }
    });
  }
  it("preserves a feature tolerance when the word-box parser reaches its cap", async () => {
    const filler = Array.from({ length: Math.ceil(MAX_WORDS_PER_PAGE / 100) }, () => "NOTE ".repeat(100)).join("\n");
    const pdfText = withMonospaceGeometry(pdfTextOf(`DIMENSIONS ARE IN INCHES\n1.25 ±.005\n${filler}`));
    const page = pdfText.pages[0]!;
    page.words = parseBboxWords(bboxMarkup(page.words!));
    expect(page.words).toEqual([]);
    page.wordGeometryComplete = false;
    for (const enabled of [undefined, false, true]) {
      const stored = buildStoredExtractionPayload(await hybrid(pdfText, enabled), 1, "test").tolerances;
      expect(stored).toMatchObject({ valueInch: 0.005, unit: "in" });
      expect(stored.reviewNeeded).toBeUndefined();
      expect(stored.reasons).toBeUndefined();
    }
  });
  it.each([false, true])("still vetoes genuinely unread feature-tolerance pages (enabled=%s)", async (enabled) => {
    const pdfText = withMonospaceGeometry(pdfTextOf("DIMENSIONS ARE IN INCHES\n1.25 ±.005"));
    pdfText.drawingFullyRead = false;
    expect((await hybrid(pdfText, enabled)).tightestTolerance.valueInch).toBeNull();
  });
  it.each([false, true])("keeps main's field reasons when no title-block evidence exists (geometry=%s)", async (geometry) => {
    const raw = pdfTextOf("DIMENSIONS ARE IN INCHES\n1.25 ±.005");
    const pdfText = geometry ? withMonospaceGeometry(raw) : raw;
    for (const enabled of [false, true]) {
      const signal = infer(pdfText, enabled);
      for (const [field] of cells) expect(signal[field].reasons).toEqual(["regex_fit"]);
      const result = await hybrid(pdfText, enabled);
      for (const field of [result.extractedPartNumberRaw, result.extractedRevisionRaw, result.material, result.finish]) {
        expect(field.reasons).toEqual(["regex_fit"]);
      }
    }
  });
  it("does not restore a geometry-free suggestion vetoed by independent OCR", async () => {
    const pdfText = pdfTextOf("DIMENSIONS ARE IN INCHES\n1.25 ±.005");
    pdfText.pages[0]!.ocrText = "DIMENSIONS ARE IN INCHES\n1.25 ±.001";
    expect((await hybrid(pdfText)).tightestTolerance.valueInch).toBeNull();
  });
  it("only gates the field actually read from a title-block cell", () => {
    const signal = infer(withMonospaceGeometry(pdfTextOf("MATERIAL: AL 6061-T6")));
    expect(signal.material.reasons).toContain(reason);
    for (const field of ["partNumber", "revision", "finish"] as const) expect(signal[field].reasons).toEqual(["regex_fit"]);
  });
  const title = "TITLE: SAMPLE PLATE\nPROCESS: MILLING\nPART NUMBER: ABC-001\nREV: B\nMATERIAL: AL 6061-T6\nFINISH: AS MACHINED";
  it.each([false, true])("gates title-block description and process (enabled=%s)", async (enabled) => {
    const pdfText = withMonospaceGeometry(pdfTextOf(title));
    const signal = infer(pdfText, enabled);
    for (const field of ["description", "process"] as const) {
      expect(signal[field].reviewNeeded).toBe(!enabled);
      expect(signal[field].reasons.includes(reason)).toBe(!enabled);
    }
    const result = await hybrid(pdfText, enabled);
    expect(result.extractedDescriptionRaw.reviewNeeded).toBe(!enabled);
    expect(result.extractedDescriptionRaw.reasons.includes(reason)).toBe(!enabled);
    expect(result.reviewFields.includes("description")).toBe(!enabled);
  });
  it.each([undefined, false, true])("gates the existing OCR title rescue without a source region (enabled=%s)", async (enabled) => {
    // Exercise the existing rescue without copying a private drawing title into a fixture.
    const source = fs.readFileSync(new URL("./pdfDrawing.ts", import.meta.url), "utf8");
    const rescuedTitle = /input\.fields\.description = buildRescuedField\(\s*"([^"]+)"/.exec(source)?.[1];
    expect(Boolean(rescuedTitle)).toBe(true);
    const words = rescuedTitle!.split(" ");
    const lastWord = words.pop();
    const pdfText = withMonospaceGeometry(pdfTextOf(`TITLE: ${words.join(" ")} 10/20/2026\n${lastWord}`));
    const field = infer(pdfText, enabled).description;
    expect(field.value === rescuedTitle).toBe(true);
    expect(field.sourceRegion).toBeNull();
    expect(field.reasons).toContain("ocr_title_block");
    expect(field.reviewNeeded).toBe(enabled !== true);
    expect(field.reasons.includes(reason)).toBe(enabled !== true);
    const result = await hybrid(pdfText, enabled);
    expect(result.extractedDescriptionRaw.reviewNeeded).toBe(enabled !== true);
    expect(result.extractedDescriptionRaw.reasons.includes(reason)).toBe(enabled !== true);
    expect(result.reviewFields.includes("description")).toBe(enabled !== true);
  });
  it("gates a description inferred spatially within the title block", () => {
    const field = infer(withMonospaceGeometry(pdfTextOf("SAMPLE PLATE\nPART NUMBER: ABC-001\nREV: B"))).description;
    expect(field.reasons).toContain("spatial_match");
    expect(field.reviewNeeded).toBe(true);
    expect(field.reasons).toContain(reason);
  });
  it.each([false, true])("retains the cross-sheet description/process delta check (geometry=%s)", async (geometry) => {
    const raw = pdfTextOf(title);
    raw.pageCount = 2;
    raw.pages.push({ ...raw.pages[0]!, page: 2 });
    const pdfText = geometry ? withMonospaceGeometry(raw) : raw;
    for (const enabled of [false, true]) {
      const signal = infer(pdfText, enabled);
      for (const field of ["description", "process"] as const) expect(signal[field].reviewNeeded).toBe(true);
      const result = await hybrid(pdfText, enabled);
      expect(result.extractedDescriptionRaw.reviewNeeded).toBe(true);
      expect(result.reviewFields).toContain("description");
    }
  });
  it.each([false, true])("preserves HEAD's model-fallback notes-description review (enabled=%s)", async (enabled) => {
    const fields = Object.fromEntries(["description", "partNumber", "revision", "material", "finish", "process"].map((field) =>
      [field, { value: field === "description" ? "Sample Plate" : null, confidence: 0.99, fieldSource: "notes", reasons: [] }])) as DrawingModelExtractionResult["fields"];
    const result = await runHybridExtraction({
      part: { id: "part-1", name: "sample" } as PartRecord, cadFile: null,
      drawingFile: { original_name: "upload.pdf" } as JobFileRecord,
      pdfText: pdfTextOf("NOTES:\n1. MAKE SAMPLE PLATE PER CAD"), config: config(enabled),
      drawingPath: "/tmp/sample.pdf", runDir: "/tmp", forceModelFallback: true,
    }, { extractWithModel: async () => ({ fields, attempts: [{ attempt: "full_page", titleBlockSufficient: false, fields }], modelName: "test-model", promptVersion: "test",
      usedTitleBlockCrop: false, usedFullPage: true, usage: null }) });
    expect(result.fieldSelections.description).toBe("model");
    expect(result.extractedDescriptionRaw).toMatchObject({ value: "Sample Plate", reviewNeeded: true,
      reasons: ["model_fallback", "regex_fit", "model_value_unproven"] });
    expect(result.reviewFields).toContain("description");
  });
});
it("leaves non-title-block approval paths unchanged", () => {
  const field = { value: "MILLING", reviewNeeded: false, confidence: 0.9, reasons: ["label_match"], sourceRegion: null, snippet: "MILLING" };
  const fields = { process: field, description: { ...field, value: "BRACKET" }, material: { ...field, value: "ALUMINUM" } };
  const before = structuredClone(fields);
  finalizeExtractionApproval({ fields });
  expect(fields).toEqual(before);
});
it("vetoes title-block proof retained after model merging", () => {
  const fields = { material: { value: "ALUMINUM", reviewNeeded: false, confidence: 0.99, reasons: ["title_block_cell_proven"], sourceRegion: null, snippet: "ALUMINUM" } };
  finalizeExtractionApproval({ fields });
  expect(fields.material).toMatchObject({ value: "ALUMINUM", reviewNeeded: true });
  expect(fields.material.reasons).toContain(reason);
});

const hasTools = ["pdfinfo", "pdftotext", "pdftocairo", "tesseract"].every((tool) => {
  try { execFileSync("which", [tool], { stdio: "ignore" }); return true; } catch { return false; }
});
describe.skipIf(!hasTools)("round-18 P1 repros through real PDF extraction", () => {
  let directory: string;
  const inputs = new Map<string, PdfTextExtraction>();
  const cases: Array<{ name: string; field: "revision" | "material"; value: string; items: PdfTextItem[]; options?: MinimalPdfOptions }> = [
    { name: "REVISION HISTORY heading", field: "revision", value: "HISTORY", items: [
      { x: 820, y: 40, size: 9, text: "REVISION HISTORY" },
      ...[[820, "REV"], [860, "DESCRIPTION"], [1000, "DATE"], [1080, "APPROVED"]].map(([x, text]) => ({ x: Number(x), y: 60, size: 7, text: String(text) })),
      ...[[822, "A"], [860, "INITIAL RELEASE"], [1000, "2026-01-05"], [1080, "JD"]].map(([x, text]) => ({ x: Number(x), y: 74, size: 9, text: String(text) })),
      { x: 600, y: 640, size: 7, text: "MATERIAL" }, { x: 600, y: 652, size: 9, text: "AL 6061-T6" },
      { x: 600, y: 670, size: 7, text: "FINISH" }, { x: 600, y: 682, size: 9, text: "AS MACHINED" },
      { x: 860, y: 700, size: 7, text: "DWG NO." }, { x: 860, y: 714, size: 9, text: "ABC-001" },
    ] },
    { name: "sloped divider", field: "material", value: "LOT CODE A123", items: [
      { x: 100, y: 600, size: 9, text: "MATERIAL" }, { x: 100, y: 640, size: 9, text: "LOT CODE A123" },
    ], options: { paint: "0 G .5 w 90 167 m 350 166 l S" } },
    { name: "opaque stroke over the value", field: "material", value: "AL 6061-T6", items: [
      { x: 100, y: 600, size: 9, text: "MATERIAL" }, { x: 100, y: 620, size: 9, text: "AL 6061-T6" },
    ], options: { paintAfter: "q 0 G 14 w 95 165 m 200 165 l S Q" } },
  ];
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "title-block-flag-"));
    for (const [index, test] of cases.entries()) {
      const file = path.join(directory, `case-${index}.pdf`);
      fs.writeFileSync(file, minimalPdf(test.items, test.options));
      const pdfText = await extractPdfText(file);
      expect(pdfText?.drawingFullyRead).toBe(true);
      inputs.set(test.name, pdfText!);
    }
  }, 60_000);
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const test of cases) {
    it(`${test.name} requires review by default`, async () => {
      const pdfText = inputs.get(test.name)!;
      expect(infer(pdfText)[test.field]).toMatchObject({ value: test.value, reviewNeeded: true });
      expect(infer(pdfText)[test.field].reasons).toContain(reason);
      const result = await hybrid(pdfText);
      expect(result.reviewFields).toContain(test.field);
    });
    // Known holes: PR #884 round-18 P1 findings 1, 15, 16, tracked in OVD-1034; repair before enabling approval.
    it.fails(`${test.name} remains unsafe when approval is enabled`, () => {
      expect(infer(inputs.get(test.name)!, true)[test.field].reviewNeeded).toBe(true);
    });
  }
});
