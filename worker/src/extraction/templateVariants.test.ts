// @vitest-environment node
//
// Real-template regression corpus for the deterministic drawing extractor
// (Linear OVD-989; related OVD-985 and OVD-976).
//
// LOCAL GATE, NOT CI EVIDENCE. The corpus is a set of PDFs exported from the project
// owner's own drawing template, one variant per selectable template field (units,
// general-tolerance block, ASME edition, drawing number, revision, material, finish,
// notes, ITAR note, EAR note). The repository is public, so neither the PDFs nor their
// manifest are committed. They live in test-fixtures/private/template-variants/
// (gitignored) or in the folder named by OVERDRAFTER_TEMPLATE_VARIANTS_DIR. When the
// manifest or poppler is absent this whole suite is skipped, as it is in CI.
//
// Tier: real poppler (pdfinfo, pdftotext) and real file bytes. No model, no database, no
// storage, no network. The model extractor is injected as a stub that fails the test if it
// is ever called. This is not staging or live evidence.
//
// Expected values are NOT derived from the code under test. manifest.json records what a
// person read on each rendered page (title block, tolerance block, notes) and which
// general tolerance applies to the dimensions actually shown. It is read at run time.
//
// Each PDF is copied byte for byte to "upload.pdf" in a temporary folder, so the file-name
// fallback of the part number (rescueOcrTitleBlockFields in pdfDrawing.ts) cannot hide a
// title-block defect.
//
// KNOWN_DEFECTS maps a variant id and a check name to the open Linear issue that explains
// why the extractor is wrong today. Those checks run as `it.fails`: the suite is green
// while the issue is open and turns red when a fix lands, and then the entry is deleted.
// The map is static on purpose. It must never be computed from the observed result, or a
// fix could not flip it. TEMPLATE_VARIANTS_STRICT=1 runs the known defects as ordinary
// assertions.
//
// Observed when this file was written (poppler 26.10.0), per failure class:
//  - Title block (OVD-989): each label sits on one text row and its value on a later row.
//    The DWG. NO. and REV values are two rows below their labels (a blank row between) and
//    the MATERIAL value is five rows below, but the anchored reader looks one row down for
//    the part number, revision and material (two for the finish), so nothing is paired. The
//    part number falls back to the upload name (the fallback pattern needs digits-digits
//    numbers), the revision stays empty, and the material stays empty, except in TV09 and
//    TV13 where an unlabeled finish keyword (ANODIZE) matches the material fallback and the
//    finish cell text is read as the material. The finish is read from the SURFACE FINISH
//    block, because the label FINISH is a substring of SURFACE FINISH. All four fields are
//    flagged for review and nothing is approved, which the noSilentApproval check pins.
//  - Four-place row (OVD-989): the inch general-tolerance block prints a FOUR PLACE row, but
//    no dimension on the sheet uses four decimals. The tightest printed row is stored, which
//    is tighter than the manifest's applicable tolerance. TV02, which has no such row, stores
//    the applicable value.
//  - Metric (filed under OVD-989 because its regression set must cover metric templates):
//    the metric rows carry no "PLACE DECIMAL" words and the plus-minus glyph is not in the
//    text layer, so no metric row is read. The only plus-minus signs left in the text are the
//    inspection-environment figures, so the raw tightest text is the humidity percentage and
//    the stored inch value is null (OVD-976 fails closed, and the units are read correctly
//    as metric). Null is safe but is not the applicable value.
//  - OVD-985 ("Q.A." read as part number and revision) does not occur in this corpus: the
//    template has no "Q.A." label, so no entry cites it.
// TV07 prints a drawing number that visually touches the REV cell. Its text layer still
// carries the number and the revision as separate tokens, so the manifest truth is unchanged.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectExportControlMarkings, scanDrawingTextForExportMarkings } from "../exportControl";
import type { DrawingExtractionPayload, JobFileRecord, PartRecord } from "../types";
import { runHybridExtraction } from "./hybridExtraction";
import { extractPdfText, type PdfTextExtraction } from "./pdfDrawing";
import { buildStoredExtractionPayload } from "./sharedResult";

const NEUTRAL_UPLOAD_NAME = "upload.pdf";
const MM_PER_INCH = 25.4;
// approved_part_requirements.tightest_tolerance_inch is numeric(10,4): a stored tolerance
// is the printed one to within one step of that column.
const STORED_TOLERANCE_STEP = 0.0001;
const EXPECTED_VARIANT_IDS = Array.from({ length: 13 }, (_, index) => `TV${String(index + 1).padStart(2, "0")}`);

