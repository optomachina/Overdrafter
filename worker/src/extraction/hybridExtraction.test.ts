// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFileRecord, PartRecord, WorkerConfig } from "../types";
import * as pdfDrawing from "./pdfDrawing";
import { MODEL_FALLBACK_PROMPT_VERSION } from "./modelFallback";
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

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "simulate",
    workerName: "worker-1",
    pollIntervalMs: 5000,
    httpHost: "127.0.0.1",
    httpPort: 8080,
    workerTempDir: "/tmp/overdrafter-tests",
    artifactBucket: "quote-artifacts",
    playwrightHeadless: true,
    playwrightCaptureTrace: false,
    browserTimeoutMs: 30000,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: true,
    xometryStorageStatePath: null,
    xometryStorageStateJson: null,
    xometryUserDataDir: null,
    xometryBrowserChannel: null,
    xometryProfileLockWaitMs: 0,
    openAiApiKey: "test-openai-key",
    drawingExtractionModel: "gpt-5.4",
    drawingExtractionEnableModelFallback: true,
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
      modelFallbackUsed: false,
      modelName: null,
      modelPromptVersion: null,
      fieldSelections: {
        description: "parser",
        partNumber: "parser",
        revision: "parser",
        material: "parser",
        finish: "parser",
        process: "parser",
      },
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
        "Description extraction needs review.",
        "PartNumber extraction needs review.",
        "Revision extraction needs review.",
        "Material extraction needs review.",
        "Finish extraction needs review.",
        "Process extraction needs review.",
      ],
      debugCandidates: {},
      modelCandidates: {},
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
    expect(result.reviewFields).toEqual(["finish"]);
  });

  it("does not call the model when parser output is strong and label-backed", async () => {
    const extractWithModel = vi.fn();

    vi.spyOn(pdfDrawing, "inferDrawingSignalsFromPdf").mockReturnValue({
      description: {
        value: "Widget Clamp",
        confidence: 0.95,
        reviewNeeded: false,
        reasons: ["label_match", "spatial_match"],
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
      reviewFields: ["process"],
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
    });

    const result = await runHybridExtraction(
      {
        part: makePart(),
        cadFile: makeFile(),
        drawingFile: makeFile({
          id: "file-2",
          original_name: "widget-clamp.pdf",
          file_kind: "drawing",
        }),
        drawingPath: "/tmp/widget-clamp.pdf",
        runDir: "/tmp",
        previewPagePath: "/tmp/drawing-page-1.png",
        config: makeConfig(),
      },
      {
        extractWithModel,
      },
    );

    expect(extractWithModel).not.toHaveBeenCalled();
    expect(result.modelFallbackUsed).toBe(false);
    expect(result.status).toBe("approved");
  });

  it("uses the model to rescue a weak revision extraction", async () => {
    vi.spyOn(pdfDrawing, "inferDrawingSignalsFromPdf").mockReturnValue({
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
        confidence: 0.95,
        reviewNeeded: false,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "1000-00001",
      },
      revision: {
        value: "S",
        confidence: 0.31,
        reviewNeeded: true,
        reasons: ["regex_fit"],
        sourceRegion: null,
        snippet: "S",
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
        reviewNeeded: false,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "Black Oxide",
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
      reviewFields: ["revision", "process"],
      notes: [],
      threads: [],
      evidence: [],
      warnings: ["Revision extraction needs review."],
      debugCandidates: {
        description: [],
        partNumber: [],
        revision: [
          {
            value: "S",
            page: 1,
            line: 10,
            columnStart: 90,
            columnEnd: 90,
            label: null,
            score: 1.2,
            reasons: ["regex_fit"],
            snippet: "S",
          },
          {
            value: "02",
            page: 1,
            line: 11,
            columnStart: 90,
            columnEnd: 91,
            label: "REV",
            score: 1.05,
            reasons: ["label_match"],
            snippet: "02",
          },
        ],
        material: [],
        finish: [],
        process: [],
      },
    });

    const extractWithModel = vi.fn().mockResolvedValue({
      modelName: "gpt-5.4",
      promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
      usedTitleBlockCrop: true,
      usedFullPage: false,
      attempts: [
        {
          attempt: "title_block_crop",
          titleBlockSufficient: true,
          fields: {
            description: {
              value: "Widget Clamp",
              confidence: 0.97,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            partNumber: {
              value: "1000-00001",
              confidence: 0.98,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            revision: {
              value: "02",
              confidence: 0.95,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            material: {
              value: "6061-T6",
              confidence: 0.93,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            finish: {
              value: "Black Oxide",
              confidence: 0.92,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            process: {
              value: null,
              confidence: 0.22,
              fieldSource: "unknown",
              reasons: [],
            },
          },
        },
      ],
      fields: {
        description: {
          value: "Widget Clamp",
          confidence: 0.97,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        partNumber: {
          value: "1000-00001",
          confidence: 0.98,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        revision: {
          value: "02",
          confidence: 0.95,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        material: {
          value: "6061-T6",
          confidence: 0.93,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        finish: {
          value: "Black Oxide",
          confidence: 0.92,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        process: {
          value: null,
          confidence: 0.22,
          fieldSource: "unknown",
          reasons: [],
        },
      },
    });

    const result = await runHybridExtraction(
      {
        part: makePart(),
        cadFile: makeFile(),
        drawingFile: makeFile({
          id: "file-2",
          original_name: "widget-clamp.pdf",
          file_kind: "drawing",
        }),
        drawingPath: "/tmp/widget-clamp.pdf",
        runDir: "/tmp",
        previewPagePath: "/tmp/drawing-page-1.png",
        config: makeConfig(),
      },
      {
        extractWithModel,
      },
    );

    expect(extractWithModel).toHaveBeenCalledTimes(1);
    expect(result.revision).toBe("02");
    expect(result.modelFallbackUsed).toBe(true);
    expect(result.modelName).toBe("gpt-5.4");
    expect(result.fieldSelections?.revision).toBe("model");
    expect(result.extractedRevisionRaw.reasons).toContain("model_fallback");
    expect(result.reviewFields).not.toContain("revision");
  });

  it("fails closed when parser and model disagree without a clear winner", async () => {
    vi.spyOn(pdfDrawing, "inferDrawingSignalsFromPdf").mockReturnValue({
      description: {
        value: "Widget Clamp",
        confidence: 0.74,
        reviewNeeded: true,
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
        value: "02",
        confidence: 0.93,
        reviewNeeded: false,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "02",
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
        reviewNeeded: false,
        reasons: ["label_match"],
        sourceRegion: null,
        snippet: "Black Oxide",
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
      reviewFields: ["description", "process"],
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
    });

    const extractWithModel = vi.fn().mockResolvedValue({
      modelName: "gpt-5.4",
      promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
      usedTitleBlockCrop: true,
      usedFullPage: false,
      attempts: [
        {
          attempt: "title_block_crop",
          titleBlockSufficient: true,
          fields: {
            description: {
              value: "Widget Clamper",
              confidence: 0.81,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            partNumber: {
              value: "1000-00001",
              confidence: 0.98,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            revision: {
              value: "02",
              confidence: 0.96,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            material: {
              value: "6061-T6",
              confidence: 0.92,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            finish: {
              value: "Black Oxide",
              confidence: 0.91,
              fieldSource: "title_block",
              reasons: ["label_match"],
            },
            process: {
              value: null,
              confidence: 0.2,
              fieldSource: "unknown",
              reasons: [],
            },
          },
        },
      ],
      fields: {
        description: {
          value: "Widget Clamper",
          confidence: 0.81,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        partNumber: {
          value: "1000-00001",
          confidence: 0.98,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        revision: {
          value: "02",
          confidence: 0.96,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        material: {
          value: "6061-T6",
          confidence: 0.92,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        finish: {
          value: "Black Oxide",
          confidence: 0.91,
          fieldSource: "title_block",
          reasons: ["label_match"],
        },
        process: {
          value: null,
          confidence: 0.2,
          fieldSource: "unknown",
          reasons: [],
        },
      },
    });

    const result = await runHybridExtraction(
      {
        part: makePart(),
        cadFile: makeFile(),
        drawingFile: makeFile({
          id: "file-2",
          original_name: "widget-clamp.pdf",
          file_kind: "drawing",
        }),
        drawingPath: "/tmp/widget-clamp.pdf",
        runDir: "/tmp",
        previewPagePath: "/tmp/drawing-page-1.png",
        config: makeConfig(),
      },
      {
        extractWithModel,
      },
    );

    expect(result.description).toBe("Widget Clamp");
    expect(result.fieldSelections?.description).toBe("review");
    expect(result.reviewFields).toContain("description");
    expect(result.warnings).toContain("Description parser/model disagreement needs review.");
  });
});
