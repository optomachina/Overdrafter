import type { SupabaseClient } from "@supabase/supabase-js";
import { prepareCapabilityCanaryObservation, prepareCapabilityCanaryPlan, type CanaryReviewedEnvelope } from "./providerCapabilityCanary.js";
import { recordProviderUploadCapabilityObservation } from "./providerUploadCapabilityPersistence.js";
import type { ProviderUploadCapabilityAdmissionResolverResult } from "./providerUploadCapabilityTypes.js";
import { projectCapabilityAttention, type CapabilityAttentionMetadata, type CapabilityAttentionEvidence } from "./providerCapabilityAttention.js";

/** Caller-owned durable reservation; this receipt is binding data, not proof of storage. */
export type CanaryWindowClaim = { windowKey: string; observationRevision: number };
export type CanaryLedgerInput = {
  config: unknown;
  reviewed: readonly CanaryReviewedEnvelope[];
  observation: unknown;
  admission: ProviderUploadCapabilityAdmissionResolverResult;
  nowMs: number;
  claim: CanaryWindowClaim;
  signal?: AbortSignal;
};
export type CanaryLedgerResult =
  | { state: "recorded"; observationRevision: number; evidence: CapabilityAttentionEvidence }
  | { state: "rejected"; reasonCode: "disabled" | "invalid_configuration" | "invalid_observation" | "invalid_claim" | "aborted_before_record" }
  | { state: "failed"; reasonCode: "record_failed" }
  | { state: "uncertain"; reasonCode: "record_outcome_unknown" };

import { updateCapabilityAttention, type CapabilityAttentionStore, type CapabilityAttentionRuntimeResult } from "./providerCapabilityAttentionRuntime.js";

const RECORD_BUDGET_MS = 5_000;

function matchesClaim(value: unknown, key: string, revision: number): boolean {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 && keys.includes("windowKey") && keys.includes("observationRevision")
    && keys.every((field) => "value" in Object.getOwnPropertyDescriptor(value, field)!)
    && (value as CanaryWindowClaim).windowKey === key
    && (value as CanaryWindowClaim).observationRevision === revision;
}

/**
 * One abort-aware call to the existing sanitized record RPC. Never acquires a
 * claim, derives a revision, creates a client, retries, or delivers attention.
 * The runtime must reserve the window durably BEFORE probing. Preserve the exact
 * candidate after an uncertain write: ledger replay compares every payload field.
 */
