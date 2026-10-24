/**
 * Jev quote driver state machine (docs/jev-quote-driver.md §4, §11, §14).
 *
 * Code owns the sub-goal order, every status, every value, every action and
 * every verification. Jev only names an operation and an element id from a
 * table code has already filtered. Benchmark prototype: no production wiring.
 */
import type { Frame, Page } from "playwright";
import { XOMETRY_LOCATORS } from "../../adapters/xometryConstraints.js";
import { JevTransportError, estimateTokens, serializeQuestions, type JevDriverModel, type QuestionsDecider, type QuestionsRequest, type QuestionsResult } from "../questions.js";
import { gateCycleDecision, gateOverlayDecision, gateSaveDecision, type DecisionMetrics } from "./decision.js";
import { changedControls, clickAt, observeFrame, prepareTarget, readPageKey, settleTarget, typeValue } from "./executor.js";
import { BOUNDARY_PATH, DENY_PATTERN, clickCompatible, fillCompatible, type DriverOp } from "./policy.js";
import {
  OPTION_FIELDS, fieldOfLabels, hashState, projectLabel,
  type DriverField, type OptionField, type ProjectedElement, type ValueState,
} from "./projection.js";
import { FIELD_GOALS, buildCycleRequest, buildOverlayRequest, buildSaveRequest, type FieldStatus } from "./request.js";
import type { FrameObservation, RawRecord } from "./snapshot.js";
import type { PageSignal, XometryDriverBinding } from "./xometryBinding.js";

export type DriverLimits = {
  calls: number; actions: number; tokens: number; requestTokens: number; cyclesPerSubgoal: number;
  stale: number; noProgress: number; rejectedDone: number; wallMs: number; codeWaitMs: number; codeWaits: number;
  modelWaitMs: number; modelWaits: number; regressions: number; records: number; saveNavigationMs: number; saveSettleMs: number;
};

/** Frozen values from §14; the save waits are benchmark values (production keeps the 120 s floor). */
export const DRIVER_LIMITS: DriverLimits = Object.freeze({
  calls: 30, actions: 20, tokens: 120_000, requestTokens: 6_000, cyclesPerSubgoal: 8, stale: 3, noProgress: 3,
  rejectedDone: 2, wallMs: 120_000, codeWaitMs: 15_000, codeWaits: 3, modelWaitMs: 5_000, modelWaits: 4, regressions: 2,
  records: 120, saveNavigationMs: 30_000, saveSettleMs: 30_000,
});

export type StopReason =
  | "export_control" | "blocking_state" | "manual_review" | "unknown_dialog" | "units_unknown" | "value_unavailable"
  | "ambiguous_option" | "ambiguous_duplicate" | "low_confidence" | "invalid_decision" | "blocked" | "verification_gap"
  | "regression_loop" | "subgoal_budget" | "stale_loop" | "no_progress" | "budget_calls" | "budget_actions" | "budget_tokens"
  | "budget_request" | "budget_time" | "budget_observation" | "inference_unavailable" | "action_uncertain"
  | "unexpected_mutation" | "boundary_violation" | "deny_hit" | "save_unresolved" | "save_failed" | "observation_failed";

const MUTATING_STOPS = new Set<StopReason>(["action_uncertain", "unexpected_mutation", "boundary_violation", "save_failed"]);

export type CycleReceipt = {
  schema: "jev-driver-cycle.v1";
  cycle: number;
  subgoal: DriverField;
  decidedBy: "code" | "jev" | "none";
  observationHash: string | null;
  records: number;
  candidates: { click: number; fill: number; select: number } | null;
  offeredOps: DriverOp[] | null;
  op: string | null;
  metrics: DecisionMetrics | null;
  gate: string;
  action: "executed" | "skipped" | "uncertain" | "verified" | "waited" | "none";
  formChanged: boolean | null;
  timings: { observeMs: number; modelMs: number; actMs: number; settleMs: number };
  tokens: { input: number | null; output: number | null; estimated: number | null };
  requestId: string | null;
};

export type DriverSummary = {
  cycles: number;
  modelCalls: number;
  codeDecisions: number;
  jevDecisions: number;
  actions: number;
  inputTokensReported: number;
  outputTokensReported: number;
  tokensCharged: number;
  estimatedTokensForCalls: number;
  callsWithoutUsage: number;
  modelLatencyMs: number[];
  cycleMs: number[];
  gateHits: Record<string, number>;
  denyRemovals: number;
  subgoals: Record<string, string>;
  receipts: CycleReceipt[];
};

export type DriverOutcome =
  | { status: "completed"; verified: DriverField[]; summary: DriverSummary }
  | { status: "stopped"; reason: StopReason; detail: string; mutationPossible: boolean; summary: DriverSummary };

export type ModelCallRecord = { subgoal: DriverField; request: QuestionsRequest; result: QuestionsResult | null; error: string | null };

export type DriverOptions = {
  /** Host-supplied keyed decider. Null means code-only: any model need stops with inference_unavailable. */
  decide: QuestionsDecider | null;
  model: JevDriverModel;
  shortcuts: boolean;
  modelResolvedSave: boolean;
  allowedOrigins: readonly string[];
  checkpoint: (stage: "before_configure" | "before_save") => Promise<void>;
  limits?: Partial<DriverLimits>;
  /** Benchmark only: synthetic request/response capture for replay fixtures. */
  onModelCall?: (call: ModelCallRecord) => void;
};

