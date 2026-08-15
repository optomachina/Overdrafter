/**
 * Single source of truth for model identity: which provider serves a model id,
 * what that model supports, and what it costs.
 *
 * Provider inference used to be written separately in the eval providers, the
 * debug lab, and the web extraction lab, which meant the three could disagree
 * about where a given model id would actually be routed. Everything that needs
 * to reason about a model id imports from here.
 */

export type ExtractionModelProvider = "openai" | "anthropic" | "openrouter";

export type ModelCostEntry = {
  inputPer1MTokens: number; // USD
  outputPer1MTokens: number; // USD
  notes?: string;
};

export const MODEL_COSTS: Record<string, ModelCostEntry> = {
  "gpt-5.4":                     { inputPer1MTokens: 2.00,  outputPer1MTokens: 8.00 },
  "gpt-4.1":                     { inputPer1MTokens: 2.00,  outputPer1MTokens: 8.00 },
  "gpt-4.1-mini":                { inputPer1MTokens: 0.15,  outputPer1MTokens: 0.60 },
  "gpt-4o":                      { inputPer1MTokens: 2.50,  outputPer1MTokens: 10.00 },
  "gpt-4o-mini":                 { inputPer1MTokens: 0.15,  outputPer1MTokens: 0.60 },
  "claude-opus-4-6":             { inputPer1MTokens: 15.00, outputPer1MTokens: 75.00 },
  "claude-sonnet-4-6":           { inputPer1MTokens: 3.00,  outputPer1MTokens: 15.00 },
  "claude-haiku-4-5-20251001":   { inputPer1MTokens: 0.25,  outputPer1MTokens: 1.25 },
  "openai/gpt-4.1-mini":         { inputPer1MTokens: 0.15,  outputPer1MTokens: 0.60 },
  "anthropic/claude-3-5-haiku":  { inputPer1MTokens: 0.25,  outputPer1MTokens: 1.25 },
  "moonshotai/kimi-k2":          { inputPer1MTokens: 0.14,  outputPer1MTokens: 0.55, notes: "verify current pricing" },
  "minimax/minimax-m2.5":        { inputPer1MTokens: 0.20,  outputPer1MTokens: 0.80, notes: "verify current pricing" },
  "minimax/minimax-m2.7":        { inputPer1MTokens: 0.20,  outputPer1MTokens: 0.80, notes: "verify current pricing" },
  "zhipuai/glm-5":               { inputPer1MTokens: 0.10,  outputPer1MTokens: 0.40, notes: "verify current pricing" },
};

/**
 * Returns estimated cost in USD, or null when the model is not in the cost
 * table. For OpenRouter, prefer the provider-reported cost when present.
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): { costUsd: number; isApproximate: boolean; notes?: string } | null {
  const entry = MODEL_COSTS[modelId];
  if (!entry) return null;
  const costUsd =
    (inputTokens / 1_000_000) * entry.inputPer1MTokens +
    (outputTokens / 1_000_000) * entry.outputPer1MTokens;
  return { costUsd, isApproximate: true, notes: entry.notes };
}

/**
 * Resolves which provider serves a model id.
 *
 * A slash means an OpenRouter-qualified id (`openai/gpt-4.1-mini`); a
 * `claude-` prefix means Anthropic direct; everything else is OpenAI.
 */
export function inferProvider(modelId: string, override?: string): ExtractionModelProvider {
  if (override === "openai" || override === "anthropic" || override === "openrouter") {
    return override;
  }

  if (modelId.includes("/")) return "openrouter";
  if (modelId.startsWith("claude-")) return "anthropic";
  return "openai";
}

/** Whether a model id addresses a provider directly rather than through a routing proxy. */
export function isDirectExtractionModelId(modelId: string) {
  return inferProvider(modelId) !== "openrouter";
}

/** Whether the configured direct model has credentials for its native provider. */
export function hasDirectExtractionCredential(
  modelId: string,
  apiKeys: { openai?: string | null; anthropic?: string | null },
) {
  const provider = inferProvider(modelId);

  if (provider === "openai") {
    return Boolean(apiKeys.openai);
  }

  if (provider === "anthropic") {
    return Boolean(apiKeys.anthropic);
  }

  return false;
}

/** Strips any OpenRouter provider qualifier, leaving the bare model name. */
export function bareModelId(modelId: string) {
  return modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
}

/**
 * Whether a model accepts an explicit `temperature`.
 *
 * Extraction wants greedy decoding, so that re-running the same drawing gives
 * the same answer and so that eval numbers describe what production does.
 *
 * The o-series reasoning models reject explicit sampling controls, so the
 * parameter is omitted for them rather than sent and rejected — determinism is
 * the goal, not the parameter itself. Everything else, including the `gpt-5.x`
 * default, is sent `temperature: 0`, which is the configuration the eval
 * harness has always exercised. If a provider starts rejecting the parameter
 * for a model family, exclude it here rather than at the call sites.
 */
export function supportsTemperature(modelId: string): boolean {
  const bare = bareModelId(modelId);

  return !/^o[134](?:[-.]|$)/i.test(bare);
}

/**
 * Qualifies an unqualified model id for OpenRouter, which requires a
 * `vendor/model` form. A already-qualified id passes through untouched.
 */
export function qualifyForOpenRouter(modelId: string) {
  return modelId.includes("/") ? modelId : `openai/${modelId}`;
}
