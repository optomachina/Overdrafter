// @vitest-environment node
//
// OVD-985 and OVD-989: the title block is read by the cell each label owns. These tests use controlled
// `pdftotext -layout` text (worker/test-support/titleBlockSheet.ts), so every failure shape is explicit:
// a value several lines below its label, other cells' text in between, approvals labels such as Q.A.
// closest to the label, a label alone in its cell. The real sample drawing runs in sampleDrawing.test.ts
// and a full B-size sheet in titleBlockLayout.test.ts. The caps and the cost on hostile text are in
// titleBlockCells.hostile.test.ts. No model, no network, no poppler.

import { describe, expect, it } from "vitest";
import { box, phrase } from "../../test-support/pdfWordBoxes";
import { layoutLine, layoutSheet, pdfTextOf, type Piece } from "../../test-support/titleBlockSheet";
import { inferDrawingSignalsFromPdf } from "./pdfDrawing";
import { buildWordLines, type PdfWord } from "./pdfWords";
import { isLabelLikeToken, readTitleBlockCells, type CellField, type CellRead } from "./titleBlockCells";

function read(text: string): CellRead[] {
  return readTitleBlockCells(text.split("\n").map((raw, index) => ({ page: 1, lineNumber: index + 1, raw })));
}

function cell(text: string, field: CellField): CellRead {
  const reads = read(text).filter((candidate) => candidate.field === field);
  expect(reads, `one ${field} label`).toHaveLength(1);
  return reads[0]!;
}

/** The cell of a field read from word boxes (true positions, in points). */
function wordRead(words: PdfWord[], field: CellField): CellRead {
  const reads = readTitleBlockCells(buildWordLines(words, 1)).filter((candidate) => candidate.field === field);
  expect(reads, `one ${field} label`).toHaveLength(1);
  return reads[0]!;
}

function infer(text: string, baseName = "upload") {
  return inferDrawingSignalsFromPdf({ baseName, pdfText: pdfTextOf(text) });
}

/**
 * The shape of the sample drawing's title block, at the sample's own relative columns: MATERIAL and
 * FINISH on the left, the approvals column and the THIRD ANGLE PROJECTION note in the middle, then the
 * SIZE / DWG. NO. / REV row with the approvals label Q.A. on the line under it and the values seven
 * lines further down.
 */
function sampleLikeSheet(options: { between?: Piece[]; values?: Piece[] } = {}): string {
  return layoutSheet(
    [[106, "APPROVALS"], [118, "NAME"], [130, "DATE"]],
    [[106, "ENGINEER"], [118, "ACM"], [130, "10/29/2013"]],
    [[106, "DRAWN"], [118, "ACM"]],
    [[106, "CHECKED"], [118, "-"]],
    [[107, "MFG"]],
    [[139, "SIZE"]],
    [[153, "DWG. NO."], [202, "REV"]],
    options.between ?? [[107, "Q.A."]],
    [[6, "MATERIAL"]],
    [[10, "6061 Alloy"]],
    [[47, "FINISH"], [60, "ANODIZE, BLACK, MIL-A-8625F, TYPE II"]],
    [[60, "CLASS 2"], [117, "THIRD ANGLE"]],
    [[117, "PROJECTION"]],
    options.values ?? [[146, "B"], [166, "1093-05589"], [203, "02"]],
    [[6, "COMMENTS:"], [76, "NEXT ASM"], [91, "0000-00000"], [140, "SCALE: 1:1"], [188, "SHEET 1 OF 1"]],
  );
}

