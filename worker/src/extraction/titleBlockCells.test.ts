// @vitest-environment node
//
// OVD-985 and OVD-989: the title block is read by the cell each label owns. These tests use controlled
// `pdftotext -layout` text (worker/test-support/titleBlockSheet.ts), so every failure shape is explicit:
// a value several lines below its label, other cells' text in between, approvals labels such as Q.A.
// closest to the label, a label alone in its cell. The real sample drawing runs in sampleDrawing.test.ts
// and a full B-size sheet in titleBlockLayout.test.ts. The caps and the cost on hostile text are in
// titleBlockCells.hostile.test.ts. No model, no network, no poppler.

import { describe, expect, it } from "vitest";
import { phrase } from "../../test-support/pdfWordBoxes";
import { layoutSheet, pdfTextOf, type Piece } from "../../test-support/titleBlockSheet";
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
        [[0, "FINISH"]],
        [[2, "ANODIZE, BLACK, MIL-A-8625F, TYPE II"]],
        [[2, "CLASS 2"]],
        [[0, "MATERIAL"]],
        [[2, "6061-T6"]],
      );
      expect(cell(sheet, "finish").value).toBe("ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2");
      expect(cell(sheet, "material").value).toBe("6061-T6");
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
      const sheet = layoutSheet([[0, "FINISH"]], [[2, "AS MACHINED"]], "", [[8, "4"]]);
      expect(cell(sheet, "finish").value).toBe("AS MACHINED");
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

  // OVD-985 and OVD-989, repair round 1: a value is assigned to a label only when it sits in that label's
  // cell. Text that belongs to no label (a company name, a note, a zone letter, the value of a label the
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

      it("does not read a cell's far run as part of its value (join gap)", () => {
        // 'AB' under the label and 'CD' 15 columns on, still inside the label's reach: the gap is wider than
        // the space inside a value, so CD is another cell.
        const sheet = layoutSheet([[0, "MATERIAL"]], [[0, "AB"], [17, "CD"]]);
        expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "AB" });
      });

      it("joins runs of one value that are a few columns apart (join gap)", () => {
        const sheet = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE"], [12, "TYPE II"]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "ANODIZE TYPE II" });
      });

      it("takes the stray text beside a value for another cell, however it is spaced", () => {
        const sheet = layoutSheet([[0, "FINISH"]], [[2, "AS MACHINED"], [45, "STRAY CELL TEXT"]], [[2, "CLASS 2"]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "AS MACHINED CLASS 2" });
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
      const sheet = layoutSheet([[0, "MATERIAL"], [30, "HEAT TREAT"]], [[2, "AL 6061-T6"], [30, "RC 40-45"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "AL 6061-T6" });
    });

    it("leaves MATERIAL empty when only the unlisted cell beside it has text", () => {
      const sheet = layoutSheet([[0, "MATERIAL"], [30, "HEAT TREAT"]], "", [[30, "RC 40-45"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "empty", value: null });
    });

    it("reads no value for an unlisted label close beside MATERIAL when a value is under MATERIAL too", () => {
      // Within the inline gap the text could be MATERIAL's own value or another cell's label: neither is taken.
      const sheet = layoutSheet([[0, "MATERIAL"], [12, "HEAT TREAT"]], [[2, "AL 6061-T6"], [12, "RC 40-45"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "ambiguous", value: null, reason: "multiple_values" });
    });

    it.each([
      [12, "value"],
      [13, "empty"],
    ] as const)("reads a value %i columns after its label on the same line as a %s", (gap, status) => {
      const sheet = layoutSheet([[0, "DWG. NO."], [8 + gap, "1000-1"]]);
      expect(cell(sheet, "partNumber").status).toBe(status);
    });

    it("keeps a value that is more than 3 lines under the previous line out of the value", () => {
      const sheet = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE"]], "", "", "", [[2, "CLASS 2"]]);
      expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: "ANODIZE" });
      const near = layoutSheet([[0, "FINISH"]], [[2, "ANODIZE"]], "", [[2, "CLASS 2"]]);
      expect(cell(near, "finish")).toMatchObject({ status: "value", value: "ANODIZE CLASS 2" });
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
      const sheet = layoutSheet([[0, "MATERIAL"]], [[2, "AL 6061-T6"]], [[0, "PER ECO 1234 REV C"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "rejected", reason: "label_in_value" });
    });

    it.each(["ZINC PLATING PER ASTM B633", "BLACK COATING", "SEE FINISH NOTE 3"])(
      "keeps the finish %s, whose words are finish labels or fences",
      (finish) => {
        const sheet = layoutSheet([[0, "FINISH"], [8, finish]]);
        expect(cell(sheet, "finish")).toMatchObject({ status: "value", value: finish });
      },
    );
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
      const sheet = layoutSheet([[0, "MATERIAL"]], [[2, "ALUMINUM"]], [[2, "6061-T6"]]);
      expect(cell(sheet, "material")).toMatchObject({ status: "value", value: "ALUMINUM 6061-T6", valueLines: [2, 3] });
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
