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

type ExtractedDrawingSignals = {
  description: string | null;
  partNumber: string | null;
  revision: string | null;
  material: string | null;
  finish: string | null;
  generalTolerance: string | null;
  tightestTolerance: string | null;
  notes: string[];
  threads: string[];
  evidence: Array<{ field: string; page: number; snippet: string; confidence: number }>;
  warnings: string[];
};

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

function findField(pages: PdfTextPage[], patterns: RegExp[]) {
  for (const page of pages) {
    for (const pattern of patterns) {
      const match = page.text.match(pattern);
      if (match?.[1]) {
        return {
          value: normalizeWhitespace(match[1]),
          page: page.page,
          snippet: normalizeWhitespace(match[0]),
        };
      }
    }
  }

  return null;
}

function collectLines(pages: PdfTextPage[]) {
  return pages.flatMap((page) =>
    page.text
      .split(/\r?\n/)
      .map((line) => ({ page: page.page, line: normalizeWhitespace(line) }))
      .filter((item) => item.line.length > 0),
  );
}

function collectNotes(lines: Array<{ page: number; line: string }>) {
  const notes: string[] = [];
  let capture = false;

  for (const item of lines) {
    if (/^notes?[:\s]*$/i.test(item.line)) {
      capture = true;
      continue;
    }

    if (capture) {
      if (/^(material|finish|revision|rev|title|scale|sheet)\b/i.test(item.line)) {
        break;
      }

      notes.push(item.line);
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
      description: fallbackTitle,
      partNumber: input.baseName.toUpperCase(),
      revision: null,
      material: null,
      finish: null,
      generalTolerance: null,
      tightestTolerance: null,
      notes: [],
      threads: [],
      evidence: [
        {
          field: "description",
          page: 1,
          snippet: fallbackTitle,
          confidence: 0.65,
        },
      ],
      warnings: ["Unable to extract text from the drawing PDF. Review extracted fields manually."],
    };
  }

  const lines = collectLines(input.pdfText.pages);
  const joinedText = input.pdfText.pages.map((page) => page.text).join("\n");
  const evidence: ExtractedDrawingSignals["evidence"] = [];
  const warnings: string[] = [];

  const descriptionMatch = lines.find((line) => !/^(material|finish|rev|revision|scale|sheet|notes?)\b/i.test(line.line));
  const partNumberMatch = findField(input.pdfText.pages, [
    /\b(?:part(?:\s*number)?|part\s*no|drawing\s*number|dwg\s*no|p\/n|pn)\s*[:#-]?\s*([A-Z0-9._-]{3,})/i,
    /\b([A-Z]{1,5}-?\d{3,}[A-Z0-9._-]*)\b/,
  ]);
  const revisionMatch = findField(input.pdfText.pages, [
    /\b(?:revision|rev)\s*[:#-]?\s*([A-Z0-9.-]{1,8})\b/i,
  ]);
  const materialMatch = findField(input.pdfText.pages, [
    /\bmaterial\b\s*[:#-]?\s*([^\n\r]+)/i,
  ]);
  const finishMatch = findField(input.pdfText.pages, [
    /\b(?:finish|coating|plating|surface\s*finish)\b\s*[:#-]?\s*([^\n\r]+)/i,
  ]);
  const toleranceMatch = findField(input.pdfText.pages, [
    /\b(?:unless otherwise specified|general tolerance|tolerances?)\b[^\n\r]*?((?:\+\/-|±)\s*[0-9]*\.?[0-9]+)/i,
  ]);
  const notes = collectNotes(lines);
  const threads = collectThreads(joinedText);
  const inferredTightestTolerance = estimateTightestTolerance(joinedText);

  if (partNumberMatch) {
    evidence.push({
      field: "partNumber",
      page: partNumberMatch.page,
      snippet: partNumberMatch.snippet,
      confidence: 0.82,
    });
  } else {
    warnings.push("Part number was not confidently detected from the drawing.");
  }

  if (revisionMatch) {
    evidence.push({
      field: "revision",
      page: revisionMatch.page,
      snippet: revisionMatch.snippet,
      confidence: 0.72,
    });
  }

  if (materialMatch) {
    evidence.push({
      field: "material",
      page: materialMatch.page,
      snippet: materialMatch.snippet,
      confidence: 0.75,
    });
  } else {
    warnings.push("Material was not confidently detected from the drawing.");
  }

  if (finishMatch) {
    evidence.push({
      field: "finish",
      page: finishMatch.page,
      snippet: finishMatch.snippet,
      confidence: 0.65,
    });
  }

  if (toleranceMatch) {
    evidence.push({
      field: "generalTolerance",
      page: toleranceMatch.page,
      snippet: toleranceMatch.snippet,
      confidence: 0.7,
    });
  }

  return {
    description: descriptionMatch?.line ?? fallbackTitle,
    partNumber: partNumberMatch?.value ?? input.baseName.toUpperCase(),
    revision: revisionMatch?.value ?? null,
    material: materialMatch?.value ?? null,
    finish: finishMatch?.value ?? null,
    generalTolerance: toleranceMatch?.value ?? null,
    tightestTolerance: inferredTightestTolerance?.raw ?? toleranceMatch?.value ?? null,
    notes,
    threads,
    evidence,
    warnings,
  };
}

export async function readFileBuffer(filePath: string) {
  return fs.readFile(filePath);
}
