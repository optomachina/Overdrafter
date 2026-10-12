import { createHash } from "node:crypto";
import { PROVIDER_CATALOG } from "./generated/provider-catalog.js";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "./providerDispatchEnvelope.js";
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
import type {
  VendorName,
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOffer,
  VendorQuoteAdapterOutput,
} from "./types.js";
import { nextRetryAt } from "./vendorTaskRetry.js";

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
 *   6. validate the complete normalized result (OVD-463)
 *   7. persist atomically (one `reconcile_vendor_quote_offers` call)
 *   8. release the lease
 *
 * Every denial returns an outcome with zero adapter calls. There is no
 * fallback to another provider, an aggregator or a generic session.
 *
 * Retry authority: `decideProviderTaskRetry` is the only place this route
 * decides to requeue. The caller writes the outcome and must not rethrow it
 * into the worker's generic task retry.
 */

export const PROVIDER_SESSION_LEASE_SETTINGS = ["off", "on"] as const;
export type ProviderSessionLeaseSetting = (typeof PROVIDER_SESSION_LEASE_SETTINGS)[number];

/**
 * Requeues allowed after an adapter start. The cap is read from the database
 * claim counter (`work_queue.attempts`, incremented atomically by
 * `api_claim_next_task` on every claim), never from worker memory, so it holds
 * across processes and restarts. A requeue after an adapter start is allowed
 * only on the first claim; every later claim that starts the adapter is final.
 * A worker that crashes mid run is reaped to `failed`, never requeued.
 */
export const PROVIDER_TASK_MAX_ADAPTER_REQUEUES = 1;

// --------------------------------------------------------------------------- lease port

/** Result shape of OVD-462 `runWithLease`, kept structural until that module lands on main. */
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
  /** Per code cap from the validator; 0 forbids a retry. Defaults to 1. */
  retryBudget?: number;
  now?: Date;
}): ProviderTaskRetryDecision {
  const attempts = Number.isInteger(input.attempts) && input.attempts > 0 ? input.attempts : Number.POSITIVE_INFINITY;
  switch (input.failureClass) {
    case "pre_dispatch_transient": {
      const retryAt = Number.isFinite(attempts) ? nextRetryAt(attempts, input.now) : null;
      return retryAt ? { action: "requeue", retryAt } : { action: "fail" };
    }
    case "post_start_bounded": {
      const budget = Math.min(input.retryBudget ?? 1, PROVIDER_TASK_MAX_ADAPTER_REQUEUES);
      if (!(budget > 0) || attempts > budget) return { action: "fail" };
      const retryAt = nextRetryAt(attempts, input.now);
      return retryAt ? { action: "requeue", retryAt } : { action: "fail" };
    }
    case "manual_follow_up":
      return { action: "manual_follow_up" };
    default:
      return { action: "fail" };
  }
}

// --------------------------------------------------------------------------- outcome

export type ProviderTaskStage = "authorize" | "verify_bytes" | "lease" | "adapter" | "validate" | "persist";

export type ProviderTaskOutcome = {
  /** Finite visible state for the lane. */
  disposition: "persisted" | "requeue" | "manual_follow_up" | "failed";
  /** Stable code; never adapter supplied text. */
  code: string;
  stage: ProviderTaskStage;
  adapterStarted: boolean;
  retryAt: string | null;
  /** True after a block or ban: the provider was switched off for the rest of the UTC day. */
  providerDisabledForDay: boolean;
  /** Admin visible validator rejection, when the result was refused. */
  rejection: ReturnType<typeof toAdminRejectionDiagnostic> | null;
  /** Set only when persisted. */
  persisted: { status: VendorQuoteAdapterOutput["status"]; offerCount: number; artifactCount: number } | null;
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
  task: { id: string; attempts: number; organizationId: string; quoteRunId: string };
  claim: ProviderDispatchClaim;
  /** `vendor_quote_results.requested_quantity` for the claimed lane. */
  requestedQuantity: number;
  environment: ProviderExecutionEnvironment;
  /** Bounded text identifying the running adapter build. */
  adapterRevision: string;
  leaseSetting: ProviderSessionLeaseSetting;
  quoteInput: VendorQuoteAdapterInput;
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
  persist(output: VendorQuoteAdapterOutput): Promise<{ artifactCount: number }>;
  lease?: ProviderTaskLeasePort | null;
  daySwitch: ProviderDaySwitch;
  /** Replay record for the seam; the pipeline scopes keys to the claim. */
  consumer?: ProviderAuthorizationConsumer;
  guards?: readonly ProviderExecutionGuard[];
  validate?: (candidate: ProviderResultCandidate, expectation: ProviderResultExpectation) => ProviderResultValidation;
  now?: () => number;
  log?: ProviderExecutionLogger;
  /** Called once, immediately before the adapter is invoked. */
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
      .sort()
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
    if (!authorized || authorized.sha256 !== digest || authorized.sourceSha256 !== digest) return false;
  }
  return true;
}

