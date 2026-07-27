import fs from "node:fs/promises";
import path from "node:path";
import type { WorkerConfig } from "../types.js";
import {
  renderPdfTitleBlockCrop,
  type CandidateSignal,
  type ExtractedDrawingSignals,
  type ExtractedFieldSignal,
} from "./pdfDrawing.js";
import {
  CRITICAL_MODEL_FIELDS,
  COMPETING_CANDIDATE_DELTA,
  isModelAttemptSufficient,
  MODEL_ACCEPT_CONFIDENCE,
  MODEL_FIELD_NAMES,
  MODEL_TRIGGER_CONFIDENCE,
  PARSER_STRONG_CONFIDENCE,
  derivePromptVersion,
  type CriticalModelFieldName,
  type ModelFieldName,
} from "./policy.js";
import {
  EXTRACTION_SYSTEM_INSTRUCTION,
  EXTRACTION_USER_INSTRUCTIONS,
  modelResponseSchema,
  type ModelFieldResponse,
  type ParsedModelResponse,
} from "./schema.js";
import {
  EXTRACTION_SCHEMA_SHAPE,
  resolveProvider,
  type ExtractionProvider,
  type ModelAttempt,
} from "./modelProvider.js";
import { qualifyForOpenRouter } from "./modelRegistry.js";
import { callModel, combineUsage, type ModelCallUsage } from "./callModel.js";
import type { SpendContext, SpendGuard } from "../spendGuard.js";

export {
  EXTRACTION_SYSTEM_INSTRUCTION,
  EXTRACTION_USER_INSTRUCTIONS,
  modelResponseSchema,
  type ParsedModelResponse,
};

/**
 * Prompt version derived from the prompt and schema actually in the build,
 * rather than a hand-bumped constant that can silently disagree with them.
 */
export const MODEL_FALLBACK_PROMPT_VERSION = derivePromptVersion({
  systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
  userInstructions: EXTRACTION_USER_INSTRUCTIONS,
  schemaShape: EXTRACTION_SCHEMA_SHAPE,
});

const PART_NUMBER_PATTERN = /\b\d{3,5}-\d{4,6}(?:-[A-Z0-9]{1,4})?\b/;
const SPEC_PATTERN = /\b(?:MIL|ASTM|AMS|QQ|ASME|SAE|ISO|DIN)[-\s/]*[A-Z0-9.]+/i;
const DATE_PATTERN = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b/i;
const SIGNATURE_PATTERN = /\b(?:engineer|checker|checked|approvals|approved|date|ec\/date|ecn)\b/i;

