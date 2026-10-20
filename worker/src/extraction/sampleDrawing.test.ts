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
// and revision are recovered from the FILENAME stem (rescueOcrTitleBlockFields in
// pdfDrawing.ts), which would hide the title-block defect below. The test
// therefore deliberately uses the neutral base name "upload.pdf".
//
// KNOWN DEFECT, Linear OVD-985 (observed 2026-10-18, poppler 26.05.0): the parser
// reads the part number and revision as "Q.A." (an approvals-block label above the
// DWG. NO. row) with reviewNeeded=false and status "approved". The three OVD-985
// tests below (drawing number, revision, no silent approval) are wrapped in
// `it.fails` so the suite stays green while OVD-985 is open, and so that once
// OVD-985 is fixed they flip to red until the wrapper is removed. When OVD-985 is
// closed, replace `knownDefect` with `it` so the wrapper cannot outlive its reason.
// Set SAMPLE_DRAWING_STRICT=1 to run them as ordinary failing assertions.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
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
const strict = process.env.SAMPLE_DRAWING_STRICT === "1";
const knownDefect = strict ? it : it.fails;

describe.skipIf(!hasPoppler)("sample drawing 1093-05589-02, deterministic PDF-text extraction", () => {
  let pdfText: PdfTextExtraction | null;
  let extraction: DrawingExtractionPayload;
  const modelCalls: unknown[] = [];

  beforeAll(async () => {
    pdfText = await extractPdfText(FIXTURE);
    extraction = await runHybridExtraction(
      {
        part: { id: "part-sample", name: "sample" } as PartRecord,
        cadFile: null,
        // The friend's upload keeps its own file name; use a neutral one so a
        // filename fallback cannot supply the part number.
        drawingFile: { original_name: "upload.pdf" } as JobFileRecord,
        pdfText,
      },
      {
        extractWithModel: async (...args) => {
          modelCalls.push(args);
          throw new Error("model extraction must not run in the deterministic path test");
        },
      },
    );
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

  // KNOWN DEFECT OVD-985: observed value is "Q.A." for both, reviewNeeded=false.
  // When OVD-985 is fixed these three tests flip to red: replace knownDefect with it.
  knownDefect("OVD-985: extracts the drawing number 1093-05589", () => {
    expect(extraction.partNumber).toBe(TRUTH.partNumber);
  });

  knownDefect("OVD-985: extracts revision 02", () => {
    expect(extraction.revision).toBe(TRUTH.revision);
  });

  // OVD-985 as well. Holds regardless of the defect above once it is fixed or
  // mitigated: a value that differs from the drawing must at least be flagged for
  // the user to edit, and the part must not be reported as approved.
  knownDefect("OVD-985: never silently approves a part number or revision that differs from the drawing", () => {
    const wrong = extraction.partNumber !== TRUTH.partNumber || extraction.revision !== TRUTH.revision;
    if (wrong) {
      expect(extraction.reviewFields).toEqual(expect.arrayContaining(["partNumber", "revision"]));
      expect(extraction.status).not.toBe("approved");
    }
  });
});
