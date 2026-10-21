import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SupportedReviewField } from "../types.js";
import { buildWordLines, MAX_WORDS_TOTAL, parseBboxWords, type PdfWord } from "./pdfWords.js";
import {
  isLabelLikeToken,
  readTitleBlockCells,
  type CellField,
  type CellRead,
  type TitleBlockTextLine,
} from "./titleBlockCells.js";

const execFileAsync = promisify(execFile);

/** Pages beyond this cap are not OCR'd and report `not_read`. */
export const PDF_OCR_MAX_PAGES = 12;
/** Upper bound for one pdftoppm render and for one tesseract run. */
export const PDF_OCR_PAGE_TIMEOUT_MS = 60_000;
/**
 * Total budget for the whole OCR pass, starting before the tesseract version
 * probe. Every pdfinfo, pdftoppm, and tesseract call gets at most the time left;
 * a page whose next call would start with no time left reports `not_read`.
 */
export const PDF_OCR_TOTAL_TIMEOUT_MS = 120_000;
/** Bound for one pdfinfo or pdftotext call and for the tesseract version probe. */
export const PDF_TOOL_TIMEOUT_MS = 30_000;
/** Pages past this cap get no pdftotext call; their text layer is not read. */
export const PDF_TEXT_LAYER_MAX_PAGES = 50;
/** Total budget for the pdftotext loop; pages not reached in time are not read. */
export const PDF_TEXT_LAYER_TOTAL_TIMEOUT_MS = 60_000;
/** Total budget for the word box pass (`pdftotext -bbox`); pages not reached in time keep the layout text only. */
export const PDF_WORD_BOXES_TOTAL_TIMEOUT_MS = 30_000;
/** Pages are rendered at no less than this resolution so small print is legible. */
export const PDF_OCR_MIN_DPI = 200;
/**
 * A page whose CropBox would need more pixels than this at the DPI floor is
 * reported failed instead of rendered. An E size sheet at 200 DPI is about
 * 60 MP, and tesseract uses about 12 bytes a pixel, so this keeps one page
 * well inside the worker's memory.
 */
export const PDF_OCR_MAX_PIXELS = 70_000_000;
export const PDF_OCR_UNAVAILABLE_WARNING_CODE = "pdf_ocr_tesseract_unavailable";

/**
 * ok: OCR ran on the page (text may be empty).
 * failed: page size unknown, the page is over PDF_OCR_MAX_PIXELS at the DPI
 * floor, or the render or tesseract errored or timed out.
 * unavailable: no tesseract binary, or the version probe failed or timed out.
 * not_read: the page is past PDF_OCR_MAX_PAGES, or PDF_OCR_TOTAL_TIMEOUT_MS ran
 * out before its next call could start.
 * Anything other than ok means the raster content of that page was not read.
 */
export type PdfOcrStatus = "ok" | "failed" | "unavailable" | "not_read";

/**
 * Set on a page that a fixed limit kept from being read, so no rerun of the
 * same bytes can read it: `page_cap` (not_read, past PDF_OCR_MAX_PAGES) or
 * `pixel_cap` (failed, over PDF_OCR_MAX_PIXELS at the DPI floor). A timeout,
 * a spent budget, or a tool error sets no limit.
 */
export type PdfOcrLimit = "page_cap" | "pixel_cap";

export type PdfTextPage = {
  page: number;
  /**
   * Text layer from pdftotext. When the whole document has no text layer this
   * falls back to the OCR text, as before. Use `ocrText` for OCR output alone.
   */
  text: string;
  /** OCR output only, never mixed with the text layer. */
  ocrText: string;
  ocrStatus: PdfOcrStatus;
  /** Present only when a fixed limit kept the page from being read. */
  ocrLimit?: PdfOcrLimit;
  /**
   * OVD-989: the text layer's words with their boxes in points, from `pdftotext -bbox`. Geometry only: the
   * title block reader uses it when present, because `-layout` columns are squeezed where a word is set
   * larger than its neighbours. Absent when the page has no text layer, when poppler could not print the
   * boxes, or when the page has too many words; nothing else reads it.
   */
  words?: PdfWord[];
};

export type PdfTextExtraction = {
  pageCount: number;
  /**
   * False when pdfinfo failed or was unparsable. `pageCount` is then a floor of
   * 1 and later pages may exist unread, so the drawing is not fully read.
   */
  pageCountKnown: boolean;
  /**
   * The single fail closed answer for export gates: true only when the page
   * count is known, every page's text layer was read without error, and every
   * page has `ocrStatus` ok. Anything else must hold the drawing.
   */
  drawingFullyRead: boolean;
  /** True when there is no text layer and OCR produced text. */
  ocr: boolean;
  pages: PdfTextPage[];
};

export type RenderedPreviewAsset = {
  localPath: string;
  pageNumber: number;
  kind: "thumbnail" | "page";
  width: number | null;
  height: number | null;
  contentType: string;
};

export type SourceRegion = {
  page: number;
  line: number;
  columnStart: number;
  columnEnd: number;
  label: string | null;
};

export type ExtractedFieldSignal = {
  value: string | null;
  confidence: number;
  reviewNeeded: boolean;
  reasons: string[];
  sourceRegion: SourceRegion | null;
  snippet: string | null;
};

export type CandidateSignal = {
  value: string;
  page: number;
  line: number;
  columnStart: number;
  columnEnd: number;
  label: string | null;
  score: number;
  reasons: string[];
  snippet: string;
};

type StructuredLine = {
  page: number;
  lineNumber: number;
  raw: string;
  normalized: string;
  firstColumn: number;
  lastColumn: number;
};

type TitleBlockBounds = {
  startLine: number;
  endLine: number;
};

export type ExtractedDrawingSignals = {
  description: ExtractedFieldSignal;
  partNumber: ExtractedFieldSignal;
  revision: ExtractedFieldSignal;
  material: ExtractedFieldSignal;
  finish: ExtractedFieldSignal;
  process: ExtractedFieldSignal;
  generalTolerance: string | null;
  tightestTolerance: string | null;
  /** OVD-976: tightest tolerance in inches; null when its units could not be resolved. */
  tightestToleranceValueInch?: number | null;
  tightestToleranceUnit?: ToleranceUnit | null;
  tightestToleranceDrawingUnits?: DrawingUnits | null;
  quoteDescription: string | null;
  quoteFinish: string | null;
  reviewFields: SupportedReviewField[];
  notes: string[];
  threads: string[];
  evidence: Array<{ field: string; page: number; snippet: string; confidence: number; reasons: string[] }>;
  warnings: string[];
  debugCandidates: Record<string, CandidateSignal[]>;
};

const PART_NUMBER_LABELS = ["DWG. NO.", "DWG NO.", "DWG NO", "DRAWING NUMBER", "PART NUMBER", "PART NO", "P/N", "PN"];
const REVISION_LABELS = ["REVISION", "REV"];
const DESCRIPTION_LABELS = ["TITLE:", "TITLE", "DESCRIPTION"];
const MATERIAL_LABELS = ["MATERIAL"];
const FINISH_LABELS = ["FINISH", "COATING", "PLATING", "SURFACE FINISH"];
const PROCESS_LABELS = ["PROCESS"];
const TITLE_BLOCK_KEYWORDS = [
  ...PART_NUMBER_LABELS,
  ...REVISION_LABELS,
  ...DESCRIPTION_LABELS,
  ...MATERIAL_LABELS,
  ...FINISH_LABELS,
  "SIZE",
  "SCALE",
  "SHEET",
  "WEIGHT",
  "UNLESS OTHERWISE SPECIFIED",
  "APPROVALS",
] as const;
const FIELD_LABEL_PATTERN =
  /\b(?:title|description|dwg(?:\.|\s)*no|drawing\s*number|part(?:\s*number|\s*no)?|p\/n|pn|revision|rev|material|finish|coating|plating|surface\s*finish|process|scale|sheet|size|weight|approvals|engineer|checker|date|ec\/date)\b/i;
const PART_NUMBER_PATTERN = /\b\d{3,5}-\d{4,6}(?:-[A-Z0-9]{1,4})?\b/;
const SPEC_PATTERN = /\b(?:MIL|ASTM|AMS|QQ|ASME|SAE|ISO|DIN)[-\s/]*[A-Z0-9.]+/i;
const DATE_PATTERN = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b/i;
const SIGNATURE_PATTERN = /\b(?:engineer|checker|checked|approvals|approved|date|ec\/date|ecn)\b/i;
// Boilerplate that appears in a proprietary notice regardless of whose name
// is on it. Naming a specific company here would tie the parser to one
// customer and break the moment a drawing is anonymised.
const PROPRIETARY_NOTICE_PATTERN =
  /\b(?:PROPRIETARY|CONFIDENTIAL|APPROVALS|SOLE PROPERTY|REPRODUCTION IN PART|WRITTEN PERMISSION)\b/i;
