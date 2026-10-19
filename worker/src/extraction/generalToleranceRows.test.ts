// @vitest-environment node
//
// OVD-989: which rows of a general-tolerance table apply. A table of "TWO / THREE / FOUR PLACE DECIMAL" rows
// is a default for dimensions printed with that many decimal places, so a row applies only when a dimension
// on the sheet is printed that way. A common SolidWorks template always prints a four-place row (.0010) even
// when no dimension uses four places; the tightest tolerance that applies is then the three-place row, .005.
//
// The rule (pdfDrawing.ts, T1 to T3):
//   T1/T2  dimension text is read from lines that hold only dimension callouts; with at least three such
//          numbers on a text layer, a row whose places no dimension uses is dropped;
//   T3     when that cannot be read (OCR, no dimensions, a line too long to scan), a row of four or more
//          places is not assumed in force: it is an unresolved value (valueInch null unless a tighter explicit
//          tolerance exists, so the OVD-683 beta gate asks the user). Rows of one to three places are read as
//          before.
// Explicit tolerances on features (a plus-minus value that is not a table row) are never dropped, and the
// OVD-976 unit policy is untouched. No model, no network, no poppler.

import { describe, expect, it } from "vitest";
import { pdfTextOf } from "../../test-support/titleBlockSheet";
import { inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";

const INCHES = "DIMENSIONS ARE IN INCHES";
const ROWS = ["TWO PLACE DECIMAL .01", "THREE PLACE DECIMAL .005", "FOUR PLACE DECIMAL .0010"];
// Five decimal numbers on dimension-only lines: two with two places, three with three.
const DIMENSIONS_2_AND_3 = [".18", ".656 THRU    2X    .089 THRU", "      .75", "1.653", "R.50"];
const DIMENSIONS_2_ONLY = [".18", ".75", "1.25", "2.50"];

function toleranceOf(
  lines: string[],
  options: { ocr?: boolean; pdfText?: PdfTextExtraction } = {},
) {
  const signals = inferDrawingSignalsFromPdf({
    baseName: "upload",
    pdfText: options.pdfText ?? pdfTextOf(["MATERIAL 6061-T6", ...lines].join("\n"), { ocr: options.ocr }),
  });
  return {
    raw: signals.tightestTolerance,
    valueInch: signals.tightestToleranceValueInch ?? null,
    unit: signals.tightestToleranceUnit ?? null,
    drawingUnits: signals.tightestToleranceDrawingUnits ?? null,
  };
}

describe("general tolerance rows (OVD-989)", () => {
  describe("a row applies only to the places the dimensions use", () => {
    it("drops the four-place row when no dimension uses four places", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS])).toEqual({
        raw: "±0.005",
        valueInch: 0.005,
        unit: "in",
        drawingUnits: "inch",
      });
    });

    it("keeps the four-place row when a dimension is printed with four places", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, "Ø.0625 THRU", INCHES, ...ROWS])).toMatchObject({
        raw: "±0.001",
        valueInch: 0.001,
        unit: "in",
      });
    });

    it("reads the same value with and without the four-place row on the sheet", () => {
      const withRow = toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS]);
      const withoutRow = toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS.slice(0, 2)]);
      expect(withRow).toEqual(withoutRow);
    });

    it("drops the three-place row too when every dimension has two places", () => {
      expect(toleranceOf([...DIMENSIONS_2_ONLY, INCHES, ...ROWS])).toMatchObject({ raw: "±0.01", valueInch: 0.01 });
    });

    it.each([
      ["with plus-minus signs", ["TWO PLACE DECIMAL ±.01", "THREE PLACE DECIMAL ±.005", "FOUR PLACE DECIMAL ±.0010"]],
      ["with +/-", ["TWO PLACE DECIMAL +/-.01", "THREE PLACE DECIMAL +/-.005", "FOUR PLACE DECIMAL +/-.0010"]],
      ["written .X", [".X ±.1", ".XX ±.01", ".XXX ±.005", ".XXXX ±.0010"]],
      ["written X.XXXX", ["X.X ±.1", "X.XX ±.01", "X.XXX ±.005", "X.XXXX ±.0010"]],
    ])("drops the four-place row written %s", (_name, rows) => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...rows])).toMatchObject({ valueInch: 0.005 });
    });

    it.each([
      ["with plus-minus signs", ["THREE PLACE DECIMAL ±.005", "FOUR PLACE DECIMAL ±.0010"]],
      ["written .XXXX", [".XXX ±.005", ".XXXX ±.0010"]],
    ])("keeps the four-place row written %s when a dimension uses four places", (_name, rows) => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, ".1875", INCHES, ...rows])).toMatchObject({ valueInch: 0.001 });
    });

    it("always keeps an explicit tolerance on a feature, whatever the table says", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS, "BORE ±.0005"])).toMatchObject({ valueInch: 0.0005 });
      // Even one tighter than every row that applies, with the four-place row dropped.
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS, "BORE ±.002"])).toMatchObject({ valueInch: 0.002 });
    });

    it("reads the dimensions from any page", () => {
      const pdfText: PdfTextExtraction = {
        pageCount: 2,
        pageCountKnown: true,
        drawingFullyRead: true,
        ocr: false,
        pages: [
          { page: 1, text: ["MATERIAL 6061-T6", INCHES, ...ROWS].join("\n"), ocrText: "", ocrStatus: "ok" },
          { page: 2, text: DIMENSIONS_2_AND_3.join("\n"), ocrText: "", ocrStatus: "ok" },
        ],
      };
      expect(toleranceOf([], { pdfText })).toMatchObject({ valueInch: 0.005 });
    });
  });

  describe("what is not a dimension", () => {
    it.each([
      ["a weight with four places", "SCALE: 1:1    WEIGHT: 0.0724    SHEET 1 OF 1"],
      ["the ASME Y14.5 edition", "INTERPRET IN ACCORDANCE WITH:   ASME Y14.5M-2009"],
      ["an edge-break note", 'BREAK SHARP EDGES .0050" MAX'],
      ["a surface finish", "SURFACE FINISH: Ra 0.0625"],
      ["the angular row", "ANGULAR: MACH 0.5000"],
    ])("does not let %s keep the four-place row", (_name, line) => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS, line])).toMatchObject({ valueInch: 0.005 });
    });

    it("does not count a conversion note as a dimension", () => {
      // "25.4" is one place and is on a line with words: with only two real dimensions the sheet is not readable.
      expect(toleranceOf([".18", ".75", "NOTE: 1 INCH = 25.4", INCHES, ...ROWS])).toMatchObject({
        raw: "±0.001",
        valueInch: null,
        unit: "unknown",
      });
    });

    it("keeps the four-place row when an unclassified note prints a four-place number", () => {
      // A feature note is not a title-block line, so it counts as evidence: the row stays (the safe side).
      expect(toleranceOf([...DIMENSIONS_2_AND_3, "FLATNESS .0005", INCHES, ...ROWS])).toMatchObject({ valueInch: 0.001 });
      expect(toleranceOf([...DIMENSIONS_2_AND_3, "HOLE SPACING 1.2500 REF", INCHES, ...ROWS])).toMatchObject({ valueInch: 0.001 });
    });
  });

  describe("when the sheet cannot be read, a four-place row is not assumed in force", () => {
    it("leaves the tolerance unresolved on an OCR text layer, with the row's value kept for the user", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS], { ocr: true })).toEqual({
        raw: "±0.001",
        valueInch: null,
        unit: "unknown",
        drawingUnits: "inch",
      });
    });

    it("leaves the tolerance unresolved when fewer than three dimensions can be read", () => {
      expect(toleranceOf([".18", ".75", INCHES, ...ROWS])).toMatchObject({ valueInch: null, unit: "unknown" });
      expect(toleranceOf([INCHES, ...ROWS])).toMatchObject({ valueInch: null, unit: "unknown" });
    });

    it("leaves the tolerance unresolved when a line is too long to scan", () => {
      const longLine = `${".5 ".repeat(1_000)}.5`;
      expect(toleranceOf([...DIMENSIONS_2_AND_3, longLine, INCHES, ...ROWS])).toMatchObject({
        valueInch: null,
        unit: "unknown",
      });
    });

    it("still reads a table without a four-place row as before (the tightest printed row)", () => {
      expect(toleranceOf([INCHES, ...ROWS.slice(0, 2)])).toMatchObject({ raw: "±0.005", valueInch: 0.005 });
      expect(toleranceOf([INCHES, ...ROWS.slice(0, 2)], { ocr: true })).toMatchObject({ valueInch: 0.005 });
    });

    it("keeps an explicit tolerance that is tighter than the unresolved row", () => {
      expect(toleranceOf([INCHES, ...ROWS, "BORE ±.0005"], { ocr: true })).toMatchObject({ valueInch: 0.0005 });
    });

    it("ignores the unresolved row when every reading of it is looser than an explicit tolerance", () => {
      expect(toleranceOf([INCHES, "FOUR PLACE DECIMAL .0010", "BORE ±.0005"], { ocr: true })).toMatchObject({
        valueInch: 0.0005,
      });
    });
  });

  describe("a metric table whose plus-minus sign is not in the text layer", () => {
    // The sign is a symbol-font glyph that pdftotext does not print: "X.XX 0.10" is "X.XX ±0.10".
    const MM = "DIMENSIONS ARE IN MILLIMETERS";
    const METRIC_ROWS = ["TOLERANCES:", "ANGULAR: 0.5", "LINEAR: X.X 0.3", "X.XX 0.10", "X.XXX 0.030", "X.XXXX 0.0100"];
    const METRIC_DIMENSIONS_2_PLACES = ["4.49", "16.67 THRU", "2X 2.26 THRU", "19.05", "R12.7", "9.77", "42"];

    it("reads the row for the places the dimensions use, in millimetres", () => {
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, MM, ...METRIC_ROWS])).toEqual({
        raw: "±0.1 mm",
        valueInch: 0.0039,
        unit: "mm",
        drawingUnits: "metric",
      });
    });

    it("reads the finer row when a dimension uses its places", () => {
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, "3.175 THRU", MM, ...METRIC_ROWS])).toMatchObject({
        raw: "±0.03 mm",
        valueInch: 0.0011,
      });
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, "3.1750 THRU", MM, ...METRIC_ROWS])).toMatchObject({
        raw: "±0.01 mm",
        valueInch: 0.0003,
      });
    });

    it("does not count the table's own values as dimensions", () => {
      // 0.0100, 0.030 and 0.10 have four, three and two places; they are the table, not features. With
      // one-place dimensions only, the X.X row (0.3 mm) is the one that applies.
      expect(toleranceOf([".5", ".6", ".7", MM, ...METRIC_ROWS])).toMatchObject({ raw: "±0.3 mm", valueInch: 0.0118 });
    });

    it("leaves a four-place row unresolved when the sheet cannot be read", () => {
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, MM, ...METRIC_ROWS], { ocr: true })).toMatchObject({
        valueInch: null,
        unit: "unknown",
      });
    });

    it("does not read a row that has a sign twice", () => {
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, MM, "X.XX ±0.10", "X.XXX ±0.030"])).toMatchObject({ raw: "±0.1 mm" });
    });

    it("is not confused by the percentage in a humidity note", () => {
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, MM, ...METRIC_ROWS, "30% ±10% RH", "72°F ±3°F"])).toMatchObject({
        valueInch: 0.0039,
      });
    });
  });

  describe("units (OVD-976) are unchanged", () => {
    it("reads the rows as millimetres on a millimetre drawing", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, "DIMENSIONS ARE IN MILLIMETERS", ...ROWS])).toEqual({
        raw: "±0.005 mm",
        valueInch: 0.0001,
        unit: "mm",
        drawingUnits: "metric",
      });
    });

    it("leaves the tolerance unresolved when the drawing declares both systems", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, "DIMENSIONS IN INCHES [MILLIMETERS]", ...ROWS])).toMatchObject({
        valueInch: null,
        drawingUnits: "mixed",
      });
    });

    it("leaves the tolerance unresolved when no units are declared and a row has two decimals", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, ...ROWS])).toMatchObject({ valueInch: null, unit: "unknown", drawingUnits: "unspecified" });
    });
  });

  describe("hostile text", () => {
    it("scans a very long line of decimals once and stays fast", () => {
      const started = Date.now();
      const result = toleranceOf([`${"1.5 ".repeat(100_000)}`, INCHES, ...ROWS]);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.valueInch).toBeNull();
    });

    it("scans many short lines of decimals and stays fast", () => {
      const lines = Array.from({ length: 50_000 }, () => ".125 THRU");
      const started = Date.now();
      const result = toleranceOf([...lines, INCHES, ...ROWS]);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.valueInch).toBe(0.005);
    });
  });
});
