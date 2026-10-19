// @vitest-environment node
//
// OVD-989 and OVD-985: a B-size title block, in the order and at the columns `pdftotext -layout` prints it,
// run through the deterministic extraction (no model, no network, no poppler).
//
// Tier: synthetic text layer (worker/test-support/titleBlockTemplateSheet.ts). It is written for the tests
// and carries placeholder values only; it reproduces the layout problem, not any real drawing. The real
// drawings run in sampleDrawing.test.ts (the committed quoted sample, through poppler). The variants model
// the fields such a template lets a drawing change: drawing number, revision, material, finish, units, the
// ASME Y14.5 edition, the tolerance table (with and without a four-place row), notes and the approvals
// block. Expected values are what the sheet prints, not values read from the code under test.

import { describe, expect, it } from "vitest";
import { pdfTextOf, stretchColumns } from "../../test-support/titleBlockSheet";
import {
  TEMPLATE_DEFAULTS as DEFAULTS,
  titleBlockTemplateSheet,
  type TitleBlockTemplateOptions,
} from "../../test-support/titleBlockTemplateSheet";
import { detectExportControlMarkings } from "../exportControl";
import type { DrawingExtractionPayload, JobFileRecord, PartRecord } from "../types";
import { runHybridExtraction } from "./hybridExtraction";
import { buildStoredExtractionPayload, summarizeExtractionOutcome } from "./sharedResult";

const NEUTRAL_NAMES = ["upload.pdf", "bracket.pdf"] as const;

async function extractSheet(sheet: string, fileName = "upload.pdf") {
  const extraction = await runHybridExtraction(
    {
      part: { id: "part-template", name: "template" } as PartRecord,
      cadFile: null,
      drawingFile: { original_name: fileName } as JobFileRecord,
      pdfText: pdfTextOf(sheet),
    },
    {
      extractWithModel: async () => {
        throw new Error("model extraction must not run in the deterministic path test");
      },
    },
  );
  return {
    extraction,
    stored: buildStoredExtractionPayload(extraction, 1, "test-build"),
    missing: summarizeExtractionOutcome(extraction).missingFields,
  };
}

const extract = (options: TitleBlockTemplateOptions = {}) => extractSheet(titleBlockTemplateSheet(options));

function expectDefaultFields(extraction: DrawingExtractionPayload) {
  expect(extraction.partNumber).toBe(DEFAULTS.drawingNumber);
  expect(extraction.revision).toBe(DEFAULTS.revision);
  expect(extraction.material.raw).toBe(DEFAULTS.material);
  expect(extraction.finish.raw).toBe(DEFAULTS.finish);
  expect(extraction.description).toBe(DEFAULTS.title);
}