const FINISH_KEYWORD_PATTERN = /\b(?:anodize|anodized|paint|painted|plate|plated|passivate|passivated|coat|coated|powder|oxide|chromate|mil-|ams|astm|type\s*[ivx0-9]+|class\s*\d+)\b/i;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function titleCaseFromStem(stem: string) {
  return stem
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function collectStructuredLines(pages: PdfTextPage[]) {
  return pages.flatMap((page) =>
    page.text
      .split(/\r?\n/)
      .map((line, index) => ({
        page: page.page,
        lineNumber: index + 1,
        raw: line.replace(/\r/g, ""),
        normalized: normalizeWhitespace(line),
        firstColumn: line.search(/\S/),
        lastColumn: Math.max(line.length - 1, 0),
      }))
      .filter((item) => item.normalized.length > 0 && item.firstColumn >= 0),
  );
}

function collectNotes(lines: StructuredLine[]) {
  const notes: string[] = [];
  let capture = false;

  for (const item of lines) {
    if (/^notes?[:\s]*$/i.test(item.normalized)) {
      capture = true;
      continue;
    }

    if (capture) {
      if (/^(material|finish|revision|rev|title|scale|sheet)\b/i.test(item.normalized)) {
        break;
      }

      notes.push(item.normalized);
      if (notes.length >= 5) {
        break;
      }
    }
  }

  return notes;
}

function collectThreads(text: string) {
  const metricMatches = text.match(/\bM\d+(?:x\d+(?:\.\d+)?)?\b/gi) ?? [];
  const imperialMatches =
    text.match(/\b(?:\d+\/\d+|\d+)-\d+\s*(?:UNC|UNF|UNEF|NPT|NPTF)(?:\s*-\s*[23][AB])?\b/gi) ?? [];
  return [...new Set([...metricMatches, ...imperialMatches].map((match) => normalizeWhitespace(match)))].slice(0, 12);
}

export type ToleranceUnit = "in" | "mm" | "um" | "mil" | "unknown";
export type DrawingUnits = "inch" | "metric" | "mixed" | "unspecified";
type LengthUnit = Exclude<ToleranceUnit, "unknown">;

/*
 * OVD-976: the tightest tolerance in inches, under one fail-closed policy. Anything that cannot be
 * read safely gives valueInch null with the raw text kept, so the OVD-683 gate blocks the quote and
 * the user enters the tolerance.
 *
 * P1 Drawing units come only from explicit declarations: a unit word after DIMENSIONS/UNITS/
 *    TOLERANCES ("DIMENSIONS ARE IN INCHES", "UNITS: MM", "UNITS [MM]"), a unit word alone on its
 *    line or bracketed on its own ("METRIC", "[mm]"), or a metric general-tolerance standard
 *    (ISO 2768, DIN 7168, JIS B 0405, EN 22768). A declaration that lists a second unit word right
 *    after the first ("UNITS: INCH MM", "DIMENSIONS IN INCHES [MM]") declares both systems.
 * P2 Any other unit token (a 6 MM dowel pin, Ra 0.8 µm, 10mm in a revision note, MM/DD/YY) is not a
 *    declaration and never changes the drawing units.
 * P3 A unit on the same line right after the value (optionally in one bracket pair) beats the drawing
 *    units. %, per-length ratios, microinches and scientific notation are unresolved.
 * P4 A bare value follows the single declared system. With both declared it is unresolved. With none,
 *    it is inches only when printed with at least three decimals (".005") and below 0.1; otherwise
 *    it is unresolved.
 * P5 Angular values are skipped; a bracketed bare value is the inch side of a dual dimension only when
 *    it matches the metric value; decimal commas, zero and non-finite values are unresolved.
 * P6 An unresolved value blocks the result when any of its readings could be tighter than the
 *    tightest resolved value; one that is looser in every reading is ignored.
 * P7 Inch values are floored (exactly) to the 4 decimals of numeric(10,4); a value below 0.0001 in is
 *    unresolved rather than rounded up.
 */

// Exact unit-to-inch ratios, so a converted value is floored without binary rounding error.
const INCH_RATIO: Record<LengthUnit, readonly [bigint, bigint]> = {
  in: [1n, 1n],
  mm: [10n, 254n],
  um: [10n, 254_000n],
  mil: [1n, 1_000n],
};
const UNIT_TO_INCH: Record<LengthUnit, number> = { in: 1, mm: 1 / 25.4, um: 1 / 25_400, mil: 1 / 1_000 };
const UNIT_TO_MM: Partial<Record<LengthUnit, number>> = { mm: 1, um: 0.001 };
const UNIT_LABEL: Record<LengthUnit, string> = { in: "in", mm: "mm", um: "µm", mil: "mil" };
const MIN_UNDECLARED_INCH_DECIMALS = 3;
const MAX_UNDECLARED_INCH_TOLERANCE = 0.1;
// approved_part_requirements.tightest_tolerance_inch is numeric(10,4), which rounds half up, so a
// stored value is floored to 4 decimals here. Larger values are not tolerances and would overflow it.
const STORED_TOLERANCE_SCALE = 10_000n;
const MAX_STORED_TOLERANCE_INCH = 1_000;
// The smaller reading of a number with no unit: as millimeters.
const SMALLEST_BARE_READING = UNIT_TO_INCH.mm;
const DUAL_DIMENSION_RELATIVE_TOLERANCE = 0.05;

const UNIT_WORD = String.raw`(?:MM|RNM|MILLIMET(?:ER|RE)S?|MILIMETROS?|METRIC|INCH(?:ES)?)(?![A-Z0-9])`;
// DIMENSIONS/UNITS/TOLERANCES (and the German, French and Spanish words), then optional linking words.
// The linking words are bounded: an unbounded repeat overflows the regexp stack on a line of a few
// million separators, and a real declaration uses at most a few of them.
const DECLARATION_INTRODUCER = String.raw`\b(?:ALL[ \t]+DIMENSIONS|DIMENSIONS?|DIMS|UNITS?|MEASUREMENTS?|TOL(?:ERANCES?|S)?\.?|MA(?:SS|ß)E|COTES|MEDIDAS)(?:[ \t]*[:=–—-]|[ \t]+(?:ARE|IS|SHOWN|GIVEN|EXPRESSED|EN)){0,8}`;
// A second unit word right after the first one on the declaration line, so the drawing declares
// both systems ("DIMENSIONS IN INCHES [MM]", "UNITS: INCH / MM", and a units field that lists both
// options, "UNITS: INCH MM", "UNITS: MM X INCH", or a checkbox or OCR rendering of one such as
// "UNITS: INCH ☐ MM ☒", "UNITS: INCH [ ] MM [X]" or "UNITS: INCH | MM"). Only blanks and at most 12
// marks (any character but a letter, digit or line break, or the words X, AND and OR) may sit
// between the two words, so a unit later on the line ("UNITS: INCH; NOTE 6 MM DOWEL", "UNITS: INCH;
// 6 MM DOWEL") is not a second declaration. A bare IN counts only when it ends the phrase, after
// blanks or after a mark ("DIMENSIONS IN MM IN ACCORDANCE WITH" and "DIMENSIONS IN MM, IN ACCORDANCE
// WITH" stay metric). Each repeated piece after the single leading [ \t]* starts with a non-blank
// character and the marks are bounded, which keeps the match linear.
const UNIT_LIST_MARK = String.raw`(?:[^A-Za-z0-9 \t\r\n]|(?:X|AND|OR)(?![A-Z0-9]))`;
const SECOND_DECLARED_UNIT = String.raw`(?:[ \t]*(?:${UNIT_LIST_MARK}[ \t]*){0,12}(${UNIT_WORD}|IN\.?(?=[ \t]*(?:[\r\n,;:)\]]|$))))?`;
const DECLARATION_PATTERNS = [
  // "DIMENSIONS ARE IN MILLIMETERS", "UNITS: MM", "UNITS - MM", "DIMENSIONS IN INCHES [MM]".
  new RegExp(
    String.raw`${DECLARATION_INTRODUCER}(?:[ \t]+IN)?[ \t]*(?:[:=–—-][ \t]*)?(${UNIT_WORD})${SECOND_DECLARED_UNIT}`,
    "gi",
  ),
  // The bare word IN is a unit only after a separator, a bracket or another IN ("UNITS: IN",
  // "DIMENSIONS IN IN"), and only when it ends the phrase; "DIMENSIONS ARE IN" is a preposition.
  new RegExp(
    String.raw`${DECLARATION_INTRODUCER}(?:[ \t]+IN[ \t]+|[ \t]*[:=–—-][ \t]*|[ \t]*[[(][ \t]*)(IN)\.?(?=[ \t]*(?:$|[,;:)\][(/&]|(?:X|AND|OR)(?![A-Z0-9])))${SECOND_DECLARED_UNIT}`,
    "gim",
  ),
];
// A unit bracketed but not attached to a number ("UNITS [MM]", "ALL DIMENSIONS (mm)"); "±0.05 [mm]"
// and "216 (MM)" are not declarations, which followsNumber checks in code. A lookbehind such as
// (?<![\d.][ \t]*) is quadratic on a long run of tabs once V8 has compiled the regex natively.
const BRACKETED_UNIT = new RegExp(String.raw`[[(][ \t]*(${UNIT_WORD})[ \t]*[\])]`, "gi");
// A unit word alone on its line ("METRIC", "mm", "[mm]"), matched against each trimmed line.
const UNIT_ALONE_ON_LINE = new RegExp(String.raw`^[[(]?[ \t]*(${UNIT_WORD})[ \t]*[\])]?$`, "i");
const METRIC_TOLERANCE_STANDARD = /\b(?:ISO[ \t]*2768|DIN[ \t]*7168|JIS[ \t]*B[ \t]*0405|EN[ \t]*22768)\b/i;

/**
 * Folds width variants, diacritics ("millimètres", "MILÍMETROS"), OCR homoglyphs and degree
 * look-alikes so unit words match one spelling. Combining marks are dropped before the
 * decomposition as well as after it: canonical reordering is quadratic on a long run of marks of
 * mixed classes, and every mark decomposes only to marks, so the result is the same.
 */
function normalizeUnitText(text: string) {
  return (
    text
      .replace(/[º˚]/g, "°")
      .replace(/\p{M}+/gu, "")
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      // Two Greek capital mu are a homoglyph of MM; a single one is the upper case of the micro sign.
      .replace(/ΜΜ/g, "MM")
      .replace(/[мМ]/g, (letter) => (letter === "м" ? "m" : "M"))
  );
}

// Whether the nearest character before index, past spaces and tabs, is a digit or a decimal point.
// Each blank run is scanned at most once, for the bracket that ends it, so the check stays linear.
function followsNumber(text: string, index: number) {
  let position = index - 1;
  while (position >= 0 && (text.charAt(position) === " " || text.charAt(position) === "\t")) {
    position -= 1;
  }
  return position >= 0 && /[\d.]/.test(text.charAt(position));
}

function detectDeclaredUnits(text: string) {
  const declared = { inch: false, metric: METRIC_TOLERANCE_STANDARD.test(text) };
  const declare = (word: string | undefined) => {
    if (word !== undefined) {
      declared[/^IN/i.test(word) ? "inch" : "metric"] = true;
    }
  };
  for (const pattern of DECLARATION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      match.slice(1).forEach(declare);
    }
  }
  for (const match of text.matchAll(BRACKETED_UNIT)) {
    if (!followsNumber(text, match.index ?? 0)) {
      declare(match[1]);
    }
  }
  // Line by line rather than one multiline regex, whose blank runs around the optional bracket
  // backtrack quadratically on a long line of spaces.
  for (const line of text.split(/[\n\r\u2028\u2029]/)) {
    declare(UNIT_ALONE_ON_LINE.exec(line.trim())?.[1]);
  }
  return declared;
}

type ValueSuffix =
  | { kind: "unit"; unit: LengthUnit }
  | { kind: "in-word" }
  | { kind: "angular" }
  | { kind: "unresolved"; smallestReading: number };

