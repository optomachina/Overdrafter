// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelFallbackRuntime,
  extractDrawingFieldsWithModel,
  shouldTriggerDrawingModelFallback,
  validateModelFieldValue,
} from "./modelFallback";
import type { ExtractionProvider } from "./modelProvider";
import * as pdfDrawing from "./pdfDrawing";
import type { ExtractedDrawingSignals } from "./pdfDrawing";
import type { WorkerConfig } from "../types";

const tempDirs: string[] = [];

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "simulate",
    workerLiveAdapters: [],
    vendorStorageStateDir: null,
    vendorStorageStatePaths: {},
    vendorStorageStateJson: {},
    workerName: "worker-1",
    pollIntervalMs: 5000,
    quantityPricingLadder: [1, 10, 100],
    vendorRateLimitMs: 0,
    pricingModelEnabled: false,
    pricingModelMinConfidence: 0.7,
    httpHost: "127.0.0.1",
    httpPort: 8080,
    workerTempDir: path.join(os.tmpdir(), "overdrafter-tests"),
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
    xometryBrowserEngine: "patchright",
    xometryProfileLockWaitMs: 0,
    xometrySessionFreshnessWarnDays: 14,
    fictivStorageStatePath: null,
    fictivStorageStateJson: null,
    openAiApiKey: null,
    anthropicApiKey: null,
    openRouterApiKey: null,
    workerBuildVersion: "test",
    drawingExtractionModel: "gpt-5.4",
    drawingExtractionEnableModelFallback: true,
    drawingExtractionDebugAllowedModels: ["gpt-5.4"],
    ...overrides,
  };
}

function makeModelResponse(titleBlockSufficient: boolean) {
  const field = (value: string) => ({
    value,
    confidence: 0.95,
    fieldSource: "title_block" as const,
    reasons: ["visible"],
  });

  return {
    partNumber: field("1000-00001"),
    revision: field("02"),
    description: field("Widget Clamp"),
    material: field("6061-T6"),
    finish: field("BLACK ANODIZE"),
    process: field("CNC Machining"),
    titleBlockSufficient,
  };
}

async function makeModelInput() {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-model-fallback-"));
  tempDirs.push(outputDir);
  const pagePreviewPath = path.join(outputDir, "drawing-page.png");
  await fs.writeFile(pagePreviewPath, "preview");

  vi.spyOn(pdfDrawing, "renderPdfTitleBlockCrop").mockImplementation(
    async (_drawingPath, outputPath) => {
      await fs.writeFile(outputPath, "crop");
      return {
        localPath: outputPath,
        pageNumber: 1,
        kind: "page",
        width: 100,
        height: 100,
        contentType: "image/png",
      };
    },
  );

  return {
    drawingPath: path.join(outputDir, "drawing.pdf"),
    outputDir,
    baseName: "widget-clamp",
    drawingSignals: makeSignals(),
    pagePreviewPath,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

function makeFakeProvider(
  run: ReturnType<typeof vi.fn>,
  provider: "openai" | "anthropic" | "openrouter" = "openai",
): ExtractionProvider {
  return { provider, run } as unknown as ExtractionProvider;
}

function makeProviderOutput(fields: ReturnType<typeof makeModelResponse>, modelName: string) {
  return {
    fields,
    modelName,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 10,
    estimatedCostUsd: null,
    rawResponse: {},
  };
}

describe("modelFallback", () => {
  it("fails closed when only an OpenRouter key is configured", () => {
    const runtime = buildModelFallbackRuntime({
      drawingExtractionModel: "gpt-5.4",
      openAiApiKey: null,
      anthropicApiKey: null,
    });

    expect(runtime).toBeNull();
  });

  it("rejects provider-qualified model ids even when a direct key is configured", () => {
    const runtime = buildModelFallbackRuntime({
      drawingExtractionModel: "anthropic/claude-sonnet-4.5",
      openAiApiKey: "test-openai-key",
      anthropicApiKey: "test-anthropic-key",
    });

    expect(runtime).toBeNull();
  });

  it("routes a Claude model to Anthropic when only that key is configured", () => {
    const runtime = buildModelFallbackRuntime({
      drawingExtractionModel: "claude-sonnet-4-6",
      openAiApiKey: null,
      anthropicApiKey: "test-anthropic-key",
    });

    expect(runtime?.provider.provider).toBe("anthropic");
    expect(runtime?.model).toBe("claude-sonnet-4-6");
  });

  it("does not fall back when the model's direct provider key is missing", () => {
    const runtime = buildModelFallbackRuntime({
      drawingExtractionModel: "claude-sonnet-4-6",
      openAiApiKey: "test-openai-key",
      anthropicApiKey: null,
    });

    expect(runtime).toBeNull();
  });

  it("rejects an injected provider when no provider key is configured", () => {
    const runtime = buildModelFallbackRuntime(
      {
        drawingExtractionModel: "gpt-5.4",
        openAiApiKey: null,
        anthropicApiKey: null,
      },
      { provider: makeFakeProvider(vi.fn()) },
    );

    expect(runtime).toBeNull();
  });

  it("rejects an injected OpenRouter provider without making a request", async () => {
    const run = vi.fn();
    const input = await makeModelInput();

    const result = await extractDrawingFieldsWithModel(
      {
        ...input,
        config: makeConfig({ openAiApiKey: "test-openai-key" }),
      },
      { provider: makeFakeProvider(run, "openrouter") },
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("rejects an injected direct provider that does not match the configured model", async () => {
    const run = vi.fn();
    const input = await makeModelInput();

    const result = await extractDrawingFieldsWithModel(
      {
        ...input,
        config: makeConfig({
          drawingExtractionModel: "gpt-5.4",
          openAiApiKey: null,
          anthropicApiKey: "test-anthropic-key",
        }),
      },
      { provider: makeFakeProvider(run, "anthropic") },
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("keeps the OpenAI model unqualified on an early crop success", async () => {
    const run = vi.fn().mockResolvedValue(makeProviderOutput(makeModelResponse(true), "gpt-5.4"));
    const input = await makeModelInput();

    const result = await extractDrawingFieldsWithModel(
      {
        ...input,
        config: makeConfig({ openAiApiKey: "test-openai-key" }),
      },
      { provider: makeFakeProvider(run) },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe("gpt-5.4");
    expect(result).toMatchObject({
      modelName: "gpt-5.4",
      usedTitleBlockCrop: true,
      usedFullPage: false,
    });
    expect(result?.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, attempts: 1 });
  });

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
