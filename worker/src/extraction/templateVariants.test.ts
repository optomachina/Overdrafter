// @vitest-environment node
//
// Real-template regression corpus for the deterministic drawing extractor
// (Linear OVD-989; related OVD-985 and OVD-976).
//
// Corpus: PDFs exported from Blaine's own SolidWorks 2022 drawing template
// (Drawing.drwdot) for the sanitized part OVD-VALIDATION-002, one variant per
// selectable template field (units, tolerance block, ASME edition, drawing
// number, revision, material, finish, notes, ITAR note, EAR99 note). Company and
// contact fields are the template placeholders. The PDFs are private: they are
// NOT committed (see test-fixtures/README.md). They live in
// test-fixtures/private/template-variants/ (gitignored) or in the folder named
// by OVERDRAFTER_TEMPLATE_VARIANTS_DIR, next to a manifest.json written when the
// variants were exported. When the manifest is absent the suite is skipped.
//
// Tier: real poppler (pdfinfo, pdftotext) and real file bytes; NO model, NO
// database, NO storage, NO network. The model extractor is injected as a stub that
// fails the test if it is ever called. This is not staging or live evidence.
//
// Expected values are NOT derived from the code under test. The manifest records
// what a human reads on the rendered page: each variant was exported, rendered
// and read visually, and the printed title block and tolerance block lines were
// transcribed. The tests compare the extractor against that truth.
//
// File name: the upload is called "upload.pdf" so that the file-name fallback
// (rescueOcrTitleBlockFields in pdfDrawing.ts) cannot supply a part number and
// hide a title-block defect.
//
// KNOWN DEFECTS: `KNOWN_DEFECTS` below maps a variant id and a check to the Linear
// issue that explains why the parser is wrong today. Those checks run as
// `it.fails`, so the suite stays green while the issue is open and flips to red
// when the fix lands: then delete the entry. The map is static on purpose; it
// must never be computed from the observed result, or a fix could not flip it.
// Set TEMPLATE_VARIANTS_STRICT=1 to run the known defects as ordinary assertions.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { detectExportControlMarkings, scanDrawingTextForExportMarkings } from "../exportControl";
import type { DrawingExtractionPayload, JobFileRecord, PartRecord } from "../types";
import { runHybridExtraction } from "./hybridExtraction";
import { extractPdfText, type PdfTextExtraction } from "./pdfDrawing";
import { buildStoredExtractionPayload } from "./sharedResult";

const MM_PER_INCH = 25.4;

type ToleranceTruth = { value: number; unit: "inch" | "mm"; row: string };

type VariantTruth = {
  partNumber: string;
  revision: string;
  material: string;
  finish: string;
  units: "inch" | "mm";
  toleranceBlockLines: string[];
  dimensionsShown: string[];
  tightestStatedLinearToleranceInPrintedBlock: ToleranceTruth;
  tightestApplicableLinearTolerance: ToleranceTruth;
  exportControlMarkingExpected: boolean;
  exportNoteText: string | null;
};

type Variant = {
  id: string;
  pdf: string;
  pdfSha256: string;
  pageCount: number;
  fieldsChanged: string[];
  truth: VariantTruth;
};

type Manifest = { variants: Variant[] };

type Check =
  | "partNumber"
  | "revision"
  | "material"
  | "finish"
  | "tightestTolerance"
  | "noSilentApproval";

// variant id -> check -> the open issue that explains the failure. Filled from the
// observed run of the corpus (see the PR description for the per-variant table).
const KNOWN_DEFECTS: Record<string, Partial<Record<Check, "OVD-989" | "OVD-985" | "OVD-976">>> = {};

function defaultCorpusDir() {
  return path.resolve(__dirname, "../../../test-fixtures/private/template-variants");
}

function resolveCorpusDir() {
  const fromEnv = process.env.OVERDRAFTER_TEMPLATE_VARIANTS_DIR?.trim();
  return fromEnv ? path.resolve(fromEnv.replace(/^~(?=$|\/)/, os.homedir())) : defaultCorpusDir();
}

function loadManifest(dir: string): Manifest | null {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
    throw new Error(`${manifestPath} has no variants`);
  }
  return parsed;
}

