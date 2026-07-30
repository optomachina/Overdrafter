import type { ExtractionModelProvider } from "./types";

/**
 * Client-side mirror of the worker's model registry.
 *
 * The worker at `worker/src/extraction/modelRegistry.ts` is the source of
 * truth: it decides which provider actually serves a model id, and every
 * catalog entry the worker returns already carries a resolved `provider`.
 * Prefer that value.
 *
 * This mirror exists only for the degraded path where the worker's catalog is
 * unavailable and the UI has nothing but a list of model ids to label. Keeping
 * it in one place — rather than inline in a component — means there is exactly
 * one client-side copy to reconcile when the worker's routing rules change.
 */
export function inferExtractionModelProvider(modelId: string): ExtractionModelProvider {
  if (modelId.includes("/")) return "openrouter";
  if (modelId.startsWith("claude-")) return "anthropic";
  return "openai";
}
