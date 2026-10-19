// @vitest-environment node
//
// Real-drawing evidence for the extraction step of the friend journey (OVD-968):
// the deterministic PDF-text path run on the scrubbed quoted-sample drawing.
//
// Tier: real poppler (pdfinfo, pdftotext) and real file bytes; NO model, NO
// database, NO storage, NO network. The model extractor is injected as a stub
// that fails the test if it is ever called, and `config` is left undefined so the
// fallback cannot run. This is not staging or live evidence.
//
// The expected values below are NOT derived from the code under test. They were
// read from the drawing by two other means: macOS PDFKit text extraction of the
// page, and a visual read of a PDFKit render of the same bytes. The title block
// states:
//   DWG. NO. 1093-05589   REV 02   (revision block row: 02 CHANGED HOLE SIZE)
//   TITLE: ROUND, CARBON FIBER END ATTACHMENTS BONDED
//   MATERIAL: 6061 Alloy
//   FINISH: ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2
//   UNLESS OTHERWISE SPECIFIED: DIMENSIONS ARE IN INCHES;
//     ANGULAR: MACH +/-.5 deg, BEND +/-2 deg; TWO PLACE DECIMAL +/-.01;
//     THREE PLACE DECIMAL +/-.005; BREAK SHARP EDGES .003-.007 (not a tolerance)
// so the tightest linear tolerance on the drawing is 0.005 inch.
//
// The drawing declares inch units (DIMENSIONS ARE IN INCHES), so the stored
// valueInch must be exactly 0.005, or null (fail closed). Any other number, in
// particular 0.000197 (0.005 wrongly divided by 25.4 as if it were millimetres),
// is wrong and fails the test.
//
// File name: when the upload is named 1093-05589-02.pdf, the correct part number
// and revision can also be recovered from the FILENAME stem (rescueOcrTitleBlockFields
// in pdfDrawing.ts), which would hide a title-block defect. The checks below
// therefore run under the neutral base names "upload.pdf" and "bracket.pdf", and a
// separate case checks that the real name gives the same values (no regression).
//
// OVD-985 (observed 2026-10-18, poppler 26.05.0, fixed with OVD-989): the parser
// read the part number and revision as "Q.A." (an approvals-block label above the
// DWG. NO. row) with reviewNeeded=false and status "approved". The three tests that
// were `it.fails` pins while the defect was open are ordinary assertions now: the
// drawing number, the revision, and no silent approval of a value that differs from
// the drawing. A label-like token is never accepted (titleBlockCells.test.ts).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { pdfTextOf, stretchColumns } from "../../test-support/titleBlockSheet";
import type { DrawingExtractionPayload, JobFileRecord, PartRecord } from "../types";
import { runHybridExtraction } from "./hybridExtraction";
import { extractPdfText, type PdfTextExtraction } from "./pdfDrawing";
import { buildStoredExtractionPayload, summarizeExtractionOutcome } from "./sharedResult";

const FIXTURE = path.resolve(__dirname, "../../../test-fixtures/quoted-sample/1093-05589-02.pdf");
const FIXTURE_SHA256 = "4c1a151a9c642137a2d98c2ea1d2b1381db0ef28b8ca819d3fa360e26f861962";

const TRUTH = {
  partNumber: "1093-05589",
  revision: "02",
  material: "6061 Alloy",
  tightestLinearToleranceInch: 0.005,
} as const;