type DriverRecord = RawRecord & { id: string; frame: Frame; field: OptionField | "quantity" | null; klass: string; projected: ProjectedElement };
type Observation = {
  records: DriverRecord[];
  byId: Map<string, DriverRecord>;
  frames: Map<Frame, FrameObservation>;
  text: string;
  modalText: string | null;
  signals: Set<PageSignal>;
  markerHash: string;
  url: string;
  foreignFrames: number;
};
type Plan =
  | { kind: "act"; op: DriverOp; target: DriverRecord | null; decidedBy: "code" | "jev"; note: string; metrics: DecisionMetrics | null; call: CallCost | null }
  | { kind: "stop"; reason: StopReason; detail: string; decidedBy: "code" | "jev"; metrics: DecisionMetrics | null; call: CallCost | null };
type CallCost = { input: number | null; output: number | null; estimated: number; latencyMs: number; requestId: string | null };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const QUOTE_ROUTE = XOMETRY_LOCATORS.quotePagePathPattern;

export class JevQuoteDriver {
  private readonly limits: DriverLimits;
  private readonly started = performance.now();
  private readonly status = new Map<DriverField, "pending" | "verified">();
  private readonly attempts: Partial<Record<OptionField, number>> = {};
  private readonly regressions: Partial<Record<DriverField, number>> = {};
  private readonly cyclesBySubgoal: Partial<Record<DriverField, number>> = {};
  private readonly recent: Array<{ op: string; field: DriverField; effect: string }> = [];
  private readonly flags = { boundary: 0, popup: 0, fileChooser: 0 };
  private readonly summaryState: DriverSummary = {
    cycles: 0, modelCalls: 0, codeDecisions: 0, jevDecisions: 0, actions: 0, inputTokensReported: 0, outputTokensReported: 0,
    tokensCharged: 0, estimatedTokensForCalls: 0, callsWithoutUsage: 0, modelLatencyMs: [], cycleMs: [], gateHits: {}, denyRemovals: 0,
    subgoals: {}, receipts: [],
  };
  private stale = 0;
  private noProgress = 0;
  private doneRejected = 0;
  private codeWaits = 0;
  private modelWaits = 0;
  private mutationPossible = false;
  private lastMarker: string | null = null;
  private lastCycleActed = false;
  private confirmedCompletion = false;
  /** After a stale or occluded shortcut target, the next cycle on that sub-goal asks the model instead. */
  private blockedShortcut: DriverField | null = null;
  private readonly routeGuard = (url: URL) => BOUNDARY_PATH.test(url.pathname);
  private readonly onPopup = (popup: Page) => { this.flags.popup += 1; void popup.close().catch(() => undefined); };
  private readonly onFileChooser = () => { this.flags.fileChooser += 1; };

  constructor(private readonly page: Page, private readonly binding: XometryDriverBinding, private readonly options: DriverOptions) {
    this.limits = { ...DRIVER_LIMITS, ...options.limits };
  }

  /** Network, popup and upload guards for the whole driver window (§12). */
  async install() {
    await this.page.route(this.routeGuard, async (route) => { this.flags.boundary += 1; await route.abort("blockedbyclient"); });
    this.page.on("popup", this.onPopup);
    this.page.on("filechooser", this.onFileChooser);
  }

  async uninstall() {
    await this.page.unroute(this.routeGuard).catch(() => undefined);
    this.page.off("popup", this.onPopup);
    this.page.off("filechooser", this.onFileChooser);
  }

  get summary(): DriverSummary {
    return { ...this.summaryState, subgoals: Object.fromEntries(this.status) };
  }

  private hit(name: string) { this.summaryState.gateHits[name] = (this.summaryState.gateHits[name] ?? 0) + 1; }

  private stop(reason: StopReason, detail = ""): DriverOutcome {
    this.hit(`stop:${reason}`);
    return { status: "stopped", reason, detail, mutationPossible: this.mutationPossible || MUTATING_STOPS.has(reason), summary: this.summary };
  }

  private budgetStop(): StopReason | null {
    if (performance.now() - this.started > this.limits.wallMs) return "budget_time";
    if (this.summaryState.modelCalls >= this.limits.calls) return "budget_calls";
    if (this.summaryState.actions >= this.limits.actions) return "budget_actions";
    if (this.summaryState.tokensCharged >= this.limits.tokens) return "budget_tokens";
    return null;
  }

  private flagStop(): DriverOutcome | null {
    if (this.flags.boundary) return this.stop("boundary_violation", "network");
    if (this.flags.popup) return this.stop("boundary_violation", "popup");
    if (this.flags.fileChooser) return this.stop("boundary_violation", "file_chooser");
    let url: URL;
    try { url = new URL(this.page.url()); } catch { return this.stop("boundary_violation", "url"); }
    if (!this.options.allowedOrigins.includes(url.origin) || !QUOTE_ROUTE.test(url.pathname)) return this.stop("boundary_violation", "route");
    return null;
  }

  // ---- observation --------------------------------------------------------

