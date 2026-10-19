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
import { minimalPdf, syntheticSheet, type MinimalPdfOptions, type PdfTextItem, type SyntheticSheetOptions } from "../../test-support/minimalPdf";
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

describe.skipIf(!hasPoppler)("synthetic sheets through poppler", () => {
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
