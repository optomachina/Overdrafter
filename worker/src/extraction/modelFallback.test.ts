// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelFallbackRuntime,
  extractDrawingFieldsWithModel,
  shouldTriggerDrawingModelFallback,
  validateModelFieldValue,
} from "./modelFallback";
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

describe("modelFallback", () => {
  it("builds an OpenRouter runtime with a provider-qualified OpenAI model", () => {
    const runtime = buildModelFallbackRuntime({
      drawingExtractionModel: "gpt-5.4",
      openAiApiKey: null,
      openRouterApiKey: "test-openrouter-key",
    });

    expect(runtime?.client.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(runtime?.model).toBe("openai/gpt-5.4");
  });

  it("preserves an explicitly provider-qualified OpenRouter model", () => {
    const runtime = buildModelFallbackRuntime({
      drawingExtractionModel: "anthropic/claude-sonnet-4.5",
      openAiApiKey: null,
      openRouterApiKey: "test-openrouter-key",
    });

    expect(runtime?.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("sends the qualified OpenRouter model through crop and full-page attempts", async () => {
    const parse = vi
      .fn()
      .mockResolvedValueOnce({ output_parsed: makeModelResponse(false) })
      .mockResolvedValueOnce({ output_parsed: makeModelResponse(true) });
    const input = await makeModelInput();

    const result = await extractDrawingFieldsWithModel(
      {
        ...input,
        config: makeConfig({ openRouterApiKey: "test-openrouter-key" }),
      },
      { client: { responses: { parse } } as unknown as OpenAI },
    );

    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls.map(([request]) => request.model)).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.4",
    ]);
    expect(result).toMatchObject({
      modelName: "openai/gpt-5.4",
      usedTitleBlockCrop: true,
      usedFullPage: true,
    });
  });

  it("keeps the OpenAI model unqualified on an early crop success", async () => {
    const parse = vi.fn().mockResolvedValue({ output_parsed: makeModelResponse(true) });
    const input = await makeModelInput();

    const result = await extractDrawingFieldsWithModel(
      {
        ...input,
        config: makeConfig({ openAiApiKey: "test-openai-key" }),
      },
      { client: { responses: { parse } } as unknown as OpenAI },
    );

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][0].model).toBe("gpt-5.4");
    expect(result).toMatchObject({
      modelName: "gpt-5.4",
      usedTitleBlockCrop: true,
      usedFullPage: false,
    });
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
