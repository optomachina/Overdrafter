import type { VendorQuoteAcceptance } from "./vendorQuoteOfferPersistence.js";
import { createHash } from "node:crypto";
import { PROVIDER_CATALOG } from "./generated/provider-catalog.js";
import {
  REVIEWED_PROVIDER_DISPATCH_ENVELOPES,
  type ReviewedProviderDispatchEnvelope,
} from "./providerDispatchEnvelope.js";
import { ProviderDispatchAuthorizationError, type ProviderDispatchClaim } from "./providerDispatchPreflight.js";
import type {
  ProviderDispatchAuthorization,
  ProviderDispatchEnvelope,
  ProviderDispatchFileRole,
} from "./providerDispatchTypes.js";
import {
  executeWithProviderAuthorization,
  PROVIDER_EXECUTION_ENVIRONMENTS,
  type ProviderAuthorizationConsumer,
  type ProviderExecutionCapturedFile,
  type ProviderExecutionContext,
  type ProviderExecutionEnvironment,
  type ProviderExecutionGuard,
  type ProviderExecutionLogger,
  type ProviderExecutionResult,
  type ProviderExecutionSession,
  type ProviderExecutionTerminalOutcome,
} from "./providerExecutionSeam.js";
import {
  PROVIDER_RESULT_CONTRACT_VERSION,
  sanitizeRawPayload,
  toAdminRejectionDiagnostic,
  validateProviderResult,
  type ProviderResultCandidate,
  type ProviderResultExpectation,
  type ProviderResultValidation,
  type ValidatedProviderResult,
} from "./providerResultValidation.js";
import {
  createProviderMutationPhase,
  runInProviderMutationPhase,
  type ProviderMutationPhase,
} from "./providerMutationPhase.js";
import {
  VendorAutomationError,
  type VendorArtifact,
  type VendorName,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOffer,
  type VendorQuoteAdapterOutput,
} from "./types.js";
import { PROVIDER_ABORTED, ProviderAbortedError, throwIfProviderAborted, withProviderAbortSignal } from "./providerAbort.js";
import {
  CANCELLED_PROVIDER_DISABLED,
  isProviderKillSwitchEngaged,
  PROVIDER_KILL_SWITCH_ENGAGED,
  PROVIDER_DAILY_CAP_REACHED,
  PROVIDER_KILL_SWITCH_UNAVAILABLE,
  ProviderDispatchRefusedError,
  ProviderKillSwitchError,
} from "./providerSettings.js";
import { isRetryableVendorTaskError, nextRetryAt } from "./vendorTaskRetry.js";

/**
 * OVD-464: the single provider neutral launch boundary for a claimed
 * `run_vendor_quote` task on the generic permit route (live, non Xometry,
 * carrying `providerDispatchPermitId` and `providerDispatchEnvelopeFingerprint`).
 * Xometry keeps its specialized path in `xometryDispatchPreflight.ts`.
 *
 * Order, each step only after the previous one passed:
 *   1. the task is already claimed (`api_claim_next_task` incremented attempts)
 *   2. resolve current capability and service authorization (OVD-459 preflight)
 *   3. verify the captured bytes against the authorized outbound files
 *   4. acquire the exact session lease (OVD-462), only when the setting is on
 *   5. invoke only the admitted adapter through the OVD-461 seam
 *   6. validate the complete normalized result (OVD-463), then the fixture
 *      sanity gate (OVD-813, `deps.sanity`), which may hold the result
 *   7. persist atomically (one claim-fenced acceptance call)
 *   8. release the lease
 *
 * Every denial returns an outcome with zero adapter calls. There is no
 * fallback to another provider, an aggregator or a generic session.
 *
 * Retry authority: `decideProviderTaskRetry` is the only place this route
 * decides to requeue. The caller writes the outcome and must not rethrow it
 * into the worker's generic task retry. Only a pre dispatch transient (the
 * adapter never started) may requeue, once. Until OVD-734 lands durable per
 * permit consumption, nothing requeues after an adapter start: a pre mutation
 * transient adapter failure settles as manual follow up (`adapter_failed`),
 * and a refused result after a completed adapter run never requeues.
 *
 * OVD-722: an engaged provider kill switch, whether the server preflight
 * denied for it or an adapter checkpoint refused (before launch, navigation,
 * upload, configuration or save), ends as `cancelled_provider_disabled`: never
 * a provider failure, never manual follow up, never a requeue.
 */

/** OVD-813: the lane stop for a supplier the fixture sanity gate paused. */
export const PROVIDER_PAUSED_FIXTURE_HEAL = "provider_paused_fixture_heal";

export const PROVIDER_SESSION_LEASE_SETTINGS = ["off", "on"] as const;
export type ProviderSessionLeaseSetting = (typeof PROVIDER_SESSION_LEASE_SETTINGS)[number];

/**
 * Requeues allowed after an adapter start. The cap is read from the database
 * claim counter (`work_queue.attempts`, incremented atomically by
 * `api_claim_next_task` on every claim), never from worker memory, so it holds
 * across processes and restarts. `decideProviderTaskRetry` would allow one
 * such requeue from the first claim, but the pipeline currently settles every
 * bounded post start failure for an operator instead (see
 * `effectiveFailureClass`) until OVD-734 makes permit consumption durable.
 * A worker that crashes mid run is reaped to `failed`, never requeued.
 */
export const PROVIDER_TASK_MAX_ADAPTER_REQUEUES = 1;

/**
 * Highest claim number (`work_queue.attempts` as returned by the claim RPC)
 * on which the pipeline may still start. Every adapter start happens inside a
 * claim and the database increments attempts atomically at claim, so this
 * bounds adapter starts at two even if a start crashes before reporting. A
 * claim past it settles to a visible lane state with zero adapter calls. The
 * claim RPC refusing such tasks itself is OVD-734 (window 2).
 */
export const PROVIDER_TASK_MAX_CLAIMS = PROVIDER_TASK_MAX_ADAPTER_REQUEUES + 1;

// --------------------------------------------------------------------------- lease port

