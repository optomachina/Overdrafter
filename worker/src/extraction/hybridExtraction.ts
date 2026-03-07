import path from "node:path";
import type {
  DrawingExtractionPayload,
  JobFileRecord,
  PartRecord,
} from "../types.js";
import { inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing.js";

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function baseName(file: JobFileRecord | null, fallback: string): string {
  if (!file) {
    return fallback;
  }

  return path.basename(file.original_name, path.extname(file.original_name));
}

export async function runHybridExtraction(input: {
  part: PartRecord;
  cadFile: JobFileRecord | null;
  drawingFile: JobFileRecord | null;
  pdfText?: PdfTextExtraction | null;
}): Promise<DrawingExtractionPayload> {
  const inferredBase = baseName(input.drawingFile ?? input.cadFile, input.part.name);
  const normalizedTitle = titleCase(inferredBase);
  const drawingSignals = inferDrawingSignalsFromPdf({
    baseName: inferredBase,
    pdfText: input.pdfText ?? null,
  });
  const warnings = [...drawingSignals.warnings];

  if (!input.drawingFile) {
    warnings.push("No PDF drawing was attached. Material, finish, and tolerance values require review.");
  }

  return {
    partId: input.part.id,
    description: drawingSignals.description ?? normalizedTitle,
    partNumber: drawingSignals.partNumber ?? inferredBase.toUpperCase(),
    revision: drawingSignals.revision,
    material: {
      raw: drawingSignals.material,
      normalized: drawingSignals.material,
      confidence: drawingSignals.material ? (input.drawingFile ? 0.72 : 0.2) : input.drawingFile ? 0.35 : 0.15,
    },
    finish: {
      raw: drawingSignals.finish,
      normalized: drawingSignals.finish,
      confidence: drawingSignals.finish ? 0.6 : input.drawingFile ? 0.25 : 0.1,
    },
    generalTolerance: {
      raw: drawingSignals.generalTolerance,
      confidence: drawingSignals.generalTolerance ? 0.68 : input.drawingFile ? 0.2 : 0.1,
    },
    tightestTolerance: {
      raw: drawingSignals.tightestTolerance,
      valueInch: drawingSignals.tightestTolerance
        ? Number.parseFloat(drawingSignals.tightestTolerance.replace(/[^0-9.]/g, "")) || null
        : null,
      confidence: drawingSignals.tightestTolerance ? 0.68 : input.drawingFile ? 0.25 : 0.1,
    },
    notes: drawingSignals.notes,
    threads: drawingSignals.threads,
    evidence:
      drawingSignals.evidence.length > 0
        ? drawingSignals.evidence
        : [
            {
              field: "description",
              page: 1,
              snippet: normalizedTitle,
              confidence: 0.75,
            },
          ],
    warnings,
    status: "needs_review",
  };
}