function toAdapterOutput(output: VendorQuoteAdapterOutput, validated: ValidatedProviderResult): VendorQuoteAdapterOutput {
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
    validUntil: validated.validUntil,
    offers: derivedOnly ? undefined : offers,
    rawPayload: {
      ...sanitizeRawPayload(output.rawPayload ?? {}),
      providerResultContract: validated.contractVersion,
      providerResultProvenance: validated.provenance,
    },
  };
}

// --------------------------------------------------------------------------- pipeline

type InnerOutcome =
  | { kind: "persisted"; status: VendorQuoteAdapterOutput["status"]; offerCount: number; artifactCount: number }
  | { kind: "seam"; result: Exclude<ProviderExecutionResult<unknown>, { kind: "completed" }> }
  | { kind: "rejected"; validation: Extract<ProviderResultValidation, { ok: false }> }
  | { kind: "error"; code: string; stage: ProviderTaskStage };

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
  const provider = input.claim.provider;
  let adapterStarted = false;
  let providerDisabledForDay = false;

  const finish = (
    failureClass: ProviderTaskFailureClass,
    code: string,
    stage: ProviderTaskStage,
    extra: { retryBudget?: number; rejection?: ProviderTaskOutcome["rejection"] } = {},
  ): ProviderTaskOutcome => {
    // Nothing that reached the provider is ever classed as pre dispatch.
    const effectiveClass = adapterStarted && failureClass === "pre_dispatch_transient" ? "failed" : failureClass;
    const decision = decideProviderTaskRetry({
      failureClass: effectiveClass,
      attempts: input.task.attempts,
      retryBudget: extra.retryBudget,
      now: new Date(now()),
    });
    let disposition: ProviderTaskOutcome["disposition"] = "failed";
    if (decision.action === "requeue") disposition = "requeue";
    else if (decision.action === "manual_follow_up") disposition = "manual_follow_up";
    return {
      disposition,
      code,
      stage,
      adapterStarted,
      retryAt: decision.action === "requeue" ? decision.retryAt : null,
      providerDisabledForDay,
      rejection: extra.rejection ?? null,
      persisted: null,
    };
  };

  const disableForDay = (outcome: string) => {
    if (BLOCKING_DAY_OFF.has(outcome)) {
      deps.daySwitch.disable(provider, now());
      providerDisabledForDay = true;
    }
  };

  const environment = input.environment;
  if (
    !PROVIDER_EXECUTION_ENVIRONMENTS.includes(environment) ||
    !Number.isInteger(input.requestedQuantity) ||
    input.requestedQuantity < 1 ||
    input.claim.provider === "xometry"
  ) {
    return finish("failed", "execution_request_malformed", "authorize");
  }
  if (input.leaseSetting !== "off" && input.leaseSetting !== "on") {
    return finish("failed", "lease_setting_invalid", "authorize");
  }
  const lease = input.leaseSetting === "on" ? deps.lease ?? null : null;
  if (input.leaseSetting === "on" && !lease) {
    return finish("manual_follow_up", "session_lease_unavailable", "lease");
  }
  // Exact routing: only the adapter registered for this provider, and only a
  // provider the worker itself has reviewed. No default, no substitute.
  const reviewed = REVIEWED_PROVIDER_DISPATCH_ENVELOPES.find(
    (entry) => entry.provider === provider && entry.requiredAdmission === "generic_dispatch",
  );
  if (!reviewed) return finish("manual_follow_up", "provider_envelope_unknown", "authorize");
  if (!deps.adapter || deps.adapter.provider !== provider || typeof deps.adapter.quote !== "function") {
    return finish("manual_follow_up", "adapter_not_enabled", "authorize");
  }
  if (deps.daySwitch.isDisabled(provider, now())) {
    return finish("manual_follow_up", "provider_disabled", "authorize");
  }

  // The claimed lane, read from the database independently of the authorization.
  let lane: ProviderTaskLane;
  try {
    lane = await deps.readLane();
  } catch {
    return finish("failed", "lane_unavailable", "authorize");
  }
  if (!lane || lane.vendorQuoteResultId !== input.claim.vendorQuoteResultId || lane.quoteRunId !== input.task.quoteRunId) {
    return finish("failed", "lane_mismatch", "authorize");
  }

  // 2. Current capability and service authorization.
  let authorization: ProviderDispatchAuthorization;
  try {
    authorization = await deps.authorize();
  } catch (error) {
    if (error instanceof ProviderDispatchAuthorizationError) {
      return finish(error.retryable ? "pre_dispatch_transient" : "manual_follow_up", error.denial, "authorize");
    }
    return finish("failed", "authorization_failed", "authorize");
  }
  if (!authorization || typeof authorization !== "object" || !authorization.envelope) {
    return finish("failed", "authorization_malformed", "authorize");
  }

  // 3. Captured bytes.
  const authorizedRoles = authorization.envelope.outboundFiles.map((file) => file.role);
  let files: ProviderExecutionCapturedFile[];
  try {
    files = await deps.readCapturedFiles(authorizedRoles);
  } catch {
    return finish("failed", "captured_file_unreadable", "verify_bytes");
  }
  if (!capturedFilesMatch(authorization.envelope, files)) {
    return finish("manual_follow_up", "captured_file_mismatch", "verify_bytes");
  }

  // 4. Session identity and (when on) the exact lease.
  let session: ProviderExecutionSession | null;
  try {
    session = lease ? lease.identity(provider, environment) : unleasedSessionIdentity(provider, environment);
  } catch {
    session = null;
  }
  if (!session) return finish("manual_follow_up", "session_identity_unavailable", "lease");

  const expected = {
    provider,
    accountRef: session.accountRef,
    environment,
    sessionBindingRef: session.sessionBindingRef,
    organizationId: input.task.organizationId,
    envelope: { id: reviewed.id, version: reviewed.version },
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

  const claimScopedConsumer: ProviderAuthorizationConsumer | undefined = deps.consumer
    ? { consume: (key, expiresAtMs, nowMs) => deps.consumer!.consume(`${key}:${input.task.attempts}`, expiresAtMs, nowMs) }
    : undefined;

  const operation = async (leaseContext: ProviderTaskLeaseContext | null): Promise<InnerOutcome> => {
    let collectedAt = "";
    let packageId = "";
    const seamResult = await executeWithProviderAuthorization(
      { authorization, expected, session, files, nowMs: now() },
      {
        provider,
        execute: async (context: ProviderExecutionContext) => {
          leaseContext?.assertHeld();
          packageId = providerPackageId(context.files);
          adapterStarted = true;
          deps.onAdapterStart?.();
          const output = await deps.adapter!.quote({
            ...input.quoteInput,
            stagedCadFile: authorizedRoles.includes("cad") ? input.quoteInput.stagedCadFile : null,
            stagedDrawingFile: authorizedRoles.includes("drawing") ? input.quoteInput.stagedDrawingFile : null,
            providerDispatchAuthorization: authorization,
          });
          collectedAt = new Date(now()).toISOString();
          return output;
        },
      },
      {
        log: deps.log,
        guards: [deps.daySwitch.guard(now), ...(deps.guards ?? [])],
        consumer: claimScopedConsumer,
        toLeaseError: lease ? (outcome) => lease.toLeaseError(outcome) : undefined,
      },
    );
    if (!seamResult || typeof seamResult !== "object") return { kind: "error", code: "seam_result_malformed", stage: "adapter" };
    if (seamResult.kind !== "completed") {
      if (!["denied", "terminal", "adapter_failed"].includes(seamResult.kind)) {
        return { kind: "error", code: "seam_result_malformed", stage: "adapter" };
      }
      return { kind: "seam", result: seamResult };
    }

    // 6. Validate the complete normalized result. Expectation from the
    // authorization; candidate binding from independent worker state.
    const envelope = authorization.envelope;
    const output = seamResult.value as VendorQuoteAdapterOutput;
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
      now: new Date(now()).toISOString(),
    };
    const candidate: ProviderResultCandidate = {
      contractVersion: PROVIDER_RESULT_CONTRACT_VERSION,
      binding: {
        provider,
        taskId: input.task.id,
        laneId: lane.laneId,
        permitId: input.claim.permitId,
        runId: input.task.quoteRunId,
        envelopeRevision: envelopeRevision(reviewed),
        // No worker side source exists for the admission policy revision.
        policyRevision: envelope.admission.policyRevision,
        packageId,
        quantity: input.requestedQuantity,
        adapterRevision: input.adapterRevision,
      },
      currency: "USD",
      collectedAt,
      result: output,
    };
    let validation: ProviderResultValidation;
    try {
      validation = (deps.validate ?? validateProviderResult)(candidate, expectation);
    } catch {
      return { kind: "error", code: "result_validation_failed", stage: "validate" };
    }
    if (!validation || typeof validation !== "object" || (validation.ok !== true && validation.ok !== false)) {
      return { kind: "error", code: "result_validation_failed", stage: "validate" };
    }
    if (!validation.ok) return { kind: "rejected", validation };
    if (!SHA256.test(packageId)) return { kind: "error", code: "result_validation_failed", stage: "validate" };

    // 7. Persist atomically, only while the lease (if any) is still held.
    try {
      leaseContext?.assertHeld();
    } catch {
      return { kind: "error", code: "lease_lost", stage: "persist" };
    }
    const persistable = toAdapterOutput(output, validation.value);
    try {
      const persisted = await deps.persist(persistable);
      return {
        kind: "persisted",
        status: persistable.status,
        offerCount: validation.value.offers.length,
        artifactCount: persisted?.artifactCount ?? 0,
      };
    } catch {
      return { kind: "error", code: "persistence_failure", stage: "persist" };
    }
  };

  let inner: InnerOutcome;
  if (!lease) {
    try {
      inner = await operation(null);
    } catch {
      inner = { kind: "error", code: "pipeline_error", stage: adapterStarted ? "adapter" : "authorize" };
    }
  } else {
    let run: ProviderTaskLeaseRunResult<InnerOutcome>;
    try {
      run = await lease.runWithLease({ identity: session, taskRef: input.task.id }, (context) => operation(context));
    } catch {
      return finish("failed", "lease_error", "lease");
    }
    switch (run?.kind) {
      case "completed":
        inner = run.value;
        break;
      case "contended":
      case "unavailable":
        return finish("pre_dispatch_transient", `lease_${run.kind}`, "lease");
      case "manual_follow_up":
        disableForDay(run.outcome);
        return finish("manual_follow_up", typeof run.outcome === "string" ? run.outcome : "lease_manual_follow_up", adapterStarted ? "adapter" : "lease");
      case "rejected":
        return finish("manual_follow_up", "lease_rejected", "lease");
      case "lease_lost":
        return finish("failed", "lease_lost", adapterStarted ? "adapter" : "lease");
      default:
        return finish("failed", "lease_result_malformed", "lease");
    }
  }

  switch (inner.kind) {
    case "persisted":
      return {
        disposition: "persisted",
        code: "persisted",
        stage: "persist",
        adapterStarted,
        retryAt: null,
        providerDisabledForDay,
        rejection: null,
        persisted: { status: inner.status, offerCount: inner.offerCount, artifactCount: inner.artifactCount },
      };
    case "seam": {
      const result = inner.result;
      if (result.kind === "denied") {
        return finish(result.retryable ? "pre_dispatch_transient" : "manual_follow_up", result.denial, "adapter");
      }
      if (result.kind === "terminal") {
        disableForDay(result.outcome);
        return finish("manual_follow_up", TERMINAL_CODES[result.outcome] ?? "terminal", "adapter");
      }
      return finish("post_start_bounded", "adapter_failed", "adapter");
    }
    case "rejected": {
      const rejection = inner.validation.rejection;
      const diagnostic = toAdminRejectionDiagnostic(rejection);
      if (rejection.retry === "bounded") {
        return finish("post_start_bounded", rejection.code, "validate", { retryBudget: rejection.retryBudget, rejection: diagnostic });
      }
      return finish(rejection.retry === "manual_follow_up" ? "manual_follow_up" : "failed", rejection.code, "validate", {
        rejection: diagnostic,
      });
    }
    default:
      return finish("failed", inner.code, inner.stage);
  }
}
