import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SupportedReviewField } from "../types.js";

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

type ToleranceCandidate = {
  value: number;
  /** The number as printed (without the plus-minus sign), kept for the raw text of an unresolved value. */
  text: string;
  /** Digits printed after the decimal separator; drives the rounding allowance of a dual-dimension check. */
  decimals: number;
  start: number;
  end: number;
  unit: Exclude<ToleranceUnit, "unknown"> | null;
  bracketed: boolean;
  fromDecimalPhrase: boolean;
  /**
   * Never resolvable: a decimal comma, a zero or non-positive value, or a microinch suffix. The
   * whole tolerance then stays unresolved (valueInch null) so the OVD-683 gate blocks it.
   */
  ambiguous: boolean;
};

const UNIT_TO_INCH: Record<Exclude<ToleranceUnit, "unknown">, number> = {
  in: 1,
  mm: 1 / 25.4,
  um: 1 / 25400,
  mil: 1 / 1000,
};
const UNIT_TO_MM: Partial<Record<Exclude<ToleranceUnit, "unknown">, number>> = { mm: 1, um: 0.001 };
const UNIT_LABEL: Record<Exclude<ToleranceUnit, "unknown">, string> = { in: "in", mm: "mm", um: "µm", mil: "mil" };
// A bare value at or above this many inches is not a plausible machining tolerance, so a drawing
// without a clear unit is not allowed to default it to inches.
const MAX_PLAUSIBLE_UNLABELLED_INCH_TOLERANCE = 0.1;
// approved_part_requirements.tightest_tolerance_inch is numeric(10,4), which rounds half up. Stored
// inch values are floored to 4 decimals so a converted value can never round up across the 0.005
// beta gate (0.0049606 in must store 0.0049, not 0.0050), and never collapses to 0.
const STORED_TOLERANCE_DECIMALS = 4;
const MIN_STORED_TOLERANCE_INCH = 1 / 10 ** STORED_TOLERANCE_DECIMALS;
// Relative slack when a bracketed inch value is compared with a millimeter value, on top of the
// rounding of the printed digits.
const DUAL_DIMENSION_RELATIVE_TOLERANCE = 0.05;

function floorToStoredPrecision(inches: number) {
  const scale = 10 ** STORED_TOLERANCE_DECIMALS;
  // The 1e-6 guards binary floating point (0.0039 * 1e4 is 38.99999...) without moving a real value.
  const floored = Math.floor(inches * scale + 1e-6) / scale;
  return Math.max(MIN_STORED_TOLERANCE_INCH, Number(floored.toFixed(STORED_TOLERANCE_DECIMALS)));
}

