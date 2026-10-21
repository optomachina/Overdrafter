// @vitest-environment node
import { describe, expect, it } from "vitest";
import { geometryIssuesInRegion, readSvgGeometry } from "./pdfVectorGeometry";
import { inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";
import { phrase } from "../../test-support/pdfWordBoxes";

const frame = "M 20 20 L 580 20 L 580 780 L 20 780 Z M 200 20 L 200 30 M 400 780 L 400 770 M 20 400 L 30 400 M 580 400 L 570 400";
const path = (d: string, colour = "rgb(75.3%, 75.3%, 75.3%)", attrs = "") =>
  `<path fill="none" stroke="${colour}" stroke-width="0.5" d="${d}" ${attrs}/>`;
const parse = (paint: string) => readSvgGeometry(`<svg viewBox="0 0 600 800">${paint}</svg>`, { width: 600, height: 800 });
const cells = [
  ["partNumber", "PART NUMBER", "ABC-001", 100],
  ["description", "DESCRIPTION", "SAMPLE PLATE", 220],
  ["material", "MATERIAL", "AL 6061-T6", 340],
  ["finish", "FINISH", "AS MACHINED", 460],
] as const;
function infer(paint: string) {
  const pdfText: PdfTextExtraction = { pageCount: 1, pageCountKnown: true, drawingFullyRead: true, ocr: false,
    pages: [{ page: 1, text: cells.map(([, label, value]) => `${label}\n${value}`).join("\n"),
      words: cells.flatMap(([, label, value, y]) => [...phrase(label, 100, y), ...phrase(value, 100, y+20)]),
      wordGeometryComplete: true, ocrText: "", ocrStatus: "ok", ...parse(paint) }] };
  return inferDrawingSignalsFromPdf({ titleBlockApprovalEnabled: true, baseName: "upload", pdfText });
}
function expectOnlyMaterialReview(paint: string, cause: string) {
  const result = infer(path(frame)+paint);
  for (const [field, , value] of cells) expect(result[field]).toMatchObject({ value, reviewNeeded: field === "material" });
  expect(result.material.reasons).toContain(`geometry_${cause}`);
}

describe("segment-local vector proof", () => {
  it("a grey compound sheet border and zone ticks approve the correct title-block values", () => {
    const result = infer(path(frame));
    for (const [field, , value] of cells) expect(result[field]).toMatchObject({ value, reviewNeeded: false });
    expect(parse(path(frame)).vectorGeometry.issues).toEqual([]);
  });

  it.each([
    ["curve", path("M 100 355 C 110 345 125 365 140 355")],
    ["image_xobject", '<image x="100" y="350" width="20" height="20"/>'],
    ["clip_path", '<defs><clipPath id="clip"><path d="M 100 350 L 140 350 L 140 370 L 100 370 Z"/></clipPath></defs><g clip-path="url(#clip)">'+path("M 100 355 L 140 355")+'</g>'],
    ["fill", '<path d="M 100 350 L 140 350 L 140 370 L 100 370 Z"/>'],
    ["white_stroke", path("M 100 350 L 140 350", "white")],
  ])("only material needs review for local %s", (cause, paint) => expectOnlyMaterialReview(paint, cause));

  it("a distant curve in the same compound path cannot contaminate the title block", () => {
    const result = infer(path(frame+" M 450 50 C 460 30 480 70 500 50"));
    for (const [field, , value] of cells) expect(result[field]).toMatchObject({ value, reviewNeeded: false });
    expect(parse(path(frame+" M 450 50 C 460 30 480 70 500 50")).vectorGeometry.issues).toHaveLength(1);
  });

  it("a local curve within the compound frame reviews only material", () => {
    const result = infer(path(frame+" M 100 355 C 110 345 125 365 140 355"));
    for (const [field, , value] of cells) expect(result[field]).toMatchObject({ value, reviewNeeded: field === "material" });
    expect(result.material.reasons).toContain("geometry_curve");
  });

  it("white compound border erasure uses each segment's expanded box", () => {
    const border = parse(path(frame, "white")).vectorGeometry;
    expect(geometryIssuesInRegion(border, { x0: 90, x1: 350, y0: 100, y1: 500 })).toEqual([]);
    const geometry = parse('<path fill="none" stroke="white" stroke-width="10" d="M 90 330 L 180 330"/>').vectorGeometry;
    expect(geometryIssuesInRegion(geometry, { x0: 100, x1: 140, y0: 340, y1: 370 })).toContain("white_stroke");
  });

  it.each(["rgb(99%, 99%, 99%)", "rgb(255, 0, 0)", "#fefefe", "blue"])(
    "%s with positive alpha remains an I4 divider even after later paint", (colour) => {
      const divider = path("M 90 120 L 350 120", colour, 'stroke-opacity="0.01"');
      for (const paint of [divider, divider+path("M 90 120 L 350 120", "white"), divider+'<image x="100" y="120" width="20" height="20"/>']) {
        const data = parse(paint);
        expect(data.borders).toContainEqual({ x0: 90, x1: 350, y: 120 });
        const result = inferDrawingSignalsFromPdf({ titleBlockApprovalEnabled: true, baseName: "upload", pdfText: {
          pageCount: 1, pageCountKnown: true, drawingFullyRead: true, ocr: false,
          pages: [{ page: 1, text: "MATERIAL\nLOT CODE A123", ocrText: "", ocrStatus: "ok", wordGeometryComplete: true,
            words: [...phrase("MATERIAL", 100, 100), ...phrase("LOT CODE A123", 100, 140)], ...data }],
        } });
        expect(result.material.reviewNeeded).toBe(true);
      }
      expect(parse(divider).vectorGeometry.issues).toEqual([]);
    });

  it("unknown paint within two points of a cell edge still forces review", () => {
    const geometry = parse('<image x="100" y="97" width="20" height="2"/>').vectorGeometry;
    expect(geometryIssuesInRegion(geometry, { x0: 100, x1: 200, y0: 100, y1: 130 })).toEqual(["image_xobject"]);
    expect(geometryIssuesInRegion(geometry, { x0: 100, x1: 200, y0: 102, y1: 130 })).toEqual([]);
  });

  it("zero-alpha strokes do not supply divider proof", () => {
    expect(parse(path("M 90 120 L 350 120", "gray", 'stroke-opacity="0"')).borders).toEqual([]);
    expect(parse('<g opacity="0">'+path(frame)+'</g>').borders).toEqual([]);
    expect(parse('<g opacity="0.1">'+path(frame)+'</g>').borders.length).toBeGreaterThan(0);
  });

  it("a resolved clip outside the cells does not veto them, even if its child is inside", () => {
    const paint = '<defs><clipPath id="clip"><path d="M 450 10 L 480 10 L 480 40 L 450 40 Z"/></clipPath></defs><g clip-path="url(#clip)">'+path("M 100 355 L 140 355")+'</g>';
    for (const [field, , value] of cells) expect(infer(path(frame)+paint)[field]).toMatchObject({ value, reviewNeeded: false });
  });

  it("a local clip still vetoes material when its painted child is elsewhere", () => {
    expectOnlyMaterialReview('<defs><clipPath id="clip" transform="matrix(1,0,0,1,100,350)"><path d="M 0 0 L 40 0 L 40 20 L 0 20 Z"/></clipPath></defs><g clip-path="url(#clip)">'+path("M 450 10 L 480 10")+'</g>', "clip_path");
  });
});
