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
      expect(signals.tightestToleranceValueInch).toBe(0.005);
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
      expect(signals.tightestToleranceValueInch).toBe(0.001);
      // The table row is what applies; its value is in inches.
      expect(signals.tightestToleranceUnit).toBe("in");
    });

    it("drops the row when the same notes carry no four-place number", async () => {
      const { signals } = await read({
        extra: [
          { x: 120, y: 520, size: 9, text: ".375" },
          { x: 700, y: 520, size: 9, text: "SECTION A-A  SCALE 2 : 1" },
          { x: 700, y: 540, size: 9, text: "SURFACE FINISH: 63" },
        ],
      });
      expect(signals.tightestToleranceValueInch).toBe(0.005);
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
      expect(signals.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
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
      expect(control.material).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
      expect(control.finish).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
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
        expect(signals.finish, source).toMatchObject({ value: "AS MACHINED", reviewNeeded: false });
      }
    });

    it("(a) leaves an empty FINISH empty and flagged, not 'PAINT' or 'PAINT RAL 9005'", async () => {
      for (const [source, signals] of await bothSources(syntheticSheet({ finish: null, extra: labelAndValue("PAINT", "RAL 9005", 775, 372) }))) {
        expect(signals.finish, source).toMatchObject({ value: null, reviewNeeded: true });
        expect(signals.material, source).toMatchObject({ value: "AL 6061-T6", reviewNeeded: false });
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
        expect(result.reviewFields, source).toEqual(["material"]);
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
        expect(result.reviewFields, source).toEqual(["finish"]);
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
          expect(result.reviewFields, `${source}, ${size} pt`).toEqual(["material"]);
          expect(result.status, `${source}, ${size} pt`).toBe("needs_review");
          expect(result.finish.raw, `${source}, ${size} pt`).toBe("AS MACHINED");
        }
      }
    });

    it("(a) leaves an empty FINISH empty and flagged, not 'QTY' over '4'", async () => {
      for (const size of [6, 9]) {
        for (const [source, result] of await extractBoth(syntheticSheet({ finish: null, extra: overOneCharacter("QTY", "4", 767, size) }))) {
          expect(result.finish.raw, `${source}, ${size} pt`).toBeNull();
          expect(result.reviewFields, `${source}, ${size} pt`).toEqual(["finish"]);
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
        expect(result.reviewFields, source).toEqual([]);
        expect(result.status, source).toBe("approved");
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
        expect(signals.partNumber).toMatchObject({ value: "ABC-001", reviewNeeded: false });
        expect(signals.revision).toMatchObject({ value: "A", reviewNeeded: false });
        expect(signals.material).toMatchObject({ value: "ALUMINUM", reviewNeeded: false });
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
      expect(inferDrawingSignalsFromPdf({ baseName: "upload", pdfText }).revision).toMatchObject({ value: "A", reviewNeeded: false });
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
      expect(signals.tightestToleranceValueInch).toBe(0.005);
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
      expect(signals.tightestToleranceValueInch).toBe(0.005);
    });
  });
});
