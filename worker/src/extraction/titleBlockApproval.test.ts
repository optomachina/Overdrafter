// @vitest-environment node
import { describe, expect, it } from "vitest";
import { box, phrase } from "../../test-support/pdfWordBoxes";
import type { JobFileRecord, PartRecord, WorkerConfig } from "../types";
import { runHybridExtraction } from "./hybridExtraction";
import { validateModelFieldValue, type DrawingModelExtractionResult } from "./modelFallback";
import { inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";
import type { PdfWord } from "./pdfWords";

const fields = ["material", "finish", "partNumber", "revision"] as const;
const labels = { material: "MATERIAL", finish: "FINISH", partNumber: "PART NUMBER", revision: "REV" };
function pdf(words: PdfWord[], text = "", ocrText = ""): PdfTextExtraction {
  return { pageCount: 1, pageCountKnown: true, drawingFullyRead: true, ocr: false,
    pages: [{ page: 1, text, ocrText, ocrStatus: "ok", words, wordGeometryComplete: true }] };
}
const infer = (pdfText: PdfTextExtraction) => inferDrawingSignalsFromPdf({ baseName: "upload", pdfText });
function model(values: Partial<Record<keyof DrawingModelExtractionResult["fields"], string>>): DrawingModelExtractionResult {
  const result = Object.fromEntries(["description", "partNumber", "revision", "material", "finish", "process"].map((name) =>
    [name, { value: values[name as keyof typeof values] ?? null, confidence: 0.99, fieldSource: "title_block", reasons: [] }])) as DrawingModelExtractionResult["fields"];
  return { fields: result, attempts: [{ attempt: "title_block", titleBlockSufficient: true, fields: result }],
    modelName: "test-model", promptVersion: "test", usedTitleBlockCrop: true, usedFullPage: false, usage: null };
}
async function hybrid(pdfText: PdfTextExtraction, answer: DrawingModelExtractionResult) {
  return runHybridExtraction({ part: { id: "part-1", name: "sample" } as PartRecord, cadFile: null,
    drawingFile: { original_name: "upload.pdf" } as JobFileRecord, pdfText, drawingPath: "/tmp/sample.pdf", runDir: "/tmp",
    forceModelFallback: true, config: {} as WorkerConfig }, { extractWithModel: async () => answer });
}

describe("final extraction approval invariants", () => {
  it("model agreement at 0.99 cannot approve an incomplete 6061-T cell", async () => {
    const input = pdf([box("MATERIAL", 100, 100), box("6061-T", 100, 120), box("6", 100, 150)], "MATERIAL\n6061-T\n6");
    expect(infer(input).material).toMatchObject({ value: "6061-T", reviewNeeded: true });
    const result = await hybrid(input, model({ material: "6061-T" }));
    expect(result.material).toMatchObject({ raw: "6061-T", confidence: 0.99, reviewNeeded: true });
    expect(result.material.reasons).toContain("title_block_cell_unread");
  });

  it.each([
    ["material", "AL 6061-T6", "304 STAINLESS STEEL"],
    ["finish", "AS MACHINED", "ANODIZE"],
    ["partNumber", "ABC-001", "ABC-002"],
    ["revision", "B", "A"],
  ] as const)("independent OCR disagreement vetoes a proven %s cell", (field, value, other) => {
    const words = [...phrase(labels[field], 100, 100), ...phrase(value, 100, 120)];
    const text = `${labels[field]}\n${value}`;
    expect(infer(pdf(words, text))[field]).toMatchObject({ value, reviewNeeded: false });
    expect(infer(pdf(words, text, `${labels[field]}\n${value}`))[field]).toMatchObject({ value, reviewNeeded: false });
    const result = infer(pdf(words, text, `${labels[field]}\n${other}`))[field];
    expect(result).toMatchObject({ value, reviewNeeded: true });
    expect(result.reasons).toContain("independent_source_conflict");
  });

  it("ambiguous OCR retains competing identifiers as veto evidence", () => {
    const words = [...phrase("PART NUMBER", 100, 100), box("ABC-001", 100, 120)];
    const input = pdf(words, "PART NUMBER\nABC-001", "PART NUMBER\nABC-001\nABC-002");
    expect(infer(input).partNumber).toMatchObject({ value: "ABC-001", reviewNeeded: true });
    expect(infer(input).partNumber.reasons).toContain("independent_source_conflict");
  });

  it("wrapped OCR observations retain vertical reading order", () => {
    const input = pdf([box("MATERIAL", 100, 100), ...phrase("ALUMINUM 6061-T6", 100, 120)],
      "MATERIAL\nALUMINUM 6061-T6", "MATERIAL\n  ALUMINUM\n6061-T6");
    expect(infer(input).material).toMatchObject({ value: "ALUMINUM 6061-T6", reviewNeeded: false });
  });

  it("unread OCR parsing caps cannot erase independent evidence", () => {
    const input = pdf([box("MATERIAL", 100, 100), ...phrase("AL 6061-T6", 100, 120)],
      "MATERIAL\nAL 6061-T6\nTOLERANCE ±.005", "MATERIAL\n304 STAINLESS STEEL\n" + "NOTE\n".repeat(401));
    const result = infer(input);
    expect(result.material.reviewNeeded).toBe(true);
    expect(result.material.reasons).toContain("independent_source_unread");
    expect(result.tightestToleranceValueInch).toBeNull();
  });

  it("colon-suffixed revision headers preserve history and ambiguous roles", () => {
    const history = [box("REV:", 100, 100), box("ECO:", 200, 100), box("DATE:", 350, 100), box("A", 100, 120)];
    expect(infer(pdf(history)).revision.reviewNeeded).toBe(true);
    const current = [box("REV:", 100, 300), box("DESCRIPTION:", 200, 300), box("DATE:", 350, 300), box("B", 100, 320)];
    expect(infer(pdf([...history, ...current])).revision).toMatchObject({ value: "B", reviewNeeded: true });
  });

  it("an OCR-only tighter tolerance vetoes the vector tolerance", () => {
    const text = "DIMENSIONS ARE IN INCHES\nTOLERANCE ±.005";
    const words = [...phrase("DIMENSIONS ARE IN INCHES", 100, 100), ...phrase("TOLERANCE ±.005", 100, 120)];
    expect(infer(pdf(words, text)).tightestToleranceValueInch).toBe(0.005);
    expect(infer(pdf(words, text, "1.250 ±.001")).tightestToleranceValueInch).toBeNull();
    expect(infer(pdf(words, text, "1.250 ±.005")).tightestToleranceValueInch).toBe(0.005);
  });

  it("a rule between MATERIAL and LOT CODE prevents label binding", () => {
    const input = pdf([box("MATERIAL", 100, 100, 9), ...phrase("LOT CODE A123", 100, 140, 9)]);
    input.pages[0]!.borders = [{ x0: 90, x1: 350, y: 120 }];
    expect(infer(input).material.reviewNeeded).toBe(true);
  });

  it("revision history cannot outrank a current or ambiguous title-block row", () => {
    const history = [...phrase("REV", 100, 100), ...phrase("ECO", 200, 100), ...phrase("DATE", 350, 100), box("A", 100, 120)];
    const current = [...phrase("REV", 100, 300), ...phrase("DESCRIPTION", 200, 300), ...phrase("DATE", 350, 300), box("B", 100, 320)];
    for (const words of [current, [...history, ...current]]) {
      // DESCRIPTION/DATE alone does not prove which role this row has, but B remains the suggestion.
      expect(infer(pdf(words)).revision).toMatchObject({ value: "B", reviewNeeded: true });
    }
    const clearCurrent = [...phrase("DWG. NO.", 100, 500), box("ABC-001", 100, 520), box("REV", 350, 500), box("C", 350, 520)];
    expect(infer(pdf([...history, ...current, ...clearCurrent])).revision).toMatchObject({ value: "C", reviewNeeded: false });
    expect(infer(pdf(history)).revision.reviewNeeded).toBe(true);
  });

  it.each(fields)("placeholders never approve a single %s cell", (field) => {
    for (const value of ["TBD", "TBA", "N/A", "NA", "NONE", "SEE NOTE", "SEE NOTES", "SEE NOTE(S)", "SEE DWG", "PER NOTE", "-", "--", "Q.A.", "MATERIAL"]) {
      const result = infer(pdf([...phrase(labels[field], 100, 100), ...phrase(value, 100, 120)]))[field];
      expect(result.reviewNeeded, value).toBe(true);
      expect(validateModelFieldValue(field, value), value).toContain("rejected_label_token");
    }
  });

  it("model Q.A. values are rejected for material and finish through hybrid extraction", async () => {
    for (const field of ["material", "finish"] as const) expect(validateModelFieldValue(field, "Q.A.")).toContain("rejected_label_token");
    const result = await hybrid(pdf([box("TITLE", 100, 100), ...phrase("SAMPLE PLATE", 100, 120)]), model({ material: "Q.A.", finish: "Q.A." }));
    for (const field of ["material", "finish"] as const) {
      expect(result[field].raw).not.toBe("Q.A.");
      expect(result[field].reviewNeeded).toBe(true);
      expect(result.modelCandidates?.[field]?.reasons).toContain("rejected_label_token");
    }
  });

  it.each(["ok", "unavailable"] as const)("four cell approvals require OCR availability: %s", (ocrStatus) => {
    const words = fields.flatMap((field, index) => [...phrase(labels[field], 100 + index * 220, 100),
      ...phrase(["AL 6061-T6", "AS MACHINED", "ABC-001", "B"][index]!, 100 + index * 220, 120)]);
    const input = pdf(words);
    input.pages[0]!.ocrStatus = ocrStatus;
    input.drawingFullyRead = ocrStatus === "ok";
    for (const field of fields) expect(infer(input)[field].reviewNeeded, field).toBe(ocrStatus !== "ok");
  });

  it("numeric tolerance requires complete word geometry even with successful OCR", () => {
    const text = "DIMENSIONS ARE IN INCHES\nTOLERANCE ±.005";
    const input = pdf([...phrase(text.replace("\n", " "), 100, 100)], text);
    expect(infer(input).tightestToleranceValueInch).toBe(0.005);
    input.pages[0]!.wordGeometryComplete = false;
    expect(infer(input).tightestToleranceValueInch).toBeNull();
  });
});
