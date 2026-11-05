// @vitest-environment node
import { describe, expect, it } from "vitest";
import { displayedPageSize, pdfSourceGeometryIssues, readSvgGeometry, wordsFitFrame } from "./pdfVectorGeometry";
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
const infer = (pdfText: PdfTextExtraction) => inferDrawingSignalsFromPdf({ titleBlockApprovalEnabled: true, baseName: "upload", pdfText });

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

  it.each(["rgb(85%, 85%, 85%)", "rgb(100%, 0%, 0%)"])(
    "%s is an understood divider and never deletes existing rules", (colour) => {
      const paint = path("M 90 115 L 350 115").replace("rgb(0%, 0%, 0%)", colour);
      expect(infer(input("")).material.reviewNeeded).toBe(false);
      for (const content of [paint, paint+rule, rule+paint]) {
        const data = input(content);
        expect(data.pages[0]!.borders).toContainEqual({ x0: 90, x1: 350, y: 115 });
        if (content !== paint) expect(data.pages[0]!.borders).toContainEqual({ x0: 90, x1: 350, y: 120 });
        expect(data.pages[0]!.vectorGeometry?.issues).toEqual([]);
        expect(infer(data).material.reviewNeeded).toBe(true);
        expect(infer(data).material.reasons).not.toContain("title_block_geometry_incomplete");
      }
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

  // OVD-1169: poppler's SVG and word boxes are in the displayed frame; pdftotext prints the stored size.
  it.each([[90, true], [270, true], [-90, true], [450, true], [0, false], [180, false], [null, false]] as const)(
    "a /Rotate %s page is compared in its displayed frame (swapped: %s)", (rotation, swapped) => {
      const frame = displayedPageSize({ width: 600, height: 800 }, rotation);
      expect(frame).toEqual(swapped ? { width: 800, height: 600 } : { width: 600, height: 800 });
      const landscape = readSvgGeometry(svg("", "0 0 800 600"), frame).vectorGeometry;
      expect(landscape.complete).toBe(swapped);
      expect(landscape.issues.some((issue) => issue.cause === "coordinate_frame_mismatch")).toBe(!swapped);
    });

  it("the swapped size of a rotated page still vetoes a viewBox that differs from it", () => {
    const data = input("");
    Object.assign(data.pages[0]!, readSvgGeometry(svg("", "0 0 800 590"), displayedPageSize({ width: 600, height: 800 }, 90)));
    expect(data.pages[0]!.vectorGeometry?.complete).toBe(false);
    expect(infer(data).material.reasons).toContain("geometry_coordinate_frame_mismatch");
  });

  it("a word box outside the displayed frame keeps the frame unproven", () => {
    const frame = displayedPageSize({ width: 600, height: 800 }, 90);
    expect(wordsFitFrame([box("MATERIAL", 100, 100), box("EDGE", 700, 580)], frame)).toBe(true);
    expect(wordsFitFrame([box("MATERIAL", 100, 100), box("PAST", 700, 700)], frame)).toBe(false);
    expect(wordsFitFrame([box("PAST", 790, 100)], { width: 600, height: 800 })).toBe(false);
  });

  // OVD-1169: arcs and circles drawn as short polylines are diagonal segments. They are not rules, so they neither
  // count toward the 2,000-rule cap nor veto a cell, while the cap still applies to real horizontal and vertical rules.
  const polygon = (cx: number, cy: number, radius: number, segments: number) =>
    "M " + Array.from({ length: segments + 1 }, (_, index) => {
      const angle = (2 * Math.PI * index) / segments;
      return `${(cx + radius * Math.cos(angle)).toFixed(3)} ${(cy + radius * Math.sin(angle)).toFixed(3)}`;
    }).join(" L ");

  it("a 3,000-segment polyline circle crossing the cell neither trips the rule cap nor vetoes it", () => {
    const data = input(path(polygon(200, 120, 60, 3_000)) + rule);
    const geometry = data.pages[0]!.vectorGeometry!;
    expect(geometry.complete).toBe(true);
    expect(geometry.issues).toEqual([]);
    expect(geometry.rules!.length).toBeLessThan(2_000);
    expect(geometry.rules!.every((r) => Math.abs(r.x0 - r.x1) < 0.01 || Math.abs(r.y0 - r.y1) < 0.01)).toBe(true);
    expect(data.pages[0]!.borders).toContainEqual({ x0: 90, x1: 350, y: 120 });
    const away = input(path(polygon(400, 600, 60, 3_000)));
    expect(away.pages[0]!.vectorGeometry?.complete).toBe(true);
    expect(infer(away).material.reviewNeeded).toBe(false);
  });

  it.each([
    ["horizontal", (x: number, y: number) => `M ${x} ${y} L ${x + 3} ${y}`],
    ["vertical", (x: number, y: number) => `M ${x} ${y} L ${x} ${y + 3}`],
  ] as const)("2,100 short %s ticks still trip the rule cap", (_name, tick) => {
    const ticks = Array.from({ length: 2_100 }, (_, index) => tick(10 + (index % 70) * 8, 300 + Math.floor(index / 70) * 10)).join(" ");
    const data = input(path(ticks));
    expect(data.pages[0]!.vectorGeometry?.complete).toBe(false);
    expect(data.pages[0]!.vectorGeometry?.issues.map((issue) => issue.cause)).toContain("border_limit");
    expect(infer(data).material.reasons).toContain("geometry_border_limit");
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
