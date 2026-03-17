import path from "node:path";
import type {
  DrawingExtractionPayload,
  JobFileRecord,
  PartRecord,
} from "../types.js";
import { inferDrawingSignalsFromPdf, type PdfTextExtraction } from "./pdfDrawing.js";

const SUPPORTED_REVIEW_FIELDS = new Set(["description", "partNumber", "revision", "material", "finish"]);

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
  const description = drawingSignals.description.value ?? normalizedTitle;
  const partNumber = drawingSignals.partNumber.value ?? inferredBase.toUpperCase();
  const finishRaw = drawingSignals.finish.value;
  const reviewFields = drawingSignals.reviewFields.filter((field) => SUPPORTED_REVIEW_FIELDS.has(field));
  const quoteDescription = drawingSignals.quoteDescription ?? description;
  const quoteFinish = drawingSignals.quoteFinish ?? finishRaw;

  if (!input.drawingFile) {
    warnings.push("No PDF drawing was attached. Material, finish, and tolerance values require review.");
  }

  return {
    partId: input.part.id,
    description,
    partNumber,
    revision: drawingSignals.revision.value,
    extractedDescriptionRaw: {
      value: description,
      confidence: drawingSignals.description.confidence,
      reviewNeeded: drawingSignals.description.reviewNeeded,
      reasons: drawingSignals.description.reasons,
      sourceRegion: drawingSignals.description.sourceRegion,
    },
    extractedPartNumberRaw: {
      value: partNumber,
      confidence: drawingSignals.partNumber.confidence,
      reviewNeeded: drawingSignals.partNumber.reviewNeeded,
      reasons: drawingSignals.partNumber.reasons,
      sourceRegion: drawingSignals.partNumber.sourceRegion,
    },
    extractedRevisionRaw: {
      value: drawingSignals.revision.value,
      confidence: drawingSignals.revision.confidence,
      reviewNeeded: drawingSignals.revision.reviewNeeded,
      reasons: drawingSignals.revision.reasons,
      sourceRegion: drawingSignals.revision.sourceRegion,
    },
    extractedFinishRaw: {
      value: drawingSignals.finish.value,
      confidence: drawingSignals.finish.confidence,
      reviewNeeded: drawingSignals.finish.reviewNeeded,
      reasons: drawingSignals.finish.reasons,
      sourceRegion: drawingSignals.finish.sourceRegion,
    },
    quoteDescription,
    quoteFinish,
    reviewFields,
    material: {
      raw: drawingSignals.material.value,
      normalized: drawingSignals.material.value,
      confidence: drawingSignals.material.value
        ? drawingSignals.material.confidence
        : input.drawingFile
          ? 0.35
          : 0.15,
      reviewNeeded: drawingSignals.material.reviewNeeded,
      reasons: drawingSignals.material.reasons,
    },
    finish: {
      raw: finishRaw,
      normalized: quoteFinish ?? finishRaw,
      confidence: drawingSignals.finish.value
        ? drawingSignals.finish.confidence
        : input.drawingFile
          ? 0.25
          : 0.1,
      reviewNeeded: drawingSignals.finish.reviewNeeded,
      reasons: drawingSignals.finish.reasons,
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
              reasons: ["regex_fit"],
            },
          ],
    warnings,
    debugCandidates: drawingSignals.debugCandidates,
    status: "needs_review",
  };
}
