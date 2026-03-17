// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFileRecord, PartRecord } from "../types";
import * as pdfDrawing from "./pdfDrawing";
import { runHybridExtraction } from "./hybridExtraction";

function makePart(overrides: Partial<PartRecord> = {}): PartRecord {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "fallback-bracket",
    normalized_key: "fallback-bracket",
    cad_file_id: null,
    drawing_file_id: null,
    quantity: 2,
    ...overrides,
  };
}

function makeFile(overrides: Partial<JobFileRecord> = {}): JobFileRecord {
  return {
    id: "file-1",
    job_id: "job-1",
    storage_bucket: "job-files",
    storage_path: "job-1/file.step",
    original_name: "optic-bracket.step",
    file_kind: "cad",
    ...overrides,
  };
}

describe("runHybridExtraction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives fallback extraction details from the available CAD filename", async () => {
    const result = await runHybridExtraction({
      part: makePart(),
      cadFile: makeFile({
        original_name: "optic-bracket_lower.step",
      }),
      drawingFile: null,
    });

    expect(result).toEqual({
      partId: "part-1",
      description: "Optic Bracket Lower",
      partNumber: "OPTIC-BRACKET_LOWER",
      revision: null,
      extractedDescriptionRaw: {
        value: "Optic Bracket Lower",
        confidence: 0.2,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
      },
      extractedPartNumberRaw: {
        value: "OPTIC-BRACKET_LOWER",
        confidence: 0.2,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
      },
      extractedRevisionRaw: {
        value: null,
        confidence: 0.05,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
      },
      extractedFinishRaw: {
        value: null,
        confidence: 0.05,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
      },
      quoteDescription: "Optic Bracket Lower",
      quoteFinish: null,
      reviewFields: ["description", "partNumber", "revision", "material", "finish"],
      material: {
        raw: null,
        normalized: null,
        confidence: 0.15,
        reviewNeeded: true,
        reasons: ["regex_fit"],
      },
      finish: {
        raw: null,
        normalized: null,
        confidence: 0.1,
        reviewNeeded: true,
        reasons: ["regex_fit"],
      },
      generalTolerance: {
        raw: null,
        confidence: 0.1,
      },
      tightestTolerance: {
        raw: null,
        valueInch: null,
        confidence: 0.1,
      },
      notes: [],
      threads: [],
      evidence: [
        {
          field: "description",
          page: 1,
          snippet: "Optic Bracket Lower",
          confidence: 0.2,
          reasons: ["regex_fit"],
        },
      ],
      warnings: [
        "Unable to extract text from the drawing PDF. Review extracted fields manually.",
        "No PDF drawing was attached. Material, finish, and tolerance values require review.",
      ],
      debugCandidates: {},
      status: "needs_review",
    });
  });

  it("prefers the drawing filename when present and raises confidence scores", async () => {
    const result = await runHybridExtraction({
      part: makePart(),
      cadFile: makeFile(),
      drawingFile: makeFile({
        id: "file-2",
        original_name: "client-widget_rev-a.pdf",
        file_kind: "drawing",
      }),
    });

    expect(result.description).toBe("Client Widget Rev A");
    expect(result.partNumber).toBe("CLIENT-WIDGET_REV-A");
    expect(result.material.confidence).toBe(0.35);
    expect(result.finish.confidence).toBe(0.25);
    expect(result.tightestTolerance.confidence).toBe(0.25);
    expect(result.warnings).toContain("Unable to extract text from the drawing PDF. Review extracted fields manually.");
    expect(result.reviewFields).toContain("partNumber");
  });

  it("filters unsupported review fields and falls back quote-facing values", async () => {
    vi.spyOn(pdfDrawing, "inferDrawingSignalsFromPdf").mockReturnValue({
      description: {
        value: "Widget Clamp",
        confidence: 0.92,
        reviewNeeded: false,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "Widget Clamp",
      },
      partNumber: {
        value: "1000-00001",
        confidence: 0.95,
        reviewNeeded: false,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "1000-00001",
      },
      revision: {
        value: "A",
        confidence: 0.9,
        reviewNeeded: false,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "A",
      },
      material: {
        value: "6061-T6",
        confidence: 0.88,
        reviewNeeded: false,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "6061-T6",
      },
      finish: {
        value: "Black Oxide",
        confidence: 0.86,
        reviewNeeded: true,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "Black Oxide",
      },
      process: {
        value: "Grind",
        confidence: 0.51,
        reviewNeeded: true,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "Grind",
      },
      generalTolerance: null,
      tightestTolerance: null,
      quoteDescription: null,
      quoteFinish: null,
      reviewFields: ["description", "process", "finish"],
      notes: [],
      threads: [],
      evidence: [],
      warnings: [],
      debugCandidates: {},
    });

    const result = await runHybridExtraction({
      part: makePart(),
      cadFile: makeFile(),
      drawingFile: makeFile({
        id: "file-2",
        original_name: "widget-clamp.pdf",
        file_kind: "drawing",
      }),
    });

    expect(result.quoteDescription).toBe("Widget Clamp");
    expect(result.quoteFinish).toBe("Black Oxide");
    expect(result.finish.normalized).toBe("Black Oxide");
    expect(result.reviewFields).toEqual(["description", "finish"]);
  });
});
