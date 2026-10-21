// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { minimalPdf, type MinimalPdfOptions, type PdfTextItem } from "../../test-support/minimalPdf";
import { phrase, withMonospaceGeometry } from "../../test-support/pdfWordBoxes";
import { pdfTextOf } from "../../test-support/titleBlockSheet";
import { loadConfig } from "../config";
import type { JobFileRecord, PartRecord } from "../types";
import { finalizeExtractionApproval } from "./extractionApproval";
import { runHybridExtraction } from "./hybridExtraction";
import { extractPdfText, inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";
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
