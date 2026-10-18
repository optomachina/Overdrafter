// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFileRecord, PartRecord, WorkerConfig } from "../types";
import * as pdfDrawing from "./pdfDrawing";
import { MODEL_FALLBACK_PROMPT_VERSION } from "./modelFallback";
import { runHybridExtraction } from "./hybridExtraction";
import { buildStoredExtractionPayload, summarizeExtractionOutcome } from "./sharedResult";
import { selectToleranceTier } from "../adapters/xometry";
import { ExportControlExtractionDeniedError, ExportControlLookupError } from "../exportControl";

// The Xometry adapter is imported only for the pure selectToleranceTier function. Its browser
// launchers are never called in this file, so they are stubbed instead of loaded.
vi.mock("camoufox-js", () => ({ Camoufox: vi.fn(), launchOptions: vi.fn() }));
vi.mock("patchright", () => ({ chromium: { launch: vi.fn(), launchPersistentContext: vi.fn() } }));
vi.mock("playwright", () => ({
  chromium: { launch: vi.fn(), launchPersistentContext: vi.fn() },
  firefox: { launch: vi.fn(), launchPersistentContext: vi.fn() },
}));
vi.mock("../camoufoxAssets.js", () => ({ assertCamoufoxAssetsPresent: vi.fn() }));
vi.mock("../camoufoxPersistentContext.js", () => ({ launchPersistentCamoufox: vi.fn() }));

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
    pricingModelEnabled: false,
    pricingModelMinConfidence: 0.7,
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
      modelUsage: null,
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
        config: makeConfig({
          openAiApiKey: null,
          anthropicApiKey: "test-anthropic-key",
          openRouterApiKey: null,
          drawingExtractionModel: "claude-sonnet-4-6",
        }),
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
        config: makeConfig({
          openAiApiKey: null,
          anthropicApiKey: "test-anthropic-key",
          openRouterApiKey: null,
          drawingExtractionModel: "claude-sonnet-4-6",
        }),
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

    const incompatibleResult = await runHybridExtraction(
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
        config: makeConfig({
          drawingExtractionModel: "claude-sonnet-4-6",
          openAiApiKey: "test-openai-key",
          anthropicApiKey: null,
          openRouterApiKey: null,
        }),
      },
      { extractWithModel },
    );

    expect(extractWithModel).toHaveBeenCalledTimes(1);
    expect(incompatibleResult.modelFallbackUsed).toBe(false);
  });

  // OVD-723: the export-control guard reaches the model extractor, and an
  // export-control denial or failed lookup stops extraction instead of
  // degrading to parser-only output with a warning.
  it("passes the export-control guard through and rethrows an export-control stop", async () => {
    const input = {
      part: makePart(),
      cadFile: makeFile(),
      drawingFile: makeFile({ id: "file-2", original_name: "widget-clamp.pdf", file_kind: "drawing" }),
      drawingPath: "/tmp/widget-clamp.pdf",
      runDir: "/tmp",
      previewPagePath: "/tmp/drawing-page-1.png",
      config: makeConfig(),
      forceModelFallback: true,
    };
    const beforeModelAttempt = vi.fn(async () => undefined);
    const seen = vi.fn().mockResolvedValue(null);
    await runHybridExtraction({ ...input, beforeModelAttempt }, { extractWithModel: seen });
    expect(seen.mock.calls[0][0].beforeModelAttempt).toBe(beforeModelAttempt);

    for (const stop of [new ExportControlExtractionDeniedError("export_review_pending"), new ExportControlLookupError("extraction")]) {
      await expect(
        runHybridExtraction({ ...input, beforeModelAttempt }, { extractWithModel: vi.fn().mockRejectedValue(stop) }),
      ).rejects.toBe(stop);
    }

    // Any other model failure still degrades to a warning.
    const degraded = await runHybridExtraction(input, { extractWithModel: vi.fn().mockRejectedValue(new Error("timeout")) });
    expect(degraded.warnings.join(" ")).toContain("Model fallback failed");
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

describe("drawing tolerance units through the stored extraction (OVD-976)", () => {
  // supabase/migrations/20260815100000_add_xometry_beta_dispatch_permits.sql denies the Xometry
  // beta permit for a NULL tolerance or one below 0.005 in (xometry_beta_standard_tolerance_required).
  // That SQL function cannot be imported here, so its documented threshold is restated.
  const BETA_MINIMUM_TOLERANCE_INCH = 0.005;

  async function storedTolerances(lines: string[]) {
    const extraction = await runHybridExtraction({
      part: makePart({ cad_file_id: "file-1", drawing_file_id: "file-2" }),
      cadFile: makeFile(),
      drawingFile: makeFile({ id: "file-2", original_name: "probe.pdf", file_kind: "drawing" }),
      pdfText: {
        pageCount: 1,
        pageCountKnown: true,
        drawingFullyRead: true,
        ocr: false,
        pages: [{ page: 1, text: ["MATERIAL 6061-T6", "DWG. NO. 1000-1 REV A", ...lines].join("\n") }],
      } as never,
    });
    return {
      extraction,
      stored: buildStoredExtractionPayload(extraction, 1, "test") as {
        tolerances: {
          tightest: string | null;
          valueInch: number | null;
          unit?: string | null;
          drawingUnits?: string | null;
        };
      },
    };
  }

  it("never lets a metric +/-0.1 mm drawing reach the looser tier or pass the beta gate as >= 0.005", async () => {
    const { stored } = await storedTolerances(["DIMENSIONS ARE IN MILLIMETERS", "TOLERANCES ±0.1 mm"]);
    const valueInch = stored.tolerances.valueInch;

    expect(valueInch).toBeCloseTo(0.003937, 6);
    expect(selectToleranceTier(valueInch).tier).toBe("tighter");
    expect(valueInch !== null && valueInch >= BETA_MINIMUM_TOLERANCE_INCH).toBe(false);
    expect(stored.tolerances).toMatchObject({ tightest: "±0.1 mm", unit: "mm", drawingUnits: "metric" });
  });

  it("stores a bare +/-0.1 on a millimeter drawing as converted inches, never 0.1", async () => {
    const { stored } = await storedTolerances(["DIMENSIONS IN MM", "UNLESS OTHERWISE SPECIFIED TOLERANCES ±0.1"]);

    expect(stored.tolerances.valueInch).not.toBe(0.1);
    expect(selectToleranceTier(stored.tolerances.valueInch).tier).not.toBe("looser");
  });

  it("stores null with the raw text when units cannot be resolved, so the beta gate blocks it", async () => {
    const { extraction, stored } = await storedTolerances(["TOLERANCES ±1"]);

    expect(stored.tolerances).toMatchObject({ tightest: "±1", valueInch: null, unit: "unknown" });
    expect(selectToleranceTier(stored.tolerances.valueInch).tier).toBeNull();
    expect(extraction.tightestTolerance.valueInch).toBeNull();
    expect(summarizeExtractionOutcome(extraction).missingFields).toContain("tightestToleranceInch");
  });

  it("keeps inch drawings unchanged", async () => {
    const { stored, extraction } = await storedTolerances(["DIMENSIONS ARE IN INCHES", "THREE PLACE DECIMAL +.005"]);

    expect(stored.tolerances).toMatchObject({ tightest: "±0.005", valueInch: 0.005, unit: "in" });
    expect(summarizeExtractionOutcome(extraction).missingFields).not.toContain("tightestToleranceInch");
  });

  it("stores no tolerance fields as numbers when only an angular tolerance is present", async () => {
    const { stored } = await storedTolerances(["ANGULAR ±.005°"]);

    expect(stored.tolerances.tightest).toBeNull();
    expect(stored.tolerances.valueInch).toBeNull();
  });
});
