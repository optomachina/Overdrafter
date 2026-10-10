import type { CanaryPlan } from "./providerCapabilityCanary.js";
import { projectCapabilityAttention, type CapabilityAttentionEvidence, type CapabilityAttentionMetadata } from "./providerCapabilityAttention.js";
import { updateCapabilityAttention } from "./providerCapabilityAttentionRuntime.js";
import { createCapabilityAttentionStoreAdapter, type PreparedCapabilityAttentionCommit } from "./providerCapabilityAttentionStoreAdapter.js";
import type { CapabilityPersistenceTransport } from "./providerCapabilityPersistenceTransport.js";

type AttentionTransport = Pick<CapabilityPersistenceTransport, "readAttention" | "commitAttention" | "listDueAttention">;
type Budget = { signal: AbortSignal; deadlineMs: number };
export type ConfirmedCapabilityObservation = Budget & { plan: CanaryPlan; evidence: CapabilityAttentionEvidence };
type Unavailable = { state: "disabled" | "dependency_unavailable" | "invalid_context" | "invalid_request" | "cancelled" };
export type CapabilityAttentionServiceOutcome = Unavailable | { state: "committed" | "pending" | "conflict" | "uncertain" };
export type CapabilityAttentionSweepOutcome = Unavailable | { state: "list_failed" } | {
  state: "swept"; visited: number; committed: number; pending: number; skipped: number;
};
const HASH = /^[a-f0-9]{64}$/;
function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
}
/** Discovery reads a data property only; due-list metadata cannot review itself. */
function dueScope(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const property = Object.getOwnPropertyDescriptor(value, "cursor");
  if (!property || !("value" in property) || !property.value || typeof property.value !== "object") return null;
  const scope = Object.getOwnPropertyDescriptor(property.value, "scopeKey");
  return scope && "value" in scope && typeof scope.value === "string" && HASH.test(scope.value) ? scope.value : null;
}

/**
 * Default-off SDK composition, not a scheduler, probe, ledger writer or journal.
 * The supplied transport unwraps the canonical SDK results and cancels its actual
 * builders. onPrepared remains a required DURABLE retention obligation: no
 * concrete journal exists here and omitting it disables all service operations.
 * Due rows are discovery only; each approved scope is reloaded through the strict
 * store adapter. A confirmed-completion caller must use direct fenced evidence,
 * never candidate data inferred from status-only reconciliation.
 */
