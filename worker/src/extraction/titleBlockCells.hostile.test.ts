// @vitest-environment node
//
// OVD-985 and OVD-989: the cell reader runs on text from an uploaded PDF, so its work must stay bounded by
// what it is allowed to read, not by how much a file contains. Two kinds of test:
//
//  - each cap (line length, lines, labels, runs per page) has a test that exceeds only that cap, and that
//    fails when only that cap is removed, so no cap hides behind another;
//  - the work grows linearly with the length of a line (blank runs and long tokens before labels were
//    quadratic) and stays small on a page that sits just under every cap at once.
//
// Time limits are generous multiples of the measured time (tens of milliseconds): they exist to tell
// linear from quadratic work, not to measure a machine. No model, no network, no poppler.

import { describe, expect, it } from "vitest";
import { isLabelLikeToken, readTitleBlockCells, type CellRead } from "./titleBlockCells";

function read(text: string): CellRead[] {
  return readTitleBlockCells(text.split("\n").map((raw, index) => ({ page: 1, lineNumber: index + 1, raw })));
}

// The fastest of a few runs: a loaded machine slows a run down, never speeds it up.
function bestMs(work: () => void, repeats = 5): number {
  work();
  let best = Number.POSITIVE_INFINITY;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

// A page the reader may read: one label with its value.
const LABEL_AND_VALUE = ["DWG. NO.", "  1000-1"];

describe("each cap of the cell reader is tested alone", () => {
  it("MAX_LINE_LENGTH: a line over 2,000 characters is not read, a shorter one is", () => {
    const longLine = `DWG. NO.   1000-1${" ".repeat(2_000)}`;
    const shortLine = `DWG. NO.   1000-1${" ".repeat(1_900)}`;
    expect(longLine.length).toBeGreaterThan(2_000);
    expect(shortLine.length).toBeLessThanOrEqual(2_000);
    expect(read(longLine)).toEqual([]);
    expect(read(shortLine).map((cell) => cell.value)).toEqual(["1000-1"]);
  });

  it("MAX_LINES_PER_PAGE: a page of 401 lines is not read, 400 are (blank lines count)", () => {
    const page = (lines: number) => [...LABEL_AND_VALUE, ...Array.from({ length: lines - LABEL_AND_VALUE.length }, () => "")].join("\n");
    expect(read(page(401))).toEqual([]);
    expect(read(page(400)).map((cell) => cell.value)).toEqual(["1000-1"]);
  });

  it("MAX_LABELS_PER_PAGE: 401 labels on a page are not read, 400 are", () => {
    // One line of labels: few lines and no runs, so no other cap can be what stops the page.
    const labels = (count: number) => "PN  ".repeat(count);
    expect(labels(401).length).toBeLessThan(2_000);
    expect(read(labels(401))).toEqual([]);
    expect(read(labels(400))).toHaveLength(400);
  });

  it("MAX_RUNS_PER_PAGE: a page with 2,001 runs is not read, 2,000 are", () => {
    // One label with one value, then lines of runs two spaces apart: few lines and one label, so only the run
    // cap applies. `runs` counts the value too.
    const page = (runs: number) => {
      const lines = ["DWG. NO.  1000-1"];
      for (let remaining = runs - 1; remaining > 0; remaining -= 100) {
        // Far to the right of the label, so none of it is in the label's cell.
        lines.push(`${" ".repeat(100)}${Array.from({ length: Math.min(100, remaining) }, (_, index) => `r${index}`).join("  ")}`);
      }
      return lines.join("\n");
    };
    const over = page(2_001);
    const at = page(2_000);
    expect(read(over)).toEqual([]);
    expect(read(at).map((cell) => cell.value)).toEqual(["1000-1"]);
  });

  it("MAX_DY: a value more than 20 lines under its label is not owned", () => {
    const lines = ["DWG. NO.", ...Array.from({ length: 20 }, () => ""), "  1000-1"];
    expect(read(lines.join("\n"))[0]).toMatchObject({ status: "empty" });
    const near = ["DWG. NO.", ...Array.from({ length: 19 }, () => ""), "  1000-1"];
    expect(read(near.join("\n"))[0]).toMatchObject({ status: "value", value: "1000-1" });
  });
});

describe("the work is linear in the length of a line", () => {
  // The first run of the line is a lone character far to the left, then hundreds of blank columns, then
  // many labels ("PN 1 " repeated: a label after a token with a digit).
  const blankThenLabels = (blanks: number, labels = 198) => `x${" ".repeat(blanks)}${"PN 1 ".repeat(labels)}`;
  const page = (line: string, lines: number) => Array.from({ length: lines }, () => line).join("\n");

  it("reads 40 lines of 1,000 blanks and 198 labels in a fraction of a second", () => {
    const sheet = page(blankThenLabels(1_000), 40);
    expect(blankThenLabels(1_000).length).toBeLessThanOrEqual(2_000);
    // A page of 40 x 198 labels is over the label cap, so it is also not read; the time is the point (the old
    // reader took 12 seconds for these 40 lines).
    expect(bestMs(() => read(sheet), 3)).toBeLessThan(5_000);
  });

  it("does not take longer for a line with 4 times the blanks before its labels", () => {
    // Under the label cap, so the whole page is read: 400 / 198 = 2 lines of labels.
    const short = page(blankThenLabels(250, 100), 3);
    const long = page(blankThenLabels(1_000, 100), 3);
    const ratio = bestMs(() => read(long)) / Math.max(bestMs(() => read(short)), 2);
    // Linear work is a ratio of about 1 (the labels are the same); quadratic is about 16.
    expect(ratio).toBeLessThan(5);
  });

  it("reads 100 lines of a 1,900 character token followed by a label in a fraction of a second", () => {
    const sheet = page(`${"x".repeat(1_900)}  REV`, 100);
    expect(bestMs(() => read(sheet), 3)).toBeLessThan(3_000);
  });

  it("does not take longer for a token 4 times as long before a label", () => {
    const short = page(`${"x".repeat(475)}  REV`, 100);
    const long = page(`${"x".repeat(1_900)}  REV`, 100);
    const ratio = bestMs(() => read(long)) / Math.max(bestMs(() => read(short)), 5);
    // The line is 4 times as long: linear is about 4 (a little more from memory), quadratic is about 16.
    expect(ratio).toBeLessThan(9);
  });

  // The digit rule asks whether the token before a label holds a digit. Looking back over the token for each label
  // is quadratic in a token that holds many labels ("PN.PN.PN. ..."): 62, 200 and 756 ms for 399 lines of 500, 1,000
  // and 2,000 characters. The cost is compared with the same page where the token holds no label, measured here, so
  // the bound follows the speed of the machine: a linear reader takes about as long on both, the old one 50 times.
  it("reads a token that holds many labels as fast as one that holds none (the digit rule is linear)", () => {
    const hostile = page(`REV  (${"PN.".repeat(700)}`.slice(0, 2_000), 399);
    const plain = page(`REV  (${"xyz".repeat(700)}`.slice(0, 2_000), 399);
    expect(hostile.split("\n")[0]!.length).toBe(2_000);
    const hostileMs = bestMs(() => read(hostile), 7);
    const plainMs = bestMs(() => read(plain), 7);
    expect(hostileMs).toBeLessThan(12 * plainMs + 40);
    expect(hostileMs).toBeLessThan(2_000);
  });

  it("does not take longer for a token 4 times as long that holds many labels", () => {
    const short = page(`REV  (${"PN.".repeat(700)}`.slice(0, 500), 399);
    const long = page(`REV  (${"PN.".repeat(700)}`.slice(0, 2_000), 399);
    const ratio = bestMs(() => read(long), 7) / Math.max(bestMs(() => read(short), 7), 5);
    // The line is 4 times as long, so linear work is a ratio of about 4; a quadratic one is about 16 and more.
    expect(ratio).toBeLessThan(10);
  });

  it("scans a line of repeated look-alike labels once", () => {
    const sheet = page("(REV(REV(REV(REV(REV(REV(REV(REV(REV(REV".repeat(40), 40);
    expect(bestMs(() => read(sheet), 3)).toBeLessThan(3_000);
  });
});

describe("a page just under every cap at once", () => {
  // 399 lines, 399 labels (one per line) and 1,596 runs that no label owns inline (they start 40 columns on), so each
  // run is looked up among all the labels: the most work the owner search can be given. A search over labels times
  // labels per run (254 million steps) takes seconds. The page is timed against the same runs under a single label,
  // so the bound follows the speed of the machine.
  const values = (line: number) => Array.from({ length: 4 }, (_, index) => `v${line}x${index}`).join("  ");
  const apart = (line: number) => `PN${" ".repeat(38)}${values(line)}`;

  it("is read in about the time of the same runs under one label, not seconds more", () => {
    const hostile = Array.from({ length: 399 }, (_, line) => apart(line)).join("\n");
    const control = Array.from({ length: 399 }, (_, line) => (line === 0 ? apart(line) : `${" ".repeat(40)}${values(line)}`)).join("\n");
    expect(read(hostile)).toHaveLength(399);
    expect(read(control)).toHaveLength(1);
    const hostileMs = bestMs(() => read(hostile), 5);
    const controlMs = bestMs(() => read(control), 5);
    expect(hostileMs).toBeLessThan(25 * controlMs + 60);
    expect(hostileMs).toBeLessThan(4_000);
  });

  it("is read in seconds at most with the labels stacked in one column", () => {
    const lines = Array.from({ length: 399 }, (_, line) => (line % 2 === 0 ? "PN" : `  ${Array.from({ length: 9 }, (_, index) => `c${index}`).join("  ")}`));
    const text = lines.join("\n");
    expect(bestMs(() => read(text), 3)).toBeLessThan(4_000);
  });
});

describe("a value that looks like a label but is spelled with other characters", () => {
  it.each([
    ["Cyrillic A in Q.A.", "Q.\u0410."],
    ["full-width Q.A.", "\uff31.\uff21."],
    ["zero-width space in Q.A.", "Q\u200b.A."],
    ["Cyrillic H in CHECKED", "C\u041dECKED"],
    ["Cyrillic E in REV", "R\u0415V"],
    ["soft hyphen in DRAWN", "DRA\u00adWN"],
    ["a combining mark in APPROVED", "APPROVED\u0301"],
    ["Greek capitals in ENG", "\u0395\u039d\u0393".replace("\u0393", "G")],
  ])("is a label token: %s", (_name, value) => {
    expect(isLabelLikeToken(value)).toBe(true);
  });

  it("stays a value when it is more than labels", () => {
    expect(isLabelLikeToken("Q.\u0410.-77")).toBe(false);
    expect(isLabelLikeToken("\u0410BC-001")).toBe(false);
  });

  it("is not made slow by a long run of combining marks or invisible characters", () => {
    expect(
      bestMs(() => {
        isLabelLikeToken(`Q.A.${"\u0301".repeat(50_000)}`);
        isLabelLikeToken(`Q${"\u200b".repeat(50_000)}.A.`);
      }, 3),
    ).toBeLessThan(3_000);
  });

  it("never reads such a value as the part number or revision of a cell", () => {
    const sheet = ["DWG. NO.    REV", "  Q.\u0410.      R\u0415V"].join("\n");
    const cells = read(sheet);
    expect(cells.map((cell) => cell.value)).toEqual([null, null]);
  });
});
