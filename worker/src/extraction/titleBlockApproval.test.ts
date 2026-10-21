// @vitest-environment node
import { describe, expect, it } from "vitest";
import { box, phrase } from "../../test-support/pdfWordBoxes";
import type { JobFileRecord, PartRecord, WorkerConfig } from "../types";
import { runHybridExtraction } from "./hybridExtraction";
import { validateModelFieldValue, type DrawingModelExtractionResult } from "./modelFallback";
import { inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";
import { finalizeExtractionApproval } from "./extractionApproval";
import type { PdfWord } from "./pdfWords";

const fields = ["material", "finish", "partNumber", "revision"] as const;
const labels = { material: "MATERIAL", finish: "FINISH", partNumber: "PART NUMBER", revision: "REV" };
function pdf(words: PdfWord[], text = "", ocrText = ""): PdfTextExtraction {
  return { pageCount: 1, pageCountKnown: true, drawingFullyRead: true, ocr: false,
    pages: [{ page: 1, text, ocrText, ocrStatus: "ok", words, vectorGeometry: { complete: true, issues: [] }, wordGeometryComplete: true }] };
}
const infer = (pdfText: PdfTextExtraction) => inferDrawingSignalsFromPdf({ titleBlockApprovalEnabled: true, baseName: "upload", pdfText });
function model(values: Partial<Record<keyof DrawingModelExtractionResult["fields"], string>>): DrawingModelExtractionResult {
  const result = Object.fromEntries(["description", "partNumber", "revision", "material", "finish", "process"].map((name) =>
    [name, { value: values[name as keyof typeof values] ?? null, confidence: 0.99, fieldSource: "title_block", reasons: [] }])) as DrawingModelExtractionResult["fields"];
  return { fields: result, attempts: [{ attempt: "title_block", titleBlockSufficient: true, fields: result }],
    modelName: "test-model", promptVersion: "test", usedTitleBlockCrop: true, usedFullPage: false, usage: null };
}
async function hybrid(pdfText: PdfTextExtraction, answer: DrawingModelExtractionResult) {
  return runHybridExtraction({ part: { id: "part-1", name: "sample" } as PartRecord, cadFile: null,
    drawingFile: { original_name: "upload.pdf" } as JobFileRecord, pdfText, drawingPath: "/tmp/sample.pdf", runDir: "/tmp",
    forceModelFallback: true, config: { titleBlockApprovalEnabled: true } as WorkerConfig }, { extractWithModel: async () => answer });
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
    for (const value of ["TBD", "T.B.D.", "TBD.", "TBA", "N.A.", "N/A.", "NONE.", "TO BE DETERMINED", "NOT APPLICABLE", " ( t.b.d. ) ", "[N / A]", "N/A", "NA", "NONE", "SEE NOTE", "SEE NOTES", "SEE NOTE(S)", "SEE DWG", "PER NOTE", "-", "--", "Q.A.", "MATERIAL"]) {
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

// Every fixture below contains only the supplied words unless it explicitly supplies vector issues.
describe("round 17 confirmed approval regressions", () => {
  it.each([
    ["material", "AL 6061-T6", "304 STAINLESS STEEL"],
    ["finish", "AS MACHINED", "ANODIZE"],
    ["partNumber", "ABC-001", "ABC-002"],
    ["revision", "B", "A"],
  ] as const)("I1 rejects a different 0.99 model value for proven %s", async (field, value, other) => {
    const input = pdf([...phrase(labels[field], 100, 100), ...phrase(value, 100, 120)], `${labels[field]}\n${value}`);
    expect(infer(input)[field]).toMatchObject({ value, reviewNeeded: false });
    const result = await hybrid(input, model({ [field]: other }));
    expect(result.reviewFields).toContain(field);
    const selected = field === "material" || field === "finish" ? result[field].raw : result[field];
    expect(selected).toBe(other);
    const reason = field === "material" || field === "finish" ? result[field].reasons : (field === "partNumber" ? result.extractedPartNumberRaw : result.extractedRevisionRaw).reasons;
    expect(reason).toContain("model_value_unproven");
  });

  it("I1 preserves a deterministic review veto even when the model agrees", () => {
    const deterministic = infer(pdf([box("MATERIAL", 100, 100), box("6061-T", 100, 120), box("6", 100, 150)])).material;
    expect(deterministic.reviewNeeded).toBe(true);
    const fields = { material: { ...deterministic, confidence: 0.99, reviewNeeded: false, reasons: [] } };
    finalizeExtractionApproval({ titleBlockApprovalEnabled: true, fields, deterministicFields: { material: deterministic } });
    expect(fields.material.reviewNeeded).toBe(true);
  });

  it("a value above its label cannot make MATERIAL approve the FINISH value", () => {
    const input = pdf([...phrase("AL 6061-T6", 100, 100), box("MATERIAL", 100, 112, 6),
      ...phrase("ANODIZE BLACK", 100, 130), box("FINISH", 100, 142, 6)]);
    expect(infer(input).material.reviewNeeded).toBe(true);
  });

  it("REVISIONS with DESCRIPTION and APPROVED cannot approve a history revision", () => {
    const input = pdf([box("REVISIONS", 100, 70), box("REV", 100, 100), box("DESCRIPTION", 200, 100),
      box("APPROVED", 350, 100), box("A", 100, 120), box("REV", 100, 500),
      box("DESCRIPTION", 200, 500), box("DATE", 350, 500), box("B", 100, 520)]);
    expect(infer(input).revision).toMatchObject({ value: "B", reviewNeeded: true });
  });

  it("a REVISIONS heading remains history across intervening text rows", () => {
    const input = pdf([box("REVISIONS", 100, 70), box("NOTES", 400, 80), box("ONE", 400, 90),
      box("TWO", 400, 100), box("THREE", 400, 110), box("REV", 100, 200), box("A", 100, 220)]);
    expect(infer(input).revision.reviewNeeded).toBe(true);
  });

  it.each([false, true])("current revision wins across pages, reversed=%s", (reverse) => {
    const history = pdf([box("REV", 100, 100), box("ECO", 200, 100), box("DATE", 350, 100), box("A", 100, 112)], "REV   ECO   DATE\nA").pages[0]!;
    const current = pdf(phrase("REV: B", 100, 100), "REV: B").pages[0]!;
    const pages = (reverse ? [current, history] : [history, current]).map((page, i) => ({ ...page, page: i+1 }));
    expect(infer({ ...pdf([]), pageCount: 2, pages }).revision).toMatchObject({ value: "B", reviewNeeded: false });
  });

  it("split collinear rules cannot lose a divider at the label junction", () => {
    const input = pdf([box("MATERIAL", 100, 100), ...phrase("LOT CODE A123", 100, 140)]);
    input.pages[0]!.borders = [{ x0: 90, x1: 125, y: 120 }, { x0: 125, x1: 350, y: 120 }];
    expect(infer(input).material.reviewNeeded).toBe(true);
  });

  it("filters columns before rules on 5000 words and 2000 rules in under 2 seconds", () => {
    const words = Array.from({ length: 100 }, (_, i) => [box("REV", 6600+i*25, 100), box("A", 6600+i*25, 115)]).flat();
    for (let i = 0; i < 4800; i++) words.push(box(".", 10+(i%800)*6, 140+Math.floor(i/800)*12));
    const input = pdf(words);
    input.pages[0]!.borders = Array.from({ length: 2000 }, (_, i) => ({ x0: 5, x1: 14400, y: 400+i*0.15 }));
    const start = performance.now();
    const result = infer(input);
    expect(performance.now()-start).toBeLessThan(2000);
    expect(result.revision.value).toBe("A");
  });
});