  private async observe(): Promise<Observation | null> {
    await this.page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return await this.observeOnce();
      } catch {
        await sleep(60);
      }
    }
    return null;
  }

  private async observeOnce(): Promise<Observation> {
    const frames = new Map<Frame, FrameObservation>();
    let foreignFrames = 0;
    const args = { deny: DENY_PATTERN, maxRecords: this.limits.records + 40, offerContainers: XOMETRY_LOCATORS.offerContainers };
    for (const frame of this.page.frames()) {
      const url = frame.url();
      if (!url || url === "about:blank") continue;
      let origin: string;
      try { origin = new URL(url).origin; } catch { foreignFrames += 1; continue; }
      if (!this.options.allowedOrigins.includes(origin)) { foreignFrames += 1; continue; }
      const observation = await observeFrame(frame, args);
      if (!observation) {
        if (frame === this.page.mainFrame()) throw new Error("not_ready");
        continue;
      }
      frames.set(frame, observation);
    }
    if (!frames.has(this.page.mainFrame())) throw new Error("not_ready");
    const modalFrames = [...frames].filter(([, observation]) => observation.modal);
    const kept = modalFrames.length ? modalFrames : [...frames];
    const records: DriverRecord[] = [];
    const vocabulary = this.binding.vocabulary;
    for (const [frame, observation] of kept) {
      for (const raw of observation.records) {
        if (raw.denied) { this.summaryState.denyRemovals += 1; continue; }
        const labelField = fieldOfLabels(raw, vocabulary);
        const roleOk = labelField === "quantity"
          ? ["spinbutton", "textbox"].includes(raw.role) && raw.tag === "input"
          : labelField !== null && (["combobox", "searchbox"].includes(raw.role) && (raw.tag === "input" || raw.tag === "select"));
        const field = roleOk ? labelField : null;
        const name = raw.role === "option" ? (vocabulary.labels.has(raw.name.toLowerCase()) ? projectLabel(raw.name, vocabulary) : "«catalog»") : projectLabel(raw.name, vocabulary);
        const near = raw.near ? projectLabel(raw.near, vocabulary) : undefined;
        const record = { ...raw, id: `e${records.length + 1}`, frame, field, klass: `${raw.role}|${name}|${near ?? ""}`,
          projected: { id: `e${records.length + 1}`, role: raw.role, name } as ProjectedElement };
        if (near && near !== name) record.projected.near = near;
        if (raw.expanded !== null) record.projected.expanded = raw.expanded;
        if (raw.checked !== null && ["radio", "checkbox", "switch"].includes(raw.role)) record.projected.checked = raw.checked;
        if (raw.role === "tab" && raw.selected !== null) record.projected.selected = raw.selected;
        if (raw.submit) record.projected.submit = true;
        if (raw.disabled) record.projected.disabled = true;
        if (raw.offscreen) record.projected.offscreen = true;
        if (raw.occluded) record.projected.occluded = true;
        if (raw.overlay) record.projected.covering_layer = true;
        records.push(record);
      }
    }
    const text = [...frames.values()].map((observation) => observation.text).join("\n");
    const modalText = modalFrames.length ? modalFrames.map(([, observation]) => observation.modal!.text).join("\n") : null;
    const signals = this.binding.signals(text, modalText, this.page.url());
    if (records.some((record) => OPTION_FIELDS.includes(record.field as OptionField))) signals.add("configuration_panel");
    return {
      records, byId: new Map(records.map((record) => [record.id, record])), frames, text, modalText, signals,
      markerHash: hashState([...frames.values()].map((observation) => observation.marker)), url: this.page.url(), foreignFrames,
    };
  }

  // ---- code verification (§15) ------------------------------------------

  private controlsFor(field: OptionField | "quantity", observation: Observation) {
    return observation.records.filter((record) => record.field === field);
  }

  private valueState(record: DriverRecord): ValueState | undefined {
    if (!record.field) return undefined;
    if (record.field === "quantity") {
      if (!record.value.trim()) return "empty";
      return record.value.trim() === this.binding.quantityValue ? "matches_required" : "differs";
    }
    if (record.tag === "input" && record.value.trim()) return "search_typed";
    if (!record.display.trim()) return "empty";
    return this.binding.displaySatisfies(record.field, record.display) ? "matches_required" : "differs";
  }

  private verify(field: DriverField, observation: Observation): "verified" | "not_verified" | "absent" | "ambiguous" {
    if (field === "panel") return observation.signals.has("configuration_panel") ? "verified" : "not_verified";
    if (field === "dialog" || field === "save" || field === "overlay") return "not_verified";
    const controls = this.controlsFor(field, observation);
    if (controls.length === 0) return "absent";
    if (controls.length > 1) return "ambiguous";
    return this.valueState(controls[0]) === "matches_required" ? "verified" : "not_verified";
  }

  // ---- main loop ------------------------------------------------------------

  async runFields(): Promise<DriverOutcome> {
    const order: DriverField[] = ["panel", "process", "material", "finish", "quantity"];
    for (const field of order) if (!this.status.has(field)) this.status.set(field, "pending");
    for (;;) {
      const budget = this.budgetStop();
      if (budget) return this.stop(budget);
      const cycleStarted = performance.now();
      const observation = await this.observe();
      const observeMs = Math.round(performance.now() - cycleStarted);
      if (!observation) return this.stop("observation_failed");
      if (observation.records.length > this.limits.records) return this.stop("budget_observation");
      const flagged = this.flagStop();
      if (flagged) return flagged;
      if (this.lastCycleActed) {
        this.noProgress = observation.markerHash === this.lastMarker ? this.noProgress + 1 : 0;
        if (this.noProgress >= this.limits.noProgress) return this.stop("no_progress");
      }
      this.lastMarker = observation.markerHash;
      this.lastCycleActed = false;
      const signals = observation.signals;
      if (signals.has("export_control")) return this.stop("export_control");
      if (signals.has("blocking")) return this.stop("blocking_state");
      if (signals.has("manual_review")) return this.stop("manual_review");
      if (signals.has("unknown_dialog")) return this.stop("unknown_dialog");
      if (!observation.modalText && (signals.has("loading") || signals.has("pricing_in_progress"))) {
        this.codeWaits += 1;
        if (this.codeWaits > this.limits.codeWaits) return this.stop("budget_time", "code_waits");
        await this.waitForSignalsToClear(this.limits.codeWaitMs);
        this.record({ subgoal: "panel", decidedBy: "code", observation, gate: "code_wait", action: "waited", observeMs });
        continue;
      }
      let current: DriverField | null = null;
      const covered = observation.records.some((record) => record.occluded && (clickCompatible(record) || record.field !== null));
      const coverControls = observation.records.filter((record) => record.overlay && clickCompatible(record));
      if (observation.modalText) {
        current = "dialog";
      } else if (covered && coverControls.length) {
        // A non-modal fixed layer covers usable controls: dismissing it is its own code-classified sub-goal.
        current = "overlay";
      } else {
        for (const field of order) {
          if (this.status.get(field) !== "verified") continue;
          if (this.verify(field, observation) === "not_verified") {
            this.regressions[field] = (this.regressions[field] ?? 0) + 1;
            this.hit("regression");
            if ((this.regressions[field] ?? 0) > this.limits.regressions) return this.stop("regression_loop", field);
            this.status.set(field, "pending");
          }
        }
        const pending: DriverField[] = [];
        for (const field of order) {
          if (this.status.get(field) === "verified") continue;
          if (this.verify(field, observation) === "verified") { this.status.set(field, "verified"); continue; }
          pending.push(field);
        }
        // panel and process keep their place (a process change reloads the catalogs); after that, a pending field
        // whose control is on screen goes before one hidden behind a tab or drawer.
        current = pending.find((field) => field === "panel" || field === "process")
          ?? pending.find((field) => this.verify(field, observation) === "not_verified")
          ?? pending[0] ?? null;
        if (current === null) {
          if (!this.confirmedCompletion) {
            // A modal (export control, confirm) can open just after the last commit; look once more before handing back.
            this.confirmedCompletion = true;
            await sleep(300);
            continue;
          }
          return { status: "completed", verified: order, summary: this.summary };
        }
        this.confirmedCompletion = false;
      }
      const cycles = (this.cyclesBySubgoal[current] ?? 0) + 1;
      this.cyclesBySubgoal[current] = cycles;
      if (cycles > this.limits.cyclesPerSubgoal) return this.stop("subgoal_budget", current);
      this.summaryState.cycles += 1;

      let plan = this.blockedShortcut === current ? null : this.codePlan(current, observation);
      this.blockedShortcut = null;
      if (plan === null) plan = await this.modelPlan(current, observation, order);
      if (plan.kind === "stop") {
        this.record({ subgoal: current, decidedBy: plan.decidedBy, observation, gate: plan.reason, action: "none", observeMs, plan });
        return this.stop(plan.reason, plan.detail);
      }
      if (plan.decidedBy === "code") this.summaryState.codeDecisions += 1; else this.summaryState.jevDecisions += 1;
      const result = await this.execute(plan, current, observation, observeMs);
      this.summaryState.cycleMs.push(Math.round(performance.now() - cycleStarted));
      if (result) return result;
    }
  }

  private async waitForSignalsToClear(capMs: number) {
    const deadline = performance.now() + capMs;
    while (performance.now() < deadline) {
      await sleep(250);
      const text = await this.page.evaluate("document.body ? document.body.innerText : ''").catch(() => "") as string;
      const frameTexts = await Promise.all(this.page.frames().slice(1).map((frame) => frame.evaluate("document.body ? document.body.innerText : ''").catch(() => "")));
      const signals = this.binding.signals([text, ...frameTexts].join("\n"), null, this.page.url());
      if (!signals.has("loading") && !signals.has("pricing_in_progress")) return;
    }
  }

  // ---- planning ---------------------------------------------------------------

  private codePlan(current: DriverField, observation: Observation): Plan | null {
    const act = (op: DriverOp, target: DriverRecord | null, note: string): Plan => ({ kind: "act", op, target, decidedBy: "code", note, metrics: null, call: null });
    const stop = (reason: StopReason, detail: string): Plan => ({ kind: "stop", reason, detail, decidedBy: "code", metrics: null, call: null });
    if (current === "dialog") {
      if (!observation.signals.has("units_prompt")) return null;
      if (this.binding.requirement.cadUnits === null) return stop("units_unknown", "no_units_source");
      const radio = observation.records.find((record) => record.role === "radio" && this.binding.unitsLabel(record.name));
      if (!radio) return stop("units_unknown", "units_option_absent");
      if (!radio.checked) return act("SELECT_REQUIRED_VALUE", radio, "units_radio");
      return null;
    }
    if (OPTION_FIELDS.includes(current as OptionField)) {
      const field = current as OptionField;
      const controls = this.controlsFor(field, observation);
      const control = controls.length === 1 ? controls[0] : null;
      if (control) {
        const options = observation.records.filter((record) => record.role === "option" && record.frame === control.frame
          && (!control.controls || record.inListbox === control.controls));
        const ranked = options.map((record) => ({ record, rank: this.binding.optionRank(field, record.name) })).filter((entry) => entry.rank >= 0);
        if (control.expanded !== false && ranked.length) {
          const best = Math.min(...ranked.map((entry) => entry.rank));
          const top = ranked.filter((entry) => entry.rank === best);
          if (top.length > 1) return stop("ambiguous_option", field);
          if (this.options.shortcuts) return act("SELECT_REQUIRED_VALUE", top[0].record, "shortcut_select");
          return null;
        }
        if (control.value.trim() && control.expanded !== false && ranked.length === 0) {
          // The settled search shows no option the code matcher accepts: next term, or stop. Never the nearest option.
          if (this.binding.searchValue(field, this.attempts[field] ?? 0) === null) return stop("value_unavailable", field);
          if (this.options.shortcuts && fillCompatible(control, "option")) return act("FILL_REQUIRED_VALUE", control, "shortcut_next_term");
          return null;
        }
        if (this.options.shortcuts && fillCompatible(control, "option") && this.valueState(control) !== "matches_required") {
          if (this.binding.searchValue(field, this.attempts[field] ?? 0) === null) return stop("value_unavailable", field);
          return act("FILL_REQUIRED_VALUE", control, "shortcut_fill");
        }
      }
      return null;
    }
    if (!this.options.shortcuts) return null;
    if (current === "panel") {
      const openers = observation.records.filter((record) => clickCompatible(record) && this.binding.openNames.has(record.projected.name));
      return openers.length === 1 ? act("CLICK", openers[0], "shortcut_open") : null;
    }
    if (current === "quantity") {
      const controls = this.controlsFor("quantity", observation);
      if (controls.length === 1 && fillCompatible(controls[0], "quantity") && this.valueState(controls[0]) !== "matches_required") {
        return act("FILL_REQUIRED_VALUE", controls[0], "shortcut_fill");
      }
    }
    return null;
  }

  private candidates(current: DriverField, observation: Observation) {
    // A covered control cannot be pressed; it stays in `elements` (flagged occluded) but is never a target.
    const click = observation.records.filter((record) => clickCompatible(record) && !record.occluded && (current !== "overlay" || record.overlay));
    let fill: DriverRecord[] = [];
    let select: DriverRecord[] = [];
    if (current === "quantity") fill = observation.records.filter((record) => fillCompatible(record, "quantity"));
    if (OPTION_FIELDS.includes(current as OptionField)) {
      const field = current as OptionField;
      fill = observation.records.filter((record) => fillCompatible(record, "option"));
      select = observation.records.filter((record) => record.role === "option" && this.binding.optionRank(field, record.name) >= 0);
    }
    return { click, fill, select };
  }

  private elements(observation: Observation, current: DriverField) {
    return observation.records.slice(0, this.limits.records).map((record) => {
      const element = { ...record.projected };
      const state = this.valueState(record);
      if (state) element.value_state = state;
      if (record.role === "option" && OPTION_FIELDS.includes(current as OptionField)) {
        element.matches_required = this.binding.optionRank(current as OptionField, record.name) >= 0;
      }
      return element;
    });
  }

  private async callModel(subgoal: DriverField, request: QuestionsRequest): Promise<{ result: QuestionsResult; cost: CallCost } | { error: StopReason; detail: string; cost: CallCost | null }> {
    if (!this.options.decide) return { error: "inference_unavailable", detail: "no_decider", cost: null };
    let estimated: number;
    try {
      estimated = estimateTokens(serializeQuestions(this.options.model, request));
    } catch {
      return { error: "budget_request", detail: "request_too_large", cost: null };
    }
    if (estimated > this.limits.requestTokens) return { error: "budget_request", detail: String(estimated), cost: null };
    if (this.summaryState.tokensCharged + estimated > this.limits.tokens) return { error: "budget_tokens", detail: "", cost: null };
    if (this.summaryState.modelCalls >= this.limits.calls) return { error: "budget_calls", detail: "", cost: null };
    this.summaryState.modelCalls += 1;
    try {
      const result = await this.options.decide(request, AbortSignal.timeout(5_500));
      const charged = result.inputTokens ?? result.estimatedTokens;
      this.summaryState.tokensCharged += charged;
      this.summaryState.estimatedTokensForCalls += result.estimatedTokens;
      if (result.inputTokens === null) this.summaryState.callsWithoutUsage += 1;
      else this.summaryState.inputTokensReported += result.inputTokens;
      this.summaryState.outputTokensReported += result.outputTokens ?? 0;
      this.summaryState.modelLatencyMs.push(result.latencyMs);
      this.options.onModelCall?.({ subgoal, request, result, error: null });
      return { result, cost: { input: result.inputTokens, output: result.outputTokens, estimated: result.estimatedTokens, latencyMs: result.latencyMs, requestId: result.requestId } };
    } catch (error) {
      const code = error instanceof JevTransportError ? error.code : "jev_unavailable";
      this.summaryState.tokensCharged += estimated;
      this.options.onModelCall?.({ subgoal, request, result: null, error: code });
      return { error: "inference_unavailable", detail: code, cost: { input: null, output: null, estimated, latencyMs: 0, requestId: null } };
    }
  }

  private async modelPlan(current: DriverField, observation: Observation, order: DriverField[]): Promise<Plan> {
    if (current === "overlay") return this.overlayPlan(observation);
    const candidates = this.candidates(current, observation);
    const fields: FieldStatus[] = order.filter((field) => field !== "panel").map((field) => ({ field, status: this.status.get(field) ?? "pending" }));
    const signals = [...observation.signals].filter((signal) => signal !== "unknown_dialog");
    const built = buildCycleRequest({
      current: { field: current, goal: FIELD_GOALS[current], attempt: (this.cyclesBySubgoal[current] ?? 1) },
      fields, signals,
      dialog: observation.signals.has("units_prompt") ? "units_prompt" : observation.signals.has("confirm_prompt") ? "confirm_prompt" : null,
      elements: this.elements(observation, current), recent: this.recent,
    }, { click: candidates.click.map((record) => record.id), fill: candidates.fill.map((record) => record.id), select: candidates.select.map((record) => record.id) });
    const called = await this.callModel(current, built.request);
    if ("error" in called) return { kind: "stop", reason: called.error, detail: called.detail, decidedBy: "jev", metrics: null, call: called.cost };
    const gate = gateCycleDecision(built, called.result.answers);
    if (gate.kind === "stop") {
      this.hit(`gate:${gate.reason}:${gate.detail}`);
      return { kind: "stop", reason: gate.reason, detail: gate.detail, decidedBy: "jev", metrics: gate.metrics, call: called.cost };
    }
    const target = gate.target ? observation.byId.get(gate.target) ?? null : null;
    if (gate.target && !target) return { kind: "stop", reason: "invalid_decision", detail: "unknown_target", decidedBy: "jev", metrics: gate.metrics, call: called.cost };
    if (target && gate.op === "CLICK" && observation.records.filter((record) => record.klass === target.klass).length > 1) {
      this.hit("duplicate");
      return { kind: "stop", reason: "ambiguous_duplicate", detail: target.klass.split("|")[0], decidedBy: "jev", metrics: gate.metrics, call: called.cost };
    }
    return { kind: "act", op: gate.op, target, decidedBy: "jev", note: "jev", metrics: gate.metrics, call: called.cost };
  }

  /**
   * Two equally valid dismiss buttons split a single choice head, so each covering-layer control gets its own
   * noul (one judgment per candidate); code takes the highest at or above the gate, ties to document order.
   */
  private async overlayPlan(observation: Observation): Promise<Plan> {
    const candidates = this.candidates("overlay", observation).click.slice(0, 8);
    const layer = [...observation.frames.values()].flatMap((frame) => frame.layers ?? []).map((name) => projectLabel(name, this.binding.vocabulary))[0] ?? "«text»";
    const { request } = buildOverlayRequest(this.elements(observation, "overlay"), candidates.map((record) => record.id), layer);
    const called = await this.callModel("overlay", request);
    if ("error" in called) return { kind: "stop", reason: called.error, detail: called.detail, decidedBy: "jev", metrics: null, call: called.cost };
    const gate = gateOverlayDecision(candidates.map((record) => record.id), called.result.answers);
    if (gate.kind === "stop") {
      this.hit(`gate:${gate.reason}:${gate.detail}`);
      return { kind: "stop", reason: gate.reason, detail: gate.detail, decidedBy: "jev", metrics: gate.metrics, call: called.cost };
    }
    const target = observation.byId.get(gate.target ?? "") ?? null;
    if (!target) return { kind: "stop", reason: "invalid_decision", detail: "overlay_target", decidedBy: "jev", metrics: gate.metrics, call: called.cost };
    return { kind: "act", op: "CLICK", target, decidedBy: "jev", note: "jev_dismiss", metrics: gate.metrics, call: called.cost };
  }

  // ---- execution (§11) --------------------------------------------------------

  private record(entry: { subgoal: DriverField; decidedBy: "code" | "jev" | "none"; observation: Observation | null; gate: string; action: CycleReceipt["action"];
    observeMs: number; plan?: Plan; modelMs?: number; actMs?: number; settleMs?: number; formChanged?: boolean | null }) {
    const call = entry.plan?.call ?? null;
    this.summaryState.receipts.push({
      schema: "jev-driver-cycle.v1", cycle: this.summaryState.receipts.length + 1, subgoal: entry.subgoal, decidedBy: entry.decidedBy,
      observationHash: entry.observation ? hashState(entry.observation.records.map((record) => record.projected)) : null,
      records: entry.observation?.records.length ?? 0, candidates: null, offeredOps: null,
      op: entry.plan && entry.plan.kind === "act" ? entry.plan.op : null, metrics: entry.plan?.metrics ?? null,
      gate: entry.gate, action: entry.action, formChanged: entry.formChanged ?? null,
      timings: { observeMs: entry.observeMs, modelMs: call?.latencyMs ?? 0, actMs: entry.actMs ?? 0, settleMs: entry.settleMs ?? 0 },
      tokens: { input: call?.input ?? null, output: call?.output ?? null, estimated: call?.estimated ?? null }, requestId: call?.requestId ?? null,
    });
  }

  private async execute(plan: Extract<Plan, { kind: "act" }>, current: DriverField, observation: Observation, observeMs: number): Promise<DriverOutcome | null> {
    const effect = (value: string) => { this.recent.push({ op: plan.op, field: current, effect: value }); if (this.recent.length > 6) this.recent.shift(); };
    const receipt = (gate: string, action: CycleReceipt["action"], extra: { actMs?: number; settleMs?: number; formChanged?: boolean | null } = {}) =>
      this.record({ subgoal: current, decidedBy: plan.decidedBy, observation, gate, action, observeMs, plan, ...extra });

    if (plan.op === "WAIT") {
      const needed = OPTION_FIELDS.includes(current as OptionField) || current === "quantity" ? this.controlsFor(current as OptionField | "quantity", observation) : [];
      const justified = observation.signals.has("loading") || observation.signals.has("pricing_in_progress") || needed.some((record) => record.disabled);
      if (!justified) { this.lastCycleActed = true; receipt("noop_wait", "skipped"); effect("no_change"); return null; }
      this.modelWaits += 1;
      if (this.modelWaits > this.limits.modelWaits) return this.stop("budget_time", "model_waits");
      await this.waitForSignalsToClear(this.limits.modelWaitMs);
      receipt("wait", "waited");
      this.lastCycleActed = true;
      effect("waited");
      return null;
    }
    if (plan.op === "DONE") {
      await sleep(60);
      const fresh = await this.observe();
      if (fresh && this.verify(current, fresh) === "verified") { receipt("done_verified", "verified"); return null; }
      this.doneRejected += 1;
      this.hit("done_rejected");
      receipt("done_rejected", "skipped");
      effect("done_rejected");
      this.lastCycleActed = true;
      if (this.doneRejected >= this.limits.rejectedDone) return this.stop("verification_gap", current);
      return null;
    }
    if (plan.op === "BLOCKED" || !plan.target) return this.stop("blocked", current);
    const target = plan.target;
    const frameObservation = observation.frames.get(target.frame);
    if (!frameObservation) return this.stop("observation_failed", "frame");
    const isFill = plan.op === "FILL_REQUIRED_VALUE";
    const prepared = await prepareTarget(this.page, target.frame, target.node, { fill: isFill });
    if (!prepared.ok) {
      if (prepared.reason === "deny_hit") { this.hit("execution_deny"); receipt("deny_hit", "skipped"); return this.stop("deny_hit", target.role); }
      this.hit(prepared.reason === "occluded" || prepared.reason === "frame_occluded" ? "occluded" : "stale");
      if (plan.decidedBy === "code" && this.options.decide) this.blockedShortcut = current;
      return this.markStale(receipt, effect, prepared.reason);
    }
    const guardMatches = JSON.stringify(prepared.guard) === JSON.stringify(frameObservation.guards[String(target.node)])
      && JSON.stringify(prepared.pageKey) === JSON.stringify(frameObservation.pageKey);
    let fresh = guardMatches;
    if (fresh && isFill) {
      const again = await observeFrame(target.frame, { deny: DENY_PATTERN, maxRecords: this.limits.records + 40, offerContainers: XOMETRY_LOCATORS.offerContainers }).catch(() => null);
      fresh = !!again && JSON.stringify(again.marker) === JSON.stringify(frameObservation.marker);
    }
    if (!fresh) { this.hit("stale"); return this.markStale(receipt, effect, "guard"); }
    this.stale = 0;

    let value: string | null = null;
    if (isFill) {
      if (current === "quantity") value = this.binding.quantityValue;
      else if (OPTION_FIELDS.includes(current as OptionField)) {
        const field = current as OptionField;
        value = this.binding.searchValue(field, this.attempts[field] ?? 0);
        if (value === null) return this.stop("value_unavailable", field);
        this.attempts[field] = (this.attempts[field] ?? 0) + 1;
      } else return this.stop("invalid_decision", "fill_without_field");
    }
    await this.options.checkpoint("before_configure");
    this.summaryState.actions += 1;
    this.mutationPossible = true;
    const before = await readPageKey(target.frame);
    const actStarted = performance.now();
    try {
      if (isFill && value !== null) {
        await typeValue(this.page, prepared.x, prepared.y, value);
        if (current === "quantity") {
          await this.options.checkpoint("before_configure");
          await this.page.keyboard.press("Enter");
        }
      } else {
        await clickAt(this.page, prepared.x, prepared.y);
      }
    } catch {
      receipt("action_uncertain", "uncertain");
      return this.stop("action_uncertain", plan.op);
    }
    const actMs = Math.round(performance.now() - actStarted);
    const combobox = isFill && current !== "quantity";
    const settleMs = await settleTarget(target.frame, target.node, combobox);
    const flagged = this.flagStop();
    if (flagged) { receipt("boundary", "executed", { actMs, settleMs }); return flagged; }
    const after = await readPageKey(target.frame);
    let formChanged: boolean | null = null;
    if (before && after) {
      const diff = changedControls(before, after);
      if (diff.sameDocument) {
        const allowed = new Set<number>([target.node]);
        if (plan.op === "SELECT_REQUIRED_VALUE") {
          for (const record of observation.records) {
            if (record.frame !== target.frame) continue;
            if (record.field === current) allowed.add(record.node);
            if (target.role === "radio" && record.role === "radio" && record.inDialog === target.inDialog) allowed.add(record.node);
          }
        }
        const unexpected = diff.changed.filter((node) => !allowed.has(node));
        formChanged = diff.changed.length > 0;
        if (unexpected.length) {
          const roles = unexpected.map((node) => observation.records.find((record) => record.node === node && record.frame === target.frame)?.klass ?? "unlisted");
          receipt("unexpected_mutation", "executed", { actMs, settleMs, formChanged });
          return this.stop("unexpected_mutation", `${plan.op}:${roles.join(",")}`);
        }
      }
    }
    receipt(plan.note, "executed", { actMs, settleMs, formChanged });
    this.lastCycleActed = true;
    effect(isFill && combobox ? "search_typed" : "executed");
    return null;
  }

  private markStale(receipt: (gate: string, action: CycleReceipt["action"]) => void, effect: (value: string) => void, why: string): DriverOutcome | null {
    this.stale += 1;
    this.lastCycleActed = true;
    receipt(`stale:${why}`, "skipped");
    effect("stale");
    if (this.stale >= this.limits.stale) return this.stop("stale_loop", why);
    return null;
  }

  // ---- save (§7 shortcut c, §19.3 macro) -------------------------------------

  async save(): Promise<DriverOutcome> {
    const budget = this.budgetStop();
    if (budget) return this.stop(budget);
    const cycleStarted = performance.now();
    const observation = await this.observe();
    const observeMs = Math.round(performance.now() - cycleStarted);
    if (!observation) return this.stop("observation_failed");
    const flagged = this.flagStop();
    if (flagged) return flagged;
    if (observation.signals.has("export_control")) return this.stop("export_control");
    if (observation.modalText) return this.stop("unknown_dialog", "save");
    this.summaryState.cycles += 1;
    const buttons = observation.records.filter((record) => record.role === "button" && !record.disabled && !record.denied);
    const named = buttons.filter((record) => this.binding.saveNames.has(record.projected.name));
    let target: DriverRecord | null = null;
    let plan: Plan | null = null;
    if (this.options.shortcuts && named.length === 1) {
      target = named[0];
      plan = { kind: "act", op: "CLICK", target, decidedBy: "code", note: "shortcut_save", metrics: null, call: null };
      this.summaryState.codeDecisions += 1;
    } else if (this.options.modelResolvedSave && buttons.length) {
      const { request, keys } = buildSaveRequest(this.elements(observation, "save"), buttons.map((record) => record.id), [...observation.signals]);
      const called = await this.callModel("save", request);
      if ("error" in called) return this.stop(called.error, called.detail);
      const gate = gateSaveDecision(keys, called.result.answers);
      if (gate.kind === "stop") {
        this.record({ subgoal: "save", decidedBy: "jev", observation, gate: gate.detail, action: "none", observeMs,
          plan: { kind: "stop", reason: gate.reason, detail: gate.detail, decidedBy: "jev", metrics: gate.metrics, call: called.cost } });
        return this.stop("save_unresolved", gate.detail);
      }
      target = observation.byId.get(gate.target ?? "") ?? null;
      if (!target) return this.stop("invalid_decision", "save_target");
      if (buttons.filter((record) => record.klass === target!.klass).length > 1) return this.stop("ambiguous_duplicate", "save");
      plan = { kind: "act", op: "CLICK", target, decidedBy: "jev", note: "jev_save", metrics: gate.metrics, call: called.cost };
      this.summaryState.jevDecisions += 1;
    } else {
      return this.stop("save_unresolved", named.length ? "duplicate_save" : "no_save_button");
    }
    const prepared = await prepareTarget(this.page, target.frame, target.node);
    if (!prepared.ok) {
      const again = await this.observe();
      if (again?.signals.has("export_control")) return this.stop("export_control", "save");
      if (again?.modalText) return this.stop("unknown_dialog", "save");
      return this.stop(prepared.reason === "deny_hit" ? "deny_hit" : "stale_loop", `save_${prepared.reason}`);
    }
    await this.options.checkpoint("before_save");
    const configurationUrl = this.page.url();
    this.summaryState.actions += 1;
    this.mutationPossible = true;
    const actStarted = performance.now();
    try {
      await clickAt(this.page, prepared.x, prepared.y);
    } catch {
      return this.stop("action_uncertain", "save");
    }
    const navigated = await this.page.waitForURL((url) => url.toString() !== configurationUrl, { timeout: this.limits.saveNavigationMs })
      .then(() => true).catch(() => false);
    const settled = navigated && await this.page.waitForFunction(() => {
      const text = document.body?.innerText ?? "";
      return (/least expensive/i.test(text) && /\$\d[\d,]*\.\d{2}/.test(text))
        || /manual review|manually quoted|manually-quoted|requires review|drawing required/i.test(text);
    }, undefined, { timeout: this.limits.saveSettleMs }).then(() => true).catch(() => false);
    this.record({ subgoal: "save", decidedBy: plan.decidedBy, observation, gate: plan.note, action: "executed", observeMs, plan,
      actMs: Math.round(performance.now() - actStarted) });
    this.summaryState.cycleMs.push(Math.round(performance.now() - cycleStarted));
    const boundary = this.flags.boundary || this.flags.popup || this.flags.fileChooser;
    if (boundary) return this.stop("boundary_violation", "save");
    if (!navigated) return this.stop("save_failed", "no_navigation");
    if (!settled) return this.stop("save_failed", "no_price_or_manual_review");
    this.status.set("save", "verified");
    return { status: "completed", verified: [...this.status.keys()], summary: this.summary };
  }
}
