import { validateChoiceAnswer, validateNoulAnswer, type ValidChoice } from "../questions.js";
import { HEAD_FOR_OP, type BuiltRequest } from "./request.js";
import type { DriverOp, GateHit, StopReason } from "./types.js";

/**
 * Answer validation and gates (§8.3, §10). Pure. Only heads the chosen
 * operation needs are validated; a needed head that is missing or invalid is
 * `invalid_decision`. A low-confidence answer is always a stop, never an
 * argmax action, and no threshold can reach an element code did not offer.
 */
export const DECISION_THRESHOLDS = Object.freeze({
  op: 0.8, click: 0.85, fill: 0.8, select: 0.8, maxNone: 0.1, controlPresent: 0.7,
});

export type DecisionEvidence = {
  opConfidence: number | null;
  reversedAgrees: boolean | null;
  targetProbability: number | null;
  noneProbability: number | null;
  controlPresent: number | null;
  gates: GateHit[];
};

export type TargetOp = "CLICK" | "FILL_REQUIRED_VALUE" | "SELECT_REQUIRED_VALUE";
export type Decision =
  | { kind: "act"; op: TargetOp; targetId: string; evidence: DecisionEvidence }
  | { kind: "wait"; op: "WAIT"; evidence: DecisionEvidence }
  | { kind: "done"; op: "DONE"; evidence: DecisionEvidence }
  | { kind: "blocked"; op: "BLOCKED"; evidence: DecisionEvidence }
  | { kind: "stop"; reason: Extract<StopReason, "low_confidence" | "invalid_decision" | "ambiguous_duplicate">; op: DriverOp | null; evidence: DecisionEvidence };

/** `(p_max - 1/n) / (1 - 1/n)`, where n counts every offered option including `none`. */
export function normalizedConfidence(answer: ValidChoice) {
  const n = Object.keys(answer.probabilities).length;
  if (n <= 1) return 1;
  return Math.max(0, (answer.probabilities[answer.choice] - 1 / n) / (1 - 1 / n));
}

export function decideFromAnswers(answers: Record<string, unknown>, built: BuiltRequest, classSize: (id: string) => number): Decision {
  const evidence: DecisionEvidence = { opConfidence: null, reversedAgrees: null, targetProbability: null, noneProbability: null, controlPresent: null, gates: [] };
  const stop = (reason: Extract<StopReason, "low_confidence" | "invalid_decision" | "ambiguous_duplicate">, op: DriverOp | null): Decision => {
    if (reason === "low_confidence") evidence.gates.push("low_confidence");
    if (reason === "ambiguous_duplicate") evidence.gates.push("duplicate");
    return { kind: "stop", reason, op, evidence };
  };
  const opAnswer = validateChoiceAnswer(answers.op, built.heads.op ?? []);
  const reversed = validateChoiceAnswer(answers.op_reversed, built.heads.op_reversed ?? []);
  if (!opAnswer || !reversed) return stop("invalid_decision", null);
  const op = opAnswer.choice as DriverOp;
  evidence.opConfidence = normalizedConfidence(opAnswer);
  evidence.reversedAgrees = reversed.choice === op;
  if (evidence.opConfidence < DECISION_THRESHOLDS.op || !evidence.reversedAgrees) return stop("low_confidence", op);
  if (op === "WAIT") return { kind: "wait", op, evidence };
  if (op === "DONE") return { kind: "done", op, evidence };
  if (op === "BLOCKED") return { kind: "blocked", op, evidence };
  const head = HEAD_FOR_OP[op];
  const target = head ? validateChoiceAnswer(answers[head], built.heads[head] ?? []) : null;
  if (!head || !target) return stop("invalid_decision", op);
  const confidence = normalizedConfidence(target);
  evidence.targetProbability = target.probabilities[target.choice];
  evidence.noneProbability = target.probabilities.none ?? null;
  if (target.choice === "none") return stop("low_confidence", op);
  if (op === "CLICK") {
    if (confidence < DECISION_THRESHOLDS.click || (evidence.noneProbability ?? 1) > DECISION_THRESHOLDS.maxNone) return stop("low_confidence", op);
    if (built.heads.click_target_r) {
      const again = validateChoiceAnswer(answers.click_target_r, built.heads.click_target_r);
      if (!again) return stop("invalid_decision", op);
      if (again.choice !== target.choice) return stop("low_confidence", op);
    }
  } else if (op === "FILL_REQUIRED_VALUE") {
    if (confidence < DECISION_THRESHOLDS.fill || (evidence.noneProbability ?? 1) > DECISION_THRESHOLDS.maxNone) return stop("low_confidence", op);
    const present = validateNoulAnswer(answers.control_present);
    if (present === null) return stop("invalid_decision", op);
    evidence.controlPresent = present;
    if (present < DECISION_THRESHOLDS.controlPresent) return stop("low_confidence", op);
  } else if (confidence < DECISION_THRESHOLDS.select) {
    return stop("low_confidence", op);
  }
  if (classSize(target.choice) !== 1) return stop("ambiguous_duplicate", op);
  return { kind: "act", op, targetId: target.choice, evidence };
}
