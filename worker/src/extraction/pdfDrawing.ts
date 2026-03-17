import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type PdfTextPage = {
  page: number;
  text: string;
};

export type PdfTextExtraction = {
  pageCount: number;
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

type SourceRegion = {
  page: number;
  line: number;
  columnStart: number;
  columnEnd: number;
  label: string | null;
};

type ExtractedFieldSignal = {
  value: string | null;
  confidence: number;
  reviewNeeded: boolean;
  reasons: string[];
  sourceRegion: SourceRegion | null;
  snippet: string | null;
};

type CandidateSignal = {
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

type ExtractedDrawingSignals = {
  description: ExtractedFieldSignal;
  partNumber: ExtractedFieldSignal;
  revision: ExtractedFieldSignal;
  material: ExtractedFieldSignal;
  finish: ExtractedFieldSignal;
  process: ExtractedFieldSignal;
  generalTolerance: string | null;
  tightestTolerance: string | null;
  quoteDescription: string | null;
  quoteFinish: string | null;
  reviewFields: string[];
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
const SIGNATURE_PATTERN = /\b(?:engineer|checker|checked|approvals|approved|date|ec\/date|ecn|tim)\b/i;
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
  const matches = text.match(/\b(?:M\d+(?:x\d+(?:\.\d+)?)?|(?:\d+\/\d+|\d+)-\d+\s*(?:UNC|UNF|UNEF|NPT|NPTF|2A|2B)?)\b/gi);
  return [...new Set((matches ?? []).map((match) => normalizeWhitespace(match)))].slice(0, 12);
}

function estimateTightestTolerance(text: string) {
  const matches = [...text.matchAll(/(?:\+\/-|±)\s*([0-9]*\.?[0-9]+)/g)];
  if (matches.length === 0) {
    return null;
  }

  const parsed = matches
    .map((match) => Number.parseFloat(match[1] ?? ""))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (parsed.length === 0) {
    return null;
  }

  return {
    raw: `±${parsed[0]}`,
    valueInch: parsed[0],
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

      const boundedValue = cleanCapturedValue(nextLine.raw.slice(lowerRowStart, cellEnd));
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

function normalizeQuoteDescription(raw: string | null) {
  if (!raw) {
    return null;
  }

  const normalized = normalizeWhitespace(raw);

  if (/^ROUND,\s*CARBON FIBER END ATTACHMENTS BONDED$/i.test(normalized)) {
    return "BONDED, CARBON FIBER END ATTACHMENT";
  }

  return normalized;
}

function normalizeQuoteFinish(raw: string | null) {
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
    });
    const match = stdout.match(/^Pages:\s+(\d+)$/m);
    const pageCount = Number.parseInt(match?.[1] ?? "", 10);
    return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : null;
  } catch {
    return null;
  }
}

export async function extractPdfText(localPath: string): Promise<PdfTextExtraction | null> {
  const pageCount = await getPdfPageCount(localPath);

  if (!pageCount) {
    return null;
  }

  const pages: PdfTextPage[] = [];

  for (let page = 1; page <= pageCount; page += 1) {
    try {
      const { stdout } = await execFileAsync(
        "pdftotext",
        ["-layout", "-enc", "UTF-8", "-f", String(page), "-l", String(page), localPath, "-"],
        {
          maxBuffer: 20 * 1024 * 1024,
        },
      );
      pages.push({ page, text: stdout });
    } catch {
      pages.push({ page, text: "" });
    }
  }

  return {
    pageCount,
    pages,
  };
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
    },
  );

  const resolvedOutputPath = `${outputPrefix}.png`;
  await fs.access(resolvedOutputPath);

  if (resolvedOutputPath !== outputPath) {
    await fs.rename(resolvedOutputPath, outputPath);
  }

  return { width: null, height: null };
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
  const thumbnailMeta = await renderPdfPage(pdfPath, thumbnailPath, 0, 320);

  if (thumbnailMeta) {
    assets.push({
      localPath: thumbnailPath,
      pageNumber: 1,
      kind: "thumbnail",
      width: thumbnailMeta.width,
      height: thumbnailMeta.height,
      contentType: "image/png",
    });
  }

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const outputPath = path.join(outputDir, `drawing-page-${pageIndex + 1}.png`);
    const pageMeta = await renderPdfPage(pdfPath, outputPath, pageIndex, 1600);

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

  debugCandidates.description = descriptionCandidate.debugCandidates;
  debugCandidates.partNumber = partNumberCandidate.debugCandidates;
  debugCandidates.revision = revisionCandidate.debugCandidates;
  debugCandidates.material = materialCandidate.debugCandidates;
  debugCandidates.finish = finishCandidate.debugCandidates;
  debugCandidates.process = processCandidate.debugCandidates;

  for (const [field, result] of Object.entries(fieldResults)) {
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

  const reviewFields = Object.entries(fieldResults)
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
    tightestTolerance: inferredTightestTolerance?.raw ?? (toleranceMatch?.[1] ? cleanCapturedValue(toleranceMatch[1]) : null),
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