describe("title block cells", () => {
  describe("reading the cell a label owns", () => {
    it("takes the drawing number and revision from under their labels, past the approvals labels between", () => {
      const sheet = sampleLikeSheet();
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "value", value: "1093-05589", label: "DWG. NO." });
      expect(cell(sheet, "revision")).toMatchObject({ status: "value", value: "02", label: "REV" });
      expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "6061 Alloy" });
      expect(cell(sheet, "finish")).toMatchObject({
        status: "value",
        value: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
      });
    });

    it("gives the SIZE value to SIZE, not to the DWG. NO. cell next to it", () => {
      // "B" sits just left of the drawing number; it is the sheet size.
      const sheet = sampleLikeSheet();
      expect(cell(sheet, "partNumber").value).toBe("1093-05589");
      expect(cell(sheet, "partNumber").valueLines).toHaveLength(1);
    });

    it("does not let a cell reach into the stack next to it (THIRD ANGLE PROJECTION)", () => {
      const sheet = sampleLikeSheet();
      expect(cell(sheet, "finish").value).not.toMatch(/PROJECTION|THIRD/);
    });

    it("reads a value centred under its label, left of the label's left edge", () => {
      const sheet = layoutSheet(
        [[60, "SIZE"], [70, "DWG. NO."], [100, "REV"]],
        "",
        "",
        [[60, "B"], [64, "ABC-0002-LONG"], [100, "C"]],
      );
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "value", value: "ABC-0002-LONG" });
      expect(cell(sheet, "revision")).toMatchObject({ status: "value", value: "C" });
    });

    it.each([
      ["a value on the label's line", "DWG. NO. 1000-1  REV A"],
      ["single-space labels and values", "DWG. NO. 1000-1 REV A"],
      ["a colon after the label", "DWG. NO.: 1000-1  REV: A"],
      ["DRAWING NUMBER and REVISION", "DRAWING NUMBER  1000-1  REVISION  A"],
      ["PART NO.", "PART NO.   1000-1   REV   A"],
      ["tab separated cells", "DWG. NO.\t1000-1\tREV\tA"],
      ["gaps of several spaces", layoutSheet([[0, "DWG. NO."], [18, "1000-1"], [40, "REV"], [52, "A"]])],
    ])("reads %s", (_name, sheet) => {
      expect(cell(sheet, "partNumber").value).toBe("1000-1");
      expect(cell(sheet, "revision").value).toBe("A");
    });

    it("reads labels run together on one line and values on the next", () => {
      const sheet = [
        "                      SIZE DWG. NO.                      REV",
        "",
        "                      B                                  C",
        "                          XYZ-17",
      ].join("\n");
      expect(cell(sheet, "partNumber").value).toBe("XYZ-17");
      expect(cell(sheet, "revision").value).toBe("C");
    });

    it("joins a value that wraps under itself and stops at the next label of the stack", () => {
      const sheet = layoutSheet(
        [[0, "FINISH"], [10, "ANODIZE, BLACK, MIL-A-8625F, TYPE II"]],
        [[10, "CLASS 2"]],
        [[0, "MATERIAL"]],
        [[2, "6061-T6"]],
      );
      expect(cell(sheet, "finish").value).toBe("ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2");
      expect(cell(sheet, "material").value).toBe("6061-T6");
      // Under a value that is under its label, "CLASS 2" has the shape of a stacked cell's label and value ("QTY 4").
      const under = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE, BLACK, MIL-A-8625F, TYPE II"]], [[2, "CLASS 2"]], [[0, "MATERIAL"]], [[2, "6061-T6"]]);
      expect(cell(under, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });

    it("does not join unlabeled text that is beside the value instead of under it", () => {
      // The company line sits lower and to the right of the FINISH value; it is another cell.
      const sheet = layoutSheet(
        [[0, "FINISH"], [14, "ANODIZE, BLACK"]],
        "",
        [[40, "ACME Mfg Co."]],
      );
      expect(cell(sheet, "finish").value).toBe("ANODIZE, BLACK");
    });

    it("does not join a sheet-border zone marker under the value", () => {
      for (const finish of ["ANODIZE, BLACK", "AL 6061-T6", "MIL-A-8625 TYPE II"]) {
        const sheet = layoutSheet([[0, "FINISH"]], [[2, finish]], "", [[8, "4"]]);
        expect(cell(sheet, "finish"), finish).toMatchObject({ status: "value", value: finish });
      }
      // #884 review, round 6: under a value of label words only, a lone character is how a stacked cell's label sits over
      // its own one-character value ("QTY" over "4"), so the field is flagged rather than read. The safe direction.
      const labelWords = layoutSheet([[0, "FINISH"]], [[2, "AS MACHINED"]], "", [[8, "4"]]);
      expect(cell(labelWords, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });

    it("does not take the sheet-border zone markers under the block as the value of an empty cell", () => {
      const border = [[0, "8"], [20, "7"], [40, "6"], [60, "5"], [80, "4"]] as Piece[];
      const sheet = layoutSheet(
        [[0, "FINISH"], [40, "REV"], [60, "SHEET 1 OF 1"]],
        "",
        "",
        border,
        [[90, "1"]],
      );
      expect(cell(sheet, "finish")).toMatchObject({ status: "empty", value: null });
      expect(cell(sheet, "revision")).toMatchObject({ status: "empty", value: null });
    });

    it.each([["FINISH", "A"], ["MATERIAL", "4"], ["DWG. NO.", "7"]])(
      "never takes a single stray character as the value of %s",
      (label, stray) => {
        const sheet = layoutSheet([[0, label]], [[4, stray]], [[4, "SOME TEXT BELOW"]]);
        const field = label === "FINISH" ? "finish" : label === "MATERIAL" ? "material" : "partNumber";
        expect(cell(sheet, field).value).not.toBe(stray);
      },
    );

    it("does not read a label that is part of a sentence", () => {
      const sheet = layoutSheet(
        [[0, "DIMENSIONS APPLY AFTER PLATING"]],
        [[0, "SEE NOTE 3 FOR FINISH"]],
        [[0, "FINISH"], [14, "AS MACHINED"]],
      );
      expect(read(sheet).filter((candidate) => candidate.field === "finish")).toHaveLength(1);
      expect(cell(sheet, "finish").value).toBe("AS MACHINED");
    });

    it.each(["ENG-1234", "REV-B", "QA-77", "DATE-001", "MFG-9"])("keeps %s as a value, not a label", (partNumber) => {
      const sheet = layoutSheet([[0, "DWG. NO."]], [[2, partNumber]]);
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "value", value: partNumber });
    });
  });

  describe("never a neighbouring cell's text", () => {
    it("takes the material from MATERIAL, not from the TITLE cell above it", () => {
      const sheet = layoutSheet(
        [[40, "TITLE:"]],
        [[48, "SAMPLE PLATE"]],
        [[0, "MATERIAL"]],
        [[2, "ALUMINUM 6061-T6"]],
      );
      expect(cell(sheet, "material").value).toBe("ALUMINUM 6061-T6");
    });

    it("leaves the material empty when its cell is empty, rather than taking the TITLE text", () => {
      const sheet = layoutSheet(
        [[40, "TITLE:"]],
        [[48, "SAMPLE PLATE"]],
        [[0, "MATERIAL"]],
        "",
        [[0, "FINISH"], [14, "AS MACHINED"]],
      );
      expect(cell(sheet, "material")).toMatchObject({ status: "empty", value: null, reason: "no_value" });
      const signals = infer(sheet);
      expect(signals.material.value).toBeNull();
      expect(signals.material.reviewNeeded).toBe(true);
      expect(signals.reviewFields).toContain("material");
    });

    it("takes the finish from FINISH, not from the SURFACE FINISH note", () => {
      const sheet = layoutSheet(
        [[0, "SURFACE FINISH: SEE NOTE"]],
        [[12, "AS SPECIFIED"]],
        [[20, "INTERPRET IN ACCORDANCE WITH:"]],
        [[0, "FINISH"]],
        [[2, "AS MACHINED"]],
      );
      expect(cell(sheet, "finish").value).toBe("AS MACHINED");
    });

    it("leaves the finish empty and flagged when only the SURFACE FINISH note is near", () => {
      const sheet = layoutSheet(
        [[0, "SURFACE FINISH: SEE NOTE"]],
        [[12, "AS SPECIFIED"]],
        [[0, "DIMENSIONS APPLY AFTER PLATING"]],
        [[0, "FINISH"]],
      );
      const signals = infer(sheet);
      expect(signals.finish.value).toBeNull();
      expect(signals.finish.reviewNeeded).toBe(true);
      expect(signals.quoteFinish).toBeNull();
    });
  });

  describe("approvals labels are never values", () => {
    const TOKENS = ["Q.A.", "QA", "Q.C.", "CHECKED", "DRAWN", "APPROVED", "ENG", "MFG", "ENG APPR.", "MFG APPR.", "QA APPR."];

    it.each(TOKENS)("yields no value when %s is the only text under DWG. NO. and REV", (token) => {
      const sheet = layoutSheet([[0, "DWG. NO."], [30, "REV"]], [[2, token]], "", [[32, token]]);
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "empty", value: null });
      expect(cell(sheet, "revision")).toMatchObject({ status: "empty", value: null });
    });

    it.each(TOKENS)("never reports %s as the part number or revision, and flags both", (token) => {
      // The drawing number cell is empty here, so the only candidates near its label are approvals labels.
      const sheet = sampleLikeSheet({ between: [[107, token]], values: [[146, "B"], [203, token]] });
      const signals = infer(sheet);
      expect(signals.partNumber.value).not.toBe(token);
      expect(signals.revision.value).not.toBe(token);
      expect(signals.revision.value).toBeNull();
      expect(signals.revision.reviewNeeded).toBe(true);
      expect(signals.partNumber.reviewNeeded).toBe(true);
      expect(signals.reviewFields).toEqual(expect.arrayContaining(["partNumber", "revision"]));
    });

    it.each(TOKENS)("rejects a lone %s line as a revision when the sheet has no REV label", (token) => {
      // Without a REV label the parser falls back to lone short tokens; a label is still not a value.
      const sheet = layoutSheet([[0, "MATERIAL"], [14, "6061 ALLOY"]], [[10, token]], [[0, "SCALE: 1:1"]]);
      const signals = infer(sheet);
      expect(signals.revision.value).toBeNull();
      expect(signals.revision.reviewNeeded).toBe(true);
    });

    it("reads the real values even with the approvals labels directly under the label row", () => {
      const signals = infer(sampleLikeSheet({ between: [[107, "Q.A."], [120, "MFG"]] }));
      expect(signals.partNumber).toMatchObject({ value: "1093-05589", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "02", reviewNeeded: false });
      expect(signals.material).toMatchObject({ value: "6061 Alloy", reviewNeeded: false });
      expect(signals.finish).toMatchObject({ value: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2", reviewNeeded: false });
      expect(signals.reviewFields).not.toEqual(expect.arrayContaining(["partNumber"]));
      expect(signals.reviewFields).not.toEqual(expect.arrayContaining(["revision"]));
    });

    it("does not take a revision from a filename stem that is an approvals label", () => {
      // The REV cell is empty, so the filename stem is consulted: it supplies the part number but not "QA".
      const sheet = layoutSheet([[0, "DWG. NO."], [30, "REV"]], "", [[40, "SHEET 1 OF 1"]]);
      const signals = inferDrawingSignalsFromPdf({ baseName: "1093-05589-QA", pdfText: pdfTextOf(sheet) });
      expect(signals.partNumber.value).toBe("1093-05589");
      expect(signals.partNumber.reasons).toContain("filename_stem");
      expect(signals.revision.value).toBeNull();
      expect(signals.revision.reviewNeeded).toBe(true);
    });

    it("still takes a real revision from the filename stem when the REV cell is empty", () => {
      const sheet = layoutSheet([[0, "DWG. NO."], [30, "REV"]], "", [[40, "SHEET 1 OF 1"]]);
      const signals = inferDrawingSignalsFromPdf({ baseName: "1093-05589-02", pdfText: pdfTextOf(sheet) });
      expect(signals.revision.value).toBe("02");
      expect(signals.revision.reasons).toContain("filename_stem");
    });
  });

  describe("fails closed", () => {
    it("takes no value for an identifier with a second value line under it", () => {
      const sheet = layoutSheet([[0, "DWG. NO."]], [[2, "1000-1"]], [[2, "1000-2"]]);
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "ambiguous", value: null, reason: "multiple_values" });
      const signals = infer(sheet);
      expect(signals.partNumber.reviewNeeded).toBe(true);
      expect(signals.partNumber.value).not.toBe("1000-1");
    });

    it("takes no value for a wrapped value that runs past its limit", () => {
      const sheet = layoutSheet(
        [[0, "MATERIAL"]],
        [[2, "ALUMINUM"]],
        [[2, "6061-T6"]],
        [[2, "PER AMS-QQ-A-250/11"]],
      );
      expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null });
    });

    it("takes no value for a revision that is not shaped like one", () => {
      const sheet = layoutSheet([[0, "REV"]], [[2, "10/29/2013"]]);
      expect(cell(sheet, "revision")).toMatchObject({ status: "rejected", reason: "bad_shape", value: null });
    });

    it("leaves a label with nothing under it empty", () => {
      const sheet = layoutSheet([[0, "DWG. NO."], [30, "REV"]]);
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "empty", value: null });
      expect(infer(sheet).revision.value).toBeNull();
    });
  });

  // OVD-985 and OVD-989: a value is assigned to a label only when it sits in that label's cell. Text that belongs to no label (a company name, a note, a zone letter, the value of a label the
  // vocabulary does not know) is never assigned, so an empty cell stays empty and flagged.
  describe("text that belongs to no label is never assigned", () => {
    const FIELDS = [
      ["partNumber", "DWG. NO.", "ABC-77"],
      ["revision", "REV", "A2"],
      ["material", "MATERIAL", "ALUMINUM NOTE"],
      ["finish", "FINISH", "ANODIZE NOTE"],
    ] as const;

    describe("on layout text", () => {
      it.each(FIELDS)("%s: text 60 columns to the right and three lines down is not the value", (field, label, stray) => {
        const sheet = layoutSheet([[0, label]], "", "", [[60, stray]]);
        expect(cell(sheet, field)).toMatchObject({ status: "empty", value: null, reason: "no_value" });
        expect(infer(sheet)[field].value).not.toBe(stray);
      });

      it.each(FIELDS)("%s: the same text just past the label's reach (%s) is not the value either", (field, label, stray) => {
        // REVISION reach 5 and the others 12 columns past the label's right edge.
        const column = label.length + (field === "revision" ? 6 : 13);
        const sheet = layoutSheet([[0, label]], "", [[column, stray]]);
        expect(cell(sheet, field)).toMatchObject({ status: "empty", value: null });
      });

      it.each(FIELDS)("%s: text that starts exactly at the reach of the label is its cell's", (field, label, stray) => {
        const column = label.length + (field === "revision" ? 5 : 12);
        const sheet = layoutSheet([[0, label]], "", [[column, stray]]);
        expect(cell(sheet, field)).toMatchObject({ status: "value", value: stray });
      });

      it.each(FIELDS)("%s: reads the value under the label and not the stray text beside it", (field, label, stray) => {
        const value = field === "partNumber" ? "1000-1" : field === "revision" ? "B" : "6061 ALLOY";
        const sheet = layoutSheet([[0, label]], [[2, value]], "", [[60, stray]]);
        expect(cell(sheet, field)).toMatchObject({ status: "value", value });
      });

      it("takes no value when a run of the cell was left over: layout text cannot tell the rest of a value from another cell (join gap)", () => {
        // 'AB' under the label and 'CD' 15 columns on, still inside the label's reach. In layout text the gap
        // may be the rest of the same value spread apart (a fine pitch), so the cell is flagged, not cut.
        const sheet = layoutSheet([[0, "MATERIAL"]], [[0, "AB"], [17, "CD"]]);
        expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unconsumed_text" });
      });

      it("joins runs of a wrapped line that are a few columns apart (join gap)", () => {
        const sheet = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE, BLACK"]], [[2, "MIL-A-8625"], [14, "TYPE II"]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK MIL-A-8625 TYPE II" });
      });

      // #884 review, round 5: on the first line of a material or finish, a run set apart from the words before it is a
      // label beside its own value ("PAINT   BLACK"), whatever the words before it are made of.
      it.each(["ANODIZE", "ANODIZE,", "THICKNESS (IN)", "WT (LB)", "LOT #", "HEAT-TREAT", "# REQD", "6061-T6"])(
        "flags a first line '%s' with a run set apart after it",
        (lead) => {
          const sheet = layoutSheet([[0, "FINISH"]], [[2, lead], [lead.length + 6, "TYPE II"]]);
          expect(cell(sheet, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
        },
      );

      it("flags a value with text left over to its right on layout text: it may be the rest of the value", () => {
        // At a fine pitch the words of one value are tens of columns apart, as cells are, so layout text cannot
        // tell the rest of a value from a neighbour. Word boxes can (the twin test below).
        const sheet = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE, BLACK"], [45, "STRAY CELL TEXT"]], [[2, "MIL-A-8625 TYPE II"]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unconsumed_text" });
      });

      it("does not flag a value whose neighbour text is far off (beyond the trailing window)", () => {
        const sheet = layoutSheet([[0, "FINISH"]], [[2, "AS MACHINED"], [120, "STRAY CELL TEXT"]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("flags a value whose next word was taken by the band of another label above it (a fine pitch)", () => {
        // The company line above holds a label (MFG) whose band reaches the second word of the value.
        const sheet = layoutSheet([[14, "MFG"]], [[0, "MATERIAL"]], [[0, "6061"], [10, "ALLOY"]]);
        expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unconsumed_text" });
      });

      it("takes no value from layout text whose own labels are spread apart (a fine pitch)", () => {
        const sheet = layoutSheet([[0, "DWG.     NO."], [40, "MATERIAL"]], "", [[0, "1000-1"], [40, "STEEL 1018"]]);
        expect(cell(sheet, "partNumber")).toMatchObject({ status: "ambiguous", value: null, reason: "fine_pitch" });
        expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "fine_pitch" });
      });

      it("reads the same sheet whose labels are single spaced", () => {
        const sheet = layoutSheet([[0, "DWG. NO."], [40, "MATERIAL"]], "", [[0, "1000-1"], [40, "STEEL 1018"]]);
        expect(cell(sheet, "partNumber")).toMatchObject({ status: "value", value: "1000-1" });
        expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "STEEL 1018" });
      });
    });

    describe("on word boxes", () => {
      // 9 pt words in 9.9 pt boxes make a column 3.96 pt wide; 60 columns are about 240 pt.
      const WORD_FIELDS = FIELDS.map(([field, label, stray]) => [field, label, stray] as const);
      const wordCell = (words: PdfWord[], field: CellField) =>
        readTitleBlockCells(buildWordLines(words, 1)).filter((candidate) => candidate.field === field)[0]!;

      it.each(WORD_FIELDS)("%s: text 240 points to the right and three lines down is not the value", (field, label, stray) => {
        const words = [...phrase(label, 100, 100), ...phrase(stray, 340, 145), ...phrase("SOME TEXT", 700, 300)];
        expect(wordCell(words, field)).toMatchObject({ status: "empty", value: null });
      });

      it.each(WORD_FIELDS)("%s: reads the value under the label and not the stray text beside it", (field, label, stray) => {
        const value = field === "partNumber" ? "1000-1" : field === "revision" ? "B" : "6061 ALLOY";
        const words = [...phrase(label, 100, 100), ...phrase(value, 101, 115), ...phrase(stray, 340, 130), ...phrase("SOME TEXT", 700, 300)];
        expect(wordCell(words, field)).toMatchObject({ status: "value", value });
      });

      it("reads a value whose neighbour text is far off, which word boxes place exactly", () => {
        const words = [...phrase("FINISH", 100, 100), ...phrase("AS MACHINED", 101, 115), ...phrase("STRAY CELL TEXT", 400, 115)];
        expect(wordCell(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("stops a value at a cell break: a word set apart from it is another cell's", () => {
        // STRAYCELL starts past the label's reach and 2 columns after the value, with a wider gap than a space.
        const words = [...phrase("FINISH", 100, 100), ...phrase("ANODIZE BLACK", 101, 115), ...phrase("STRAYCELL", 172, 115)];
        expect(wordCell(words, "finish")).toMatchObject({ status: "value", value: "ANODIZE BLACK" });
      });

      it("continues a value along the line over single spaces, past the reach of its label", () => {
        const words = [...phrase("FINISH", 100, 100), ...phrase("ANODIZE BLACK COATING TYPE II CLASS 2", 101, 115)];
        expect(wordCell(words, "finish")).toMatchObject({ status: "value", value: "ANODIZE BLACK COATING TYPE II CLASS 2" });
      });

      it("does not take a lone letter near the REV label for the revision when the cell is empty", () => {
        const words = [...phrase("DWG. NO.", 100, 100), ...phrase("REV", 300, 100), ...phrase("1000-1", 101, 115), ...phrase("A", 340, 115)];
        expect(wordCell(words, "revision")).toMatchObject({ status: "empty", value: null });
        expect(wordCell(words, "partNumber")).toMatchObject({ status: "value", value: "1000-1" });
      });
    });

    it("does not take the text of an unlisted label beside MATERIAL for its value", () => {
      // The unlisted cell HEAT TREAT, with its own label and value, sits right of MATERIAL on the label row.
      // Word boxes place the cells exactly and read the material; layout text flags it.
      const sheet = layoutSheet([[0, "MATERIAL"], [30, "HEAT TREAT"]], [[2, "AL 6061-T6"], [30, "RC 40-45"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unconsumed_text" });
      const words = [...phrase("MATERIAL", 100, 100), ...phrase("HEAT TREAT", 300, 100), ...phrase("AL 6061-T6", 101, 115), ...phrase("RC 40-45", 301, 115)];
      expect(wordRead(words, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
    });

    it("leaves MATERIAL empty when only the unlisted cell beside it has text", () => {
      const sheet = layoutSheet([[0, "MATERIAL"], [30, "HEAT TREAT"]], "", [[30, "RC 40-45"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "empty", value: null });
    });

    it("reads no value for an unlisted label close beside MATERIAL when a value is under MATERIAL too", () => {
      // Within the inline gap the text could be MATERIAL's own value or another cell's label: neither is taken. The
      // words of letters on the label's line with a line under them have the shape of that cell's label.
      const sheet = layoutSheet([[0, "MATERIAL"], [12, "LOT CODE"]], [[2, "AL 6061-T6"], [12, "L-4412"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });

    it.each([
      [12, "value"],
      [13, "empty"],
    ] as const)("reads a value %i columns after its label on the same line as a %s", (gap, status) => {
      const sheet = layoutSheet([[0, "DWG. NO."], [8 + gap, "1000-1"]]);
      expect(cell(sheet, "partNumber").status).toBe(status);
    });

    it("does not join a line more than 3 lines under the previous one, and flags the cell on layout text", () => {
      const sheet = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE, BLACK"]], "", "", "", [[2, "MIL-A-8625"]]);
      expect(cell(sheet, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unconsumed_text" });
      const near = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE, BLACK"]], "", [[2, "MIL-A-8625"]]);
      expect(cell(near, "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK MIL-A-8625" });
    });
  });

  describe("the end of an inline value", () => {
    it("ends a phrase after a few columns: a run farther on is read by the cell rules", () => {
      // SHEET 1 OF 1 sits under REV. 'OF' is 3 columns after '1' (the phrase goes on), 'OF' 9 columns after
      // it is not part of it.
      const phrase3 = layoutSheet([[10, "REV"]], "", [[0, "SHEET"], [8, "1"], [12, "OF"]]);
      expect(cell(phrase3, "revision")).toMatchObject({ status: "empty", value: null });
      const phrase9 = layoutSheet([[10, "REV"]], "", [[0, "SHEET"], [8, "1"], [17, "OF"]]);
      expect(cell(phrase9, "revision")).toMatchObject({ status: "value", value: "OF" });
    });
  });

  describe("labels that are not values", () => {
    it.each([
      ["SHT", "SHT"],
      ["PAGE", "PAGE"],
      ["ECO", "ECO"],
      ["ECN", "ECN"],
      ["ZONE", "ZONE"],
    ])("does not read the number after %s under an empty REV cell as the revision", (_name, label) => {
      const sheet = layoutSheet(
        [[0, "MATERIAL"], [40, "DWG. NO."], [80, "REV"]],
        "",
        [[2, "AL 6061-T6"], [42, "1000-123"]],
        [[40, "SCALE 1:1"], [70, label], [81, "1"]],
      );
      expect(cell(sheet, "revision")).toMatchObject({ status: "empty", value: null });
    });

    it("does not read the number of a note 'PER ECO 1234 REV C' as a REV cell", () => {
      const sheet = layoutSheet(
        [[0, "MATERIAL"], [40, "DWG. NO."], [80, "REV"]],
        "",
        [[2, "AL 6061-T6"], [42, "1000-123"]],
        [[0, "PER ECO 1234 REV C"], [40, "SCALE 1:1"]],
      );
      const revisions = read(sheet).filter((candidate) => candidate.field === "revision");
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ status: "empty", value: null });
    });

    it("still reads a REV label after a value on a line that already has a label (DWG. NO. 1000-1 REV A)", () => {
      expect(cell("DWG. NO. 1000-1 REV A", "revision")).toMatchObject({ status: "value", value: "A" });
    });

    it("does not read a lone letter just past the REV cell as the revision", () => {
      const sheet = layoutSheet(
        [[0, "MATERIAL"], [40, "DWG. NO."], [80, "REV"]],
        "",
        [[2, "AL 6061-T6"], [42, "1000-123"], [90, "A"]],
        [[40, "SCALE 1:1"]],
      );
      expect(cell(sheet, "revision")).toMatchObject({ status: "empty", value: null });
    });
  });

  describe("two cells run together on one line", () => {
    it("reads neither when the value of one names the label of the other", () => {
      const sheet = "MATERIAL ALUMINUM FINISH ANODIZE";
      expect(cell(sheet, "material")).toMatchObject({ status: "rejected", value: null, reason: "label_in_value" });
    });

    it("reads no material when its second line names a revision label", () => {
      const sheet = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6"]], [[0, "1234 PER ECO REV C"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "rejected", reason: "label_in_value" });
      // A second line that starts with words of letters is flagged before its words are read.
      const lettersFirst = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6"]], [[0, "PER ECO 1234 REV C"]]);
      expect(cell(lettersFirst, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });

    it.each(["ZINC PLATING PER ASTM B633", "BLACK COATING", "ANODIZE PER MIL-A-8625 TYPE II"])(
      "keeps the finish %s, whose words are finish labels or specifications",
      (finish) => {
        const sheet = layoutSheet([[0, "FINISH"], [8, finish]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: finish });
      },
    );
  });

  // A cell that points elsewhere ("SEE NOTE 1") names no material or finish: nothing is stored for the part.
  describe("a value that is a pointer", () => {
    it.each([
      "SEE NOTE 1",
      "SEE NOTES 2 AND 3",
      "SEE BOM",
      "SEE SPEC",
      "PER SPEC",
      "PER SPECIFICATION",
      "PER NOTE 2",
      "PER DWG",
      "PER THE BOM",
      "REFER TO NOTE 4",
      "REFER TO DWG",
      "AS NOTED",
      "AS SPECIFIED",
      "SEE FINISH NOTE 3",
      "BLACK ANODIZE SEE NOTE 3",
      "see note 1",
    ])("takes no material or finish from %s", (value) => {
      for (const [field, label] of [["material", "MATERIAL"], ["finish", "FINISH"]] as const) {
        expect(cell(layoutSheet([[0, label], [10, value]]), field)).toMatchObject({ status: "rejected", value: null, reason: "pointer" });
        // flagged, and not filled from anywhere else, by the full signal path
        const signals = infer(layoutSheet([[0, label], [10, value]], [[40, "SCALE 1:1"]]));
        expect(signals[field].value).toBeNull();
        expect(signals[field].reviewNeeded).toBe(true);
      }
    });

    it.each(["6061-T6 PER AMS 4027", "STEEL, SEEDED", "NOTED STEEL 1018", "SEEDED STEEL"])("keeps the material %s", (value) => {
      expect(cell(layoutSheet([[0, "MATERIAL"], [10, value]]), "material")).toMatchObject({ status: "value", value });
    });

    it.each(["ANODIZE PER MIL-A-8625F", "ZINC PLATING PER ASTM B633", "AS MACHINED"])("keeps the finish %s", (value) => {
      expect(cell(layoutSheet([[0, "FINISH"], [10, value]]), "finish")).toMatchObject({ status: "value", value });
    });
  });

  // A value that stops in the middle was cut short by the text around it.
  describe("a value that ends in the middle", () => {
    // The other dashes a sheet prints, and "&" for AND, end a value as "-" and AND do (#884 review, round 12).
    it.each(["ANODIZE, CLASS", "ANODIZE, BLACK,", "6061 -", "ALUMINUM 6061-T6 (", "STEEL AND", "ANODIZE TYPE", "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS", "BLACK OXIDE PER", "ZINC /", "6061 —", "6061 –", "6061 −", "6061‐", "ANODIZE, BLACK &"])(
      "takes no value from %s",
      (value) => {
        expect(cell(layoutSheet([[0, "FINISH"], [8, value]]), "finish")).toMatchObject({ status: "rejected", value: null, reason: "cut_short" });
      },
    );

    it.each(["ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2", "6061 Alloy", "ANODIZE TYPE II", "GRADE 5 ZINC", "BLACK OXIDE, 1.2 MIL"])("keeps %s", (value) => {
      expect(cell(layoutSheet([[0, "FINISH"], [8, value]]), "finish")).toMatchObject({ status: "value", value });
    });
  });

  describe("centred labels over left aligned values", () => {
    it("reads neither value rather than the other cell's", () => {
      // Labels centred in their cells, values flush left: MATERIAL's value starts left of its label, FINISH's
      // value starts 40 columns left of FINISH. Neither is under the label it would be paired with.
      const sheet = layoutSheet([[26, "MATERIAL"], [87, "FINISH"]], "", [[2, "AL 6061-T6"], [62, "BLACK ANODIZE"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "empty", value: null });
      expect(cell(sheet, "finish")).toMatchObject({ status: "empty", value: null });
    });
  });

  describe("the same title block on more than one sheet", () => {
    const block = (partNumber: string, revision: string) =>
      layoutSheet(
        [[0, "MATERIAL"], [40, "DWG. NO."], [80, "REV"]],
        "",
        [[2, "AL 6061-T6"], [42, partNumber], [81, revision]],
        [[40, "SCALE 1:1"], [70, "SHEET 1 OF 2"]],
      );
    const inferPages = (...texts: string[]) =>
      inferDrawingSignalsFromPdf({
        baseName: "upload",
        pdfText: {
          pageCount: texts.length,
          pageCountKnown: true,
          drawingFullyRead: true,
          ocr: false,
          pages: texts.map((text, index) => ({ page: index + 1, text, ocrText: "", ocrStatus: "ok" as const })),
        },
      });

    it("agrees with itself: identical values on two sheets are not a tie", () => {
      const signals = inferPages(block("1000-123", "A"), block("1000-123", "A"));
      expect(signals.partNumber).toMatchObject({ value: "1000-123", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "A", reviewNeeded: false });
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
    });

    it("flags a field whose sheets differ", () => {
      const signals = inferPages(block("1000-123", "B"), block("1000-123", "A"));
      expect(signals.revision.reviewNeeded).toBe(true);
      expect(signals.partNumber).toMatchObject({ value: "1000-123", reviewNeeded: false });
    });

    it("counts values that differ only in case as the same", () => {
      const signals = inferPages(block("1000-123", "a"), block("1000-123", "A"));
      expect(signals.revision.reviewNeeded).toBe(false);
    });
  });

  describe("a part number is recognised only as the whole value", () => {
    it.each(["XYZ-1093-05589", "1093-05589.01", "XYZ-0070-3333", "1093-05589-02A-X"])(
      "keeps %s, and does not replace it with a company-style number inside it",
      (partNumber) => {
        const sheet = layoutSheet([[0, "MATERIAL"], [40, "DWG. NO."], [80, "REV"]], "", [[2, "AL 6061-T6"], [42, partNumber], [81, "A"]]);
        const signals = infer(sheet);
        expect(signals.partNumber.value).toBe(partNumber);
      },
    );

    it("marks a value that is a company-style number as one", () => {
      const sheet = layoutSheet([[0, "MATERIAL"], [40, "DWG. NO."], [80, "REV"]], "", [[2, "AL 6061-T6"], [42, "1093-05589"], [81, "A"]]);
      expect(infer(sheet).partNumber.reasons).toContain("regex_fit");
    });

    it("does not mark a prefixed number as one", () => {
      const sheet = layoutSheet([[0, "MATERIAL"], [40, "DWG. NO."], [80, "REV"]], "", [[2, "AL 6061-T6"], [42, "XYZ-1093-05589"], [81, "A"]]);
      expect(infer(sheet).partNumber.reasons).not.toContain("regex_fit");
    });
  });

  describe("a single character under a label", () => {
    // A lone character is a zone marker or a stray letter, never a material, finish or drawing number (R06).
    it.each([
      ["MATERIAL", "material"],
      ["FINISH", "finish"],
      ["DWG. NO.", "partNumber"],
    ] as const)("is no value of %s, and the field is flagged", (label, field) => {
      const sheet = layoutSheet([[0, label]], [[2, "X"]], [[40, "SCALE 1:1"]]);
      expect(cell(sheet, field)).toMatchObject({ status: "rejected", value: null, reason: "bad_shape" });
      expect(infer(sheet)[field].value).not.toBe("X");
      expect(infer(sheet)[field].reviewNeeded).toBe(true);
    });

    it("is a value of REV, whose values are short", () => {
      expect(cell(layoutSheet([[0, "REV"]], [[0, "X"]], [[40, "SCALE 1:1"]]), "revision")).toMatchObject({ status: "value", value: "X" });
    });
  });

  describe("a file name that looks like a part number", () => {
    // The stem of 1093-05589-02.pdf names a part and a revision, but it is no reason to replace the drawing's own
    // number when that number was read from its cell and is not flagged (S16). Only an empty, flagged or
    // unlabelled value gives way to the stem.
    const sheet = (partNumber: string) =>
      layoutSheet([[0, "MATERIAL"], [40, "DWG. NO."], [80, "REV"]], "", [[2, "AL 6061-T6"], [42, partNumber], [81, "C"]], [[40, "SCALE 1:1"]]);

    it("keeps a number read from the DWG. NO. cell that is not shaped like a company number", () => {
      const signals = infer(sheet("XYZ-77"), "1093-05589-02");
      expect(signals.partNumber).toMatchObject({ value: "XYZ-77", reviewNeeded: false });
      expect(signals.partNumber.reasons).not.toContain("filename_stem");
      expect(signals.revision).toMatchObject({ value: "C", reviewNeeded: false });
    });

    it("keeps a company-shaped number read from the cell, and does not call it the stem", () => {
      const signals = infer(sheet("2222-33333"), "1093-05589-02");
      expect(signals.partNumber).toMatchObject({ value: "2222-33333", reviewNeeded: false });
    });

    it("gives way to the stem when the cell is empty", () => {
      const signals = infer(sheet(""), "1093-05589-02");
      expect(signals.partNumber.value).toBe("1093-05589");
      expect(signals.partNumber.reasons).toContain("filename_stem");
    });
  });

  describe("the label vocabulary", () => {
    it.each([
      ["MATL.", "MATL.  6061-T6", "material", "6061-T6"],
      ["MATL", "MATL  6061-T6", "material", "6061-T6"],
      ["MATERIAL:", "MATERIAL:  6061-T6", "material", "6061-T6"],
      ["COATING", "COATING  BLACK OXIDE", "finish", "BLACK OXIDE"],
      ["PLATING", "PLATING  ZINC CLEAR", "finish", "ZINC CLEAR"],
      ["FINISH/COATING", "FINISH / COATING  BLACK OXIDE", "finish", "BLACK OXIDE"],
      ["PN", "PN  1000-1", "partNumber", "1000-1"],
      ["P/N", "P/N  1000-1", "partNumber", "1000-1"],
      ["PART NUMBER", "PART NUMBER  1000-1", "partNumber", "1000-1"],
      ["DRAWING NUMBER", "DRAWING NUMBER  1000-1", "partNumber", "1000-1"],
      ["DWG NO", "DWG NO  1000-1", "partNumber", "1000-1"],
      ["REVISION", "REVISION  C", "revision", "C"],
    ] as const)("reads the value after the label %s", (_name, line, field, value) => {
      expect(cell(line, field)).toMatchObject({ status: "value", value });
    });

    it("does not read REVISIONS (the revision history table) as the REV label", () => {
      expect(read("REVISIONS  A  B").filter((candidate) => candidate.field === "revision")).toEqual([]);
    });

    it.each([
      ["UNLESS OTHERWISE SPECIFIED:", "DIMENSIONS ARE IN INCHES"],
      ["PROPRIETARY AND CONFIDENTIAL", "THE INFORMATION IN THIS"],
      ["INTERPRET GEOMETRIC TOLERANCING PER", "ASME Y14.5M-2009"],
      ["DO NOT SCALE DRAWING", "SEE MODEL"],
      ["THIRD ANGLE PROJECTION", "SEE NOTE"],
    ])("stops a value above %s from taking the text below that label", (fence, below) => {
      const sheet = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061"]], [[0, fence]], [[2, below]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "AL 6061" });
    });

    it("joins the two lines of a material that wraps", () => {
      const sheet = layoutSheet([[0, "MATERIAL"], [10, "AL 6061-T6"]], [[10, "PER AMS 4027"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "AL 6061-T6 PER AMS 4027", valueLines: [1, 2] });
      const startsWithDigits = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6 PER"]], [[2, "AMS-4027"]]);
      expect(cell(startsWithDigits, "material")).toMatchObject({ status: "value", value: "AL 6061-T6 PER AMS-4027", valueLines: [2, 3] });
      // Under a value that is under its label, "PER AMS 4027" has the shape of a stacked cell ("LOT CODE A123").
      const under = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6"]], [[2, "PER AMS 4027"]]);
      expect(cell(under, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });
  });

  describe("the shape of a revision", () => {
    it.each(["A", "B2", "AB", "02", "10", "A.1", "NR", "0", "ABCDEFGH"])("accepts %s", (revision) => {
      expect(cell(layoutSheet([[0, "REV"]], [[0, revision]], [[40, "SCALE 1:1"]]), "revision")).toMatchObject({ status: "value", value: revision });
    });

    it.each([
      ["nine characters", "ABCDEFGHI"],
      ["a date written with slashes", "1/2/23"],
      ["a date written with hyphens", "1-2-23"],
      ["a date with a two-digit year", "10/29/13"],
      ["a lone hyphen (no revision)", "-"],
      ["a word with a space", "SEE NOTE"],
      ["a symbol", "#"],
    ])("rejects %s", (_name, revision) => {
      expect(cell(layoutSheet([[0, "REV"]], [[0, revision]], [[40, "SCALE 1:1"]]), "revision")).toMatchObject({ value: null });
    });
  });

  describe("a part number", () => {
    it("is at most 40 characters", () => {
      const forty = "X".repeat(40);
      expect(cell(layoutSheet([[0, "DWG. NO."]], [[0, forty]]), "partNumber")).toMatchObject({ status: "value", value: forty });
      expect(cell(layoutSheet([[0, "DWG. NO."]], [[0, `${forty}X`]]), "partNumber")).toMatchObject({ status: "rejected", reason: "bad_shape" });
    });

    it("is not a date", () => {
      expect(cell(layoutSheet([[0, "DWG. NO."]], [[0, "10/29/2013"]]), "partNumber")).toMatchObject({ status: "rejected", reason: "bad_shape" });
    });
  });

  // An unlisted label beside an empty cell is another cell's: the field stays empty and flagged, and the text of that
  // cell is neither the value nor part of it.
  describe("a label the vocabulary does not know, beside an empty cell", () => {
    describe("on layout text", () => {
      it.each([
        ["MATERIAL", "material", [[12, "LOT CODE"]], [[12, "RC 40-45"]]],
        ["FINISH", "finish", [[10, "BATCH"]], [[10, "STRESS RELIEVE"]]],
        ["MATERIAL", "material", [[18, "STOCK"]], [[18, "RC 40-45"]]],
      ] as const)("leaves %s empty and flagged when an unlisted label with its value under it follows on its line (%j)", (label, field, beside, under) => {
        const sheet = layoutSheet([[0, label], ...beside], "", [...under]);
        expect(cell(sheet, field)).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
        expect(infer(layoutSheet([[0, label], ...beside], "", [...under], [[40, "SCALE 1:1"]]))[field]).toMatchObject({
          value: null,
          reviewNeeded: true,
        });
      });

      it("treats a short run of letters with text under it as a label even when the text follows on the next line", () => {
        // Layout text has no heights: "LOT CODE" over "RC 40-45" is a label over its value, where the wrapped
        // value of a finish ("ANODIZE, BLACK" over "CLASS 2") has commas and digits.
        const sheet = layoutSheet([[0, "MATERIAL"], [12, "LOT CODE"]], [[14, "RC 40-45"]]);
        expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
        const finish = layoutSheet([[0, "FINISH"], [10, "BATCH"]], [[12, "STRESS RELIEVE"]]);
        expect(cell(finish, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      });

      it("treats an inline run with text under it after a blank line as a label, whatever it is made of", () => {
        // Not letters only (a digit), so the shape rule does not apply; the blank line between is what separates a
        // label over its value from a wrapped value.
        const sheet = layoutSheet([[0, "MATERIAL"], [12, "HT 2 PROCESS"]], "", [[12, "RC 40-45"]]);
        expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      });

      it("does not call a short run of letters a label when nothing is under it", () => {
        expect(cell(layoutSheet([[0, "MATERIAL"], [10, "ALUMINUM"]]), "material")).toMatchObject({ status: "value", value: "ALUMINUM" });
        const noteElsewhere = layoutSheet([[0, "MATERIAL"], [10, "ALUMINUM"]], [[60, "SOME NOTE"]]);
        expect(cell(noteElsewhere, "material")).toMatchObject({ status: "value", value: "ALUMINUM" });
      });

      it("treats a run that ends in a colon as a label of its own, with or without text under it", () => {
        const sheet = layoutSheet([[0, "MATERIAL"], [10, "BATCH:"], [24, "STRESS"]]);
        expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      });

      it("does not treat a wrapped value as a label: its second line follows directly", () => {
        const sheet = layoutSheet([[0, "FINISH"], [8, "ANODIZE, BLACK"]], [[8, "CLASS 2"]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK CLASS 2" });
      });

      it("does not treat inline text with unrelated text two lines under it as a label when that text is not aligned with it", () => {
        const sheet = layoutSheet([[0, "FINISH"], [8, "AS MACHINED"]], "", [[60, "SOME NOTE"]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("takes a part number from an inline value, and flags an unlisted label with its own value under it", () => {
        expect(cell(layoutSheet([[0, "DWG. NO."], [10, "1000-1"]]), "partNumber")).toMatchObject({ status: "value", value: "1000-1" });
        const sheet = layoutSheet([[0, "DWG. NO."], [10, "CODE"]], "", [[10, "1ABC2"]]);
        expect(cell(sheet, "partNumber")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      });
    });

    describe("on word boxes", () => {
      // The labels are set in 6 pt and the values under them in 9 pt, as in a title block.
      const label = (text: string, x: number, y = 720) => phrase(text, x, y, 6);
      const value = (text: string, x: number, y = 732) => phrase(text, x, y, 9);

      it("leaves MATERIAL empty and flagged when LOT CODE (a 6 pt label, 24 pt on) has RC 40-45 (9 pt) under it", () => {
        const words = [...label("MATERIAL", 330), ...label("LOT CODE", 380), ...value("RC 40-45", 385)];
        expect(wordRead(words, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      });

      it("leaves FINISH empty and flagged when BATCH (24 pt on) has STRESS RELIEVE under it", () => {
        const words = [...label("FINISH", 330, 750), ...label("BATCH", 370, 750), ...value("STRESS RELIEVE", 375, 762)];
        expect(wordRead(words, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      });

      it("does not call a wrapped value a label: both lines are the same size", () => {
        const words = [...label("FINISH", 330, 750), ...value("ANODIZE, BLACK", 360, 750), ...value("CLASS 2", 360, 762)];
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK CLASS 2" });
      });

      it("does not call text a label that is only as tall as the text under it", () => {
        const words = [...value("MATERIAL", 330), ...value("AL 6061", 400), ...value("T6 TEMPER", 401, 745)];
        // MATERIAL set in 9 pt like the text under its value: nothing is taller than anything, so the second line wraps.
        expect(wordRead(words, "material")).toMatchObject({ status: "value", value: "AL 6061 T6 TEMPER" });
        // Only words of letters with a line under them have the shape of a label over its value, whatever the sizes.
        const lettersOnly = [...value("MATERIAL", 330), ...value("ALUMINUM", 400), ...value("6061 T6", 401, 745)];
        expect(wordRead(lettersOnly, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      });

      // The page text sets the size of a column (0.4 of a text height). A label 74 pt on from a 6 pt label is out
      // of its inline window whatever the page text size is, and its text is no value of MATERIAL.
      describe.each([10, 12, 13, 14, 16, 18])("on a page whose text is %i pt", (size) => {
        const page = () =>
          Array.from({ length: 90 }, (_, index) => box(`.${100 + ((index * 7) % 900)}`, 60 + (index % 9) * 45, 90 + Math.floor(index / 9) * (size + 14), size));

        it("does not read a label 74 pt on from an empty MATERIAL as its value", () => {
          const words = [...page(), ...label("MATERIAL", 330), ...label("PROCESS", 430), ...value("ZINC", 436)];
          expect(wordRead(words, "material").value).toBeNull();
        });

        it("does not read it when the label is alone on its row either", () => {
          const words = [...page(), ...label("MATERIAL", 330), ...label("PROCESS ZINC", 430)];
          expect(wordRead(words, "material")).toMatchObject({ status: "empty", value: null });
        });

        it("still reads a value that follows the label closely", () => {
          const words = [...page(), ...label("MATERIAL", 330), ...value("ALUMINUM", 362, 720)];
          expect(wordRead(words, "material")).toMatchObject({ status: "value", value: "ALUMINUM" });
        });
      });
    });
  });

  // The words that head the other cells of a title block (HEAT TREAT, HARDNESS, COLOR, ...) are fences wherever they
  // are on the label's line: the text is that cell's label, and a cell that has nothing under it is no value of its
  // neighbour. A colon in the middle of the text is one too, whatever the label is called.
  describe("a word that heads another cell, on the line of an empty cell", () => {
    const NEIGHBOURS = ["HEAT TREAT", "HEAT TREATMENT", "TREATMENT", "HARDNESS", "COLOR", "COLOUR", "PROCESS", "SPEC", "SPECS", "SPECIFICATION", "TEMPER", "CONDITION"];

    it.each(NEIGHBOURS)("leaves MATERIAL and FINISH empty and flagged for %s with nothing under it (layout text)", (word) => {
      expect(cell(layoutSheet([[0, "MATERIAL"], [12, word]]), "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      expect(cell(layoutSheet([[0, "FINISH"], [9, word]]), "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });

    it.each([
      ["HARDNESS RC 40-45", "MATERIAL"],
      ["SPEC 123", "FINISH"],
      ["HEAT TREAT: RC 40-45", "MATERIAL"],
      ["COLOR BLACK", "FINISH"],
    ])("leaves the cell empty and flagged when its line goes on with %s (layout text)", (text, label) => {
      const field = label === "MATERIAL" ? "material" : "finish";
      expect(cell(layoutSheet([[0, label], [label.length + 3, text]]), field)).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      expect(infer(layoutSheet([[0, label], [label.length + 3, text]], "", [[40, "SCALE 1:1"]]))[field]).toMatchObject({ value: null, reviewNeeded: true });
    });

    it("leaves the value on the next line, right of the word's end, to no cell", () => {
      const sheet = layoutSheet([[0, "MATERIAL"], [12, "HEAT TREAT"]], [[23, "RC 40-45"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });

    it("fences a colon in the middle of the text, whatever the label is called", () => {
      expect(cell(layoutSheet([[0, "MATERIAL"], [12, "LOT CODE: L-4412"]]), "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      expect(cell(layoutSheet([[0, "FINISH"], [10, "AS MACHINED: 63 RA"]]), "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });

    it.each(["COLORED ZINC", "HARDENED 4140", "PROCESSED STEEL", "SPECIAL ALLOY", "TEMPERED GLASS", "CONDITIONED 6061"])(
      "reads %s, which only starts like such a word",
      (value) => {
        expect(cell(layoutSheet([[0, "MATERIAL"], [12, value]]), "material")).toMatchObject({ status: "value", value });
      },
    );

    it("fences the words of a phrase set as word boxes", () => {
      const label = (text: string, x: number, y = 720) => phrase(text, x, y, 6);
      const value = (text: string, x: number, y = 720) => phrase(text, x, y, 9);
      expect(wordRead([...label("MATERIAL", 330), ...label("HEAT TREAT", 380)], "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      expect(wordRead([...label("FINISH", 330), ...label("COLOR", 366)], "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      expect(wordRead([...label("MATERIAL", 330), ...label("HEAT TREAT:", 380), ...value("RC 40-45", 440)], "material")).toMatchObject({
        status: "ambiguous",
        value: null,
        reason: "unlisted_label",
      });
      expect(wordRead([...label("MATERIAL", 330), ...value("HARDNESS RC 40-45", 365)], "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
      expect(wordRead([...label("MATERIAL", 330), ...value("ALUMINUM 6061-T6", 365)], "material")).toMatchObject({ status: "value", value: "ALUMINUM 6061-T6" });
    });

    // The value of another label on its own row is not text under this label's value: a table of label and value
    // rows is read, where a label over text under it is not.
    it("reads a table of label and value rows, each value on its own row", () => {
      const sheet = layoutSheet([[0, "MATERIAL"], [12, "STAINLESS STEEL"]], [[0, "FINISH"], [12, "AS MACHINED"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "STAINLESS STEEL" });
      expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
    });
  });

  // An unlisted cell is as often stacked under MATERIAL or FINISH, in the same columns, as it is printed beside them
  // (OVD-985, OVD-989). Its label and value are owned by the cell above it, and are neither that cell's value nor a
  // wrapped line of it: an empty MATERIAL over HEAT TREAT / RC 40-45 has no material, and a material over an empty
  // HEAT TREAT cell is the material alone. Layout text has no sizes to tell a label from a wrapped line, so it flags.
  describe("a word that heads another cell, stacked under MATERIAL or FINISH", () => {
    const STACKED = ["HEAT TREAT", "HEAT TREATMENT", "TREATMENT", "HARDNESS", "COLOR", "COLOUR", "PROCESS", "SPEC", "TEMPER", "CONDITION"];
    const FLAGGED = { status: "ambiguous", value: null, reason: "unlisted_label" } as const;

    describe("on layout text", () => {
      it.each(STACKED)("leaves an empty MATERIAL empty and flagged, not '%s RC 40-45'", (word) => {
        const sheet = layoutSheet([[6, "MATERIAL"]], "", [[6, word]], [[6, "RC 40-45"]], [[6, "FINISH"], [20, "AS MACHINED"]]);
        expect(cell(sheet, "material")).toMatchObject(FLAGGED);
        expect(infer(sheet).material).toMatchObject({ value: null, reviewNeeded: true });
        // The next cell of the stack keeps its own value.
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it.each(STACKED)("leaves an empty FINISH empty and flagged, not '%s N/A'", (word) => {
        const sheet = layoutSheet([[6, "MATERIAL"]], [[6, "AL 6061-T6"]], [[6, "FINISH"]], "", [[6, word]], [[6, "N/A"]], [[100, "SIZE"]]);
        expect(cell(sheet, "finish")).toMatchObject(FLAGGED);
        expect(infer(sheet).finish).toMatchObject({ value: null, reviewNeeded: true });
        expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
      });

      it("leaves an empty FINISH empty and flagged when the stacked word has nothing under it", () => {
        const sheet = layoutSheet([[6, "MATERIAL"]], [[6, "AL 6061-T6"]], [[6, "FINISH"]], "", [[6, "HEAT TREAT"]], [[100, "SIZE"]]);
        expect(cell(sheet, "finish")).toMatchObject(FLAGGED);
      });

      it("never joins the stacked word to a material or finish that has a value, and flags the cell", () => {
        const material = layoutSheet([[6, "MATERIAL"]], [[6, "AL 6061-T6"]], [[6, "HEAT TREAT"]], "", [[6, "FINISH"], [20, "AS MACHINED"]]);
        expect(cell(material, "material")).toMatchObject(FLAGGED);
        expect(infer(material).material).toMatchObject({ value: null, reviewNeeded: true });
        const finish = layoutSheet([[6, "MATERIAL"], [20, "AL 6061-T6"]], [[6, "FINISH"]], [[6, "AS MACHINED"]], [[6, "HEAT TREAT"]], [[6, "NONE"]], [[100, "SIZE"]]);
        expect(cell(finish, "finish")).toMatchObject(FLAGGED);
        expect(infer(finish).finish).toMatchObject({ value: null, reviewNeeded: true });
        expect(cell(finish, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
      });

      it("treats a label that ends in a colon, or has one in its text, as the next cell too", () => {
        for (const text of ["LOT NO:", "LOT NO: 4412", "HT:", "RC: 40-45"]) {
          const empty = layoutSheet([[6, "MATERIAL"]], "", [[6, text]], [[6, "FINISH"], [20, "AS MACHINED"]]);
          expect(cell(empty, "material"), text).toMatchObject(FLAGGED);
          const filled = layoutSheet([[6, "FINISH"]], [[6, "AS MACHINED"]], [[6, text]], [[100, "SIZE"]]);
          expect(cell(filled, "finish"), text).toMatchObject(FLAGGED);
        }
      });

      it("reads a wrapped line that only starts like such a word, and the text a stacked cell is not", () => {
        // The value beside its label, and its wrapped line under it where the value starts.
        expect(cell(layoutSheet([[6, "MATERIAL"], [16, "ALUMINUM 6061"]], [[16, "TEMPERED T6"]]), "material")).toMatchObject({
          status: "value",
          value: "ALUMINUM 6061 TEMPERED T6",
        });
        expect(cell(layoutSheet([[6, "FINISH"], [14, "ANODIZE, BLACK"]], [[14, "CLASS 2"]]), "finish")).toMatchObject({
          status: "value",
          value: "ANODIZE, BLACK CLASS 2",
        });
        // Under a value that is under its label, a line that starts with words of letters may be a stacked cell's label.
        expect(cell(layoutSheet([[6, "MATERIAL"]], [[6, "ALUMINUM 6061"]], [[6, "TEMPERED T6"]]), "material")).toMatchObject(FLAGGED);
        expect(cell(layoutSheet([[6, "FINISH"]], [[6, "ANODIZE, BLACK"]], [[6, "CLASS 2"]]), "finish")).toMatchObject(FLAGGED);
      });

      it("does not look under an identifier: a part number and a revision are not fenced this way", () => {
        const sheet = layoutSheet([[6, "DWG. NO."], [20, "ABC-001"]], [[6, "REV"]], [[6, "A"]], [[100, "SIZE"]]);
        expect(cell(sheet, "partNumber")).toMatchObject({ status: "value", value: "ABC-001" });
      });
    });

    describe("on word boxes", () => {
      // The labels are set in 6 pt and the values in 9 pt, as in a title block.
      const label = (text: string, x: number, y: number) => phrase(text, x, y, 6);
      const value = (text: string, x: number, y: number) => phrase(text, x, y, 9);

      it("leaves an empty MATERIAL empty and flagged, not 'HEAT TREAT RC 40-45'", () => {
        const words = [
          ...label("MATERIAL", 330, 720),
          ...label("HEAT TREAT", 332, 736),
          ...value("RC 40-45", 336, 743),
          ...label("FINISH", 330, 760),
          ...value("AS MACHINED", 340, 770),
        ];
        expect(wordRead(words, "material")).toMatchObject(FLAGGED);
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("leaves an empty FINISH empty and flagged, not 'HEAT TREAT N/A'", () => {
        const words = [
          ...label("MATERIAL", 330, 720),
          ...value("AL 6061-T6", 340, 728),
          ...label("FINISH", 330, 750),
          ...label("HEAT TREAT", 332, 766),
          ...value("N/A", 336, 773),
        ];
        expect(wordRead(words, "finish")).toMatchObject(FLAGGED);
        expect(wordRead(words, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
      });

      it("reads a material over a stacked cell that is set smaller than the value, without the cell's label", () => {
        const words = [
          ...label("MATERIAL", 330, 720),
          ...value("AL 6061-T6", 340, 728),
          ...label("HEAT TREAT", 332, 741),
          ...label("FINISH", 330, 760),
          ...value("AS MACHINED", 340, 768),
        ];
        expect(wordRead(words, "material")).toMatchObject({ status: "value", value: "AL 6061-T6", valueLines: [2] });
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("reads a value on the label's line over a stacked cell set smaller than it: the cell is not a second value", () => {
        const words = [...label("MATERIAL", 330, 720), ...value("AL 6061-T6", 362, 720), ...label("HEAT TREAT", 332, 736), ...value("RC 40-45", 336, 743)];
        expect(wordRead(words, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
      });

      it("reads a finish over a stacked cell with its own value, without either", () => {
        const words = [
          ...label("MATERIAL", 330, 700),
          ...value("AL 6061-T6", 340, 708),
          ...label("FINISH", 330, 730),
          ...value("AS MACHINED", 340, 738),
          ...label("HEAT TREAT", 332, 752),
          ...value("NONE", 336, 760),
          ...label("SIZE", 600, 700),
        ];
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("stops at a stacked label with a colon, set smaller than the value", () => {
        const words = [...label("FINISH", 330, 730), ...value("AS MACHINED", 340, 738), ...label("LOT:", 332, 752), ...value("A123", 336, 760)];
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it.each(["COLOR BLACK", "TEMPER T6", "SPEC MIL-A-8625", "HARDNESS RC 40"])(
        "does not cut a value short at a wrapped line set as large as the value that starts with %s",
        (wrapped) => {
          // The same size as the value above it: a wrapped line of the value, or another cell's label, and which one
          // it is cannot be told. The cell gives no value, where reading "ANODIZE TYPE II" would drop the rest.
          const words = [...label("FINISH", 330, 730), ...value("ANODIZE TYPE II", 340, 738), ...value(wrapped, 340, 750)];
          expect(wordRead(words, "finish")).toMatchObject(FLAGGED);
        },
      );

      it("still reads a wrapped line that does not start with such a word, under a value beside its label", () => {
        const words = [...label("FINISH", 330, 730), ...value("ANODIZE, TYPE II", 352, 729), ...value("CLASS 2 BLACK", 352, 741)];
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "ANODIZE, TYPE II CLASS 2 BLACK" });
        // A first line of letters only with a line under it is the shape of a label over its value, beside its label too.
        const lettersOnly = [...label("FINISH", 330, 730), ...value("ANODIZE TYPE II", 352, 729), ...value("CLASS 2 BLACK", 352, 741)];
        expect(wordRead(lettersOnly, "finish")).toMatchObject(FLAGGED);
        // Under a value that is under its label, "CLASS 2 BLACK" has the shape of a stacked cell ("QTY 4").
        const under = [...label("FINISH", 330, 730), ...value("ANODIZE TYPE II", 340, 738), ...value("CLASS 2 BLACK", 340, 750)];
        expect(wordRead(under, "finish")).toMatchObject(FLAGGED);
      });
    });
  });

  // Any cell can be stacked under MATERIAL or FINISH, with a label the vocabulary does not know (#884 review, round 2):
  // SURFACE TREATMENT, PAINT, THICKNESS over .125. Its text is never part of the value. With word boxes the size
  // tells: a label is set smaller than the value, so it ends the value when it is shaped like a label, and a line set
  // smaller that is not shaped like one, or a line set taller than the one above it (a label over its value), leaves the
  // field flagged. Where no size tells (layout text, or a template that sets its values like its labels), a value of
  // more than one line with a line shaped like a label (at most three words of letters only) is flagged: "ALUMINUM"
  // over "6061-T6" cannot be told from "THICKNESS" over ".125".
  describe("a cell the vocabulary does not know, stacked under MATERIAL or FINISH", () => {
    const UNLISTED = ["SURFACE TREATMENT", "PAINT", "PAINT COLOR", "THICKNESS", "GAUGE", "QTY", "LOT CODE", "STOCK"];
    const FLAGGED = { status: "ambiguous", value: null, reason: "unlisted_label" } as const;
    const label = (text: string, x: number, y: number) => phrase(text, x, y, 6);
    const value = (text: string, x: number, y: number) => phrase(text, x, y, 9);

    describe("on word boxes, 6 pt labels over 9 pt values", () => {
      it.each(UNLISTED)("ends a material at an empty %s cell under it", (word) => {
        const words = [...label("MATERIAL", 330, 720), ...value("AL 6061-T6", 340, 728), ...label(word, 332, 741), ...label("FINISH", 330, 760), ...value("AS MACHINED", 340, 768)];
        expect(wordRead(words, "material")).toMatchObject({ status: "value", value: "AL 6061-T6", valueLines: [2] });
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it.each(UNLISTED)("ends a finish at a %s cell under it, with that cell's own value", (word) => {
        const words = [...label("FINISH", 330, 730), ...value("ANODIZE", 340, 738), ...label(word, 332, 752), ...value("BLACK", 336, 760), ...label("SIZE", 600, 700)];
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "ANODIZE" });
      });

      it.each(UNLISTED)("leaves an empty MATERIAL empty and flagged, not '%s .125'", (word) => {
        const words = [...label("MATERIAL", 330, 720), ...label(word, 332, 736), ...value(".125", 336, 743), ...label("FINISH", 330, 760), ...value("AS MACHINED", 340, 770)];
        expect(wordRead(words, "material")).toMatchObject(FLAGGED);
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("ends a value at a smaller label that has its own value beside it on the same line", () => {
        for (const [cellLabel, cellValue] of [["PAINT", "BLACK"], ["LOT", "A123"], ["THICKNESS", ".125"]] as const) {
          const words = [...label("FINISH", 330, 730), ...value("ANODIZE", 340, 738), ...label(cellLabel, 332, 753), ...value(cellValue, 372, 751)];
          const lines = buildWordLines(words, 1);
          expect(lines.some((line) => line.raw.includes(cellLabel) && line.raw.includes(cellValue)), cellLabel).toBe(true);
          expect(wordRead(words, "finish"), cellLabel).toMatchObject({ status: "value", value: "ANODIZE" });
        }
      });

      it("flags a line set smaller than the value that is not shaped like a label: it may be the rest of the value", () => {
        const words = [...label("MATERIAL", 330, 720), ...value("AL 6061-T6", 340, 728), ...label("THICKNESS .125", 332, 741)];
        expect(wordRead(words, "material")).toMatchObject(FLAGGED);
        const finish = [...label("FINISH", 330, 730), ...value("ANODIZE", 340, 738), ...label("TYPE II CLASS 2", 340, 750)];
        expect(wordRead(finish, "finish")).toMatchObject(FLAGGED);
      });

      // #884 review, final round (Codex): a stacked label set as large as the value, which is larger than its own label.
      // The size of the line does not decide: "ANODIZE" over "PAINT" and "THICKNESS" over ".125" are the shape of a
      // label over its value, and so are "BLACK" over "ANODIZE" and "ALUMINUM" over "6061-T6". None of them is read.
      it.each(["PAINT", "THICKNESS", "QTY", "LOT CODE"])("flags a finish with a 9 pt %s under its 9 pt value, wherever it starts", (word) => {
        for (const x of [332, 340]) {
          const words = [...label("FINISH", 330, 730), ...value("ANODIZE", 340, 738), ...value(word, x, 750), ...label("SIZE", 600, 700)];
          expect(wordRead(words, "finish"), `${word} at ${x}`).toMatchObject(FLAGGED);
          const longer = [...label("FINISH", 330, 730), ...value("ANODIZE, BLACK", 340, 738), ...value(word, x, 750), ...label("SIZE", 600, 700)];
          expect(wordRead(longer, "finish"), `${word} at ${x}`).toMatchObject(FLAGGED);
        }
        const empty = [...label("MATERIAL", 330, 720), ...value(word, 332, 728), ...value(".125", 336, 740), ...label("FINISH", 330, 760), ...value("AS MACHINED", 340, 768)];
        expect(wordRead(empty, "material")).toMatchObject(FLAGGED);
      });

      it("flags a wrapped line shaped like a label even when it is set as large as the value", () => {
        const words = [...label("FINISH", 330, 730), ...value("BLACK", 340, 738), ...value("ANODIZE", 340, 750)];
        expect(wordRead(words, "finish")).toMatchObject(FLAGGED);
        const material = [...label("MATERIAL", 330, 720), ...value("ALUMINUM", 340, 728), ...value("6061-T6", 340, 740)];
        expect(wordRead(material, "material")).toMatchObject(FLAGGED);
        // A wrapped line that starts with a designator, under a first line that is not only words of letters, is read.
        const designator = [...label("FINISH", 330, 730), ...value("ANODIZE, BLACK", 340, 738), ...value("MIL-A-8625 TYPE II", 340, 750)];
        expect(wordRead(designator, "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK MIL-A-8625 TYPE II" });
      });

      it("flags a value of a template that sets its labels as large as its values, when a line is shaped like a label", () => {
        // 9 pt throughout: nothing tells PAINT, a cell of its own, from a wrapped line of the material.
        const words = [...value("MATERIAL", 330, 720), ...value("AL 6061-T6", 340, 732), ...value("PAINT", 332, 744), ...value("FINISH", 330, 770), ...value("AS MACHINED", 340, 782)];
        expect(wordRead(words, "material")).toMatchObject(FLAGGED);
        const empty = [...value("MATERIAL", 330, 720), ...value("THICKNESS", 332, 736), ...value(".125", 336, 748), ...value("FINISH", 330, 770), ...value("AS MACHINED", 340, 782)];
        expect(wordRead(empty, "material")).toMatchObject(FLAGGED);
        // #884 review, final round (c): the label of the stacked cell printed with its value, one word space apart.
        for (const stacked of ["THICKNESS .125", "LOT CODE A123", "PAINT RAL 9005", "QTY 4"]) {
          const material = [...value("MATERIAL", 330, 720), ...value("AL 6061-T6", 340, 732), ...value(stacked, 332, 744), ...value("FINISH", 330, 770), ...value("AS MACHINED", 340, 782)];
          expect(wordRead(material, "material"), stacked).toMatchObject(FLAGGED);
          const finish = [...value("FINISH", 330, 730), ...value("ANODIZE, BLACK", 340, 742), ...value(stacked, 332, 754), ...value("SIZE", 600, 700)];
          expect(wordRead(finish, "finish"), stacked).toMatchObject(FLAGGED);
        }
        // A line that is not shaped like a label still wraps (a material on the label's own line, as before).
        const wrapped = [...value("MATERIAL", 330, 720), ...value("AL 6061", 400, 720), ...value("T6 TEMPER", 401, 733)];
        expect(wordRead(wrapped, "material")).toMatchObject({ status: "value", value: "AL 6061 T6 TEMPER" });
      });

      // #884 review, final round (a): an empty MATERIAL with a stacked cell whose 6 pt label and 9 pt value share a line.
      it.each(UNLISTED)("leaves an empty MATERIAL empty and flagged, not '%s .125' printed on one line", (word) => {
        // The value 10 pt after the end of the label (a 6 pt word is 3.3 pt a character), as the review's sheets set it.
        const words = [...label("MATERIAL", 330, 720), ...label(word, 332, 736), ...value(".125", 342 + word.length * 3.3, 734), ...label("FINISH", 330, 760), ...value("AS MACHINED", 340, 770)];
        expect(buildWordLines(words, 1).some((line) => line.raw.includes(word) && line.raw.includes(".125"))).toBe(true);
        expect(wordRead(words, "material")).toMatchObject(FLAGGED);
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      // #884 review, round 5 (HIGH 1): a stacked label with a word that is not letters only (a bracket, a number sign, a
      // hyphen), its 9 pt value beside it on the line: owned by the cell, or past its reach and owned by no cell.
      const NOT_LETTERS_ONLY = [
        ["THICKNESS (IN)", ".125"],
        ["WT (LB)", "2.5"],
        ["HEAT-TREAT", "RC 40-45"],
        ["LOT #", "A123"],
        ["ROUGHNESS (Ra)", "63"],
        ["# REQD", "4"],
      ] as const;
      it.each(NOT_LETTERS_ONLY)("leaves an empty MATERIAL or FINISH empty and flagged, not a 6 pt '%s' by a 9 pt '%s'", (cellLabel, cellValue) => {
        for (const valueX of [342 + cellLabel.length * 3.3, 385, 420]) {
          const material = [...label("MATERIAL", 330, 720), ...label(cellLabel, 332, 736), ...value(cellValue, valueX, 734), ...label("FINISH", 330, 760), ...value("AS MACHINED", 340, 770)];
          expect(buildWordLines(material, 1).some((line) => line.raw.includes(cellLabel.replace("# ", "")) && line.raw.includes(cellValue))).toBe(true);
          expect(wordRead(material, "material"), `value at ${valueX}`).toMatchObject(FLAGGED);
          expect(wordRead(material, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
          const finish = [...label("MATERIAL", 330, 700), ...value("AL 6061-T6", 340, 708), ...label("FINISH", 330, 730), ...label(cellLabel, 332, 746), ...value(cellValue, valueX, 744), ...label("SIZE", 600, 700)];
          expect(wordRead(finish, "finish"), `value at ${valueX}`).toMatchObject(FLAGGED);
          expect(wordRead(finish, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
        }
      });

      // #884 review, round 6 (HIGH 1): a stacked label over a value of ONE character in an empty cell. A single character
      // never joins a value (it may be a zone marker), so the label alone was read and approved. Text the cell owns under
      // a line of label words, one character included, makes that line a label. 6 pt over 9 pt, and both at 9 pt.
      const OVER_ONE_CHARACTER = [["QTY", "4"], ["NO. REQD", "2"], ["SHEETS", "1"], ["THICKNESS", ".5"], ["PROTECTION", "A"]] as const;
      it.each(OVER_ONE_CHARACTER)("leaves an empty MATERIAL or FINISH empty and flagged, not '%s' over '%s'", (cellLabel, cellValue) => {
        for (const size of [6, 9]) {
          const stacked = (y: number) => [...phrase(cellLabel, 332, y, size), ...value(cellValue, 336, y + (size === 9 ? 11 : 9))];
          const material = [...label("MATERIAL", 330, 720), ...stacked(736), ...label("FINISH", 330, 760), ...value("AS MACHINED", 340, 770)];
          expect(wordRead(material, "material"), `${size} pt`).toMatchObject(FLAGGED);
          expect(wordRead(material, "finish"), `${size} pt`).toMatchObject({ status: "value", value: "AS MACHINED" });
          const finish = [...label("MATERIAL", 330, 700), ...value("AL 6061-T6", 340, 708), ...label("FINISH", 330, 730), ...stacked(746), ...label("SIZE", 600, 700)];
          expect(wordRead(finish, "finish"), `${size} pt`).toMatchObject(FLAGGED);
          expect(wordRead(finish, "material"), `${size} pt`).toMatchObject({ status: "value", value: "AL 6061-T6" });
        }
      });

      it("keeps a lone character under a value out of it, and flags it only under a value of label words", () => {
        for (const text of ["AL 6061-T6", "ANODIZE, BLACK", "MIL-A-8625 TYPE II"]) {
          const words = [...label("FINISH", 330, 730), ...value(text, 340, 738), ...value("4", 345, 750), ...label("SIZE", 600, 700)];
          expect(wordRead(words, "finish"), text).toMatchObject({ status: "value", value: text });
        }
        const labelWords = [...label("FINISH", 330, 730), ...value("AS MACHINED", 340, 738), ...value("4", 345, 750), ...label("SIZE", 600, 700)];
        expect(wordRead(labelWords, "finish")).toMatchObject(FLAGGED);
        // A value of label words whose cell ends at the label of the cell under it (set smaller) is still read.
        const stopped = [...label("FINISH", 330, 730), ...value("AS MACHINED", 340, 738), ...label("QTY", 332, 752), ...value("4", 336, 761), ...label("SIZE", 600, 700)];
        expect(wordRead(stopped, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("reads a first line whose words are set at one size, one word space apart, as the value", () => {
        // The rule above does not touch a value: every word after the first is as large as it and not set apart.
        for (const text of ["AL 6061-T6", "ANODIZE, BLACK, MIL-A-8625F, TYPE II", "STAINLESS STEEL (CRES) 304", "HEAT TREATED 4140"]) {
          const words = [...label("MATERIAL", 330, 720), ...value(text, 340, 728), ...label("FINISH", 330, 760), ...value("AS MACHINED", 340, 768)];
          expect(wordRead(words, "material"), text).toMatchObject({ status: "value", value: text });
        }
      });

      // #884 review, round 5 (MEDIUM 2): a hyphenated label is a label word, and HEAT-TREAT heads another cell.
      it("never joins a stacked cell whose label is hyphenated, at the value's size or smaller", () => {
        for (const [field, cellValue, stacked] of [
          ["material", "AL 6061-T6", "HEAT-TREAT RC 40-45"],
          ["finish", "ANODIZE, BLACK", "X-RAY 100%"],
        ] as const) {
          const top = field === "material" ? "MATERIAL" : "FINISH";
          const same = [...label(top, 330, 720), ...value(cellValue, 340, 728), ...value(stacked, 340, 740), ...label("SIZE", 600, 700)];
          expect(wordRead(same, field), stacked).toMatchObject(FLAGGED);
          const [stackedLabel, ...rest] = stacked.split(" ");
          const smaller = [...label(top, 330, 720), ...value(cellValue, 340, 728), ...label(stackedLabel!, 332, 743), ...value(rest.join(" "), 375, 741), ...label("SIZE", 600, 700)];
          const read = wordRead(smaller, field);
          expect(read.value ?? "", stacked).not.toContain(stackedLabel!);
          expect(read.value === cellValue || read.status === "ambiguous", `${stacked}: ${read.value}`).toBe(true);
        }
      });

      // #884 review, final round: 7 pt labels over 8 pt values are within the 15% that tells a label by its size.
      it("flags a stacked label and its value under a value set less than 15% larger than it", () => {
        const words = [
          ...phrase("MATERIAL", 330, 720, 7),
          ...phrase("AL 6061-T6", 340, 729, 8),
          ...phrase("THICKNESS .125", 332, 739, 7),
          ...phrase("FINISH", 330, 760, 7),
          ...phrase("AS MACHINED", 340, 769, 8),
        ];
        expect(wordRead(words, "material")).toMatchObject(FLAGGED);
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      // A label no title block uses, so no list can know it: only its shape keeps it out of the value.
      it("flags a cell whose label no vocabulary knows, at any size and with or without its own value", () => {
        for (const stacked of [label("FROBNITZ", 332, 750), value("FROBNITZ", 332, 750), value("FROBNITZ", 340, 750), value("FROBNITZ X-77", 332, 750)]) {
          const words = [...label("FINISH", 330, 730), ...value("ANODIZE, BLACK", 340, 738), ...stacked, ...label("SIZE", 600, 700)];
          const read = wordRead(words, "finish");
          expect(read.value === "ANODIZE, BLACK" || read.status === "ambiguous", read.value ?? "").toBe(true);
          expect(read.value ?? "").not.toMatch(/FROBNITZ/);
        }
      });
    });

    describe("on layout text", () => {
      it.each(UNLISTED)("flags a material with an empty %s cell under it, and never joins it", (word) => {
        const sheet = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6"]], [[0, word]], [[0, "FINISH"]], [[2, "AS MACHINED"]]);
        expect(cell(sheet, "material")).toMatchObject(FLAGGED);
        expect(infer(sheet).material).toMatchObject({ value: null, reviewNeeded: true });
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
        const blank = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6"]], "", [[0, word]], [[0, "FINISH"]], [[2, "AS MACHINED"]]);
        expect(cell(blank, "material")).toMatchObject(FLAGGED);
      });

      it.each(UNLISTED)("flags a finish with a %s cell and its value under it", (word) => {
        const sheet = layoutSheet([[0, "FINISH"]], [[2, "BLACK ANODIZE"]], [[0, word]], [[2, "NONE"]], [[100, "SIZE"]]);
        expect(cell(sheet, "finish")).toMatchObject(FLAGGED);
        // Flagged; a finish word elsewhere ("PAINT") may still be offered as a flagged suggestion, as on main.
        expect(infer(sheet).finish.reviewNeeded).toBe(true);
        expect(infer(sheet).finish.value ?? "").not.toMatch(/ANODIZE|NONE/);
      });

      it.each(UNLISTED)("leaves an empty FINISH empty and flagged, not '%s' and the value under it", (word) => {
        for (const under of ["PASSIVATE", "RC 40-45", ".125", "L-4412"]) {
          const sheet = layoutSheet([[0, "FINISH"]], "", [[0, word]], [[2, under]], [[100, "SIZE"]]);
          expect(cell(sheet, "finish"), under).toMatchObject(FLAGGED);
        }
      });

      it("flags a wrapped value with a line shaped like a label: on layout text it looks like a label over its value", () => {
        expect(cell(layoutSheet([[0, "MATERIAL"]], [[2, "ALUMINUM"]], [[2, "6061-T6"]]), "material")).toMatchObject(FLAGGED);
        expect(cell(layoutSheet([[0, "FINISH"]], [[2, "ANODIZE"]], [[2, "CLASS 2"]]), "finish")).toMatchObject(FLAGGED);
        // One line shaped like a label is a value, as before.
        expect(cell(layoutSheet([[0, "FINISH"]], [[2, "AS MACHINED"]], [[100, "SIZE"]]), "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      // #884 review, final round (b): the stacked cell's label printed with its own value on its line, or with a digit or
      // a bracket in it, is not a line of letters, but it starts with one. It is never joined to the value above it.
      it.each(["THICKNESS .125", "THICKNESS (IN)", "SURFACE ROUGHNESS (Ra)", "LOT CODE A123", "PAINT RAL 9005", "QTY 4", "FROBNITZ X-77", "HEAT-TREAT RC 40-45", "X-RAY 100%"])(
        "flags a material or finish with '%s' stacked under its value",
        (stacked) => {
          for (const column of [0, 2]) {
            const material = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6"]], [[column, stacked]], [[0, "FINISH"]], [[2, "AS MACHINED"]]);
            expect(cell(material, "material"), `at ${column}`).toMatchObject(FLAGGED);
            expect(infer(material).material, `at ${column}`).toMatchObject({ value: null, reviewNeeded: true });
            expect(cell(material, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
            const finish = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE, BLACK"]], [[column, stacked]], [[100, "SIZE"]]);
            expect(cell(finish, "finish"), `at ${column}`).toMatchObject(FLAGGED);
            const twoRuns = stacked.replace(" ", "   ");
            expect(cell(layoutSheet([[0, "FINISH"]], [[2, "MIL-A-8625 TYPE II"]], [[column, twoRuns]], [[100, "SIZE"]]), "finish"), twoRuns).toMatchObject(FLAGGED);
          }
        },
      );

      // #884 review, final round (a), as layout text: the label and its value set apart on the first line of an empty cell.
      it.each([
        "THICKNESS   .125",
        "LOT CODE    A123",
        "PAINT   RAL 9005",
        "QTY      4",
        // #884 review, round 5: a label word that is not letters only.
        "THICKNESS (IN)   .125",
        "WT (LB)   2.5",
        "LOT #    A123",
        "HEAT-TREAT   RC 40-45",
        "ROUGHNESS (Ra)   63",
        "# REQD     4",
      ])("leaves an empty MATERIAL empty and flagged, not '%s'", (stacked) => {
        const sheet = layoutSheet([[0, "MATERIAL"]], [[0, stacked]], [[0, "FINISH"]], [[2, "AS MACHINED"]]);
        expect(cell(sheet, "material")).toMatchObject(FLAGGED);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      // #884 review, round 5: a label with a bracketed unit or a number sign is a line of label words, so with its value
      // under it in an empty cell it is flagged, as "THICKNESS" over ".125" is.
      it.each(["THICKNESS (IN)", "WT (LB)", "LOT #", "HEAT-TREAT", "X-RAY"])("leaves an empty MATERIAL empty and flagged, not '%s' over its value", (stacked) => {
        const sheet = layoutSheet([[0, "MATERIAL"]], [[0, stacked]], [[2, ".125"]], [[0, "FINISH"]], [[2, "AS MACHINED"]]);
        expect(cell(sheet, "material")).toMatchObject(FLAGGED);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      // #884 review, round 6 (HIGH 1), as layout text: the stacked label over a value of one character, or with it on its
      // own line, inside the cell's reach (owned, but too far to join) or past it (owned by no cell).
      it.each([["QTY", "4"], ["NO. REQD", "2"], ["SHEETS", "1"], ["THICKNESS", ".5"], ["PROTECTION", "A"]])(
        "leaves an empty MATERIAL or FINISH empty and flagged, not '%s' with '%s'",
        (cellLabel, cellValue) => {
          const material = layoutSheet([[0, "MATERIAL"]], [[0, cellLabel]], [[2, cellValue]], [[0, "FINISH"]], [[2, "AS MACHINED"]]);
          expect(cell(material, "material")).toMatchObject(FLAGGED);
          expect(infer(material).material).toMatchObject({ value: null, reviewNeeded: true });
          expect(cell(material, "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
          const finish = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6"]], [[0, "FINISH"]], [[0, cellLabel]], [[2, cellValue]]);
          expect(cell(finish, "finish")).toMatchObject(FLAGGED);
          expect(infer(finish).finish).toMatchObject({ value: null, reviewNeeded: true });
          expect(cell(finish, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
          for (const column of [cellLabel.length + 6, 18, 30, 60]) {
            const beside = layoutSheet([[0, "MATERIAL"]], [[0, cellLabel], [column, cellValue]], [[0, "FINISH"]], [[2, "AS MACHINED"]]);
            expect(cell(beside, "material"), `at ${column}`).toMatchObject({ status: "ambiguous", value: null });
          }
        },
      );

      it("fences a neighbour-cell word after one word of letters, beside or under an empty cell", () => {
        for (const text of ["SURFACE TREATMENT", "PAINT COLOR", "NO HEAT TREAT", "CASE HARDNESS"]) {
          expect(cell(layoutSheet([[0, "MATERIAL"]], [[0, text]], [[0, "FINISH"]], [[2, "AS MACHINED"]]), "material"), text).toMatchObject(FLAGGED);
          expect(cell(layoutSheet([[0, "MATERIAL"], [12, text]]), "material"), text).toMatchObject(FLAGGED);
        }
        // Two words before it, or a word that only starts like one, is not a fence.
        expect(cell(layoutSheet([[0, "FINISH"], [10, "BLACK ANODIZE COLOR"]]), "finish")).toMatchObject({ status: "value", value: "BLACK ANODIZE COLOR" });
        expect(cell(layoutSheet([[0, "FINISH"], [10, "CLEAR COLORED"]]), "finish")).toMatchObject({ status: "value", value: "CLEAR COLORED" });
      });
    });
  });

  // #884 review, round 11 (MEDIUM 1): a template that centres its values in wide cells prints a value past its label's
  // reach, so no cell owns it. The label of a cell stacked under it at the cell's left edge (6 pt QTY, its own value
  // centred too) was then the only text the cell owned, read as the material or finish and approved. Text that no cell
  // owns in the cell's rows, right of where that line starts, flags a first line of label words only.
  describe("a value centred past its label's reach, with a stacked cell at the left edge", () => {
    const FLAGGED = { status: "ambiguous", value: null, reason: "unlisted_label" } as const;
    // Eight 9 pt words: the text height is 9.9 pt and a column 3.96 pt. MATERIAL (6 pt, from 330 pt) ends at 356.4 pt,
    // column 90; its reach ends at column 98 (388 pt), and text no cell owns counts up to column 130 (515 pt).
    const page = ["ABC", "DEF", "GHI", "JKL", "MNO", "PQR", "STU", "VWX"].flatMap((text, index) => phrase(text, 60 + index * 40, 60, 9));
    const label = (text: string, x: number, y: number, size = 6) => phrase(text, x, y, size);
    const value = (text: string, x: number, y: number) => phrase(text, x, y, 9);
    const materialSheet = (valueX: number | null, qtyValueX: number, qtySize = 6) => [
      ...page,
      ...label("MATERIAL", 330, 720),
      ...(valueX === null ? [] : value("AL 6061-T6", valueX, 728)),
      ...label("QTY", 332, 742, qtySize),
      ...value("4", qtyValueX, 748),
      ...label("FINISH", 330, 765),
      ...value("AS MACHINED", 340, 775),
    ];

    it.each([400, 420, 460, 500])("flags a material whose value starts at %i pt, with QTY over a centred 4 under it", (x) => {
      expect(wordRead(materialSheet(x, x + 20), "material")).toMatchObject(FLAGGED);
      expect(wordRead(materialSheet(x, x + 20), "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
    });

    it("still reads a value that starts inside the label's reach, over the stacked cell", () => {
      expect(wordRead(materialSheet(380, 400), "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
    });

    it.each([6, 9])("flags an empty material over a %i pt QTY whose 4 is centred", (size) => {
      expect(wordRead(materialSheet(null, 420, size), "material")).toMatchObject(FLAGGED);
    });

    it.each([400, 440])("flags a finish whose value starts at %i pt, with QTY over a centred 4 under it", (x) => {
      const words = [...page, ...label("FINISH", 330, 750), ...value("ANODIZE, BLACK", x, 758), ...label("QTY", 332, 772), ...value("4", x + 20, 778)];
      expect(wordRead(words, "finish")).toMatchObject(FLAGGED);
    });

    describe("what does not count", () => {
      const finish = (extra: PdfWord[]) => [...page, ...label("FINISH", 330, 750), ...value("AS MACHINED", 340, 758), ...extra];

      it("flags a value of label words only with text that no cell owns right of it on the line under it (the price)", () => {
        expect(wordRead(finish(value("XYZ", 420, 772)), "finish")).toMatchObject(FLAGGED);
      });

      it("reads it when that text is more than 40 columns past the label, after the next cell, or on the value's own line", () => {
        // FINISH ends at column 88.3: 40 columns past it is 508 pt.
        expect(wordRead(finish(value("XYZ", 560, 772)), "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
        // SIZE at 400 pt begins the next cell on that line.
        expect(wordRead(finish([...label("SIZE", 400, 772), ...value("XYZ", 480, 772)]), "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
        expect(wordRead(finish(value("XYZ", 420, 758)), "finish")).toMatchObject({ status: "value", value: "AS MACHINED" });
      });

      it("does not look at a value that is not only label words", () => {
        const words = [...page, ...label("FINISH", 330, 750), ...value("ANODIZE, BLACK", 340, 758), ...value("XYZ", 420, 772)];
        expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK" });
      });
    });

    it("flags the same sheets on layout text", () => {
      expect(cell(layoutSheet([[0, "MATERIAL"]], [[2, "QTY"]], [[30, "4"]]), "material")).toMatchObject(FLAGGED);
      expect(cell(layoutSheet([[0, "MATERIAL"]], [[28, "AL 6061-T6"]], [[2, "QTY"]], [[30, "4"]]), "material")).toMatchObject(FLAGGED);
      // Past 40 columns it is another cell's, a note's or the border's (see "does not call a short run of letters a label").
      expect(cell(layoutSheet([[0, "MATERIAL"]], [[2, "ALUMINUM"]], [[60, "4"]]), "material")).toMatchObject({ status: "value", value: "ALUMINUM" });
    });

    // #884 review, round 12 (MEDIUM 1): the same failure in the part number and the revision. A drawing number or revision
    // centred past its label's reach belongs to no cell, so the label of an unlisted cell stacked under it at the cell's
    // left edge (QTY, ITEM, STOCK, CUSTOMER) was read as the identifier and the drawing approved. An identifier read from a
    // line under its label that could be a label (label words only, or a part number with no digit) is flagged when the
    // cell holds other text.
    describe("the part number and the revision", () => {
      // DWG. NO. (6 pt, from 330 pt) ends at 356.1 pt, column 89.9: its reach ends at 387.8 pt, and text no cell owns
      // counts up to 514.5 pt. REV ends at 339.9 pt, column 85.8: its reach (4 columns) ends at 355.7 pt.
      const identifierSheet = (labelText: string, valueText: string | null, valueX: number, stacked: string, stackedValueX: number | null) => [
        ...page,
        ...label(labelText, 330, 720),
        ...(valueText === null ? [] : value(valueText, valueX, 728)),
        ...label(stacked, 332, 742),
        ...(stackedValueX === null ? [] : value("12", stackedValueX, 748)),
        ...label("SCALE", 330, 765),
      ];

      it.each(["QTY", "ITEM", "STOCK", "CUSTOMER"])("flags the part number, not a stacked %s, when the drawing number is centred past DWG. NO.", (stacked) => {
        for (const x of [400, 460, 500]) {
          expect(wordRead(identifierSheet("DWG. NO.", "ABC-1001", x, stacked, x + 20), "partNumber"), `${x} pt`).toMatchObject(FLAGGED);
          // The stacked cell alone, its own value not printed: the drawing number between them is still in the cell.
          expect(wordRead(identifierSheet("DWG. NO.", "ABC-1001", x, stacked, null), "partNumber"), `${x} pt, alone`).toMatchObject(FLAGGED);
        }
      });

      it("flags the revision, not a stacked QTY, when the revision is set past REV's reach", () => {
        for (const x of [365, 380, 420]) {
          expect(wordRead(identifierSheet("REV", "B", x, "QTY", x + 2), "revision"), `${x} pt`).toMatchObject(FLAGGED);
          expect(wordRead(identifierSheet("REV", "B", x, "QTY", null), "revision"), `${x} pt, alone`).toMatchObject(FLAGGED);
        }
      });

      it("still reads an identifier inside its label's reach over the stacked cell", () => {
        // A stacked line in the identifier's own columns joins it as a second line and flags it (multiple_values): a stacked
        // value of two characters under the drawing number, or QTY right under the revision. These are clear of it.
        expect(wordRead(identifierSheet("DWG. NO.", "ABC-1001", 380, "QTY", null), "partNumber")).toMatchObject({ status: "value", value: "ABC-1001" });
        expect(wordRead(identifierSheet("REV", "B", 345, "QTY", 400), "revision")).toMatchObject({ status: "value", value: "B" });
      });

      it("reads an identifier of letters only when nothing else is in its cell", () => {
        const alone = (labelText: string, valueText: string) => [...page, ...label(labelText, 330, 720), ...value(valueText, 332, 728), ...label("SCALE", 330, 742)];
        expect(wordRead(alone("REV", "AB"), "revision")).toMatchObject({ status: "value", value: "AB" });
        expect(wordRead(alone("REV", "NC"), "revision")).toMatchObject({ status: "value", value: "NC" });
        expect(wordRead(alone("DWG. NO.", "ABC-DEF"), "partNumber")).toMatchObject({ status: "value", value: "ABC-DEF" });
        // A part number with a digit is never asked, whatever lies in its cell.
        expect(wordRead([...page, ...label("DWG. NO.", 330, 720), ...value("ABC-1001", 332, 728), ...value("XYZ", 420, 742)], "partNumber")).toMatchObject({
          status: "value",
          value: "ABC-1001",
        });
      });

      it("flags an identifier of letters only with text that no cell owns in its cell (the price)", () => {
        expect(wordRead([...page, ...label("DWG. NO.", 330, 720), ...value("ABC-DEF", 332, 728), ...value("XYZ", 420, 742)], "partNumber")).toMatchObject(FLAGGED);
        expect(wordRead([...page, ...label("REV", 330, 720), ...value("AB", 332, 728), ...value("4", 340, 742)], "revision")).toMatchObject(FLAGGED);
      });

      // A row-form table: each label with its value along its row, past the inline window (six heights of a 6 pt label,
      // 39.6 pt; 12 columns of 9 pt text, 47.5 pt), so no cell owns the values and DWG. NO. owns only the QTY row's label.
      describe("a row-form table", () => {
        const table = (width: number, labelSize: number, valueSize: number, rows: Array<[string, string]>) =>
          rows.flatMap(([labelText, valueText], index) => [
            ...phrase(labelText, 330, 700 + index * 14, labelSize),
            ...(valueText === "" ? [] : phrase(valueText, 330 + width, 700 + index * 14 + (labelSize - valueSize), valueSize)),
          ]);
        const rows: Array<[string, string]> = [["DWG. NO.", "ABC-1001"], ["QTY", "4"], ["REV", "B"], ["MATERIAL", "AL 6061-T6"], ["FINISH", "AS MACHINED"]];

        it.each([
          [80, 6, 9],
          [120, 6, 9],
          [120, 9, 9],
        ])("flags the part number, not QTY, with the values %i pt along rows of %i pt labels and %i pt values", (width, labelSize, valueSize) => {
          const words = [...page, ...table(width, labelSize, valueSize, rows)];
          expect(wordRead(words, "partNumber")).toMatchObject(FLAGGED);
          // Through the whole inference, as the review ran it: no part number from the cell, so the field is flagged.
          const text = buildWordLines(words, 1).map((line) => line.raw).join("\n");
          const pdfText = pdfTextOf(text);
          const signals = inferDrawingSignalsFromPdf({ baseName: "upload", pdfText: { ...pdfText, pages: pdfText.pages.map((sheet) => ({ ...sheet, words })) } });
          expect(signals.partNumber.value).not.toBe("QTY");
          expect(signals.partNumber.reviewNeeded).toBe(true);
          expect(signals.reviewFields).toContain("partNumber");
        });

        it("flags it by the value on its own row or the label's when the rows under it hold their values inline", () => {
          // REV's value is its own (inline), so the only text no cell owns in the cell's rows is on the QTY row and on the
          // DWG. NO. row itself.
          const words = [...page, ...table(120, 9, 9, [["DWG. NO.", "ABC-1001"], ["QTY", "4"]]), ...phrase("REV", 330, 728, 9), ...phrase("B", 355, 728, 9)];
          expect(wordRead(words, "partNumber")).toMatchObject(FLAGGED);
          expect(wordRead(words, "revision")).toMatchObject({ status: "value", value: "B" });
          const labelRowOnly = [...page, ...table(120, 9, 9, [["DWG. NO.", "ABC-1001"], ["QTY", ""]]), ...phrase("REV", 330, 728, 9), ...phrase("B", 355, 728, 9)];
          expect(wordRead(labelRowOnly, "partNumber")).toMatchObject(FLAGGED);
        });
      });

      it("flags the same sheets on layout text", () => {
        expect(cell(layoutSheet([[0, "DWG. NO."]], [[28, "ABC-1001"]], [[2, "QTY"], [30, "12"]]), "partNumber")).toMatchObject(FLAGGED);
        expect(cell(layoutSheet([[0, "DWG. NO."]], [[28, "ABC-1001"]], [[2, "CUSTOMER"]]), "partNumber")).toMatchObject(FLAGGED);
        expect(cell(layoutSheet([[0, "REV"]], [[10, "B"]], [[1, "QTY"]]), "revision")).toMatchObject(FLAGGED);
        expect(cell(layoutSheet([[0, "DWG. NO."], [20, "REV"]], [[0, "ABC-DEF"], [20, "AB"]], [[0, "SCALE"]]), "partNumber")).toMatchObject({
          status: "value",
          value: "ABC-DEF",
        });
      });
    });
  });

  // A label and its value printed as one word, with a colon and no blank between ("MATERIAL:ALUMINUM", "REV:A") (Codex
  // review of #884): the label is the text up to and with the colon, and the rest of the word is the value.
  describe("a label and its value printed as one word", () => {
    it("reads the value after the colon from word boxes", () => {
      const words = [...phrase("MATERIAL:ALUMINUM", 330, 720), ...phrase("DWG NO:ABC-001", 500, 720), ...phrase("REV:A", 700, 720)];
      expect(wordRead(words, "material")).toMatchObject({ status: "value", value: "ALUMINUM" });
      expect(wordRead(words, "partNumber")).toMatchObject({ status: "value", value: "ABC-001" });
      expect(wordRead(words, "revision")).toMatchObject({ status: "value", value: "A" });
    });

    it("reads it from layout text", () => {
      const sheet = layoutSheet([[0, "MATERIAL:ALUMINUM"], [30, "DWG NO:ABC-001"], [50, "REV:A"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "ALUMINUM" });
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "value", value: "ABC-001" });
      expect(cell(sheet, "revision")).toMatchObject({ status: "value", value: "A" });
      expect(infer(sheet)).toMatchObject({ partNumber: { value: "ABC-001" }, revision: { value: "A" }, material: { value: "ALUMINUM" } });
    });

    it("places the value where its characters are in the word's box, so it is the label's inline value", () => {
      // The word box runs past where the label ends; the value starts where its own characters start.
      const words = [...phrase("FINISH:ANODIZE", 330, 730, 6)];
      expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "ANODIZE", valueLines: [1] });
    });

    it("keeps a word that only starts with a label and has no colon a value or nothing, as before", () => {
      expect(cell(layoutSheet([[0, "DWG. NO."], [10, "REV-B"]]), "partNumber")).toMatchObject({ status: "value", value: "REV-B" });
      expect(read(layoutSheet([[0, "MATERIALS LIST"]])).filter((candidate) => candidate.field === "material")).toHaveLength(0);
    });
  });

  // A wrapped line is read to its end (OVD-989 review): the words after the first one that sits under the line above
  // continue it along their own line, even when they run past where the line above ends.
  describe("a wrapped line that is wider than the line above it", () => {
    const label = (text: string, x: number, y: number) => phrase(text, x, y, 6);
    const value = (text: string, x: number, y: number) => phrase(text, x, y, 9);

    it("reads 'ANODIZE, BLACK' over 'MIL-A-8625 TYPE III' whole", () => {
      const words = [...label("FINISH", 330, 730), ...value("ANODIZE, BLACK", 340, 738), ...value("MIL-A-8625 TYPE III", 340, 750)];
      expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "ANODIZE, BLACK MIL-A-8625 TYPE III", valueLines: [2, 3] });
      // A first line of letters only with a line under it is the shape of a label over its value ("THICKNESS" over
      // ".125"), whatever size either is set in, so "ANODIZE" over the same line is flagged.
      const lettersOnly = [...label("FINISH", 330, 730), ...value("ANODIZE", 340, 738), ...value("MIL-A-8625 TYPE III", 340, 750)];
      expect(wordRead(lettersOnly, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unlisted_label" });
    });

    it("reads it whole through the signals, and does not store a cut specification", () => {
      const words = [...label("FINISH", 330, 730), ...value("ANODIZE, BLACK", 340, 738), ...value("MIL-A-8625 TYPE III", 340, 750)];
      const signals = inferDrawingSignalsFromPdf({
        baseName: "upload",
        pdfText: { pageCount: 1, pageCountKnown: true, drawingFullyRead: true, ocr: false, pages: [{ page: 1, text: "FINISH", ocrText: "", ocrStatus: "ok", words }] },
      });
      expect(signals.finish).toMatchObject({ value: "ANODIZE, BLACK MIL-A-8625 TYPE III", reviewNeeded: false });
    });

    it("reads three lines, each wider than the one above", () => {
      // The value beside its label, so its wrapped lines start where it starts, a label's width from the stack's edge.
      const words = [
        ...label("FINISH", 330, 730),
        ...value("HARD COAT,", 356, 729),
        ...value("ANODIZE TYPE II,", 356, 741),
        ...value("PER MIL-A-8625 CLASS 2", 356, 753),
      ];
      expect(wordRead(words, "finish")).toMatchObject({ status: "value", value: "HARD COAT, ANODIZE TYPE II, PER MIL-A-8625 CLASS 2" });
    });

    it("gives no value when a word the cell owns is too far along the line to be part of the value", () => {
      // A wide label ("FINISH/COATING") has a wide cell, so a word far along the line is still in it; the value
      // has no way to take it, and a value that left it out would be cut short.
      const words = [...label("FINISH/COATING", 20, 100), ...value("AB", 24, 115), ...value("CD", 90, 115)];
      expect(wordRead(words, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unconsumed_text" });
    });

    it("keeps layout text as it was: a run apart from the line above is flagged, not joined", () => {
      const sheet = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE"]], [[2, "MIL-A-8625"], [20, "TYPE III"]]);
      expect(cell(sheet, "finish")).toMatchObject({ status: "ambiguous", value: null, reason: "unconsumed_text" });
    });
  });

  // The last line of a block is a revision as often as it is a zone marker: "A" under REV is read, and the border's
  // "1" is not (OVD-985 review). Only the marker row above it says which.
  describe("a single character on the last line of the block", () => {
    const MARKER_ROW: Piece[] = [[0, "8"], [20, "7"], [40, "6"], [60, "5"], [80, "4"]];

    it.each([
      ["directly under REV", layoutSheet([[0, "DWG. NO."], [12, "ABC-001"]], [[0, "REV"]], [[0, "A"]]), "A"],
      ["under REV after a blank line", layoutSheet([[0, "DWG. NO."], [12, "ABC-001"]], [[0, "REV"]], "", [[0, "A"]]), "A"],
      ["a digit under REV", layoutSheet([[0, "DWG. NO."], [12, "ABC-001"]], [[0, "REV"]], [[0, "2"]]), "2"],
    ])("reads the revision %s, whether or not a line follows it", (_name, sheet, value) => {
      expect(cell(sheet, "revision")).toMatchObject({ status: "value", value });
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "value", value: "ABC-001" });
      expect(cell(`${sheet}\n${layoutLine([60, "SHEET 1 OF 1"])}`, "revision")).toMatchObject({ status: "value", value });
      expect(infer(sheet).revision).toMatchObject({ value, reviewNeeded: false });
    });

    it("reads the revision under REV from word boxes when it is the last line", () => {
      const words = [...phrase("DWG. NO.", 20, 600, 6), ...phrase("ABC-001", 60, 600, 9), ...phrase("REV", 20, 620, 6), ...phrase("A", 20, 632, 9)];
      expect(wordRead(words, "revision")).toMatchObject({ status: "value", value: "A" });
      expect(wordRead(words, "partNumber")).toMatchObject({ status: "value", value: "ABC-001" });
    });

    it("still drops the border's lone marker when the marker row is the line above it", () => {
      const sheet = layoutSheet([[0, "DWG. NO."], [12, "ABC-001"], [40, "REV"]], "", MARKER_ROW, [[41, "1"]]);
      expect(cell(sheet, "revision")).toMatchObject({ status: "empty", value: null });
      expect(infer(sheet).revision.reviewNeeded).toBe(true);
    });

    it("drops the lone marker from word boxes too", () => {
      const words = [
        ...phrase("DWG. NO.", 20, 600, 6),
        ...phrase("ABC-001", 60, 600, 9),
        ...phrase("REV", 300, 600, 6),
        ...["8", "7", "6", "5", "4", "3", "2"].map((mark, index) => box(mark, 40 + index * 45, 700, 7)),
        box("1", 302, 712, 7),
      ];
      expect(wordRead(words, "revision")).toMatchObject({ status: "empty", value: null });
    });
  });

  // The bounds that decide a value (OVD-989), each pinned at its edge.
  describe("the bounds of a value", () => {
    const words = (length: number) => "ALUMINUM ".repeat(20).slice(0, length);

    it("reads a material of 120 characters and rejects one of 121", () => {
      expect(words(120).endsWith(" ")).toBe(false);
      expect(cell(layoutSheet([[0, "MATERIAL"]], [[0, words(120)]]), "material")).toMatchObject({ status: "value", value: words(120) });
      expect(cell(layoutSheet([[0, "MATERIAL"]], [[0, words(121)]]), "material")).toMatchObject({ status: "rejected", reason: "bad_shape" });
    });

    it("tells a label from a value only up to 200 characters", () => {
      expect(isLabelLikeToken("Q.A. ".repeat(40))).toBe(true);
      expect(isLabelLikeToken("Q.A. ".repeat(41))).toBe(false);
    });

    it("takes a run of letters for a label up to 41 characters, with text under it", () => {
      const letters = (length: number) => `${"A".repeat(20)} ${"B".repeat(length - 21)}`;
      const sheet = (length: number) => layoutSheet([[0, "MATERIAL"], [12, letters(length)]], [[14, "RC 40-45"]]);
      expect(letters(41)).toHaveLength(41);
      // Fenced on the label's line (hasOwnCellOnItsLine), before any value line is chosen.
      expect(cell(sheet(41), "material")).toMatchObject({ status: "ambiguous", reason: "unlisted_label", valueLines: [] });
      // Past the bound the run is not fenced there; the line under it, which starts with words of letters and not where
      // the run starts, is still never joined to it (stackedLineVerdict), whatever the run's length.
      expect(cell(sheet(42), "material")).toMatchObject({ status: "ambiguous", reason: "unlisted_label", valueLines: [1] });
    });

    // The window after a label in which text is its own value is six heights of the LABEL's own text, however tall
    // the other words on the line are: a 24 pt word on the same line must not widen it.
    it("sizes the inline window by the label's own words, not the tallest word of its line", () => {
      const label = (text: string, x: number, y = 100) => phrase(text, x, y, 6);
      const page = [...phrase("ABC", 60, 60, 9), ...phrase("DEF", 120, 60, 9), ...phrase("GHI", 180, 60, 9), ...phrase("JKL", 240, 60, 9)];
      // poppler puts the 24 pt word on a line of its own, just under the label's. It is far right of the cell: within
      // 40 columns of the label it would be text no cell owns in the rows of a value of letters only, which flags it
      // (#884 review, round 11: unownedTextInCell), as the last assertion pins.
      const tall = phrase("B", 760, 100, 24);
      // MATERIAL ends 6 * 6 * 0.55 * 8 = 26.4 pt after it starts; the value begins 44 pt later, past six label heights
      // (6 * 6.6 = 39.6 pt) and inside the 12 columns of a window sized by the 24 pt word (47.5 pt).
      const material = label("MATERIAL", 330);
      const labelEnd = Math.max(...material.map((word) => word.xMax));
      expect(wordRead([...page, ...material, ...phrase("ZINC", labelEnd + 44, 100, 9), ...tall], "material")).toMatchObject({ status: "empty", value: null });
      expect(wordRead([...page, ...material, ...phrase("ZINC", labelEnd + 20, 100, 9), ...tall], "material")).toMatchObject({ status: "value", value: "ZINC" });
      const near = phrase("B", 500, 100, 24);
      expect(wordRead([...page, ...material, ...phrase("ZINC", labelEnd + 20, 100, 9), ...near], "material")).toMatchObject({
        status: "ambiguous",
        reason: "unlisted_label",
      });
    });
  });

  // Codex review of #884, round 6: a line over MAX_LINE_LENGTH (2,000 characters) is not read, and the cells around it
  // are not read across it (crossesUnreadLine; the cap itself is pinned in titleBlockCells.hostile.test.ts).
  describe("a line too long to read", () => {
    const oversized = (text: string) => `${text}${" ".repeat(2_000)}OTHER`;

    it("is no way for a cell to own the text under it", () => {
      const sheet = ["MATERIAL", oversized("FINISH"), "ANODIZE"].join("\n");
      expect(read(sheet)).toEqual([expect.objectContaining({ field: "material", status: "ambiguous", value: null, reason: "unread_line" })]);
      expect(infer(sheet).material).toMatchObject({ value: null, reviewNeeded: true });
      expect(infer(sheet).reviewFields).toEqual(expect.arrayContaining(["material", "finish"]));
      // Under the cap the line is read: FINISH ends MATERIAL's cell and owns ANODIZE.
      const short = ["MATERIAL", `FINISH${" ".repeat(1_900)}OTHER`, "ANODIZE"].join("\n");
      expect(read(short).map((cellRead) => [cellRead.field, cellRead.status, cellRead.value])).toEqual([
        ["material", "empty", null],
        ["finish", "value", "ANODIZE"],
      ]);
    });

    it("is no end of a value above it either: the line may hold the rest of it", () => {
      expect(cell(["MATERIAL", "  AL 6061-T6", oversized("FINISH"), "ANODIZE"].join("\n"), "material")).toMatchObject({
        status: "ambiguous",
        value: null,
        reason: "unread_line",
      });
    });

    it("is the same on word boxes", () => {
      const words = [...phrase("MATERIAL", 330, 720, 6), ...phrase(`FINISH ${"X".repeat(2_000)}`, 330, 740, 6), ...phrase("ANODIZE", 340, 760, 9)];
      expect(buildWordLines(words, 1).some((line) => line.raw.length > 2_000)).toBe(true);
      expect(wordRead(words, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "unread_line" });
      // Word boxes give true positions, so a long line just above a label is not where its value can be.
      const above = [...phrase(`NOTE ${"X".repeat(2_000)}`, 330, 700, 6), ...phrase("MATERIAL", 330, 720, 6), ...phrase("AL 6061-T6", 340, 730, 9)];
      expect(wordRead(above, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
    });
  });

  describe("isLabelLikeToken", () => {
    it.each([
      "Q.A.", "q.a.", "QA", "Q.C.", "CHECKED", "Checked", "DRAWN", "APPROVED", "ENG", "ENG.", "MFG", "ENG APPR.", "MFG APPR.",
      "QA APPR.", "DWG. NO.", "REV", "SIZE", "SCALE", "NAME", "DATE", "MATERIAL", "FINISH", "SURFACE FINISH", "SHEET", "TITLE:",
    ])("is true for the label %s", (value) => {
      expect(isLabelLikeToken(value)).toBe(true);
    });

    it.each([
      "A", "B", "02", "C2", "1093-05589", "ABC-0001", "ALUMINUM 6061-T6", "AS MACHINED", "6061 Alloy", "ENG-1234",
      "REV-B", "QA-77", "MFG-9", "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2", "", "-", "ACM", "ABC",
    ])("is false for the value %s", (value) => {
      expect(isLabelLikeToken(value)).toBe(false);
    });
  });
});
