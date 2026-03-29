import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  extractPdfText,
  inferDrawingSignalsFromPdf,
  renderPdfFirstPagePreview,
  renderPdfPreviewAssets,
  renderPdfTitleBlockCrop,
} from "./pdfDrawing.js";
import {
  MODEL_FALLBACK_PROMPT_VERSION,
  type DrawingModelExtractionResult,
  type ParsedModelResponse,
  serializeParserContext,
} from "./modelFallback.js";
import { buildStoredExtractionPayload, currentExtractorVersion, summarizeExtractionOutcome } from "./sharedResult.js";
import { runHybridExtraction } from "./hybridExtraction.js";
import { cleanupPaths, createRunDir, stageStorageObject } from "../files.js";
import { fetchPartContext } from "../partContext.js";
import { createServiceClient } from "../queue.js";
import type { WorkerConfig } from "../types.js";
import {
  createProvider,
  inferProvider,
  isEvalError,
  type EvalModelInput,
  type EvalModelOutput,
  type EvalProvider,
} from "../tools/extractEvalProviders.js";

export type ExtractionModelProvider = "openai" | "anthropic" | "openrouter";

export type DiscoveredExtractionModel = {
  provider: ExtractionModelProvider;
  modelId: string;
  displayLabel: string;
  sourceFreshness: "refreshed" | "fallback";
  previewRunnable: boolean;
  debugRunnable: boolean;
  defaultHint: boolean;
  stale: boolean;
};

export type DiscoveredModelCatalog = {
  models: DiscoveredExtractionModel[];
  updatedAt: string | null;
  catalogFreshness: "cached" | "refreshed";
  refreshing: boolean;
  stale: boolean;
  error: string | null;
};

export type PreviewExtractionResult = {
  partId: string;
  jobId: string;
  provider: ExtractionModelProvider;
  requestedModel: string;
  effectiveModel: string;
  workerBuildVersion: string;
  extractorVersion: string;
  modelFallbackUsed: boolean;
  modelPromptVersion: string | null;
  parserContext: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  extraction: Record<string, unknown>;
  status: "approved" | "needs_review";
  warnings: string[];
  evidence: Array<Record<string, unknown>>;
  summary: ReturnType<typeof summarizeExtractionOutcome>;
  preview: {
    pageCount: number;
    previewAssetCount: number;
    hasPreviewImage: boolean;
  };
  modelAttempts: Array<{
    attempt: "title_block_crop" | "full_page";
    titleBlockSufficient: boolean;
    rawResponse: unknown;
  }>;
};

type StoredCatalogState = {
  updatedAt: string;
  models: Omit<DiscoveredExtractionModel, "stale">[];
  error: string | null;
};

const MODEL_CATALOG_TTL_MS = 1000 * 60 * 60 * 6;
const SUFFICIENT_FIELDS = ["partNumber", "revision", "description", "material", "finish"] as const;

const OPENAI_FALLBACK_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-4.1-mini"];
const ANTHROPIC_FALLBACK_MODELS = ["claude-sonnet-4-6", "claude-3-7-sonnet-latest"];
const OPENROUTER_FALLBACK_MODELS = ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"];