/** Result shape of OVD-462 `runWithLease`, kept structural so tests can fake the lease; wired in `providerTaskLeasePort.ts`. */
export type ProviderTaskLeaseRunResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "lease_lost"; outcome: string }
  | { kind: "contended"; retryAfterMs: number }
  | { kind: "manual_follow_up"; outcome: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unavailable" };

export type ProviderTaskLeaseContext = { signal: AbortSignal; assertHeld(): void };

/** Adapter over OVD-462's lease manager. Inject only when the lease setting is on. */
export type ProviderTaskLeasePort = {
  /** Opaque session identity for the provider slot, or null when none is configured. */
  identity(provider: VendorName, environment: ProviderExecutionEnvironment): ProviderExecutionSession | null;
  runWithLease<T>(
    request: { identity: ProviderExecutionSession; taskRef: string },
    operation: (context: ProviderTaskLeaseContext) => Promise<T>,
  ): Promise<ProviderTaskLeaseRunResult<T>>;
  /** Builds the lease's own outcome error, so a terminal outcome blocks the binding. */
  toLeaseError(outcome: ProviderExecutionTerminalOutcome): Error;
};

// --------------------------------------------------------------------------- provider day switch

/**
 * Turns a provider off until the next UTC midnight after a block or ban
 * (never retry around a block, CAPTCHA, IP block or ban). Process local; with
 * the lease setting on, the lease also blocks the binding durably.
 */
export type ProviderDaySwitch = {
  disable(provider: VendorName, nowMs: number): void;
  isDisabled(provider: VendorName, nowMs: number): boolean;
  guard(nowMs?: () => number): ProviderExecutionGuard;
};

export function createProviderDaySwitch(): ProviderDaySwitch {
  const disabledUntil = new Map<VendorName, number>();
  const isDisabled = (provider: VendorName, nowMs: number) => (disabledUntil.get(provider) ?? 0) > nowMs;
  return {
    disable(provider, nowMs) {
      const midnight = new Date(nowMs);
      midnight.setUTCHours(24, 0, 0, 0);
      disabledUntil.set(provider, Math.max(disabledUntil.get(provider) ?? 0, midnight.getTime()));
    },
    isDisabled,
    guard(nowMs = () => Date.now()) {
      return (input) => (isDisabled(input.provider, nowMs()) ? "provider_disabled" : null);
    },
  };
}

// --------------------------------------------------------------------------- retry authority

export type ProviderTaskFailureClass =
  /** Nothing reached the provider and the cause is transient (service or lease unavailable). */
  | "pre_dispatch_transient"
  /** The adapter started and the failure allows a bounded retry. */
  | "post_start_bounded"
  /** Needs an operator; never retried. */
  | "manual_follow_up"
  /** Final; never retried. */
  | "failed";

export type ProviderTaskRetryDecision =
  | { action: "requeue"; retryAt: string }
  | { action: "manual_follow_up" }
  | { action: "fail" };

/**
 * The single retry decision for this route. `attempts` is the database claim
 * counter of the current claim. Pre dispatch transients follow the shared
 * finite schedule; a post start failure requeues at most once, and only from
 * the first claim; everything else is final.
 */
export function decideProviderTaskRetry(input: {
  failureClass: ProviderTaskFailureClass;
  attempts: number;
  /** Optional per code cap; 0 forbids a retry. Defaults to 1. */
  retryBudget?: number;
  now?: Date;
}): ProviderTaskRetryDecision {
  const attempts = Number.isInteger(input.attempts) && input.attempts > 0 ? input.attempts : Number.POSITIVE_INFINITY;
  switch (input.failureClass) {
    case "pre_dispatch_transient": {
      // A requeue is only useful if the next claim may still start.
      const retryAt = attempts < PROVIDER_TASK_MAX_CLAIMS ? nextRetryAt(attempts, input.now) : null;
      return retryAt ? { action: "requeue", retryAt } : { action: "fail" };
    }
    case "post_start_bounded": {
      const budget = Math.min(input.retryBudget ?? 1, PROVIDER_TASK_MAX_ADAPTER_REQUEUES);
      if (budget <= 0 || Number.isNaN(budget) || attempts > budget) return { action: "fail" };
      const retryAt = nextRetryAt(attempts, input.now);
      return retryAt ? { action: "requeue", retryAt } : { action: "fail" };
    }
    case "manual_follow_up":
      return { action: "manual_follow_up" };
    default:
      return { action: "fail" };
  }
}

// --------------------------------------------------------------------------- adapter failure class

/** Terminal portal states that never change on a rerun. */
const DETERMINISTIC_TERMINAL_STATES: ReadonlySet<unknown> = new Set(["unsupported", "selector_drift"]);

/**
 * Classes an error thrown by the adapter, given the mutation phase the
 * pipeline ran the adapter in. Only a failure the shared vendor retry policy
 * accepts before any provider mutation (a transient navigation, network or
 * persistence failure) is classed `post_start_bounded`; the pipeline settles
 * it for an operator rather than requeueing (see `effectiveFailureClass`). Any mutation
 * evidence, from the phase or the error's own `providerMutationPossible`, means
 * the provider may hold an upload or a quote: never requeue, an operator looks.
 */
export function classifyProviderAdapterFailure(
  error: unknown,
  phase: ProviderMutationPhase,
): { failureClass: ProviderTaskFailureClass; code: string } {
  // OVD-722: an unreadable switch may be an engaged one, so it is not routed
  // to manual quoting unless the provider may already hold an upload.
  if (error instanceof ProviderKillSwitchError && error.reasonCode === PROVIDER_KILL_SWITCH_UNAVAILABLE) {
    return phase.started
      ? { failureClass: "manual_follow_up", code: PROVIDER_KILL_SWITCH_UNAVAILABLE }
      : { failureClass: "failed", code: PROVIDER_KILL_SWITCH_UNAVAILABLE };
  }
  // OVD-829: the supplier settings gate refused before launch, so nothing was
  // sent. A spent daily cap goes to manual quoting; an unreachable counter
  // fails like an unreadable switch (it may be a spent cap).
  if (error instanceof ProviderDispatchRefusedError) {
    return {
      failureClass: error.reasonCode === PROVIDER_DAILY_CAP_REACHED ? "manual_follow_up" : "failed",
      code: error.reasonCode,
    };
  }
  // OVD-748: an abort is a stop decision, never a provider failure and never retried.
  if (error instanceof ProviderAbortedError) {
    return { failureClass: phase.started ? "manual_follow_up" : "failed", code: PROVIDER_ABORTED };
  }
  const vendorError = error instanceof VendorAutomationError ? error : null;
  if (phase.started || vendorError?.payload.providerMutationPossible === true) {
    return { failureClass: "manual_follow_up", code: "adapter_failed_after_mutation" };
  }
  const terminalState = vendorError?.payload.terminalState;
  if (DETERMINISTIC_TERMINAL_STATES.has(terminalState)) {
    return { failureClass: "manual_follow_up", code: `adapter_${String(terminalState)}` };
  }
  if (isRetryableVendorTaskError(error, phase)) return { failureClass: "post_start_bounded", code: "adapter_failed" };
  if (vendorError) return { failureClass: "manual_follow_up", code: `adapter_${vendorError.code}` };
  return { failureClass: "failed", code: "adapter_failed" };
}

// --------------------------------------------------------------------------- outcome

export type ProviderTaskStage = "authorize" | "verify_bytes" | "lease" | "adapter" | "validate" | "persist";

export type ProviderTaskOutcome = {
  /** Finite visible state for the lane. */
  disposition: "persisted" | "requeue" | "manual_follow_up" | "failed" | "cancelled_provider_disabled";
  /** Stable code; never adapter supplied text. */
  code: string;
  stage: ProviderTaskStage;
  adapterStarted: boolean;
  retryAt: string | null;
  /** True after a block or ban: the provider was switched off for the rest of the UTC day. */
  providerDisabledForDay: boolean;
  /** Admin visible validator rejection, when the result was refused. */
  rejection: ReturnType<typeof toAdminRejectionDiagnostic> | null;
  /**
   * OVD-722: set only for `cancelled_provider_disabled`. Mutation is possible
   * only when the adapter's mutation phase had started before the refusal.
   */
  killSwitch: { error: ProviderKillSwitchError; providerMutationPossible: boolean } | null;
  /**
   * Set only when persisted. `held` means the OVD-813 sanity gate withheld the
   * prices and offers: the caller must not compute routing scores from it.
   */
  persisted: { status: VendorQuoteAdapterOutput["status"]; offerCount: number; artifactCount: number; acceptance: VendorQuoteAcceptance; held?: boolean } | null;
  /**
   * Failure evidence for the worker to keep and clean up: the adapter's own
   * error (for repair candidates) and the artifacts of a failed or refused
   * run. Empty when persisted. Never written to the lane as text.
   */
  evidence: { adapterError: VendorAutomationError | null; artifacts: VendorArtifact[] };
};

// --------------------------------------------------------------------------- inputs

/** Lane identity read from the database by the worker, independent of the authorization. */
export type ProviderTaskLane = {
  laneId: string;
  quoteRequestId: string;
  quoteRunId: string;
  vendorQuoteResultId: string;
  scopeFingerprint: string;
};

export type ProviderTaskPipelineInput = {
  /** `attempts` is the value returned by `api_claim_next_task` for this claim; never a worker side counter. */
  task: { id: string; attempts: number; organizationId: string; quoteRunId: string };
  claim: ProviderDispatchClaim;
  /** `vendor_quote_results.requested_quantity` for the claimed lane. */
  requestedQuantity: number;
  environment: ProviderExecutionEnvironment;
  /** Bounded text identifying the running adapter build. */
  adapterRevision: string;
  leaseSetting: ProviderSessionLeaseSetting;
  quoteInput: VendorQuoteAdapterInput;
  /** OVD-813: a verified internal test quote (internal marker, internal org, golden part). */
  internalTestQuote?: boolean;
};

/** OVD-813: what the fixture sanity gate needs about the lane; kept structural so the pipeline imports no heal code. */
export type ProviderTaskSanityContext = {
  provider: VendorName;
  vendorQuoteResultId: string;
  quoteRunId: string;
  requestedQuantity: number;
  packageId: string;
  internalTestQuote: boolean;
};

export type ProviderTaskPipelineDeps = {
  /** Reads the registered lane for the claimed result from the database. */
  readLane(): Promise<ProviderTaskLane>;
  /** OVD-459 service preflight; throws ProviderDispatchAuthorizationError on denial. */
  authorize(): Promise<ProviderDispatchAuthorization>;
  /** Reads the staged bytes for exactly the authorized roles; the adapter sees no other file. */
  readCapturedFiles(roles: readonly ProviderDispatchFileRole[]): Promise<ProviderExecutionCapturedFile[]>;
  /** The registered adapter for exactly `claim.provider`, or null. */
  adapter: { provider: VendorName; quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> } | null;
  /** One atomic write of the validated result and its complete offer set. */
  persist(output: VendorQuoteAdapterOutput, metadata: { offerCount: number }): Promise<{ artifactCount: number; acceptance: VendorQuoteAcceptance }>;
  lease?: ProviderTaskLeasePort | null;
  daySwitch: ProviderDaySwitch;
  /** Replay record for the seam, keyed by permit and fingerprint, so one permit dispatches at most once per process. */
  consumer?: ProviderAuthorizationConsumer;
  guards?: readonly ProviderExecutionGuard[];
  validate?: (candidate: ProviderResultCandidate, expectation: ProviderResultExpectation) => ProviderResultValidation;
  /**
   * OVD-813: the fixture sanity gate, run between validation and persist. A
   * held result comes back as `manual_review_pending` without prices or offers.
   */
  sanity?: (
    output: VendorQuoteAdapterOutput,
    context: ProviderTaskSanityContext,
  ) => Promise<{ output: VendorQuoteAdapterOutput; held: boolean }>;
  /** OVD-813: the fixture-heal supplier pause; a paused supplier admits only internal test quotes. */
  pause?: { admits(provider: VendorName, quote: { internalTestQuote: boolean }): boolean };
  now?: () => number;
  log?: ProviderExecutionLogger;
  /**
   * Called once, immediately before the adapter is invoked, outside the
   * adapter's mutation phase. It must not mark a provider mutation: only the
   * adapter knows when its first upload or configuration starts.
   */
  onAdapterStart?: () => void;
};

// --------------------------------------------------------------------------- helpers

const SHA256 = /^[a-f0-9]{64}$/;
const BLOCKING_DAY_OFF: ReadonlySet<string> = new Set(["blocked", "banned", "provider_blocked", "account_banned"]);
const TERMINAL_CODES: Readonly<Record<ProviderExecutionTerminalOutcome, string>> = {
  login_required: "login_required",
  challenge_required: "challenge_required",
  blocked: "provider_blocked",
  banned: "account_banned",
};

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Package identity: the sorted role and digest pairs of the disclosed files. */
export function providerPackageId(files: readonly { role: string; sha256: string }[]): string {
  return sha256Hex(
    files
      .map((file) => `${file.role}:${file.sha256}`)
      .sort((a, b) => a.localeCompare(b, "en"))
      .join("\n"),
  );
}

function envelopeRevision(envelope: { id: string; version: number }): string {
  return `${envelope.id}.v${envelope.version}`;
}

/** Deterministic opaque session identity used while the lease setting is off. */
export function unleasedSessionIdentity(
  provider: VendorName,
  environment: ProviderExecutionEnvironment,
): ProviderExecutionSession {
  const digest = sha256Hex(`ovd464.unleased:${provider}:${environment}`);
  return { provider, environment, accountRef: `acct_${digest.slice(0, 32)}`, sessionBindingRef: `sb_${digest.slice(32, 64)}` };
}

function capturedFilesMatch(envelope: ProviderDispatchEnvelope, files: readonly ProviderExecutionCapturedFile[]): boolean {
  if (!Array.isArray(files) || files.length !== envelope.outboundFiles.length) return false;
  const roles = new Set<string>();
  for (const file of files) {
    if (!file || !(file.bytes instanceof Uint8Array) || roles.has(file.role)) return false;
    roles.add(file.role);
    const authorized = envelope.outboundFiles.find((outbound) => outbound.role === file.role);
    const digest = sha256Hex(file.bytes);
    if (authorized?.sha256 !== digest || authorized.sourceSha256 !== digest) return false;
  }
  return true;
}

/** `vendor_quote_offers.sort_rank` is int4; ranks are positions, so negatives are refused too. */
export const MAX_PERSISTED_SORT_RANK = 2_147_483_647;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isPersistableSortRank(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_PERSISTED_SORT_RANK;
}

/**
 * The single place a result level expiry is derived. A vendor date wins; a
 * vendor stated duration runs from the quote time, or the collection time when
 * the vendor gave none, and its end is inclusive (the OVD-463 rule).
 */
export function deriveProviderResultValidUntil(
  output: Pick<VendorQuoteAdapterOutput, "validitySource" | "validityDurationDays">,
  validated: Pick<ValidatedProviderResult, "validUntil" | "quotedAt" | "provenance">,
): string | null {
  if (validated.validUntil) return validated.validUntil;
  const days = output.validityDurationDays;
  if (output.validitySource !== "vendor_duration" || !Number.isInteger(days) || (days as number) <= 0) return null;
  const anchorMs = Date.parse(validated.quotedAt ?? validated.provenance.collectedAt);
  if (!Number.isFinite(anchorMs)) return null;
  return new Date(anchorMs + (days as number) * DAY_MS).toISOString();
}

/**
 * Raw payload marker for an expiry the worker derived from a vendor duration.
 * The persistence layer must then keep the raw `validUntil` empty, so the
 * database validity trigger keeps `validity_source = vendor_duration` instead
 * of relabeling a derived date as a vendor date.
 */
export const PROVIDER_RESULT_VALID_UNTIL_DERIVED = "providerResultValidUntilDerived";

function toAdapterOutput(
  output: VendorQuoteAdapterOutput,
  validated: ValidatedProviderResult,
  validUntil: string | null,
): VendorQuoteAdapterOutput {
  const validUntilDerived = !validated.validUntil && validUntil !== null;
  const derivedOnly = validated.offers.every((offer) => offer.derivedFromSummary);
  const offers: VendorQuoteAdapterOffer[] = validated.offers.map((offer) => ({
    providerOptionId: offer.providerOptionId,
    providerLabel: offer.providerLabel,
    quoteRef: offer.quoteRef,
    quoteUrl: offer.quoteUrl,
    quantity: offer.quantity,
    unitPriceUsd: offer.unitPriceUsd,
    totalPriceUsd: offer.totalPriceUsd,
    leadTimeBusinessDays: offer.leadTimeBusinessDays,
    shipReceiveBy: offer.shipReceiveBy,
    tier: offer.tier,
    sourcing: offer.sourcing,
    geographicOrigin: offer.geographicOrigin,
    sortRank: offer.sortRank,
    provenance: offer.provenance,
    rawPayload: offer.rawPayload,
  }));
  return {
    ...output,
    status: validated.status,
    quotedAt: validated.quotedAt,
    validUntil,
    offers: derivedOnly ? undefined : offers,
    rawPayload: {
      ...sanitizeRawPayload(output.rawPayload ?? {}),
      providerResultContract: validated.contractVersion,
      providerResultProvenance: validated.provenance,
      ...(validUntilDerived ? { [PROVIDER_RESULT_VALID_UNTIL_DERIVED]: true } : {}),
    },
  };
}

// --------------------------------------------------------------------------- pipeline

/** A step that did not pass: the finite reason and how the retry authority classes it. */
type Stop = {
  stop: true;
  failureClass: ProviderTaskFailureClass;
  code: string;
  stage: ProviderTaskStage;
  rejection?: ProviderTaskOutcome["rejection"];
  killSwitch?: ProviderTaskOutcome["killSwitch"];
};

function stop(failureClass: ProviderTaskFailureClass, code: string, stage: ProviderTaskStage, extra: Partial<Stop> = {}): Stop {
  return { ...extra, stop: true, failureClass, code, stage };
}

function isStop(value: unknown): value is Stop {
  return typeof value === "object" && value !== null && (value as Stop).stop === true;
}

type Persisted = {
  persisted: true;
  acceptance: VendorQuoteAcceptance;
  status: VendorQuoteAdapterOutput["status"];
  offerCount: number;
  artifactCount: number;
  held: boolean;
};

/** Mutable facts gathered while the pipeline runs; read when the outcome is built. */
type RunState = {
  adapterStarted: boolean;
  providerDisabledForDay: boolean;
  /** The pipeline owned phase the adapter runs in; adapters mark it before their first provider mutation. */
  mutationPhase: ProviderMutationPhase;
  /** What the adapter threw, kept because the seam returns `adapter_failed` without it. */
  adapterError: { error: unknown } | null;
  /** The adapter's output once it completed, kept for its evidence if it is refused. */
  output: VendorQuoteAdapterOutput | null;
};

type Route = {
  reviewed: ReviewedProviderDispatchEnvelope;
  lease: ProviderTaskLeasePort | null;
  adapter: NonNullable<ProviderTaskPipelineDeps["adapter"]>;
};

/** Exact routing: only a reviewed provider, its registered adapter, and a valid lease setting. No default, no substitute. */
function resolveRoute(input: ProviderTaskPipelineInput, deps: ProviderTaskPipelineDeps, nowMs: number): Route | Stop {
  const provider = input.claim.provider;
  if (
    !PROVIDER_EXECUTION_ENVIRONMENTS.includes(input.environment) ||
    !Number.isInteger(input.requestedQuantity) ||
    input.requestedQuantity < 1 ||
    provider === "xometry"
  ) {
    return stop("failed", "execution_request_malformed", "authorize");
  }
  const attempts = input.task.attempts;
  if (!Number.isInteger(attempts) || attempts < 1) return stop("failed", "execution_request_malformed", "authorize");
  if (attempts > PROVIDER_TASK_MAX_CLAIMS) return stop("failed", "attempts_exhausted", "authorize");
  if (input.leaseSetting !== "off" && input.leaseSetting !== "on") return stop("failed", "lease_setting_invalid", "authorize");
  const lease = input.leaseSetting === "on" ? deps.lease ?? null : null;
  if (input.leaseSetting === "on" && !lease) return stop("manual_follow_up", "session_lease_unavailable", "lease");
  const reviewed = REVIEWED_PROVIDER_DISPATCH_ENVELOPES.find(
    (entry) => entry.provider === provider && entry.requiredAdmission === "generic_dispatch",
  );
  if (!reviewed) return stop("manual_follow_up", "provider_envelope_unknown", "authorize");
  const adapter = deps.adapter;
  if (adapter?.provider !== provider || typeof adapter.quote !== "function") {
    return stop("manual_follow_up", "adapter_not_enabled", "authorize");
  }
  if (deps.daySwitch.isDisabled(provider, nowMs)) return stop("manual_follow_up", "provider_disabled", "authorize");
  return { reviewed, lease, adapter };
}

/** The claimed lane, read from the database independently of the authorization. */
async function resolveLane(input: ProviderTaskPipelineInput, deps: ProviderTaskPipelineDeps): Promise<ProviderTaskLane | Stop> {
  let lane: ProviderTaskLane;
  try {
    lane = await deps.readLane();
  } catch {
    return stop("failed", "lane_unavailable", "authorize");
  }
  if (lane?.vendorQuoteResultId !== input.claim.vendorQuoteResultId || lane.quoteRunId !== input.task.quoteRunId) {
    return stop("failed", "lane_mismatch", "authorize");
  }
  return lane;
}

/** OVD-722: the switch refused; terminal, never retried, never manual follow up. */
function killSwitchStop(error: ProviderKillSwitchError, stage: ProviderTaskStage, providerMutationPossible: boolean): Stop {
  return stop("failed", CANCELLED_PROVIDER_DISABLED, stage, { killSwitch: { error, providerMutationPossible } });
}

async function resolveAuthorization(
  deps: ProviderTaskPipelineDeps,
  provider: VendorName,
): Promise<ProviderDispatchAuthorization | Stop> {
  let authorization: ProviderDispatchAuthorization;
  try {
    authorization = await deps.authorize();
  } catch (error) {
    if (error instanceof ProviderDispatchAuthorizationError && error.denial === PROVIDER_KILL_SWITCH_ENGAGED) {
      return killSwitchStop(new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_ENGAGED, provider, "server_preflight"), "authorize", false);
    }
    if (error instanceof ProviderDispatchAuthorizationError) {
      return stop(error.retryable ? "pre_dispatch_transient" : "manual_follow_up", error.denial, "authorize");
    }
    return stop("failed", "authorization_failed", "authorize");
  }
  if (typeof authorization !== "object" || !authorization?.envelope) return stop("failed", "authorization_malformed", "authorize");
  return authorization;
}

