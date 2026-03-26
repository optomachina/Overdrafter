import type { DrawingExtractionPayload } from "../types.js";

export const PDF_EXTRACTOR_VERSION = "worker-pdf-v3";
export const SIM_EXTRACTOR_VERSION = "worker-sim-v1";

export type ExtractionCompletionSummary = {
  missingFields: string[];
  reviewFields: string[];
  lifecycle: "partial" | "succeeded";
};

export function summarizeExtractionOutcome(
  extraction: DrawingExtractionPayload,
): ExtractionCompletionSummary {
  const missingFields = [
    extraction.description ? null : "description",
    extraction.partNumber ? null : "partNumber",
    extraction.revision ? null : "revision",
    extraction.material.normalized || extraction.material.raw ? null : "material",
    extraction.finish.normalized || extraction.finish.raw ? null : "finish",
    extraction.tightestTolerance.valueInch ?? extraction.tightestTolerance.raw ? null : "tightestToleranceInch",
  ].filter((value): value is string => Boolean(value));
  const reviewFields = extraction.reviewFields.filter((field) => !missingFields.includes(field));

  return {
    missingFields,
    reviewFields,
    lifecycle:
      missingFields.length > 0 || reviewFields.length > 0 || extraction.warnings.length > 0
        ? "partial"
        : "succeeded",
  };
}

export function currentExtractorVersion(hasDrawingFile: boolean) {
  return hasDrawingFile ? PDF_EXTRACTOR_VERSION : SIM_EXTRACTOR_VERSION;
}

export function buildStoredExtractionPayload(
  extraction: DrawingExtractionPayload,
  pageCount: number,
  workerBuildVersion: string,
) {
  return {
    pageCount,
    workerBuildVersion,
    description: extraction.description,
    partNumber: extraction.partNumber,
    revision: extraction.revision,
    extractedDescriptionRaw: extraction.extractedDescriptionRaw,
    extractedPartNumberRaw: extraction.extractedPartNumberRaw,
    extractedRevisionRaw: extraction.extractedRevisionRaw,
    extractedFinishRaw: extraction.extractedFinishRaw,
    quoteDescription: extraction.quoteDescription,
    quoteFinish: extraction.quoteFinish,
    reviewFields: extraction.reviewFields,
    debugCandidates: extraction.debugCandidates,
    modelFallbackUsed: extraction.modelFallbackUsed,
    modelName: extraction.modelName,
    modelPromptVersion: extraction.modelPromptVersion,
    fieldSelections: extraction.fieldSelections,
    modelCandidates: extraction.modelCandidates,
    material: extraction.material,
    finish: extraction.finish,
    generalTolerance: extraction.generalTolerance,
    tolerances: {
      general: extraction.generalTolerance.raw,
      tightest: extraction.tightestTolerance.raw,
      valueInch: extraction.tightestTolerance.valueInch,
      confidence: extraction.tightestTolerance.confidence,
    },
    notes: extraction.notes,
    threads: extraction.threads,
  };
}
