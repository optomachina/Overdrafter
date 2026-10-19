// @vitest-environment node
//
// OVD-989: the title block read from word boxes (`pdftotext -bbox`). `pdftotext -layout` puts every character
// in one cell, so a word set larger than its neighbours (a 24 pt drawing number beside 9 pt labels) overruns
// its cells and squeezes the words after it against it: "B  ABC-0001 A", with the revision value no longer
// under the REV label. The boxes give every word's true position. These tests build the boxes for such a row
// and the squeezed layout text poppler prints for it, and check that the boxes win, that the squeezed text
// alone is never trusted into a wrong value, and that the geometry code handles poppler's markup.
// No PDF, no poppler, no model.

import { describe, expect, it } from "vitest";
import { bboxMarkup, box, phrase } from "../../test-support/pdfWordBoxes";
import { inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";
import {
  buildWordLines,
  FALLBACK_POINTS_PER_COLUMN,
  MAX_WORDS_PER_PAGE,
  parseBboxWords,
  pointsPerColumn,
  type PdfWord,
} from "./pdfWords";
import { readTitleBlockCells } from "./titleBlockCells";

/** The title row of a template whose drawing number is 24 pt beside 9 pt labels, as word boxes. */
function titleRowWords(options: { number?: string; numberX?: number; revision?: string; extra?: PdfWord[] } = {}): PdfWord[] {
  const number = options.number ?? "ABC-0001";
  return [
    ...phrase("DIMENSIONS APPLY AFTER PLATING", 20, 500),
    ...phrase("DRAWN", 200, 560),
    ...phrase("CHECKED", 200, 580),
    // The label row (9 pt) and, under it, the values (24 pt). Q.A. is the approvals label next to them.
    box("Q.A.", 200, 600),
    box("MATERIAL", 20, 600),
    box("SIZE", 300, 600),
    ...phrase("DWG. NO.", 325, 600),
    box("REV", 500, 600),
    box("B", 300, 615, 24),
    box(number, options.numberX ?? 325, 615, 24),
    box(options.revision ?? "A", 500, 615, 24),
    ...phrase("ALUMINUM 6061-T6", 24, 645),
    box("FINISH", 20, 670),
    ...phrase("AS MACHINED", 24, 700),
    box("SCALE:", 300, 740),
    box("NONE", 335, 740),
    ...phrase("SHEET 1 OF 1", 480, 740),
    ...(options.extra ?? []),
  ];
}

/** The same words with the page scaled by `factor` in both directions: positions, sizes and text widths. */
function scaled(words: readonly PdfWord[], factor: number): PdfWord[] {
  return words.map((word) => ({
    text: word.text,
    xMin: word.xMin * factor,
    yMin: word.yMin * factor,
    xMax: word.xMax * factor,
    yMax: word.yMax * factor,
  }));
}

/** What `pdftotext -layout` prints for that sheet: the 24 pt words overrun their cells, so "A" is squeezed against the number. */
const SQUEEZED_LAYOUT = [
  "DIMENSIONS APPLY AFTER PLATING",
  "                                     DRAWN",
  "                                     CHECKED",
  "MATERIAL                             Q.A.      SIZE DWG. NO.                        REV",
  "                                                B     ABC-0001 A",
  "ALUMINUM 6061-T6",
  "FINISH",
  "AS MACHINED",
  "                                                SCALE: NONE                    SHEET 1 OF 1",
].join("\n");

function pdfTextOf(text: string, words?: PdfWord[]): PdfTextExtraction {
  return {
    pageCount: 1,
    pageCountKnown: true,
    drawingFullyRead: true,
    ocr: false,
    pages: [{ page: 1, text, ocrText: "", ocrStatus: "ok", ...(words ? { words } : {}) }],
  };
}

const infer = (text: string, words?: PdfWord[]) => inferDrawingSignalsFromPdf({ baseName: "upload", pdfText: pdfTextOf(text, words) });

describe("title block from word boxes", () => {
  describe("a 24 pt drawing number beside 9 pt labels", () => {
    it("reads the drawing number, revision, material and finish from where the words are", () => {
      const signals = infer(SQUEEZED_LAYOUT, titleRowWords());
      expect(signals.partNumber).toMatchObject({ value: "ABC-0001", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "A", reviewNeeded: false });
      expect(signals.material).toMatchObject({ value: "ALUMINUM 6061-T6", reviewNeeded: false });
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
      expect(signals.reviewFields).not.toEqual(expect.arrayContaining(["partNumber"]));
      expect(signals.reviewFields).not.toEqual(expect.arrayContaining(["revision"]));
    });

    it("never reports the approvals label Q.A. next to the label row as a value", () => {
      const signals = infer(SQUEEZED_LAYOUT, titleRowWords());
      expect(signals.partNumber.value).not.toBe("Q.A.");
      expect(signals.revision.value).not.toBe("Q.A.");
    });

    it("splits a number that runs right up to the REV cell from the revision value", () => {
      // 10 characters at 24 pt end at x = 497; the revision value starts at x = 500, as the REV label does.
      const signals = infer(SQUEEZED_LAYOUT, titleRowWords({ number: "ABC-0070-3", numberX: 365, revision: "C" }));
      expect(signals.partNumber).toMatchObject({ value: "ABC-0070-3", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "C", reviewNeeded: false });
    });

    it("reads a two-character revision and a longer number", () => {
      const signals = infer(SQUEEZED_LAYOUT, titleRowWords({ number: "ABC-0001-LONG", numberX: 325, revision: "02" }));
      expect(signals.partNumber.value).toBe("ABC-0001-LONG");
      expect(signals.revision.value).toBe("02");
    });

    it("keeps SHEET 1 OF 1 out of the revision cell above it", () => {
      const signals = infer(SQUEEZED_LAYOUT, titleRowWords());
      expect(signals.revision).toMatchObject({ value: "A", reviewNeeded: false });
    });
  });

  // The reader measures in columns of 0.4 text heights, so a sheet drawn at another size (a B-size sheet
  // printed to letter, an E-size sheet) is the same sheet. Absolute-point constants read the 24 pt SIZE value
  // as the DWG. NO. value of a half-size sheet.
  describe("a uniformly scaled title block", () => {
    it.each([0.5, 0.647, 0.65, 0.688, 1, 1.5, 2])("reads every field at scale %s", (factor) => {
      const signals = infer(SQUEEZED_LAYOUT, scaled(titleRowWords(), factor));
      expect(signals.partNumber).toMatchObject({ value: "ABC-0001", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "A", reviewNeeded: false });
      expect(signals.material).toMatchObject({ value: "ALUMINUM 6061-T6", reviewNeeded: false });
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
    });

    it.each([0.5, 0.65, 1, 2])("keeps the SIZE value out of the drawing number at scale %s", (factor) => {
      const words = scaled(titleRowWords(), factor);
      const cells = readTitleBlockCells(buildWordLines(words, 1));
      expect(cells.find((cell) => cell.field === "partNumber")).toMatchObject({ status: "value", value: "ABC-0001" });
    });

    it("measures columns in text heights: the same sheet at two sizes has the same columns", () => {
      const full = buildWordLines(titleRowWords(), 1);
      const half = buildWordLines(scaled(titleRowWords(), 0.5), 1);
      expect(half.map((line) => line.raw)).toEqual(full.map((line) => line.raw));
      full.forEach((line, index) => {
        line.words!.forEach((word, position) => {
          expect(half[index]!.words![position]!.x0).toBeCloseTo(word.x0, 6);
        });
      });
    });

    it("takes the column unit from the median text height of the page", () => {
      expect(pointsPerColumn([box("A", 0, 0, 10), box("B", 0, 20, 10), box("C", 0, 40, 30)])).toBeCloseTo(0.4 * 11, 6);
      expect(pointsPerColumn([box("A", 0, 0, 20), box("B", 0, 20, 20)])).toBeCloseTo(0.4 * 22, 6);
      expect(pointsPerColumn([])).toBe(FALLBACK_POINTS_PER_COLUMN);
      expect(pointsPerColumn([{ text: "x", xMin: 0, yMin: 5, xMax: 3, yMax: 5 }])).toBe(FALLBACK_POINTS_PER_COLUMN);
    });
  });

  describe("a rotated page", () => {
    // A letter page with /Rotate 90: poppler prints the page as 612 x 792 but the coordinates of its words
    // run to 772.5 across. Nothing in the reader may take the page size from the markup.
    it("is read from the coordinates of its words, not from the size the markup gives the page", () => {
      const words = scaled(titleRowWords(), 1.3);
      expect(Math.max(...words.map((word) => word.xMax))).toBeGreaterThan(612);
      const parsed = parseBboxWords(bboxMarkup(words, { width: 612, height: 792 }));
      const signals = infer(SQUEEZED_LAYOUT, parsed);
      expect(signals.partNumber).toMatchObject({ value: "ABC-0001", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "A", reviewNeeded: false });
    });
  });

  describe("the layout text alone", () => {
    it("is not read into a wrong part number: the squeezed value is flagged and left for the user", () => {
      const signals = infer(SQUEEZED_LAYOUT);
      expect(signals.partNumber.value).not.toBe("ABC-0001 A");
      expect(signals.partNumber.reviewNeeded).toBe(true);
      expect(signals.revision.value).not.toBe("A");
      expect(signals.revision.value).toBeNull();
      expect(signals.revision.reviewNeeded).toBe(true);
      expect(signals.reviewFields).toEqual(expect.arrayContaining(["partNumber", "revision"]));
      // The cells that were not squeezed still read.
      expect(signals.material.value).toBe("ALUMINUM 6061-T6");
      expect(signals.finish.value).toBe("AS MACHINED");
    });

    it("is read when a page has no word boxes, and when the boxes hold no title block", () => {
      const layoutOnly = infer(SQUEEZED_LAYOUT, undefined);
      const emptyBoxes = infer(SQUEEZED_LAYOUT, [box("NOTHING", 10, 10), box("USEFUL", 80, 10)]);
      for (const signals of [layoutOnly, emptyBoxes]) {
        expect(signals.material.value).toBe("ALUMINUM 6061-T6");
        expect(signals.finish.value).toBe("AS MACHINED");
      }
    });
  });

  describe("parseBboxWords", () => {
    it("reads the words with their boxes and decodes the markup", () => {
      const words = parseBboxWords(
        bboxMarkup([box("DWG.", 10, 20), box("A&B", 50, 20), box("<TYP>", 90, 20), { text: "Né", xMin: 1, yMin: 2, xMax: 3, yMax: 4 }]),
      );
      expect(words.map((word) => word.text)).toEqual(["DWG.", "A&B", "<TYP>", "Né"]);
      expect(words[0]).toMatchObject({ xMin: 10, yMin: 20 });
      expect(words[0]!.xMax).toBeCloseTo(10 + 4 * 9 * 0.55, 3);
    });

    it("decodes numeric entities and ignores markup that is not a word", () => {
      const markup = [
        "<html><body><doc><page>",
        '<word xMin="1.0" yMin="2.0" xMax="30.0" yMax="12.0">&#216;12 &#x00B1;.1</word>',
        '<word xMin="NaN" yMin="2.0" xMax="30.0" yMax="12.0">BAD</word>',
        '<word xMin="40.0" yMin="2.0" xMax="30.0" yMax="12.0">BACKWARDS</word>',
        '<word xMin="1.0" yMin="2.0" xMax="30.0" yMax="12.0">   </word>',
        "<word>no attributes</word>",
        "not markup at all",
        "</page></doc></body></html>",
      ].join("\n");
      expect(parseBboxWords(markup).map((word) => word.text)).toEqual(["Ø12 ±.1"]);
    });

    it("returns no geometry for a page with more words than it will read", () => {
      const one = '<word xMin="1" yMin="2" xMax="3" yMax="4">x</word>';
      const page = (count: number) => `<html><body><doc><page>${one.repeat(count)}</page></doc></body></html>`;
      expect(parseBboxWords(page(MAX_WORDS_PER_PAGE)).length).toBe(MAX_WORDS_PER_PAGE);
      expect(parseBboxWords(page(MAX_WORDS_PER_PAGE + 1))).toEqual([]);
    });
  });

  describe("buildWordLines", () => {
    it("puts the 9 pt labels and the 24 pt values under them on separate lines, top to bottom", () => {
      const lines = buildWordLines(titleRowWords(), 1);
      const texts = lines.map((line) => line.raw.replace(/\s+/g, " "));
      const labelLine = texts.findIndex((text) => text.includes("SIZE DWG. NO. REV"));
      const valueLine = texts.findIndex((text) => text.includes("ABC-0001"));
      expect(labelLine).toBeGreaterThanOrEqual(0);
      expect(valueLine).toBe(labelLine + 1);
      expect(texts[valueLine]).toContain("B ABC-0001 A");
      expect(lines.map((line) => line.lineNumber)).toEqual(lines.map((_line, index) => index + 1));
    });

    it("keeps words of one line in order of position, with two spaces where a cell ends", () => {
      const words = [box("RIGHT", 200, 10), box("LEFT", 20, 11), box("MID", 60, 9)];
      const lines = buildWordLines(words, 3);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ page: 3, raw: "LEFT  MID  RIGHT" });
      expect(lines[0]!.words!.map((word) => Math.round(word.x0 * pointsPerColumn(words)))).toEqual([20, 60, 200]);
    });

    it("joins the words of a phrase with one space", () => {
      const lines = buildWordLines(phrase("THREE PLACE DECIMAL", 20, 100), 1);
      expect(lines[0]!.raw).toBe("THREE PLACE DECIMAL");
    });

    it("reads a label that is several words as one label, at the first word's position", () => {
      const words = titleRowWords();
      const cells = readTitleBlockCells(buildWordLines(words, 1));
      expect(cells.find((cell) => cell.field === "partNumber")).toMatchObject({
        label: "DWG. NO.",
        status: "value",
        value: "ABC-0001",
      });
      const dwg = cells.find((cell) => cell.field === "partNumber")!;
      expect(dwg.labelStart * pointsPerColumn(words)).toBeCloseTo(325, 0);
    });
  });
});