async function resolveFiles(
  deps: ProviderTaskPipelineDeps,
  envelope: ProviderDispatchEnvelope,
): Promise<ProviderExecutionCapturedFile[] | Stop> {
  let files: ProviderExecutionCapturedFile[];
  try {
    files = await deps.readCapturedFiles(envelope.outboundFiles.map((file) => file.role));
  } catch {
    return stop("failed", "captured_file_unreadable", "verify_bytes");
  }
  return capturedFilesMatch(envelope, files) ? files : stop("manual_follow_up", "captured_file_mismatch", "verify_bytes");
}

function resolveSession(input: ProviderTaskPipelineInput, lease: ProviderTaskLeasePort | null): ProviderExecutionSession | Stop {
  let session: ProviderExecutionSession | null;
  try {
    session = lease
      ? lease.identity(input.claim.provider, input.environment)
      : unleasedSessionIdentity(input.claim.provider, input.environment);
  } catch {
    session = null;
  }
  return session ?? stop("manual_follow_up", "session_identity_unavailable", "lease");
}

/** What the seam must find in the authorization, taken from worker state. */
function buildExecutionExpectation(
  input: ProviderTaskPipelineInput,
  route: Route,
  lane: ProviderTaskLane,
  session: ProviderExecutionSession,
  authorization: ProviderDispatchAuthorization,
) {
  return {
    provider: input.claim.provider,
    accountRef: session.accountRef,
    environment: input.environment,
    sessionBindingRef: session.sessionBindingRef,
    organizationId: input.task.organizationId,
    envelope: { id: route.reviewed.id, version: route.reviewed.version },
    envelopeFingerprint: input.claim.envelopeFingerprint,
    permitId: input.claim.permitId,
    sessionBindingId: `lease:${input.claim.permitId}`,
    task: {
      quoteRequestId: lane.quoteRequestId,
      quoteRunId: input.task.quoteRunId,
      vendorQuoteResultId: input.claim.vendorQuoteResultId,
      quoteRequestLaneId: lane.laneId,
      workQueueTaskId: input.task.id,
    },
    scope: { fingerprint: lane.scopeFingerprint, requestedQuantity: input.requestedQuantity },
    // Rollout revision has no worker side source; the preflight evaluated it in the database.
    rolloutRevision: authorization.envelope.rollout.revision,
  };
}

