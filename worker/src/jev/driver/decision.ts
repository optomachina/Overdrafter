/**
 * Answer validation and gates (docs/jev-quote-driver.md §8.3, §10). Pure.
 * A stop on low confidence is always a stop, never an argmax action.
 */
import { validateChoiceAnswer, validateNoulAnswer } from "../questions.js";
import { normalizedConfidence, type DriverOp } from "./policy.js";
import type { BuiltCycleRequest } from "./request.js";

export const GATES = {
  op: 0.8,
  click: 0.85,
  fill: 0.8,
  select: 0.8,
  pNone: 0.1,
  controlPresent: 0.7,
  save: 0.85,
  dismiss: 0.8,
} as const;

export type DecisionMetrics = {
  op: string | null;
  opConfidence: number | null;
  opReversedAgrees: boolean | null;
  target: string | null;
  targetProbability: number | null;
  targetConfidence: number | null;
  pNone: number | null;
  reversedTargetAgrees: boolean | null;
  controlPresent: number | null;
};

export type GateResult =
  | { kind: "act"; op: DriverOp; target: string | null; metrics: DecisionMetrics }
  | { kind: "stop"; reason: "invalid_decision" | "low_confidence" | "blocked"; detail: string; metrics: DecisionMetrics };

const emptyMetrics = (): DecisionMetrics => ({
  op: null, opConfidence: null, opReversedAgrees: null, target: null, targetProbability: null, targetConfidence: null,
  pNone: null, reversedTargetAgrees: null, controlPresent: null,
});

export function gateCycleDecision(built: BuiltCycleRequest, answers: Record<string, unknown>): GateResult {
  const metrics = emptyMetrics();
  const op = validateChoiceAnswer(answers.op, built.offeredOps);
  const opReversed = validateChoiceAnswer(answers.op_reversed, built.offeredOps);
  if (!op || !opReversed) return { kind: "stop", reason: "invalid_decision", detail: "op", metrics };
  metrics.op = op.choice;
  metrics.opConfidence = normalizedConfidence(op.probabilities);
  metrics.opReversedAgrees = op.choice === opReversed.choice;
  const present = validateNoulAnswer(answers.control_present);
  metrics.controlPresent = present?.noul ?? null;
  if (metrics.opConfidence < GATES.op || !metrics.opReversedAgrees) {
    return { kind: "stop", reason: "low_confidence", detail: "op", metrics };
  }
  const chosen = op.choice as DriverOp;
  const head = chosen === "CLICK" ? "click" : chosen === "FILL_REQUIRED_VALUE" ? "fill" : chosen === "SELECT_REQUIRED_VALUE" ? "select" : null;
  if (head === null) {
    if (chosen === "BLOCKED") return { kind: "stop", reason: "blocked", detail: "model_blocked", metrics };
    return { kind: "act", op: chosen, target: null, metrics };
  }
  const keys = built.heads[head];
  const answer = validateChoiceAnswer(answers[`${head}_target`], keys);
  if (!answer) return { kind: "stop", reason: "invalid_decision", detail: `${head}_target`, metrics };
  metrics.target = answer.choice;
  metrics.targetProbability = answer.probabilities[answer.choice] ?? null;
  metrics.targetConfidence = normalizedConfidence(answer.probabilities);
  metrics.pNone = answer.probabilities.none ?? 0;
  if (answer.choice === "none") return { kind: "stop", reason: "low_confidence", detail: `${head}_none`, metrics };
  if (metrics.pNone > GATES.pNone) return { kind: "stop", reason: "low_confidence", detail: `${head}_p_none`, metrics };
  if (head === "click") {
    if (metrics.targetConfidence < GATES.click) return { kind: "stop", reason: "low_confidence", detail: "click_target", metrics };
    if (built.reversedClickHead) {
      const reversed = validateChoiceAnswer(answers.click_target_r, keys);
      if (!reversed) return { kind: "stop", reason: "invalid_decision", detail: "click_target_r", metrics };
      metrics.reversedTargetAgrees = reversed.choice === answer.choice;
      if (!metrics.reversedTargetAgrees) return { kind: "stop", reason: "low_confidence", detail: "click_target_r", metrics };
    }
  } else if (head === "fill") {
    if (metrics.targetConfidence < GATES.fill) return { kind: "stop", reason: "low_confidence", detail: "fill_target", metrics };
    if ((metrics.controlPresent ?? 0) < GATES.controlPresent) return { kind: "stop", reason: "low_confidence", detail: "control_present", metrics };
  } else if (metrics.targetConfidence < GATES.select) {
    return { kind: "stop", reason: "low_confidence", detail: "select_target", metrics };
  }
  return { kind: "act", op: chosen, target: answer.choice, metrics };
}

export function gateSaveDecision(keys: string[], answers: Record<string, unknown>): GateResult {
  const metrics = emptyMetrics();
  const forward = validateChoiceAnswer(answers.save_target, keys);
  const reversed = validateChoiceAnswer(answers.save_target_r, keys);
  if (!forward || !reversed) return { kind: "stop", reason: "invalid_decision", detail: "save_target", metrics };
  metrics.target = forward.choice;
  metrics.targetProbability = forward.probabilities[forward.choice] ?? null;
  metrics.targetConfidence = normalizedConfidence(forward.probabilities);
  metrics.pNone = forward.probabilities.none ?? 0;
  metrics.reversedTargetAgrees = forward.choice === reversed.choice;
  if (forward.choice === "none" || metrics.pNone > GATES.pNone || metrics.targetConfidence < GATES.save || !metrics.reversedTargetAgrees) {
    return { kind: "stop", reason: "low_confidence", detail: "save_target", metrics };
  }
  return { kind: "act", op: "CLICK", target: forward.choice, metrics };
}

export function gateOverlayDecision(candidates: string[], answers: Record<string, unknown>): GateResult {
  const metrics = emptyMetrics();
  const scored: Array<[string, number]> = [];
  for (const id of candidates) {
    const answer = validateNoulAnswer(answers[`dismiss_${id}`]);
    if (!answer) return { kind: "stop", reason: "invalid_decision", detail: `dismiss_${id}`, metrics };
    scored.push([id, answer.noul]);
  }
  const best = scored.reduce<[string, number] | null>((top, entry) => (top === null || entry[1] > top[1] ? entry : top), null);
  if (!best || best[1] < GATES.dismiss) return { kind: "stop", reason: "low_confidence", detail: "dismiss", metrics };
  metrics.target = best[0];
  metrics.targetProbability = best[1];
  return { kind: "act", op: "CLICK", target: best[0], metrics };
}
