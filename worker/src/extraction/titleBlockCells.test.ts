// @vitest-environment node
//
// OVD-985 and OVD-989: the title block is read by the cell each label owns. These tests use controlled
// `pdftotext -layout` text (worker/test-support/titleBlockSheet.ts), so every failure shape is explicit:
// a value several lines below its label, other cells' text in between, approvals labels such as Q.A.
// closest to the label, a label alone in its cell. The real sample drawing runs in sampleDrawing.test.ts
// and a full B-size sheet in titleBlockLayout.test.ts. No model, no network, no poppler.

import { describe, expect, it } from "vitest";
import { layoutSheet, pdfTextOf, type Piece } from "../../test-support/titleBlockSheet";
import { inferDrawingSignalsFromPdf } from "./pdfDrawing";
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
        [[60, "B"], [64, "TPL-VALIDATION-0002-LONG"], [100, "C"]],
      );
      expect(cell(sheet, "partNumber")).toMatchObject({ status: "value", value: "TPL-VALIDATION-0002-LONG" });
      expect(cell(sheet, "revision")).toMatchObject({ status: "value", value: "C" });
    });

    it.each([
      ["a value on the label's line", "DWG. NO. 1000-1  REV A"],
      ["single-space labels and values", "DWG. NO. 1000-1 REV A"],
      ["a colon after the label", "DWG. NO.: 1000-1  REV: A"],
      ["DRAWING NUMBER and REVISION", "DRAWING NUMBER  1000-1  REVISION  A"],
      ["PART NO.", "PART NO.   1000-1   REV   A"],
      ["tab separated cells", "DWG. NO.\t1000-1\tREV\tA"],
      ["wide gaps", layoutSheet([[0, "DWG. NO."], [40, "1000-1"], [80, "REV"], [95, "A"]])],
    ])("reads %s", (_name, sheet) => {
      expect(cell(sheet, "partNumber").value).toBe("1000-1");
      expect(cell(sheet, "revision").value).toBe("A");
    });

    it("reads labels run together on one line and values on the next", () => {
      const sheet = [
        "                      SIZE DWG. NO.                      REV",
        "",
        "                      B                                  C",
        "                          OVD-17",
      ].join("\n");
      expect(cell(sheet, "partNumber").value).toBe("OVD-17");
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
        [[0, "SURFACE FINISH: 63"]],
        [[12, "OR BETTER"]],
        [[20, "INTERPRET IN ACCORDANCE WITH:"]],
        [[0, "FINISH"]],
        [[2, "AS MACHINED"]],
      );
      expect(cell(sheet, "finish").value).toBe("AS MACHINED");
    });

    it("leaves the finish empty and flagged when only the SURFACE FINISH note is near", () => {
      const sheet = layoutSheet(
        [[0, "SURFACE FINISH: 63"]],
        [[12, "OR BETTER"]],
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

    it("does not read a page that is too large, or a line that is too long", () => {
      const bigLine = `DWG. NO.${" ".repeat(1_000_000)}1000-1`;
      expect(read(bigLine)).toEqual([]);
      const manyLines = Array.from({ length: 5_000 }, (_, index) => (index === 0 ? "DWG. NO." : "  1000-1")).join("\n");
      expect(read(manyLines)).toEqual([]);
    });

    it("stays fast on a page of many runs", () => {
      const row = Array.from({ length: 150 }, (_, index) => `x${index}`).join("   ");
      const sheet = Array.from({ length: 200 }, () => row).join("\n");
      const started = Date.now();
      read(sheet);
      expect(Date.now() - started).toBeLessThan(2_000);
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
      "A", "B", "02", "C2", "1093-05589", "TPL-0001", "ALUMINUM 6061-T6", "AS MACHINED", "6061 Alloy", "ENG-1234",
      "REV-B", "QA-77", "MFG-9", "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2", "", "-", "ACM", "ABC",
    ])("is false for the value %s", (value) => {
      expect(isLabelLikeToken(value)).toBe(false);
    });
  });
});