/** Expectation from the authorization; candidate binding from independent worker state. */
function buildResultCheck(
  input: ProviderTaskPipelineInput,
  route: Route,
  lane: ProviderTaskLane,
  envelope: ProviderDispatchEnvelope,
  collected: { output: VendorQuoteAdapterOutput; collectedAt: string; packageId: string },
  nowMs: number,
): { candidate: ProviderResultCandidate; expectation: ProviderResultExpectation } {
  const expectation: ProviderResultExpectation = {
    provider: envelope.provider,
    taskId: envelope.task.workQueueTaskId,
    laneId: envelope.task.quoteRequestLaneId,
    permitId: envelope.permit.permitId,
    runId: envelope.task.quoteRunId,
    envelopeRevision: envelopeRevision(envelope.envelope),
    policyRevision: envelope.admission.policyRevision,
    packageId: providerPackageId(envelope.outboundFiles),
    requestedQuantity: envelope.scope.requestedQuantity,
    allowedDomains: [...(PROVIDER_CATALOG[envelope.provider]?.officialDomains ?? [])],
    now: new Date(nowMs).toISOString(),
  };
  const candidate: ProviderResultCandidate = {
    contractVersion: PROVIDER_RESULT_CONTRACT_VERSION,
    binding: {
      provider: input.claim.provider,
      taskId: input.task.id,
      laneId: lane.laneId,
      permitId: input.claim.permitId,
      runId: input.task.quoteRunId,
      envelopeRevision: envelopeRevision(route.reviewed),
      // No worker side source exists for the admission policy revision.
      policyRevision: envelope.admission.policyRevision,
      packageId: collected.packageId,
      quantity: input.requestedQuantity,
      adapterRevision: input.adapterRevision,
    },
    currency: "USD",
    collectedAt: collected.collectedAt,
    result: collected.output,
  };
  return { candidate, expectation };
}