function uniqueModels(models: DiscoveredExtractionModel[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.provider}:${model.modelId}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function byProviderOrder(provider: ExtractionModelProvider) {
  switch (provider) {
    case "openai":
      return 0;
    case "anthropic":
      return 1;
    case "openrouter":
      return 2;
  }
}

function sortModels(models: DiscoveredExtractionModel[]) {
  return [...models].sort((left, right) => {
    const providerDelta = byProviderOrder(left.provider) - byProviderOrder(right.provider);
    if (providerDelta !== 0) {
      return providerDelta;
    }

    if (left.defaultHint !== right.defaultHint) {
      return left.defaultHint ? -1 : 1;
    }

    return left.modelId.localeCompare(right.modelId);
  });
}

function isOpenAiPreviewCandidate(modelId: string) {
  return /^(gpt-|o[134]|chatgpt-)/i.test(modelId);
}

function supportsStructuredOutputs(parameters: unknown) {
  return Array.isArray(parameters) && parameters.some((parameter) => parameter === "structured_outputs");
}

function fallbackModelsForProvider(
  provider: ExtractionModelProvider,
  config: WorkerConfig,
): DiscoveredExtractionModel[] {
  const ids =
    provider === "openai"
      ? OPENAI_FALLBACK_MODELS
      : provider === "anthropic"
        ? ANTHROPIC_FALLBACK_MODELS
        : OPENROUTER_FALLBACK_MODELS;

  return ids.map((modelId, index) => ({
    provider,
    modelId,
    displayLabel: modelId,
    sourceFreshness: "fallback",
    previewRunnable: true,
    debugRunnable: config.drawingExtractionDebugAllowedModels.includes(modelId),
    defaultHint: modelId === config.drawingExtractionModel || index === 0,
    stale: true,
  }));
}

async function discoverOpenAiModels(config: WorkerConfig) {
  if (!config.openAiApiKey) {
    return [] as DiscoveredExtractionModel[];
  }

  const client = new OpenAI({ apiKey: config.openAiApiKey });
  const page = await client.models.list();

  return page.data
    .filter((model) => isOpenAiPreviewCandidate(model.id))
    .map((model) => ({
      provider: "openai" as const,
      modelId: model.id,
      displayLabel: model.id,
      sourceFreshness: "refreshed" as const,
      previewRunnable: true,
      debugRunnable: config.drawingExtractionDebugAllowedModels.includes(model.id),
      defaultHint: model.id === config.drawingExtractionModel,
      stale: false,
    }));
}

async function discoverAnthropicModels(config: WorkerConfig) {
  if (!config.anthropicApiKey) {
    return [] as DiscoveredExtractionModel[];
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const page = await client.models.list();

  return page.data
    .filter((model) => Boolean(model.capabilities?.image_input?.supported))
    .filter((model) => Boolean(model.capabilities?.structured_outputs?.supported))
    .map((model) => ({
      provider: "anthropic" as const,
      modelId: model.id,
      displayLabel: model.display_name || model.id,
      sourceFreshness: "refreshed" as const,
      previewRunnable: true,
      debugRunnable: config.drawingExtractionDebugAllowedModels.includes(model.id),
      defaultHint: model.id === config.drawingExtractionModel,
      stale: false,
    }));
}

async function discoverOpenRouterModels(config: WorkerConfig) {
  if (!config.openRouterApiKey) {
    return [] as DiscoveredExtractionModel[];
  }

  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter model discovery returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as {
    data?: Array<{
      id?: string;
      name?: string;
      architecture?: { input_modalities?: string[] };
      supported_parameters?: string[];
    }>;
  };

  return (payload.data ?? [])
    .filter((model) => typeof model.id === "string" && model.id.length > 0)
    .filter((model) => model.architecture?.input_modalities?.includes("image"))
    .filter((model) => supportsStructuredOutputs(model.supported_parameters))
    .map((model) => ({
      provider: "openrouter" as const,
      modelId: model.id!,
      displayLabel: model.name || model.id!,
      sourceFreshness: "refreshed" as const,
      previewRunnable: true,
      debugRunnable: config.drawingExtractionDebugAllowedModels.includes(model.id!),
      defaultHint: model.id === config.drawingExtractionModel,
      stale: false,
    }));
}

export class ExtractionModelCatalogManager {
  private refreshPromise: Promise<StoredCatalogState> | null = null;

  constructor(private readonly config: WorkerConfig) {}

  private get cachePath() {
    return path.join(this.config.workerTempDir, "debug", "extraction-model-catalog.json");
  }

  private async readStoredCatalog() {
    try {
      const raw = await fs.readFile(this.cachePath, "utf8");
      return JSON.parse(raw) as StoredCatalogState;
    } catch {
      return null;
    }
  }

  private async writeStoredCatalog(catalog: StoredCatalogState) {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(catalog, null, 2), "utf8");
  }

  private isStale(updatedAt: string | null) {
    if (!updatedAt) {
      return true;
    }

    const parsed = new Date(updatedAt);
    return Number.isNaN(parsed.valueOf()) || Date.now() - parsed.valueOf() > MODEL_CATALOG_TTL_MS;
  }

  private async discoverModels(): Promise<StoredCatalogState> {
    const errors: string[] = [];
    const discovered: DiscoveredExtractionModel[] = [];

    const attempts = await Promise.allSettled([
      discoverOpenAiModels(this.config),
      discoverAnthropicModels(this.config),
      discoverOpenRouterModels(this.config),
    ]);

    const providers: ExtractionModelProvider[] = ["openai", "anthropic", "openrouter"];
    attempts.forEach((result, index) => {
      const provider = providers[index]!;

      if (result.status === "fulfilled" && result.value.length > 0) {
        discovered.push(...result.value);
        return;
      }

      if (result.status === "rejected") {
        errors.push(`${provider}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }

      discovered.push(...fallbackModelsForProvider(provider, this.config));
    });

    const catalog: StoredCatalogState = {
      updatedAt: new Date().toISOString(),
      models: sortModels(uniqueModels(discovered)).map(({ stale, ...model }) => model),
      error: errors.length > 0 ? errors.join(" | ") : null,
    };
    await this.writeStoredCatalog(catalog);
    return catalog;
  }

  async refreshNow() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.discoverModels().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  async getCatalog(): Promise<DiscoveredModelCatalog> {
    let stored = await this.readStoredCatalog();

    if (!stored) {
      stored = await this.refreshNow();
      return {
        models: stored.models.map((model) => ({ ...model, stale: false })),
        updatedAt: stored.updatedAt,
        catalogFreshness: "refreshed",
        refreshing: false,
        stale: false,
        error: stored.error,
      };
    }

    const stale = this.isStale(stored.updatedAt);
    if (stale && !this.refreshPromise) {
      void this.refreshNow();
    }

    return {
      models: stored.models.map((model) => ({ ...model, stale })),
      updatedAt: stored.updatedAt,
      catalogFreshness: "cached",
      refreshing: Boolean(this.refreshPromise),
      stale,
      error: stored.error,
    };
  }
}

function isAttemptSufficient(parsed: ParsedModelResponse) {
  return SUFFICIENT_FIELDS.every((fieldName) => {
    const field = parsed[fieldName];
    return Boolean(field.value) && field.confidence >= 0.8 && field.fieldSource !== "unknown";
  });
}

async function runPreviewModelAttempts(input: {
  config: WorkerConfig;
  modelId: string;
  baseName: string;
  drawingSignals: ReturnType<typeof inferDrawingSignalsFromPdf>;
  cropPath: string | null;
  fullPagePath: string | null;
}) {
  const providerName = inferProvider(input.modelId) as ExtractionModelProvider;
  const provider = createProvider(providerName, {
    openai: input.config.openAiApiKey ?? undefined,
    anthropic: input.config.anthropicApiKey ?? undefined,
    openrouter: input.config.openRouterApiKey ?? undefined,
  });

  if (!provider) {
    throw new Error(`No configured credentials are available for ${providerName}.`);
  }

  const request = async (
    attempt: "title_block_crop" | "full_page",
    providerClient: EvalProvider,
  ) => {
    const evalInput: EvalModelInput = {
      parserContext: serializeParserContext(input.drawingSignals),
      baseName: input.baseName,
      titleBlockCropDataUrl: input.cropPath ? await fs.readFile(input.cropPath, "base64").then((data) => `data:image/png;base64,${data}`) : null,
      fullPageDataUrl:
        attempt === "full_page" && input.fullPagePath
          ? await fs.readFile(input.fullPagePath, "base64").then((data) => `data:image/png;base64,${data}`)
          : null,
      attempt,
    };

    const output = await providerClient.run(evalInput, input.modelId);

    if (isEvalError(output)) {
      throw new Error(`${output.modelName}: ${output.errorType}: ${output.errorMessage}`);
    }

    return output;
  };

  const attempts: Array<{
    attempt: "title_block_crop" | "full_page";
    titleBlockSufficient: boolean;
    rawResponse: unknown;
    output: EvalModelOutput;
  }> = [];

  const cropOutput = await request("title_block_crop", provider);
  attempts.push({
    attempt: "title_block_crop",
    titleBlockSufficient: cropOutput.fields.titleBlockSufficient,
    rawResponse: cropOutput.rawResponse,
    output: cropOutput,
  });

  let finalOutput = cropOutput;
  let usedFullPage = false;

  if ((!cropOutput.fields.titleBlockSufficient || !isAttemptSufficient(cropOutput.fields)) && input.fullPagePath) {
    const fullPageOutput = await request("full_page", provider);
    attempts.push({
      attempt: "full_page",
      titleBlockSufficient: fullPageOutput.fields.titleBlockSufficient,
      rawResponse: fullPageOutput.rawResponse,
      output: fullPageOutput,
    });
    finalOutput = fullPageOutput;
    usedFullPage = true;
  }

  const modelResult: DrawingModelExtractionResult = {
    fields: {
      partNumber: finalOutput.fields.partNumber,
      revision: finalOutput.fields.revision,
      description: finalOutput.fields.description,
      material: finalOutput.fields.material,
      finish: finalOutput.fields.finish,
      process: finalOutput.fields.process,
    },
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      titleBlockSufficient: attempt.titleBlockSufficient,
      fields: {
        partNumber: attempt.output.fields.partNumber,
        revision: attempt.output.fields.revision,
        description: attempt.output.fields.description,
        material: attempt.output.fields.material,
        finish: attempt.output.fields.finish,
        process: attempt.output.fields.process,
      },
    })),
    modelName: input.modelId,
    promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
    usedTitleBlockCrop: Boolean(input.cropPath),
    usedFullPage,
  };

  return {
    provider: providerName,
    parserContext: serializeParserContext(input.drawingSignals),
    durationMs: attempts.reduce((sum, attempt) => sum + attempt.output.durationMs, 0),
    inputTokens: attempts.reduce((sum, attempt) => sum + attempt.output.inputTokens, 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + attempt.output.outputTokens, 0),
    estimatedCostUsd: attempts.reduce<number | null>((sum, attempt) => {
      if (attempt.output.estimatedCostUsd === null) {
        return sum;
      }

      return (sum ?? 0) + attempt.output.estimatedCostUsd;
    }, null),
    modelAttempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      titleBlockSufficient: attempt.titleBlockSufficient,
      rawResponse: attempt.rawResponse,
    })),
    modelResult,
  };
}

export async function previewStoredPartExtraction(
  config: WorkerConfig,
  input: { partId: string; modelId: string },
): Promise<PreviewExtractionResult> {
  const supabase = createServiceClient(config);
  const context = await fetchPartContext(supabase, input.partId);

  if (!context.drawingFile) {
    throw new Error(`Part ${input.partId} does not have a drawing file.`);
  }

  const runDir = await createRunDir(config, ["debug-preview", context.part.job_id, context.part.id]);
  const stagedDrawingFile = await stageStorageObject(supabase, context.drawingFile, runDir);
  if (!stagedDrawingFile) {
    throw new Error(`Part ${input.partId} drawing could not be staged.`);
  }

  try {
    const pdfText = stagedDrawingFile ? await extractPdfText(stagedDrawingFile.localPath) : null;
    let previewAssets = [] as Awaited<ReturnType<typeof renderPdfPreviewAssets>>;

    if (stagedDrawingFile && pdfText) {
      try {
        previewAssets = await renderPdfPreviewAssets(stagedDrawingFile.localPath, runDir, pdfText.pageCount);
      } catch {
        previewAssets = [];
      }
    }

    let firstPagePreviewPath =
      previewAssets.find((asset) => asset.kind === "page" && asset.pageNumber === 1)?.localPath ?? null;

    if (stagedDrawingFile && !firstPagePreviewPath) {
      const fallbackPreviewAsset = await renderPdfFirstPagePreview(
        stagedDrawingFile.localPath,
        path.join(runDir, "drawing-page-1.png"),
      );

      if (fallbackPreviewAsset) {
        previewAssets = [
          ...previewAssets.filter(
            (asset) => !(asset.kind === "page" && asset.pageNumber === fallbackPreviewAsset.pageNumber),
          ),
          fallbackPreviewAsset,
        ];
        firstPagePreviewPath = fallbackPreviewAsset.localPath;
      }
    }

    const drawingSignals = inferDrawingSignalsFromPdf({
      baseName: path.basename(context.drawingFile.original_name, path.extname(context.drawingFile.original_name)),
      pdfText,
    });
    const cropPath = path.join(runDir, "drawing-title-block.png");
    const cropAsset = await renderPdfTitleBlockCrop(stagedDrawingFile.localPath, cropPath).catch(() => null);

    const previewModel = await runPreviewModelAttempts({
      config,
      modelId: input.modelId,
      baseName: path.basename(context.drawingFile.original_name, path.extname(context.drawingFile.original_name)),
      drawingSignals,
      cropPath: cropAsset?.localPath ?? null,
      fullPagePath: firstPagePreviewPath,
    });

    const previewConfig: WorkerConfig = {
      ...config,
      drawingExtractionModel: input.modelId,
      drawingExtractionEnableModelFallback: true,
    };

    const extraction = await runHybridExtraction(
      {
        part: context.part,
        cadFile: context.cadFile,
        drawingFile: context.drawingFile,
        requirement: context.requirement,
        pdfText,
        drawingPath: stagedDrawingFile.localPath,
        previewPagePath: firstPagePreviewPath,
        runDir,
        config: previewConfig,
        forceModelFallback: true,
      },
      {
        extractWithModel: async () => previewModel.modelResult,
      },
    );

    const summary = summarizeExtractionOutcome(extraction);
    const extractorVersion = currentExtractorVersion(Boolean(stagedDrawingFile));

    return {
      partId: context.part.id,
      jobId: context.part.job_id,
      provider: previewModel.provider,
      requestedModel: input.modelId,
      effectiveModel: input.modelId,
      workerBuildVersion: config.workerBuildVersion,
      extractorVersion,
      modelFallbackUsed: true,
      modelPromptVersion: MODEL_FALLBACK_PROMPT_VERSION,
      parserContext: previewModel.parserContext,
      durationMs: previewModel.durationMs,
      inputTokens: previewModel.inputTokens,
      outputTokens: previewModel.outputTokens,
      estimatedCostUsd: previewModel.estimatedCostUsd,
      extraction: buildStoredExtractionPayload(
        extraction,
        pdfText?.pageCount ?? 0,
        config.workerBuildVersion,
      ),
      status: extraction.status,
      warnings: extraction.warnings,
      evidence: extraction.evidence as Array<Record<string, unknown>>,
      summary,
      preview: {
        pageCount: pdfText?.pageCount ?? 0,
        previewAssetCount: previewAssets.length,
        hasPreviewImage: Boolean(firstPagePreviewPath),
      },
      modelAttempts: previewModel.modelAttempts,
    };
  } finally {
    await cleanupPaths([runDir]);
  }
}
