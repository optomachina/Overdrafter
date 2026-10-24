import { z } from "zod";
import type { JsonValue } from "./choice.js";

/**
 * Multi-question Jev transport for the quote driver (docs/jev-quote-driver.md §8.4).
 *
 * Driver-only. Existing callers keep `choice.ts`. Differences from it: several
 * named questions per request, `null` criteria, a token-estimated request
 * budget, non-strict response schemas, nullable usage, one bounded retry on
 * 429/529, and distinct error codes. The key is used only for the one header
 * and never appears in an error, a result or a receipt.
 */
export const JEV_DRIVER_MODEL = "jev-1.13.0";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DRIVER_TRANSPORT_LIMITS = Object.freeze({
  deadlineMs: 5_000,
  /** Estimated tokens, `ceil(bytes / 2)`. About 12 KB of JSON. */
  requestTokens: 6_000,
  responseBytes: 65_536,
});

export type ChoiceQuestionSpec = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type NoulQuestionSpec = { type: "noul"; instructions: string };
export type QuestionSpec = ChoiceQuestionSpec | NoulQuestionSpec;
export type QuestionsRequest = { state: JsonValue; questions: Record<string, QuestionSpec> };
export type QuestionsResponse = {
  model: typeof JEV_DRIVER_MODEL;
  /** Unvalidated per-question answers. Callers validate only the heads they use. */
  answers: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  /** True when the service returned no usage and the estimate was charged. */
  estimatedUsage: boolean;
  requestId: string | null;
};
export type QuestionsDecider = (request: QuestionsRequest, signal: AbortSignal) => Promise<QuestionsResponse>;

export const JEV_TRANSPORT_ERRORS = [
  "jev_rate_limited", "jev_rejected_4xx", "jev_unavailable", "jev_invalid_response", "jev_request_budget", "jev_invalid_question",
] as const;
export type JevTransportErrorCode = (typeof JEV_TRANSPORT_ERRORS)[number];
export class JevTransportError extends Error {
  constructor(public readonly code: JevTransportErrorCode) {
    super(code);
    this.name = "JevTransportError";
  }
}

const OPTION_KEY = /^[A-Za-z0-9_]{1,64}$/;
const QUESTION_KEY = /^[A-Za-z0-9_]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const count = z.number().int().nonnegative();
const envelope = z.object({
  model: z.literal(JEV_DRIVER_MODEL),
  answers: z.record(z.unknown()),
  usage: z.object({ input_tokens: count, output_tokens: count.nullish() }).nullish(),
});

export function estimateRequestTokens(body: string) {
  return Math.ceil(Buffer.byteLength(body) / 2);
}

/** Serializes a request or throws a fixed code. Exported so the loop can budget before it calls. */
export function serializeQuestionsRequest(request: QuestionsRequest) {
  const entries = Object.entries(request.questions);
  if (entries.length < 1 || entries.length > 32) throw new JevTransportError("jev_invalid_question");
  for (const [id, question] of entries) {
    if (!QUESTION_KEY.test(id) || !question.instructions.trim()) throw new JevTransportError("jev_invalid_question");
    if (question.type === "choice") {
      const keys = Object.keys(question.criteria);
      if (keys.length < 1 || keys.length > 255 || keys.some((key) => !OPTION_KEY.test(key))
        || Object.values(question.criteria).some((value) => value !== null && typeof value !== "string")) {
        throw new JevTransportError("jev_invalid_question");
      }
    }
  }
  let body: string;
  try {
    body = JSON.stringify({ model: JEV_DRIVER_MODEL, state: request.state, questions: request.questions });
  } catch {
    throw new JevTransportError("jev_invalid_question");
  }
  const estimatedTokens = estimateRequestTokens(body);
  if (estimatedTokens > JEV_DRIVER_TRANSPORT_LIMITS.requestTokens) throw new JevTransportError("jev_request_budget");
  return { body, estimatedTokens };
}