type ToleranceTruth = { value: number; unit: "in" | "mm" };

type VariantTruth = {
  partNumber: string;
  revision: string;
  material: string;
  finish: string;
  units: "inch" | "mm";
  tightestApplicableLinearTolerance: ToleranceTruth;
  exportControlMarkingExpected: boolean;
  exportNoteText: string | null;
};

type Variant = {
  id: string;
  pdf: string;
  pdfSha256: string;
  pageCount: number;
  truth: VariantTruth;
};

type Manifest = { variants: Variant[] };

/** What the extraction chain produced for one variant, reduced to the compared values. */
type Observation = {
  partNumber: string | null;
  revision: string | null;
  material: string | null;
  finish: string | null;
  drawingUnits: string | null;
  valueInch: number | null;
  status: string;
  reviewFields: readonly string[];
  exportScanSource: string | null;
  exportPatterns: readonly string[];
};

function text(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function toInch(tolerance: ToleranceTruth) {
  return tolerance.unit === "mm" ? tolerance.value / MM_PER_INCH : tolerance.value;
}

function sameField(field: string, observed: string | null, expected: string) {
  // An empty expected value would equal an empty observation, so it never matches.
  return text(expected) !== "" && text(observed) === text(expected)
    ? null
    : `${field}: got ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`;
}

function storedMatchesApplicable(stored: number | null, truth: VariantTruth) {
  return (
    stored !== null &&
    Math.abs(stored - toInch(truth.tightestApplicableLinearTolerance)) <= STORED_TOLERANCE_STEP + 1e-9
  );
}

const FIELD_CHECKS = {
  partNumber: (truth: VariantTruth, observed: Observation) =>
    sameField("partNumber", observed.partNumber, truth.partNumber),
  revision: (truth: VariantTruth, observed: Observation) => sameField("revision", observed.revision, truth.revision),
  material: (truth: VariantTruth, observed: Observation) => sameField("material", observed.material, truth.material),
  finish: (truth: VariantTruth, observed: Observation) => sameField("finish", observed.finish, truth.finish),
};

// Each check returns null when the extraction agrees with the manifest, else a description.
const CHECKS = {
  ...FIELD_CHECKS,
  drawingUnits: (truth: VariantTruth, observed: Observation) => {
    const expected = truth.units === "mm" ? "metric" : "inch";
    return observed.drawingUnits === expected
      ? null
      : `drawingUnits: got ${JSON.stringify(observed.drawingUnits)}, expected ${JSON.stringify(expected)}`;
  },
  // Never a value from a row that does not govern the sheet: the applicable tolerance in
  // inches, or nothing stored (fail closed).
  toleranceSafe: (truth: VariantTruth, observed: Observation) =>
    observed.valueInch === null || storedMatchesApplicable(observed.valueInch, truth)
      ? null
      : `valueInch: stored ${observed.valueInch}, applicable ${toInch(truth.tightestApplicableLinearTolerance)}`,
  // The applicable tolerance is what is stored.
  toleranceApplicable: (truth: VariantTruth, observed: Observation) =>
    storedMatchesApplicable(observed.valueInch, truth)
      ? null
      : `valueInch: stored ${observed.valueInch}, applicable ${toInch(truth.tightestApplicableLinearTolerance)}`,
  // A field that differs from the drawing must be flagged for review and not approved.
  noSilentApproval: (truth: VariantTruth, observed: Observation) => {
    const wrong = (Object.keys(FIELD_CHECKS) as Array<keyof typeof FIELD_CHECKS>).filter(
      (field) => FIELD_CHECKS[field](truth, observed) !== null,
    );
    const unflagged = wrong.filter((field) => !observed.reviewFields.includes(field));
    if (unflagged.length > 0) return `wrong and not flagged for review: ${unflagged.join(", ")}`;
    return wrong.length > 0 && observed.status === "approved" ? "status approved with fields that differ" : null;
  },
  exportMarking: (truth: VariantTruth, observed: Observation) => {
    const scanned = observed.exportScanSource !== null;
    const matched = observed.exportPatterns.length > 0;
    return scanned === truth.exportControlMarkingExpected && matched === truth.exportControlMarkingExpected
      ? null
      : `export marking: scan ${scanned}, pattern match ${matched}, expected ${truth.exportControlMarkingExpected}`;
  },
};

type Check = keyof typeof CHECKS;
const ALL_CHECKS = Object.keys(CHECKS) as Check[];
// Listed again by hand so that dropping a check from CHECKS fails the coverage guard below.
const EXPECTED_CHECKS: readonly Check[] = [
  "partNumber",
  "revision",
  "material",
  "finish",
  "drawingUnits",
  "toleranceSafe",
  "toleranceApplicable",
  "noSilentApproval",
  "exportMarking",
];

const CHECK_TITLES: Record<Check, string> = {
  partNumber: "extracts the drawing number printed in the title block",
  revision: "extracts the revision printed in the title block",
  material: "extracts the material printed in the title block",
  finish: "extracts the finish printed in the title block",
  drawingUnits: "reads the drawing units the title block declares",
  toleranceSafe: "stores the applicable tolerance in inches, or nothing (fail closed)",
  toleranceApplicable: "stores the applicable linear tolerance in inches",
  noSilentApproval: "never approves a field that differs from the drawing",
  exportMarking: "flags an export-control note and nothing else",
};

const TITLE_BLOCK_NOT_PAIRED = {
  partNumber: "OVD-989",
  revision: "OVD-989",
  material: "OVD-989",
  finish: "OVD-989",
} as const;
const FOUR_PLACE_ROW_STORED = { toleranceSafe: "OVD-989", toleranceApplicable: "OVD-989" } as const;
const METRIC_ROWS_NOT_READ = { toleranceApplicable: "OVD-989" } as const;

// Static on purpose: see the header. Delete an entry when its fix lands and the check turns red.
const KNOWN_DEFECTS: Readonly<Record<string, Partial<Record<Check, string>>>> = {
  TV01: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV02: { ...TITLE_BLOCK_NOT_PAIRED },
  TV03: { ...TITLE_BLOCK_NOT_PAIRED, ...METRIC_ROWS_NOT_READ },
  TV04: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV05: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV06: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV07: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV08: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV09: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV10: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV11: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV12: { ...TITLE_BLOCK_NOT_PAIRED, ...FOUR_PLACE_ROW_STORED },
  TV13: { ...TITLE_BLOCK_NOT_PAIRED, ...METRIC_ROWS_NOT_READ },
};

// An observation that agrees with the manifest in every compared value. It is built from
// the truth alone, so it tests the comparators without involving the extractor.
function mirror(truth: VariantTruth): Observation {
  return {
    partNumber: truth.partNumber,
    revision: truth.revision,
    material: truth.material,
    finish: truth.finish,
    drawingUnits: truth.units === "mm" ? "metric" : "inch",
    valueInch: toInch(truth.tightestApplicableLinearTolerance),
    status: "needs_review",
    reviewFields: [],
    exportScanSource: truth.exportControlMarkingExpected ? "drawing_text" : null,
    exportPatterns: truth.exportControlMarkingExpected ? ["itar"] : [],
  };
}

// One deviation per check, each of which that check must reject.
const DEVIATIONS: Record<Check, (same: Observation, truth: VariantTruth) => Observation> = {
  partNumber: (same) => ({ ...same, partNumber: "Q.A." }),
  revision: (same) => ({ ...same, revision: "Q.A." }),
  material: (same, truth) => ({ ...same, material: truth.finish }),
  finish: (same) => ({ ...same, finish: "63 OR BETTER" }),
  drawingUnits: (same, truth) => ({ ...same, drawingUnits: truth.units === "mm" ? "inch" : "metric" }),
  // The applicable tolerance divided by five: a tighter row that governs no dimension.
  toleranceSafe: (same, truth) => ({ ...same, valueInch: toInch(truth.tightestApplicableLinearTolerance) / 5 }),
  toleranceApplicable: (same) => ({ ...same, valueInch: null }),
  noSilentApproval: (same) => ({ ...same, partNumber: "Q.A.", reviewFields: [], status: "approved" }),
  exportMarking: (same, truth) => ({
    ...same,
    exportScanSource: truth.exportControlMarkingExpected ? null : "drawing_text",
    exportPatterns: truth.exportControlMarkingExpected ? [] : ["itar"],
  }),
};

function assertVariantShape(value: unknown): asserts value is Variant {
  const variant = value as Partial<Variant> | null;
  const truth: Partial<VariantTruth> = variant?.truth ?? {};
  const tolerance: Partial<ToleranceTruth> = truth.tightestApplicableLinearTolerance ?? {};
  const isText = (candidate: unknown) => typeof candidate === "string" && candidate.trim() !== "";
  const invalid = [
    ["id", isText(variant?.id)],
    ["pdf", isText(variant?.pdf)],
    ["pdfSha256", typeof variant?.pdfSha256 === "string" && /^[0-9a-f]{64}$/.test(variant.pdfSha256)],
    ["pageCount", Number.isInteger(variant?.pageCount) && (variant?.pageCount ?? 0) > 0],
    ["truth.partNumber", isText(truth.partNumber)],
    ["truth.revision", isText(truth.revision)],
    ["truth.material", isText(truth.material)],
    ["truth.finish", isText(truth.finish)],
    ["truth.units", truth.units === "inch" || truth.units === "mm"],
    [
      "truth.tightestApplicableLinearTolerance",
      Number.isFinite(tolerance.value) && (tolerance.value ?? 0) > 0 && (tolerance.unit === "in" || tolerance.unit === "mm"),
    ],
    ["truth.exportControlMarkingExpected", typeof truth.exportControlMarkingExpected === "boolean"],
  ]
    .filter(([, valid]) => !valid)
    .map(([name]) => name);
  if (invalid.length > 0) throw new Error(`manifest variant ${variant?.id ?? "(no id)"}: invalid ${invalid.join(", ")}`);
}

function resolveCorpusDir() {
  const fromEnv = process.env.OVERDRAFTER_TEMPLATE_VARIANTS_DIR?.trim();
  return fromEnv
    ? path.resolve(fromEnv.replace(/^~(?=$|\/)/, os.homedir()))
    : path.resolve(__dirname, "../../../test-fixtures/private/template-variants");
}

function loadManifest(dir: string): Manifest | null {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const variants: unknown = (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { variants?: unknown }).variants;
  if (!Array.isArray(variants) || variants.length === 0) throw new Error("manifest.json has no variants");
  variants.forEach(assertVariantShape);
  return { variants: variants as Variant[] };
}

function hasBinary(name: string, args: string[]): boolean {
  try {
    execFileSync(name, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CORPUS_DIR = resolveCorpusDir();
const manifest = loadManifest(CORPUS_DIR);
// CI installs poppler-utils for the test job but has no corpus. Without poppler the text
// layer cannot be read at all, so the suite is reported as skipped rather than as a pass.
const hasPoppler = hasBinary("pdfinfo", ["-v"]) && hasBinary("pdftotext", ["-v"]);
const skipReason = !hasPoppler
  ? "poppler (pdfinfo, pdftotext) is not installed"
  : !manifest
    ? "no corpus manifest; set OVERDRAFTER_TEMPLATE_VARIANTS_DIR"
    : null;
const strict = process.env.TEMPLATE_VARIANTS_STRICT === "1";

describe.skipIf(skipReason !== null)(
  `template variants, deterministic PDF-text extraction${skipReason ? ` [skipped: ${skipReason}]` : ""}`,
  () => {
    const registered = new Set<string>();
    const consumed = new Set<string>();

    for (const variant of manifest?.variants ?? []) {
      describe(variant.id, () => {
        const truth = variant.truth;
        const modelCalls: unknown[] = [];
        let tempDir = "";
        let uploadPath = "";
        let bytesSha256 = "";
        let pdfText: PdfTextExtraction | null = null;
        let extraction: DrawingExtractionPayload;
        let pageText = "";
        let observed: Observation;

        beforeAll(async () => {
          const bytes = fs.readFileSync(path.join(CORPUS_DIR, variant.pdf));
          bytesSha256 = createHash("sha256").update(bytes).digest("hex");
          tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovd-template-variant-"));
          uploadPath = path.join(tempDir, NEUTRAL_UPLOAD_NAME);
          fs.writeFileSync(uploadPath, bytes);

          pdfText = await extractPdfText(uploadPath);
          extraction = await runHybridExtraction(
            {
              part: { id: `part-${variant.id}`, name: variant.id } as PartRecord,
              cadFile: null,
              drawingFile: { original_name: NEUTRAL_UPLOAD_NAME } as JobFileRecord,
              pdfText,
            },
            {
              extractWithModel: async (...args) => {
                modelCalls.push(args);
                throw new Error("model extraction must not run in the deterministic path test");
              },
            },
          );

          const stored = buildStoredExtractionPayload(extraction, pdfText?.pageCount ?? 0, "test-build");
          pageText = pdfText?.pages.map((page) => page.text).join("\n") ?? "";
          observed = {
            partNumber: extraction.partNumber,
            revision: extraction.revision,
            material: extraction.material.raw,
            finish: extraction.finish.raw,
            drawingUnits: stored.tolerances.drawingUnits,
            valueInch: stored.tolerances.valueInch,
            status: extraction.status,
            reviewFields: extraction.reviewFields,
            exportScanSource: scanDrawingTextForExportMarkings(pdfText)?.source ?? null,
            exportPatterns: detectExportControlMarkings(pageText),
          };
        }, 120_000);

        afterAll(() => {
          if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it("reads the exact bytes the truth was established from", () => {
          expect(bytesSha256).toBe(variant.pdfSha256);
        });

        it("runs the real chain on the neutral upload name with a text layer and no model call", () => {
          // Everything below is a precondition of the known-defect checks: an extraction
          // that never ran would make every `it.fails` pass for the wrong reason.
          expect(path.basename(uploadPath)).toBe(NEUTRAL_UPLOAD_NAME);
          expect(pdfText).not.toBeNull();
          expect(pdfText?.pageCount).toBe(variant.pageCount);
          expect(pdfText?.pageCountKnown).toBe(true);
          expect(pdfText?.ocr).toBe(false);
          expect(extraction.modelFallbackUsed).toBe(false);
          expect(extraction.modelName).toBeNull();
          expect(modelCalls).toHaveLength(0);
          expect(Object.keys(observed).sort()).toEqual(Object.keys(mirror(truth)).sort());
        });

        it("does not take the part number from the file name", () => {
          expect(text(observed.partNumber)).not.toContain(text(variant.id));
        });

        it("has the printed values of the truth in its text layer", () => {
          // Guards the corpus itself: a truth the page does not carry is a bad manifest,
          // not an extractor defect.
          const layer = text(pageText);
          for (const value of [truth.partNumber, truth.revision, truth.material, truth.finish]) {
            expect(layer, value).toMatch(new RegExp(`(^| )${escapeRegExp(text(value))}( |$)`));
          }
          if (truth.exportNoteText) expect(layer).toContain(text(truth.exportNoteText));
        });

        it("compares like the manifest: accepts the truth and rejects each deviation from it", () => {
          const same = mirror(truth);
          for (const check of ALL_CHECKS) {
            expect(CHECKS[check](truth, same), `${check} on the truth itself`).toBeNull();
            expect(CHECKS[check](truth, DEVIATIONS[check](same, truth)), `${check} on a deviation`).not.toBeNull();
          }
          // Failing closed is accepted where it is safe, and only there.
          const flagged = { ...same, partNumber: "Q.A.", reviewFields: ["partNumber"] };
          expect(CHECKS.noSilentApproval(truth, flagged)).toBeNull();
          expect(CHECKS.noSilentApproval(truth, { ...flagged, status: "approved" })).not.toBeNull();
          expect(CHECKS.toleranceSafe(truth, { ...same, valueInch: null })).toBeNull();
          expect(CHECKS.toleranceApplicable(truth, { ...same, valueInch: null })).not.toBeNull();
        });

        for (const check of ALL_CHECKS) {
          registered.add(`${variant.id}:${check}`);
          const issue = KNOWN_DEFECTS[variant.id]?.[check];
          if (issue) consumed.add(`${variant.id}:${check}`);
          const runner = issue && !strict ? it.fails : it;
          runner(issue ? `${issue}: ${CHECK_TITLES[check]}` : CHECK_TITLES[check], () => {
            expect(CHECKS[check](truth, observed)).toBeNull();
          });
        }
      });
    }

    it("runs every check on every variant of the corpus", () => {
      const expected = EXPECTED_VARIANT_IDS.flatMap((id) => EXPECTED_CHECKS.map((check) => `${id}:${check}`));
      expect([...registered].sort()).toEqual(expected.sort());
    });

    it("records known defects only for variants and checks that exist, and applies every one", () => {
      const recorded: string[] = [];
      for (const [id, checks] of Object.entries(KNOWN_DEFECTS)) {
        expect(EXPECTED_VARIANT_IDS, id).toContain(id);
        for (const [check, issue] of Object.entries(checks)) {
          expect(ALL_CHECKS, `${id} ${check}`).toContain(check);
          expect(issue, `${id} ${check}`).toMatch(/^OVD-\d+$/);
          recorded.push(`${id}:${check}`);
        }
      }
      expect([...consumed].sort()).toEqual(recorded.sort());
    });
  },
);