/** Classes a non completed seam result, applying the day switch for a block or ban. */
function seamStop(result: ProviderExecutionResult<unknown>, state: RunState, onBlock: (outcome: string) => void): Stop {
  switch (result.kind) {
    case "denied":
      return stop(result.retryable ? "pre_dispatch_transient" : "manual_follow_up", result.denial, "adapter");
    case "terminal":
      onBlock(result.outcome);
      return stop("manual_follow_up", TERMINAL_CODES[result.outcome] ?? "terminal", "adapter");
    case "adapter_failed": {
      const thrown = state.adapterError?.error;
      if (isProviderKillSwitchEngaged(thrown)) return killSwitchStop(thrown, "adapter", state.mutationPhase.started);
      // No captured error means the failure came from inside the seam; class it as a mutation, never a retry.
      const classed = state.adapterError
        ? classifyProviderAdapterFailure(state.adapterError.error, state.mutationPhase)
        : { failureClass: "manual_follow_up" as const, code: "adapter_failed_after_mutation" };
      return stop(classed.failureClass, classed.code, "adapter");
    }
    default:
      return stop("failed", "seam_result_malformed", "adapter");
  }
}

function validationStop(validation: ProviderResultValidation): Stop | null {
  if (typeof validation !== "object" || validation === null || (validation.ok !== true && validation.ok !== false)) {
    return stop("failed", "result_validation_failed", "validate");
  }
  if (validation.ok) return null;
  const rejection = validation.rejection;
  // The adapter completed, so the provider already holds a quote: a refused
  // result is never requeued, even when the validator would allow a bounded retry.
  return stop(rejection.retry === "none" ? "failed" : "manual_follow_up", rejection.code, "validate", {
    rejection: toAdminRejectionDiagnostic(rejection),
  });
}

