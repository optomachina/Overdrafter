// @vitest-environment node
//
// OVD-985 and OVD-989: small synthetic PDFs written for the tests (worker/test-support/minimalPdf.ts) and read
// by real poppler: pdftotext -layout for the text, pdftotext -bbox for the word boxes. They cover what the text
// level tests cannot: that poppler's own layout and boxes, on a sheet with a 24 pt drawing number beside 6 pt
// labels, a rotated page, and a sheet drawn at another size, give the cells the geometry the reader expects.
//
// Tier: real poppler, synthetic files with placeholder text only; no model, no network. Skipped, not passed,
// when poppler is not installed (CI installs poppler-utils).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dimensionField, minimalPdf, syntheticSheet, type MinimalPdfOptions, type PdfTextItem, type SyntheticSheetOptions } from "../../test-support/minimalPdf";
import type { JobFileRecord, PartRecord } from "../types";
import { runHybridExtraction } from "./hybridExtraction";
import { extractPdfText, inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const hasPoppler = hasBinary("pdfinfo") && hasBinary("pdftotext");
// The general-tolerance rows are judged by the dimensions only when the whole drawing was read, its OCR included (T1,
// drawingFullyRead). CI installs tesseract; without it no page is OCR'd, and the four-place row is an unresolved value
// (null) whether a dimension uses four places or not (T3).
const fullyRead = hasBinary("tesseract");
const ROW_DROPPED = fullyRead ? 0.005 : null;
const FOUR_PLACE_ROW = fullyRead ? 0.001 : null;
const LAYOUT_REVIEW_FIELDS = ["partNumber", "revision", "material", "finish"];

// Every test writes a PDF and reads it with poppler and, when it is installed, tesseract: about a second each on
// an idle machine, several on a loaded one, so the default 5 seconds is not a bound the tests can keep.
describe.skipIf(!hasPoppler)("synthetic sheets through poppler", { timeout: 60_000 }, () => {
  let directory = "";
  let counter = 0;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "overdrafter-synthetic-pdf-"));
  });
  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function pdfTextOf(items: readonly PdfTextItem[], options: MinimalPdfOptions = {}): Promise<PdfTextExtraction> {
    counter += 1;
    const file = path.join(directory, `sheet-${counter}.pdf`);
    fs.writeFileSync(file, minimalPdf(items, options));
    const pdfText = await extractPdfText(file);
    expect(pdfText).not.toBeNull();
    return pdfText!;
  }

  async function read(sheet: SyntheticSheetOptions = {}, options: MinimalPdfOptions = {}) {
    const pdfText = await pdfTextOf(syntheticSheet(sheet), options);
    return { pdfText, signals: inferDrawingSignalsFromPdf({ baseName: "upload", pdfText }) };
  }

  const FOUR_PLACE_DIAMETER = "Ø.1875 THRU";

  describe("the sheet as printed", () => {
    it("has word boxes and reads every field and the tolerance", async () => {
      const { pdfText, signals } = await read();
      expect(pdfText.pages[0]?.words?.length).toBeGreaterThan(50);
      expect(signals.partNumber).toMatchObject({ value: "ABC-1001", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "B", reviewNeeded: false });
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
      // No dimension has four places, so the four-place row is not in force.
      expect(signals.tightestToleranceValueInch).toBe(ROW_DROPPED);
    });
  });

  describe("a four-place dimension keeps the four-place row wherever poppler puts it", () => {
    it.each([
      ["on its own line", [{ x: 120, y: 500, size: 9, text: FOUR_PLACE_DIAMETER }]],
      ["level with the table’s TOLERANCES row", [{ x: 120, y: 660, size: 7, text: FOUR_PLACE_DIAMETER }]],
      [
        "level with a view label",
        [{ x: 120, y: 520, size: 9, text: FOUR_PLACE_DIAMETER }, { x: 700, y: 520, size: 9, text: "SECTION A-A  SCALE 2 : 1" }],
      ],
      [
        "level with a surface finish note",
        [{ x: 120, y: 520, size: 9, text: FOUR_PLACE_DIAMETER }, { x: 700, y: 520, size: 9, text: "SURFACE FINISH: 63" }],
      ],
      [
        "level with the unless-otherwise-specified label",
        [{ x: 120, y: 640, size: 7, text: FOUR_PLACE_DIAMETER }, { x: 500, y: 640, size: 7, text: "UNLESS OTHERWISE SPECIFIED:" }],
      ],
      ["glued to a spherical radius sign", [{ x: 120, y: 500, size: 9, text: "SR.0625" }]],
      ["glued to a hole tag", [{ x: 120, y: 500, size: 9, text: ".1875A" }]],
    ] as Array<[string, PdfTextItem[]]>)("reads %s", async (_name, extra) => {
      const { signals } = await read({ extra });
      expect(signals.tightestToleranceValueInch).toBe(FOUR_PLACE_ROW);
      // The table row is what applies; its value is in inches.
      expect(signals.tightestToleranceUnit).toBe(fullyRead ? "in" : "unknown");
    });

    it("drops the row when the same notes carry no four-place number", async () => {
      const { signals } = await read({
        extra: [
          { x: 120, y: 520, size: 9, text: ".375" },
          { x: 700, y: 520, size: 9, text: "SECTION A-A  SCALE 2 : 1" },
          { x: 700, y: 540, size: 9, text: "SURFACE FINISH: 63" },
        ],
      });
      expect(signals.tightestToleranceValueInch).toBe(ROW_DROPPED);
    });
  });

  describe("cells next to the ones being read", () => {
    it("does not take the text of an unlisted cell beside MATERIAL for the material", async () => {
      const { signals } = await read({
        extra: [
          { x: 430, y: 720, size: 6, text: "HEAT TREAT" },
          { x: 440, y: 732, size: 9, text: "RC 40-45" },
        ],
      });
      // Its value is preserved, but an unrecognised neighbouring cell is not a proven boundary.
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: true });
    });

    it("leaves an empty MATERIAL cell empty and flagged, whatever text is around it", async () => {
      const { signals } = await read({
        material: null,
        extra: [
          { x: 420, y: 738, size: 9, text: "EXAMPLE ORG LLC" },
          { x: 420, y: 748, size: 9, text: "100 SAMPLE STREET" },
        ],
      });
      expect(signals.material.value).toBeNull();
      expect(signals.material.reviewNeeded).toBe(true);
      expect(signals.reviewFields).toContain("material");
    });

    it("leaves an empty FINISH cell empty and flagged, with unlabelled text beside it", async () => {
      const { signals } = await read({ finish: null, extra: [{ x: 440, y: 772, size: 9, text: "ANODIZE NOTE" }] });
      expect(signals.finish.value).toBeNull();
      expect(signals.finish.reviewNeeded).toBe(true);
    });

    it("keeps a drawing number with a prefix whole", async () => {
      const { signals } = await read({ drawingNumber: "XYZ-1093-05589" });
      expect(signals.partNumber).toMatchObject({ value: "XYZ-1093-05589", reviewNeeded: false });
      expect(signals.partNumber.reasons).not.toContain("regex_fit");
    });
  });

  // A label the vocabulary does not know, beside a cell that is empty, is another cell's: its text is neither the
  // value nor part of it, and the field is flagged. The labels are 6 pt, the values under them 9 pt.
  describe("an unlisted label beside an empty cell", () => {
    const heatTreat: PdfTextItem[] = [
      { x: 380, y: 720, size: 6, text: "HEAT TREAT" },
      { x: 385, y: 732, size: 9, text: "RC 40-45" },
    ];
    const treatment: PdfTextItem[] = [
      { x: 370, y: 750, size: 6, text: "TREATMENT" },
      { x: 375, y: 760, size: 9, text: "STRESS RELIEVE" },
    ];

    it("leaves MATERIAL empty and flagged, not 'HEAT TREAT RC 40-45'", async () => {
      const { signals } = await read({ material: null, extra: heatTreat });
      expect(signals.material.value).toBeNull();
      expect(signals.material.reviewNeeded).toBe(true);
      expect(signals.reviewFields).toContain("material");
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
    });

    it("leaves FINISH empty and flagged, not 'TREATMENT STRESS'", async () => {
      const { signals } = await read({ finish: null, extra: treatment });
      expect(signals.finish.value).toBeNull();
      expect(signals.finish.reviewNeeded).toBe(true);
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
    });

    // The same sheets as layout text alone (the word-box pass failed or was skipped): no heights, so the cells are
    // told apart by their shapes. Never the unlisted cell's text, never unflagged.
    it("holds on layout text alone (no word boxes)", async () => {
      const layoutOnly = async (items: PdfTextItem[]) => {
        const pdfText = await pdfTextOf(items);
        for (const page of pdfText.pages) {
          delete (page as { words?: unknown }).words;
        }
        return inferDrawingSignalsFromPdf({ baseName: "upload", pdfText });
      };
      const emptyMaterial = await layoutOnly(syntheticSheet({ material: null, extra: heatTreat }));
      expect(emptyMaterial.material).toMatchObject({ value: null, reviewNeeded: true });
      const emptyFinish = await layoutOnly(syntheticSheet({ finish: null, extra: treatment }));
      expect(emptyFinish.finish).toMatchObject({ value: null, reviewNeeded: true });
      for (const size of [10, 12, 14, 16]) {
        const swept = await layoutOnly([
          ...dimensionField(size),
          ...syntheticSheet({ material: null, extra: [{ x: 430, y: 720, size: 6, text: "HEAT TREAT" }, { x: 440, y: 732, size: 9, text: "RC 40-45" }] }),
        ]);
        expect(swept.material, `material at ${size} pt`).toMatchObject({ value: null, reviewNeeded: true });
      }
      const control = await layoutOnly(syntheticSheet());
      expect(control.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: true });
      expect(control.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: true });
    });

    it("never reports the unlisted cell's text for a filled MATERIAL either", async () => {
      const { signals } = await read({ extra: [{ x: 380, y: 720, size: 6, text: "HEAT TREAT" }, { x: 420, y: 732, size: 9, text: "RC 40-45" }] });
      expect(signals.material.reviewNeeded || signals.material.value === "AL 6061-T6").toBe(true);
      expect(signals.material.value ?? "").not.toMatch(/HEAT|RC 40/);
    });

    // The column of the reader is a fraction of the median text height of the page, so it widens on a page of large
    // dimensions; a label 74 pt from the MATERIAL label is not in its inline window at any of these sizes.
    it.each([10, 12, 13, 14, 16, 18])("holds on a page whose dimensions are set in %i pt", async (size) => {
      const label: PdfTextItem[] = [
        { x: 430, y: 720, size: 6, text: "HEAT TREAT" },
        { x: 440, y: 732, size: 9, text: "RC 40-45" },
      ];
      const items = [...dimensionField(size), ...syntheticSheet({ material: null, extra: label })];
      const pdfText = await pdfTextOf(items);
      const signals = inferDrawingSignalsFromPdf({ baseName: "upload", pdfText });
      expect(signals.material.value).toBeNull();
      expect(signals.material.reviewNeeded).toBe(true);
    });
  });

  // An unlisted cell is as often stacked under MATERIAL or FINISH as beside it (OVD-985, OVD-989 review). Its label
  // (6 pt) is not part of the value of the cell above it (9 pt), and when that cell is empty the unlisted cell's label
  // and value are not its value. Through poppler's own boxes the label is set smaller than the value, so a material
  // over an empty cell is the material alone; as layout text alone, which has no sizes, the cell is flagged.
  describe("an unlisted cell stacked under MATERIAL or FINISH", () => {
    const heatTreatOverRc: PdfTextItem[] = [
      { x: 332, y: 734, size: 6, text: "HEAT TREAT" },
      { x: 336, y: 741, size: 9, text: "RC 40-45" },
    ];
    const heatTreatAlone: PdfTextItem[] = [{ x: 332, y: 743, size: 6, text: "HEAT TREAT" }];
    const heatTreatOverNa: PdfTextItem[] = [
      { x: 332, y: 762, size: 6, text: "HEAT TREAT" },
      { x: 336, y: 769, size: 9, text: "N/A" },
    ];
    const heatTreatOverNone: PdfTextItem[] = [
      { x: 332, y: 772, size: 6, text: "HEAT TREAT" },
      { x: 336, y: 780, size: 9, text: "NONE" },
    ];

    async function layoutOnly(sheet: SyntheticSheetOptions) {
      const pdfText = await pdfTextOf(syntheticSheet(sheet));
      for (const page of pdfText.pages) {
        delete (page as { words?: unknown }).words;
      }
      return inferDrawingSignalsFromPdf({ baseName: "upload", pdfText });
    }

    it("leaves an empty MATERIAL empty and flagged, not 'HEAT TREAT RC 40-45'", async () => {
      const { signals } = await read({ material: null, extra: heatTreatOverRc });
      expect(signals.material).toMatchObject({ value: null, reviewNeeded: true });
      expect(signals.reviewFields).toContain("material");
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
    });

    it("leaves an empty FINISH empty and flagged, not 'HEAT TREAT N/A'", async () => {
      const { signals } = await read({ finish: null, extra: heatTreatOverNa });
      expect(signals.finish).toMatchObject({ value: null, reviewNeeded: true });
      expect(signals.reviewFields).toContain("finish");
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
    });

    it("reads a MATERIAL that has an empty HEAT TREAT cell under it as the material alone", async () => {
      const { signals } = await read({ extra: heatTreatAlone });
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
    });

    it("reads a FINISH that has HEAT TREAT and its value under it as the finish alone", async () => {
      const { signals } = await read({ extra: heatTreatOverNone });
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
    });

    it("holds on layout text alone: no sizes, so a cell with the stacked cell under it is flagged, never joined", async () => {
      const emptyMaterial = await layoutOnly({ material: null, extra: heatTreatOverRc });
      expect(emptyMaterial.material).toMatchObject({ value: null, reviewNeeded: true });
      const emptyFinish = await layoutOnly({ finish: null, extra: heatTreatOverNa });
      expect(emptyFinish.finish).toMatchObject({ value: null, reviewNeeded: true });
      const filledMaterial = await layoutOnly({ extra: heatTreatAlone });
      expect(filledMaterial.material.value ?? "").not.toMatch(/HEAT/);
      expect(filledMaterial.material.value === "AL 6061-T6" || filledMaterial.material.reviewNeeded).toBe(true);
      const filledFinish = await layoutOnly({ extra: heatTreatOverNone });
      expect(filledFinish.finish.value ?? "").not.toMatch(/HEAT|NONE/);
      expect(filledFinish.finish.value === "AS MACHINED" || filledFinish.finish.reviewNeeded).toBe(true);
    });

    // #884 review, round 2: a stacked cell whose label the vocabulary does not know, and that starts with no
    // neighbour-cell word (PAINT, THICKNESS), or has one after a word (SURFACE TREATMENT).
    const surfaceTreatmentAlone: PdfTextItem[] = [{ x: 330, y: 775, size: 6, text: "SURFACE TREATMENT" }];
    const paintOverNone: PdfTextItem[] = [
      { x: 330, y: 775, size: 6, text: "PAINT" },
      { x: 340, y: 785, size: 9, text: "NONE" },
    ];
    const thicknessOverValue: PdfTextItem[] = [
      { x: 330, y: 728, size: 6, text: "THICKNESS" },
      { x: 340, y: 738, size: 9, text: ".125" },
    ];

    it("reads a FINISH over an unlisted cell as the finish alone, and never joins the cell's text on layout text", async () => {
      for (const extra of [surfaceTreatmentAlone, paintOverNone]) {
        const { signals } = await read({ extra });
        expect(signals.finish, extra[0]!.text).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
        const layout = await layoutOnly({ extra });
        expect(layout.finish, extra[0]!.text).toMatchObject({ value: null, reviewNeeded: true });
      }
    });

    it("leaves an empty MATERIAL with an unlisted cell under it empty and flagged, not 'THICKNESS .125'", async () => {
      const { signals } = await read({ material: null, extra: thicknessOverValue });
      expect(signals.material).toMatchObject({ value: null, reviewNeeded: true });
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
      const layout = await layoutOnly({ material: null, extra: thicknessOverValue });
      expect(layout.material).toMatchObject({ value: null, reviewNeeded: true });
    });
  });

  // #884 review, final round: a stacked cell whose label (unknown to the vocabulary) is printed with its own value on
  // one line, in the three layouts the reviews built, and a label no list can know. The shape of the line keeps its
  // text out of the value whatever the sizes are: the field is the value alone, or empty and flagged, through poppler's
  // word boxes and through its layout text alone, and never the stacked cell's text approved.
  describe("a stacked cell printed as its label and its own value on one line", () => {
    /** The sheet with FINISH lowered, so that a stacked cell fits between MATERIAL and FINISH. */
    const lowerFinish = (material: string | null, stacked: PdfTextItem[]): PdfTextItem[] => [
      ...syntheticSheet({ material, finish: null }).filter((item) => item.text !== "FINISH"),
      ...stacked,
      { x: 330, y: 765, size: 6, text: "FINISH" },
      { x: 340, y: 775, size: 9, text: "AS MACHINED" },
    ];
    /** Every title-block label set in 9 pt like the values (a template that sets them alike). */
    const sameSize = (items: PdfTextItem[]) => items.map((item) => (item.y >= 715 && item.size === 6 ? { ...item, size: 9 } : item));
    const labelAndValue = (label: string, value: string, y: number, valueX = 380): PdfTextItem[] => [
      { x: 332, y, size: 6, text: label },
      { x: valueX, y: y - 2, size: 9, text: value },
    ];

    /** Signals from poppler's word boxes and from its layout text alone. */
    async function bothSources(items: PdfTextItem[]) {
      const pdfText = await pdfTextOf(items);
      expect(pdfText.pages[0]?.words?.length ?? 0).toBeGreaterThan(0);
      const layoutText = { ...pdfText, pages: pdfText.pages.map(({ words: _words, ...page }) => page) };
      return [
        ["word boxes", inferDrawingSignalsFromPdf({ baseName: "upload", pdfText })],
        ["layout text", inferDrawingSignalsFromPdf({ baseName: "upload", pdfText: layoutText })],
      ] as const;
    }

    it.each([
      ["THICKNESS", ".125"],
      ["LOT CODE", "A123"],
    ])("(a) leaves an empty MATERIAL empty and flagged, not '%s %s'", async (label, value) => {
      for (const [source, signals] of await bothSources(lowerFinish(null, labelAndValue(label, value, 745)))) {
        expect(signals.material, source).toMatchObject({ value: null, reviewNeeded: true });
        expect(signals.reviewFields, source).toContain("material");
        expect(signals.finish, source).toMatchObject({ value: "AS MACHINED", reviewNeeded: source === "layout text" });
      }
    });

    it("(a) leaves an empty FINISH empty and flagged, not 'PAINT' or 'PAINT RAL 9005'", async () => {
      for (const [source, signals] of await bothSources(syntheticSheet({ finish: null, extra: labelAndValue("PAINT", "RAL 9005", 775, 372) }))) {
        expect(signals.finish, source).toMatchObject({ value: null, reviewNeeded: true });
        expect(signals.material, source).toMatchObject({ value: "AL 6061-T6", reviewNeeded: source === "layout text" });
      }
    });

    it.each([
      ["material", "AL 6061-T6", "THICKNESS", ".125"],
      ["material", "AL 6061-T6", "LOT CODE", "A123"],
      ["finish", "ANODIZE, BLACK", "PAINT", "RAL 9005"],
      ["finish", "MIL-A-8625 TYPE II", "QTY", "4"],
    ] as const)("(b) never joins a stacked cell to the %s '%s': '%s %s'", async (field, cellValue, label, value) => {
      const items =
        field === "material"
          ? lowerFinish(cellValue, labelAndValue(label, value, 745))
          : syntheticSheet({ finish: cellValue, extra: labelAndValue(label, value, 775, 372) });
      for (const [source, signals] of await bothSources(items)) {
        // Word boxes: the stacked label is set smaller than the value, so the value ends above it.
        const read = signals[field];
        expect(read.value ?? "", source).not.toContain(label);
        expect(read.value === cellValue || (read.value === null && read.reviewNeeded), `${source}: ${read.value}`).toBe(true);
        if (source === "layout text") {
          expect(read, source).toMatchObject({ value: null, reviewNeeded: true });
        }
      }
    });

    it("(c) flags a finish with 'LOT CODE A123' under it on a template that sets its labels like its values", async () => {
      const items = sameSize(syntheticSheet({ finish: "ANODIZE, BLACK", extra: [{ x: 332, y: 775, size: 9, text: "LOT CODE A123" }] }));
      for (const [source, signals] of await bothSources(items)) {
        expect(signals.finish, source).toMatchObject({ value: null, reviewNeeded: true });
      }
    });

    // Codex review, final round: the stacked label set as large as the value, which is larger than its own label.
    it.each(["PAINT", "THICKNESS", "QTY", "LOT CODE"])("flags a finish with a 9 pt '%s' under its 9 pt value", async (label) => {
      for (const x of [332, 340]) {
        for (const [source, signals] of await bothSources(syntheticSheet({ finish: "ANODIZE", extra: [{ x, y: 772, size: 9, text: label }] }))) {
          expect(signals.finish, `${source} at ${x}`).toMatchObject({ value: null, reviewNeeded: true });
        }
      }
    });

    it("keeps out a label that no vocabulary knows, alone or with its own value", async () => {
      for (const stacked of [
        [{ x: 340, y: 772, size: 9, text: "FROBNITZ" }],
        [{ x: 332, y: 772, size: 9, text: "FROBNITZ X-77" }],
        labelAndValue("FROBNITZ", "X-77", 775, 380),
      ]) {
        for (const [source, signals] of await bothSources(syntheticSheet({ finish: "ANODIZE, BLACK", extra: stacked }))) {
          expect(signals.finish.value ?? "", source).not.toMatch(/FROBNITZ|X-77/);
          expect(signals.finish.value === "ANODIZE, BLACK" || signals.finish.reviewNeeded, `${source}: ${signals.finish.value}`).toBe(true);
        }
      }
    });

    // #884 review, round 5: the sheets the review built, through the whole extraction (runHybridExtraction, no model),
    // from poppler's word boxes and from its layout text alone. The stacked label has a word that is not letters only
    // (a bracket, a number sign, a hyphen); the field is empty, flagged, and the drawing needs review, never approved.
    async function extractBoth(items: PdfTextItem[]) {
      const pdfText = await pdfTextOf(items);
      expect(pdfText.pages[0]?.words?.length ?? 0).toBeGreaterThan(0);
      const layoutText = { ...pdfText, pages: pdfText.pages.map(({ words: _words, ...page }) => page) };
      const extract = (text: PdfTextExtraction) =>
        runHybridExtraction(
          { part: { id: "part", name: "part" } as PartRecord, cadFile: null, drawingFile: { original_name: "bracket.pdf" } as JobFileRecord, pdfText: text },
          { extractWithModel: async () => { throw new Error("model extraction must not run"); } },
        );
      return [
        ["word boxes", await extract(pdfText)],
        ["layout text", await extract(layoutText)],
      ] as const;
    }

    it.each([
      ["THICKNESS (IN)", ".125", 395],
      ["THICKNESS (IN)", ".125", 420],
      ["WT (LB)", "2.5", 395],
      ["HEAT-TREAT", "RC 40-45", 380],
      ["LOT #", "A123", 395],
      ["# REQD", "4", 380],
    ] as const)("(a) leaves an empty MATERIAL empty and flagged, not a 6 pt '%s' by a 9 pt '%s' (at x %s)", async (label, value, x) => {
      for (const [source, result] of await extractBoth(lowerFinish(null, labelAndValue(label, value, 745, x)))) {
        expect(result.material.raw, source).toBeNull();
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["material"]);
        expect(result.status, source).toBe("needs_review");
        expect(result.finish.raw, source).toBe("AS MACHINED");
      }
    });

    it.each([
      ["ROUGHNESS (Ra)", "63", 395],
      ["X-RAY", "100%", 372],
    ] as const)("(a) leaves an empty FINISH empty and flagged, not a 6 pt '%s' by a 9 pt '%s'", async (label, value, x) => {
      for (const [source, result] of await extractBoth(syntheticSheet({ finish: null, extra: labelAndValue(label, value, 775, x) }))) {
        expect(result.finish.raw, source).toBeNull();
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["finish"]);
        expect(result.status, source).toBe("needs_review");
        expect(result.material.raw, source).toBe("AL 6061-T6");
      }
    });

    // #884 review, round 6 (HIGH 1): the stacked label over a value of ONE character, its label at 6 pt or at the value's
    // 9 pt. A single character never joins a value, so the label alone was read and the drawing approved.
    const overOneCharacter = (label: string, value: string, y: number, size: number): PdfTextItem[] => [
      { x: 332, y, size, text: label },
      { x: 340, y: y + (size === 9 ? 12 : 10), size: 9, text: value },
    ];
    it.each([
      ["QTY", "4"],
      ["NO. REQD", "2"],
      ["SHEETS", "1"],
      ["THICKNESS", ".5"],
    ] as const)("(a) leaves an empty MATERIAL empty and flagged, not '%s' over '%s'", async (label, value) => {
      for (const size of [6, 9]) {
        for (const [source, result] of await extractBoth(lowerFinish(null, overOneCharacter(label, value, 741, size)))) {
          expect(result.material.raw, `${source}, ${size} pt`).toBeNull();
          // Layout text: with the MATERIAL cell empty and a 6 pt stacked label, poppler prints four blank lines between the
          // label row and the 24 pt drawing number and revision, its most, so how far under their labels they are is not
          // known and they are flagged too (far_value). Word boxes measure it and read them.
          const flagged = source === "layout text" && size === 6 ? ["partNumber", "revision", "material"] : ["material"];
          expect(result.reviewFields, `${source}, ${size} pt`).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : flagged);
          expect(result.status, `${source}, ${size} pt`).toBe("needs_review");
          expect(result.finish.raw, `${source}, ${size} pt`).toBe("AS MACHINED");
        }
      }
    });

    it("(a) leaves an empty FINISH empty and flagged, not 'QTY' over '4'", async () => {
      for (const size of [6, 9]) {
        for (const [source, result] of await extractBoth(syntheticSheet({ finish: null, extra: overOneCharacter("QTY", "4", 767, size) }))) {
          expect(result.finish.raw, `${source}, ${size} pt`).toBeNull();
          expect(result.reviewFields, `${source}, ${size} pt`).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["finish"]);
          expect(result.status, `${source}, ${size} pt`).toBe("needs_review");
          expect(result.material.raw, `${source}, ${size} pt`).toBe("AL 6061-T6");
        }
      }
    });

    it("never joins a stacked cell whose label is hyphenated to the material or finish above it", async () => {
      const sheets: Array<[field: "material" | "finish", cellValue: string, items: PdfTextItem[]]> = [
        ["material", "AL 6061-T6", lowerFinish("AL 6061-T6", [{ x: 340, y: 744, size: 9, text: "HEAT-TREAT RC 40-45" }])],
        ["material", "AL 6061-T6", lowerFinish("AL 6061-T6", labelAndValue("HEAT-TREAT", "RC 40-45", 745))],
        ["finish", "ANODIZE, BLACK", syntheticSheet({ finish: "ANODIZE, BLACK", extra: [{ x: 340, y: 772, size: 9, text: "X-RAY 100%" }] })],
        ["finish", "ANODIZE, BLACK", syntheticSheet({ finish: "ANODIZE, BLACK", extra: labelAndValue("X-RAY", "100%", 775, 372) })],
      ];
      for (const [field, cellValue, items] of sheets) {
        for (const [source, result] of await extractBoth(items)) {
          const read = result[field];
          expect(read.raw ?? "", source).not.toMatch(/HEAT-TREAT|X-RAY|RC 40-45|100%/);
          expect(read.raw === cellValue || (read.raw === null && result.reviewFields.includes(field)), `${source}: ${read.raw}`).toBe(true);
        }
      }
    });

    it("still reads and approves the sheet as printed", async () => {
      for (const [source, result] of await extractBoth(syntheticSheet())) {
        expect(result.material.raw, source).toBe("AL 6061-T6");
        expect(result.finish.raw, source).toBe("AS MACHINED");
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : []);
        expect(result.status, source).toBe(source === "layout text" ? "needs_review" : "approved");
      }
    });
  });

  // A revision is the last text of a block as often as the border's marker is: "A" under REV is read, where the
  // border's "1" after a row of markers is not (OVD-985 review).
  // Codex review of #884: a label and its value printed as one word ("MATERIAL:ALUMINUM") is one word box.
  describe("a label and its value printed as one word", () => {
    it("reads the value after the colon from poppler's word boxes and from layout text alone", async () => {
      const replaced = new Set(["MATERIAL", "DWG. NO.", "REV", "ABC-1001"]);
      const items = [
        ...syntheticSheet({ material: null }).filter((item) => !replaced.has(item.text) && !(item.text === "B" && item.x === 900)),
        { x: 330, y: 720, size: 9, text: "MATERIAL:ALUMINUM" },
        { x: 725, y: 720, size: 9, text: "DWG NO:ABC-001" },
        { x: 900, y: 720, size: 9, text: "REV:A" },
      ];
      const pdfText = await pdfTextOf(items);
      expect(pdfText.pages[0]?.words?.some((word) => word.text === "MATERIAL:ALUMINUM")).toBe(true);
      const layoutText = { ...pdfText, pages: pdfText.pages.map(({ words: _words, ...page }) => page) };
      for (const text of [pdfText, layoutText]) {
        const signals = inferDrawingSignalsFromPdf({ baseName: "upload", pdfText: text });
        expect(signals.partNumber).toMatchObject({ value: "ABC-001", reviewNeeded: text === layoutText });
        expect(signals.revision).toMatchObject({ value: "A", reviewNeeded: text === layoutText });
        expect(signals.material).toMatchObject({ value: "ALUMINUM", reviewNeeded: text === layoutText });
      }
    });
  });

  describe("a revision that is the last line of the block", () => {
    const block: PdfTextItem[] = [
      { x: 700, y: 720, size: 6, text: "DWG. NO." },
      { x: 760, y: 735, size: 24, text: "ABC-1001" },
      { x: 900, y: 720, size: 6, text: "REV" },
    ];

    it("is read under REV from poppler's word boxes, with a 24 pt number beside it", async () => {
      const pdfText = await pdfTextOf([...block, { x: 900, y: 735, size: 24, text: "A" }]);
      expect(inferDrawingSignalsFromPdf({ baseName: "upload", pdfText }).revision).toMatchObject({ value: "A", reviewNeeded: false });
    });

    it("is read under REV from layout text alone when the values are set like the labels around them", async () => {
      const pdfText = await pdfTextOf([
        { x: 700, y: 720, size: 9, text: "DWG. NO." },
        { x: 760, y: 735, size: 9, text: "ABC-1001" },
        { x: 900, y: 720, size: 9, text: "REV" },
        { x: 900, y: 735, size: 9, text: "A" },
      ]);
      for (const page of pdfText.pages) {
        delete (page as { words?: unknown }).words;
      }
      expect(inferDrawingSignalsFromPdf({ baseName: "upload", pdfText }).revision).toMatchObject({ value: "A", reviewNeeded: true });
    });

    it("is not the border's marker: the row of markers and its last marker under an empty REV are dropped", async () => {
      const markers = ["8", "7", "6", "5", "4", "3", "2"].map((text, index): PdfTextItem => ({ x: 100 + index * 140, y: 790, size: 7, text }));
      const pdfText = await pdfTextOf([...block, ...markers, { x: 905, y: 800, size: 7, text: "1" }], { height: 820 });
      expect(inferDrawingSignalsFromPdf({ baseName: "upload", pdfText }).revision.value).not.toBe("1");
      for (const page of pdfText.pages) {
        delete (page as { words?: unknown }).words;
      }
      const layout = inferDrawingSignalsFromPdf({ baseName: "upload", pdfText });
      expect(layout.revision.value).not.toBe("1");
      expect(layout.revision.reviewNeeded).toBe(true);
    });
  });

  describe("another size and a rotated page", () => {
    it.each([0.5, 0.65, 2])("reads the same fields from a sheet drawn at scale %s", async (scale) => {
      const { signals } = await read({ scale }, { width: 1224 * Math.max(1, scale), height: 792 * Math.max(1, scale) });
      expect(signals.partNumber).toMatchObject({ value: "ABC-1001", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "B", reviewNeeded: false });
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
      expect(signals.tightestToleranceValueInch).toBe(ROW_DROPPED);
    });

    it("reads a landscape sheet stored upright with /Rotate 90, whose words run past the width poppler gives the page", async () => {
      const { pdfText, signals } = await read({}, { rotate: 90 });
      const words = pdfText.pages[0]?.words ?? [];
      expect(words.length).toBeGreaterThan(50);
      // poppler prints the stored page size (792 x 1224) in its markup; the words are at displayed positions.
      expect(Math.max(...words.map((word) => word.xMax))).toBeGreaterThan(792);
      expect(signals.partNumber).toMatchObject({ value: "ABC-1001", reviewNeeded: false });
      expect(signals.revision).toMatchObject({ value: "B", reviewNeeded: false });
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
      expect(signals.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
      expect(signals.tightestToleranceValueInch).toBe(ROW_DROPPED);
    });
  });

  // #884 review, rounds 11 and 12, and Codex review, round 7: the sheets the reviews built, through the whole extraction
  // (runHybridExtraction, no model), from poppler's word boxes and from its layout text alone. The field is empty and
  // flagged, and the drawing needs review; nothing is approved from text that is not the cell's value.
  describe("the sheets of the round 11 and 12 reviews, through the whole extraction", () => {
    async function extractBoth(items: PdfTextItem[], edit: (pdfText: PdfTextExtraction) => PdfTextExtraction = (pdfText) => pdfText) {
      const pdfText = edit(await pdfTextOf(items));
      expect(pdfText.pages[0]?.words?.length ?? 0).toBeGreaterThan(0);
      const layoutText = { ...pdfText, pages: pdfText.pages.map(({ words: _words, ...page }) => page) };
      const extract = (text: PdfTextExtraction) =>
        runHybridExtraction(
          { part: { id: "part", name: "part" } as PartRecord, cadFile: null, drawingFile: { original_name: "bracket.pdf" } as JobFileRecord, pdfText: text },
          { extractWithModel: async () => { throw new Error("model extraction must not run"); } },
        );
      return [
        ["word boxes", await extract(pdfText)],
        ["layout text", await extract(layoutText)],
      ] as const;
    }

    // Codex M1: a label far above text in its columns, with nothing between. Word boxes measure the distance; layout
    // text prints at most four blank lines however far it is, so the value under them is not read either (far_value).
    it("does not read text 400 points under MATERIAL as the material", async () => {
      const items: PdfTextItem[] = [
        { x: 330, y: 100, size: 6, text: "MATERIAL" },
        { x: 340, y: 500, size: 9, text: "6061-T6" },
        { x: 700, y: 520, size: 6, text: "DWG. NO." },
        { x: 700, y: 530, size: 9, text: "ABC-1001" },
      ];
      for (const [source, result] of await extractBoth(items)) {
        expect(result.material.raw, source).toBeNull();
        expect(result.reviewFields, source).toContain("material");
        expect(result.status, source).toBe("needs_review");
        expect(result.partNumber, source).toBe("ABC-1001");
      }
    });

    it("does not read text 200 points under MATERIAL, past the tolerance table, as the material", async () => {
      const items = [
        ...syntheticSheet({ material: null }).filter((item) => item.text !== "MATERIAL"),
        { x: 330, y: 520, size: 6, text: "MATERIAL" },
        { x: 340, y: 732, size: 9, text: "6061-T6" },
      ];
      for (const [source, result] of await extractBoth(items)) {
        expect(result.material.raw, source).toBeNull();
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["material"]);
        expect(result.finish.raw, source).toBe("AS MACHINED");
      }
    });

    // Codex M2: a two-page drawing whose second page was not read keeps the four-place row unresolved.
    it("does not drop the four-place row when a page of the drawing was not read", async () => {
      const unreadSecondPage = (pdfText: PdfTextExtraction): PdfTextExtraction => ({
        ...pdfText,
        pageCount: 2,
        drawingFullyRead: false,
        pages: [...pdfText.pages, { page: 2, text: "", ocrText: "", ocrStatus: "failed" }],
      });
      for (const [source, result] of await extractBoth(syntheticSheet(), unreadSecondPage)) {
        expect(result.tightestTolerance.valueInch, source).toBeNull();
        expect(result.material.raw, source).toBe("AL 6061-T6");
      }
      for (const [source, result] of await extractBoth(syntheticSheet())) {
        expect(result.tightestTolerance.valueInch, source).toBe(source === "layout text" ? null : ROW_DROPPED);
      }
    });

    // Opus MEDIUM 1: the cell's own value centred past its label's reach, and a stacked QTY cell at the left edge.
    const centredMaterial = (valueX: number | null, qtyValueX: number, qtySize = 6): PdfTextItem[] => [
      ...syntheticSheet({ material: null, finish: null }).filter((item) => item.text !== "FINISH"),
      ...(valueX === null ? [] : [{ x: valueX, y: 728, size: 9, text: "AL 6061-T6" }]),
      { x: 332, y: 742, size: qtySize, text: "QTY" },
      { x: qtyValueX, y: 748, size: 9, text: "4" },
      { x: 330, y: 765, size: 6, text: "FINISH" },
      { x: 340, y: 775, size: 9, text: "AS MACHINED" },
    ];

    it.each([390, 400, 420])("leaves the material empty and flagged, not 'QTY', when its value starts at %i pt", async (x) => {
      for (const [source, result] of await extractBoth(centredMaterial(x, x + 20))) {
        expect(result.material.raw, source).toBeNull();
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["material"]);
        expect(result.status, source).toBe("needs_review");
        expect(result.finish.raw, source).toBe("AS MACHINED");
      }
    });

    it.each([6, 9])("leaves an empty material empty and flagged, not a %i pt 'QTY' over a centred '4'", async (size) => {
      for (const [source, result] of await extractBoth(centredMaterial(null, 420, size))) {
        expect(result.material.raw, source).toBeNull();
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["material"]);
      }
    });

    it.each([390, 420, 440])("leaves the finish empty and flagged, not 'QTY', when its value starts at %i pt", async (x) => {
      const items = [
        ...syntheticSheet({ finish: null }),
        { x, y: 758, size: 9, text: "ANODIZE, BLACK" },
        { x: 332, y: 772, size: 6, text: "QTY" },
        { x: x + 20, y: 778, size: 9, text: "4" },
      ];
      for (const [source, result] of await extractBoth(items)) {
        expect(result.finish.raw, source).toBeNull();
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["finish"]);
        expect(result.material.raw, source).toBe("AL 6061-T6");
      }
    });

    it("still reads a value inside the label's reach over the stacked cell, from word boxes", async () => {
      const [[, words]] = await extractBoth(centredMaterial(380, 400));
      expect(words.material.raw).toBe("AL 6061-T6");
      expect(words.reviewFields).toEqual([]);
    });

    // #884 review, round 12 (MEDIUM 1): the same failure in the part number and the revision, at the sheet's own sizes (6 pt
    // labels, 24 pt values, a 6 pt stacked label with its 9 pt value centred). The drawing number or revision is past its
    // label's reach, so the stacked label was the only text the cell owned and was approved as the identifier.
    const centredDrawingNumber = (x: number, stacked: string): PdfTextItem[] => [
      ...syntheticSheet().filter((item) => item.text !== "ABC-1001"),
      { x, y: 735, size: 24, text: "ABC-1001" },
      { x: 727, y: 754, size: 6, text: stacked },
      { x: 800, y: 760, size: 9, text: "12" },
    ];

    it.each([
      ["QTY", 780],
      ["ITEM", 780],
      ["STOCK", 780],
      ["CUSTOMER", 780],
      ["QTY", 820],
      ["ITEM", 820],
      ["STOCK", 820],
      ["CUSTOMER", 820],
    ] as const)("leaves the part number flagged, not a stacked %s, when the drawing number starts at %i pt", async (stacked, x) => {
      for (const [source, result] of await extractBoth(centredDrawingNumber(x, stacked))) {
        expect(result.partNumber, source).not.toBe(stacked);
        expect(result.reviewFields, source).toContain("partNumber");
        expect(result.status, source).toBe("needs_review");
        expect(result.material.raw, source).toBe("AL 6061-T6");
        if (source === "word boxes") {
          expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["partNumber"]);
          expect(result.revision, source).toBe("B");
        }
      }
    });

    it.each([925, 935])("leaves the revision flagged, not a stacked 'QTY', when it is set at %i pt", async (x) => {
      const items: PdfTextItem[] = [
        ...syntheticSheet().filter((item) => !(item.text === "B" && item.x === 900)),
        { x, y: 735, size: 24, text: "B" },
        { x: 902, y: 754, size: 6, text: "QTY" },
        { x: x + 2, y: 760, size: 9, text: "12" },
      ];
      for (const [source, result] of await extractBoth(items)) {
        expect(result.revision, source).toBeNull();
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["revision"]);
        expect(result.status, source).toBe("needs_review");
        expect(result.partNumber, source).toBe("ABC-1001");
      }
    });

    it("still reads a revision or a drawing number of letters only when nothing else is in its cell", async () => {
      for (const [source, result] of await extractBoth(syntheticSheet({ revision: "AB", drawingNumber: "ABC-DEF" }))) {
        expect(result.revision, source).toBe("AB");
        expect(result.partNumber, source).toBe("ABC-DEF");
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : []);
        expect(result.status, source).toBe(source === "layout text" ? "needs_review" : "approved");
      }
    });

    // #884 review, round 14 (Opus): words are owned one by one, so a material or finish printed as one phrase that runs on
    // under another label's columns was cut there from word boxes and approved, with no review field. Every cell the
    // phrase is printed in is flagged, as layout text flags it.
    const sideBySide = (left: string, right: string, value: string): PdfTextItem[] => [
      ...syntheticSheet({ material: null, finish: null }).filter((item) => item.text !== "MATERIAL" && item.text !== "FINISH"),
      { x: 330, y: 720, size: 6, text: left },
      { x: left === "MATERIAL" ? 425 : 440, y: 720, size: 6, text: right },
      { x: 340, y: 732, size: 9, text: value },
    ];
    it.each([
      // "T651" lies under the approvals label Q.A. (the material was stored as "... TEMPER").
      ["a material whose last word is under Q.A.", syntheticSheet({ material: "ALUMINUM 6061-T6 PLATE QQ-A-250/11 TEMPER T651" }), ["material"]],
      // "5643" lies under Q.A. (stored as "... AMS").
      ["a material whose number is under Q.A.", syntheticSheet({ material: "STAINLESS STEEL 17-4 PH CONDITION H1150 AMS 5643" }), ["material"]],
      // MATERIAL and FINISH side by side, FINISH empty: the material "ALUMINUM 6061-T6" and the finish "ALLOY".
      ["a material that runs under FINISH beside it", sideBySide("MATERIAL", "FINISH", "ALUMINUM 6061-T6 ALLOY"), ["material", "finish"]],
      // FINISH and MATERIAL side by side, MATERIAL empty: the material "SEALED HOT", the tail of the finish.
      ["a finish that runs under MATERIAL beside it", sideBySide("FINISH", "MATERIAL", "ANODIZE, BLACK, SEALED HOT"), ["material", "finish"]],
    ] as const)("leaves %s empty and flagged, not cut at the column", async (_case, items, flagged) => {
      for (const [source, result] of await extractBoth([...items])) {
        expect(result.material.raw, source).toBeNull();
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : flagged);
        expect(result.status, source).toBe("needs_review");
        expect(result.finish.raw, source).toBe(flagged.length === 1 ? "AS MACHINED" : null);
        expect(result.partNumber, source).toBe("ABC-1001");
      }
    });

    // #884 review, round 14 (Codex): only a clean value is a candidate, so a cell another sheet rejected or could not read was
    // dropped and the first sheet's value approved, where main flags it. The value is kept, flagged.
    const withSheet = (second: PdfTextExtraction) => (first: PdfTextExtraction): PdfTextExtraction => ({
      ...first,
      pageCount: 2,
      pages: [first.pages[0]!, { ...second.pages[0]!, page: 2 }],
    });

    it("flags the material and finish when another sheet's cells point elsewhere", async () => {
      const pointers = await pdfTextOf(syntheticSheet({ material: "SEE NOTE 1", finish: "SEE NOTE 2" }));
      for (const [source, result] of await extractBoth(syntheticSheet(), withSheet(pointers))) {
        expect(result.material.raw, source).toBe("AL 6061-T6");
        expect(result.finish.raw, source).toBe("AS MACHINED");
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : ["material", "finish"]);
        expect(result.status, source).toBe("needs_review");
      }
    });

    it("still approves the fields when the other sheet repeats them or leaves the cells empty", async () => {
      const repeated = await pdfTextOf(syntheticSheet());
      for (const [source, result] of await extractBoth(syntheticSheet(), withSheet(repeated))) {
        expect(result.material.raw, source).toBe("AL 6061-T6");
        expect(result.finish.raw, source).toBe("AS MACHINED");
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : []);
        expect(result.status, source).toBe(source === "layout text" ? "needs_review" : "approved");
      }
      const empty = await pdfTextOf(syntheticSheet({ material: null, finish: null }));
      for (const [source, result] of await extractBoth(syntheticSheet(), withSheet(empty))) {
        expect(result.material.raw, source).toBe("AL 6061-T6");
        expect(result.finish.raw, source).toBe("AS MACHINED");
        // An empty cell holds nothing that disagrees. On layout text alone, that sheet's 24 pt drawing number and revision
        // are under four blank lines once the MATERIAL and FINISH rows are empty, so they are not read (a known limit), and
        // a cell that could not be read flags the field the first sheet gave.
        expect(result.reviewFields, source).toEqual(source === "layout text" ? LAYOUT_REVIEW_FIELDS : source === "word boxes" ? [] : ["partNumber", "revision"]);
        expect(result.partNumber, source).toBe("ABC-1001");
        expect(result.revision, source).toBe("B");
      }
    });
  });

  describe("approval requires complete cell evidence", () => {
    const infer = (pdfText: PdfTextExtraction, baseName = "upload") => inferDrawingSignalsFromPdf({ pdfText, baseName });
    const combine = (first: PdfTextExtraction, second: PdfTextExtraction): PdfTextExtraction => ({
      ...first, pageCount: 2, drawingFullyRead: first.drawingFullyRead && second.drawingFullyRead,
      pages: [first.pages[0]!, { ...second.pages[0]!, page: 2 }],
    });

    it("a filename cannot replace conflicting sheet identities", async () => {
      const first = await pdfTextOf(syntheticSheet({ drawingNumber: "ABC-1001", revision: "B" }));
      const second = await pdfTextOf(syntheticSheet({ drawingNumber: "ABC-1002", revision: "C" }));
      for (const baseName of ["upload", "1234-56789-A"]) {
        const result = infer(combine(first, second), baseName);
        expect(result.partNumber).toMatchObject({ value: "ABC-1001", reviewNeeded: true });
        expect(result.revision).toMatchObject({ value: "B", reviewNeeded: true });
      }
    });

    it("missing or partial word geometry leaves otherwise correct fields as suggestions", async () => {
      const pdfText = await pdfTextOf(syntheticSheet());
      for (const page of [
        { ...pdfText.pages[0]!, words: undefined },
        { ...pdfText.pages[0]!, wordGeometryComplete: false },
        { ...pdfText.pages[0]!, wordGeometryComplete: undefined },
      ]) {
        const result = infer({ ...pdfText, pages: [page] });
        expect(result.tightestTolerance).toBe("±0.005");
        expect(result.tightestToleranceValueInch).toBeNull();
        for (const field of LAYOUT_REVIEW_FIELDS as Array<"partNumber" | "revision" | "material" | "finish">) {
          expect(result[field].reviewNeeded, field).toBe(true);
        }
      }
    });

    it("an unowned value on another sheet is not proof of an empty cell", async () => {
      const first = await pdfTextOf(syntheticSheet());
      const second = await pdfTextOf([
        { x: 100, y: 600, size: 6, text: "MATERIAL" },
        { x: 250, y: 612, size: 9, text: "BRASS" },
      ]);
      expect(infer(combine(first, second)).material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: true });
    });

    it("a missing identity is only suggested from the filename; an exact cell match stays approved", async () => {
      const missing = infer(await pdfTextOf([{ x: 100, y: 100, size: 9, text: "TITLE: SAMPLE" }]), "1234-56789-A");
      expect(missing.partNumber).toMatchObject({ value: "1234-56789", reviewNeeded: true });
      expect(missing.revision).toMatchObject({ value: "A", reviewNeeded: true });
      const matching = infer(await pdfTextOf(syntheticSheet({ drawingNumber: "1234-56789", revision: "A" })), "1234-56789-A");
      expect(matching.partNumber).toMatchObject({ value: "1234-56789", reviewNeeded: false });
      expect(matching.revision).toMatchObject({ value: "A", reviewNeeded: false });
    });

    it("accounts for a finish continuation beyond the title-block candidate crop", async () => {
      const pdfText = await pdfTextOf([
        { x: 100, y: 600, size: 9, text: "FINISH" },
        { x: 100, y: 612, size: 9, text: "ANODIZE, MIL-A-8625F, TYPE II" },
        { x: 700, y: 624, size: 9, text: "OTHER COLUMN" },
        { x: 700, y: 636, size: 9, text: "MORE TEXT" },
        { x: 100, y: 648, size: 9, text: "CLASS 2" },
      ]);
      expect(pdfText.pages[0]!.words?.some((word) => word.text === "CLASS")).toBe(true);
      expect(infer(pdfText).finish).toMatchObject({ value: "ANODIZE, MIL-A-8625F, TYPE II", reviewNeeded: true });
    });

    it.each([7, 12])("a %s pt qualifier beneath a 9 pt finish is not a boundary", async (size) => {
      const pdfText = await pdfTextOf([
        { x: 100, y: 600, size: 6, text: "FINISH" },
        { x: 100, y: 612, size: 9, text: "ANODIZE" },
        { x: 100, y: 625, size, text: "BLACK" },
      ]);
      expect(infer(pdfText).finish.reviewNeeded).toBe(true);
    });

    it.each(["6", "/", "|"])("accounts for a one-box continuation %s", async (continuation) => {
      const pdfText = await pdfTextOf([
        { x: 100, y: 600, size: 6, text: "MATERIAL" },
        { x: 100, y: 612, size: 9, text: "6061-T" },
        { x: 100, y: 624, size: 9, text: continuation },
      ]);
      expect(infer(pdfText).material).toMatchObject({ value: "6061-T", reviewNeeded: true });
    });

    it("an oversized conflicting line makes its page unread for every field and tolerance", async () => {
      const first = await pdfTextOf(syntheticSheet());
      const second = await pdfTextOf([{ x: 10, y: 100, size: 0.5, text: `MATERIAL BRASS ${"X".repeat(2001)}` }]);
      expect(second.pages[0]!.text.length).toBeGreaterThan(2000);
      const result = infer(combine(first, second));
      expect(result.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: true });
      for (const field of ["partNumber", "revision", "material", "finish"] as const) {
        expect(result[field].reviewNeeded, field).toBe(true);
        expect(result[field].reasons).toContain("title_block_page_unread");
      }
      expect(result.tightestToleranceValueInch).toBeNull();
    });

    it("a known neighbouring label proves a boundary regardless of its smaller type", async () => {
      const result = infer(await pdfTextOf([
        { x: 100, y: 600, size: 6, text: "FINISH" },
        { x: 100, y: 612, size: 9, text: "ANODIZE" },
        { x: 100, y: 625, size: 7, text: "SCALE: 1:1" },
      ]));
      expect(result.finish).toMatchObject({ value: "ANODIZE", reviewNeeded: false });
    });

    it.each([false, true])("a shifted continuation remains unresolved even with a short rule: %s", async (shortRule) => {
      const result = infer(await pdfTextOf([
        { x: 100, y: 600, size: 6, text: "FINISH" },
        { x: 100, y: 612, size: 9, text: "MIL-A-8625F" },
        { x: 250, y: 625, size: 9, text: "CLASS 2" },
      ], { rules: shortRule ? [{ x0: 50, x1: 200, y0: 623, y1: 623 }] : [] }));
      expect(result.finish).toMatchObject({ value: "MIL-A-8625F", reviewNeeded: true });
    });

    it("an adjacent label does not close the left part of a wide cell", async () => {
      const result = infer(await pdfTextOf([
        { x: 100, y: 500, size: 6, text: "FINISH" },
        { x: 140, y: 500, size: 9, text: "MIL-A-8625F" },
        { x: 150, y: 525, size: 6, text: "SCALE: 1:1" },
        { x: 100, y: 780, size: 9, text: "BLACK" },
      ]));
      expect(result.finish.reviewNeeded).toBe(true);
    });

    it("only a ruled border below the full inline word can close its cell", async () => {
      const items = [
        { x: 100, y: 600, size: 9, text: "MATERIAL:6061-T" },
        { x: 100, y: 625, size: 9, text: "/" },
      ];
      for (const y of [590, 640]) {
        const result = infer(await pdfTextOf(items, { rules: [{ x0: 50, x1: 400, y0: y, y1: y }] }));
        expect(result.material.reviewNeeded).toBe(true);
      }
    });

    it("an erased rule supplies no cell boundary proof", async () => {
      const result = infer(await pdfTextOf([
        { x: 100, y: 600, size: 6, text: "FINISH" },
        { x: 100, y: 612, size: 9, text: "ANODIZE" },
        { x: 100, y: 640, size: 7, text: "BLACK" },
      ], {
        rules: [{ x0: 50, x1: 400, y0: 630, y1: 630 }],
        erase: [{ x: 45, y: 627, width: 360, height: 6 }],
      }));
      expect(result.finish.reviewNeeded).toBe(true);
    });

    it("a visible gray ruled border separates the cell value from sheet-zone characters", async () => {
      const items = [
        { x: 100, y: 600, size: 6, text: "FINISH" },
        { x: 100, y: 612, size: 9, text: "AS MACHINED" },
        ...[1, 2, 3, 4].map((n) => ({ x: 60 * n, y: 650, size: 9, text: String(n) })),
      ];
      expect(infer(await pdfTextOf(items)).finish.reviewNeeded).toBe(true);
      const result = infer(await pdfTextOf(items, { rules: [{ x0: 50, x1: 400, y0: 640, y1: 640, gray: 0.75 }] }));
      expect(result.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
    });
  });

});
