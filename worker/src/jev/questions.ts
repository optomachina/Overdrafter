/**
 * Multi-question TypeSafe transport for the Jev quote driver (benchmark
 * prototype). `choice.ts` stays the single-question transport for existing
 * callers; this one carries an operation head, speculative target heads and a
 * noul in one request, as docs/jev-quote-driver.md §8.4 describes.
 *
 * Server-only. Fixed endpoint, pinned model, no redirects, 5 s deadline, one
 * retry on 429/529 inside the deadline. The API key is captured in a closure
 * and never appears in an error, receipt or return value.
 */
import { z } from "zod";
import type { JsonValue } from "./choice.js";

export const JEV_DRIVER_MODELS = ["jev-1.13.0", "jev-1.14.0"] as const;
export type JevDriverModel = (typeof JEV_DRIVER_MODELS)[number];

export type ChoiceQuestionSpec = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};
export type NoulQuestionSpec = { type: "noul"; instructions: string };
export type QuestionSpec = ChoiceQuestionSpec | NoulQuestionSpec;
export type QuestionsRequest = { state: JsonValue; questions: Record<string, QuestionSpec> };

export type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> };
export type NoulAnswer = { noul: number };

export type QuestionsResult = {
  model: string;
  /** Raw answers keyed by question name. Validate each used head with `validateChoiceAnswer`. */
  answers: Record<string, unknown>;
  /** Reported by the API; null when the API omitted it. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** ceil(bytes / 2) of the request body, charged when `inputTokens` is null. */
  estimatedTokens: number;
  requestId: string | null;
  latencyMs: number;
  requestBytes: number;
};

export type QuestionsDecider = (request: QuestionsRequest, signal: AbortSignal) => Promise<QuestionsResult>;

export const JEV_TRANSPORT_ERRORS = [
  "jev_rate_limited", "jev_rejected_4xx", "jev_unavailable", "jev_invalid_response", "jev_request_budget", "jev_timeout",
] as const;
export type JevTransportErrorCode = (typeof JEV_TRANSPORT_ERRORS)[number];

export class JevTransportError extends Error {
  constructor(readonly code: JevTransportErrorCode, readonly status: number | null = null) {
    super(code);
    this.name = "JevTransportError";
  }
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const OPTION_KEY = /^[A-Za-z0-9_]{1,64}$/;
export const MAX_REQUEST_ESTIMATED_TOKENS = 6_000;
const MAX_RESPONSE_BYTES = 65_536;
const DEADLINE_MS = 5_000;

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().nullable().optional(),
    output_tokens: z.number().int().nonnegative().nullable().optional(),
  }).nullable().optional(),
});

export function estimateTokens(body: string) {
  return Math.ceil(Buffer.byteLength(body) / 2);
}

/** Throws `jev_request_budget` for an oversized or malformed request; returns the serialized body. */
export function serializeQuestions(model: JevDriverModel, request: QuestionsRequest) {
  const names = Object.keys(request.questions);
  if (names.length < 1 || names.length > 32) throw new JevTransportError("jev_request_budget");
  for (const question of Object.values(request.questions)) {
    if (question.type !== "choice") continue;
    const keys = Object.keys(question.criteria);
    if (keys.length < 1 || keys.length > 255 || keys.some((key) => !OPTION_KEY.test(key))) {
      throw new JevTransportError("jev_request_budget");
    }
  }
  const body = JSON.stringify({ model, state: request.state, questions: request.questions });
  if (estimateTokens(body) > MAX_REQUEST_ESTIMATED_TOKENS) throw new JevTransportError("jev_request_budget");
  return body;
}

/**
 * Validates one used choice head (§8.3): offered keys exactly, finite
 * probabilities in [0,1] summing to 1 within 0.02, a choice at the maximum.
 */
export function validateChoiceAnswer(answer: unknown, offered: readonly string[]): ChoiceAnswer | null {
  if (!answer || typeof answer !== "object") return null;
  const candidate = answer as { choice?: unknown; confidence?: unknown; probabilities?: unknown };
  if (typeof candidate.choice !== "string" || !candidate.probabilities || typeof candidate.probabilities !== "object") return null;
  const probabilities = candidate.probabilities as Record<string, unknown>;
  const keys = Object.keys(probabilities).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...offered].sort())) return null;
  const values = keys.map((key) => probabilities[key]);
  if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.02) return null;
  if (!offered.includes(candidate.choice)) return null;
  const max = Math.max(...values);
  if ((probabilities[candidate.choice] as number) < max - 1e-6) return null;
  const confidence = typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence)
    && candidate.confidence >= 0 && candidate.confidence <= 1 ? candidate.confidence : null;
  if (confidence === null) return null;
  return { choice: candidate.choice, confidence, probabilities: Object.fromEntries(keys.map((key) => [key, probabilities[key] as number])) };
}

export function validateNoulAnswer(answer: unknown): NoulAnswer | null {
  if (!answer || typeof answer !== "object") return null;
  const value = (answer as { noul?: unknown }).noul;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? { noul: value } : null;
}

async function readBounded(response: Response) {
  if (!response.body) throw new JevTransportError("jev_invalid_response", response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new JevTransportError("jev_invalid_response", response.status);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Builds a keyed decider. The key never leaves this closure. */
export function createJevQuestionsDecider(apiKey: string, model: JevDriverModel): QuestionsDecider {
  if (!apiKey.trim()) throw new Error("jev_credential_missing");
  if (!JEV_DRIVER_MODELS.includes(model)) throw new Error("jev_model_not_pinned");
  return async (request, callerSignal) => {
    const body = serializeQuestions(model, request);
    const deadline = AbortSignal.any([callerSignal, AbortSignal.timeout(DEADLINE_MS)]);
    const started = performance.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST", redirect: "error", signal: deadline,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body,
        });
      } catch {
        throw new JevTransportError(deadline.aborted ? "jev_timeout" : "jev_unavailable");
      }
      if (response.status === 429 || response.status === 529) {
        await response.body?.cancel().catch(() => undefined);
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250;
        if (attempt === 0 && performance.now() - started + waitMs < DEADLINE_MS - 500) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw new JevTransportError("jev_rate_limited", response.status);
      }
      if (response.status >= 400 && response.status < 500) {
        await response.body?.cancel().catch(() => undefined);
        throw new JevTransportError("jev_rejected_4xx", response.status);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new JevTransportError("jev_unavailable", response.status);
      }
      let parsed: z.infer<typeof responseSchema>;
      try {
        const result = responseSchema.safeParse(JSON.parse(await readBounded(response)));
        if (!result.success) throw new Error("invalid");
        parsed = result.data;
      } catch (error) {
        if (error instanceof JevTransportError) throw error;
        throw new JevTransportError("jev_invalid_response", response.status);
      }
      return {
        model: parsed.model,
        answers: parsed.answers,
        inputTokens: parsed.usage?.input_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? null,
        estimatedTokens: estimateTokens(body),
        requestId: response.headers.get("x-typesafe-request-id") ?? response.headers.get("x-request-id"),
        latencyMs: Math.round(performance.now() - started),
        requestBytes: Buffer.byteLength(body),
      };
    }
    throw new JevTransportError("jev_rate_limited");
  };
}