function hasBinary(name: string, args: string[]): boolean {
  try {
    execFileSync(name, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function squash(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function toInch(tolerance: ToleranceTruth) {
  return tolerance.unit === "mm" ? tolerance.value / MM_PER_INCH : tolerance.value;
}

const CORPUS_DIR = resolveCorpusDir();
const manifest = loadManifest(CORPUS_DIR);
// CI installs poppler-utils for the test job. Without it the text layer cannot be
// read at all, so the suite is reported as skipped rather than as a pass.
const hasPoppler = hasBinary("pdfinfo", ["-v"]) && hasBinary("pdftotext", ["-v"]);
const strict = process.env.TEMPLATE_VARIANTS_STRICT === "1";

function checkTest(variantId: string, check: Check) {
  const issue = KNOWN_DEFECTS[variantId]?.[check];
  const runner = issue && !strict ? it.fails : it;
  return (title: string, body: () => void) => runner(issue ? `${issue}: ${title}` : title, body);
}

describe.skipIf(!hasPoppler || !manifest)("template variants, deterministic PDF-text extraction", () => {
  for (const variant of manifest?.variants ?? []) {
    describe(`${variant.id} (${variant.fieldsChanged.join("; ") || "baseline"})`, () => {
      const truth = variant.truth;
      const pdfPath = path.join(CORPUS_DIR, variant.pdf);
      let pdfText: PdfTextExtraction | null;
      let extraction: DrawingExtractionPayload;
      const modelCalls: unknown[] = [];

      beforeAll(async () => {
        pdfText = await extractPdfText(pdfPath);
        extraction = await runHybridExtraction(
          {
            part: { id: `part-${variant.id}`, name: variant.id } as PartRecord,
            cadFile: null,
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

      it("reads the exact bytes the truth was established from", () => {
        expect(createHash("sha256").update(fs.readFileSync(pdfPath)).digest("hex")).toBe(variant.pdfSha256);
      });

      it("reads the page text layer with no model call", () => {
        expect(pdfText).not.toBeNull();
        expect(pdfText?.pageCount).toBe(variant.pageCount);
        expect(pdfText?.pageCountKnown).toBe(true);
        expect(pdfText?.ocr).toBe(false);
        expect(extraction.modelFallbackUsed).toBe(false);
        expect(extraction.modelName).toBeNull();
        expect(modelCalls).toHaveLength(0);
      });

      it("has the printed values of the truth in its text layer", () => {
        // Guards the corpus itself: a truth the page does not carry is a bad
        // manifest, not an extractor defect.
        const text = squash(pdfText?.pages.map((page) => page.text).join("\n"));
        for (const value of [truth.partNumber, truth.revision, truth.material, truth.finish]) {
          expect(text).toContain(squash(value));
        }
      });

      checkTest(variant.id, "partNumber")("extracts the drawing number printed in the title block", () => {
        expect(extraction.partNumber).toBe(truth.partNumber);
      });

      checkTest(variant.id, "revision")("extracts the revision printed in the title block", () => {
        expect(extraction.revision).toBe(truth.revision);
      });

      checkTest(variant.id, "material")("extracts the material printed in the title block", () => {
        expect(squash(extraction.material.raw)).toBe(squash(truth.material));
      });

      checkTest(variant.id, "finish")("extracts the finish printed in the title block", () => {
        expect(squash(extraction.finish.raw)).toBe(squash(truth.finish));
      });

      checkTest(variant.id, "tightestTolerance")(
        "stores the tightest applicable linear tolerance in inches, or fails closed (null)",
        () => {
          const stored = buildStoredExtractionPayload(extraction, pdfText?.pageCount ?? 0, "test-build");
          const expectedInch = Number(toInch(truth.tightestApplicableLinearTolerance).toFixed(6));
          const valueInch = stored.tolerances.valueInch === null ? null : Number(stored.tolerances.valueInch.toFixed(6));
          // The only acceptable stored values are the applicable tolerance converted
          // to inches, or null (fail closed). A value read from a row that does not
          // govern the sheet, or a millimetre figure stored as inches, both fail.
          expect([expectedInch, null]).toContain(valueInch);
        },
      );

      checkTest(variant.id, "noSilentApproval")(
        "never silently approves a field that differs from the drawing",
        () => {
          const wrong = (
            [
              ["partNumber", extraction.partNumber === truth.partNumber],
              ["revision", extraction.revision === truth.revision],
              ["material", squash(extraction.material.raw) === squash(truth.material)],
              ["finish", squash(extraction.finish.raw) === squash(truth.finish)],
            ] as const
          )
            .filter(([, ok]) => !ok)
            .map(([field]) => field);
          if (wrong.length > 0) {
            expect(extraction.reviewFields).toEqual(expect.arrayContaining([...wrong]));
            expect(extraction.status).not.toBe("approved");
          }
        },
      );

      it(
        truth.exportControlMarkingExpected
          ? "flags the export-control note as a marking hit"
          : "does not flag the drawing as export-control marked",
        () => {
          const text = pdfText?.pages.map((page) => page.text).join("\n") ?? "";
          const scan = scanDrawingTextForExportMarkings(pdfText);
          if (truth.exportNoteText) {
            expect(squash(text)).toContain(squash(truth.exportNoteText));
          }
          if (truth.exportControlMarkingExpected) {
            expect(scan).not.toBeNull();
            expect(scan?.source).toBe("drawing_text");
            expect(detectExportControlMarkings(text).length).toBeGreaterThan(0);
          } else {
            expect(scan).toBeNull();
          }
        },
      );
    });
  }
});
