import { createHash } from "node:crypto";
import { validateChoiceDecision, type ChoiceDecision } from "../jev/choice.js";

export type Question = { state: unknown; instructions: string; criteria: Record<string, string> };
export type Decision = ChoiceDecision;
export type ChoiceProvider = (question: Question, signal: AbortSignal) => Promise<Decision>;
export type Decide = (question: Question, baseline: string) => Promise<string>;
export type DecisionMode = "off" | "shadow" | "apply";
export type DecisionAudit = {
  questionHash: string; mode: DecisionMode; baseline: string; proposed: string | null;
  selected: string; reason: string; model: string | null; elapsedMs: number; inputTokens: number; outputTokens: number;
};

/** Per-review budget. No raw source text, credentials, or service error messages enter audit records. */
export function createDecisionSession(options: {
  mode?: DecisionMode; provider?: ChoiceProvider; maxCalls?: number; maxRequestBytes?: number;
  timeoutMs?: number; maxInputTokens?: number; minConfidence?: number;
} = {}) {
  const mode = options.mode ?? "off";
  const maxCalls = options.maxCalls ?? 32;
  const maxBytes = options.maxRequestBytes ?? 8192;
  const timeoutMs = options.timeoutMs ?? 1500;
  const maxTokens = options.maxInputTokens ?? 65536;
  const confidence = options.minConfidence ?? 0.9;
  if (!["off", "shadow", "apply"].includes(mode)
    || ![maxCalls, maxBytes, timeoutMs, maxTokens].every((v) => Number.isSafeInteger(v) && v > 0)
    || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("invalid_decision_config");
  const audit: DecisionAudit[] = [];
  let calls = 0;
  let reservedTokens = 0;
  const decide: Decide = async (question, baseline) => {
    const started = performance.now();
    const serialized = JSON.stringify(question);
    const bytes = Buffer.byteLength(serialized);
    const criteria = Object.keys(question.criteria);
    const row: DecisionAudit = { questionHash: createHash("sha256").update(serialized).digest("hex"), mode,
      baseline, proposed: null, selected: baseline, reason: "off", model: null, elapsedMs: 0, inputTokens: 0, outputTokens: 0 };
    const finish = (reason: string) => {
      row.reason = reason; row.elapsedMs = Math.round(performance.now() - started); audit.push(row); return row.selected;
    };
    if (!criteria.includes(baseline) || criteria.length < 2 || criteria.length > 64) return finish("invalid_options");
    if (mode === "off") return finish("off");
    if (!options.provider) return finish("unconfigured");
    // UTF-8 bytes conservatively reserve token budget, including a fixed framing allowance.
    const reservation = bytes + 512;
    if (bytes > maxBytes || calls >= maxCalls || reservedTokens + reservation > maxTokens) return finish("budget");
    calls += 1; reservedTokens += reservation;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
      });
      const answer = await Promise.race([options.provider(question, controller.signal), timeout]);
      if (!validDecision(answer, criteria)) return finish("invalid_response");
      row.model = answer.model; row.inputTokens = answer.inputTokens; row.outputTokens = answer.outputTokens;
      row.proposed = answer.choice;
      if (answer.inputTokens > reservation) { reservedTokens = maxTokens; return finish("usage_budget"); }
      if (answer.confidence < confidence || answer.probabilities[answer.choice] < confidence) return finish("uncertain");
      if (mode === "apply") row.selected = answer.choice;
      return finish(mode === "shadow" ? "shadow" : "selected");
    } catch {
      return finish(controller.signal.aborted ? "timeout" : "service_error");
    } finally { if (timer) clearTimeout(timer); }
  };
  return { decide, audit };
}

/** Injected providers receive the same pinned-distribution checks as network responses. */
function validDecision(answer: Decision, criteria: string[]): boolean {
  try { return validateChoiceDecision(answer, criteria); } catch { return false; }
}