function leaseStop(run: ProviderTaskLeaseRunResult<unknown>, state: RunState, onBlock: (outcome: string) => void): Stop {
  switch (run?.kind) {
    case "contended":
    case "unavailable":
      return stop("pre_dispatch_transient", `lease_${run.kind}`, "lease");
    case "manual_follow_up":
      onBlock(run.outcome);
      return stop(
        "manual_follow_up",
        typeof run.outcome === "string" ? run.outcome : "lease_manual_follow_up",
        state.adapterStarted ? "adapter" : "lease",
      );
    case "rejected":
      return stop("manual_follow_up", "lease_rejected", "lease");
    case "lease_lost": {
      // OVD-748: the lease manager reports every aborted run as lease_lost, which would
      // erase the operator hand off an abort after a provider mutation requires.
      const aborted = state.adapterError?.error;
      if (aborted instanceof ProviderAbortedError) {
        const classed = classifyProviderAdapterFailure(aborted, state.mutationPhase);
        return stop(classed.failureClass, classed.code, "adapter");
      }
      return stop("failed", "lease_lost", state.adapterStarted ? "adapter" : "lease");
    }
    default:
      return stop("failed", "lease_result_malformed", "lease");
  }
}

function failureEvidence(state: RunState): ProviderTaskOutcome["evidence"] {
  const thrown = state.adapterError?.error;
  const adapterError = thrown instanceof VendorAutomationError ? thrown : null;
  const outputArtifacts = Array.isArray(state.output?.artifacts) ? state.output.artifacts : [];
  return { adapterError, artifacts: [...(adapterError?.artifacts ?? []), ...outputArtifacts] };
}

/**
 * Only a pre dispatch transient (nothing reached the provider) may requeue on
 * this route. A bounded failure after an adapter start is settled for an
 * operator instead.
 */
function effectiveFailureClass(result: Stop, state: RunState): ProviderTaskFailureClass {
  // Nothing that reached the provider is ever classed as pre dispatch.
  if (state.adapterStarted && result.failureClass === "pre_dispatch_transient") return "failed";
  // Fail closed until OVD-734 makes permit consumption durable: the seam has
  // already consumed this permit in the process local replay record, so a
  // requeued claim on this process could only end authorization_replayed while
  // another process could still run it. No requeue after an adapter start.
  if (result.failureClass === "post_start_bounded") return "manual_follow_up";
  return result.failureClass;
}

