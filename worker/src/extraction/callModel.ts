import { estimateCost } from "./modelRegistry.js";
import type { SpendContext, SpendGuard } from "../spendGuard.js";
import {
  isModelError,
  type ExtractionProvider,
  type ModelErrorType,
  type ModelPromptInput,
  type ModelRunOutput,
} from "./modelProvider.js";

/**
 * The single entry point for calling an extraction model.
 *
 * Every model request in the system goes through here so that the deadline,
 * the retry policy, and usage accounting exist exactly once and apply
 * uniformly. Previously the production path had none of the three: a hung
 * request could stall the worker's serial task loop for as long as the SDK's
 * default retry budget, and no token, latency, or cost figure was ever
 * recorded for work that customers paid for.
 */

/** Default wall-clock budget for one model attempt, including its retries. */
export const DEFAULT_MODEL_DEADLINE_MS = 60_000;

/** Retryable failures: transient conditions where the same request may succeed. */
const RETRYABLE_ERROR_TYPES = new Set<ModelErrorType>([
  "rate_limit",
  "server_error",
  "transport",
]);

export type ModelCallUsage = {
  provider: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  estimatedCostUsd: number | null;
  attempts: number;
};

export type ModelCallResult = {
  output: ModelRunOutput;
  usage: ModelCallUsage;
};

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly errorType: ModelErrorType,
    readonly modelName: string,
    readonly attempts: number,
    readonly durationMs: number,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export type CallModelOptions = {
  deadlineMs?: number;
  maxAttempts?: number;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
  /**
   * Budget enforcement. When supplied, budget is reserved before the first
   * attempt and settled to the observed cost afterwards.
   *
   * This is the choke point the spend cap needs: every model request in the
   * system routes through `callModel`, so a ceiling enforced here cannot be
   * bypassed by a retry loop, a debug rerun, or any future caller. A refusal
   * propagates as `SpendCapExceededError` and is deliberately not retried —
   * the budget will not have changed by the next attempt.
   */
  spend?: {
    guard: SpendGuard;
    /** Booked up front, then replaced by the actual cost once known. */
    estimatedUsd: number;
    context?: SpendContext;
  };
};

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter. Jitter matters because vendor lanes
 * fan out: without it, concurrent workers that hit the same rate limit would
 * retry in lockstep and collide again.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random) {
  const ceiling = Math.min(8_000, 500 * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

export async function callModel(
  provider: ExtractionProvider,
  input: ModelPromptInput,
  modelId: string,
  options: CallModelOptions = {},
): Promise<ModelCallResult> {
  if (!options.spend) {
    return callModelWithinBudget(provider, input, modelId, options);
  }

  // Reserve before the first attempt. A refusal throws out of here without any
  // provider request being made, which is the point.
  const reservation = await options.spend.guard.reserve(
    "llm_extraction",
    options.spend.estimatedUsd,
    { ...options.spend.context, provider: provider.provider, modelName: modelId },
  );

  let settlement = 0;
  try {
    const result = await callModelWithinBudget(provider, input, modelId, options);
    settlement = result.usage.estimatedCostUsd ?? options.spend.estimatedUsd;
    return result;
  } finally {
    // Settles at zero on failure: an estimate left booked for spend that never
    // happened would turn a transient provider error into a slow outage.
    await options.spend.guard.settle(reservation, settlement);
  }
}

async function callModelWithinBudget(
  provider: ExtractionProvider,
  input: ModelPromptInput,
  modelId: string,
  options: CallModelOptions = {},
): Promise<ModelCallResult> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_MODEL_DEADLINE_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const startedAt = Date.now();
  let attempts = 0;
  let lastError: { errorType: ModelErrorType; errorMessage: string } | null = null;

  while (attempts < maxAttempts) {
    attempts += 1;

    const remainingMs = deadlineMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);

    let result;
    try {
      result = await provider.run(input, modelId, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!isModelError(result)) {
      const durationMs = Date.now() - startedAt;
      const estimated =
        result.estimatedCostUsd ??
        estimateCost(result.modelName, result.inputTokens, result.outputTokens)?.costUsd ??
        null;

      return {
        output: result,
        usage: {
          provider: provider.provider,
          modelName: result.modelName,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs,
          estimatedCostUsd: estimated,
          attempts,
        },
      };
    }

    lastError = { errorType: result.errorType, errorMessage: result.errorMessage };

    const canRetry = RETRYABLE_ERROR_TYPES.has(result.errorType) && attempts < maxAttempts;
    if (!canRetry) {
      break;
    }

    const delay = retryDelayMs(attempts, random);
    if (Date.now() - startedAt + delay >= deadlineMs) {
      break;
    }

    await sleep(delay);
  }

  const durationMs = Date.now() - startedAt;
  throw new ModelCallError(
    lastError?.errorMessage ?? `Model call exceeded its ${deadlineMs}ms deadline.`,
    lastError?.errorType ?? "timeout",
    modelId,
    attempts,
    durationMs,
  );
}

/** Sums per-attempt usage into one record for a multi-attempt extraction. */
export function combineUsage(usages: ModelCallUsage[]): ModelCallUsage | null {
  if (usages.length === 0) {
    return null;
  }

  const last = usages[usages.length - 1];

  return {
    provider: last.provider,
    modelName: last.modelName,
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    durationMs: usages.reduce((sum, usage) => sum + usage.durationMs, 0),
    estimatedCostUsd: usages.reduce<number | null>((sum, usage) => {
      if (usage.estimatedCostUsd === null) {
        return sum;
      }
      return (sum ?? 0) + usage.estimatedCostUsd;
    }, null),
    attempts: usages.reduce((sum, usage) => sum + usage.attempts, 0),
  };
}
