// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hasToleranceLabel, svgNumbers, svgPathTokens, svgTags, trimDimensionPunctuation } from "./pdfParsing";
import { readSvgGeometry } from "./pdfVectorGeometry";

const parse = (content: string) => readSvgGeometry(`<svg viewBox="0 0 600 800">${content}</svg>`, { width: 600, height: 800 });
const path = (d: string, stroke = "black") => `<path fill="none" stroke="${stroke}" d="${d}"/>`;

describe("linear PDF parsing", () => {
  it.each([
    ["matrix(1,0,0,1,+2.5,-.5)", [1, 0, 0, 1, 2.5, -0.5]],
    ["1. 1.e2 2e+ 3E-2 --.5 +.6 1.2.3", [1, 1, 2, 2, 0.03, -0.5, 0.6, 1.2, 0.3]],
    ["nothing .. + - e", []],
  ])("preserves SVG number matches: %s", (input, expected) => {
    expect(svgNumbers(input)).toEqual(expected);
  });

  it.each([
    ["M+.5,-2E-1L3 4Z", ["M", "+.5", "-2E-1", "L", "3", "4", "Z"]],
    [" M 1.2.3\tL 4 5 ", ["M", "1.2", ".3", "L", "4", "5"]],
    ["m 1 2", null], ["M 1e+ 2", null], ["M 1. 2", null], ["M 1 2 A 3 4", null],
    [" , \n", []],
  ])("preserves absolute path validation/tokenization: %s", (input, expected) => {
    expect(svgPathTokens(input)).toEqual(expected);
  });

  it.each([
    ["rgb(255,255,255)", "white_stroke"], ["rgb(100%, 100%, 100%)", "white_stroke"],
    ["rgb(255.0, 0, 0%)", null], ["rgb( 0 ,\t0,0 )", null],
    ["rgb(256,0,0)", "unclassified_stroke"], ["rgb(.5,0,0)", "unclassified_stroke"],
    ["rgb(0,0,0,0)", "unclassified_stroke"], ["rgb(0.,0,0)", "unclassified_stroke"],
  ])("preserves RGB classification: %s", (colour, issue) => {
    const result = parse(path("M 10 20 L 80 20", colour));
    expect(result.vectorGeometry.issues.map(({ cause }) => cause)).toEqual(issue ? [issue] : []);
    expect(result.borders).toHaveLength(issue ? 0 : 1);
  });

  it("closes a started path and then continues with the next command", () => {
    expect(parse(path("M 10 20 L 80 20 Z M 100 40 L 150 40")).borders).toEqual([
      { x0: 10, x1: 80, y: 20 }, { x0: 100, x1: 150, y: 40 },
    ]);
    expect(parse(path("Z M 10 20 L 80 20")).vectorGeometry.issues).toEqual([
      { cause: "unclassified_path", bounds: null },
    ]);
  });

  it("skips every closing tag but pops the transform only for a closing group", () => {
    const result = parse(`<g transform="matrix(1,0,0,1,0,10)"></path>${path("M 10 20 L 80 20")}</g>${path("M 100 40 L 150 40")}`);
    expect(result.borders).toEqual([{ x0: 10, x1: 80, y: 30 }, { x0: 100, x1: 150, y: 40 }]);
    expect(result.vectorGeometry.issues).toEqual([]);
  });

  it("keeps incomplete markup and nameless clip markup distinct", () => {
    expect([...svgTags("garbage < ? <path d=\"M 0 0\"/> <path")].map(({ tag }) => tag)).toEqual(['<path d="M 0 0"/>']);
    expect([...svgTags("<><path/>", true)].map(({ tag }) => tag)).toEqual(["<>", "<path/>"]);
  });

  it.each([
    ["Ø,1875,;", "Ø,1875"], ["2X", "2X"], [",;", ""], ["1,;x", "1,;x"],
  ])("strips only trailing dimension punctuation: %s", (input, expected) => {
    expect(trimDimensionPunctuation(input)).toBe(expected);
  });

  it.each([
    ["UNLESS OTHERWISE SPECIFIED", true], ["general tolerances", true], ["TOLERANCE", true],
    ["\nX.XXX= .005", true], [".X", true], [".XXXXX", false], ["a.XX ", false],
    ["intolerance", false], ["general toleranceX", false],
  ])("preserves tolerance label recognition: %s", (input, expected) => {
    expect(hasToleranceLabel(input)).toBe(expected);
  });

  const size = 200 * 1024;
  it.each([
    ["number matcher", () => svgNumbers("9".repeat(size) + ".e+")],
    ["path validation", () => svgPathTokens("M " + "9".repeat(size) + ".e+")],
    ["path tokenization", () => svgPathTokens("M " + "0 ".repeat(size / 2))],
    ["RGB whitespace", () => parse(path("M 10 20 L 80 20", "rgb(" + " ".repeat(size) + "!)"))],
    ["RGB digits", () => parse(path("M 10 20 L 80 20", "rgb(" + "9".repeat(size) + ".,0,0)"))],
    ["clip tags", () => parse('<defs><clipPath id="c">' + "<".repeat(size) + '></clipPath></defs><g clip-path="url(#c)"></g>')],
    ["unclosed tags", () => parse("<path ".repeat(Math.ceil(size / 6)))],
    ["unclosed root tags", () => readSvgGeometry("<svg ".repeat(Math.ceil(size / 5)), { width: 600, height: 800 })],
    ["unclosed definition tags", () => parse("<image ".repeat(Math.ceil(size / 7)))],
    ["unclosed clip definitions", () => parse('<clipPath id="c">'.repeat(Math.ceil(size / 17)))],
    ["dimension punctuation", () => trimDimensionPunctuation(",".repeat(size) + "x")],
    ["tolerance label", () => hasToleranceLabel("X".repeat(size) + ".XXXXX")],
  ] as const)("bounds hostile 200 KB %s to 500 ms", (_name, run) => {
    const start = performance.now();
    run();
    expect(performance.now() - start).toBeLessThan(500);
  });
});