function toOutcome(result: Stop | Persisted, state: RunState, attempts: number, nowMs: number): ProviderTaskOutcome {
  const base = { adapterStarted: state.adapterStarted, providerDisabledForDay: state.providerDisabledForDay };
  if (!isStop(result)) {
    return {
      ...base,
      evidence: { adapterError: null, artifacts: [] },
      disposition: "persisted",
      code: "persisted",
      stage: "persist",
      retryAt: null,
      rejection: null,
      killSwitch: null,
      persisted: { status: result.status, offerCount: result.offerCount, artifactCount: result.artifactCount, acceptance: result.acceptance, held: result.held },
    };
  }
  if (result.killSwitch) {
    return {
      ...base,
      disposition: "cancelled_provider_disabled",
      code: result.code,
      stage: result.stage,
      retryAt: null,
      rejection: null,
      killSwitch: result.killSwitch,
      persisted: null,
      evidence: failureEvidence(state),
    };
  }
  const failureClass = effectiveFailureClass(result, state);
  const decision = decideProviderTaskRetry({ failureClass, attempts, now: new Date(nowMs) });
  let disposition: ProviderTaskOutcome["disposition"] = "failed";
  if (decision.action === "requeue") disposition = "requeue";
  else if (decision.action === "manual_follow_up") disposition = "manual_follow_up";
  return {
    ...base,
    disposition,
    code: result.code,
    stage: result.stage,
    retryAt: decision.action === "requeue" ? decision.retryAt : null,
    rejection: result.rejection ?? null,
    killSwitch: null,
    persisted: null,
    evidence: failureEvidence(state),
  };
}

/**
 * Last checks between a validated result and the database: every rank must fit
 * the int4 column, and a duration only validity gets its expiry derived here and
 * must not have passed. A refusal is a visible finite state, never a silent drop.
 */
function persistableOutput(
  output: VendorQuoteAdapterOutput,
  validated: ValidatedProviderResult,
  nowMs: number,
): VendorQuoteAdapterOutput | Stop {
  if (!validated.offers.every((offer) => isPersistableSortRank(offer.sortRank))) {
    return stop("manual_follow_up", "sort_rank_out_of_range", "validate");
  }
  const validUntil = deriveProviderResultValidUntil(output, validated);
  if (validUntil !== null && Date.parse(validUntil) < nowMs) {
    return stop("manual_follow_up", "expired_validity", "validate");
  }
  return toAdapterOutput(output, validated, validUntil);
}

/**
 * OVD-813: runs the injected sanity gate. Without one the result passes
 * unchanged; a gate that throws never lets the unchecked price through.
 */
async function sanityGate(
  step: AdmittedStep,
  output: VendorQuoteAdapterOutput,
  packageId: string,
): Promise<{ output: VendorQuoteAdapterOutput; held: boolean } | Stop> {
  if (!step.deps.sanity) return { output, held: false };
  try {
    const gated = await step.deps.sanity(output, {
      provider: step.input.claim.provider,
      vendorQuoteResultId: step.input.claim.vendorQuoteResultId,
      quoteRunId: step.input.task.quoteRunId,
      requestedQuantity: step.input.requestedQuantity,
      packageId,
      internalTestQuote: step.input.internalTestQuote === true,
    });
    if (!gated?.output || typeof gated.held !== "boolean") return stop("manual_follow_up", "fixture_sanity_failed", "validate");
    return gated;
  } catch {
    return stop("manual_follow_up", "fixture_sanity_failed", "validate");
  }
}

/** Everything steps 5 to 7 need once authorization, bytes and session passed. */
type AdmittedStep = {
  input: ProviderTaskPipelineInput;
  deps: ProviderTaskPipelineDeps;
  state: RunState;
  now: () => number;
  route: Route;
  lane: ProviderTaskLane;
  session: ProviderExecutionSession;
  authorization: ProviderDispatchAuthorization;
  files: ProviderExecutionCapturedFile[];
  expected: ReturnType<typeof buildExecutionExpectation>;
  consumer: ProviderAuthorizationConsumer | undefined;
  onBlock: (outcome: string) => void;
};

