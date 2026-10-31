import type { QuestionsDecider } from "../questions.js";

/**
 * Shared types for the Jev quote driver (docs/jev-quote-driver.md). Code owns
 * every value, action, rail and status; the model only picks an operation and
 * an element id from tables code has already filtered.
 */
export const DRIVER_REVISION = "jev-quote-driver.v1" as const;

export type DriverField = "dialog" | "process" | "material" | "finish" | "quantity";
export type ConfigField = Exclude<DriverField, "dialog">;
export const CONFIG_FIELD_ORDER: readonly ConfigField[] = ["process", "material", "finish", "quantity"];
export type SubGoalStatus = "pending" | "applied" | "verified" | "skipped";
export type DriverOp = "CLICK" | "FILL_REQUIRED_VALUE" | "SELECT_REQUIRED_VALUE" | "WAIT" | "DONE" | "BLOCKED";
export const DRIVER_OPS: readonly DriverOp[] = ["CLICK", "FILL_REQUIRED_VALUE", "SELECT_REQUIRED_VALUE", "WAIT", "DONE", "BLOCKED"];

/**
 * One actionable element as the in-page observer saw it. Raw strings are page
 * data: policy and verification read them in-process, and they never reach
 * the model, a receipt or a log.
 */
export type RawElement = {
  /** Frame-namespaced, stable while the node lives: `f0_e12`. */
  id: string;
  tag: string;
  role: string;
  name: string;
  /** Nearest label-like text: a reviewed phrase when one is close, else the nearest sibling text. */
  near: string;
  text: string;
  /** Current input value. */
  value: string;
  /** Displayed selection that code did not type: selected label, checked state text, single-value text. */
  display: string;
  type: string;
  inputMode: string;
  placeholder: string;
  href: string | null;
  testId: string | null;
  domId: string | null;
  nameAttr: string | null;
  title: string | null;
  scopeText: string;
  editable: boolean;
  disabled: boolean;
  checked: boolean | null;
  expanded: boolean | null;
  inDialog: boolean;
  /** Inside an excluded container (offer/tier cards) or a scope with payment inputs. */
  excluded: boolean;
  offscreen: boolean;
  guard: string;
  /** Native `<select>` option: index within its select. */
  optionIndex: number | null;
};

export type RawDialog = { text: string; elementIds: string[] };

export type RawObservation = {
  url: string;
  /** Freshness key for CLICK/SELECT: URL, scroll, viewport and every form control's state. */
  pageKey: string;
  /** Freshness key for everything else: page key plus visible text and element semantics. */
  marker: string;
  elements: RawElement[];
  dialogs: RawDialog[];
  /** Visible body text, for code signal regexes only. */
  bodyText: string;
  /** Per form control state (`id -> value|checked|index`), for the side-effect diff. */
  formState: Record<string, string>;
  foreignFrames: number;
  unsupported: number;
  truncated: boolean;
};

/** Live recheck of one node immediately before execution (§11.5). */
export type LiveTarget = {
  id: string;
  pageKey: string;
  marker: string;
  guard: string;
  connected: boolean;
  actionable: boolean;
  /** Page coordinates with the frame offset applied. Present only when the centre hit-tests to the node. */
  point: { x: number; y: number } | null;
  /** Live strings for the execution-time deny check. */
  denyText: string;
};

export type BoundaryViolation = "network" | "popup" | "navigation" | "file_chooser";

/** The browser seam. `executor.ts` implements it with Playwright; tests use a simulated page. */
export type DriverSurface = {
  observe(): Promise<RawObservation>;
  inspect(id: string, options: { scroll: boolean; forFill: boolean }): Promise<LiveTarget | null>;
  click(target: LiveTarget): Promise<void>;
  fill(target: LiveTarget, value: string): Promise<void>;
  pressEnter(): Promise<void>;
  selectNative(target: LiveTarget): Promise<void>;
  settle(kind: "action" | "combobox_fill", targetId: string | null): Promise<void>;
  sleep(ms: number): Promise<void>;
  boundaryViolation(): BoundaryViolation | null;
  locatorCandidates(id: string): Promise<string[]>;
  skeleton(id: string): Promise<string | null>;
};

export type DriverLimits = Readonly<{
  calls: number;
  actions: number;
  inputTokens: number;
  requestTokens: number;
  cyclesPerSubGoal: number;
  consecutiveStale: number;
  consecutiveNoProgress: number;
  rejectedDone: number;
  regressionsPerField: number;
  wallMs: number;
  modelDeadlineMs: number;
  codeWaitMs: number;
  codeWaitOccurrences: number;
  modelWaitMs: number;
  modelWaits: number;
}>;

/** Frozen production values (§14). `limits` on the capability is a test seam only. */
export const DRIVER_LIMITS: DriverLimits = Object.freeze({
  calls: 30,
  actions: 20,
  inputTokens: 120_000,
  requestTokens: 6_000,
  cyclesPerSubGoal: 8,
  consecutiveStale: 3,
  consecutiveNoProgress: 3,
  rejectedDone: 2,
  regressionsPerField: 2,
  wallMs: 120_000,
  modelDeadlineMs: 5_000,
  codeWaitMs: 15_000,
  codeWaitOccurrences: 3,
  modelWaitMs: 5_000,
  modelWaits: 4,
});