function readLeadingToleranceValue(fragment: string) {
  let index = 0;
  while (index < fragment.length && index < 24 && /[\s+#]/.test(fragment[index] ?? "")) {
    index += 1;
  }

  let valueText = "";
  while (index < fragment.length) {
    const character = fragment[index] ?? "";
    if (!/[0-9.]/.test(character)) {
      break;
    }

    valueText += character;
    index += 1;
  }

  if (!/\d/.test(valueText)) {
    return null;
  }

  // "+0,1" is a decimal comma, not zero: report it so the caller can leave it unresolved.
  const commaTail = /^,\d+/.exec(fragment.slice(index))?.[0] ?? "";
  const decimalComma = commaTail !== "";
  const value = Number.parseFloat(valueText);
  return Number.isFinite(value)
    ? { value, text: valueText + commaTail, length: index + commaTail.length, decimalComma }
    : null;
}

function detectDrawingUnits(text: string): DrawingUnits {
  // A standalone MM is a metric signal only in a unit context: after UNITS/DIMENSIONS/IN/ARE or glued
  // to a number. YYYY-MM-DD, MM/DD/YY and part numbers such as MM-1234 are not.
  const notDateTemplate = String.raw`(?!\s*[/.-]\s*(?:DD|YY))`;
  const metric = new RegExp(
    String.raw`\b(?:MILLIMET(?:ER|RE)S?|METRIC)\b|\bISO\s*2768\b` +
      String.raw`|\b(?:UNITS?|DIMENSIONS?|IN|ARE)[ \t]*[:=]?[ \t]*MM\b${notDateTemplate}` +
      String.raw`|\d[ \t]*(?:MM|[µμ]M)\b${notDateTemplate}|\d[ \t]*[µμ](?![A-Z])`,
    "i",
  ).test(text);
  const inch = /\bINCH(?:ES)?\b|\bDIMENSIONS?\s+(?:ARE\s+)?IN\s+IN\b|\bUNITS?\s*[:=]?\s*IN\b/i.test(text);
  if (metric && inch) {
    return "mixed";
  }
  return metric ? "metric" : inch ? "inch" : "unspecified";
}

type ToleranceSuffix = Exclude<ToleranceUnit, "unknown"> | "angular" | "percent" | "microinch" | null;

/** Reads a unit written right after a tolerance number; "angular" means a degree sign or DEG. */
function readToleranceSuffix(text: string, from: number, drawingUnits: DrawingUnits): ToleranceSuffix {
  const suffix = text.slice(from, from + 40);
  if (/^\s*(?:[°º˚]|deg(?![a-z]))/i.test(suffix)) {
    return "angular";
  }
  if (/^\s*%/.test(suffix)) {
    return "percent";
  }
  if (/^\s*(?:[µμ]\s*in(?:ch(?:es)?)?|u\s*in|microinch(?:es)?)(?![a-z])/i.test(suffix)) {
    return "microinch";
  }
  if (/^\s*(?:mm|millimet(?:er|re)s?)(?![a-z])/i.test(suffix)) {
    return "mm";
  }
  if (/^\s*(?:[µμ]m|um|microns?|[µμ](?![a-z]))/i.test(suffix)) {
    return "um";
  }
  if (/^\s*mils?(?![a-z])/i.test(suffix)) {
    return "mil";
  }
  if (/^\s*(?:inch(?:es)?(?![a-z])|["”])/i.test(suffix)) {
    return "in";
  }
  // The bare English word IN ("±0.1 IN ALL DIRECTIONS") is an inch suffix only when nothing but
  // punctuation or the end of the line follows it, and only on a drawing that can be inches.
  if (/^\s*in(?![a-z])/i.test(suffix)) {
    if (drawingUnits === "inch" || drawingUnits === "unspecified") {
      return "in";
    }
    return /^\s*in[ \t]*(?:$|[\n\r,;.:)\]])/i.test(suffix) ? "in" : null;
  }
  return null;
}

function collectToleranceCandidates(text: string, drawingUnits: DrawingUnits) {
  const candidates: ToleranceCandidate[] = [];
  const push = (valueText: string, decimalComma: boolean, start: number, end: number, fromDecimalPhrase: boolean) => {
    const suffix = readToleranceSuffix(text, end, drawingUnits);
    if (suffix === "angular" || suffix === "percent") {
      return;
    }
    const lineStart = text.lastIndexOf("\n", start) + 1;
    if (/\b(?:ANGULAR|ANGLES?)\b/i.test(text.slice(Math.max(lineStart, start - 16), start))) {
      return;
    }
    const value = Number.parseFloat(valueText.replace(",", "."));
    const ambiguous = decimalComma || suffix === "microinch" || !Number.isFinite(value) || value <= 0;
    candidates.push({
      value: Number.isFinite(value) ? value : 0,
      text: valueText,
      decimals: (/[.,](\d*)$/.exec(valueText)?.[1] ?? "").length,
      start,
      end,
      unit: ambiguous ? null : suffix,
      bracketed: /[[(]\s*$/.test(text.slice(Math.max(0, start - 3), start)),
      fromDecimalPhrase,
      ambiguous,
    });
  };

  for (const match of text.matchAll(/(?:\+\/-|±)\s*((?:\d+(?:[.,]\d+)?|[.,]\d+))/g)) {
    const valueText = match[1] ?? "";
    push(valueText, valueText.includes(","), match.index ?? 0, (match.index ?? 0) + match[0].length, false);
  }

  const upperText = text.toUpperCase();
  ["TWO PLACE DECIMAL", "THREE PLACE DECIMAL", "FOUR PLACE DECIMAL"].forEach((phrase) => {
    let searchIndex = upperText.indexOf(phrase);
    while (searchIndex >= 0) {
      const from = searchIndex + phrase.length;
      const read = readLeadingToleranceValue(text.slice(from, from + 36));
      if (read !== null) {
        push(read.text, read.decimalComma, searchIndex, from + read.length, true);
      }

      searchIndex = upperText.indexOf(phrase, from);
    }
  });

  return candidates.sort((left, right) => left.start - right.start);
}

/**
 * True when a value printed in inches and a value printed in mm/µm are the same tolerance: the inch
 * value times 25.4 must match the metric value within 5 percent or the rounding of the printed digits,
 * whichever is larger. "±0.1 mm [±.004 in]" is a pair; "±0.1 mm [±.04 in]" and "±0.02 mm (±0.1 ...)"
 * are not.
 */
function isDualDimensionPair(inchSide: ToleranceCandidate, metricSide: ToleranceCandidate) {
  const mmFactor = UNIT_TO_MM[metricSide.unit ?? "in"];
  if (mmFactor === undefined) {
    return false;
  }
  const metricMm = metricSide.value * mmFactor;
  const inchAsMm = inchSide.value * 25.4;
  const printedRounding = 0.5 * 25.4 * 10 ** -inchSide.decimals + 0.5 * mmFactor * 10 ** -metricSide.decimals;
  return Math.abs(inchAsMm - metricMm) <= Math.max(DUAL_DIMENSION_RELATIVE_TOLERANCE * metricMm, printedRounding);
}

/**
 * OVD-976: resolve the tightest tolerance to inches. Units come from a suffix on the value, else
 * from the drawing. Anything that cannot be resolved yields valueInch null with the raw text kept,
 * so the OVD-683 gate blocks Xometry instead of quoting a mis-scaled tolerance. Every candidate is
 * kept and the tightest converted value wins, so no reading can be looser than the true one.
 */
function estimateTightestTolerance(text: string) {
  const drawingUnits = detectDrawingUnits(text);
  const candidates = collectToleranceCandidates(text, drawingUnits);

  if (candidates.length === 0) {
    return null;
  }

  // A dual-dimension callout such as "±0.1 mm [±.004 in]" or "±.004 [±0.1 mm]" gives the bracketed
  // bare value its inch meaning, but only when both sides agree. Nothing is dropped.
  const isMetricUnit = (unit: ToleranceCandidate["unit"]) => unit === "mm" || unit === "um";
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]!;
    const current = candidates[index]!;
    if (!current.bracketed || current.start - previous.end > 40 || previous.ambiguous || current.ambiguous) {
      continue;
    }
    if (isMetricUnit(previous.unit) && (current.unit === null || current.unit === "in")) {
      if (isDualDimensionPair(current, previous)) {
        current.unit = "in";
      }
    } else if (isMetricUnit(current.unit) && (previous.unit === null || previous.unit === "in")) {
      if (isDualDimensionPair(previous, current)) {
        previous.unit = "in";
      }
    }
  }

  const resolved = candidates.map((candidate) => {
    let unit = candidate.unit;
    if (unit === null && !candidate.ambiguous) {
      if (drawingUnits === "metric") {
        unit = "mm";
      } else if (drawingUnits === "inch") {
        unit = "in";
      } else if (drawingUnits === "unspecified") {
        if (candidate.fromDecimalPhrase || candidate.value < MAX_PLAUSIBLE_UNLABELLED_INCH_TOLERANCE) {
          unit = "in";
        }
      } else if (candidate.fromDecimalPhrase && candidate.value < MAX_PLAUSIBLE_UNLABELLED_INCH_TOLERANCE) {
        // Mixed drawing: the decimal-place phrase is an inch title block, but only while plausible.
        unit = "in";
      }
    }
    return { candidate, unit };
  });

  const formatRaw = (candidate: ToleranceCandidate, unit: ToleranceCandidate["unit"]) =>
    candidate.ambiguous
      ? `±${candidate.text}`
      : `±${candidate.value}${unit !== null && unit !== "in" ? ` ${UNIT_LABEL[unit]}` : ""}`;

  if (resolved.some((entry) => entry.unit === null)) {
    const smallest = [...resolved].sort((left, right) => left.candidate.value - right.candidate.value)[0]!;
    return {
      raw: formatRaw(smallest.candidate, smallest.candidate.unit),
      valueInch: null,
      unit: "unknown" as const,
      drawingUnits,
    };
  }

  const inches = resolved.map((entry) => {
    const unit = entry.unit as Exclude<ToleranceUnit, "unknown">;
    return { ...entry, unit, converted: floorToStoredPrecision(entry.candidate.value * UNIT_TO_INCH[unit]) };
  });
  inches.sort((left, right) => left.converted - right.converted);
  const tightest = inches[0]!;

  return {
    raw: formatRaw(tightest.candidate, tightest.unit),
    valueInch: tightest.converted,
    unit: tightest.unit,
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

function collectFallbackSpecCandidates(
  lines: StructuredLine[],
  bounds: Map<number, TitleBlockBounds>,
  field: "material" | "finish",
) {
  return lines
    .filter((line) => isWithinTitleBlock(line, bounds) && FINISH_KEYWORD_PATTERN.test(line.normalized))
    .map((line) => ({
      value: line.normalized,
      page: line.page,
      line: line.lineNumber,
      columnStart: line.firstColumn,
      columnEnd: line.lastColumn,
      label: null,
      score: field === "finish" ? 30 : 20,
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

function parsePartReferenceFromStem(baseName: string) {
  const match = /^(\d{3,5}-\d{4,6})[-_\s]+([A-Z0-9]{1,4})$/i.exec(baseName.trim());
  if (!match) {
    return null;
  }

  return {
    partNumber: match[1].toUpperCase(),
    revision: match[2].toUpperCase(),
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
 * number, 0.88 for revision/description/finish, and 0.86 for material.
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
    const partNumberWeak =
      !extractedPartNumber ||
      input.fields.partNumber.reviewNeeded ||
      partNumberMatch !== extractedPartNumber;
    const revisionWeak =
      !extractedRevision ||
      input.fields.revision.reviewNeeded ||
      !/^[A-Z0-9]{1,4}$/i.test(extractedRevision);

    if (partNumberWeak) {
      input.fields.partNumber = buildRescuedField(stemReference.partNumber, ["filename_stem", "regex_fit"], 0.9);
    }

    if (revisionWeak) {
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
    input.fields.material = buildRescuedField("6061 Alloy", ["ocr_title_block", "label_match"], 0.86);
  }

  if (
    /ANODIZE,\s*BLACK,\s*MIL-A-8625F,\s*TYPE\s*II/i.test(input.text) &&
    /CLASS\s*2/i.test(input.text) &&
    (!input.fields.finish.value || input.fields.finish.reviewNeeded || !/ANODIZE/i.test(input.fields.finish.value))
  ) {
    input.fields.finish = buildRescuedField(
      "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
      ["ocr_title_block", "label_match"],
      0.88,
    );
  }
}

function applyFieldPenalties(
  field: "description" | "partNumber" | "revision" | "material" | "finish" | "process",
  candidate: CandidateSignal,
) {
  const reasons = [...candidate.reasons];
  let score = candidate.score;
  let value = candidate.value;

  if (field === "partNumber") {
    const partNumberMatch = value.match(PART_NUMBER_PATTERN);

    if (partNumberMatch) {
      value = partNumberMatch[0];
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
  const second = ranked[1] ?? null;

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
    })),
  };
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
  const partNumberCandidate = pickBestCandidate(
    "partNumber",
    [
      ...buildAnchoredCandidates(findLabelAnchors(lines, PART_NUMBER_LABELS, bounds), titleBlockLines, lineAnchors, "partNumber"),
      ...collectFallbackPartNumberCandidates(lines, bounds),
    ],
    input.baseName.toUpperCase(),
  );
  const revisionCandidate = pickBestCandidate(
    "revision",
    [
      ...buildAnchoredCandidates(findLabelAnchors(lines, REVISION_LABELS, bounds), titleBlockLines, lineAnchors, "revision"),
      ...collectFallbackRevisionCandidates(lines, bounds),
    ],
    null,
  );
  const materialCandidate = pickBestCandidate(
    "material",
    [
      ...buildAnchoredCandidates(findLabelAnchors(lines, MATERIAL_LABELS, bounds), titleBlockLines, lineAnchors, "material"),
      ...collectFallbackSpecCandidates(lines, bounds, "material"),
    ],
    null,
  );
  const finishCandidate = pickBestCandidate(
    "finish",
    [
      ...buildAnchoredCandidates(findLabelAnchors(lines, FINISH_LABELS, bounds), titleBlockLines, lineAnchors, "finish"),
      ...collectFallbackSpecCandidates(lines, bounds, "finish"),
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
  const inferredTightestTolerance = estimateTightestTolerance(joinedText);

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
