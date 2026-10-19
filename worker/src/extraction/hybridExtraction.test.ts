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
  const D = "DIMENSIONS ARE IN INCHES";
  const M = "DIMENSIONS IN MM";
  const mm = (value: number) => value / 25.4;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function storedFromPages(pages: string[][]) {
    const extraction = await runHybridExtraction({
      part: makePart({ cad_file_id: "file-1", drawing_file_id: "file-2" }),
      cadFile: makeFile(),
      drawingFile: makeFile({ id: "file-2", original_name: "probe.pdf", file_kind: "drawing" }),
      pdfText: {
        pageCount: pages.length,
        pageCountKnown: true,
        drawingFullyRead: true,
        ocr: false,
        pages: pages.map((lines, index) => ({
          page: index + 1,
          text: (index === 0 ? ["MATERIAL 6061-T6", "DWG. NO. 1000-1 REV A", ...lines] : lines).join("\n"),
        })),
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
      fullText: pages.map((lines, index) => (index === 0 ? ["MATERIAL 6061-T6", "DWG. NO. 1000-1 REV A", ...lines] : lines).join("\n")).join("\n"),
    };
  }

  const storedTolerances = (lines: string[]) => storedFromPages([lines]);

  /**
   * The parser on main before OVD-976 (smallest number after a plus-minus sign or a decimal-place
   * phrase, re-parsed by hybridExtraction), used as the "never looser than before" oracle.
   */
  function baseValueInch(text: string): number | null {
    const parsed = [...text.matchAll(/(?:\+\/-|±)\s*((?:\d+(?:\.\d+)?|\.\d+))/g)]
      .map((match) => Number.parseFloat(match[1] ?? ""))
      .filter((value) => Number.isFinite(value));
    const upper = text.toUpperCase();
    for (const phrase of ["TWO PLACE DECIMAL", "THREE PLACE DECIMAL", "FOUR PLACE DECIMAL"]) {
      let index = upper.indexOf(phrase);
      while (index >= 0) {
        const value = /^[\s+#]*([0-9.]*\d[0-9.]*)/.exec(text.slice(index + phrase.length, index + phrase.length + 24))?.[1];
        if (value !== undefined && Number.isFinite(Number.parseFloat(value))) {
          parsed.push(Number.parseFloat(value));
        }
        index = upper.indexOf(phrase, index + phrase.length);
      }
    }
    parsed.sort((left, right) => left - right);
    return parsed.length === 0 ? null : Number.parseFloat(`±${parsed[0]}`.replace(/[^0-9.]/g, "")) || null;
  }

  const tierRank = (tier: string | null) => ["tighter", "standard", "looser"].indexOf(tier ?? "");

  it("never lets a metric +/-0.1 mm drawing reach the looser tier or pass the beta gate as >= 0.005", async () => {
    const { stored } = await storedTolerances(["DIMENSIONS ARE IN MILLIMETERS", "TOLERANCES ±0.1 mm"]);

    expect(stored.tolerances).toMatchObject({ tightest: "±0.1 mm", valueInch: 0.0039, unit: "mm", drawingUnits: "metric" });
    expect(selectToleranceTier(stored.tolerances.valueInch).tier).toBe("tighter");
    expect((stored.tolerances.valueInch ?? 0) >= BETA_MINIMUM_TOLERANCE_INCH).toBe(false);
  });

  it("stores null with the raw text when units cannot be resolved, so the beta gate blocks it", async () => {
    const { extraction, stored } = await storedTolerances(["TOLERANCES ±1"]);

    expect(stored.tolerances).toMatchObject({ tightest: "±1", valueInch: null, unit: "unknown" });
    expect(selectToleranceTier(stored.tolerances.valueInch).tier).toBeNull();
    expect(extraction.tightestTolerance.valueInch).toBeNull();
    expect(summarizeExtractionOutcome(extraction).missingFields).toContain("tightestToleranceInch");
  });

  it("stores no tolerance when only an angular tolerance is present", async () => {
    const { stored } = await storedTolerances(["ANGULAR ±.005°"]);

    expect(stored.tolerances.tightest).toBeNull();
    expect(stored.tolerances.valueInch).toBeNull();
  });

  it("never stores a zero, negative or non-finite valueInch", async () => {
    const { extraction } = await storedTolerances(["TOLERANCES ±.005"]);
    for (const bad of [0, -0.005, Number.NaN, Number.POSITIVE_INFINITY]) {
      const stored = buildStoredExtractionPayload(
        { ...extraction, tightestTolerance: { ...extraction.tightestTolerance, valueInch: bad } },
        1,
        "test",
      ) as { tolerances: { valueInch: number | null } };
      expect(stored.tolerances.valueInch).toBeNull();
    }
  });

  it("never passes a zero value from the parser through to the stored extraction", async () => {
    const original = pdfDrawing.inferDrawingSignalsFromPdf;
    vi.spyOn(pdfDrawing, "inferDrawingSignalsFromPdf").mockImplementation((input) => ({
      ...original(input),
      tightestTolerance: "±0",
      tightestToleranceValueInch: 0,
      tightestToleranceUnit: "in",
    }));
    const { stored, extraction } = await storedTolerances(["TOLERANCES ±.005"]);
    expect(extraction.tightestTolerance.valueInch).toBeNull();
    expect(stored.tolerances).toMatchObject({ valueInch: null, unit: "unknown" });
    expect(summarizeExtractionOutcome(extraction).missingFields).toContain("tightestToleranceInch");
  });

  // Explicit-inch drawings and inch-suffixed values store exactly what main stored.
  it.each([
    [[D, ".X ±.1", ".XX ±.01", ".XXX ±.005"], 0.005],
    [[D, "UNLESS OTHERWISE SPECIFIED", ".X ±.1", ".XX ±.01", ".XXX ±.005"], 0.005],
    [["SCALE: FULL  UNITS: INCH", ".X ±.1  .XXX ±.005"], 0.005],
    [[D, "TOLERANCES ±.005", "MIL-A-8625 TYPE II CL 2"], 0.005],
    [[D, "MARK PER ±.005 MIL-STD-130"], 0.005],
    [["MARK PER ±.005 MIL-STD-130"], 0.005],
    [[D, "TOLERANCES ±.005", "MM-1234 FIXTURE"], 0.005],
    [["TOLERANCES ±.005", "MM-1234 FIXTURE"], 0.005],
    [[D, "SURFACE Ra 0.8 µm", "TOLERANCES ±.005"], 0.005],
    [[D, "ITEM 3  6 MM DOWEL PIN", "TOLERANCES ±.005"], 0.005],
    [[D, "REV B 2024-05-12 CHANGED 10mm TO 12mm", "TOLERANCES ±.005"], 0.005],
    [[D, "USE METRIC HARDWARE", "TOLERANCES ±.005"], 0.005],
    [[D, "SHEET 279 X 216 MM", ".XX ±.01  .XXX ±.005"], 0.005],
    [[D, "Ø12mm THRU", "TOLERANCES ±.005"], 0.005],
    [[D, "DATE YYYY-MM-DD", "TOLERANCES ±.005"], 0.005],
    [[D, "TWO PLACE DECIMAL ±.01", "THREE PLACE DECIMAL ±.005"], 0.005],
    [[D, "THREE PLACE DECIMAL +.005"], 0.005],
    [[D, "TOLERANCES ±.010"], 0.01],
    [[D, "BORE ±.0005"], 0.0005],
    [["DIMENSIONS IN IN", "BORE ±.002"], 0.002],
    [["UNITS: IN", "TOLERANCES ±0.25"], 0.25],
    [["TOLERANCES ±.005"], 0.005],
    [["TOLERANCES ±0.005 IN"], 0.005],
    [['BORE ±.002"'], 0.002],
    [["BORE ±.002 INCH"], 0.002],
    [[D, "BORE ±.002 in"], 0.002],
    [[D, "FINISH PER MIL-A-8625 TYPE II", "TOLERANCES ±.005"], 0.005],
  ] as Array<[string[], number]>)("inch drawing %j stores the same value as before (%s)", async (lines, valueInch) => {
    const { stored, fullText } = await storedTolerances(lines);
    expect(baseValueInch(fullText)).toBe(valueInch);
    expect(stored.tolerances).toMatchObject({ valueInch, unit: "in" });
  });

  /*
   * The adversarial corpus of the OVD-976 reviews: the first review's H cases, the author's X cases
   * and the second review's N cases. Each row states the stored valueInch it must produce (null means
   * the gate must block it and the user enters the tolerance). truth is the plain-text tolerance in
   * inches ("amb" when the text does not make it plain). oos marks callouts that are outside this
   * issue (unilateral, GD&T, fractions without a declaration) and are held only to "never looser
   * than before".
   */
  type CorpusRow = [id: string, truth: number | "amb", expected: number | null, pages: string[][], oos?: "oos"];
  const corpus: CorpusRow[] = [
    ["H01 glued mm only", mm(0.05), null, [["Ø12mm THRU", "TOLERANCES ±0.05"]]],
    ["H02 IN ALL DIRECTIONS", mm(0.1), 0.0039, [[M, "PROFILE ±0.1 IN ALL DIRECTIONS"]]],
    ["H03 unrelated bracket", 0.00079, 0.0007, [[M, "BORE ±0.02 mm (±0.1 BEFORE PLATING)"]]],
    ["H04 wrong bracket conversion", mm(0.1), 0.0039, [["TOLERANCES ±0.1 mm [±.04 in]"]]],
    ["H05 INCH note, phrase ±", mm(0.1), 0.0039, [["DIMENSIONS IN MILLIMETERS", "NOTE: 1 INCH = 25.4", "TWO PLACE DECIMAL ±0.1"]]],
    ["H06 INCH note, phrase +", mm(0.1), 0.0039, [["DIMENSIONS IN MILLIMETERS", "NOTE: 1 INCH = 25.4", "TWO PLACE DECIMAL +0.1"]]],
    ["H07 decimal comma mm", mm(0.05), null, [[M, "TOLERANCES ±0,05"]]],
    ["H08 decimal comma", "amb", null, [["TOLERANCES ±0,1"]]],
    ["H09 fraction inch", 1 / 64, 0.0156, [[D, "FRACTIONS ±1/64"]], "oos"],
    ["H10 fraction undeclared", 1 / 64, null, [["FRACTIONS ±1/64"]]],
    ["H11 bare micro sign", mm(0.005), 0.0001, [[M, "BORE ±5μ"]]],
    ["H12 +- sign", 0.002, 0.002, [[D, "BORE +-.002", "GENERAL ±.010"]], "oos"],
    ["H13 unicode minus", 0.002, 0.002, [[D, "BORE +/−.002", "GENERAL ±.010"]], "oos"],
    ["H14 unilateral", 0.002, 0.01, [[D, "BORE +.000/-.002", "GENERAL ±.010"]], "oos"],
    ["H15 GD&T position", 0.002, 0.01, [[D, "POSITION ⌖ Ø.002 Ⓜ A B C", "GENERAL ±.010"]], "oos"],
    ["H16 mm far from value", mm(0.1), null, [["TOLERANCES ±0.1 (ALL FEATURES) mm"]]],
    ["H17 date template", 0.005, 0.005, [["DATE YYYY-MM-DD", "TOLERANCES ±.005"]]],
    ["H18 metric hardware", 0.005, 0.005, [[D, "USE METRIC HARDWARE", "TOLERANCES ±.005"]]],
    ["H19 arcminutes", 0.005, 0.005, [[D, "BEND ±30'", "TOLERANCES ±.005"]]],
    ["H20 percent only", "amb", null, [[D, "SPRING RATE ±10%"]]],
    ["H21 mm + bare 3dp", 0.003, 0.003, [["TOLERANCES ±0.1 mm", "BORE ±.003"]]],
    ["H22 inch-first dual", 0.004, 0.0039, [["TOLERANCES ±.004 [±0.1 mm]"]]],
    ["H23 millimetres", mm(0.05), 0.0019, [["ALL DIMENSIONS IN MILLIMETRES", "TOLERANCE ±0.05"]]],
    ["H24 UNIT: mm", mm(0.2), 0.0078, [["UNIT: mm", "TOLERANCE ±0.2"]]],
    ["H25 X.XX block undeclared", 0.005, null, [["X.XX ±.01  X.XXX ±.005"]]],
    ["H26 dual decl, mm + bare", "amb", 0.0039, [["DIMENSIONS IN INCHES [MILLIMETERS]", "TOLERANCES ±0.1 mm", "GENERAL ±.3"]]],
    ["H27 dual decl, µm + bare", "amb", 0.0009, [["DIMENSIONS IN INCHES [MILLIMETERS]", "BORE ±25 µm", "GENERAL ±.3"]]],
    ["H28 glued mm + bracket", mm(0.05), 0.0019, [["BORE ±0.05mm [±0.5]"]]],
    ["H29 angular same line", 0.01, 0.01, [[D, "ANGULAR ±0.5  LINEAR ±.010"]]],
    ["H30 ANGLES label", 0.01, 0.01, [[D, "ANGLES UNLESS NOTED ±.5", "LINEAR ±.010"]]],
    ["H31 mils", 0.002, 0.002, [["FLATNESS ±2 mils"]]],
    ["H32 µin without plus-minus", 0.002, 0.002, [[D, "RA 32 µin", "BORE ±.002"]]],
    ["H33 per length", "amb", null, [["STRAIGHTNESS ±0.1 mm/m"]]],
    ["H34 MM part number", 0.005, 0.005, [["PART NO MM-1234", "TOLERANCES ±.005"]]],
    ["H35 inch mark on mm drawing", 0.001, 0.001, [[M, 'BORE ±.001"']]],
    ["X01 consistent dual", mm(0.1), 0.0039, [["TOLERANCES ±0.1 mm [±.004 in]"]]],
    ["X02 consistent dual bare", mm(0.1), 0.0039, [["TOLERANCES ±0.1 mm [±.004]"]]],
    ["X03 0.126 mm", mm(0.126), 0.0049, [["TOLERANCES ±0.126 mm"]]],
    ["X04 1 µm", mm(0.001), null, [["TOLERANCES ±1 µm"]]],
    ["X05 date MM/DD/YY", 0.005, 0.005, [["DATE MM/DD/YY", "TOLERANCES ±.005"]]],
    ["X06 UNITS: MM", mm(0.2), 0.0078, [["UNITS: MM", "TOLERANCES ±0.2"]]],
    ["X07 12 MM incidental", mm(0.2), null, [["OVERALL 12 MM", "TOLERANCES ±0.2"]]],
    ["X08 zero", "amb", null, [[D, "TOLERANCES ±0.000"]]],
    ["X09 microinch", 0.000032, null, [[D, "FINISH ±32 µin", "BORE ±.002"]]],
    ["X10 IN on mm drawing", 0.005, null, [[M, "BORE ±.005 IN"]]],
    ["X11 phrase decimal comma", "amb", null, [[D, "TWO PLACE DECIMAL +0,1"]]],
    ["X12 inch-first dual, inch dwg", 0.004, 0.0039, [[D, "TOLERANCES ±.004 [±0.1 mm]"]]],
    ["X13 inconsistent bracket", mm(0.02), null, [["TOLERANCES ±0.02 mm [±.01]"]]],
    ["N01 DIMENSIONS [mm]", mm(0.05), 0.0019, [["DIMENSIONS [mm]", "TOLERANCES ±0.05"]]],
    ["N02 UNITS [MM]", mm(0.02), 0.0007, [["UNITS [MM]", "GENERAL TOL ±0.02"]]],
    ["N03 DIMENSIONS IN [mm]", mm(0.05), 0.0019, [["DIMENSIONS IN [mm]", "TOLERANCES ±0.05"]]],
    ["N04 ALL DIMENSIONS (mm)", mm(0.05), 0.0019, [["ALL DIMENSIONS (mm)", "TOLERANCES ±0.05"]]],
    ["N05 UNITS - MM", mm(0.05), 0.0019, [["UNITS - MM", "TOLERANCES ±0.05"]]],
    ["N06 suffix [mm]", mm(0.05), 0.0019, [["BORE ±0.05 [mm]"]]],
    ["N07 suffix (mm)", mm(0.05), 0.0019, [["BORE ±0.05 (mm)"]]],
    ["N08 OCR rnm", mm(0.05), 0.0019, [["DIMENSIONS IN rnm", "TOLERANCES ±0.05"]]],
    ["N09 Cyrillic мм", mm(0.05), 0.0019, [["DIMENSIONS IN мм", "TOLERANCES ±0.05"]]],
    ["N10 Greek ΜΜ", mm(0.05), 0.0019, [["DIMENSIONS IN ΜΜ", "TOLERANCES ±0.05"]]],
    ["N11 fullwidth ｍｍ", mm(0.05), 0.0019, [["DIMENSIONS IN ｍｍ", "TOLERANCES ±0.05"]]],
    ["N12 suffix rnm", mm(0.05), 0.0019, [["BORE ±0.05 rnm"]]],
    ["N13 suffix мм", mm(0.05), 0.0019, [["BORE ±0.05 мм"]]],
    ["N14 fullwidth digits", mm(0.05), 0.0019, [["BORE ±０.０５ mm"]]],
    ["N15 DIN 7168", mm(0.05), 0.0019, [["GENERAL TOLERANCES DIN 7168-m", "BORE ±0.05"]]],
    ["N16 JIS B 0405", mm(0.05), 0.0019, [["GENERAL TOLERANCES JIS B 0405-m", "BORE ±0.05"]]],
    ["N17 EN 22768", mm(0.05), 0.0019, [["GENERAL TOLERANCES EN 22768-m", "BORE ±0.05"]]],
    ["N18 ISO 2768-mK", mm(0.05), 0.0019, [["TOLERANCES IN ACCORDANCE WITH ISO 2768-mK", "BORE ±0.05"]]],
    ["N19 German Maße in mm", mm(0.05), 0.0019, [["Maße in mm", "BORE ±0.05"]]],
    ["N20 UNIT mm", mm(0.05), 0.0019, [["SCALE 1:1  UNIT mm", "BORE ±0.05"]]],
    ["N21 next-line INCH", mm(0.05), 0.0019, [[M, "TOLERANCE ±0.05", "INCH EQUIVALENTS FOR REFERENCE ONLY"]]],
    ["N22 next-line IN.", mm(0.05), 0.0019, [[M, "FLATNESS ±0.05", "IN. ZONE A"]]],
    ["N23 IN at end of line, mm dwg", mm(0.05), null, [[M, "FLATNESS ±0.05 IN", "ZONE A"]]],
    ["N24 inch mark on mm dwg", "amb", 0.05, [[M, 'BORE ±0.05"']]],
    ["N25 next-line MIL", 0.005, 0.005, [[D, "TOLERANCES ±.005", "MIL-A-8625 TYPE II CL 2"]]],
    ["N26 MIL spec", 0.005, 0.005, [[D, "FINISH PER MIL-A-8625 TYPE II", "TOLERANCES ±.005"]]],
    ["N27 next-line MM part", 0.005, 0.005, [["TOLERANCES ±.005", "MM-1234 FIXTURE"]]],
    ["N28 same-line MIL-STD", 0.005, 0.005, [["MARK PER ±.005 MIL-STD-130"]]],
    ["N29 ASME block undeclared", 0.005, null, [["TOLERANCES IN ACCORDANCE WITH ASME Y14.5", ".XX ±.01  .XXX ±.005"]]],
    ["N30 ANSI block undeclared", 0.005, null, [["UNLESS OTHERWISE SPECIFIED", ".X ±.1", ".XX ±.01", ".XXX ±.005"]]],
    ["N31 ANSI block inch", 0.005, 0.005, [[D, "UNLESS OTHERWISE SPECIFIED", ".X ±.1", ".XX ±.01", ".XXX ±.005"]]],
    ["N32 UNITS: INCH", 0.005, 0.005, [["SCALE: FULL  UNITS: INCH", ".X ±.1  .XXX ±.005"]]],
    ["N33 revision mm, inch dwg", 0.005, 0.005, [[D, "REV B 2024-05-12 CHANGED 10mm TO 12mm", "TOLERANCES ±.005"]]],
    ["N34 revision mm, undeclared", 0.005, null, [["REV B CHANGED 10mm TO 12mm", ".XX ±.01  .XXX ±.005"]]],
    ["N35 sheet size MM, undeclared", 0.005, null, [["SHEET 279 X 216 MM", ".XX ±.01  .XXX ±.005"]]],
    ["N36 Ra µm, inch dwg", 0.005, 0.005, [[D, "SURFACE Ra 0.8 µm", "TOLERANCES ±.005"]]],
    ["N37 Ra µin, undeclared", 0.005, null, [["SURFACE 32 µin Ra", ".XX ±.01  .XXX ±.005"]]],
    ["N38 dowel pin MM, inch dwg", 0.005, 0.005, [[D, "ITEM 3  6 MM DOWEL PIN", "TOLERANCES ±.005"]]],
    ["N39 metric hardware, inch dwg", 0.005, 0.005, [[D, "USE METRIC HARDWARE", "TOLERANCES ±.005"]]],
    ["N40 mm decl + INCH note", mm(0.05), 0.0019, [["DIMENSIONS IN MILLIMETERS", "NOTE: 1 INCH = 25.4 MM", "TWO PLACE DECIMAL +0.05"]]],
    ["N41 decimal comma mm", mm(0.05), null, [["BORE ±0,05 mm"]]],
    ["N42 thousands comma", mm(1), null, [["BORE ±1,000 µm"]]],
    ["N43 comma list", mm(0.05), null, [["TOLERANCES ±0.1 mm, ±0,05 mm"]]],
    ["N44 list with commas", 0.005, 0.005, [[D, ".XX ±.01, .XXX ±.005"]]],
    ["N45 fraction undeclared", 0.005, null, [["FRACTIONS ±1/32  .XXX ±.005"]], "oos"],
    ["N46 scientific IN", 0.001, null, [[D, "BORE ±1e-3 IN"]]],
    ["N47 scientific", 0.005, null, [["BORE ±5E-3"]]],
    ["N48 sign then next line", mm(0.05), 0.0019, [["BORE ±", "0.05 mm"]]],
    ["N49 unit alone on next line", mm(0.05), 0.0019, [["BORE ±0.05", "mm"]]],
    ["N50 +/- then next line", 0.002, 0.002, [[D, "BORE +/-", ".002"]]],
    ["N51 superscript digits", mm(0.05), 0.0019, [["BORE ±0.⁰⁵ mm"]]],
    ["N52 minus-plus", mm(0.05), 0.0019, [["BORE ∓0.05 mm"]]],
    ["N53 fullwidth sign", mm(0.05), 0.0019, [["BORE ＋/－0.05 mm"]]],
    ["N54 spaced + / -", 0.002, 0.002, [[D, "BORE + / - .002", "GENERAL ±.010"]], "oos"],
    ["N55 asymmetric", mm(0.02), 0.0039, [[M, "Ø10 +0.05/-0.02", "GENERAL ±0.1"]], "oos"],
    ["N56 asymmetric only", mm(0.025), null, [[M, "Ø10 +0.05 -0.00"]], "oos"],
    ["N57 no plus-minus", "amb", null, [[M, "LENGTH 50 0.1 / -0.2"]]],
    ["N58 range + general", mm(0.1), 0.0039, [[M, "BORE 10.0-10.2", "GENERAL ±0.1"]]],
    ["N59 Ø and R", mm(0.05), 0.0019, [[M, "Ø12 ±0.05", "R5 ±0.1"]]],
    ["N60 Ra ±0.8 µm", mm(0.0008), null, [[M, "SURFACE Ra ±0.8 µm", "GENERAL ±0.1"]]],
    ["N61 ANGULAR DEGREES, undeclared", 0.005, null, [["ANGULAR TOLERANCE ±0.5 DEGREES", ".XX ±.01  .XXX ±.005"]]],
    ["N62 long angular label", 0.01, 0.01, [[D, "ANGULAR DIMENSIONS ±.25", "LINEAR ±.010"]]],
    ["N63 arcmin, undeclared block", 0.005, null, [["BEND ±30'", ".XX ±.01  .XXX ±.005"]]],
    // main stored null here only because it read the angle ±0°30' as 0; 0.005 is the plain truth.
    ["N64 degrees-minutes", 0.005, 0.005, [["ANGLE ±0°30'", "TOLERANCES ±.005"]]],
    ["N65 fractional degree", 0.005, 0.005, [["BEND ±1/2°", "TOLERANCES ±.005"]]],
    ["N66 GD&T position", mm(0.025), 0.0039, [[M, "POSITION ⌖ Ø0.05 Ⓜ A B C", "GENERAL ±0.1"]], "oos"],
    ["N67 per length", "amb", null, [["STRAIGHTNESS ±0.05 mm/m"]]],
    ["N68 declaration on page 2", mm(0.05), 0.0019, [["PAGE 1 OF 2", "BORE ±0.05"], ["PAGE 2 OF 2", M]]],
    ["N69 inch page + metric page", "amb", null, [[D, "TOLERANCES ±.005"], [M, "VENDOR ITEM ±0.1"]]],
    ["N70 10MM in title", mm(0.05), null, [["TITLE: SPACER, 10MM, ±0.05"]]],
    ["N71 title 3dp", 0.002, 0.002, [["TITLE: SHAFT ±.002"]]],
    ["N72 MM suffix", mm(0.05), 0.0019, [["BORE ±0.05 MM"]]],
    ["N73 millimetres suffix", mm(0.05), 0.0019, [["BORE ±0.05 millimetres"]]],
    ["N74 microns suffix", mm(0.05), 0.0019, [["BORE ±50 microns"]]],
    ["N75 UM suffix", mm(0.05), 0.0019, [["BORE ±50 UM"]]],
    ["N76 in on mm drawing", 0.002, null, [[M, "BORE ±.002 in"]]],
    ["N77 double prime", 0.05, 0.05, [["BORE ±0.05″"]]],
    ["N78 glued mm", mm(0.05), 0.0019, [["BORE +/-0.05mm"]]],
    ["N79 dual metric-first", 0.005, 0.005, [["BORE ±0.13 mm [±.005]"]]],
    ["N80 dual within 5%", mm(0.12), 0.0047, [["BORE ±0.12 mm [±.005]"]]],
    ["N81 mm callout on inch dwg", mm(0.05), 0.0019, [[D, "BORE ±0.05 mm", "GENERAL ±.010"]]],
    ["N82 ±.005", 0.005, 0.005, [[D, "BORE ±.005"]]],
    ["N83 ±.00499", 0.00499, 0.0049, [[D, "BORE ±.00499"]]],
    ["N84 ±.0050001", 0.0050001, 0.005, [[D, "BORE ±.0050001"]]],
    ["N85 ±0.127 mm", 0.005, 0.005, [["BORE ±0.127 mm"]]],
    ["N86 ±0.1270001 mm", mm(0.1270001), 0.005, [["BORE ±0.1270001 mm"]]],
    ["N87 ±0.12699 mm", mm(0.12699), 0.0049, [["BORE ±0.12699 mm"]]],
    ["N88 ±127 µm", 0.005, 0.005, [["BORE ±127 µm"]]],
    ["N89 ±126.9 µm", mm(0.1269), 0.0049, [["BORE ±126.9 µm"]]],
    ["N90 ±5 mil", 0.005, 0.005, [["BORE ±5 mil"]]],
    ["N91 ±4.99 mil", 0.00499, 0.0049, [["BORE ±4.99 mil"]]],
    ["N92 ±0.00001 in", 0.00001, null, [[D, "BORE ±0.00001"]]],
    ["N93 ±0.0001 in", 0.0001, 0.0001, [[D, "BORE ±0.0001"]]],
    ["N94 ±0.00015 in", 0.00015, 0.0001, [[D, "BORE ±0.00015"]]],
    ["N95 ±1 µm", mm(0.001), null, [["BORE ±1 µm"]]],
    ["N96 ±.00499999995", 0.00499999995, 0.0049, [[D, "BORE ±.00499999995"]]],
    ["N97 ±0.12699999999 mm", mm(0.12699999999), 0.0049, [["BORE ±0.12699999999 mm"]]],
    ["N98 ±1000000 overflows numeric(10,4)", 1000000, null, [[D, "NOTE ±1000000"]]],
    ["N99 320 digits", "amb", null, [[D, `NOTE ±${"9".repeat(320)}`]]],
    ["N100 ±1000 mm", mm(1000), 39.37, [["ENVELOPE ±1000 mm"]]],
    ["N101 zero + ±.005", 0.005, null, [[D, "DATUM ±0", "TOLERANCES ±.005"]]],
    ["N102 phrase then next line", 0.01, null, [["TWO PLACE DECIMAL", ".01"]]],
    ["N103 no unit anywhere", "amb", null, [["BORE ±0.05"]]],
    // Round 3: units fields that list both options, and accented metric declarations.
    ["R01 UNITS: INCH MM", mm(0.1), null, [["UNITS: INCH MM", "TOLERANCES ±0.1"]]],
    ["R02 UNITS: INCH MM, wide", mm(0.1), null, [["UNITS:  INCH    MM", "TOLERANCES ±0.1"]]],
    ["R03 DIMENSIONS: INCH METRIC", mm(0.1), null, [["DIMENSIONS: INCH METRIC", "TOLERANCES ±0.1"]]],
    ["R04 sheet metal, both listed", mm(0.1), null, [["UNITS: INCH MM", "FLAT ±0.2", "HOLES ±0.1"]]],
    ["R05 UNITS: INCHES MILLIMETERS", mm(0.05), null, [["UNITS: INCHES MILLIMETERS", "TOLERANCES ±0.05"]]],
    ["R06 UNITS: INCH X MM", mm(0.02), null, [["UNITS: INCH X MM", "GENERAL ±0.05", "BORE ±0.02"]]],
    ["R07 UNITS: MM INCH on an inch drawing", 0.005, null, [["UNITS: MM INCH", "TOLERANCES ±.005"]]],
    ["R08 unit later on the units line", 0.005, 0.005, [["UNITS: INCH; NOTE 6 MM DOWEL", "TOLERANCES ±.005"]]],
    ["R09 IN after blanks is a preposition", mm(0.1), 0.0039, [["DIMENSIONS IN MM IN ACCORDANCE WITH ISO 129", "TOLERANCES ±0.1"]]],
    ["R10 Cotes en millimètres", mm(0.025), 0.0009, [["Cotes en millimètres", "Ø6 ±0.025"]]],
    ["R11 MEDIDAS EN MILÍMETROS", mm(0.025), 0.0009, [["MEDIDAS EN MILÍMETROS", "Ø6 ±0.025"]]],
    // Round 4: checkbox and OCR renderings of a units field that lists both systems.
    ["R12 checkbox field, MM ticked", mm(0.05), null, [["UNITS: INCH ☐ MM ☒", "LINEAR ±0.1  HOLES ±0.05"]]],
    ["R13 bracket checkboxes, MM ticked", mm(0.05), null, [["UNITS: INCH [ ] MM [X]", "TOLERANCES ±0.1", "HOLES ±0.05"]]],
    ["R14 OCR cell border between units", mm(0.1), null, [["UNITS: INCH | MM", "TOLERANCES ±0.1"]]],
    ["R15 ticked INCH box fails closed", 0.005, null, [["UNITS: INCH ✓ / MM", ".XX ±.01", ".XXX ±.005"]]],
    ["R16 IN after a comma is a preposition", mm(0.1), 0.0039, [["ALL DIMENSIONS IN MM, IN ACCORDANCE WITH ISO 129-1", "TOLERANCES ±0.1"]]],
    ["R17 digit after the mark ends the field", 0.005, 0.005, [["UNITS: INCH; 6 MM DOWEL", "TOLERANCES ±.005"]]],
  ];

  it("covers the whole review corpus", () => {
    expect(corpus.filter(([id]) => id.startsWith("H"))).toHaveLength(35);
    expect(corpus.filter(([id]) => id.startsWith("X"))).toHaveLength(13);
    expect(corpus.filter(([id]) => id.startsWith("N"))).toHaveLength(103);
    expect(corpus.filter(([id]) => id.startsWith("R"))).toHaveLength(17);
  });

  it.each(corpus)("%s", async (_id, truth, expected, pages, oos) => {
    const { stored, extraction, fullText } = await storedFromPages(pages);
    const { valueInch, tightest, unit } = stored.tolerances;
    const base = baseValueInch(fullText);
    const tier = selectToleranceTier(valueInch).tier;

    expect(valueInch).toBe(expected);
    if (expected === null) {
      // Blocked: no tier, the beta gate denies it, and the raw text (if any) is marked unknown.
      expect(tier).toBeNull();
      if (tightest !== null) {
        expect(unit).toBe("unknown");
        expect(summarizeExtractionOutcome(extraction).missingFields).toContain("tightestToleranceInch");
      }
      return;
    }

    expect(Number.isFinite(expected) && expected > 0).toBe(true);
    if (base !== null) {
      expect(expected).toBeLessThanOrEqual(base);
    }
    if (typeof truth === "number" && oos === undefined) {
      expect(expected).toBeLessThanOrEqual(truth);
      expect(tierRank(tier)).toBeLessThanOrEqual(tierRank(selectToleranceTier(truth).tier));
      expect(expected >= BETA_MINIMUM_TOLERANCE_INCH).toBe(truth >= BETA_MINIMUM_TOLERANCE_INCH);
    }
  });
});
