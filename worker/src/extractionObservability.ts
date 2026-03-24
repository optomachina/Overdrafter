import type { DrawingExtractionPayload } from "./types.js";

export type ExtractionCompletionSummary = {
  missingFields: string[];
  reviewFields: string[];
  lifecycle: "partial" | "succeeded";
};

export function buildExtractionCompletionPayload(input: {
  extraction: DrawingExtractionPayload;
  extractionOutcome: ExtractionCompletionSummary;
  extractorVersion: string;
  workerBuildVersion: string;
  previewAssetCount: number;
  autoApprovedPartCount: number;
  completedAt: string;
}) {
  const { extraction, extractionOutcome } = input;

  return {
    extractionStatus: extraction.status,
    extractionLifecycle: extractionOutcome.lifecycle,
    extractorVersion: input.extractorVersion,
    workerBuildVersion: input.workerBuildVersion,
    warningCount: extraction.warnings.length,
    missingFields: extractionOutcome.missingFields,
    reviewFields: extractionOutcome.reviewFields,
    previewAssetCount: input.previewAssetCount,
    autoApprovedPartCount: input.autoApprovedPartCount,
    modelFallbackUsed: extraction.modelFallbackUsed ?? false,
    modelName: extraction.modelName ?? null,
    autoApproved: extraction.status === "approved",
    completedAt: input.completedAt,
  };
}