export type DrawingModelExtractionResult = {
  fields: Record<ModelFieldName, ModelFieldResponse>;
  attempts: Array<{
    attempt: ModelAttempt;
    titleBlockSufficient: boolean;
    fields: Record<ModelFieldName, ModelFieldResponse>;
  }>;
  modelName: string;
  promptVersion: string;
  usedTitleBlockCrop: boolean;
  usedFullPage: boolean;
  /** Tokens, latency, and cost for the attempts this result was built from. */
  usage: ModelCallUsage | null;
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeFieldValue(value: string | null) {
  return value ? normalizeWhitespace(value) : null;
}

function hasLabelEvidence(field: ExtractedFieldSignal) {
  return field.reasons.some((reason) => reason === "label_match" || reason === "spatial_match");
}

function hasCompetingCandidates(candidates: CandidateSignal[] | undefined) {
  if (!candidates || candidates.length < 2) {
    return false;
  }

  return Math.abs(candidates[0].score - candidates[1].score) <= COMPETING_CANDIDATE_DELTA;
}

function shouldUseModelForField(
  fieldName: CriticalModelFieldName,
  field: ExtractedFieldSignal,
  candidates: CandidateSignal[] | undefined,
) {
  if (!field.value) {
    return true;
  }

  if (field.confidence < MODEL_TRIGGER_CONFIDENCE) {
    return true;
  }

  if (!hasLabelEvidence(field)) {
    return true;
  }

  if (field.reasons.some((reason) => reason.startsWith("rejected_"))) {
    return true;
  }

  if (hasCompetingCandidates(candidates)) {
    return true;
  }

  if (fieldName === "revision" && field.value.length <= 1 && !field.reasons.includes("label_match")) {
    return true;
  }

  return false;
}

export function shouldTriggerDrawingModelFallback(input: {
  drawingSignals: ExtractedDrawingSignals;
  hasDrawingFile: boolean;
  modelEnabled: boolean;
}) {
  if (!input.modelEnabled || !input.hasDrawingFile) {
    return false;
  }

  return CRITICAL_MODEL_FIELDS.some((fieldName) =>
    shouldUseModelForField(
      fieldName,
      input.drawingSignals[fieldName],
      input.drawingSignals.debugCandidates[fieldName],
    ),
  );
}

export function validateModelFieldValue(field: ModelFieldName, value: string | null): string[] {
  if (!value) {
    return [];
  }

  const normalized = normalizeWhitespace(value);
  const rejectionReasons: string[] = [];

  switch (field) {
    case "partNumber":
      if (SPEC_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_spec_string");
      }
      if (DATE_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_date_metadata");
      }
      if (SIGNATURE_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_signature_block");
      }
      if (!PART_NUMBER_PATTERN.test(normalized)) {
        rejectionReasons.push("regex_fit");
      }
      break;
    case "revision":
      if (!/^[A-Z0-9]{1,4}$/i.test(normalized)) {
        rejectionReasons.push("regex_fit");
      }
      break;
    case "description":
      if (/^\d[\d\s-]*$/.test(normalized)) {
        rejectionReasons.push("rejected_numeric_description");
      }
      break;
    case "finish":
      if (SIGNATURE_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_signature_block");
      }
      if (DATE_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_date_metadata");
      }
      break;
    default:
      break;
  }

  return rejectionReasons;
}

type ModelFallbackRuntimeConfig = Pick<
  WorkerConfig,
  "drawingExtractionModel" | "openAiApiKey" | "anthropicApiKey" | "openRouterApiKey"
>;

/**
 * Resolves the provider and exact model identifier used for extraction.
 *
 * Anthropic participates here on equal footing with OpenAI and OpenRouter.
 * It used to be configured but unreachable: `ANTHROPIC_API_KEY` was parsed
 * and plumbed into `WorkerConfig`, yet the production client builder could
 * only ever construct OpenAI or OpenRouter, so the deployment appeared to
 * have cross-provider failover that did not exist.
 */
export function buildModelFallbackRuntime(
  config: ModelFallbackRuntimeConfig,
  dependencies: { provider?: ExtractionProvider } = {},
): { provider: ExtractionProvider; model: string } | null {
  const apiKeys = {
    openai: config.openAiApiKey ?? undefined,
    anthropic: config.anthropicApiKey ?? undefined,
    openrouter: config.openRouterApiKey ?? undefined,
  };

  if (!apiKeys.openai && !apiKeys.anthropic && !apiKeys.openrouter) {
    return null;
  }

  const configuredModel = config.drawingExtractionModel.trim();

  if (dependencies.provider) {
    return {
      provider: dependencies.provider,
      model:
        dependencies.provider.provider === "openrouter"
          ? qualifyForOpenRouter(configuredModel)
          : configuredModel,
    };
  }

  const resolved = resolveProvider(configuredModel, apiKeys);
  if (!resolved) {
    return null;
  }

  return { provider: resolved.provider, model: resolved.modelId };
}

/**
 * Serializes drawing signal fields and top candidates into a deterministic
 * text block for inclusion in model prompts as deterministic parser context.
 *
 * @param drawingSignals - Extracted drawing signals from the PDF parser.
 * @returns Newline-joined string summarizing selected field values and debug candidates.
 */
export function serializeParserContext(drawingSignals: ExtractedDrawingSignals) {
  const lines = CRITICAL_MODEL_FIELDS.map((fieldName) => {
    const selected = drawingSignals[fieldName];
    const candidates = (drawingSignals.debugCandidates[fieldName] ?? [])
      .slice(0, 3)
      .map(
        (candidate) =>
          `${candidate.value} [score=${candidate.score.toFixed(2)} reasons=${candidate.reasons.join("|") || "none"} label=${candidate.label ?? "none"}]`,
      )
      .join("; ");

    return `${fieldName}: selected=${selected.value ?? "null"} confidence=${selected.confidence.toFixed(2)} reasons=${
      selected.reasons.join("|") || "none"
    } candidates=${candidates || "none"}`;
  });

  return lines.join("\n");
}

/**
 * Reads an image file from disk and returns a base64-encoded PNG data URL.
 *
 * @param localPath - Absolute path to the PNG image file.
 * @returns A data URL string of the form `data:image/png;base64,...`.
 */
export async function imageFileToDataUrl(localPath: string) {
  const buffer = await fs.readFile(localPath);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

/**
 * Runs one extraction attempt through the shared provider layer, so the
 * production path gets the same deterministic sampling, deadline, retry
 * policy, and usage accounting as the eval harness and the debug lab.
 */
async function runModelAttempt(input: {
  provider: ExtractionProvider;
  model: string;
  drawingSignals: ExtractedDrawingSignals;
  baseName: string;
  cropPath: string | null;
  fullPagePath: string | null;
  attempt: ModelAttempt;
  spend?: { guard: SpendGuard; estimatedUsd: number; context?: SpendContext };
}): Promise<{ parsed: ParsedModelResponse; usage: ModelCallUsage }> {
  const { output, usage } = await callModel(
    input.provider,
    {
      parserContext: serializeParserContext(input.drawingSignals),
      baseName: input.baseName,
      titleBlockCropDataUrl: input.cropPath ? await imageFileToDataUrl(input.cropPath) : null,
      fullPageDataUrl:
        input.attempt === "full_page" && input.fullPagePath
          ? await imageFileToDataUrl(input.fullPagePath)
          : null,
      attempt: input.attempt,
    },
    input.model,
    input.spend ? { spend: input.spend } : {},
  );

  return { parsed: output.fields, usage };
}

export async function extractDrawingFieldsWithModel(
  input: {
    config: WorkerConfig;
    drawingPath: string;
    outputDir: string;
    baseName: string;
    drawingSignals: ExtractedDrawingSignals;
    pagePreviewPath: string | null;
    /** Budget enforcement. Each attempt reserves and settles independently. */
    spend?: { guard: SpendGuard; estimatedUsd: number; context?: SpendContext };
  },
  dependencies: {
    provider?: ExtractionProvider;
  } = {},
): Promise<DrawingModelExtractionResult | null> {
  if (
    !input.config.drawingExtractionEnableModelFallback ||
    (!input.config.openAiApiKey &&
      !input.config.anthropicApiKey &&
      !input.config.openRouterApiKey)
  ) {
    return null;
  }

  const runtime = buildModelFallbackRuntime(input.config, dependencies);
  if (!runtime) {
    return null;
  }
  const cropPath = path.join(input.outputDir, "drawing-title-block.png");
  let titleBlockCropPath: string | null = null;
  const attempts: DrawingModelExtractionResult["attempts"] = [];
  const usages: ModelCallUsage[] = [];

  try {
    const cropAsset = await renderPdfTitleBlockCrop(input.drawingPath, cropPath);
    titleBlockCropPath = cropAsset?.localPath ?? null;
  } catch {
    titleBlockCropPath = null;
  }

  if (titleBlockCropPath) {
    const { parsed: cropAttempt, usage } = await runModelAttempt({
      provider: runtime.provider,
      model: runtime.model,
      drawingSignals: input.drawingSignals,
      baseName: input.baseName,
      cropPath: titleBlockCropPath,
      fullPagePath: null,
      attempt: "title_block_crop",
      spend: input.spend,
    });
    usages.push(usage);

    attempts.push({
      attempt: "title_block_crop",
      titleBlockSufficient: cropAttempt.titleBlockSufficient,
      fields: {
        partNumber: cropAttempt.partNumber,
        revision: cropAttempt.revision,
        description: cropAttempt.description,
        material: cropAttempt.material,
        finish: cropAttempt.finish,
        process: cropAttempt.process,
      },
    });

    if (cropAttempt.titleBlockSufficient && isModelAttemptSufficient(cropAttempt)) {
      return {
        fields: attempts[0].fields,
        attempts,
        modelName: runtime.model,
        promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
        usedTitleBlockCrop: true,
        usedFullPage: false,
        usage: combineUsage(usages),
      };
    }
  }

  if (!input.pagePreviewPath) {
    return attempts.length > 0
      ? {
          fields: attempts[attempts.length - 1].fields,
          attempts,
          modelName: runtime.model,
          promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
          usedTitleBlockCrop: Boolean(titleBlockCropPath),
          usedFullPage: false,
          usage: combineUsage(usages),
        }
      : null;
  }

  const { parsed: fullPageAttempt, usage: fullPageUsage } = await runModelAttempt({
    provider: runtime.provider,
    model: runtime.model,
    drawingSignals: input.drawingSignals,
    baseName: input.baseName,
    cropPath: titleBlockCropPath,
    fullPagePath: input.pagePreviewPath,
    attempt: "full_page",
    spend: input.spend,
  });
  usages.push(fullPageUsage);

  attempts.push({
    attempt: "full_page",
    titleBlockSufficient: fullPageAttempt.titleBlockSufficient,
    fields: {
      partNumber: fullPageAttempt.partNumber,
      revision: fullPageAttempt.revision,
      description: fullPageAttempt.description,
      material: fullPageAttempt.material,
      finish: fullPageAttempt.finish,
      process: fullPageAttempt.process,
    },
  });

  return {
    fields: attempts[attempts.length - 1].fields,
    attempts,
    modelName: runtime.model,
    promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
    usedTitleBlockCrop: Boolean(titleBlockCropPath),
    usedFullPage: true,
    usage: combineUsage(usages),
  };
}

export function isParserSignalStrong(field: ExtractedFieldSignal) {
  return Boolean(field.value) && field.confidence >= PARSER_STRONG_CONFIDENCE && hasLabelEvidence(field);
}

export function normalizeComparableFieldValue(value: string | null) {
  return normalizeFieldValue(value)?.toUpperCase() ?? null;
}