export type ValidChoice = { choice: string; probabilities: Record<string, number>; reportedConfidence: number };

/**
 * §8.3: the choice is offered, probability keys equal the offered keys, each
 * value is finite in [0, 1], the sum is within 0.02 of 1 (jev-1.14.0 returned
 * 0.99), and the chosen option carries the maximum probability.
 */
// Code-unit order: the comparison only checks set equality, so locale order is irrelevant.
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function validateChoiceAnswer(answer: unknown, offered: readonly string[]): ValidChoice | null {
  if (!answer || typeof answer !== "object") return null;
  const { type, choice, confidence, probabilities } = answer as Record<string, unknown>;
  if (type !== "choice" || typeof choice !== "string" || !probabilities || typeof probabilities !== "object") return null;
  const entries = Object.entries(probabilities as Record<string, unknown>);
  const keys = entries.map(([key]) => key).sort(compareCodeUnits);
  if (JSON.stringify(keys) !== JSON.stringify([...offered].sort(compareCodeUnits)) || !offered.includes(choice)) return null;
  const values: number[] = [];
  for (const [, value] of entries) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
    values.push(value);
  }
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02) return null;
  const typed = probabilities as Record<string, number>;
  if (typed[choice] < Math.max(...values) - 1e-6) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { choice, probabilities: { ...typed }, reportedConfidence: confidence };
}

export function validateNoulAnswer(answer: unknown): number | null {
  if (!answer || typeof answer !== "object") return null;
  const { type, noul } = answer as Record<string, unknown>;
  return type === "noul" && typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : null;
}

function retryAfterMs(response: Response) {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 250;
}

async function readBounded(response: Response) {
  if (!response.body) throw new JevTransportError("jev_invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > JEV_DRIVER_TRANSPORT_LIMITS.responseBytes) throw new JevTransportError("jev_invalid_response");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Builds the keyed transport. Hosts call this; the key never enters the
 * driver. Fixed endpoint and model, redirects rejected, one deadline covering
 * the retry.
 */
export function createJevQuestionsDecider(apiKey: string): QuestionsDecider {
  if (!apiKey.trim()) throw new Error("jev_credential_missing");
  return async (request, callerSignal) => {
    const { body, estimatedTokens } = serializeQuestionsRequest(request);
    const deadline = Date.now() + JEV_DRIVER_TRANSPORT_LIMITS.deadlineMs;
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(JEV_DRIVER_TRANSPORT_LIMITS.deadlineMs)]);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(JEV_ENDPOINT, {
          method: "POST", redirect: "error", signal, body,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        });
      } catch {
        throw new JevTransportError("jev_unavailable");
      }
      if (response.status === 429 || response.status === 529) {
        await response.body?.cancel().catch(() => undefined);
        const wait = retryAfterMs(response);
        if (attempt === 0 && Date.now() + wait < deadline - 200) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        throw new JevTransportError("jev_rate_limited");
      }
      if (response.status >= 400 && response.status < 500) {
        await response.body?.cancel().catch(() => undefined);
        throw new JevTransportError("jev_rejected_4xx");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new JevTransportError("jev_unavailable");
      }
      let text: string;
      try {
        text = await readBounded(response);
      } catch (error) {
        throw error instanceof JevTransportError ? error : new JevTransportError("jev_unavailable");
      }
      let parsed: z.infer<typeof envelope>;
      try {
        parsed = envelope.parse(JSON.parse(text));
      } catch {
        throw new JevTransportError("jev_invalid_response");
      }
      const requestId = response.headers.get("x-typesafe-request-id");
      return {
        model: parsed.model,
        answers: parsed.answers,
        inputTokens: parsed.usage?.input_tokens ?? estimatedTokens,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        estimatedUsage: !parsed.usage,
        requestId: requestId && REQUEST_ID.test(requestId) && !requestId.includes(apiKey) ? requestId : null,
      };
    }
  };
}