function hasBinary(name: string, args: string[]): boolean {
  try {
    execFileSync(name, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// CI installs poppler-utils for the test job. Without it the text layer cannot be
// read at all, so the suite is reported as skipped rather than as a pass.
const hasPoppler = hasBinary("pdfinfo", ["-v"]) && hasBinary("pdftotext", ["-v"]);

describe.skipIf(!hasPoppler)("sample drawing 1093-05589-02, deterministic PDF-text extraction", () => {
  let pdfText: PdfTextExtraction | null;
  let extraction: DrawingExtractionPayload;
  let otherNeutralName: DrawingExtractionPayload;
  let realName: DrawingExtractionPayload;
  const modelCalls: unknown[] = [];

  function extractAs(fileName: string) {
    return runHybridExtraction(
      {
        part: { id: "part-sample", name: "sample" } as PartRecord,
        cadFile: null,
        drawingFile: { original_name: fileName } as JobFileRecord,
        pdfText,
      },
      {
        extractWithModel: async (...args) => {
          modelCalls.push(args);
          throw new Error("model extraction must not run in the deterministic path test");
        },
      },
    );
  }

  beforeAll(async () => {
    pdfText = await extractPdfText(FIXTURE);
    // The friend's upload keeps its own file name; use neutral ones so a filename
    // fallback cannot supply the part number or the revision.
    extraction = await extractAs("upload.pdf");
    otherNeutralName = await extractAs("bracket.pdf");
    realName = await extractAs("1093-05589-02.pdf");
  }, 120_000);

  it("reads the fixture the truth was established from", () => {
    const bytes = fs.readFileSync(FIXTURE);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FIXTURE_SHA256);
  });

  it("reads one page with a real text layer and no model call", () => {
    expect(pdfText).not.toBeNull();
    expect(pdfText?.pageCount).toBe(1);
    expect(pdfText?.pageCountKnown).toBe(true);
    expect(pdfText?.ocr).toBe(false);
    expect(pdfText?.pages[0].text).toContain(TRUTH.partNumber);
    expect(extraction.modelFallbackUsed).toBe(false);
    expect(extraction.modelName).toBeNull();
    expect(modelCalls).toHaveLength(0);
  });

  it("extracts the title as the description", () => {
    expect(extraction.description).toMatch(/^ROUND, CARBON FIBER END ATTACHMENTS/);
    expect(extraction.quoteDescription).toMatch(/CARBON FIBER END ATTACHMENTS/);
  });

  it("extracts the material printed in the title block", () => {
    expect(extraction.material.raw).toBe(TRUTH.material);
    expect(extraction.material.reviewNeeded).toBe(false);
  });

  it("extracts the finish printed in the title block", () => {
    expect(extraction.finish.raw).toMatch(/ANODIZE/i);
    expect(extraction.finish.raw).toMatch(/BLACK/i);
    expect(extraction.finish.raw).toContain("MIL-A-8625F");
    expect(extraction.finish.raw).toMatch(/TYPE II/i);
    expect(extraction.quoteFinish).toMatch(/black anodize/i);
    expect(extraction.quoteFinish).toMatch(/type ii/i);
  });

  it("stores the inch tolerance exactly (0.005) or fails closed (null)", () => {
    const stored = buildStoredExtractionPayload(extraction, pdfText?.pageCount ?? 0, "test-build");
    const valueInch = stored.tolerances.valueInch;

    // The drawing is in inches (THREE PLACE DECIMAL +/-.005), so the only
    // acceptable stored values are exactly 0.005 or null (fail closed). This
    // rejects values that are too tight (0.000197 = 0.005 / 25.4) as well as too
    // loose ones.
    expect([TRUTH.tightestLinearToleranceInch, null]).toContain(valueInch);
    // The drawing states a numeric tolerance, so the raw text must be reported.
    expect(stored.tolerances.tightest).not.toBeNull();
  });

  it("completes with an editable, reviewable result for the user", () => {
    const summary = summarizeExtractionOutcome(extraction);
    expect(summary.missingFields).toEqual([]);
    // Every printed field is present; the lifecycle may still be partial because
    // of review warnings, which is acceptable as long as nothing is missing.
    expect(["partial", "succeeded"]).toContain(summary.lifecycle);
  });

  // OVD-985: the part number and revision are the values of the DWG. NO. and REV cells, not "Q.A.",
  // the approvals label on the line under them. Under a neutral file name they must come from the drawing.
  it("OVD-985: extracts the drawing number 1093-05589", () => {
    expect(extraction.partNumber).toBe(TRUTH.partNumber);
    expect(extraction.extractedPartNumberRaw.reasons).toContain("label_match");
    expect(extraction.extractedPartNumberRaw.reasons).not.toContain("filename_stem");
  });

  it("OVD-985: extracts revision 02", () => {
    expect(extraction.revision).toBe(TRUTH.revision);
    expect(extraction.extractedRevisionRaw.reasons).toContain("label_match");
    expect(extraction.extractedRevisionRaw.reasons).not.toContain("filename_stem");
  });

  // Holds even if a part number or revision were ever misread: a value that differs from the drawing
  // must at least be flagged for the user to edit, and the part must not be reported as approved.
  it("OVD-985: never silently approves a part number or revision that differs from the drawing", () => {
    for (const result of [extraction, otherNeutralName, realName]) {
      const wrong = result.partNumber !== TRUTH.partNumber || result.revision !== TRUTH.revision;
      if (wrong) {
        expect(result.reviewFields).toEqual(expect.arrayContaining(["partNumber", "revision"]));
        expect(result.status).not.toBe("approved");
      }
    }
  });

  it("OVD-985: never accepts an approvals-block label as the part number or revision", () => {
    for (const result of [extraction, otherNeutralName, realName]) {
      expect(result.partNumber).not.toMatch(/^(?:Q\.?A\.?|CHECKED|DRAWN|APPROVED|ENG|MFG)$/i);
      expect(result.revision ?? "").not.toMatch(/^(?:Q\.?A\.?|CHECKED|DRAWN|APPROVED|ENG|MFG)$/i);
    }
  });

  it("reads the same title block under another neutral file name", () => {
    expect(otherNeutralName.partNumber).toBe(TRUTH.partNumber);
    expect(otherNeutralName.revision).toBe(TRUTH.revision);
    expect(otherNeutralName.material.raw).toBe(TRUTH.material);
    expect(otherNeutralName.finish.raw).toBe(extraction.finish.raw);
    expect(otherNeutralName.reviewFields).toEqual(extraction.reviewFields);
    expect(otherNeutralName.status).toBe(extraction.status);
  });

  it("does not regress when the file is named after the part", () => {
    expect(realName.partNumber).toBe(TRUTH.partNumber);
    expect(realName.revision).toBe(TRUTH.revision);
    expect(realName.material.raw).toBe(TRUTH.material);
    expect(realName.finish.raw).toBe(extraction.finish.raw);
    expect(realName.reviewFields).toEqual([]);
    expect(realName.tightestTolerance.valueInch).toBe(TRUTH.tightestLinearToleranceInch);
  });

  // Other poppler versions lay the same page out with different character cells; the pairing must not depend
  // on exact columns. The text layer poppler printed here is scaled and read again.
  it.each([0.75, 0.9, 1.1, 1.25, 1.5])("reads the same title block with the layout scaled by %s", async (factor) => {
    const scaled = pdfTextOf(stretchColumns(pdfText?.pages[0].text ?? "", factor));
    const result = await runHybridExtraction(
      {
        part: { id: "part-sample", name: "sample" } as PartRecord,
        cadFile: null,
        drawingFile: { original_name: "upload.pdf" } as JobFileRecord,
        pdfText: scaled,
      },
      { extractWithModel: async () => { throw new Error("model extraction must not run"); } },
    );
    expect(result.partNumber).toBe(TRUTH.partNumber);
    expect(result.revision).toBe(TRUTH.revision);
    expect(result.material.raw).toBe(TRUTH.material);
    expect(result.finish.raw).toBe(extraction.finish.raw);
    expect(result.reviewFields).toEqual([]);
    expect(result.tightestTolerance.valueInch).toBe(TRUTH.tightestLinearToleranceInch);
  });

  it("reads the title block without a review flag on the identity fields, material or finish", () => {
    expect(extraction.reviewFields).toEqual([]);
    expect(extraction.tightestTolerance.valueInch).toBe(TRUTH.tightestLinearToleranceInch);
    expect(modelCalls).toHaveLength(0);
  });
});
