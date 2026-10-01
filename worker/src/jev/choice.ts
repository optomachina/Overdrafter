import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ChoiceQuestion = { state: JsonValue; instructions: string; criteria: Record<string, string> };
export type ChoiceDecision = {
  choice: string; confidence: number; probabilities: Record<string, number>;
  model: string; inputTokens: number; outputTokens: number;
};
export type ChoiceDecider = (question: ChoiceQuestion, signal: AbortSignal) => Promise<ChoiceDecision>;
export const JEV_MODEL = "jev-1.13.0";
const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  model: z.literal(JEV_MODEL),
  answers: z.object({ target: z.object({
    type: z.literal("choice"), choice: z.string(), confidence: probability,
    probabilities: z.record(probability),
  }).strict() }).strict(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict(),
}).strict();


/** Rejects missing/invented options, nonfinite probabilities, wrong model, and inconsistent winners. */
export function validateChoiceDecision(decision: ChoiceDecision, options: string[]): boolean {
  const keys = Object.keys(decision.probabilities).sort();
  const values = Object.values(decision.probabilities);
  return decision.model === JEV_MODEL
    && Number.isFinite(decision.confidence) && decision.confidence >= 0 && decision.confidence <= 1
    && Number.isSafeInteger(decision.inputTokens) && decision.inputTokens >= 0
    && Number.isSafeInteger(decision.outputTokens) && decision.outputTokens >= 0
    && JSON.stringify(keys) === JSON.stringify([...options].sort())
    && options.includes(decision.choice)
    && values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 0.0001
    && decision.probabilities[decision.choice] === Math.max(...values);
}

/**
 * Server-only bounded transport. Callers own data authorization, projection, budgets and auditing.
 * Fixed endpoint/model; no redirects or retries. No raw response/error is exposed.
 */
export function createJevChoiceDecider(apiKey: string): ChoiceDecider {
  if (!apiKey.trim()) throw new Error("jev_credential_missing");
  return async (question, callerSignal) => {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(5_000)]);
    const options = Object.keys(question.criteria);
    if (options.length < 2 || options.length > 64 || options.some((key) => !/^[a-zA-Z0-9_]{1,64}$/.test(key))
      || Object.values(question.criteria).some((value) => typeof value !== "string")) throw new Error("jev_invalid_question");
    let body: string;
    try {
      body = JSON.stringify({ model: JEV_MODEL, state: question.state,
        questions: { target: { type: "choice", instructions: question.instructions, criteria: question.criteria } } });
    } catch { throw new Error("jev_invalid_question"); }
    if (Buffer.byteLength(body) > 8_192) throw new Error("jev_request_budget");
    try {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body,
    });
    if (!response.ok || !response.body) throw new Error("jev_service_unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 16_384) throw new Error("jev_response_budget");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

      const parsed = responseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) throw new Error("invalid");
      const { model, answers: { target }, usage } = parsed.data;
      const decision = { ...target, model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
      if (!validateChoiceDecision(decision, options)) throw new Error("invalid");
      return decision;
    } catch {
      throw new Error("jev_request_failed");
    }
  };
}
