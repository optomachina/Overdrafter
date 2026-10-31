import { serializeQuestionsRequest, JevTransportError, type QuestionsResponse } from "../questions.js";
import { decideFromAnswers, type DecisionEvidence } from "./decision.js";
import { compatibleTargets, deniedText, equivalenceKey, fieldOf, optionMatch, valueState, type OpContext } from "./policy.js";
import { admissibleElements, hashJson, MAX_ADMISSIBLE_ELEMENTS, projectElement, type ProjectedElement } from "./projection.js";
import { buildDriverRequest, type RecentAction } from "./request.js";
import { SNAPSHOT_REVISION } from "./snapshot.js";
import {
  CONFIG_FIELD_ORDER, DRIVER_LIMITS, DRIVER_REVISION,
  type ConfigField, type DriverBinding, type DriverCycleReceipt, type DriverField, type DriverOp, type DriverOutcome,
  type DriverSurface, type FieldSpec, type GateHit, type JevDriverCapability, type LocatorCandidate, type RawElement,
  type RawObservation, type StopReason, type SubGoalStatus,
} from "./types.js";

/**
 * The driver state machine (docs/jev-quote-driver.md §4, §11, §13-§16).
 * Code owns sub-goal order and status, every value, every rail and every
 * verification. A model answer can only pick an offered operation and an
 * offered element id; DONE is a proposal that code re-verifies from a fresh
 * observation.
 */
export const TYPESAFE_PRICE_PER_INPUT_TOKEN_USD = 0.042e-6;
export const TYPESAFE_PRICE_SOURCE = "docs.typesafe.ai/models, jev-1.13.0, $0.042 per million input tokens, output free (checked 2026-10-23)";

type Verification = { result: "match" | "differs" | "unknown"; term: string | null; node: string | null };
type Plan = { op: "CLICK" | "FILL_REQUIRED_VALUE" | "SELECT_REQUIRED_VALUE"; targetId: string; decidedBy: "code" | "jev"; evidence: DecisionEvidence | null };

const NO_EVIDENCE: DecisionEvidence = { opConfidence: null, reversedAgrees: null, targetProbability: null, noneProbability: null, controlPresent: null, gates: [] };
const UNITS_LABEL = { mm: /\b(mm|millimet(er|re)s?)\b/i, inch: /\b(in|inch|inches)\b/i } as const;

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function locatorKind(selector: string): LocatorCandidate["kind"] {
  if (selector.startsWith("[data-testid")) return "test_id";
  if (selector.startsWith("role=")) return "role";
  if (selector.includes(":text-is(")) return "label_anchor";
  return "stable_attribute";
}

