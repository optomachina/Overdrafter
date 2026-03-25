export type ModelCostEntry = {
  inputPer1MTokens: number;   // USD
  outputPer1MTokens: number;  // USD
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
 * Returns estimated cost in USD, or null if the model is not in the cost table.
 * For OpenRouter models, prefer using the provider-reported cost if available.
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