export async function recordCapabilityCanaryObservation(
  client: SupabaseClient,
  input: CanaryLedgerInput,
): Promise<CanaryLedgerResult> {
  try {
    if ("mode" in input || "attempt" in input || "resourceReleased" in input) return { state: "rejected", reasonCode: "invalid_claim" };
    const prepared = prepareCapabilityCanaryObservation(input.config, input.reviewed, input.observation, input.admission, input.nowMs);
    if (prepared.state !== "prepared_observation") return { state: "rejected", reasonCode: prepared.state };
    const { candidate, decision } = prepared;
    if (!matchesClaim(input.claim, candidate.idempotencyKey, candidate.observationRevision)) return { state: "rejected", reasonCode: "invalid_claim" };
    if (input.signal?.aborted) return { state: "rejected", reasonCode: "aborted_before_record" };

    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    input.signal?.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(relayAbort, RECORD_BUDGET_MS);
    let invoked = false;
    let abortListener: (() => void) | undefined;
    try {
      const boundedClient = {
        rpc(name: string, args: Record<string, unknown>) {
          if (name !== "api_record_capability_observation" || invoked || controller.signal.aborted) throw new Error("canary_record_refused");
          invoked = true;
          // PostgREST builder is lazy; attach transport cancellation before await.
          return client.rpc(name, args).abortSignal(controller.signal);
        },
      } as unknown as SupabaseClient;
      const aborted = new Promise<null>((resolve) => {
        abortListener = () => resolve(null);
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      const write = recordProviderUploadCapabilityObservation(boundedClient, candidate);
      const result = await Promise.race([write, aborted]);
      if (controller.signal.aborted || result === null) return invoked
        ? { state: "uncertain", reasonCode: "record_outcome_unknown" }
        : { state: "rejected", reasonCode: "aborted_before_record" };
      if (!result.recorded) return invoked
        ? { state: "uncertain", reasonCode: "record_outcome_unknown" }
        : { state: "failed", reasonCode: "record_failed" };
      return { state: "recorded", observationRevision: result.observationRevision, evidence: {
        decision, observedAt: candidate.observedAt, expiresAt: candidate.expiresAt,
        observationRevision: result.observationRevision,
      } };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", relayAbort);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    }
  } catch {
    return { state: "failed", reasonCode: "record_failed" };
  }
}

export type CanaryAttentionOptions = {
  store: CapabilityAttentionStore | null;
  metadata: unknown;
  reviewedMetadata: readonly CapabilityAttentionMetadata[];
  /** Trusted clock read after the ledger response, before attention projection. */
  now: () => number;
};
export type CanaryLedgerAttentionResult = CanaryLedgerResult & {
  attention: CapabilityAttentionRuntimeResult | { state: "not_attempted" };
};

/**
 * Direct runner dependency: confirmed ledger evidence -> bounded atomic attention.
 * Attention failure never retries the ledger. Missing durable storage remains an
 * explicit pending outcome; callers must not describe it as attention completion.
 */
export async function recordCapabilityCanaryWithAttention(
  client: SupabaseClient,
  input: CanaryLedgerInput,
  options: CanaryAttentionOptions,
): Promise<CanaryLedgerAttentionResult> {
  // Capture reviewed context synchronously, before the record's first await.
  let metadata: CapabilityAttentionMetadata | null = null;
  try {
    const plan = prepareCapabilityCanaryPlan(input.config, input.reviewed);
    const projected = projectCapabilityAttention({ metadata: options.metadata, reviewedMetadata: options.reviewedMetadata,
      evidence: null, previous: null, now: new Date(input.nowMs).toISOString() });
    if (plan.state === "prepared_plan" && projected.state === "projected") {
      const release = plan.plan.releaseEnvelope;
      const value = projected.item.metadata;
      if (value.provider === release.provider && value.route === release.route && value.surface === release.surface
        && value.surfaceRevision === release.revision && value.policyRevision === release.policyRevision) metadata = { ...value };
    }
  } catch { /* Invalid context cannot authorize attention persistence. */ }
  const recorded = await recordCapabilityCanaryObservation(client, input);
  if (recorded.state !== "recorded") return { ...recorded, attention: { state: "not_attempted" } };
  if (!metadata) return { ...recorded, attention: { state: "rejected", reasonCode: "invalid_attention_context" } };
  let now: string;
  try { now = new Date(options.now()).toISOString(); }
  catch { return { ...recorded, attention: { state: "rejected", reasonCode: "invalid_clock" } }; }
  const attention = await updateCapabilityAttention(options.store, {
    metadata, reviewedMetadata: [metadata], evidence: recorded.evidence, now, signal: input.signal,
  });
  return { ...recorded, attention };
}

import type { CanaryFencedAttempt, CanaryFencedClaim } from "./providerCapabilityCanaryFenced.js";
export type CanaryFencedLedgerInput = Omit<CanaryLedgerInput, "claim"> & {
  mode: "fenced"; attempt: CanaryFencedAttempt; claim: CanaryFencedClaim; resourceReleased: true;
};
/** Atomic fenced completion only; never falls back to the legacy append transport. */
export async function completeCapabilityCanaryObservation(input: CanaryFencedLedgerInput): Promise<CanaryLedgerResult> {
  try {
    if (input.mode !== "fenced" || input.resourceReleased !== true) return { state: "rejected", reasonCode: "invalid_claim" };
    const prepared = prepareCapabilityCanaryObservation(input.config, input.reviewed, input.observation, input.admission, input.nowMs);
    if (prepared.state !== "prepared_observation") return { state: "rejected", reasonCode: prepared.state };
    const recovery = input.attempt.recovery();
    const claim = recovery.claim;
    // Full receipt, not a lossy two-field projection. It must be the retained direct claim.
    if (!claim || input.claim !== claim || claim.status !== "claimed" || prepared.candidate.idempotencyKey !== claim.windowKey
      || prepared.candidate.observationRevision !== claim.observationRevision) return { state: "rejected", reasonCode: "invalid_claim" };
    if (input.signal?.aborted) return { state: "rejected", reasonCode: "aborted_before_record" };
    const { observationRevision: _revision, ...candidate } = prepared.candidate;
    if (!input.attempt.prepareCompletion(candidate, true)) return { state: "rejected", reasonCode: "invalid_claim" };
    const result = await input.attempt.complete(input.nowMs, input.signal ?? new AbortController().signal);
    if (result.state === "uncertain") return { state: "uncertain", reasonCode: "record_outcome_unknown" };
    if (result.state !== "completed") return { state: "rejected", reasonCode: "invalid_claim" };
    return { state: "recorded", observationRevision: result.observationRevision, evidence: {
      decision: prepared.decision, observedAt: candidate.observedAt, expiresAt: candidate.expiresAt, observationRevision: result.observationRevision,
    } };
  } catch { return { state: "uncertain", reasonCode: "record_outcome_unknown" }; }
}
