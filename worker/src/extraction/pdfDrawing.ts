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

export async function extractPdfText(localPath: string): Promise<PdfTextExtraction | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const swiftSource = `
import Foundation
import PDFKit

let pdfPath = CommandLine.arguments[1]
let url = URL(fileURLWithPath: pdfPath)
guard let document = PDFDocument(url: url) else {
  fputs("Unable to open PDF", stderr)
  exit(2)
}

var pages: [[String: Any]] = []
for index in 0..<document.pageCount {
  let text = document.page(at: index)?.string ?? ""
  pages.append(["page": index + 1, "text": text])
}

let payload: [String: Any] = ["pageCount": document.pageCount, "pages": pages]
let json = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(json)
`;

  const { stdout } = await execFileAsync("swift", ["-e", swiftSource, localPath], {
    maxBuffer: 20 * 1024 * 1024,
  });

  return JSON.parse(stdout) as PdfTextExtraction;
}

async function renderPdfPage(
  pdfPath: string,
  outputPath: string,
  pageIndex: number,
  maxDimension: number,
): Promise<{ width: number; height: number } | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const swiftSource = `
import Foundation
import PDFKit
import AppKit

let pdfPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let pageIndex = Int(CommandLine.arguments[3]) ?? 0
let maxDimension = CGFloat(Double(CommandLine.arguments[4]) ?? 1200.0)

guard let document = PDFDocument(url: URL(fileURLWithPath: pdfPath)),
      let page = document.page(at: pageIndex) else {
  fputs("Unable to load PDF page", stderr)
  exit(2)
}

let bounds = page.bounds(for: .mediaBox)
let maxSourceDimension = max(bounds.width, bounds.height)
let scale = maxSourceDimension > 0 ? maxDimension / maxSourceDimension : 1.0
let width = max(Int((bounds.width * scale).rounded()), 1)
let height = max(Int((bounds.height * scale).rounded()), 1)

guard let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: width,
  pixelsHigh: height,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("Unable to allocate bitmap", stderr)
  exit(3)
}

guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
  fputs("Unable to create graphics context", stderr)
  exit(4)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.setFillColor(NSColor.white.cgColor)
context.cgContext.fill(CGRect(x: 0, y: 0, width: width, height: height))
context.cgContext.translateBy(x: 0, y: CGFloat(height))
context.cgContext.scaleBy(x: scale, y: -scale)
page.draw(with: .mediaBox, to: context.cgContext)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
  fputs("Unable to encode PNG", stderr)
  exit(5)
}

try png.write(to: URL(fileURLWithPath: outputPath))
let payload: [String: Any] = ["width": width, "height": height]
let json = try JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(json)
`;

  const { stdout } = await execFileAsync(
    "swift",
    ["-e", swiftSource, pdfPath, outputPath, String(pageIndex), String(maxDimension)],
    {
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  const payload = JSON.parse(stdout) as { width: number; height: number };
  return payload;
}

export async function renderPdfPreviewAssets(
  pdfPath: string,
  outputDir: string,
  pageCount: number,
): Promise<RenderedPreviewAsset[]> {
  if (process.platform !== "darwin" || pageCount <= 0) {
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

  for (let pageIndex = 0; pageIndex < Math.min(pageCount, 3); pageIndex += 1) {
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
