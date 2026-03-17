// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  shouldTriggerDrawingModelFallback,
  validateModelFieldValue,
} from "./modelFallback";
import type { ExtractedDrawingSignals } from "./pdfDrawing";

function makeSignals(overrides: Partial<ExtractedDrawingSignals> = {}): ExtractedDrawingSignals {
  return {
    description: {
      value: "Widget Clamp",
      confidence: 0.95,
      reviewNeeded: false,
      reasons: ["label_match"],
      sourceRegion: null,
      snippet: "Widget Clamp",
    },
    partNumber: {
      value: "1000-00001",
      confidence: 0.96,
      reviewNeeded: false,
      reasons: ["label_match"],
      sourceRegion: null,
      snippet: "1000-00001",
    },
    revision: {
      value: "02",
      confidence: 0.94,
      reviewNeeded: false,
      reasons: ["label_match"],
      sourceRegion: null,
      snippet: "02",
    },
    material: {
      value: "6061-T6",
      confidence: 0.92,
      reviewNeeded: false,
      reasons: ["label_match"],
      sourceRegion: null,
      snippet: "6061-T6",
    },
    finish: {
      value: "BLACK ANODIZE",
      confidence: 0.91,
      reviewNeeded: false,
      reasons: ["label_match"],
      sourceRegion: null,
      snippet: "BLACK ANODIZE",
    },
    process: {
      value: null,
      confidence: 0.1,
      reviewNeeded: true,
      reasons: ["regex_fit"],
      sourceRegion: null,
      snippet: null,
    },
    generalTolerance: null,
    tightestTolerance: null,
    quoteDescription: null,
    quoteFinish: null,
    reviewFields: [],
    notes: [],
    threads: [],
    evidence: [],
    warnings: [],
    debugCandidates: {
      description: [],
      partNumber: [],
      revision: [],
      material: [],
      finish: [],
      process: [],
    },
    ...overrides,
  };
}

describe("modelFallback", () => {
  it("does not trigger fallback when parser signals are strong", () => {
    expect(
      shouldTriggerDrawingModelFallback({
        drawingSignals: makeSignals(),
        hasDrawingFile: true,
        modelEnabled: true,
      }),
    ).toBe(false);
  });

  it("triggers fallback when a critical parser field is weak", () => {
    expect(
      shouldTriggerDrawingModelFallback({
        drawingSignals: makeSignals({
          revision: {
            value: "S",
            confidence: 0.32,
            reviewNeeded: true,
            reasons: ["regex_fit"],
            sourceRegion: null,
            snippet: "S",
          },
        }),
        hasDrawingFile: true,
        modelEnabled: true,
      }),
    ).toBe(true);
  });

  it("rejects finish specs as part numbers", () => {
    expect(validateModelFieldValue("partNumber", "MIL-A-8625F")).toContain("rejected_spec_string");
  });

  it("rejects signature/date text as finish", () => {
    expect(validateModelFieldValue("finish", "Engineer TIM 10/29/2013")).toEqual(
      expect.arrayContaining(["rejected_signature_block", "rejected_date_metadata"]),
    );
  });
});
