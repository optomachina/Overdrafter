// @vitest-environment node
//
// OVD-989: which rows of a general-tolerance table apply. A table of "TWO / THREE / FOUR PLACE DECIMAL" rows
// is a default for dimensions printed with that many decimal places, so a row applies only when a dimension
// on the sheet is printed that way. A common CAD template prints a four-place row (.0010) even when no
// dimension uses four places; the tightest tolerance that applies is then the three-place row, .005.
//
// The rule (pdfDrawing.ts, T1 to T3):
//   T1     the sheet is readable when its text layer is not OCR, no line is too long to scan, and at least
//          three decimal numbers sit on lines that hold only dimension callouts;
//   T2     on a readable sheet a row is dropped only when EVERY other decimal number printed anywhere in the
//          text has fewer places than the row. Nothing is skipped: not a whole line, not a number with a
//          letter or symbol glued to it (Ø.1875, n.1875, SR.0625, .1875A, 1.2500). Only the values of the
//          table's own rows are left out. A number that is not a dimension (a weight, an edge-break note)
//          therefore keeps a row: the tighter value is the safe error;
//   T3     when the sheet cannot be read (OCR, too few dimensions, a line too long to scan), a row of four or
//          more places is not assumed in force: it is an unresolved value (valueInch null unless a tighter
//          explicit tolerance exists, so the OVD-683 beta gate asks the user). Rows of one to three places
//          are read as before.
// Explicit tolerances on features (a plus-minus value that is not a table row) are never dropped, and the
// OVD-976 unit policy is untouched. No model, no network, no poppler (generalToleranceRowsPdf.test.ts runs
// the same shapes through poppler when it is installed).

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
    it("does not let the ASME Y14.5 edition keep the four-place row", () => {
      // "14.5" has one place and "2009" is no decimal number.
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS, "INTERPRET IN ACCORDANCE WITH:   ASME Y14.5M-2009"])).toMatchObject({
        valueInch: 0.005,
      });
    });

    // A deliberate change from the first version of this rule, which skipped whole lines it took for notes
    // (a weight, an edge break, a surface finish, the angular row). A skipped line can hide a real
    // dimension that shares it, and a missed four-place dimension reads a LOOSER tolerance than the part
    // has. Only the table's own values are left out; any other number with that many places keeps the row,
    // which is the safe error (tighter, never looser).
    it.each([
      ["a weight with four places", "SCALE: 1:1    WEIGHT: 0.0831    SHEET 1 OF 1"],
      ["an edge-break note", 'BREAK SHARP EDGES .0050" MAX'],
      ["a surface finish", "SURFACE FINISH: Ra 0.0625"],
      ["the angular row", "ANGULAR: MACH 0.5000"],
    ])("keeps the four-place row when %s prints a four-place number", (_name, line) => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS, line])).toMatchObject({ valueInch: 0.001 });
    });

    it("keeps the three-place row when only a note prints three places and every dimension has two", () => {
      expect(toleranceOf([...DIMENSIONS_2_ONLY, INCHES, ...ROWS, 'BREAK SHARP EDGES .020" MAX'])).toMatchObject({ valueInch: 0.005 });
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
      expect(toleranceOf([...DIMENSIONS_2_AND_3, "FLATNESS .0005", INCHES, ...ROWS])).toMatchObject({ valueInch: 0.001 });
      expect(toleranceOf([...DIMENSIONS_2_AND_3, "HOLE SPACING 1.7500 REF", INCHES, ...ROWS])).toMatchObject({ valueInch: 0.001 });
    });
  });

  // OVD-989 repair round 1: a four-place dimension must keep the four-place row wherever it is printed. The
  // first version only counted places on lines that hold nothing but callouts and skipped any line that
  // mentioned a note word, so each of these read 0.005 on a part with a 0.001 dimension.
  describe("a four-place dimension keeps the four-place row wherever it is printed", () => {
    const apart = (left: string, right: string, gap = 40) => `${left}${" ".repeat(gap)}${right}`;

    it.each([
      ["a surface finish note on the same line", apart("    Ø.1875 THRU", "SURFACE FINISH: 63")],
      ["a view label on the same line", apart("    .2500", "SECTION A-A SCALE 2 : 1")],
      ["a general-tolerance row on the same line", apart("    .3125", "ONE PLACE DECIMAL ±.1")],
      ["the scale and sheet cells on the same line", apart("  2X .1250", "SCALE: 1:1  WEIGHT: 0.5  SHEET 1 OF 1")],
      ["a table row without a sign on the same line", apart("    .1875", "THREE PLACE DECIMAL .005")],
      ["the tolerances label on the same line", apart("    .1875", "TOLERANCES:")],
      ["the unless-otherwise-specified label on the same line", apart("  0.1875", "UNLESS OTHERWISE SPECIFIED:")],
      ["an ISO-style note on the same line", apart("    .3750 THRU", "FITS PER ISO 286 UNLESS NOTED")],
      ["a sheet cell on the same line", apart("    .0625 THRU", "SHEET 1 OF 1")],
    ])("reads a four-place dimension beside %s", (_name, line) => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, line, INCHES, ...ROWS])).toMatchObject({ valueInch: 0.001 });
      expect(toleranceOf([...DIMENSIONS_2_AND_3, line.replace(/ {40}/, " ".repeat(80)), INCHES, ...ROWS])).toMatchObject({
        valueInch: 0.001,
      });
    });

    it.each([
      ["a spherical radius", "SR.0625"],
      ["a diameter whose symbol font prints as a letter", "2X n.1875 THRU"],
      ["a datum or hole tag glued after the number", ".1875A"],
      ["the THRU word glued after the number", ".1875THRU"],
      ["a letter glued before the number", "A.1875"],
      ["a radius", "R.0625"],
      ["an inch mark", '.1875"'],
      ["a number with a whole part", "1.2500"],
      ["a diameter and a counterbore symbol", "⌴Ø.3125 ↧.1250"],
      ["a leading zero", "0.1875 DIA"],
      ["a note that names an ISO standard", "BORE .3750 PER ISO 286"],
      ["a comma decimal", "Ø,1875"],
    ])("reads %s", (_name, line) => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, line, INCHES, ...ROWS])).toMatchObject({ valueInch: 0.001 });
    });

    it("reads a four-place number in a hole table whose header has note words", () => {
      expect(
        toleranceOf([...DIMENSIONS_2_AND_3, "HOLE  X LOC   Y LOC   SIZE", "A1    .1250   .2500   Ø.1875", INCHES, ...ROWS]),
      ).toMatchObject({ valueInch: 0.001 });
    });

    it("does not drop the row when two four-place numbers share one line with the table", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, apart(".1875  .3125", "FOUR PLACE DECIMAL .0010"), INCHES, ...ROWS.slice(0, 2)])).toMatchObject({
        valueInch: 0.001,
      });
    });

    it("still drops the row when the same notes carry no four-place number", () => {
      const notes = [
        apart("    .18", "SURFACE FINISH: 63"),
        apart("    .75", "SCALE: 1:1  SHEET 1 OF 1"),
        apart("    .250", "FITS PER ISO 286 UNLESS NOTED"),
      ];
      expect(toleranceOf([...DIMENSIONS_2_AND_3, ...notes, INCHES, ...ROWS])).toMatchObject({ valueInch: 0.005 });
    });

    it("leaves the tolerance unresolved when the only dimensions share their lines with notes", () => {
      // Nothing proves the sheet was read, so a four-place row is not assumed in force and is not dropped.
      const shared = [".18", ".75", ".250", ".500", "1.25"].map((dimension) => apart(`    ${dimension}`, "SURFACE FINISH: 63"));
      expect(toleranceOf([...shared, INCHES, ...ROWS])).toMatchObject({ raw: "±0.001", valueInch: null, unit: "unknown" });
    });

    it("keeps the four-place row when the four-place number is the table's own text on another page", () => {
      const pdfText: PdfTextExtraction = {
        pageCount: 2,
        pageCountKnown: true,
        drawingFullyRead: true,
        ocr: false,
        pages: [
          { page: 1, text: ["MATERIAL 6061-T6", INCHES, ...ROWS, ...DIMENSIONS_2_AND_3].join("\n"), ocrText: "", ocrStatus: "ok" },
          { page: 2, text: apart("  .1875 THRU", "SURFACE FINISH: 63"), ocrText: "", ocrStatus: "ok" },
        ],
      };
      expect(toleranceOf([], { pdfText })).toMatchObject({ valueInch: 0.001 });
    });

    it("counts the table's own values only once: the row does not prove itself", () => {
      // ".0010" belongs to the row; with only two- and three-place dimensions, it must not keep itself.
      expect(toleranceOf([...DIMENSIONS_2_AND_3, INCHES, ...ROWS])).toMatchObject({ valueInch: 0.005 });
      // A second ".0010" outside the table is a real number with four places.
      expect(toleranceOf([...DIMENSIONS_2_AND_3, "CLEARANCE .0010", INCHES, ...ROWS])).toMatchObject({ valueInch: 0.001 });
    });

    // Angular dimensions with two places count as evidence of two places: a safe, tighter error.
    it("reads angular dimensions with two places as evidence of two places", () => {
      const lines = ["2.5", "1.5", "3.5", "45.00°", "30.00°", INCHES, "ONE PLACE DECIMAL ±.05", ...ROWS];
      expect(toleranceOf(lines)).toMatchObject({ valueInch: 0.01 });
    });

    // Known limits that the first version of the rule shared with main: a limit dimension (".5005/.5000") and an
    // unequal bilateral tolerance ("+.0005/-.0000") are not read as an explicit tolerance of their own, so a
    // part whose tightest tolerance is one of those reads the table value. Not changed by OVD-989.
    it.fails("reads a limit dimension as a tolerance", () => {
      expect(toleranceOf([...DIMENSIONS_2_AND_3, ".5005/.5000  RA 32", INCHES, ...ROWS])).toMatchObject({ valueInch: 0.0005 });
    });

    it.fails("reads an unequal bilateral tolerance", () => {
      expect(toleranceOf([".18", ".75", "1.25", "2.50", "Ø.500 +.0005/-.0000", INCHES, ...ROWS])).toMatchObject({ valueInch: 0.0005 });
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

    it("reads dimension lines that carry hole tags or zone letters (A to H, or a letter and digits)", () => {
      const tagged = [".18 A", ".75 B", "1.653 C1", "R.50 H"];
      expect(toleranceOf([...tagged, INCHES, ...ROWS])).toMatchObject({ valueInch: 0.005 });
    });

    it("does not read a line with any other capital letter as a dimension line", () => {
      // The same four numbers with a letter that is no tag: nothing proves the dimensions were read.
      const lettered = [".18 Z", ".75 Z", "1.653 Z", "R.50 Z"];
      expect(toleranceOf([...lettered, INCHES, ...ROWS])).toMatchObject({ valueInch: null, unit: "unknown" });
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

    it.each([
      ["an ISO 2768 note", "GENERAL TOLERANCES ISO 2768-m"],
      ["a surface finish note", "SURFACE FINISH: 63"],
      ["the scale and sheet cells", "SCALE: 1:1  SHEET 1 OF 1"],
    ])("reads a three-place dimension that shares its line with %s", (_name, note) => {
      // The first version skipped the whole line and read the 0.1 mm row for a part with a 3.175 feature.
      const line = `${"   3.175 THRU".padEnd(60)}${note}`;
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, line, MM, ...METRIC_ROWS])).toMatchObject({
        raw: "±0.03 mm",
        valueInch: 0.0011,
      });
    });

    it("reads a four-place dimension that shares its line with a note on a millimetre drawing", () => {
      const line = `${"   3.1750 THRU".padEnd(60)}SURFACE FINISH: 63`;
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, line, MM, ...METRIC_ROWS])).toMatchObject({
        raw: "±0.01 mm",
        valueInch: 0.0003,
      });
    });

    it("keeps a glued millimetre dimension with four places", () => {
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, "SR3.1750", MM, ...METRIC_ROWS])).toMatchObject({ valueInch: 0.0003 });
    });

    it("does not count the table's own values, with or without a sign, as dimensions", () => {
      expect(toleranceOf([...METRIC_DIMENSIONS_2_PLACES, MM, "X.XX ±0.10", "X.XXX ±0.030", "X.XXXX ±0.0100"])).toMatchObject({
        raw: "±0.1 mm",
      });
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

    // The evidence scan runs on every line of up to 2,000 characters once a table row exists. Shapes that
    // a backtracking pattern would split in as many ways as the line has characters: a long run of digits
    // that is not a number ("111...1x"), a long run of digits without a decimal separator, long glued
    // tokens, and many decimals on one line.
    const bigLines = (line: string, count: number) => Array.from({ length: count }, () => line);
    const HOSTILE_LINES: Array<[string, string]> = [
      ["1,990 digits and a letter", `${"1".repeat(1_990)}x`],
      ["1,990 digits", "1".repeat(1_990)],
      ["1,990 digits, a dot and a letter", `${"1".repeat(1_000)}.${"1".repeat(989)}x`],
      ["990 repeats of a diameter sign and a dot", "Ø.".repeat(990)],
      ["990 repeats of a letter and a dot", "R.".repeat(990)],
      ["decimals and dots", ".1.1.1.1.1.1.".repeat(150)],
      ["400 decimals", "1.25 ".repeat(399)],
      ["a long glued token", `R.${"5".repeat(1_900)}THRU`],
    ];
    // The fastest of a few runs: a loaded machine slows a run down, never speeds it up.
    const timeLines = (line: string, count: number) => {
      const lines = [...DIMENSIONS_2_AND_3, ...bigLines(line, count), INCHES, ...ROWS];
      let result = toleranceOf(lines);
      let ms = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        result = toleranceOf(lines);
        ms = Math.min(ms, performance.now() - started);
      }
      return { ms, result };
    };

    it.each(HOSTILE_LINES)("reads 1,000 lines of %s in well under a second", (_name, line) => {
      expect(line.length).toBeLessThanOrEqual(2_000);
      const { ms, result } = timeLines(line, 1_000);
      expect(ms).toBeLessThan(1_000);
      // Whatever the text, the answer is a tolerance of the sheet, never a crash or a value looser than the rows.
      expect(result.valueInch === null || result.valueInch <= 0.005).toBe(true);
    });

    it.each(HOSTILE_LINES)("takes about 4 times as long for 4 times as many lines of %s", (_name, line) => {
      const small = timeLines(line, 250).ms;
      const large = timeLines(line, 1_000).ms;
      // Linear is about 4. The floor keeps a few milliseconds of noise from deciding the ratio.
      expect(large / Math.max(small, 8)).toBeLessThan(10);
    });
  });
});
