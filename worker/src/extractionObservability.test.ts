// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildExtractionCompletionPayload } from "./extractionObservability";
import type { DrawingExtractionPayload } from "./types";

function createExtraction(overrides: Partial<DrawingExtractionPayload> = {}): DrawingExtractionPayload {
  return {
    partId: "part-1",
    description: "Bracket",
    partNumber: "PN-1",
    revision: "A",
    modelFallbackUsed: false,
    modelName: null,
    extractedDescriptionRaw: {
      value: "Bracket",
      confidence: 0.99,
      reviewNeeded: false,
      reasons: [],
      sourceRegion: null,
    },
    extractedPartNumberRaw: {
      value: "PN-1",
      confidence: 0.99,
      reviewNeeded: false,
      reasons: [],
      sourceRegion: null,
    },
    extractedRevisionRaw: {
      value: "A",
      confidence: 0.99,
      reviewNeeded: false,
      reasons: [],
      sourceRegion: null,
    },
    extractedFinishRaw: {
      value: null,
      confidence: 0.5,
      reviewNeeded: false,
      reasons: [],
      sourceRegion: null,
    },
    quoteDescription: "Bracket",
    quoteFinish: null,
    reviewFields: [],
    material: {
      raw: "6061-T6",
      normalized: "6061-T6 Aluminum",
      confidence: 0.98,
      reviewNeeded: false,
      reasons: [],
    },
    finish: {
      raw: null,
      normalized: null,
      confidence: 0,
      reviewNeeded: false,
      reasons: [],
    },
    generalTolerance: { raw: null, confidence: 0 },
    tightestTolerance: { raw: null, valueInch: null, confidence: 0 },
    notes: [],
    threads: [],
    evidence: [],
    warnings: [],
    debugCandidates: [],
    modelCandidates: [],
    status: "approved",
    ...overrides,
  };
}

describe("buildExtractionCompletionPayload", () => {
  it("includes immutable observability fields for audit and queue payloads", () => {
    const completedAt = "2026-03-23T12:34:56.000Z";
    const payload = buildExtractionCompletionPayload({
      extraction: createExtraction({
        modelFallbackUsed: true,
        modelName: "gpt-5.4",
        warnings: ["missing tolerance"],
      }),
      extractionOutcome: {
        lifecycle: "partial",
        missingFields: ["tightestToleranceInch"],
        reviewFields: ["finish"],
      },
      extractorVersion: "worker-pdf-v3",
      workerBuildVersion: "build-123",
      previewAssetCount: 2,
      autoApprovedPartCount: 1,
      completedAt,
    });

    expect(payload).toMatchObject({
      extractionStatus: "approved",
      extractionLifecycle: "partial",
      modelFallbackUsed: true,
      modelName: "gpt-5.4",
      autoApproved: true,
      completedAt,
      warningCount: 1,
    });
  });

  it("marks needs-review runs as not auto-approved and defaults model fields safely", () => {
    const payload = buildExtractionCompletionPayload({
      extraction: createExtraction({
        status: "needs_review",
        modelFallbackUsed: undefined,
        modelName: undefined,
      }),
      extractionOutcome: {
        lifecycle: "partial",
        missingFields: ["material"],
        reviewFields: ["material"],
      },
      extractorVersion: "worker-pdf-v3",
      workerBuildVersion: "build-123",
      previewAssetCount: 0,
      autoApprovedPartCount: 0,
      completedAt: "2026-03-23T12:34:56.000Z",
    });

    expect(payload.autoApproved).toBe(false);
    expect(payload.modelFallbackUsed).toBe(false);
    expect(payload.modelName).toBeNull();
  });
});
