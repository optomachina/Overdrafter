/**
 * Eval-facing view of the shared extraction provider layer.
 *
 * The provider implementations used to live here, which meant the eval harness
 * measured code that production never ran. They now live in
 * `../extraction/modelProvider.ts` and are shared; this module only keeps the
 * eval harness's historical names pointing at them.
 */

import {
  AnthropicExtractionProvider,
  buildPromptParts,
  createProvider,
  isModelError,
  OpenAIExtractionProvider,
  OpenRouterExtractionProvider,
  type ExtractionProvider,
  type ModelErrorOutput,
  type ModelPromptInput,
  type ModelRunOutput,
  type ModelRunResult,
} from "../extraction/modelProvider.js";
import { inferProvider as inferProviderFromRegistry } from "../extraction/modelRegistry.js";
import {
  imageFileToDataUrl,
  serializeParserContext,
} from "../extraction/modelFallback.js";
import type { ExtractedDrawingSignals } from "../extraction/pdfDrawing.js";

export type EvalModelInput = ModelPromptInput;
export type EvalModelOutput = ModelRunOutput;
export type EvalErrorOutput = ModelErrorOutput;
export type EvalRunOutput = ModelRunResult;
export type EvalProvider = ExtractionProvider;

export const OpenAIEvalProvider = OpenAIExtractionProvider;
export const AnthropicEvalProvider = AnthropicExtractionProvider;
export const OpenRouterEvalProvider = OpenRouterExtractionProvider;

export const isEvalError = isModelError;
export const buildEvalPromptParts = buildPromptParts;

/**
 * Eval keeps a warning on an unrecognized model id: the harness prints cost
 * tables, so a silently mis-routed model would show a misleading price.
 */
export function inferProvider(
  modelId: string,
  override?: string,
): "openai" | "anthropic" | "openrouter" {
  if (override && override !== "openai" && override !== "anthropic" && override !== "openrouter") {
    console.warn(`Unknown --provider "${override}", defaulting to openai`);
  } else if (!override && !modelId.includes("/") && !modelId.startsWith("claude-")) {
    console.warn(`Unknown model "${modelId}" — routing to OpenAI; add to cost table if needed`);
  }

  return inferProviderFromRegistry(modelId, override);
}

export { createProvider, serializeParserContext, imageFileToDataUrl };
export type { ExtractedDrawingSignals };