export async function runQuoteDriver(input: {
  surface: DriverSurface; binding: DriverBinding; capability: JevDriverCapability; now?: () => number;
}): Promise<DriverOutcome> {
  const { surface, binding, capability } = input;
  const now = input.now ?? Date.now;
  const limits = Object.freeze({ ...DRIVER_LIMITS, ...(capability.limits ?? {}) });
  const signal = binding.signal ?? new AbortController().signal;
  const specs = new Map(binding.fields.map((spec) => [spec.field, spec]));
  const order = CONFIG_FIELD_ORDER.filter((field) => specs.has(field));
  const status: Partial<Record<ConfigField, SubGoalStatus>> = Object.fromEntries(order.map((field) => [field, "pending"]));
  const matched: Partial<Record<ConfigField, string>> = {};
  const verifiedNode: Partial<Record<ConfigField, string>> = {};
  const filledNode: Partial<Record<ConfigField, string>> = {};
  const termIndex: Partial<Record<ConfigField, number>> = {};
  const fills: Partial<Record<ConfigField, number>> = {};
  const acted = new Set<ConfigField>();
  const cycles: Partial<Record<DriverField, number>> = {};
  const regressions: Partial<Record<ConfigField, number>> = {};
  const gateHits: Partial<Record<GateHit, number>> = {};
  const cycleTimes: number[] = [];
  const recent: RecentAction[] = [];
  const counters = { calls: 0, codeDecisions: 0, actions: 0, inputTokens: 0, outputTokens: 0, stale: 0, noProgress: 0, rejectedDone: 0, modelWaits: 0, codeWaits: 0, largestCall: 0 };
  let tokensEstimated = false;
  let mutationPossible = false;
  let unitsConfirmed = false;
  let cycle = 0;
  const started = now();

  const hit = (gates: GateHit[]) => gates.forEach((gate) => { gateHits[gate] = (gateHits[gate] ?? 0) + 1; });
  const summary = (outcome: "completed" | "stopped", stopReason: StopReason | null) => ({
    schema: "jev-driver-run.v1" as const, revision: DRIVER_REVISION, policyRevision: binding.policyRevision,
    snapshotRevision: SNAPSHOT_REVISION, vocabularyDigest: binding.vocabularyDigest, outcome, stopReason,
    subGoals: { ...status }, cycles: cycle, modelCalls: counters.calls, codeDecisions: counters.codeDecisions, actions: counters.actions,
    inputTokens: counters.inputTokens, outputTokens: counters.outputTokens, tokensEstimated,
    costUsdEstimate: Number((counters.inputTokens * TYPESAFE_PRICE_PER_INPUT_TOKEN_USD).toFixed(8)), priceSource: TYPESAFE_PRICE_SOURCE,
    cycleLatencyMs: { p50: percentile(cycleTimes, 0.5), p95: percentile(cycleTimes, 0.95) },
    elapsedMs: now() - started, gateHits: { ...gateHits },
  });
  let currentField: DriverField | null = null;
  const stop = (reason: StopReason, possible = mutationPossible): DriverOutcome =>
    ({ status: "stopped", reason, field: currentField, mutationPossible: possible, summary: summary("stopped", reason) });
  const audit = async (receipt: DriverCycleReceipt) => {
    try { return (await capability.audit(receipt, signal)) === true; } catch { return false; }
  };
  const receipt = (fields: Partial<DriverCycleReceipt> & Pick<DriverCycleReceipt, "phase" | "outcome">): DriverCycleReceipt => ({
    schema: "jev-driver-cycle.v1", revision: DRIVER_REVISION, cycle, subGoal: currentField ?? "dialog", decidedBy: null,
    observationHash: "", candidateCounts: {}, offeredOps: [], op: null, opConfidence: null, reversedAgrees: null,
    targetProbability: null, noneProbability: null, controlPresent: null, targetId: null, targetGuardHash: null, gates: [],
    pageChanged: null, formStateChanged: null, timingsMs: { observe: 0, model: 0, act: 0, settle: 0 }, model: null,
    inputTokens: null, outputTokens: null, tokensEstimated: false, requestId: null, stopReason: null, ...fields,
  });

  const verify = (field: DriverField, observation: RawObservation): Verification => {
    if (field === "dialog") return { result: observation.dialogs.length === 0 ? "match" : "differs", term: null, node: null };
    const spec = specs.get(field)!;
    const controls = observation.elements.filter((element) => element.role !== "option" && fieldOf(element, binding.fields) === field);
    if (spec.kind === "number") {
      const inputs = controls.filter((element) => element.editable && element.role !== "combobox");
      const chosen = inputs.find((element) => element.id === filledNode[field]) ?? (inputs.length === 1 ? inputs[0] : null);
      if (!chosen) return { result: "unknown", term: null, node: null };
      return chosen.value.trim() === spec.fillValues[0]
        ? { result: "match", term: spec.fillValues[0], node: chosen.id }
        : { result: "differs", term: null, node: chosen.id };
    }
    let differs = false;
    for (const element of controls) {
      const state = valueState(element, spec, binding);
      if (state === "matches_required") return { result: "match", term: binding.matchTerm(element.display, spec.acceptTerms), node: element.id };
      if (state === "differs") differs = true;
    }
    if (differs) return { result: "differs", term: null, node: null };
    const summaryValue = spec.summaryLabel ? binding.summaryField(observation.bodyText, spec.summaryLabel) : null;
    if (summaryValue) {
      const term = binding.matchTerm(summaryValue, spec.acceptTerms);
      return term ? { result: "match", term, node: null } : { result: "differs", term: null, node: null };
    }
    return { result: "unknown", term: null, node: null };
  };

  const observe = async () => {
    try { return await surface.observe(); } catch { return null; }
  };
  /** Code-owned bounded wait: polls every 250 ms while `busy` holds. */
  const waitWhile = async (busy: (observation: RawObservation) => boolean, maxMs: number) => {
    const deadline = now() + maxMs;
    while (now() < deadline) {
      await surface.sleep(250);
      const observation = await observe();
      if (observation && !busy(observation)) return true;
    }
    return false;
  };
  const busy = (observation: RawObservation) => {
    const signals = binding.classify(observation).signals;
    return signals.includes("loading") || signals.includes("pricing_in_progress");
  };

  while (true) {
    cycle += 1;
    currentField = null;
    if (signal.aborted) return stop("cancelled");
    if (now() - started > limits.wallMs || cycle > 200) return stop("budget_time");
    const cycleStarted = now();
    const observation = await observe();
    if (!observation) return stop("unsupported_ui");
    const observeMs = now() - cycleStarted;
    if (surface.boundaryViolation() || !binding.routeAllowed(observation.url)) return stop("boundary_violation", mutationPossible || counters.actions > 0);
    const page = binding.classify(observation);
    if (page.dialog === "export_control" || page.signals.includes("export_control")) return stop("export_control");
    if (page.signals.includes("blocking")) return stop("blocking_state");
    if (page.signals.includes("manual_review")) return stop("manual_review");
    const admissible = admissibleElements(observation);
    if (observation.truncated || admissible.length > MAX_ADMISSIBLE_ELEMENTS) return stop("budget_observation");
    if (busy(observation)) {
      counters.codeWaits += 1;
      if (counters.codeWaits > limits.codeWaitOccurrences || !(await waitWhile(busy, limits.codeWaitMs))) return stop("budget_time");
      continue;
    }

    // Re-verify earlier work against this observation; only positive evidence of a different value is a regression.
    for (const field of order) {
      if (status[field] !== "verified" || verify(field, observation).result !== "differs") continue;
      regressions[field] = (regressions[field] ?? 0) + 1;
      currentField = field;
      if (regressions[field]! > limits.regressionsPerField) return stop("regression_loop");
      status[field] = "pending";
    }
    let current: DriverField | null = page.dialog ? "dialog" : null;
    if (!current) {
      for (const field of order) {
        if (status[field] === "verified" || status[field] === "skipped") continue;
        const check = verify(field, observation);
        if (check.result === "match") {
          status[field] = "verified";
          if (check.term) matched[field] = check.term;
          if (check.node) verifiedNode[field] = check.node;
          continue;
        }
        current = field;
        break;
      }
    }
    currentField = current;
    if (!current) break;
    cycles[current] = (cycles[current] ?? 0) + 1;
    if (cycles[current]! > limits.cyclesPerSubGoal) return stop("subgoal_budget");

    const spec: FieldSpec | null = current === "dialog" ? null : specs.get(current)!;
    if (current === "dialog") {
      if (page.dialog === "unknown") return stop("unknown_dialog");
      if (page.dialog === "units_prompt" && !unitsConfirmed) {
        if (!binding.cadUnits) return stop("units_unknown");
        const pattern = UNITS_LABEL[binding.cadUnits];
        const radios = admissible.filter((element) => element.inDialog && element.role === "radio" && pattern.test(element.name));
        if (radios.length !== 1) return stop("unknown_dialog");
        // Only a fresh observation of the checked radio unlocks the dialog's confirm button.
        if (radios[0].checked) { unitsConfirmed = true; continue; }
      }
    }
    const fillValue = !spec ? null : spec.kind === "number"
      ? ((fills[spec.field] ?? 0) < 2 ? spec.fillValues[0] : null)
      : (spec.fillValues[termIndex[spec.field] ?? 0] ?? null);
    const context: OpContext = { spec, dialog: page.dialog, unitsConfirmed, fillValue };
    const targets = {
      CLICK: compatibleTargets("CLICK", admissible, context, binding),
      FILL_REQUIRED_VALUE: compatibleTargets("FILL_REQUIRED_VALUE", admissible, context, binding),
      SELECT_REQUIRED_VALUE: compatibleTargets("SELECT_REQUIRED_VALUE", admissible, context, binding),
    };
    const shown = admissible.filter((element) => Boolean(page.dialog) === element.inDialog);
    const projected = shown.map((element) => projectElement(element, spec, binding));
    const byId = new Map(projected.map((element) => [element.id, element]));
    const classes = new Map<string, number>();
    for (const element of projected) classes.set(equivalenceKey(element), (classes.get(equivalenceKey(element)) ?? 0) + 1);
    const classSize = (id: string) => { const element = byId.get(id); return element ? classes.get(equivalenceKey(element)) ?? 0 : 0; };
    const candidateCounts = Object.fromEntries(Object.entries(targets).map(([op, list]) => [op, list.length])) as Partial<Record<DriverOp, number>>;
    const observationHash = hashJson(projected);

    let plan: Plan | null = null;
    let modelMs = 0;
    let response: QuestionsResponse | null = null;
    let offeredOps: DriverOp[] = [];
    // Units dialog: code selects the radio for the code-supplied units.
    if (current === "dialog" && page.dialog === "units_prompt" && !unitsConfirmed) {
      const radio = admissible.find((element) => element.inDialog && element.role === "radio" && UNITS_LABEL[binding.cadUnits!].test(element.name))!;
      plan = { op: "SELECT_REQUIRED_VALUE", targetId: radio.id, decidedBy: "code", evidence: null };
    }
    // Shortcut (a): accepted options, code preference order; a tie is never broken by the model.
    if (!plan && spec?.kind === "option" && targets.SELECT_REQUIRED_VALUE.length > 0) {
      const ranked = targets.SELECT_REQUIRED_VALUE.map((element) => ({ element, rank: optionMatch(element, spec, binding)!.rank }))
        .sort((a, b) => a.rank - b.rank);
      if (ranked.length > 1 && ranked[0].rank === ranked[1].rank) return stop("ambiguous_option");
      plan = { op: "SELECT_REQUIRED_VALUE", targetId: ranked[0].element.id, decidedBy: "code", evidence: null };
    }
    // Shortcut (b): exactly one field-tied input that does not already show the required value.
    if (!plan && spec && fillValue !== null) {
      const tied = targets.FILL_REQUIRED_VALUE.filter((element) => fieldOf(element, binding.fields) === spec.field
        && valueState(element, spec, binding) !== "matches_required");
      if (tied.length === 1 && classSize(tied[0].id) === 1) plan = { op: "FILL_REQUIRED_VALUE", targetId: tied[0].id, decidedBy: "code", evidence: null };
    }
    if (plan) counters.codeDecisions += 1;

    if (!plan) {
      const built = buildDriverRequest({
        current: { field: current, status: current === "dialog" ? "pending" : status[current]!, attempt: cycles[current]! },
        fields: order.map((field) => ({ field, status: status[field]! })),
        signals: page.signals, dialog: page.dialog, elements: projected, recent: recent.slice(-3),
        targets: Object.fromEntries(Object.entries(targets).map(([op, list]) => [op, list.map((element) => element.id)])),
      });
      offeredOps = built.offeredOps;
      let estimated: number;
      try {
        estimated = serializeQuestionsRequest(built.request).estimatedTokens;
      } catch (error) {
        return stop(error instanceof JevTransportError && error.code === "jev_request_budget" ? "budget_request" : "invalid_decision");
      }
      if (estimated > limits.requestTokens) return stop("budget_request");
      if (counters.calls + 1 > limits.calls) return stop("budget_calls");
      // Charge the larger of the estimate and the largest reported request so far, so the cap holds even when usage exceeds the estimate.
      if (counters.inputTokens + Math.max(estimated, counters.largestCall) > limits.inputTokens) return stop("budget_tokens");
      const modelStarted = now();
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(limits.modelDeadlineMs)]);
      try {
        response = await Promise.race([
          capability.decide(built.request, deadline),
          new Promise<never>((_, reject) => { deadline.addEventListener("abort", () => reject(new Error("deadline")), { once: true }); }),
        ]);
      } catch {
        counters.calls += 1;
        counters.inputTokens += estimated;
        tokensEstimated = true;
        return stop("inference_unavailable");
      }
      modelMs = now() - modelStarted;
      counters.calls += 1;
      counters.inputTokens += response.inputTokens;
      counters.largestCall = Math.max(counters.largestCall, response.inputTokens);
      counters.outputTokens += response.outputTokens;
      tokensEstimated ||= response.estimatedUsage;
      const decision = response.model === capability.model
        ? decideFromAnswers(response.answers, built, classSize)
        : { kind: "stop" as const, reason: "invalid_decision" as const, op: null, evidence: { ...NO_EVIDENCE, gates: [] } };
      hit(decision.evidence.gates);
      const decisionReceipt = (outcome: DriverCycleReceipt["outcome"], stopReason: StopReason | null) => receipt({
        phase: stopReason ? "stopped" : "settled", outcome, decidedBy: "jev", observationHash, candidateCounts, offeredOps,
        op: decision.op, opConfidence: decision.evidence.opConfidence, reversedAgrees: decision.evidence.reversedAgrees,
        targetProbability: decision.evidence.targetProbability, noneProbability: decision.evidence.noneProbability,
        controlPresent: decision.evidence.controlPresent, gates: decision.evidence.gates, stopReason,
        timingsMs: { observe: observeMs, model: modelMs, act: 0, settle: 0 }, model: response!.model,
        inputTokens: response!.inputTokens, outputTokens: response!.outputTokens, tokensEstimated: response!.estimatedUsage, requestId: response!.requestId,
      });
      if (decision.kind === "stop" || decision.kind === "blocked") {
        const reason: StopReason = decision.kind === "stop" ? decision.reason
          : observation.foreignFrames > 0 || observation.unsupported > 0 ? "unsupported_ui" : "blocked";
        await audit(decisionReceipt("stopped", reason));
        return stop(reason);
      }
      if (decision.kind === "done") {
        await surface.settle("action", null);
        const fresh = await observe();
        const accepted = fresh !== null && verify(current, fresh).result === "match";
        await audit(decisionReceipt("skipped", null));
        if (!accepted) {
          counters.rejectedDone += 1;
          if (counters.rejectedDone >= limits.rejectedDone) return stop("verification_gap");
        }
        cycleTimes.push(now() - cycleStarted);
        continue;
      }
      if (decision.kind === "wait") {
        const neededDisabled = current !== "dialog" && observation.elements.some((element) => element.disabled && fieldOf(element, binding.fields) === current);
        await audit(decisionReceipt("skipped", null));
        if (neededDisabled && counters.modelWaits < limits.modelWaits) {
          counters.modelWaits += 1;
          await waitWhile((fresh) => fresh.elements.some((element) => element.disabled && fieldOf(element, binding.fields) === current), limits.modelWaitMs);
        } else {
          counters.noProgress += 1;
          if (counters.noProgress >= limits.consecutiveNoProgress) return stop("no_progress");
        }
        cycleTimes.push(now() - cycleStarted);
        continue;
      }
      plan = { op: decision.op, targetId: decision.targetId, decidedBy: "jev", evidence: decision.evidence };
    }

    // Execution (§11). The decision is spent here: nothing below can replay it.
    if (!plan) return stop("invalid_decision");
    const decidedPlan: Plan = plan;
    plan = null;
    let reference = observation;
    let element = observation.elements.find((candidate) => candidate.id === decidedPlan.targetId) as RawElement;
    const evidence = decidedPlan.evidence ?? NO_EVIDENCE;
    const base = {
      decidedBy: decidedPlan.decidedBy, observationHash, candidateCounts, offeredOps, op: decidedPlan.op,
      opConfidence: evidence.opConfidence, reversedAgrees: evidence.reversedAgrees, targetProbability: evidence.targetProbability,
      noneProbability: evidence.noneProbability, controlPresent: evidence.controlPresent, targetId: element.id,
      targetGuardHash: hashJson(element.guard).slice(0, 16), model: response?.model ?? null, inputTokens: response?.inputTokens ?? null,
      outputTokens: response?.outputTokens ?? null, tokensEstimated: response?.estimatedUsage ?? false, requestId: response?.requestId ?? null,
    };
    if (!(await audit(receipt({ ...base, phase: "planned", outcome: "planned", timingsMs: { observe: observeMs, model: modelMs, act: 0, settle: 0 } })))) {
      return stop("audit_unavailable");
    }
    if (counters.actions + 1 > limits.actions) { hit(["budget"]); return stop("budget_actions"); }
    // Kill switch: deliberately outside every catch.
    await binding.beforeAction();
    const staleCycle = async (gate: GateHit): Promise<DriverOutcome | null> => {
      hit([gate]);
      counters.stale += 1;
      counters.noProgress += 1;
      await audit(receipt({ ...base, phase: "settled", outcome: "skipped", gates: [gate], timingsMs: { observe: observeMs, model: modelMs, act: 0, settle: 0 } }));
      if (counters.stale >= limits.consecutiveStale) return stop("stale_loop");
      if (counters.noProgress >= limits.consecutiveNoProgress) return stop("no_progress");
      cycleTimes.push(now() - cycleStarted);
      return null;
    };
    if (element.offscreen) {
      // Scroll by code, then require the same node with the same semantic state before acting.
      await surface.inspect(element.id, { scroll: true, forFill: false });
      const scrolled = await observe();
      const again = scrolled?.elements.find((candidate) => candidate.id === element.id);
      if (!scrolled || !again || again.guard !== element.guard || hashJson(scrolled.formState) !== hashJson(observation.formState)) {
        const stopped = await staleCycle("stale");
        if (stopped) return stopped;
        continue;
      }
      reference = scrolled;
      element = again;
    }
    const forFill = decidedPlan.op === "FILL_REQUIRED_VALUE";
    const live = await surface.inspect(element.id, { scroll: false, forFill });
    const fresh = live !== null && live.connected && live.guard === element.guard
      && (forFill ? live.marker === reference.marker : live.pageKey === reference.pageKey);
    if (!fresh) {
      const stopped = await staleCycle("stale");
      if (stopped) return stopped;
      continue;
    }
    if (deniedText(live.denyText)) {
      hit(["deny_hit"]);
      await audit(receipt({ ...base, phase: "stopped", outcome: "stopped", gates: ["deny_hit"], stopReason: "deny_hit" }));
      return stop("deny_hit");
    }
    if (!live.actionable || !live.point) {
      const stopped = await staleCycle("occluded");
      if (stopped) return stopped;
      continue;
    }
    counters.stale = 0;
    counters.actions += 1;
    mutationPossible = true;
    const value = forFill ? context.fillValue! : null;
    const actStarted = now();
    try {
      if (decidedPlan.op === "CLICK") await surface.click(live);
      else if (decidedPlan.op === "SELECT_REQUIRED_VALUE") await (element.optionIndex !== null ? surface.selectNative(live) : surface.click(live));
      else await surface.fill(live, value!);
    } catch {
      return stop("action_uncertain", true);
    }
    if (forFill && spec?.kind === "number") {
      // Enter can submit the form; the switch is read again between fill and key press.
      await binding.beforeAction();
      try { await surface.pressEnter(); } catch { return stop("action_uncertain", true); }
    }
    const actMs = now() - actStarted;
    const settleStarted = now();
    await surface.settle(forFill && spec?.kind === "option" ? "combobox_fill" : "action", element.id);
    const settleMs = now() - settleStarted;
    if (spec) {
      status[spec.field] = "applied";
      acted.add(spec.field);
      if (forFill) {
        fills[spec.field] = (fills[spec.field] ?? 0) + 1;
        filledNode[spec.field] = element.id;
        if (spec.kind === "option") termIndex[spec.field] = (termIndex[spec.field] ?? 0) + 1;
      }
    }
    const after = await observe();
    if (!after) return stop("action_uncertain", true);
    if (surface.boundaryViolation() || !binding.routeAllowed(after.url)) return stop("boundary_violation", true);
    // Side-effect diff: only the target, or controls tied to the current field, may change.
    const changed = Object.keys(reference.formState).filter((key) => key in after.formState && after.formState[key] !== reference.formState[key]);
    const allowedOwners = new Set<ConfigField | null>(current === "dialog" || current === "process" ? order : [current]);
    const unexpected = changed.filter((key) => {
      if (key === element.id) return false;
      const control = after.elements.find((candidate) => candidate.id === key) ?? reference.elements.find((candidate) => candidate.id === key);
      return !control || !allowedOwners.has(fieldOf(control, binding.fields));
    });
    const pageChanged = after.marker !== reference.marker;
    await audit(receipt({ ...base, phase: "settled", outcome: "executed", pageChanged, formStateChanged: changed.length > 0,
      timingsMs: { observe: observeMs, model: modelMs, act: actMs, settle: settleMs } }));
    if (unexpected.length > 0) return stop("unexpected_mutation", true);
    counters.noProgress = pageChanged ? 0 : counters.noProgress + 1;
    if (counters.noProgress >= limits.consecutiveNoProgress) return stop("no_progress");
    const optionsBefore = reference.elements.filter((candidate) => candidate.role === "option").length;
    const optionsAfter = after.elements.filter((candidate) => candidate.role === "option").length;
    recent.push({ op: decidedPlan.op, id: element.id, effect: after.dialogs.length > reference.dialogs.length ? "dialog_opened"
      : after.dialogs.length < reference.dialogs.length ? "dialog_closed" : optionsAfter > optionsBefore ? "listbox_opened"
        : pageChanged ? "changed" : "no_change" });
    cycleTimes.push(now() - cycleStarted);
  }

  // All field sub-goals verified by code. The fixer reads locators while the nodes are still on the page.
  const candidates: LocatorCandidate[] = [];
  const skeletons: Partial<Record<ConfigField, string>> = {};
  for (const field of order) {
    const node = verifiedNode[field] ?? filledNode[field];
    if (!acted.has(field) || !node) continue;
    for (const selector of await surface.locatorCandidates(node).catch(() => [])) candidates.push({ field, selector, kind: locatorKind(selector) });
    const skeleton = await surface.skeleton(node).catch(() => null);
    if (skeleton) skeletons[field] = skeleton;
  }
  return {
    status: "completed", verified: order.filter((field) => status[field] === "verified"), matched,
    summary: summary("completed", null), candidates, skeletons,
  };
}

export type { ProjectedElement };
