import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { withXometryProfileInterprocessLock } from "./adapters/persistentProfileLock.js";
import { prepareCapabilityCanaryPlan, prepareCapabilityCanaryObservation, type CanaryPlan, type CanaryReviewedEnvelope, type CanaryObservationInput } from "./providerCapabilityCanary.js";
import type { ProviderUploadCapabilityAdmissionResolverResult } from "./providerUploadCapabilityTypes.js";
import { createCanaryFencedAttempt, canaryFencedTime, type CanaryFencedAttempt, type CanaryFencedClaim, type CanaryFencedTransport } from "./providerCapabilityCanaryFenced.js";
import { completeCapabilityCanaryObservation } from "./providerCapabilityCanaryLedger.js";
import type { CapabilityAttentionEvidence } from "./providerCapabilityAttention.js";
import { decideProviderUploadCapability } from "./providerUploadCapability.js";

type ProbeSnapshot = Pick<CanaryObservationInput, "state" | "extensions" | "mimeTypes" | "acceptAttributePresent">;
export type CanaryWindowClaim = { windowKey: string; observationRevision: number };
export type CanaryProbeHandle = {
  result: Promise<ProbeSnapshot>;
  /** Resolve only after all probe resources have stopped. An abort signal alone is insufficient. */
  stop(): Promise<void>;
};
export type ReviewedCanaryProbe = {
  envelope: CanaryReviewedEnvelope;
  profilePath: string;
  reviewReference: string;
  validUntil: string;
  /** Synchronous handle creation; implementation must support hard-stop containment. */
  startReadOnlyProbe(input: { signal: AbortSignal; deadlineMs: number }): CanaryProbeHandle;
};

/** No existing auth executable is a reviewed no-upload capability probe. */
export const REVIEWED_CANARY_PROBES: readonly ReviewedCanaryProbe[] = Object.freeze([]);

type Reservation = { state: "reserved"; claim: CanaryWindowClaim; admission: ProviderUploadCapabilityAdmissionResolverResult }
  | { state: "already_reserved" | "unavailable" };