export function createCapabilityAttentionService(options: {
  enabled?: boolean;
  transport?: AttentionTransport | null;
  reviewedMetadata?: readonly CapabilityAttentionMetadata[];
  onPrepared?: ((handle: PreparedCapabilityAttentionCommit, signal: AbortSignal) => Promise<void>) | null;
  issueEvaluationKey?: () => string;
  now?: () => number;
} = {}) {
  const enabled = options.enabled === true;
  const now = options.now;
  let reviewed: readonly CapabilityAttentionMetadata[] = [];
  let configurationInvalid = false;
  try {
    if (options.reviewedMetadata !== undefined && (!Array.isArray(options.reviewedMetadata) || options.reviewedMetadata.length > 100)) throw Error();
    reviewed = Object.freeze(structuredClone(options.reviewedMetadata ?? []).map((entry) => Object.freeze(entry)));
  } catch { configurationInvalid = true; }
  const transport = options.transport;
  const read = transport?.readAttention.bind(transport);
  const commit = transport?.commitAttention.bind(transport);
  const list = transport?.listDueAttention.bind(transport);
  const onPrepared = options.onPrepared;
  const issueEvaluationKey = options.issueEvaluationKey;
  let store: ReturnType<typeof createCapabilityAttentionStoreAdapter> | null = null;
  if (enabled && !configurationInvalid && reviewed.length > 0 && read && commit && list && onPrepared && issueEvaluationKey && now) {
    try {
      store = createCapabilityAttentionStoreAdapter({ reviewedMetadata: reviewed, onPrepared, issueEvaluationKey,
        transport: { read: (request, signal) => read(request.p_scope_key, signal), commit: (request, signal) => commit(request.p_input, signal) } });
    } catch { configurationInvalid = true; }
  }
  function unavailable(): Unavailable | null {
    if (!enabled) return { state: "disabled" };
    if (configurationInvalid) return { state: "invalid_context" };
    if (reviewed.length === 0) return { state: "disabled" };
    return store && now && list ? null : { state: "dependency_unavailable" };
  }
  function contexts(time: number): Map<string, CapabilityAttentionMetadata> | null {
    const known = new Map<string, CapabilityAttentionMetadata>();
    for (const metadata of reviewed) {
      const projected = projectCapabilityAttention({ metadata, reviewedMetadata: reviewed, evidence: null, previous: null, now: new Date(time).toISOString() });
      if (projected.state !== "projected") return null;
      known.set(projected.cursor.scopeKey, projected.item.metadata);
    }
    return known;
  }
  async function bounded<T>(budget: Budget, operation: (signal: AbortSignal, time: number) => Promise<T>): Promise<T | Unavailable> {
    const { signal: callerSignal, deadlineMs } = budget;
    const missing = unavailable();
    if (missing) return missing;
    let time: number;
    try { time = now!(); } catch { return { state: "invalid_request" }; }
    // Upper limit is setTimeout's representable delay, not a deployment SLA.
    const remaining = deadlineMs - time;
    if (!validTime(time) || !validTime(deadlineMs) || remaining <= 0 || remaining > 2147483647) return { state: "invalid_request" };
    if (callerSignal.aborted) return { state: "cancelled" };
    const controller = new AbortController();
    const abort = () => controller.abort();
    callerSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, remaining);
    let listener: (() => void) | undefined;
    const cancelled = new Promise<Unavailable>((resolve) => {
      listener = () => resolve({ state: "cancelled" });
      controller.signal.addEventListener("abort", listener, { once: true });
    });
    try {
      if (callerSignal.aborted) controller.abort();
      if (controller.signal.aborted) return { state: "cancelled" };
      return await Promise.race([operation(controller.signal, time), cancelled]);
    } catch {
      return { state: "invalid_context" };
    } finally {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", abort);
      if (listener) controller.signal.removeEventListener("abort", listener);
    }
  }

  async function onConfirmedObservation(input: ConfirmedCapabilityObservation): Promise<CapabilityAttentionServiceOutcome> {
    // Detach confirmed source data before any await; no provider or ledger call.
    let release: CanaryPlan["releaseEnvelope"];
    let evidence: CapabilityAttentionEvidence;
    try { release = structuredClone(input.plan.releaseEnvelope); evidence = structuredClone(input.evidence); }
    catch { return { state: "invalid_context" }; }
    return bounded(input, async (signal, time) => {
      const known = contexts(time);
      if (!known) return { state: "invalid_context" } as const;
      const matches = [...known.values()].filter((metadata) => metadata.provider === release.provider
        && metadata.route === release.route && metadata.surface === release.surface
        && metadata.surfaceRevision === release.revision && metadata.policyRevision === release.policyRevision);
      if (matches.length !== 1) return { state: "invalid_context" } as const;
      const result = await updateCapabilityAttention(store, {
        metadata: matches[0], reviewedMetadata: reviewed, evidence, now: new Date(time).toISOString(), signal,
      });
      return { state: result.state === "committed" ? "committed" : "pending" } as const;
    });
  }

  async function sweep(input: Budget & { limit: number }): Promise<CapabilityAttentionSweepOutcome> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) return { state: "invalid_request" };
    const limit = input.limit;
    const deadlineMs = input.deadlineMs;
    return bounded(input, async (signal, time) => {
      const known = contexts(time);
      if (!known) return { state: "invalid_context" } as const;
      let due: unknown;
      try { due = await list!(limit, signal); } catch { return { state: "list_failed" } as const; }
      if (signal.aborted) return { state: "cancelled" } as const;
      if (!Array.isArray(due) || due.length > limit) return { state: "list_failed" } as const;
      const result = { state: "swept" as const, visited: 0, committed: 0, pending: 0, skipped: 0 };
      const seen = new Set<string>();
      for (const row of due) {
        if (signal.aborted) return { state: "cancelled" } as const;
        const scopeKey = dueScope(row);
        const metadata = scopeKey ? known.get(scopeKey) : undefined;
        if (!scopeKey || !metadata || seen.has(scopeKey)) { result.skipped++; continue; }
        seen.add(scopeKey);
        let current: number;
        try { current = now!(); } catch { return { state: "invalid_request" } as const; }
        if (!validTime(current) || current >= deadlineMs) return { state: "cancelled" } as const;
        const outcome = await updateCapabilityAttention(store, {
          metadata, reviewedMetadata: reviewed, now: new Date(current).toISOString(), signal,
        });
        result.visited++;
        if (outcome.state === "committed") result.committed++; else result.pending++;
      }
      return result;
    });
  }

  async function replayPrepared(handle: PreparedCapabilityAttentionCommit, budget: Budget): Promise<CapabilityAttentionServiceOutcome> {
    let retained: PreparedCapabilityAttentionCommit;
    try { retained = structuredClone(handle); } catch { return { state: "invalid_request" }; }
    let started = false;
    const result = await bounded(budget, async (signal) => {
      started = true;
      try { return { state: await store!.commitPrepared(retained, signal) } as const; }
      catch { return { state: "uncertain" } as const; }
    });
    return result.state === "cancelled" && started ? { state: "uncertain" } : result;
  }
  return { onConfirmedObservation, sweep, replayPrepared };
}