/** Steps 5 to 7: the admitted adapter through the seam, validation, then one atomic write. */
async function executeValidateAndPersist(
  step: AdmittedStep,
  leaseContext: ProviderTaskLeaseContext | null,
): Promise<Stop | Persisted> {
  const { input, deps, state, now, route, authorization } = step;
  const authorizedRoles = new Set(authorization.envelope.outboundFiles.map((file) => file.role));
  const lease = route.lease;
  // The adapter sees file metadata only for authorized roles; a drawing it may not upload is absent, not hidden.
  const cadAuthorized = authorizedRoles.has("cad");
  const drawingAuthorized = authorizedRoles.has("drawing");
  const quoteInput: VendorQuoteAdapterInput = {
    ...input.quoteInput,
    cadFile: cadAuthorized ? input.quoteInput.cadFile : null,
    drawingFile: drawingAuthorized ? input.quoteInput.drawingFile : null,
    stagedCadFile: cadAuthorized ? input.quoteInput.stagedCadFile : null,
    stagedDrawingFile: drawingAuthorized ? input.quoteInput.stagedDrawingFile : null,
    providerDispatchAuthorization: authorization,
  };
  let collectedAt = "";
  let packageId = "";
  const seamResult = await executeWithProviderAuthorization(
    { authorization, expected: step.expected, session: step.session, files: step.files, nowMs: now() },
    {
      provider: input.claim.provider,
      execute: async (context: ProviderExecutionContext) => {
        try {
          leaseContext?.assertHeld();
          // OVD-748: permit expiry or a lost lease stops the adapter at its next checkpoint.
          const signal = leaseContext ? AbortSignal.any([context.signal, leaseContext.signal]) : context.signal;
          throwIfProviderAborted(signal, "before_launch");
          packageId = providerPackageId(context.files);
          state.adapterStarted = true;
          deps.onAdapterStart?.();
          const abortableInput = withProviderAbortSignal(quoteInput, signal);
          // Adapters mark this phase right before their first upload or quote configuration.
          const output = await runInProviderMutationPhase(state.mutationPhase, () => route.adapter.quote(abortableInput));
          collectedAt = new Date(now()).toISOString();
          return output;
        } catch (error) {
          // OVD-722: a before_launch refusal comes from the guard wrapping the
          // adapter, before anything launched; the adapter never started.
          if (error instanceof ProviderKillSwitchError && error.checkpoint === "before_launch") {
            state.adapterStarted = false;
          }
          // OVD-829: the settings gate runs only at before_launch.
          if (error instanceof ProviderDispatchRefusedError) {
            state.adapterStarted = false;
          }
          if (error instanceof ProviderAbortedError && error.checkpoint === "before_launch") {
            state.adapterStarted = false;
          }
          state.adapterError = { error };
          throw error;
        }
      },
    },
    {
      log: deps.log,
      guards: [deps.daySwitch.guard(now), ...(deps.guards ?? [])],
      consumer: step.consumer,
      toLeaseError: lease ? (outcome) => lease.toLeaseError(outcome) : undefined,
    },
  );
  if (seamResult?.kind !== "completed") return seamStop(seamResult, state, step.onBlock);

  // 6. Validate the complete normalized result.
  const output = seamResult.value as VendorQuoteAdapterOutput;
  state.output = output;
  const check = buildResultCheck(input, route, step.lane, authorization.envelope, { output, collectedAt, packageId }, now());
  let validation: ProviderResultValidation;
  try {
    validation = (deps.validate ?? validateProviderResult)(check.candidate, check.expectation);
  } catch {
    return stop("failed", "result_validation_failed", "validate");
  }
  const refused = validationStop(validation);
  if (refused) return refused;
  if (!validation.ok || !SHA256.test(packageId)) return stop("failed", "result_validation_failed", "validate");

  const persistable = persistableOutput(output, validation.value, now());
  if (isStop(persistable)) return persistable;
  // 6 to 7. OVD-813 fixture sanity gate: a drifting price is held, not shown.
  const gated = await sanityGate(step, persistable, packageId);
  if (isStop(gated)) return gated;

  // 7. Persist atomically, only while the lease (if any) is still held.
  try {
    leaseContext?.assertHeld();
  } catch {
    return stop("failed", "lease_lost", "persist");
  }
  try {
    const persisted = await deps.persist(gated.output, { offerCount: gated.held ? 0 : validation.value.offers.length });
    return {
      persisted: true,
      acceptance: persisted.acceptance,
      status: gated.output.status,
      offerCount: gated.held ? 0 : validation.value.offers.length,
      artifactCount: persisted?.artifactCount ?? 0,
      held: gated.held,
    };
  } catch {
    return stop("failed", "persistence_failure", "persist");
  }
}

/**
 * Runs one claimed generic provider task through the ordered pipeline and
 * returns its finite outcome. Never throws for provider, lease, validation or
 * persistence failures; the caller records the outcome.
 */
export async function runProviderTaskPipeline(
  input: ProviderTaskPipelineInput,
  deps: ProviderTaskPipelineDeps,
): Promise<ProviderTaskOutcome> {
  const now = deps.now ?? (() => Date.now());
  const state: RunState = {
    adapterStarted: false,
    providerDisabledForDay: false,
    mutationPhase: createProviderMutationPhase(),
    adapterError: null,
    output: null,
  };
  const result = await runSteps(input, deps, state, now);
  return toOutcome(result, state, input.task.attempts, now());
}

async function runSteps(
  input: ProviderTaskPipelineInput,
  deps: ProviderTaskPipelineDeps,
  state: RunState,
  now: () => number,
): Promise<Stop | Persisted> {
  const provider = input.claim.provider;
  const onBlock = (outcome: string) => {
    if (BLOCKING_DAY_OFF.has(outcome)) {
      deps.daySwitch.disable(provider, now());
      state.providerDisabledForDay = true;
    }
  };

  const route = resolveRoute(input, deps, now());
  if (isStop(route)) return route;
  const lane = await resolveLane(input, deps);
  if (isStop(lane)) return lane;
  // 2. Current capability and service authorization.
  const authorization = await resolveAuthorization(deps, provider);
  if (isStop(authorization)) return authorization;
  // OVD-813: a supplier paused for drift runs internal test quotes only.
  // Checked after authorization so an engaged kill switch wins: the lane ends
  // cancelled_provider_disabled, not in the manual follow-up queue.
  if (deps.pause && !deps.pause.admits(provider, { internalTestQuote: input.internalTestQuote === true })) {
    return stop("manual_follow_up", PROVIDER_PAUSED_FIXTURE_HEAL, "authorize");
  }
  // 3. Captured bytes.
  const files = await resolveFiles(deps, authorization.envelope);
  if (isStop(files)) return files;
  // 4. Session identity, then (when on) the exact lease around steps 5 to 7.
  const session = resolveSession(input, route.lease);
  if (isStop(session)) return session;

  const lease = route.lease;
  const step: AdmittedStep = {
    input,
    deps,
    state,
    now,
    route,
    lane,
    session,
    authorization,
    files,
    onBlock,
    expected: buildExecutionExpectation(input, route, lane, session, authorization),
    // The replay key is the permit and fingerprint alone: a second dispatch on
    // the same permit in this process, from a requeue or otherwise, is denied
    // authorization_replayed. Durable per permit tracking is OVD-734.
    consumer: deps.consumer,
  };
  const operation = (leaseContext: ProviderTaskLeaseContext | null) => executeValidateAndPersist(step, leaseContext);

  if (!lease) {
    try {
      return await operation(null);
    } catch {
      return stop("failed", "pipeline_error", state.adapterStarted ? "adapter" : "authorize");
    }
  }
  // 8. The lease releases itself when the operation returns or throws.
  let run: ProviderTaskLeaseRunResult<Stop | Persisted>;
  try {
    run = await lease.runWithLease({ identity: session, taskRef: input.task.id }, (context) => operation(context));
  } catch {
    return stop("failed", "lease_error", "lease");
  }
  return run?.kind === "completed" ? run.value : leaseStop(run, state, onBlock);
}