type LedgerInput = {
  config: unknown; reviewed: readonly CanaryReviewedEnvelope[]; observation: unknown;
  admission: ProviderUploadCapabilityAdmissionResolverResult; nowMs: number;
  claim: CanaryWindowClaim; signal: AbortSignal;
};
export type CanaryFencedRuntime = {
  mode: "fenced"; resourceKey: string; requestKey: string; completionKey: string; leaseSeconds: number;
  transport: CanaryFencedTransport;
  /** Service composition can require provider admission before constructing a persistence client. */
  preflightAdmission?: boolean;
  resolveAdmission(plan: CanaryPlan, windowIndex: number, signal: AbortSignal): Promise<ProviderUploadCapabilityAdmissionResolverResult>;
  /** Synchronous private recovery handoff before claim. Caller owns durable retention; this closure is not storage. */
  retainAttempt(attempt: CanaryFencedAttempt): void;
};
export type CanaryConfirmedObservation = {
  plan: CanaryPlan; evidence: CapabilityAttentionEvidence; signal: AbortSignal; deadlineMs: number;
};
export type CanaryRuntimeDependencies = {
  onConfirmedObservation?: (input: CanaryConfirmedObservation) => Promise<{ state: string }>;
  fenced?: CanaryFencedRuntime;
  bindings: readonly ReviewedCanaryProbe[];
  now(): number;
  /** Trusted operator disable/revocation signal; never deletes prior audit history. */
  revocationSignal?: AbortSignal;
  /** Trusted durable atomic claim/revision service; never replace with latest revision + 1. */
  reserveWindow?: (plan: CanaryPlan, windowIndex: number, signal: AbortSignal) => Promise<Reservation>;
  /** May use the record-plus-attention bridge; omitted attention means ledger-only recording. */
  recordObservation?: (input: LedgerInput) => Promise<{ state: "recorded"; observationRevision: number; attention?: { state: string } } | { state: "rejected" | "failed" | "uncertain" }>;
  withProfileLock?: (profilePath: string, operation: () => Promise<CanaryRuntimeResult>) => Promise<CanaryRuntimeResult>;
};
export type CanaryRuntimeResult = { state:
  "disabled" | "invalid_configuration" | "authorization_rejected" | "reviewed_probe_unavailable"
  | "durable_reservation_unavailable" | "ledger_unavailable" | "window_closed" | "window_already_attempted"
  | "profile_lock_unavailable" | "reservation_rejected" | "admission_rejected" | "probe_failed" | "invalid_observation"
  | "timed_out" | "cleanup_unconfirmed" | "record_uncertain" | "record_failed" | "recorded" | "recorded_attention_pending" };

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}
function time(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}
function instant(value: number): boolean { return Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000; }
function reference(value: unknown): boolean { return typeof value === "string" && /^issue:OVD-[1-9]\d{0,9}$/.test(value); }
export function capabilityCanaryPlanDigest(plan: CanaryPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
function receipt(value: unknown, key: "planDigest" | "windowKey", expected: string, now: number): boolean {
  return record(value, ["enabled", "evidenceReference", key, "expiresAt"]) && value.enabled === true
    && reference(value.evidenceReference) && value[key] === expected && time(value.expiresAt) > now;
}
function bindingMatches(binding: ReviewedCanaryProbe, plan: CanaryPlan): boolean {
  return ["provider", "route", "surface", "revision"].every((key) =>
    binding.envelope[key as keyof CanaryReviewedEnvelope] === plan.releaseEnvelope[key as keyof CanaryReviewedEnvelope]);
}

/** Runtime orchestration only. Operator receipts are trusted configuration, not an authentication mechanism. */
export function createCapabilityCanaryRuntime(deps: CanaryRuntimeDependencies) {
  let fencedAttempted = false; // One UUID pair belongs to one window/payload. Instantiate anew with new trusted IDs for another window.
  const attempted = new Set<string>(); // Local reentry guard; the required service provides durable reservations.
  return async (request: unknown): Promise<CanaryRuntimeResult> => {
    if (request === undefined) return { state: "disabled" };
    if (!record(request, ["plan", "windowIndex", "scheduleAuthorization", "triggerAuthorization"])) return { state: "invalid_configuration" };
    if (!record(request.scheduleAuthorization, ["enabled", "evidenceReference", "planDigest", "expiresAt"])
      || !record(request.triggerAuthorization, ["enabled", "evidenceReference", "windowKey", "expiresAt"])) return { state: "authorization_rejected" };
    if (request.scheduleAuthorization.enabled === false || request.triggerAuthorization.enabled === false) return { state: "disabled" };
    // No runtime URL/module selection and no production provider defaults.
    if (deps.bindings.length === 0) return { state: "reviewed_probe_unavailable" };
    const reviewed = structuredClone(deps.bindings.map((entry) => entry.envelope));
    const prepared = prepareCapabilityCanaryPlan(request.plan, reviewed);
    if (prepared.state !== "prepared_plan") return { state: "invalid_configuration" };
    const plan = prepared.plan;
    const config = structuredClone(request.plan);
    const index = request.windowIndex;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || !plan.windows[index]) return { state: "invalid_configuration" };
    const window = plan.windows[index];
    const bindings = deps.bindings.filter((entry) => bindingMatches(entry, plan));
    if (bindings.length !== 1) return { state: "reviewed_probe_unavailable" };
    // Snapshot trusted binding and authorization data before any asynchronous boundary.
    const binding = deps.fenced ? { ...bindings[0], envelope: structuredClone(bindings[0].envelope) } : bindings[0];
    const scheduleAuthorization = deps.fenced ? structuredClone(request.scheduleAuthorization) : request.scheduleAuthorization;
    const triggerAuthorization = deps.fenced ? structuredClone(request.triggerAuthorization) : request.triggerAuthorization;
    const fenced = deps.fenced ? { ...deps.fenced, transport: { ...deps.fenced.transport } } : undefined;
    if ("fenced" in deps && (!fenced || fenced.mode !== "fenced" || typeof fenced.resolveAdmission !== "function"
      || typeof fenced.retainAttempt !== "function")) return { state: "invalid_configuration" };
    const digest = capabilityCanaryPlanDigest(plan);
    const permitted = (now: number) => instant(now)
      && receipt(scheduleAuthorization, "planDigest", digest, now)
      && receipt(triggerAuthorization, "windowKey", window.idempotencyKey, now)
      && reference(binding.reviewReference) && time(binding.validUntil) > now;
    const onConfirmedObservation = deps.onConfirmedObservation;
    const start = deps.now();
    if (!permitted(start) || deps.revocationSignal?.aborted) return { state: "authorization_rejected" };
    if (start < time(window.startAt) || start >= time(window.endAt)) return { state: "window_closed" };
    if (!isAbsolute(binding.profilePath)) return { state: "invalid_configuration" };
    if (!fenced && !deps.reserveWindow) return { state: "durable_reservation_unavailable" };
    if (!fenced && !deps.recordObservation) return { state: "ledger_unavailable" };
    if (fenced && fencedAttempted) return { state: "window_already_attempted" };
    if (attempted.has(window.idempotencyKey)) return { state: "window_already_attempted" };
    attempted.add(window.idempotencyKey);
    if (fenced) fencedAttempted = true;
    const controller = new AbortController();
    const cleanupBudget = Math.min(1000, plan.timeoutSeconds * 250);
    let hardDeadline = Math.min(start + plan.timeoutSeconds * 1000, time(window.endAt));
    let workDeadline = hardDeadline - cleanupBudget;
    let phase: "waiting" | "probing" | "cleanup" | "recording" | "attention" = "waiting";
    let terminal = false;
    const lock = deps.withProfileLock ?? ((profilePath, operation) => withXometryProfileInterprocessLock(profilePath,
      { waitMs: 0, vendor: plan.releaseEnvelope.provider, logWarn: () => undefined }, operation));
    return new Promise<CanaryRuntimeResult>((resolve) => {
      const finish = (result: CanaryRuntimeResult) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(workTimer);
        clearTimeout(hardTimer);
        deps.revocationSignal?.removeEventListener("abort", revoke);
        controller.abort();
        resolve(result);
      };
      let workTimer = setTimeout(() => controller.abort(), Math.max(0, workDeadline - deps.now()));
      let hardTimer = setTimeout(() => finish({ state: phase === "probing" || phase === "cleanup" ? "cleanup_unconfirmed"
        : phase === "attention" ? "recorded_attention_pending" : phase === "recording" ? "record_uncertain" : "timed_out" }), Math.max(0, hardDeadline - deps.now()));
      const revoke = () => controller.abort();
      deps.revocationSignal?.addEventListener("abort", revoke, { once: true });
      if (deps.revocationSignal?.aborted) revoke();
      const interrupted = (): CanaryRuntimeResult => ({ state: deps.revocationSignal?.aborted ? "disabled" : "timed_out" });
      const untilAbort = <T>(promise: Promise<T>): Promise<T> => new Promise((accept, reject) => {
        const abort = () => reject(new Error("deadline"));
        if (controller.signal.aborted) reject(new Error("deadline"));
        else controller.signal.addEventListener("abort", abort, { once: true });
        promise.then(accept, reject).finally(() => controller.signal.removeEventListener("abort", abort));
      });
      const operation = async (): Promise<CanaryRuntimeResult> => {
        if (terminal || controller.signal.aborted || deps.now() >= workDeadline) return interrupted();
        let reserved: Reservation;
        let attempt: CanaryFencedAttempt | undefined;
        let fencedClaim: CanaryFencedClaim | undefined;
        try {
          if (fenced) {
            if (fenced.preflightAdmission) {
              const admission = await untilAbort(fenced.resolveAdmission(structuredClone(plan), index, controller.signal));
              const checked = decideProviderUploadCapability({ releaseEnvelope: plan.releaseEnvelope, admissionResolver: admission,
                nowMs: deps.now(), observed: { provider: plan.releaseEnvelope.provider, route: plan.releaseEnvelope.route,
                  surface: plan.releaseEnvelope.surface, revision: plan.releaseEnvelope.revision, state: "loading", acceptAttributePresent: false } });
              if (checked.classification !== "formats_loading") return { state: "admission_rejected" };
              if (terminal || controller.signal.aborted || deps.now() >= workDeadline) return interrupted();
              if (!permitted(deps.now())) return { state: "authorization_rejected" };
            }
            const claimTime = deps.now();
            attempt = createCanaryFencedAttempt({ transport: fenced.transport, completionKey: fenced.completionKey, request: {
              windowKey: window.idempotencyKey, resourceKey: fenced.resourceKey, configDigest: digest, requestKey: fenced.requestKey,
              provider: plan.releaseEnvelope.provider, route: plan.releaseEnvelope.route, surface: plan.releaseEnvelope.surface,
              surfaceRevision: plan.releaseEnvelope.revision, windowStart: window.startAt, windowEnd: window.endAt, leaseSeconds: fenced.leaseSeconds,
            } });
            fenced.retainAttempt(attempt);
            const claimed = await untilAbort(attempt.claim(claimTime, controller.signal));
            if (claimed.state !== "claimed") return { state: "reservation_rejected" };
            fencedClaim = claimed.claim;
            hardDeadline = Math.min(hardDeadline, canaryFencedTime(fencedClaim.deadline));
            workDeadline = Math.min(workDeadline, hardDeadline - cleanupBudget);
            clearTimeout(workTimer); clearTimeout(hardTimer);
            workTimer = setTimeout(() => controller.abort(), Math.max(0, workDeadline - deps.now()));
            hardTimer = setTimeout(() => finish({ state: phase === "probing" || phase === "cleanup" ? "cleanup_unconfirmed"
              : phase === "attention" ? "recorded_attention_pending" : phase === "recording" ? "record_uncertain" : "timed_out" }), Math.max(0, hardDeadline - deps.now()));
            if (terminal || controller.signal.aborted || deps.now() >= workDeadline) return interrupted();
            const admission = await untilAbort(fenced.resolveAdmission(structuredClone(plan), index, controller.signal));
            reserved = { state: "reserved", claim: { windowKey: fencedClaim.windowKey, observationRevision: fencedClaim.observationRevision }, admission: structuredClone(admission) };
          } else reserved = await untilAbort(deps.reserveWindow!(plan, index, controller.signal));
        }
        catch { return controller.signal.aborted ? interrupted() : { state: "reservation_rejected" }; }
        if (reserved.state !== "reserved" || reserved.claim.windowKey !== window.idempotencyKey
          || !Number.isSafeInteger(reserved.claim.observationRevision) || reserved.claim.observationRevision < 1) return { state: "reservation_rejected" };
        if (terminal || controller.signal.aborted || deps.now() >= workDeadline) return interrupted();
        const activationTime = deps.now();
        if (!permitted(activationTime)) return { state: "authorization_rejected" };
        // A loading sentinel reaches the observed-state branch only after shared admission checks.
        // It is not an observed provider fact and is never recorded as one.
        const admissionCheck = decideProviderUploadCapability({ releaseEnvelope: plan.releaseEnvelope,
          admissionResolver: reserved.admission, nowMs: activationTime,
          observed: { provider: plan.releaseEnvelope.provider, route: plan.releaseEnvelope.route,
            surface: plan.releaseEnvelope.surface, revision: plan.releaseEnvelope.revision,
            state: "loading", acceptAttributePresent: false } });
        if (admissionCheck.classification !== "formats_loading") return { state: "admission_rejected" };
        // Reconciliation can begin through the retained handle during either claim or admission awaits.
        if (fenced && !attempt!.canExecuteClaim()) return { state: "reservation_rejected" };
        let handle: CanaryProbeHandle;
        try {
          phase = "probing";
          handle = binding.startReadOnlyProbe({ signal: controller.signal, deadlineMs: workDeadline });
        } catch {
          finish({ state: "cleanup_unconfirmed" });
          return new Promise<never>(() => undefined);
        }
        let snapshot: ProbeSnapshot | undefined;
        let observedTime: number | undefined;
        let failed = false;
        try { snapshot = await untilAbort(handle.result); observedTime = deps.now(); } catch { failed = true; }
        phase = "cleanup";
        try {
          // Do not release profile ownership until the binding confirms containment.
          await handle.stop();
        } catch {
          finish({ state: "cleanup_unconfirmed" });
          return new Promise<never>(() => undefined); // Preserve the existing lock sidecar for explicit recovery.
        }
        if (terminal || controller.signal.aborted || deps.now() >= workDeadline) return interrupted();
        phase = "waiting";
        if (failed) return { state: "probe_failed" };
        if (observedTime === undefined || !instant(observedTime)) return { state: "invalid_observation" };
        if (!record(snapshot, ["state", "extensions", "mimeTypes", "acceptAttributePresent"])) return { state: "invalid_observation" };
        const now = deps.now();
        if (!permitted(now) || now >= workDeadline) return { state: "authorization_rejected" };
        const observation = { ...snapshot, provider: plan.releaseEnvelope.provider, route: plan.releaseEnvelope.route,
          surface: plan.releaseEnvelope.surface, revision: plan.releaseEnvelope.revision, windowIndex: index,
          observationRevision: reserved.claim.observationRevision, observedAt: new Date(observedTime).toISOString(),
          expiresAt: new Date(Math.min(observedTime + 3600000, time(window.endAt))).toISOString() };
        const candidate = prepareCapabilityCanaryObservation(config, reviewed, observation, reserved.admission, now);
        if (candidate.state !== "prepared_observation") return { state: "invalid_observation" };
        phase = "recording";
        try {
          const recordTime = deps.now();
          if (controller.signal.aborted || recordTime >= workDeadline) return interrupted();
          if (!permitted(recordTime)) return { state: "authorization_rejected" };
          let admission = reserved.admission;
          if (fenced) {
            admission = structuredClone(await untilAbort(fenced.resolveAdmission(structuredClone(plan), index, controller.signal)));
            const checked = decideProviderUploadCapability({ releaseEnvelope: plan.releaseEnvelope, admissionResolver: admission,
              nowMs: deps.now(), observed: { provider: plan.releaseEnvelope.provider, route: plan.releaseEnvelope.route,
                surface: plan.releaseEnvelope.surface, revision: plan.releaseEnvelope.revision, state: "loading", acceptAttributePresent: false } });
            if (checked.classification !== "formats_loading") return { state: "admission_rejected" };
            if (terminal || controller.signal.aborted || deps.now() >= workDeadline) return interrupted();
            if (!permitted(deps.now())) return { state: "authorization_rejected" };
          }
          const result = fenced
            ? await untilAbort(completeCapabilityCanaryObservation({ mode: "fenced", attempt: attempt!, claim: fencedClaim!, resourceReleased: true,
              config, reviewed, observation, admission, nowMs: deps.now(), signal: controller.signal }))
            : await untilAbort(deps.recordObservation!({ config, reviewed, observation,
              admission, nowMs: recordTime, claim: reserved.claim, signal: controller.signal }));
          if (terminal || controller.signal.aborted || result.state === "uncertain") return { state: "record_uncertain" };
          if (result.state === "recorded") {
            if (result.observationRevision !== reserved.claim.observationRevision) return { state: "record_uncertain" };
            if (fenced && "evidence" in result) {
              phase = "attention"; // Ledger is confirmed; attention failure must not erase that knowledge.
              if (!onConfirmedObservation || deps.now() >= workDeadline) return { state: "recorded_attention_pending" };
              try {
                const attention = await untilAbort(onConfirmedObservation({ plan: structuredClone(plan), evidence: structuredClone(result.evidence),
                  signal: controller.signal, deadlineMs: workDeadline }));
                return { state: !terminal && !controller.signal.aborted && attention.state === "committed" ? "recorded" : "recorded_attention_pending" };
              } catch { return { state: "recorded_attention_pending" }; }
            }
            return { state: fenced || ("attention" in result && result.attention && result.attention.state !== "committed") ? "recorded_attention_pending" : "recorded" };
          }
          return { state: result.state === "failed" || result.state === "rejected" ? "record_failed" : "record_uncertain" };
        } catch { return { state: "record_uncertain" }; }
      };
      void Promise.resolve().then(() => lock(binding.profilePath, operation)).then(finish, () => finish({ state: "profile_lock_unavailable" }));
    });
  };
}