const NOT_A_WORD_END = String.raw`(?![A-Z0-9]|-[A-Z0-9])`;
// Order matters: inch marks before arcminutes, microinches before microns and inches.
const SUFFIX_TOKENS: ReadonlyArray<readonly [RegExp, ValueSuffix]> = [
  [/^(?:″|′′|''|"|”)/, { kind: "unit", unit: "in" }],
  [/^(?:°|DEG(?:REES?|S)?\.?(?![A-Z])|′|')/i, { kind: "angular" }],
  [/^%/, { kind: "unresolved", smallestReading: SMALLEST_BARE_READING }],
  [/^(?:[µμu][ \t]?IN(?:CH(?:ES)?)?|[µμ]["”]|MICRO-?INCH(?:ES)?)(?![A-Z0-9])/i, { kind: "unresolved", smallestReading: 1e-6 }],
  [new RegExp(String.raw`^(?:MM|RNM|MILLIMET(?:ER|RE)S?)${NOT_A_WORD_END}`, "i"), { kind: "unit", unit: "mm" }],
  [
    new RegExp(String.raw`^(?:[µμ]M|UM|MICRONS?|MICROMET(?:ER|RE)S?|M[KК]M|[µμ])${NOT_A_WORD_END}`, "i"),
    { kind: "unit", unit: "um" },
  ],
  [new RegExp(String.raw`^MILS?${NOT_A_WORD_END}`, "i"), { kind: "unit", unit: "mil" }],
  [new RegExp(String.raw`^INCH(?:ES)?${NOT_A_WORD_END}`, "i"), { kind: "unit", unit: "in" }],
  // The bare word IN only when it ends the callout ("±.005 IN", not "±0.1 IN ALL DIRECTIONS").
  [/^IN\.?(?=[ \t]*(?:$|[,;:)\]]))/i, { kind: "in-word" }],
];

/** Reads the unit written right after a value. lineRest never extends past the value's own line. */
function readValueSuffix(lineRest: string): { suffix: ValueSuffix | null; text: string } {
  const opening = /^[ \t]*([[(][ \t]*)?/.exec(lineRest)?.[0] ?? "";
  const rest = lineRest.slice(opening.length);
  for (const [pattern, suffix] of SUFFIX_TOKENS) {
    const token = pattern.exec(rest)?.[0];
    if (token === undefined) {
      continue;
    }
    let consumed = opening.length + token.length;
    if (/[[(]/.test(opening)) {
      const closing = /^[ \t]*[\])]/.exec(lineRest.slice(consumed))?.[0];
      if (closing === undefined) {
        return { suffix: null, text: "" };
      }
      consumed += closing.length;
    }
    const ratio = suffix.kind === "unit" ? /^[ \t]*\/[ \t]*[A-Zµμ0-9]+/i.exec(lineRest.slice(consumed))?.[0] : undefined;
    if (ratio !== undefined) {
      // "±0.1 mm/m" is a per-length tolerance, which may be tighter than anything else on the part.
      return { suffix: { kind: "unresolved", smallestReading: 0 }, text: lineRest.slice(0, consumed) + ratio };
    }
    return { suffix, text: lineRest.slice(0, consumed) };
  }
  return { suffix: null, text: "" };
}

type ToleranceCandidate = {
  /** The number as printed, e.g. ".005", "1/64" or "0,05". */
  printed: string;
  value: number;
  /** Digits printed after the decimal point. */
  decimals: number;
  start: number;
  end: number;
  bracketed: boolean;
  suffix: ValueSuffix | null;
  suffixText: string;
  /** A number that cannot be read safely: a decimal comma ("0,05" or "1,000") or scientific notation. */
  problem: "decimal-comma" | "scientific" | null;
  /** The bracketed inch side of a consistent dual dimension. */
  pairedInch: boolean;
  /**
   * OVD-989: the decimal places a general-tolerance table row covers ("THREE PLACE DECIMAL" or ".XXX"
   * is 3), or null for any other value (a callout on a feature, a note).
   */
  rowPlaces: number | null;
  /** Where the printed number begins in the text. */
  numberStart: number;
};

function buildCandidate(text: string, start: number, numberStart: number, number: string): ToleranceCandidate | null {
  let printed = number;
  let end = numberStart + number.length;
  const fraction = /^\d+$/.test(number) ? /^\/\d+(?![\d.,])/.exec(text.slice(end))?.[0] : undefined;
  if (fraction !== undefined) {
    printed += fraction;
    end += fraction.length;
  }
  const scientific = /^[eE][-+]?\d/.test(text.slice(end));
  const lineRest = text.slice(end, end + 40).split(/[\r\n]/, 1)[0] ?? "";
  const { suffix, text: suffixText } = scientific ? { suffix: null, text: "" } : readValueSuffix(lineRest);
  if (suffix?.kind === "angular") {
    return null;
  }

  const value =
    fraction !== undefined ? Number(number) / Number(fraction.slice(1)) : Number.parseFloat(printed.replace(",", "."));
  return {
    printed,
    value,
    decimals: (/\.(\d+)$/.exec(printed)?.[1] ?? "").length,
    start,
    end,
    bracketed: /[[(]\s*$/.test(text.slice(Math.max(0, start - 3), start)),
    suffix,
    suffixText: suffixText.replace(/^[ \t]+/, " ").replace(/μ/g, "µ"),
    problem: printed.includes(",") ? "decimal-comma" : scientific ? "scientific" : null,
    pairedInch: false,
    rowPlaces: null,
    numberStart,
  };
}

const PLUS_MINUS_VALUE = /(?:±|∓|\+[ \t]*\/[ \t]*[-−–]|\+[-−])\s*(\d+(?:[.,]\d+)?|[.,]\d+)/g;
const DECIMAL_PLACE_PHRASE = /\b(TWO|THREE|FOUR) PLACE DECIMAL/gi;
const PLACE_WORDS: Record<string, number> = { TWO: 2, THREE: 3, FOUR: 4 };
// ".X", ".XX", "X.XXX": a general-tolerance table row labelled by the digits it covers.
const X_ROW_LABEL = /(?:^|[^A-Z0-9])X?\.(X{1,4})[ \t]*$/i;
// "X.X 0.3", "X.XX 0.10": a metric row labelled by the digits it covers, with no sign in the text layer.
const SIGNLESS_X_ROW = /(?<![A-Z0-9.])X\.(X{1,4})[ \t]+(\d+(?:[.,]\d+)?|[.,]\d+)/gi;
// "THREE PLACE DECIMAL ±.005": the sign and value that follow a row phrase are the row's own value.
const PLACE_ROW_LABEL = /\b(TWO|THREE|FOUR)\s+PLACE\s+DECIMAL[\s+#]*$/i;
// An angle label directly before the value ("ANGULAR ±.5", "ANGLES UNLESS NOTED ±.5", "90° ±.5").
// Only filler words may sit between, so "ANGULAR AND LINEAR ±.005" or "ANGLE BRACKET LENGTH ±.005"
// keep their (linear) value.
const ANGULAR_LABEL =
  /(?:\b(?:ANGULAR|ANGLES?|DEG(?:REES?|S)?)\b(?:[ \t:.,=]+(?:TOL(?:ERANCES?|S)?|DIMENSIONS?|UNLESS|OTHERWISE|NOTED|SPECIFIED)\b)*|°)[ \t:.,=]*$/i;

// One linear scan decides whether any table row can exist, so a hostile line of plus-minus values pays
// nothing for the row labels.
const MAY_HAVE_TABLE_ROWS = /PLACE\s+DECIMAL|\.X/i;

/**
 * ".XX ±.01" or "THREE PLACE DECIMAL ±.005": the label directly before a sign names the places the row covers.
 * Only a few characters are read, from the same line, so a long line stays linear.
 */
function rowPlacesBefore(text: string, start: number): number | null {
  const before = text.slice(Math.max(0, start - 40), start).split("\n").pop() ?? "";
  const xRow = X_ROW_LABEL.exec(before);
  if (xRow) {
    return xRow[1]!.length;
  }
  const wordRow = PLACE_ROW_LABEL.exec(before);
  return wordRow ? (PLACE_WORDS[wordRow[1]!.toUpperCase()] ?? null) : null;
}

/** The values written with a plus-minus sign, in the order printed. */
function collectSignedCandidates(text: string, mayHaveRows: boolean): ToleranceCandidate[] {
  const candidates: ToleranceCandidate[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(PLUS_MINUS_VALUE)) {
    const start = match.index ?? 0;
    const number = match[1] ?? "";
    // An angle label applies to the values after it on its line, up to the previous value. Only the
    // text since the previous value is searched, so a long line with many values stays linear.
    const sincePrevious = text.slice(previousEnd, start);
    previousEnd = start + match[0].length;
    if (ANGULAR_LABEL.test(sincePrevious.slice(sincePrevious.lastIndexOf("\n") + 1))) {
      continue;
    }
    const candidate = buildCandidate(text, start, previousEnd - number.length, number);
    if (candidate) {
      if (mayHaveRows) {
        candidate.rowPlaces = rowPlacesBefore(text, start);
      }
      candidates.push(candidate);
    }
  }
  return candidates;
}

/** "THREE PLACE DECIMAL .005": the value that follows a row phrase, with or without a sign. */
function collectPhraseCandidates(text: string): ToleranceCandidate[] {
  const candidates: ToleranceCandidate[] = [];
  for (const match of text.matchAll(DECIMAL_PLACE_PHRASE)) {
    const from = (match.index ?? 0) + match[0].length;
    const read = /^[\s+#]{0,24}(\d+(?:[.,]\d+)?|[.,]\d+)/.exec(text.slice(from, from + 40));
    const candidate = read ? buildCandidate(text, match.index ?? 0, from + read[0].length - read[1]!.length, read[1]!) : null;
    if (candidate) {
      candidate.rowPlaces = PLACE_WORDS[(match[1] ?? "").toUpperCase()] ?? null;
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * A metric table row whose plus-minus glyph is not in the text layer: "X.XX 0.10". The row label is followed
 * directly by the value, so a row with a sign ("X.XX ±0.10") is not read twice.
 */
function collectSignlessRows(text: string): ToleranceCandidate[] {
  const candidates: ToleranceCandidate[] = [];
  for (const match of text.matchAll(SIGNLESS_X_ROW)) {
    const number = match[2] ?? "";
    const candidate = buildCandidate(text, match.index ?? 0, (match.index ?? 0) + match[0].length - number.length, number);
    if (candidate) {
      candidate.rowPlaces = match[1]!.length;
      candidates.push(candidate);
    }
  }
  return candidates;
}

function collectToleranceCandidates(text: string) {
  const mayHaveRows = MAY_HAVE_TABLE_ROWS.test(text);
  const candidates = [
    ...collectSignedCandidates(text, mayHaveRows),
    ...collectPhraseCandidates(text),
    ...(mayHaveRows ? collectSignlessRows(text) : []),
  ];
  return candidates.sort((left, right) => left.start - right.start);
}

/*
 * OVD-989: which rows of a general-tolerance table apply.
 *
 * A table such as "TWO PLACE DECIMAL .01 / THREE PLACE DECIMAL .005 / FOUR PLACE DECIMAL .0010" is a
 * default for dimensions printed with that many decimal places. A drawing whose dimensions use only two
 * and three places is not toleranced by the four-place row, so reading the tightest row as the
 * drawing's tightest tolerance denied every drawing made from a template that prints one.
 *
 * The rule can only err towards a tighter value. A row is dropped on positive evidence alone, and a
 * missing number never counts as evidence, so reading more of the sheet than needed is always safe:
 *
 * T1 Readable: the whole drawing was read (drawingFullyRead: the page count is known, and every page's text layer
 *    and OCR were read; a page that was not read may print the dimension that keeps a row), the text layer is not
 *    OCR, no line was too long to scan, and at least MIN_READABLE_DIMENSIONS decimal numbers sit on lines that hold
 *    only dimension callouts (numbers, "2X", R, Ø, THRU, TYP, hole tags such as A1). This gate is strict on
 *    purpose: a miss only makes the sheet unreadable (T3).
 * T2 Evidence: on a readable sheet, the most decimal places printed anywhere in the text, counting every
 *    decimal number except the values of the table's own rows (".0010" in "FOUR PLACE DECIMAL .0010").
 *    No line or word is skipped, and no number is dropped for what is glued to it ("Ø.1875", "SR.0625",
 *    ".1875A", "1.2500"), so a dimension that shares a line with a note, a view label, a weight or the
 *    table itself still counts. A row applies unless every decimal number printed has fewer places than
 *    the row. An explicit "±" value that is not a table row is a tolerance on a feature and is kept.
 *    A text layer can garble a decimal, and a garbled four-place dimension must not be what drops the
 *    four-place row, so a fragment that is not a complete decimal counts as the places it may carry: a
 *    separator then blanks then digits ("Ø. 1875"), digits split by blanks (".18 75"), a mantissa and an
 *    exponent ("1.875E-1"), and a separator spelled with another character (a middle dot, a bullet, the
 *    Arabic decimal separator, an ideographic full stop) is a separator.
 * T3 When the sheet is not readable, a row of four or more places is not assumed to apply: it becomes
 *    an unresolved value like any other unclear unit (P6), so the result is valueInch null, unless a
 *    tighter explicit tolerance exists, and the OVD-683 beta gate asks the user. Rows of one to three
 *    places are read as before (the tightest printed row), which is the safe direction for a quote and
 *    changes nothing for a table without a four-place row.
 * T4 Raster: a page with a text layer can also carry a raster view whose dimensions only OCR reads. OCR
 *    digits are not trusted to drop a row, nor to set one in force. When the OCR text prints, as a dimension
 *    callout ("2X Ø.1875 THRU", or "Ø.1875" on a line with a view label, "Ø.1875 THRU SECTION A-A"), a decimal
 *    that the text layer does not print as the same whole number, with more places than T2 found, the text layer
 *    did not show every dimension, so the readable sheet is read as T3 reads one: a row of more places than both
 *    T2's evidence and MOST_PLACES_ASSUMED_IN_FORCE is an unresolved value, never dropped. A decimal the text layer
 *    prints (the table's own ".0010", every vector dimension OCR reads again) is no such evidence, but "1.0010" is
 *    not ".0010". Nor is a line of the table or the notes, or a number glued to other text (OCR garbles the table:
 *    ".005" as ", 5005").
 *
 * Known limit: a raster dimension that OCR does not read, reads with no more places than the text layer prints,
 * reads glued to other text, or reads as exactly a number the text layer prints, is not seen.
 */
const NON_DIMENSION_LINE_PATTERNS: readonly RegExp[] = [
  /\b(?:PLACE\s+DECIMAL|LINEAR|ANGULAR|BEND|BREAK\s+SHARP|RADII|WEIGHT|MASS)\b/i,
  /\b(?:SCALE|SHEET|UNLESS\s+OTHERWISE|TOLERANC\w*|SURFACE|INTERPRET)\b/i,
  /\b(?:ASME|ANSI|ISO|RA|RMS)\b|Y14/i,
  /(?:^|[^A-Z0-9])X?\.X{1,4}(?![A-Z0-9])/i,
];
// A decimal separator and the digits after it. The digits before it are not matched: a pattern that starts
// with \d* rescans a long digit run from every position in it, which is quadratic. `numberStartOf` finds the
// start of the whole number by walking back, once per separator.
const DECIMAL_NUMBER = /[.,]\d+/g;
// What a line that holds only dimensions is made of: "20X R.425", ".656 THRU    2X    .089 THRU", "A1, A2".
// The number is \d+(?:\.\d*)? and not \d+\.?\d*: with the optional dot between them, a long digit run followed by
// anything that is not a digit can be split between the two \d+ groups in as many ways as it has digits.
const DIMENSION_PREFIX = /^(?:\d{1,3}X)?[RCØ∅⌀]?/i;
const DIMENSION_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)?$/;
// A token is a count ("2X"), a radius, diameter or chamfer sign, and a number, each optional. The prefix is taken first
// and the rest must be a number or nothing: the optional prefix and the number never compete for the same characters,
// so there is nothing to backtrack over.
const isDimensionToken = (token: string) => DIMENSION_NUMBER.test(token.replace(DIMENSION_PREFIX, ""));
const CALLOUT_WORDS = new Set([
  "THRU", "ALL", "TYP", "TYPICAL", "DIA", "DIAMETER", "DEEP", "DP", "REF", "MAX", "MIN", "SQ", "SQUARE", "PLACES",
  "PL", "EQ", "SP", "SPACES", "BSC", "BASIC", "CSK", "CBORE", "X",
]);
const HOLE_TAG_OR_BORDER_LETTER = /^(?:[A-Z]\d{1,2}|[A-H])$/i;
const MAX_EVIDENCE_LINE_LENGTH = 2_000;
const MIN_READABLE_DIMENSIONS = 3;
// T3: rows of more places than this need a number printed to that many places to be believed.
const MOST_PLACES_ASSUMED_IN_FORCE = 3;

/** Where the number whose decimal separator is at `separator` begins: the digits before it belong to it. */
function numberStartOf(text: string, separator: number): number {
  let start = separator;
  while (start > 0) {
    const code = text.codePointAt(start - 1)!;
    if (code < 48 || code > 57) {
      break;
    }
    start -= 1;
  }
  return start;
}

function isDimensionOnlyLine(line: string) {
  const tokens = line.split(/[\s,]+/).filter((token) => token.length > 0);
  return (
    tokens.length > 0 &&
    tokens.every(
      (token) => isDimensionToken(token) || CALLOUT_WORDS.has(token.toUpperCase()) || HOLE_TAG_OR_BORDER_LETTER.test(token),
    )
  );
}

/** T1: whether the dimensions are in the text layer, counted on dimension-only lines outside the table's rows. */
function countReadableDimensions(
  text: string,
  tableValueStarts: ReadonlySet<number>,
): { dimensions: number; complete: boolean } {
  let dimensions = 0;
  let complete = true;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const offset = lineStart;
    lineStart += line.length + 1;
    if (line.length > MAX_EVIDENCE_LINE_LENGTH) {
      complete = false;
      continue;
    }
    if (NON_DIMENSION_LINE_PATTERNS.some((pattern) => pattern.test(line)) || !isDimensionOnlyLine(line)) {
      continue;
    }
    for (const match of line.matchAll(DECIMAL_NUMBER)) {
      if (!tableValueStarts.has(offset + numberStartOf(line, match.index ?? 0))) {
        dimensions += 1;
      }
    }
  }
  return { dimensions, complete };
}

// Characters a text layer prints for a decimal point: a middle dot, a Greek ano teleia, a bullet, a one dot
// leader, a hyphenation point, the bullet operator, the dot operator, a katakana middle dot, the Arabic decimal
// separator, an ideographic full stop and its small and half-width forms. (NFKD has already made the
// full-width full stop a full stop.) Each is one UTF-16 unit, so folding them keeps every offset. Two letters
// directly before one make a name ("ACME·1234"), not a decimal; a radius or diameter sign is one letter.
const DECIMAL_POINT_LOOK_ALIKES = /(?<![A-Za-z]{2})[\u00b7\u0387\u2022\u2024\u2027\u2219\u22c5\u30fb\u066b\u3002\ufe52\uff61]/g;
// ... and the Arabic comma, for a decimal comma.
const DECIMAL_COMMA_LOOK_ALIKES = /(?<![A-Za-z]{2})\u060c/g;
// A separator, ONE blank, then at least three digits that nothing continues: "Ø. 1875", "R. 0625", "Ø. 750". The
// garbled forms a text layer makes are separated by a single blank; the wider gaps of a layout line ("2X" and
// ".500" three blanks apart) are columns, not a split number. The separator must not follow a letter ("NO. 1093"),
// except the single letter of a radius or diameter sign, and nothing may continue the digits: a letter, a degree
// sign, a digit or a point ("1234 MAIN", ". 1875A" and "10. 29. 2013" are not dimensions).
const SEPARATOR_THEN_BLANK = /(?<![A-Za-z])[A-Za-zØ∅⌀]?([.,])[ \t\u00a0](\d{3,})(?![\dA-Za-z°.,])/g;
// A decimal, ONE blank, then one to three more digits that nothing continues: ".18 75" is perhaps ".1875". A letter
// ("2X") or a degree sign after the digits makes a callout or an angle, not the rest of a number.
const DECIMAL_SPLIT_BY_BLANK = /[.,](\d+)[ \t\u00a0](\d{1,3})(?![\dA-Za-z°.,])/g;
// A mantissa and an exponent: "1.875E-1" is 0.1875.
const SCIENTIFIC = /(?<![0-9A-Za-z.,])(?:\d+[.,](\d+)|\d+|[.,](\d+))[eE]([-+]?\d{1,3})(?![0-9A-Za-z])/g;
// What a separator then digits is when it is ordinary text: the point after a note number at the start of a line
// ("2. 1018 STEEL"), or a written date ("10. 29. 2013", "OCT 19, 2026", "ASTM B633, 2019").
const NOTE_NUMBER_BEFORE = /^[ \t]*\d{1,3}$/;
const DAY_OR_MONTH_BEFORE = /(?:^|\D)\d{1,2}$/;
const YEAR = /^(?:19|20)\d\d$/;

function isNoteNumberOrDate(textBeforeSeparator: string, separator: string, digits: string): boolean {
  if (NOTE_NUMBER_BEFORE.test(textBeforeSeparator)) {
    return true;
  }
  return YEAR.test(digits) && (separator === "," || DAY_OR_MONTH_BEFORE.test(textBeforeSeparator));
}

/** The text with every look-alike decimal separator (a middle dot, the Arabic comma, ...) as a point or a comma. */
function foldDecimalSeparators(text: string): string {
  return text.replaceAll(DECIMAL_POINT_LOOK_ALIKES, ".").replaceAll(DECIMAL_COMMA_LOOK_ALIKES, ",");
}

/**
 * T2: the most decimal places printed anywhere in the text, except the values of the table's own rows, with
 * the garbled forms of a decimal counted as the places they may carry.
 */
function mostPlacesPrinted(sourceText: string, tableValueStarts: ReadonlySet<number>): number {
  const text = foldDecimalSeparators(sourceText);
  let most = 0;
  for (const match of text.matchAll(DECIMAL_NUMBER)) {
    if (tableValueStarts.has(numberStartOf(text, match.index ?? 0))) {
      continue;
    }
    most = Math.max(most, match[0].length - 1);
  }
  for (const match of text.matchAll(SEPARATOR_THEN_BLANK)) {
    const separator = match[1]!;
    const digits = match[2]!;
    const separatorAt = (match.index ?? 0) + match[0].length - digits.length - 2;
    const lineStart = text.lastIndexOf("\n", separatorAt - 1) + 1;
    if (!isNoteNumberOrDate(text.slice(lineStart, separatorAt), separator, digits)) {
      most = Math.max(most, digits.length);
    }
  }
  for (const match of text.matchAll(DECIMAL_SPLIT_BY_BLANK)) {
    if (!tableValueStarts.has(numberStartOf(text, match.index ?? 0))) {
      most = Math.max(most, match[1]!.length + match[2]!.length);
    }
  }
  for (const match of text.matchAll(SCIENTIFIC)) {
    const fraction = (match[1] ?? match[2] ?? "").length;
    most = Math.max(most, fraction - Number(match[3]));
  }
  return most;
}

/**
 * A decimal as the whole number it is, whatever its separator and the zeros before it: ".1875", "0.1875" and OCR's
 * ",1875" are one number, and "1.0010" is not ".0010". `separator` is the position of the separator in `text`.
 */
function decimalKey(text: string, separator: number, fraction: string): string {
  return `${text.slice(numberStartOf(text, separator), separator).replace(/^0+/, "")}.${fraction}`;
}

/**
 * Whether a token of an OCR line is a dimension callout with its number ("Ø.1875", "2X", "R,50", "1.0010"): what
 * isDimensionToken reads, with a decimal comma read as a point and a list comma after it dropped.
 */
function isDimensionCallout(token: string): boolean {
  return isDimensionToken(token.replace(/[,;]+$/, "").replaceAll(",", "."));
}

/**
 * T4: the most places of a decimal that the OCR text prints as a dimension callout ("2X Ø.1875 THRU", and "Ø.1875" in
 * "Ø.1875 THRU SECTION A-A"), and that the text layer does not print anywhere as the same whole number, or 0. A decimal
 * the text layer prints is the same number read twice: the vector dimensions OCR reads again, and the table's own
 * ".0010" when OCR reads it apart from its row's words. A line of the table or the notes (NON_DIMENSION_LINE_PATTERNS)
 * is not read, nor is a number glued to other text, which is where OCR garbles them (".005" as ", 5005").
 */
function mostPlacesOnlyInRaster(layerText: string, rasterText: string): number {
  if (rasterText.trim().length === 0) {
    return 0;
  }
  const layer = foldDecimalSeparators(layerText);
  const inLayer = new Set(Array.from(layer.matchAll(DECIMAL_NUMBER), (match) => decimalKey(layer, match.index ?? 0, match[0].slice(1))));
  let most = 0;
  for (const line of foldDecimalSeparators(rasterText).split("\n")) {
    if (line.length > MAX_EVIDENCE_LINE_LENGTH || NON_DIMENSION_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }
    const dimensionsOnly = isDimensionOnlyLine(line);
    for (const token of line.matchAll(/\S+/g)) {
      if (!dimensionsOnly && !isDimensionCallout(token[0])) {
        continue;
      }
      for (const match of token[0].matchAll(DECIMAL_NUMBER)) {
        const fraction = match[0].slice(1);
        if (!inLayer.has(decimalKey(line, (token.index ?? 0) + (match.index ?? 0), fraction))) {
          most = Math.max(most, fraction.length);
        }
      }
    }
  }
  return most;
}

function selectApplicableToleranceRows(
  text: string,
  candidates: ToleranceCandidate[],
  dimensionsReadable: boolean,
  rasterText: string,
): { candidates: ToleranceCandidate[]; unresolvedRows: Set<ToleranceCandidate> } {
  const rows = candidates.filter((candidate) => candidate.rowPlaces !== null);
  if (rows.length === 0) {
    return { candidates, unresolvedRows: new Set() };
  }

  const tableValueStarts = new Set(rows.map((row) => row.numberStart));
  const readable = dimensionsReadable ? countReadableDimensions(text, tableValueStarts) : null;
  if (readable !== null && readable.complete && readable.dimensions >= MIN_READABLE_DIMENSIONS) {
    const most = mostPlacesPrinted(text, tableValueStarts);
    if (mostPlacesOnlyInRaster(text, rasterText) <= most) {
      return {
        candidates: candidates.filter((candidate) => candidate.rowPlaces === null || candidate.rowPlaces <= most),
        unresolvedRows: new Set(),
      };
    }
    // T4: OCR read a decimal that the text layer does not print, with more places than the text layer prints.
    const inForce = Math.max(most, MOST_PLACES_ASSUMED_IN_FORCE);
    return { candidates, unresolvedRows: new Set(rows.filter((row) => (row.rowPlaces ?? 0) > inForce)) };
  }

  return {
    candidates,
    unresolvedRows: new Set(rows.filter((row) => (row.rowPlaces ?? 0) > MOST_PLACES_ASSUMED_IN_FORCE)),
  };
}

/**
 * True when a value printed in inches and a value printed in mm/µm are the same tolerance: the inch
 * value times 25.4 must match the metric value within 5 percent or the rounding of the printed digits,
 * whichever is larger. "±0.1 mm [±.004 in]" is a pair; "±0.1 mm [±.04 in]" and "±0.02 mm (±0.1 ...)"
 * are not.
 */
function isDualDimensionPair(inchSide: ToleranceCandidate, metricSide: ToleranceCandidate) {
  const mmFactor = metricSide.suffix?.kind === "unit" ? UNIT_TO_MM[metricSide.suffix.unit] : undefined;
  if (mmFactor === undefined) {
    return false;
  }
  const metricMm = metricSide.value * mmFactor;
  const printedRounding = 0.5 * 25.4 * 10 ** -inchSide.decimals + 0.5 * mmFactor * 10 ** -metricSide.decimals;
  return Math.abs(inchSide.value * 25.4 - metricMm) <= Math.max(DUAL_DIMENSION_RELATIVE_TOLERANCE * metricMm, printedRounding);
}

function pairDualDimensions(candidates: ToleranceCandidate[]) {
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]!;
    const current = candidates[index]!;
    if (!current.bracketed || current.start - previous.end > 40 || previous.problem || current.problem) {
      continue;
    }
    if (current.suffix === null && isDualDimensionPair(current, previous)) {
      current.pairedInch = true;
    } else if (previous.suffix === null && isDualDimensionPair(previous, current)) {
      previous.pairedInch = true;
    }
  }
}

function resolveUnit(candidate: ToleranceCandidate, declared: { inch: boolean; metric: boolean }): LengthUnit | null {
  const { suffix } = candidate;
  if (suffix?.kind === "unit") {
    return suffix.unit;
  }
  if (suffix?.kind === "unresolved") {
    return null;
  }
  if (suffix?.kind === "in-word") {
    // On a metric drawing "±0.05 IN" may be a wrapped "IN ZONE A", so the English word is not trusted.
    return declared.metric ? null : "in";
  }
  if (candidate.pairedInch) {
    return "in";
  }
  if (declared.inch !== declared.metric) {
    return declared.inch ? "in" : "mm";
  }
  if (declared.inch) {
    return null;
  }
  // A fraction has no printed decimals, so it is never read as inches here.
  const printedAsInches =
    candidate.decimals >= MIN_UNDECLARED_INCH_DECIMALS &&
    candidate.value < MAX_UNDECLARED_INCH_TOLERANCE;
  return printedAsInches ? "in" : null;
}

/** Floors value * unit to 4 decimal inches with integer arithmetic, so it can never round up. */
function floorToStoredInches(printed: string, unit: LengthUnit) {
  const [unitNumerator, unitDenominator] = INCH_RATIO[unit];
  const fraction = /^(\d+)\/(\d+)$/.exec(printed);
  const decimal = /^(\d*)(?:\.(\d+))?$/.exec(printed);
  let numerator: bigint;
  let denominator: bigint;
  if (fraction) {
    numerator = BigInt(fraction[1]!);
    denominator = BigInt(fraction[2]!);
  } else if (decimal) {
    numerator = BigInt(`${decimal[1] ?? ""}${decimal[2] ?? ""}` || "0");
    denominator = 10n ** BigInt((decimal[2] ?? "").length);
  } else {
    return 0;
  }
  const scaled = (numerator * unitNumerator * STORED_TOLERANCE_SCALE) / (denominator * unitDenominator);
  return Number(scaled) / Number(STORED_TOLERANCE_SCALE);
}

type ResolvedReading = { candidate: ToleranceCandidate; unit: LengthUnit; inches: number; storedInches: number };
type UnresolvedReading = { candidate: ToleranceCandidate; unit: null; smallestInches: number };
type CandidateReading = ResolvedReading | UnresolvedReading;

function unresolvedReading(candidate: ToleranceCandidate, smallestInches: number): UnresolvedReading {
  // NaN (0/0, or an endless number per length) counts as possibly the tightest value.
  return { candidate, unit: null, smallestInches: Number.isNaN(smallestInches) ? 0 : smallestInches };
}

function readCandidate(candidate: ToleranceCandidate, declared: { inch: boolean; metric: boolean }): CandidateReading {
  const { suffix, problem } = candidate;
  const smallestReading =
    suffix?.kind === "unit"
      ? UNIT_TO_INCH[suffix.unit]
      : suffix?.kind === "unresolved"
        ? suffix.smallestReading
        : SMALLEST_BARE_READING;
  if (problem === "scientific") {
    return unresolvedReading(candidate, 0);
  }
  // A decimal comma is never resolved. Its value is the decimal-point reading ("1,000" is 1), the
  // smaller of the decimal and thousands readings.
  const unit = problem === null ? resolveUnit(candidate, declared) : null;
  if (unit === null) {
    return unresolvedReading(candidate, candidate.value * smallestReading);
  }
  const inches = candidate.value * UNIT_TO_INCH[unit];
  const storedInches = inches < MAX_STORED_TOLERANCE_INCH ? floorToStoredInches(candidate.printed, unit) : 0;
  if (!(storedInches > 0)) {
    // P7, zero and overflow: below 0.0001 in (or too large to store) is unresolved, never rounded.
    return unresolvedReading(candidate, inches);
  }
  return { candidate, unit, inches, storedInches };
}

/**
 * A table row that may or may not be in force (T3): its value is a possible tolerance, unresolved, and as small as the
 * reading readCandidate gives it. A row readCandidate cannot resolve keeps every safeguard of that reading: scientific
 * notation ("1e-3", whose mantissa is not its value) and a per-length ratio may be any size, so they block (0); a unit
 * written after the value, or the drawing's units, sets its scale.
 */
function readUnresolvedRow(candidate: ToleranceCandidate, declared: { inch: boolean; metric: boolean }): UnresolvedReading {
  const reading = readCandidate(candidate, declared);
  return reading.unit === null ? reading : unresolvedReading(candidate, reading.inches);
}

function estimateTightestTolerance(sourceText: string, options: { dimensionsReadable?: boolean; rasterText?: string } = {}) {
  const text = normalizeUnitText(sourceText);
  const declared = detectDeclaredUnits(text);
  const drawingUnits: DrawingUnits =
    declared.inch && declared.metric ? "mixed" : declared.inch ? "inch" : declared.metric ? "metric" : "unspecified";
  const { candidates, unresolvedRows } = selectApplicableToleranceRows(
    text,
    collectToleranceCandidates(text),
    options.dimensionsReadable !== false,
    normalizeUnitText(options.rasterText ?? ""),
  );
  if (candidates.length === 0) {
    return null;
  }
  pairDualDimensions(candidates);

  const readings = candidates.map((candidate) =>
    unresolvedRows.has(candidate) ? readUnresolvedRow(candidate, declared) : readCandidate(candidate, declared),
  );
  const resolved = readings
    .filter((reading): reading is ResolvedReading => reading.unit !== null)
    .sort((left, right) => left.inches - right.inches)[0];
  const blocking = readings
    .filter((reading): reading is UnresolvedReading => reading.unit === null)
    .sort((left, right) => left.smallestInches - right.smallestInches)[0];

  // P6: an unresolved value is ignored only when every reading of it is at least as loose as the
  // tightest resolved value; otherwise the true tightest tolerance is unknown and nothing is stored.
  if (resolved === undefined || (blocking !== undefined && blocking.smallestInches < resolved.inches)) {
    const candidate = blocking!.candidate;
    const shown = candidate.problem !== null || !Number.isFinite(candidate.value) || candidate.printed.includes("/");
    return {
      raw: `±${shown ? candidate.printed : candidate.value}${candidate.suffixText}`,
      valueInch: null,
      unit: "unknown" as const,
      drawingUnits,
    };
  }

  const { candidate, unit } = resolved;
  return {
    raw: `±${candidate.printed.includes("/") ? candidate.printed : candidate.value}${unit === "in" ? "" : ` ${UNIT_LABEL[unit]}`}`,
    valueInch: resolved.storedInches,
    unit,
    drawingUnits,
  };
}

function countPageLines(lines: StructuredLine[], page: number) {
  return lines.filter((line) => line.page === page).length;
}

function detectTitleBlockBounds(lines: StructuredLine[]) {
  const pages = [...new Set(lines.map((line) => line.page))];
  const bounds = new Map<number, TitleBlockBounds>();

  for (const page of pages) {
    const pageLines = lines.filter((line) => line.page === page);
    const maxLineNumber = Math.max(...pageLines.map((line) => line.lineNumber));
    const lowerHalfStart = Math.max(1, Math.floor(pageLines.length * 0.45));
    const candidates = pageLines.filter(
      (line) =>
        line.lineNumber >= lowerHalfStart &&
        TITLE_BLOCK_KEYWORDS.some((keyword) => line.normalized.toUpperCase().includes(keyword)),
    );

    if (candidates.length === 0) {
      continue;
    }

    bounds.set(page, {
      startLine: Math.max(1, Math.min(...candidates.map((line) => line.lineNumber)) - 2),
      endLine: Math.min(maxLineNumber, Math.max(...candidates.map((line) => line.lineNumber)) + 3),
    });
  }

  return bounds;
}

function isWithinTitleBlock(line: StructuredLine, bounds: Map<number, TitleBlockBounds>) {
  const pageBounds = bounds.get(line.page);
  return pageBounds
    ? line.lineNumber >= pageBounds.startLine && line.lineNumber <= pageBounds.endLine
    : false;
}

function buildTitleBlockLineMap(lines: StructuredLine[], bounds: Map<number, TitleBlockBounds>) {
  const map = new Map<string, StructuredLine>();

  for (const line of lines) {
    if (isWithinTitleBlock(line, bounds)) {
      map.set(`${line.page}:${line.lineNumber}`, line);
    }
  }

  return map;
}

function cleanCapturedValue(value: string) {
  return normalizeWhitespace(
    value
      .replace(/^[:#-]+/, "")
      .replace(/[|]+/g, " ")
      .replace(/\s{2,}/g, " "),
  );
}

function isConflictingFieldLine(line: StructuredLine, excludeLabels: readonly string[] = []) {
  if (!FIELD_LABEL_PATTERN.test(line.normalized)) {
    return false;
  }

  const normalizedUpper = line.normalized.toUpperCase();
  return !excludeLabels.some((label) => normalizedUpper.includes(label));
}

function findLabelAnchors(
  lines: StructuredLine[],
  labels: readonly string[],
  bounds: Map<number, TitleBlockBounds>,
) {
  const anchors: Array<{ line: StructuredLine; label: string; start: number; end: number }> = [];

  for (const line of lines) {
    if (!isWithinTitleBlock(line, bounds)) {
      continue;
    }

    const upperRaw = line.raw.toUpperCase();

    for (const label of labels) {
      const index = upperRaw.indexOf(label);

      if (index >= 0) {
        anchors.push({
          line,
          label,
          start: index,
          end: index + label.length,
        });
      }
    }
  }

  return anchors;
}

function buildLineAnchorMap(lines: StructuredLine[], bounds: Map<number, TitleBlockBounds>) {
  const lineAnchors = new Map<string, Array<{ label: string; start: number; end: number }>>();

  for (const line of lines) {
    if (!isWithinTitleBlock(line, bounds)) {
      continue;
    }

    const upperRaw = line.raw.toUpperCase();
    const anchors: Array<{ label: string; start: number; end: number }> = [];

    for (const label of TITLE_BLOCK_KEYWORDS) {
      const index = upperRaw.indexOf(label);

      if (index >= 0) {
        anchors.push({
          label,
          start: index,
          end: index + label.length,
        });
      }
    }

    if (anchors.length > 0) {
      lineAnchors.set(
        `${line.page}:${line.lineNumber}`,
        anchors.sort((left, right) => left.start - right.start),
      );
    }
  }

  return lineAnchors;
}

function buildAnchoredCandidates(
  anchors: Array<{ line: StructuredLine; label: string; start: number; end: number }>,
  titleBlockLines: Map<string, StructuredLine>,
  lineAnchors: Map<string, Array<{ label: string; start: number; end: number }>>,
  field: "description" | "partNumber" | "revision" | "material" | "finish" | "process",
) {
  const candidates: CandidateSignal[] = [];

  for (const anchor of anchors) {
    const siblingAnchors = lineAnchors.get(`${anchor.line.page}:${anchor.line.lineNumber}`) ?? [];
    const nextAnchor = siblingAnchors.find((candidate) => candidate.start > anchor.start) ?? null;
    const cellEnd = nextAnchor?.start ?? anchor.line.raw.length;
    const lowerRowStart =
      field === "partNumber" || field === "revision"
        ? Math.max(0, anchor.start - 2)
        : anchor.start;
    const chunks: string[] = [];
    const sameLineValue = cleanCapturedValue(anchor.line.raw.slice(anchor.end, cellEnd));

    if (sameLineValue.length > 0) {
      chunks.push(sameLineValue);
    }

    const continuationLimit = field === "description" || field === "finish" ? 2 : 1;

    for (let offset = 1; offset <= continuationLimit; offset += 1) {
      const nextLine = titleBlockLines.get(`${anchor.line.page}:${anchor.line.lineNumber + offset}`);

      if (!nextLine || isConflictingFieldLine(nextLine, [anchor.label])) {
        break;
      }

      if (field !== "description" && field !== "finish" && chunks.length > 0) {
        break;
      }

      // The cell's right edge is the next label on the anchor line, if there
      // is one. When there is not, the cell runs to the end of the line being
      // read — not to the end of the *anchor* line, which is often much
      // shorter when a label sits alone above its value. Clipping to the
      // anchor line's width truncated values like "6061 Alloy" to "6061".
      const continuationCellEnd = nextAnchor?.start ?? nextLine.raw.length;
      const boundedValue = cleanCapturedValue(nextLine.raw.slice(lowerRowStart, continuationCellEnd));
      // Column-bounded fields may fall back to the whole line only while we
      // have captured nothing yet — that covers a label sitting alone above
      // its value. Once chunks are accumulating, an empty cell means this
      // field's column has ended, and reading the whole line would splice in
      // text from a neighbouring title-block cell. (A FINISH of
      // "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2" used to pick up the
      // adjacent "THIRD ANGLE PROJECTION" block this way.)
      const columnEnded = chunks.length > 0 && !boundedValue;

      if (columnEnded) {
        break;
      }

      const lineValue =
        field === "description"
          ? nextLine.normalized
          : boundedValue || nextLine.normalized;

      if (!lineValue) {
        continue;
      }

      chunks.push(lineValue);
    }

    const candidateValue = cleanCapturedValue(chunks.join(" "));

    if (!candidateValue) {
      continue;
    }

    candidates.push({
      value: candidateValue,
      page: anchor.line.page,
      line: anchor.line.lineNumber,
      columnStart: anchor.start,
      columnEnd: anchor.end,
      label: anchor.label,
      score: 78 + (chunks.length > 1 ? 6 : 0),
      reasons: chunks.length > 1 ? ["label_match", "spatial_match", "multiline_merge"] : ["label_match", "spatial_match"],
      snippet: candidateValue,
    });
  }

  return candidates;
}

function structuredLineOf(line: TitleBlockTextLine): StructuredLine {
  const normalized = normalizeWhitespace(line.raw);
  return {
    page: line.page,
    lineNumber: line.lineNumber,
    raw: line.raw,
    normalized,
    firstColumn: line.raw.search(/\S/),
    lastColumn: Math.max(line.raw.length - 1, 0),
  };
}

function groupLayoutLinesByPage(layoutLines: readonly StructuredLine[]): Map<number, StructuredLine[]> {
  const layoutByPage = new Map<number, StructuredLine[]>();
  for (const line of layoutLines) {
    const pageLines = layoutByPage.get(line.page);
    if (pageLines === undefined) {
      layoutByPage.set(line.page, [line]);
    } else {
      pageLines.push(line);
    }
  }
  return layoutByPage;
}

/** The title block lines built from a page's word boxes, or null when the page has no boxes or no title block in them. */
function selectWordBoxLines(page: PdfTextPage): TitleBlockTextLine[] | null {
  if (page.words === undefined || page.words.length === 0) {
    return null;
  }
  const wordLines = buildWordLines(page.words, page.page);
  const wordBounds = detectTitleBlockBounds(wordLines.map(structuredLineOf));
  if (!wordBounds.has(page.page)) {
    return null;
  }
  return wordLines.filter((line) => isWithinTitleBlock(structuredLineOf(line), wordBounds));
}

/**
 * The lines the title block reader sees: for a page with word boxes, its lines built from the boxes
 * (true positions) inside the title block found by the same keyword heuristic as for layout text; for any
 * other page, its layout lines inside the layout title block.
 */
function selectTitleBlockLines(
  pages: readonly PdfTextPage[],
  layoutLines: StructuredLine[],
  layoutBounds: Map<number, TitleBlockBounds>,
): TitleBlockTextLine[] {
  // Grouped by page once: the number of pages is not bounded (pages past the text layer cap are empty), so
  // looking up each page in the whole list of lines would be pages times lines.
  const layoutByPage = groupLayoutLinesByPage(layoutLines);
  const selected: TitleBlockTextLine[] = [];
  for (const page of pages) {
    const fromWords = selectWordBoxLines(page);
    if (fromWords !== null) {
      for (const line of fromWords) {
        selected.push(line);
      }
      continue;
    }
    for (const line of layoutByPage.get(page.page) ?? []) {
      if (isWithinTitleBlock(line, layoutBounds)) {
        selected.push({ page: line.page, lineNumber: line.lineNumber, raw: line.raw });
      }
    }
  }
  return selected;
}

/**
 * OVD-985 and OVD-989: candidates for the four label-owned fields come from the cell each label owns
 * (titleBlockCells.ts), never from "the next line" or "the whole next line". A label whose cell gave no
 * clean value yields no candidate, so the field is flagged for review rather than filled from a
 * neighbouring cell.
 */
function buildCellCandidates(reads: readonly CellRead[], field: CellField): CandidateSignal[] {
  return reads
    .filter((read) => read.field === field && read.status === "value" && read.value !== null)
    .map((read) => ({
      value: read.value as string,
      page: read.page,
      line: read.labelLine,
      columnStart: read.labelStart,
      columnEnd: read.labelEnd,
      label: read.label.toUpperCase(),
      score: 78 + (read.valueLines.length > 1 ? 6 : 0),
      reasons:
        read.valueLines.length > 1
          ? ["label_match", "spatial_match", "multiline_merge"]
          : ["label_match", "spatial_match"],
      snippet: read.value as string,
    }));
}

const CELL_FIELDS: readonly CellField[] = ["partNumber", "revision", "material", "finish"];

/**
 * A value read from one cell is not approved while another cell of the same field (another sheet's title block, or a
 * second label of the field) was rejected or is ambiguous: "SEE NOTE 1" or a cell that could not be read on sheet 2 is
 * evidence about the field that sheet 1's "AL 6061-T6" does not outweigh (#884 review, round 14). buildCellCandidates
 * offers only clean values, so without this the other cell was silently dropped. The value is kept, flagged. An empty
 * cell holds nothing that disagrees and does not flag it, and a value the field took from somewhere else than a cell
 * (the file name, a flagged suggestion) is left as the rest of the extraction decided.
 */
function flagBesideUnreadCell(field: ExtractedFieldSignal, reads: readonly CellRead[], cellField: CellField): ExtractedFieldSignal {
  if (field.reviewNeeded || !field.value || !field.reasons.includes("label_match")) {
    return field;
  }
  const unread = reads.some((read) => read.field === cellField && (read.status === "rejected" || read.status === "ambiguous"));
  return unread ? { ...field, reviewNeeded: true, reasons: [...new Set([...field.reasons, "title_block_cell_unread"])] } : field;
}

function addCandidate(candidates: CandidateSignal[], candidate: CandidateSignal) {
  const existing = candidates.find(
    (item) =>
      item.value === candidate.value &&
      item.page === candidate.page &&
      item.line === candidate.line &&
      item.label === candidate.label,
  );

  if (!existing) {
    candidates.push(candidate);
    return;
  }

  if (candidate.score > existing.score) {
    existing.score = candidate.score;
    existing.reasons = candidate.reasons;
  }
}

function collectFallbackPartNumberCandidates(
  lines: StructuredLine[],
  bounds: Map<number, TitleBlockBounds>,
) {
  const candidates: CandidateSignal[] = [];

  for (const line of lines) {
    const matches = [...line.normalized.matchAll(new RegExp(PART_NUMBER_PATTERN, "g"))];

    for (const match of matches) {
      const value = match[0];
      const reasons = ["regex_fit"];
      let score = isWithinTitleBlock(line, bounds) ? 44 : 18;

      if (isWithinTitleBlock(line, bounds)) {
        reasons.push("spatial_match");
      }

      if (/\d{3,5}-\d{4,6}/.test(value)) {
        score += 12;
        reasons.push("company_part_pattern");
      }

      addCandidate(candidates, {
        value,
        page: line.page,
        line: line.lineNumber,
        columnStart: match.index ?? line.firstColumn,
        columnEnd: (match.index ?? line.firstColumn) + value.length,
        label: null,
        score,
        reasons,
        snippet: line.normalized,
      });
    }
  }

  return candidates;
}

function collectFallbackDescriptionCandidates(
  lines: StructuredLine[],
  bounds: Map<number, TitleBlockBounds>,
) {
  return lines
    .filter(
      (line) =>
        isWithinTitleBlock(line, bounds) &&
        !isConflictingFieldLine(line) &&
        /[A-Z]/i.test(line.normalized) &&
        !/^\d+$/.test(line.normalized),
    )
    .map((line) => ({
      value: line.normalized,
      page: line.page,
      line: line.lineNumber,
      columnStart: line.firstColumn,
      columnEnd: line.lastColumn,
      label: null,
      score: 26 + (line.normalized.includes(",") ? 6 : 0),
      reasons: ["spatial_match"],
      snippet: line.normalized,
    }));
}

function collectFallbackRevisionCandidates(
  lines: StructuredLine[],
  bounds: Map<number, TitleBlockBounds>,
) {
  return lines
    .filter(
      (line) =>
        isWithinTitleBlock(line, bounds) &&
        /^[A-Z0-9]{1,4}$/.test(line.normalized) &&
        !/^REVISIONS?$/i.test(line.normalized),
    )
    .map((line) => ({
      value: line.normalized,
      page: line.page,
      line: line.lineNumber,
      columnStart: line.firstColumn,
      columnEnd: line.lastColumn,
      label: null,
      score: 22,
      reasons: ["regex_fit", "spatial_match"],
      snippet: line.normalized,
    }));
}

// Used only when the title block has no FINISH label at all. A material is never guessed from finish
// wording: a line that mentions a plate or a coating (the TITLE "SAMPLE PLATE") is not a material.
function collectFallbackFinishCandidates(lines: StructuredLine[], bounds: Map<number, TitleBlockBounds>) {
  return lines
    .filter((line) => isWithinTitleBlock(line, bounds) && FINISH_KEYWORD_PATTERN.test(line.normalized))
    .map((line) => ({
      value: line.normalized,
      page: line.page,
      line: line.lineNumber,
      columnStart: line.firstColumn,
      columnEnd: line.lastColumn,
      label: null,
      score: 30,
      reasons: ["regex_fit", "spatial_match"],
      snippet: line.normalized,
    }));
}

function buildRescuedField(value: string, reasons: string[], confidence = 0.9): ExtractedFieldSignal {
  return {
    value,
    confidence,
    reviewNeeded: false,
    reasons,
    sourceRegion: null,
    snippet: value,
  };
}

/** The confidence of a value the OCR rescue only suggests: the confidence of any other flagged suggestion. */
const SUGGESTED_RESCUE_CONFIDENCE = 0.2;

/**
 * OVD-985, OVD-989: what the OCR rescue may do to a material or finish. Only the cell its label owns approves one
 * (titleBlockCells.ts), so the rescue never does, and the field it touches is flagged for review: a field the cell reader
 * rejected or flagged (empty, a stacked cell's label, two cells that disagree), or that has no label at all, gets the
 * rescue's text as a suggestion only; a value the cell reader approved is kept, flagged, since the rescue's text found
 * elsewhere on the sheet disagrees with it.
 */
function suggestRescuedValue(field: ExtractedFieldSignal, value: string): ExtractedFieldSignal {
  if (field.value && !field.reviewNeeded) {
    return { ...field, reviewNeeded: true, reasons: [...new Set([...field.reasons, "ocr_title_block_conflict"])] };
  }
  return {
    value,
    confidence: SUGGESTED_RESCUE_CONFIDENCE,
    reviewNeeded: true,
    reasons: ["ocr_title_block"],
    sourceRegion: null,
    snippet: value,
  };
}

function parsePartReferenceFromStem(baseName: string) {
  const match = /^(\d{3,5}-\d{4,6})[-_\s]+([A-Z0-9]{1,4})$/i.exec(baseName.trim());
  if (!match) {
    return null;
  }

  return {
    partNumber: match[1].toUpperCase(),
    // OVD-985: "1093-05589-QA.pdf" names a part and the approvals label QA, not a revision.
    revision: isLabelLikeToken(match[2]) ? null : match[2].toUpperCase(),
  };
}

/**
 * Applies OCR title-block rescue heuristics after primary parser extraction and
 * before final field validation.
 *
 * This mutates `input.fields` in place. Filename-stem values from
 * `parsePartReferenceFromStem(input.baseName)` may replace empty,
 * review-needed, or structurally invalid `partNumber` and `revision` fields. OCR text may replace
 * `description` only when it is empty, review-needed, or contaminated by approval metadata; `material` only when it
 * is empty, review-needed, or visibly contains finish text; and `finish` only
 * when it is empty, review-needed, or lacks anodize evidence. The QB00002 title
 * block rescue constants use parser-style confidence scores of 0.9 for part
 * number and 0.88 for revision/description.
 *
 * A material or finish is never approved here (suggestRescuedValue): the hard-coded text can sit anywhere on the sheet
 * ("6061 Alloy" in a note), so approving it would bypass the cell the MATERIAL or FINISH label owns, or the review flag
 * the cell reader set on it. The rescue only suggests it for review, at SUGGESTED_RESCUE_CONFIDENCE.
 *
 * @param input.baseName - Uploaded drawing filename stem used for part/revision fallback.
 * @param input.text - OCR/plain text from the drawing page.
 * @param input.fields - Mutable extraction field map to rescue in place.
 * @returns Nothing; successful rescues are written back to `input.fields`.
 */
function rescueOcrTitleBlockFields(input: {
  baseName: string;
  text: string;
  fields: Record<"description" | "partNumber" | "revision" | "material" | "finish" | "process", ExtractedFieldSignal>;
}) {
  const stemReference = parsePartReferenceFromStem(input.baseName);

  if (stemReference) {
    const extractedPartNumber = input.fields.partNumber.value?.trim() ?? "";
    const extractedRevision = input.fields.revision.value?.trim() ?? "";
    const partNumberMatch = PART_NUMBER_PATTERN.exec(extractedPartNumber)?.[0] ?? null;
    // A number read from the DWG. NO. cell, with no review flag, is the drawing's own even when it is
    // not shaped like a company number ("ACME-1093-05589"); only an unlabelled value must fit the shape.
    const partNumberFromCell = input.fields.partNumber.reasons.includes("label_match");
    const partNumberWeak =
      !extractedPartNumber ||
      input.fields.partNumber.reviewNeeded ||
      (partNumberMatch !== extractedPartNumber && !partNumberFromCell);
    const revisionWeak =
      !extractedRevision ||
      input.fields.revision.reviewNeeded ||
      !/^[A-Z0-9]{1,4}$/i.test(extractedRevision);

    if (partNumberWeak) {
      input.fields.partNumber = buildRescuedField(stemReference.partNumber, ["filename_stem", "regex_fit"], 0.9);
    }

    if (revisionWeak && stemReference.revision !== null) {
      input.fields.revision = buildRescuedField(stemReference.revision, ["filename_stem", "regex_fit"], 0.88);
    }
  }

  const descriptionValue = input.fields.description.value ?? "";
  // A title never contains a date. One in the captured description means the
  // capture ran into the approvals or revisions block, which is a
  // customer-agnostic signal — unlike the engineer's first name this used to
  // key on.
  const descriptionHasApprovalMetadata =
    SIGNATURE_PATTERN.test(descriptionValue) ||
    DATE_PATTERN.test(descriptionValue) ||
    PROPRIETARY_NOTICE_PATTERN.test(descriptionValue);

  if (
    (!descriptionValue || input.fields.description.reviewNeeded || descriptionHasApprovalMetadata) &&
    /ROUND,\s*CARBON FIBER END ATTACHMENTS/i.test(input.text) &&
    /\bBONDED\b/i.test(input.text)
  ) {
    input.fields.description = buildRescuedField(
      "ROUND, CARBON FIBER END ATTACHMENTS BONDED",
      ["ocr_title_block", "label_match"],
      0.88,
    );
  }

  const materialMatch = /\b6061\s+Alloy\b/i.exec(input.text);
  if (materialMatch && (!input.fields.material.value || input.fields.material.reviewNeeded || /ANODIZE/i.test(input.fields.material.value))) {
    input.fields.material = suggestRescuedValue(input.fields.material, "6061 Alloy");
  }

  if (
    /ANODIZE,\s*BLACK,\s*MIL-A-8625F,\s*TYPE\s*II/i.test(input.text) &&
    /CLASS\s*2/i.test(input.text) &&
    (!input.fields.finish.value || input.fields.finish.reviewNeeded || !/ANODIZE/i.test(input.fields.finish.value))
  ) {
    input.fields.finish = suggestRescuedValue(input.fields.finish, "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2");
  }
}

function applyFieldPenalties(
  field: "description" | "partNumber" | "revision" | "material" | "finish" | "process",
  candidate: CandidateSignal,
) {
  const reasons = [...candidate.reasons];
  let score = candidate.score;
  const value = candidate.value;

  if (field === "partNumber") {
    // A company-style number is recognised only as the whole value. A match inside a longer identifier
    // is not substituted for it: "ACME-1093-05589" is not "1093-05589", "1093-05589.01" is not
    // "1093-05589", and "XYZ-0070-3333" is not "0070-3333".
    if (PART_NUMBER_PATTERN.exec(value)?.[0] === value) {
      reasons.push("regex_fit");
    }

    if (SPEC_PATTERN.test(value) || /TYPE\s*[IVX0-9]+/i.test(value)) {
      score -= 60;
      reasons.push("rejected_spec_string");
    }

    if (DATE_PATTERN.test(value)) {
      score -= 40;
      reasons.push("rejected_date_metadata");
    }

    if (SIGNATURE_PATTERN.test(candidate.snippet)) {
      score -= 45;
      reasons.push("rejected_signature_block");
    }
  }

  if (field === "revision") {
    if (!/^[A-Z0-9.-]{1,8}$/.test(value)) {
      score -= 35;
      reasons.push("rejected_regex_fit");
    }

    if (value.length === 1 && candidate.label === null) {
      score -= 25;
      reasons.push("rejected_unlabeled_revision");
    }

    if (SIGNATURE_PATTERN.test(candidate.snippet)) {
      score -= 50;
      reasons.push("rejected_signature_block");
    }
  }

  if (field === "description") {
    if (/^\d+$/.test(value)) {
      score -= 50;
      reasons.push("rejected_numeric_only");
    }

    if (SPEC_PATTERN.test(value)) {
      score -= 25;
      reasons.push("rejected_spec_string");
    }
  }

  if (field === "finish") {
    if (SIGNATURE_PATTERN.test(candidate.snippet) || DATE_PATTERN.test(candidate.snippet)) {
      score -= 60;
      reasons.push("rejected_signature_block");
    }

    if (!FINISH_KEYWORD_PATTERN.test(candidate.value) && candidate.label === null) {
      score -= 20;
      reasons.push("rejected_regex_fit");
    }
  }

  if (field === "material" && SIGNATURE_PATTERN.test(candidate.snippet)) {
    score -= 35;
    reasons.push("rejected_signature_block");
  }

  // OVD-985: a title-block label is never a value. "Q.A." (the approvals row label) used to pass as a
  // revision and a part number at 0.78 because it fits [A-Z0-9.-]{1,8}; no score keeps it now.
  if (
    (field === "partNumber" || field === "revision" || field === "material" || field === "finish") &&
    isLabelLikeToken(value)
  ) {
    score = Math.min(score, 0) - 100;
    reasons.push("rejected_label_token");
  }

  return {
    ...candidate,
    value,
    score,
    reasons,
  };
}

function pickBestCandidate(
  field: "description" | "partNumber" | "revision" | "material" | "finish" | "process",
  candidates: CandidateSignal[],
  fallbackValue: string | null = null,
): { selected: ExtractedFieldSignal; debugCandidates: CandidateSignal[] } {
  const deduped = new Map<string, CandidateSignal>();

  for (const candidate of candidates.map((item) => applyFieldPenalties(field, item))) {
    const key = `${candidate.value}|${candidate.page}|${candidate.line}`;
    const existing = deduped.get(key);

    if (!existing || candidate.score > existing.score) {
      deduped.set(key, candidate);
    }
  }

  const ranked = [...deduped.values()].sort((left, right) => right.score - left.score);
  const top = ranked[0] ?? null;
  // A candidate with the same value as the winner agrees with it (the same title block printed on two
  // sheets); only a different value is a rival that can make the choice uncertain.
  const second =
    ranked.find(
      (candidate, index) =>
        index > 0 && candidate.value.trim().toUpperCase() !== (top?.value ?? "").trim().toUpperCase(),
    ) ?? null;

  if (!top || top.score <= 0) {
    return {
      selected: {
        value: fallbackValue,
        confidence: fallbackValue ? 0.2 : 0.05,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
        snippet: fallbackValue,
      },
      debugCandidates: ranked.slice(0, 5),
    };
  }

  const confidence = clamp(top.score / 100, 0.1, 0.99);
  const reviewNeeded = confidence < 0.72 || top.score < 72 || (second !== null && top.score - second.score < 12);

  return {
    selected: {
      value: top.value,
      confidence,
      reviewNeeded,
      reasons: top.reasons,
      sourceRegion: {
        page: top.page,
        line: top.line,
        columnStart: top.columnStart,
        columnEnd: top.columnEnd,
        label: top.label,
      },
      snippet: top.snippet,
    },
    debugCandidates: ranked.slice(0, 5),
  };
}

export function normalizeQuoteDescription(raw: string | null) {
  if (!raw) {
    return null;
  }

  const normalized = normalizeWhitespace(raw);

  if (/^ROUND,\s*CARBON FIBER END ATTACHMENTS BONDED$/i.test(normalized)) {
    return "BONDED, CARBON FIBER END ATTACHMENT";
  }

  return normalized;
}

export function normalizeQuoteFinish(raw: string | null) {
  if (!raw) {
    return null;
  }

  const normalized = normalizeWhitespace(raw);

  if (/ANODIZE/i.test(normalized) && /BLACK/i.test(normalized) && /TYPE\s*II/i.test(normalized)) {
    return "Black Anodize, Type II";
  }

  return normalized;
}

async function getPdfPageCount(localPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("pdfinfo", [localPath], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: PDF_TOOL_TIMEOUT_MS,
    });
    const match = stdout.match(/^Pages:\s+(\d+)$/m);
    const pageCount = Number.parseInt(match?.[1] ?? "", 10);
    return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : null;
  } catch {
    return null;
  }
}

/** CropBox size of one page, which is what pdfinfo prints as the page size. */
async function getPdfPageSize(
  localPath: string,
  page: number,
  timeoutMs = PDF_TOOL_TIMEOUT_MS,
): Promise<{ widthPoints: number; heightPoints: number } | null> {
  try {
    const { stdout } = await execFileAsync("pdfinfo", ["-f", String(page), "-l", String(page), localPath], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
    const match =
      stdout.match(new RegExp(`^Page\\s+${page} size:\\s+([\\d.]+)\\s+x\\s+([\\d.]+)\\s+pts`, "m")) ??
      (page === 1 ? stdout.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m) : null);
    const widthPoints = Number.parseFloat(match?.[1] ?? "");
    const heightPoints = Number.parseFloat(match?.[2] ?? "");

    if (!Number.isFinite(widthPoints) || !Number.isFinite(heightPoints)) {
      return null;
    }

    return {
      widthPoints,
      heightPoints,
    };
  } catch {
    return null;
  }
}

export async function extractPdfText(localPath: string): Promise<PdfTextExtraction | null> {
  const detectedPageCount = await getPdfPageCount(localPath);
  const pageCount = detectedPageCount ?? 1;
  const layerTexts: string[] = [];
  let textLayerComplete = true;
  const textLayerDeadline = Date.now() + PDF_TEXT_LAYER_TOTAL_TIMEOUT_MS;

  for (let page = 1; page <= pageCount; page += 1) {
    const remainingMs = textLayerDeadline - Date.now();
    if (page > PDF_TEXT_LAYER_MAX_PAGES || remainingMs <= 0) {
      layerTexts.push("");
      textLayerComplete = false;
      continue;
    }

    try {
      const { stdout } = await execFileAsync(
        "pdftotext",
        ["-layout", "-enc", "UTF-8", "-f", String(page), "-l", String(page), localPath, "-"],
        {
          maxBuffer: 20 * 1024 * 1024,
          timeout: Math.min(PDF_TOOL_TIMEOUT_MS, remainingMs),
        },
      );
      layerTexts.push(stdout);
    } catch {
      layerTexts.push("");
      textLayerComplete = false;
    }
  }

  // OVD-989: the same pages' word boxes, for the title block reader. A failure here is not a failure of
  // the text layer: that page keeps its layout text, the reader falls back to it, and drawingFullyRead
  // is unchanged.
  const wordBoxes = await readWordBoxes(localPath, layerTexts);

  // Every page is OCR'd even when a text layer exists, because a selectable
  // title block can sit next to an embedded raster marking that has no text.
  const ocrResults = await ocrPdfPages(localPath, pageCount);
  const hasTextLayer = layerTexts.some((text) => text.trim().length > 0);
  const hasOcrText = ocrResults.some((result) => result.text.trim().length > 0);

  if (detectedPageCount === null && !hasTextLayer && !hasOcrText) {
    return null;
  }

  return {
    pageCount,
    pageCountKnown: detectedPageCount !== null,
    drawingFullyRead:
      detectedPageCount !== null && textLayerComplete && ocrResults.every((result) => result.status === "ok"),
    // Same meaning as the older OCR fallback flag, so the two PRs merge cleanly.
    ocr: !hasTextLayer && hasOcrText,
    pages: layerTexts.map((layerText, index) => ({
      page: index + 1,
      text: hasTextLayer ? layerText : ocrResults[index].text,
      ocrText: ocrResults[index].text,
      ocrStatus: ocrResults[index].status,
      ...(ocrResults[index].limit ? { ocrLimit: ocrResults[index].limit } : {}),
      ...(hasTextLayer && wordBoxes[index] ? { words: wordBoxes[index] } : {}),
    })),
  };
}

/** Word boxes of every page that has a text layer; undefined for a page poppler could not or did not box. */
async function readWordBoxes(localPath: string, layerTexts: readonly string[]): Promise<Array<PdfWord[] | undefined>> {
  const boxes: Array<PdfWord[] | undefined> = [];
  const deadline = Date.now() + PDF_WORD_BOXES_TOTAL_TIMEOUT_MS;
  let totalWords = 0;
  for (let index = 0; index < layerTexts.length; index += 1) {
    const remainingMs = deadline - Date.now();
    // The geometry of a page costs memory until the task ends, so the words of all pages together are
    // bounded; pages past the bound keep their layout text only.
    if (layerTexts[index]!.trim().length === 0 || remainingMs <= 0 || totalWords >= MAX_WORDS_TOTAL) {
      boxes.push(undefined);
      continue;
    }
    try {
      const { stdout } = await execFileAsync(
        "pdftotext",
        ["-bbox", "-enc", "UTF-8", "-f", String(index + 1), "-l", String(index + 1), localPath, "-"],
        { maxBuffer: 32 * 1024 * 1024, timeout: Math.min(PDF_TOOL_TIMEOUT_MS, remainingMs) },
      );
      const words = parseBboxWords(typeof stdout === "string" ? stdout : "");
      totalWords += words.length;
      boxes.push(words.length > 0 && totalWords <= MAX_WORDS_TOTAL ? words : undefined);
    } catch {
      boxes.push(undefined);
    }
  }
  return boxes;
}

/** Time left before `deadline`, capped at `capMs`; zero or less means skip the call. */
function remainingBudgetMs(deadline: number, capMs: number): number {
  return Math.min(capMs, deadline - Date.now());
}

async function isTesseractAvailable(deadline: number): Promise<boolean> {
  const timeout = remainingBudgetMs(deadline, PDF_TOOL_TIMEOUT_MS);
  if (timeout <= 0) {
    return false;
  }

  try {
    await execFileAsync("tesseract", ["--version"], {
      maxBuffer: 1024 * 1024,
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

type PageOcrResult = { status: PdfOcrStatus; text: string; limit?: PdfOcrLimit };

async function ocrPdfPages(localPath: string, pageCount: number): Promise<PageOcrResult[]> {
  // The clock starts before the version probe so the probe counts too.
  const deadline = Date.now() + PDF_OCR_TOTAL_TIMEOUT_MS;

  if (!(await isTesseractAvailable(deadline))) {
    // Fixed code only: never log file names, paths, or contents.
    console.warn(PDF_OCR_UNAVAILABLE_WARNING_CODE);
    return Array.from({ length: pageCount }, () => ({ status: "unavailable" as const, text: "" }));
  }

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-pdf-ocr-"));
  try {
    const results: PageOcrResult[] = [];

    // Serial on purpose: pages are capped at PDF_OCR_MAX_PAGES and a render plus
    // tesseract run is memory heavy, so parallel pages would risk the worker.
    for (let page = 1; page <= pageCount; page += 1) {
      if (page > PDF_OCR_MAX_PAGES) {
        results.push({ status: "not_read", text: "", limit: "page_cap" });
        continue;
      }
      results.push(await ocrPdfPage(localPath, path.join(runDir, `drawing-page-${page}.png`), page, deadline));
    }

    return results;
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ocrPdfPage(
  localPath: string,
  previewPath: string,
  page: number,
  deadline: number,
): Promise<PageOcrResult> {
  try {
    const rendered = await renderPdfPageForOcr(localPath, previewPath, page, deadline);
    if (rendered === "too_large") {
      return { status: "failed", text: "", limit: "pixel_cap" };
    }
    if (rendered !== "ok") {
      return { status: rendered, text: "" };
    }

    const timeout = remainingBudgetMs(deadline, PDF_OCR_PAGE_TIMEOUT_MS);
    if (timeout <= 0) {
      return { status: "not_read", text: "" };
    }

    const { stdout } = await execFileAsync("tesseract", [previewPath, "stdout", "--psm", "4"], {
      maxBuffer: 20 * 1024 * 1024,
      timeout,
      // One OpenMP thread: on a loaded host four threads were 20 to 70 times
      // slower than one and could hit the page timeout.
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    });
    return { status: "ok", text: stdout };
  } catch {
    return { status: "failed", text: "" };
  } finally {
    // Drop each render as soon as it is read so /tmp holds one page at a time.
    await fs.rm(previewPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Renders one page's CropBox at PDF_OCR_MIN_DPI. pdfinfo reports the CropBox
 * size and pdftoppm renders the CropBox only with -cropbox, so the pixel cap is
 * checked against the area actually rendered; without it a small CropBox on a
 * huge MediaBox would pass the cap and render the whole MediaBox.
 * Returns failed when the page size is unknown, too_large when it is over
 * PDF_OCR_MAX_PIXELS (the caller reports that page failed with the pixel cap
 * as its limit), and not_read when the OCR budget runs out before a call can
 * start. Quick Look is
 * not used here because it cannot honour a resolution floor.
 */
export async function renderPdfPageForOcr(
  pdfPath: string,
  outputPath: string,
  page: number,
  deadline: number,
): Promise<"ok" | "failed" | "not_read" | "too_large"> {
  const sizeTimeout = remainingBudgetMs(deadline, PDF_TOOL_TIMEOUT_MS);
  if (sizeTimeout <= 0) {
    return "not_read";
  }

  const size = await getPdfPageSize(pdfPath, page, sizeTimeout);
  if (!size) {
    return "failed";
  }

  const scale = PDF_OCR_MIN_DPI / 72;
  const pixels = size.widthPoints * scale * (size.heightPoints * scale);
  if (!Number.isFinite(pixels)) {
    return "failed";
  }
  if (pixels > PDF_OCR_MAX_PIXELS) {
    return "too_large";
  }

  const renderTimeout = remainingBudgetMs(deadline, PDF_OCR_PAGE_TIMEOUT_MS);
  if (renderTimeout <= 0) {
    return "not_read";
  }

  const outputPrefix = outputPath.slice(0, -".png".length);
  await execFileAsync(
    "pdftoppm",
    [
      "-png",
      "-gray",
      "-cropbox",
      "-r",
      String(PDF_OCR_MIN_DPI),
      "-f",
      String(page),
      "-l",
      String(page),
      "-singlefile",
      pdfPath,
      outputPrefix,
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: renderTimeout,
    },
  );
  await fs.access(outputPath);
  return "ok";
}

async function renderPdfPage(
  pdfPath: string,
  outputPath: string,
  pageIndex: number,
  maxDimension: number,
): Promise<{ width: number | null; height: number | null } | null> {
  const outputPrefix = outputPath.endsWith(".png") ? outputPath.slice(0, -4) : outputPath;

  await execFileAsync(
    "pdftoppm",
    [
      "-png",
      "-f",
      String(pageIndex + 1),
      "-l",
      String(pageIndex + 1),
      "-singlefile",
      "-scale-to",
      String(maxDimension),
      pdfPath,
      outputPrefix,
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: PDF_OCR_PAGE_TIMEOUT_MS,
    },
  );

  const resolvedOutputPath = `${outputPrefix}.png`;
  await fs.access(resolvedOutputPath);

  if (resolvedOutputPath !== outputPath) {
    await fs.rename(resolvedOutputPath, outputPath);
  }

  return { width: null, height: null };
}

async function renderPdfPageWithQuickLook(
  pdfPath: string,
  outputPath: string,
  maxDimension: number,
): Promise<{ width: number | null; height: number | null } | null> {
  const outputDir = path.dirname(outputPath);
  const expectedNames = [
    `${path.basename(pdfPath)}.png`,
    `${path.basename(pdfPath, path.extname(pdfPath))}.png`,
  ];

  await execFileAsync("qlmanage", ["-t", "-s", String(maxDimension), "-o", outputDir, pdfPath], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: PDF_TOOL_TIMEOUT_MS,
  });

  let resolvedOutputPath: string | null = null;

  for (const expectedName of expectedNames) {
    const candidatePath = path.join(outputDir, expectedName);

    try {
      await fs.access(candidatePath);
      resolvedOutputPath = candidatePath;
      break;
    } catch {
      // Continue searching the expected Quick Look output names.
    }
  }

  if (!resolvedOutputPath) {
    return null;
  }

  if (resolvedOutputPath !== outputPath) {
    await fs.rename(resolvedOutputPath, outputPath);
  }

  return { width: null, height: null };
}

export async function renderPdfFirstPagePreview(
  pdfPath: string,
  outputPath: string,
  maxDimension = 1600,
): Promise<RenderedPreviewAsset | null> {
  let pageMeta: { width: number | null; height: number | null } | null = null;

  try {
    pageMeta = await renderPdfPage(pdfPath, outputPath, 0, maxDimension);
  } catch {
    // Quick Look exists only on macOS; elsewhere it can only fail.
    try {
      pageMeta =
        process.platform === "darwin" ? await renderPdfPageWithQuickLook(pdfPath, outputPath, maxDimension) : null;
    } catch {
      pageMeta = null;
    }
  }

  if (!pageMeta) {
    return null;
  }

  return {
    localPath: outputPath,
    pageNumber: 1,
    kind: "page",
    width: pageMeta.width,
    height: pageMeta.height,
    contentType: "image/png",
  };
}

export async function renderPdfTitleBlockCrop(
  pdfPath: string,
  outputPath: string,
): Promise<RenderedPreviewAsset | null> {
  const pageSize = await getPdfPageSize(pdfPath, 1);

  if (!pageSize) {
    return null;
  }

  const renderDpi = 150;
  const pageWidthPixels = Math.max(1, Math.round((pageSize.widthPoints / 72) * renderDpi));
  const pageHeightPixels = Math.max(1, Math.round((pageSize.heightPoints / 72) * renderDpi));
  const cropX = Math.floor(pageWidthPixels * 0.48);
  const cropY = Math.floor(pageHeightPixels * 0.58);
  const cropWidth = Math.max(1, pageWidthPixels - cropX);
  const cropHeight = Math.max(1, pageHeightPixels - cropY);
  const outputPrefix = outputPath.endsWith(".png") ? outputPath.slice(0, -4) : outputPath;

  await execFileAsync(
    "pdftoppm",
    [
      "-png",
      // The crop is computed from the CropBox size pdfinfo prints, so render that box.
      "-cropbox",
      "-r",
      String(renderDpi),
      "-f",
      "1",
      "-l",
      "1",
      "-singlefile",
      "-x",
      String(cropX),
      "-y",
      String(cropY),
      "-W",
      String(cropWidth),
      "-H",
      String(cropHeight),
      pdfPath,
      outputPrefix,
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: PDF_OCR_PAGE_TIMEOUT_MS,
    },
  );

  const resolvedOutputPath = `${outputPrefix}.png`;
  await fs.access(resolvedOutputPath);

  if (resolvedOutputPath !== outputPath) {
    await fs.rename(resolvedOutputPath, outputPath);
  }

  return {
    localPath: outputPath,
    pageNumber: 1,
    kind: "page",
    width: cropWidth,
    height: cropHeight,
    contentType: "image/png",
  };
}

export async function renderPdfPreviewAssets(
  pdfPath: string,
  outputDir: string,
  pageCount: number,
): Promise<RenderedPreviewAsset[]> {
  if (pageCount <= 0) {
    return [];
  }

  const assets: RenderedPreviewAsset[] = [];
  const thumbnailPath = path.join(outputDir, "drawing-thumbnail.png");
  const thumbnailAsset = await renderPdfFirstPagePreview(pdfPath, thumbnailPath, 320);

  if (thumbnailAsset) {
    assets.push({
      localPath: thumbnailPath,
      pageNumber: 1,
      kind: "thumbnail",
      width: thumbnailAsset.width,
      height: thumbnailAsset.height,
      contentType: "image/png",
    });
  }

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const outputPath = path.join(outputDir, `drawing-page-${pageIndex + 1}.png`);
    let pageMeta: { width: number | null; height: number | null } | null = null;

    try {
      pageMeta = await renderPdfPage(pdfPath, outputPath, pageIndex, 1600);
    } catch {
      if (pageIndex === 0) {
        pageMeta = (await renderPdfFirstPagePreview(pdfPath, outputPath, 1600)) ?? null;
      }
    }

    if (!pageMeta) {
      continue;
    }

    assets.push({
      localPath: outputPath,
      pageNumber: pageIndex + 1,
      kind: "page",
      width: pageMeta.width,
      height: pageMeta.height,
      contentType: "image/png",
    });
  }

  return assets;
}

export function inferDrawingSignalsFromPdf(input: {
  baseName: string;
  pdfText: PdfTextExtraction | null;
}): ExtractedDrawingSignals {
  const fallbackTitle = titleCaseFromStem(input.baseName);

  if (!input.pdfText || input.pdfText.pages.length === 0) {
    return {
      description: {
        value: fallbackTitle,
        confidence: 0.2,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
        snippet: fallbackTitle,
      },
      partNumber: {
        value: input.baseName.toUpperCase(),
        confidence: 0.2,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
        snippet: input.baseName.toUpperCase(),
      },
      revision: {
        value: null,
        confidence: 0.05,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
        snippet: null,
      },
      material: {
        value: null,
        confidence: 0.05,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
        snippet: null,
      },
      finish: {
        value: null,
        confidence: 0.05,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
        snippet: null,
      },
      process: {
        value: null,
        confidence: 0.05,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
        snippet: null,
      },
      generalTolerance: null,
      tightestTolerance: null,
      quoteDescription: normalizeQuoteDescription(fallbackTitle),
      quoteFinish: null,
      reviewFields: ["description", "partNumber", "revision", "material", "finish"],
      notes: [],
      threads: [],
      evidence: [
        {
          field: "description",
          page: 1,
          snippet: fallbackTitle,
          confidence: 0.2,
          reasons: ["regex_fit"],
        },
      ],
      warnings: ["Unable to extract text from the drawing PDF. Review extracted fields manually."],
      debugCandidates: {},
    };
  }

  const lines = collectStructuredLines(input.pdfText.pages);
  const bounds = detectTitleBlockBounds(lines);
  const titleBlockLines = buildTitleBlockLineMap(lines, bounds);
  const lineAnchors = buildLineAnchorMap(lines, bounds);
  const joinedText = input.pdfText.pages.map((page) => page.text).join("\n");
  const evidence: ExtractedDrawingSignals["evidence"] = [];
  const warnings: string[] = [];
  const debugCandidates: ExtractedDrawingSignals["debugCandidates"] = {};

  const descriptionCandidate = pickBestCandidate(
    "description",
    [
      ...buildAnchoredCandidates(findLabelAnchors(lines, DESCRIPTION_LABELS, bounds), titleBlockLines, lineAnchors, "description"),
      ...collectFallbackDescriptionCandidates(lines, bounds),
    ],
    fallbackTitle,
  );
  // OVD-985, OVD-989: the part number, revision, material and finish are the values of the cells their
  // labels own. When a label is present but its cell gives no clean value, nothing is filled from
  // neighbouring text (no fallback for revision, material or finish): the field stays empty and flagged.
  // A part number shaped like a drawing number is still offered as a flagged suggestion.
  const cellReads = readTitleBlockCells(selectTitleBlockLines(input.pdfText.pages, lines, bounds));
  const hasCellLabel = (field: CellField) => cellReads.some((read) => read.field === field);
  const partNumberCandidate = pickBestCandidate(
    "partNumber",
    [...buildCellCandidates(cellReads, "partNumber"), ...collectFallbackPartNumberCandidates(lines, bounds)],
    input.baseName.toUpperCase(),
  );
  const revisionCandidate = pickBestCandidate(
    "revision",
    [
      ...buildCellCandidates(cellReads, "revision"),
      ...(hasCellLabel("revision") ? [] : collectFallbackRevisionCandidates(lines, bounds)),
    ],
    null,
  );
  const materialCandidate = pickBestCandidate("material", buildCellCandidates(cellReads, "material"), null);
  const finishCandidate = pickBestCandidate(
    "finish",
    [
      ...buildCellCandidates(cellReads, "finish"),
      ...(hasCellLabel("finish") ? [] : collectFallbackFinishCandidates(lines, bounds)),
    ],
    null,
  );
  const processCandidate = pickBestCandidate(
    "process",
    buildAnchoredCandidates(findLabelAnchors(lines, PROCESS_LABELS, bounds), titleBlockLines, lineAnchors, "process"),
    null,
  );
  const toleranceMatch = joinedText.match(
    /\b(?:unless otherwise specified|general tolerance|tolerances?)\b[^\n\r]*?((?:\+\/-|±)\s*[0-9]*\.?[0-9]+)/i,
  );
  const notes = collectNotes(lines);
  const threads = collectThreads(joinedText);
  // OVD-989: dimension decimals are read from a real text layer only; OCR digits are not trusted to
  // rule a general-tolerance row out. A page with a text layer is OCR'd too (a raster view beside vector
  // text): a decimal only its OCR prints keeps a row from being dropped (T4), never sets it in force. A row is
  // dropped only when the whole drawing was read (T1): a page whose text layer or OCR was not read may print the
  // four-place dimension that keeps the four-place row, and is no evidence that none exists.
  const inferredTightestTolerance = estimateTightestTolerance(joinedText, {
    dimensionsReadable: input.pdfText.ocr !== true && input.pdfText.drawingFullyRead === true,
    rasterText: input.pdfText.ocr === true ? "" : input.pdfText.pages.map((page) => page.ocrText).join("\n"),
  });

  const fieldResults = {
    description: descriptionCandidate.selected,
    partNumber: partNumberCandidate.selected,
    revision: revisionCandidate.selected,
    material: materialCandidate.selected,
    finish: finishCandidate.selected,
    process: processCandidate.selected,
  };

  rescueOcrTitleBlockFields({
    baseName: input.baseName,
    text: joinedText,
    fields: fieldResults,
  });
  // After the rescue, so that a value a cell gave is flagged, not replaced by the file name's.
  for (const field of CELL_FIELDS) {
    fieldResults[field] = flagBesideUnreadCell(fieldResults[field], cellReads, field);
  }

  const reviewFieldResults = {
    description: fieldResults.description,
    partNumber: fieldResults.partNumber,
    revision: fieldResults.revision,
    material: fieldResults.material,
    finish: fieldResults.finish,
  } satisfies Record<SupportedReviewField, ExtractedFieldSignal>;

  debugCandidates.description = descriptionCandidate.debugCandidates;
  debugCandidates.partNumber = partNumberCandidate.debugCandidates;
  debugCandidates.revision = revisionCandidate.debugCandidates;
  debugCandidates.material = materialCandidate.debugCandidates;
  debugCandidates.finish = finishCandidate.debugCandidates;
  debugCandidates.process = processCandidate.debugCandidates;

  for (const [field, result] of Object.entries(reviewFieldResults) as Array<
    [SupportedReviewField, ExtractedFieldSignal]
  >) {
    if (result.value) {
      evidence.push({
        field,
        page: result.sourceRegion?.page ?? 1,
        snippet: result.snippet ?? result.value,
        confidence: result.confidence,
        reasons: result.reasons,
      });
    }

    if (result.reviewNeeded) {
      warnings.push(`${field.charAt(0).toUpperCase()}${field.slice(1)} extraction needs review.`);
    }
  }

  const reviewFields = (Object.entries(reviewFieldResults) as Array<
    [SupportedReviewField, ExtractedFieldSignal]
  >)
    .filter(([, result]) => result.reviewNeeded)
    .map(([field]) => field);

  return {
    description: fieldResults.description,
    partNumber: fieldResults.partNumber,
    revision: fieldResults.revision,
    material: fieldResults.material,
    finish: fieldResults.finish,
    process: fieldResults.process,
    generalTolerance: toleranceMatch?.[1] ? cleanCapturedValue(toleranceMatch[1]) : null,
    tightestTolerance: inferredTightestTolerance?.raw ?? null,
    tightestToleranceValueInch: inferredTightestTolerance?.valueInch ?? null,
    tightestToleranceUnit: inferredTightestTolerance?.unit ?? null,
    tightestToleranceDrawingUnits: inferredTightestTolerance?.drawingUnits ?? null,
    quoteDescription: normalizeQuoteDescription(fieldResults.description.value),
    quoteFinish: normalizeQuoteFinish(fieldResults.finish.value),
    reviewFields,
    notes,
    threads,
    evidence,
    warnings,
    debugCandidates,
  };
}

export async function readFileBuffer(filePath: string) {
  return fs.readFile(filePath);
}
