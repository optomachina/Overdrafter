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
  MAX_LINE_STEP,
  MAX_WORDS_PER_PAGE,
  MIN_POINTS_PER_COLUMN,
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

  describe("pointsPerColumn", () => {
    const sized = (height: number) => ({ text: "x", xMin: 0, yMin: 0, xMax: 3, yMax: height });

    it("is 0.4 of the median word height", () => {
      expect(pointsPerColumn([sized(10), sized(10), sized(30)])).toBeCloseTo(4, 9);
    });

    it("never gives a column smaller than MIN_POINTS_PER_COLUMN, whatever the text size", () => {
      for (const height of [5e-324, 1e-300, 1e-10, 1e-5]) {
        const column = pointsPerColumn([sized(height), sized(height), sized(height)]);
        expect(column).toBe(MIN_POINTS_PER_COLUMN);
        expect(Number.isFinite(1_000 / column)).toBe(true);
      }
    });

    it("falls back to the B-size column for heights that are not usable: zero, negative, NaN, infinite", () => {
      const unusable = [0, -4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
      for (const height of unusable) {
        expect(pointsPerColumn([sized(height)])).toBe(FALLBACK_POINTS_PER_COLUMN);
      }
      expect(pointsPerColumn([{ text: "x", xMin: 0, yMin: Number.NaN, xMax: 3, yMax: 9 }])).toBe(FALLBACK_POINTS_PER_COLUMN);
    });

    it("takes the median over the usable heights only", () => {
      expect(pointsPerColumn([sized(Number.NaN), sized(0), sized(10), sized(20), sized(20)])).toBeCloseTo(8, 9);
    });

    it("gives finite positions for a page of denormal-height words", () => {
      const words = ["DWG.", "NO.", "1000-1"].map((text, index) => ({ text, xMin: 100 * index, yMin: 0, xMax: 100 * index + 50, yMax: 5e-324 }));
      const lines = buildWordLines(words, 1);
      expect(lines[0]!.words!.every((word) => Number.isFinite(word.x0) && Number.isFinite(word.x1))).toBe(true);
      expect(lines[0]!.pointsPerColumn).toBe(MIN_POINTS_PER_COLUMN);
    });
  });

  describe("parseBboxWords", () => {
    const wrap = (body: string) => `<html><body><doc><page width="612" height="792">${body}</page></doc></body></html>`;
    const word = (xMin: string, yMin: string, xMax: string, yMax: string, text = "w") =>
      `<word xMin="${xMin}" yMin="${yMin}" xMax="${xMax}" yMax="${yMax}">${text}</word>`;

    it("skips a word whose coordinates are not finite numbers", () => {
      const markup = wrap(
        [word("NaN", "1", "5", "9"), word("1", "Infinity", "5", "9"), word("1", "1", "-Infinity", "9"), word("1", "1", "5", "1e999"), word("1", "2", "5", "9", "ok")].join(""),
      );
      expect(parseBboxWords(markup).map((entry) => entry.text)).toEqual(["ok"]);
    });

    it("skips a word whose box runs backwards", () => {
      expect(parseBboxWords(wrap([word("9", "1", "5", "9"), word("1", "9", "5", "1"), word("1", "1", "5", "9", "ok")].join(""))).map((entry) => entry.text)).toEqual(["ok"]);
    });

    it("trusts nothing from markup that stops before the end of the document", () => {
      const whole = wrap(word("1", "1", "5", "9", "ok"));
      expect(parseBboxWords(whole)).toHaveLength(1);
      for (const cut of [whole.indexOf("</page>"), whole.indexOf("</doc>"), whole.indexOf("</body>"), whole.length - 8]) {
        expect(parseBboxWords(whole.slice(0, cut))).toEqual([]);
      }
    });
  });

  describe("parseBboxWords, entities", () => {
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
      expect(parseBboxWords(page(MAX_WORDS_PER_PAGE))).toHaveLength(MAX_WORDS_PER_PAGE);
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

    // Codex review of #884, round 7: lines are numbered in order, and each line's `y` is its distance down the page in
    // text heights, so the reader can limit what it reads by the distance on the sheet as well.
    it("measures each line's distance down the page in text heights", () => {
      // 9 pt words in 9.9 pt boxes: the text height is 9.9 pt.
      const words = [box("A", 100, 100), box("B", 100, 109.9), box("C", 100, 129.7), box("D", 100, 500), box("E", 100, 5_000)];
      expect(buildWordLines(words, 1).map((line) => [line.raw, line.lineNumber, line.y])).toEqual([
        ["A", 1, 1],
        ["B", 2, 2],
        ["C", 3, 4],
        // 370.3 pt is 37.4 text heights.
        ["D", 4, 41],
        // Farther than any distance the reader measures counts MAX_LINE_STEP lines.
        ["E", 5, 41 + MAX_LINE_STEP],
      ]);
    });

    it("counts a line just under the one above it as the next line, and keeps a hostile coordinate finite", () => {
      expect(buildWordLines([box("A", 100, 100), box("B", 100, 104)], 1).map((line) => line.y)).toEqual([1, 2]);
      const huge = [box("A", 100, 100), { text: "B", xMin: 100, yMin: 1e308, xMax: 110, yMax: Number.MAX_VALUE }];
      const ys = buildWordLines(huge, 1).map((line) => line.y!);
      expect(ys).toHaveLength(2);
      expect(ys.every((y) => Number.isFinite(y))).toBe(true);
      expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(1);
      expect(ys[1]! - ys[0]!).toBeLessThanOrEqual(MAX_LINE_STEP);
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

  // Codex review of #884, round 7: lines built from word boxes were numbered by their order alone, so the next line of
  // text under a label was one line under it however far down the sheet it was, and the reader's distance limits did not
  // hold. What a cell reads is now limited by the distance down the page in text heights as well.
  describe("the distance down the page", () => {
    const cellOf = (words: PdfWord[], field: string) => readTitleBlockCells(buildWordLines(words, 1)).find((cell) => cell.field === field);

    it("does not read text 400 points under MATERIAL as its value (the review's sheet)", () => {
      const far = [...phrase("MATERIAL", 330, 100, 6), ...phrase("6061-T6", 340, 500, 9)];
      expect(cellOf(far, "material")).toMatchObject({ status: "empty", value: null });
      const signals = infer(["MATERIAL", "", "", "", "", "  6061-T6"].join("\n"), far);
      expect(signals.material.reviewNeeded).toBe(true);
      expect(signals.material.value === null || signals.material.confidence <= 0.2, `${signals.material.value}`).toBe(true);
      expect(signals.reviewFields).toContain("material");
      // The same two words one line apart are the label and its value.
      const near = [...phrase("MATERIAL", 330, 100, 6), ...phrase("6061-T6", 340, 108, 9)];
      expect(cellOf(near, "material")).toMatchObject({ status: "value", value: "6061-T6" });
    });

    it("owns text at most MAX_DY (20) text heights under its label, however few lines lie between", () => {
      // Two 9 pt words in 9.9 pt boxes: the text height is 9.9 pt.
      const at = (heights: number) => cellOf([...phrase("MATERIAL", 100, 100), ...phrase("6061-T6", 101, 100 + heights * 9.9)], "material");
      expect(at(20)).toMatchObject({ status: "value", value: "6061-T6" });
      expect(at(21)).toMatchObject({ status: "empty", value: null });
    });

    it("flags a value whose next line of text, which would continue it, is far under it on the sheet", () => {
      const sheet = (heights: number) => [
        ...phrase("FINISH", 100, 100),
        ...phrase("ANODIZE, BLACK", 101, 110),
        ...phrase("MIL-A-8625 TYPE II", 101, 110 + heights * 9.9),
      ];
      expect(cellOf(sheet(1), "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK MIL-A-8625 TYPE II" });
      expect(cellOf(sheet(3), "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK MIL-A-8625 TYPE II" });
      // Neither joined (it may be another cell's text) nor left out (it may be the rest of the value).
      expect(cellOf(sheet(4), "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "far_value" });
      expect(cellOf(sheet(30), "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "far_value" });
      // An identifier is flagged the same way.
      const drawingNumber = [...phrase("DWG. NO.", 100, 100), ...phrase("1000-1", 101, 110), ...phrase("2000-2", 101, 160)];
      expect(cellOf(drawingNumber, "partNumber")).toMatchObject({ status: "ambiguous", value: null, reason: "far_value" });
    });

    it("still ends a value at the label of a stacked cell far under it, and still flags text the cell owns near it in order", () => {
      // A 6 pt label shaped like a label, the next line of text but five heights under the value: the value ends above it.
      const stacked = [...phrase("MATERIAL", 330, 100, 6), ...phrase("AL 6061-T6", 340, 108, 9), ...phrase("QTY", 332, 160, 6), ...phrase("4", 340, 168, 9)];
      expect(cellOf(stacked, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
      // A stacked label at the top of a tall cell, its value near the bottom: the next line of text, four heights down.
      const tall = [...phrase("MATERIAL", 330, 100, 6), ...phrase("QTY", 332, 108, 6), ...phrase("4", 340, 140, 9), ...phrase("FINISH", 330, 160, 6)];
      expect(cellOf(tall, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });
  });
});