export type StopReason =
  | "budget_calls" | "budget_actions" | "budget_tokens" | "budget_request" | "budget_time" | "budget_observation"
  | "subgoal_budget" | "stale_loop" | "no_progress" | "verification_gap" | "regression_loop"
  | "low_confidence" | "invalid_decision" | "inference_unavailable" | "blocked"
  | "ambiguous_duplicate" | "ambiguous_option" | "deny_hit" | "unsupported_ui" | "unknown_dialog" | "units_unknown"
  | "export_control" | "blocking_state" | "manual_review" | "boundary_violation"
  | "action_uncertain" | "unexpected_mutation" | "audit_unavailable" | "cancelled";

export type GateHit = "deny_hit" | "stale" | "occluded" | "duplicate" | "low_confidence" | "budget";

/** `jev-driver-cycle.v1`: hashes, counts, enums and numbers only (§16). */
export type DriverCycleReceipt = {
  schema: "jev-driver-cycle.v1";
  revision: typeof DRIVER_REVISION;
  phase: "planned" | "settled" | "stopped";
  cycle: number;
  subGoal: DriverField;
  decidedBy: "code" | "jev" | null;
  observationHash: string;
  candidateCounts: Partial<Record<DriverOp, number>>;
  offeredOps: DriverOp[];
  op: DriverOp | null;
  opConfidence: number | null;
  reversedAgrees: boolean | null;
  targetProbability: number | null;
  noneProbability: number | null;
  controlPresent: number | null;
  targetId: string | null;
  targetGuardHash: string | null;
  gates: GateHit[];
  outcome: "planned" | "executed" | "skipped" | "uncertain" | "stopped";
  pageChanged: boolean | null;
  formStateChanged: boolean | null;
  timingsMs: { observe: number; model: number; act: number; settle: number };
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensEstimated: boolean;
  requestId: string | null;
  stopReason: StopReason | null;
};

export type DriverRunSummary = {
  schema: "jev-driver-run.v1";
  revision: typeof DRIVER_REVISION;
  policyRevision: string;
  snapshotRevision: string;
  vocabularyDigest: string;
  outcome: "completed" | "stopped";
  stopReason: StopReason | null;
  subGoals: Partial<Record<ConfigField, SubGoalStatus>>;
  cycles: number;
  modelCalls: number;
  codeDecisions: number;
  actions: number;
  inputTokens: number;
  outputTokens: number;
  tokensEstimated: boolean;
  costUsdEstimate: number;
  priceSource: string;
  cycleLatencyMs: { p50: number; p95: number };
  elapsedMs: number;
  gateHits: Partial<Record<GateHit, number>>;
};

export type LocatorCandidate = { field: ConfigField; selector: string; kind: "test_id" | "role" | "label_anchor" | "stable_attribute" };

export type DriverOutcome =
  | { status: "completed"; verified: ConfigField[]; matched: Partial<Record<ConfigField, string>>; summary: DriverRunSummary; candidates: LocatorCandidate[]; skeletons: Partial<Record<ConfigField, string>> }
  | { status: "stopped"; reason: StopReason; field: DriverField | null; mutationPossible: boolean; summary: DriverRunSummary };

/** Supplied only by a host. No environment variable turns the driver on. */
export type JevDriverCapability = Readonly<{
  /** Keyed transport built by the host; the key never enters the driver. */
  decide: QuestionsDecider;
  /** Durable receipt sink. Must resolve true before any action is taken. */
  audit: (receipt: DriverCycleReceipt, signal: AbortSignal) => Promise<boolean>;
  /** Pinned; changing it requires benchmark re-tuning. */
  model: "jev-1.13.0";
  /** Receives a verified `driven_locator_candidate.v1` after the quote's own gates pass. Best effort. */
  emitRepairCandidate?: (payload: unknown) => Promise<void>;
  /** Test seam only. */
  limits?: Partial<DriverLimits>;
}>;

export type PageSignal =
  | "configuration_panel" | "loading" | "pricing_in_progress" | "manual_review" | "export_control"
  | "blocking" | "units_prompt" | "confirm_prompt" | "error_banner";
export type DialogClass = "units_prompt" | "confirm_prompt" | "export_control" | "unknown";
export type PageClass = { signals: PageSignal[]; dialog: DialogClass | null };

/** What code requires of one configuration field. Values come from the approved requirement only. */
export type FieldSpec = Readonly<{
  field: ConfigField;
  kind: "number" | "option";
  /** Normalized whole words that tie a control to this field ("quantity", "material"). */
  keywords: readonly string[];
  /** Typed values in order: the quantity string, or the option search terms (attempt n types term n). */
  fillValues: readonly string[];
  /** Exact terms code accepts as the required value, in preference order. */
  acceptTerms: readonly string[];
  /** Quote-summary label for read-back verification, e.g. "Material". */
  summaryLabel: string | null;
}>;

/** Provider binding: everything the generic loop needs to know about one portal. */
export type DriverBinding = Readonly<{
  vendor: string;
  policyRevision: string;
  fields: readonly FieldSpec[];
  /** Normalized reviewed phrases. Only these reach the model as names or `near` text. */
  vocabulary: ReadonlySet<string>;
  vocabularyDigest: string;
  /** Catalog terms that turn an unreviewed option label into «catalog» instead of «text». */
  catalogTerms: readonly string[];
  /** Normalized names of the one save control the code macro may press. */
  saveVocabulary: readonly string[];
  cadUnits: "mm" | "inch" | null;
  classify: (observation: RawObservation) => PageClass;
  routeAllowed: (url: string) => boolean;
  matchTerm: (text: string, terms: readonly string[]) => string | null;
  summaryField: (bodyText: string, label: string) => string | null;
  /** Kill-switch checkpoint. Called outside every catch before each action. */
  beforeAction: () => Promise<void>;
  signal?: AbortSignal;
}>;
