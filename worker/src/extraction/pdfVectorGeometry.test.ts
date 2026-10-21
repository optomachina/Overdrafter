// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pdfSourceGeometryIssues, readSvgGeometry } from "./pdfVectorGeometry";
import { inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing";
import { box, phrase } from "../../test-support/pdfWordBoxes";

const svg = (content: string, viewBox = "0 0 600 800") => `<svg viewBox="${viewBox}">${content}</svg>`;
const path = (d: string, attrs = '') => `<path fill="none" stroke="rgb(0%, 0%, 0%)" stroke-width="0.5" stroke-opacity="1" d="${d}" ${attrs}/>`;
const parse = (content: string) => readSvgGeometry(svg(content), { width: 600, height: 800 });
const rule = path("M 90 120 L 350 120");
function input(content: string): PdfTextExtraction {
  return { pageCount: 1, pageCountKnown: true, drawingFullyRead: true, ocr: false, pages: [{
    page: 1, text: "MATERIAL\nAL 6061-T6", ocrText: "", ocrStatus: "ok", wordGeometryComplete: true,
    words: [box("MATERIAL", 100, 100), ...phrase("AL 6061-T6", 100, 140)], ...parse(content),
  }] };
}
const infer = (pdfText: PdfTextExtraction) => inferDrawingSignalsFromPdf({ baseName: "upload", pdfText });

describe("I7 complete vector geometry", () => {
  it.each(["/Subtype /Form", "/Subtype /F#6frm", "/Type /ObjStm", "/Type /Obj#53tm", "/Encrypt 1 0 R"])(
    "source provenance survives Cairo flattening: %s", (source) => {
      expect(pdfSourceGeometryIssues(Buffer.from(source))).not.toEqual([]);
    });

  it.each([
    ["rectangle", "M 90 120 L 350 120 L 350 170 L 90 170 Z"],
    ["polyline", "M 90 80 L 90 120 L 350 120 L 350 170"],
    ["closed path", "M 90 120 L 350 120 Z"],
    ["split path", "M 90 120 L 125 120 M 125 120 L 350 120"],
  ])("classifies %s dividers and refuses a value across them", (_name, d) => {
    const data = input(path(d));
    expect(data.pages[0]!.borders).toContainEqual({ x0: 90, x1: 350, y: 120 });
    expect(data.pages[0]!.vectorGeometry?.issues).toEqual([]);
    expect(infer(data).material.reviewNeeded).toBe(true);
  });

  it("classifies thin filled bars as rules while retaining the fill veto", () => {
    const data = input('<path fill="rgb(0%, 0%, 0%)" d="M 90 120 L 350 120 L 350 120.6 L 90 120.6 Z"/>');
    expect(data.pages[0]!.borders).toContainEqual({ x0: 90, x1: 350, y: 120 });
    expect(infer(data).material.reasons).toContain("geometry_fill");
  });

  it.each([
    ["unclassified_path", path("M 100 110 A 10 10 0 0 1 150 110")],
    ["image_xobject", '<defs><image id="source-1" width="2" height="2"/></defs><use xlink:href="#source-1" transform="matrix(20,0,0,20,100,110)"/>'],
    ["form_xobject", '<defs><g id="surface-1"/></defs><use xlink:href="#surface-1"/>'],
    ["fill", '<path fill="rgb(0%, 0%, 0%)" d="M 100 110 L 150 110 L 150 130 Z"/>'],
    ["non_black_or_light_stroke", path("M 90 115 L 350 115").replace('rgb(0%, 0%, 0%)', 'rgb(85%, 85%, 85%)')],
    ["non_black_or_light_stroke", path("M 90 115 L 350 115").replace('rgb(0%, 0%, 0%)', 'rgb(100%, 0%, 0%)')],
    ["clip_path", `<g clip-path="url(#clip1)">${path("M 90 115 L 350 115")}</g>`],
    ["curve", path("M 90 110 C 150 110 200 130 350 130")],
  ])("%s in the region vetoes approval and never deletes existing rules", (cause, paint) => {
    expect(infer(input("")).material.reviewNeeded).toBe(false);
    for (const content of [paint+rule, rule+paint]) {
      const data = input(content);
      expect(data.pages[0]!.borders).toContainEqual({ x0: 90, x1: 350, y: 120 });
      expect(infer(data).material.reviewNeeded).toBe(true);
      expect(infer(data).material.reasons).toContain(`geometry_${cause}`);
    }
    // The veto must work without a helpful separating border, too.
    expect(infer(input(paint)).material.reviewNeeded).toBe(true);
  });

  it("located unsupported paint outside the title block does not erase its rules", () => {
    const gray = path("M 10 20 L 80 20").replace('rgb(0%, 0%, 0%)', 'rgb(85%, 85%, 85%)');
    expect(infer(input(gray)).material.reviewNeeded).toBe(false);
    expect(input(rule+gray).pages[0]!.borders).toContainEqual({ x0: 90, x1: 350, y: 120 });
    expect(infer(input(rule+gray)).material.reviewNeeded).toBe(true);
  });

  it("a curve crossing the region is incomplete even with endpoints outside it", () => {
    expect(infer(input(path("M 10 110 C 150 110 200 110 650 110"))).material.reviewNeeded).toBe(true);
  });

  it("an active clip cannot hide behind paint outside the title block", () => {
    const data = input(`<g clip-path="url(#clip1)">${path("M 10 20 L 80 20")}</g>`);
    expect(infer(data).material.reasons).toContain("geometry_clip_path");
  });

  it("viewBox mismatch vetoes every field on that page", () => {
    const data = input("");
    Object.assign(data.pages[0]!, readSvgGeometry(svg("", "0 0 590 800"), { width: 600, height: 800 }));
    const result = infer(data);
    for (const field of [result.material, result.finish, result.partNumber, result.revision, result.description]) {
      expect(field.reviewNeeded).toBe(true);
      expect(field.reasons).toContain("geometry_coordinate_frame_mismatch");
    }
  });

  it("missing or partial SVG geometry cannot prove an empty region", () => {
    const data = input("");
    delete data.pages[0]!.vectorGeometry;
    expect(infer(data).material.reasons).toContain("geometry_vector_geometry_unavailable");
    Object.assign(data.pages[0]!, readSvgGeometry('<svg viewBox="0 0 600 800">'+rule, { width: 600, height: 800 }));
    expect(data.pages[0]!.borders).toHaveLength(1);
    expect(infer(data).material.reviewNeeded).toBe(true);
  });
});