describe("B-size title block layout", () => {
  describe("the sheet as printed", () => {
    it.each(NEUTRAL_NAMES)(
      "reads the part number, revision, material, finish and tolerance from their cells (%s)",
      async (fileName) => {
        const { extraction, stored, missing } = await extractSheet(titleBlockTemplateSheet(), fileName);

        expectDefaultFields(extraction);
        expect(extraction.quoteFinish).toBe("AS MACHINED");
        expect(extraction.extractedPartNumberRaw.reasons).toContain("label_match");
        expect(extraction.extractedRevisionRaw.reasons).toContain("label_match");
        expect(extraction.extractedRevisionRaw.reasons).not.toContain("filename_stem");
        // The four-place row (.0010) is not used by any dimension on the sheet; three places (.005) is.
        expect(stored.tolerances).toMatchObject({ tightest: "±0.005", valueInch: 0.005, unit: "in", drawingUnits: "inch" });
        expect(extraction.reviewFields).toEqual([]);
        expect(extraction.status).toBe("approved");
        expect(missing).toEqual([]);
        expect(extraction.threads).toEqual([]);
        expect(extraction.modelFallbackUsed).toBe(false);
      },
    );

    it("never fills a field from the neighbouring label's text", async () => {
      const { extraction } = await extract();
      // The TITLE cell, the SURFACE FINISH block and the plating note sit next to MATERIAL and FINISH.
      expect(extraction.material.raw).not.toContain(DEFAULTS.title);
      expect(extraction.finish.raw).not.toMatch(/SEE NOTE|AS SPECIFIED|INTERPRET|PLATING|ACCORDANCE/);
      expect(extraction.partNumber).not.toMatch(/^(?:UPLOAD|BRACKET)$/);
    });

    it("is the layout problem: the drawing number is eight lines under its label, past the FINISH label", () => {
      const lines = titleBlockTemplateSheet().split("\n");
      const labelLine = lines.findIndex((line) => line.includes("SIZE DWG. NO."));
      const valueLine = lines.findIndex((line) => line.includes(DEFAULTS.drawingNumber));
      const finishLine = lines.findIndex((line) => line.includes("FINISH") && !line.includes("SURFACE"));
      expect(valueLine - labelLine).toBeGreaterThanOrEqual(7);
      expect(finishLine).toBeGreaterThan(labelLine);
      expect(finishLine).toBeLessThan(valueLine);
    });
  });

  describe("fields a drawing changes", () => {
    it.each([
      "X-1",
      "ABC-0001-LONGER-NUMBER",
      "1093-05589",
      "ENG-1234",
      "REV-B",
      "SIZE-7",
    ])("reads the drawing number %s from its own cell", async (drawingNumber) => {
      const { extraction } = await extract({ drawingNumber });
      expect(extraction.partNumber).toBe(drawingNumber);
      expect(extraction.revision).toBe(DEFAULTS.revision);
      expect(extraction.reviewFields).toEqual([]);
    });

    it.each(["A", "C", "C2", "10", "AB", "02"])("reads revision %s from the REV cell, not the SIZE cell beside it", async (revision) => {
      const { extraction } = await extract({ revision });
      expect(extraction.revision).toBe(revision);
      expect(extraction.partNumber).toBe(DEFAULTS.drawingNumber);
    });

    it.each([
      ["a different material", { material: "STAINLESS STEEL 316" }, "material", "STAINLESS STEEL 316"],
      ["a different finish", { finish: "ANODIZE, BLACK, TYPE II" }, "finish", "ANODIZE, BLACK, TYPE II"],
    ] as const)("reads %s from its own cell", async (_name, options, field, expected) => {
      const { extraction } = await extract(options);
      expect(extraction[field].raw).toBe(expected);
      expect(extraction.partNumber).toBe(DEFAULTS.drawingNumber);
      expect(extraction.revision).toBe(DEFAULTS.revision);
    });

    it("leaves the material empty and flagged when the MATERIAL cell is empty, not the TITLE text", async () => {
      const { extraction, missing } = await extract({ material: null });
      expect(extraction.material.raw).toBeNull();
      expect(extraction.material.reviewNeeded).toBe(true);
      expect(extraction.reviewFields).toContain("material");
      expect(missing).toContain("material");
      expect(extraction.status).toBe("needs_review");
      expect(extraction.finish.raw).toBe(DEFAULTS.finish);
    });

    it("leaves the finish empty and flagged when the FINISH cell is empty, not the SURFACE FINISH or plating note", async () => {
      const { extraction, missing } = await extract({ finish: null });
      expect(extraction.finish.raw).toBeNull();
      expect(extraction.finish.reviewNeeded).toBe(true);
      expect(extraction.reviewFields).toContain("finish");
      expect(missing).toContain("finish");
      expect(extraction.quoteFinish).toBeNull();
      expect(extraction.material.raw).toBe(DEFAULTS.material);
    });

    it("leaves the part number and revision flagged, not filled, when their cells are empty", async () => {
      const { extraction, missing } = await extract({ drawingNumber: "", revision: "" });
      expect(extraction.revision).toBeNull();
      expect(extraction.partNumber).toBe("UPLOAD");
      expect(extraction.reviewFields).toEqual(expect.arrayContaining(["partNumber", "revision"]));
      expect(missing).toContain("revision");
      expect(extraction.status).toBe("needs_review");
    });
  });

  describe("the approvals block beside the label row", () => {
    const TOKENS = ["Q.A.", "CHECKED", "DRAWN", "APPROVED", "ENG", "MFG", "ENG APPR.", "QA APPR."];

    it("reads the real cells with approvals labels on the line under the SIZE / DWG. NO. / REV labels", async () => {
      const { extraction } = await extract({
        underLabelRow: [[150, "ENG"], [160, "MFG"], [170, "APPROVED"], [184, "DRAWN"], [195, "Q.A."], [205, "CHECKED"]],
      });
      expectDefaultFields(extraction);
      expect(extraction.reviewFields).toEqual([]);
    });

    it.each(TOKENS)("reports %s as neither the part number nor the revision when the real cells hold it", async (token) => {
      const { extraction } = await extract({ drawingNumber: token, revision: token });
      expect(extraction.partNumber).not.toBe(token);
      expect(extraction.revision).not.toBe(token);
      expect(extraction.reviewFields).toEqual(expect.arrayContaining(["partNumber", "revision"]));
      expect(extraction.status).toBe("needs_review");
    });
  });

  describe("units, standard edition, table and notes", () => {
    it.each(["ASME Y14.5M-1994", "ASME Y14.5M-2009", "ASME Y14.5M-2018", "ASME Y14.5-2018"])(
      "reads the same fields and tolerance with %s",
      async (standard) => {
        const { extraction, stored } = await extract({ standard });
        expectDefaultFields(extraction);
        expect(stored.tolerances.valueInch).toBe(0.005);
      },
    );

    it("reads the same fields and tolerance with the inspection notes off", async () => {
      const { extraction, stored } = await extract({ inspectionNotes: false });
      expectDefaultFields(extraction);
      expect(stored.tolerances.valueInch).toBe(0.005);
    });

    it("reads the same tolerance with and without the four-place row", async () => {
      const withRow = (await extract({ fourPlaceRow: true })).stored.tolerances;
      const withoutRow = (await extract({ fourPlaceRow: false })).stored.tolerances;
      expect(withRow).toEqual(withoutRow);
      expect(withRow.valueInch).toBe(0.005);
    });

    it.each([
      ["two and three places", "two_and_three_places", 0.005],
      ["two places only", "two_places", 0.01],
      ["a dimension with four places", "four_places", 0.001],
    ] as const)("applies the rows for the places the dimensions use: %s", async (_name, dimensions, valueInch) => {
      const { stored } = await extract({ dimensions });
      expect(stored.tolerances.valueInch).toBe(valueInch);
    });

    // The rows are dropped only on positive evidence. A dimension printed on the same layout line as a note
    // (pdftotext puts text at the same height on one line, however far apart) is still a dimension.
    describe("a dimension that shares its layout line with a note", () => {
      const NOTES = [
        "SURFACE FINISH: SEE NOTE",
        "SCALE: 1:1",
        "TOLERANCES:",
        "UNLESS OTHERWISE SPECIFIED:",
        "SHEET 1 OF 1",
        "FITS PER ISO 286 UNLESS NOTED",
        "WEIGHT: 0.5",
      ];
      // Appends `note` to the one layout line that contains `needle`, after `gap` spaces.
      const withNote = (sheet: string, needle: string, note: string, gap: number) => {
        const lines = sheet.split("\n");
        const matches = lines.flatMap((line, index) => (line.includes(needle) ? [index] : []));
        expect(matches).toHaveLength(1);
        lines[matches[0]!] = `${lines[matches[0]!]}${" ".repeat(gap)}${note}`;
        return lines.join("\n");
      };

      it.each(NOTES.flatMap((note) => [40, 80].map((gap) => [note, gap] as const)))(
        "keeps the four-place row for a .0625 dimension followed by %s after %i spaces",
        async (note, gap) => {
          const { extraction, stored } = await extractSheet(
            withNote(titleBlockTemplateSheet({ dimensions: "four_places" }), ".0625 THRU", note, gap),
          );
          expect(stored.tolerances.valueInch).toBe(0.001);
          expectDefaultFields(extraction);
        },
      );

      it.each(NOTES.flatMap((note) => [40, 80].map((gap) => [note, gap] as const)))(
        "still drops the four-place row for a .140 dimension followed by %s after %i spaces",
        async (note, gap) => {
          const sheet = withNote(titleBlockTemplateSheet({ dimensions: "two_and_three_places" }), ".190 THRU", note, gap);
          const { stored } = await extractSheet(sheet);
          expect(stored.tolerances.valueInch).toBe(0.005);
        },
      );

      it("keeps the four-place row when the four-place dimension is the only one glued to its callout", async () => {
        const { stored } = await extractSheet(
          withNote(titleBlockTemplateSheet({ dimensions: "four_places" }), ".0625 THRU", "SURFACE FINISH: SEE NOTE", 80).replace(
            ".0625 THRU",
            "SR.0625   ",
          ),
        );
        expect(stored.tolerances.valueInch).toBe(0.001);
      });

      it("keeps a three-place edge note's row when the dimensions have two places", async () => {
        const sheet = titleBlockTemplateSheet({ dimensions: "two_places" }).replace("SAMPLE EDGE NOTE", 'BREAK EDGES .020" MAX');
        expect((await extractSheet(sheet)).stored.tolerances.valueInch).toBe(0.005);
      });
    });

    it("leaves the tolerance unresolved, with the four-place value kept, when no dimension can be read", async () => {
      const { stored, missing } = await extract({ dimensions: "none" });
      expect(stored.tolerances).toMatchObject({ tightest: "±0.001", valueInch: null, unit: "unknown" });
      expect(missing).toContain("tightestToleranceInch");
    });

    it("reads the same tolerance without a four-place row even when no dimension can be read", async () => {
      const { stored } = await extract({ dimensions: "none", fourPlaceRow: false });
      expect(stored.tolerances.valueInch).toBe(0.005);
    });

    it("reads the table values as millimetres when the drawing declares millimetres, never as inches", async () => {
      const { extraction, stored } = await extract({ units: "DIMENSIONS ARE IN MILLIMETERS" });
      expectDefaultFields(extraction);
      // THREE PLACE DECIMAL .005 mm is 0.000197 in, stored floored to 0.0001; 0.005 would be wrong.
      expect(stored.tolerances).toMatchObject({ tightest: "±0.005 mm", valueInch: 0.0001, unit: "mm", drawingUnits: "metric" });
    });

    it("leaves the tolerance unresolved when the drawing declares no units", async () => {
      const { stored, missing } = await extract({ units: null });
      expect(stored.tolerances.valueInch).toBeNull();
      expect(stored.tolerances.unit).toBe("unknown");
      expect(missing).toContain("tightestToleranceInch");
    });

    it("leaves the tolerance unresolved when the drawing declares both inches and millimetres", async () => {
      const { stored } = await extract({ units: "DIMENSIONS IN INCHES [MILLIMETERS]" });
      expect(stored.tolerances.valueInch).toBeNull();
      expect(stored.tolerances.drawingUnits).toBe("mixed");
    });
  });

  describe("export control notes", () => {
    it("has no export-control marking in the sheet as printed", () => {
      expect(detectExportControlMarkings(titleBlockTemplateSheet())).toEqual([]);
    });

    it.each([
      ["ITAR CONTROLLED", ["itar"]],
      ["EAR 99", ["ear"]],
      ["EXPORT CONTROLLED TECHNICAL DATA", ["export_controlled", "technical_data"]],
      ["EAR99", []],
    ])("keeps the scanner's answer for the note %s, and the fields read the same", async (note, markings) => {
      const sheet = titleBlockTemplateSheet({ notice: [note] });
      expect(detectExportControlMarkings(sheet)).toEqual(markings);
      const { extraction } = await extractSheet(sheet);
      expectDefaultFields(extraction);
    });
  });

  describe("poppler lays the same page out with other character cells", () => {
    // Other poppler versions place the same text at other columns (every piece of text at its column times
    // the factor, text widths unchanged). The cells stay in the same order and aligned, so the pairing must
    // not depend on exact columns, within the reach a value may start from its label (LAYOUT_REACH).
    it.each([0.75, 0.9, 1.1, 1.25, 1.5])("reads the same fields with the layout scaled by %s", async (factor) => {
      const { extraction, stored } = await extractSheet(stretchColumns(titleBlockTemplateSheet(), factor));
      expectDefaultFields(extraction);
      expect(extraction.reviewFields).toEqual([]);
      expect(stored.tolerances.valueInch).toBe(0.005);
    });

    // A compression no poppler version produces (the text no longer fits its cell), and a stretch past the
    // reach a value may start from its label: a field may be lost, but never replaced by another cell's
    // text without a review flag.
    it.each([0.3, 0.45, 0.6, 0.7, 2, 3])("never reports a wrong value without a review flag when squeezed to %s", async (factor) => {
      const { extraction } = await extractSheet(stretchColumns(titleBlockTemplateSheet(), factor));
      const read: Record<string, string | null> = {
        partNumber: extraction.partNumber,
        revision: extraction.revision,
        material: extraction.material.raw,
        finish: extraction.finish.raw,
      };
      const truth: Record<string, string> = {
        partNumber: DEFAULTS.drawingNumber,
        revision: DEFAULTS.revision,
        material: DEFAULTS.material,
        finish: DEFAULTS.finish,
      };
      for (const field of Object.keys(truth)) {
        if (read[field] !== truth[field]) {
          expect(extraction.reviewFields, `${field} read as ${read[field]}`).toContain(field);
        }
      }
    });
  });
});
