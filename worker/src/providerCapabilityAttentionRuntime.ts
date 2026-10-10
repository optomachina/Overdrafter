import {
  projectCapabilityAttention,
  type CapabilityAttentionCursor,
  type CapabilityAttentionEvidence,
  type CapabilityAttentionItem,
  type CapabilityAttentionMetadata,
  type CapabilityAttentionResult,
} from "./providerCapabilityAttention.js";

type Projected = Extract<CapabilityAttentionResult, { state: "projected" }>;
export type CapabilityAttentionSnapshot = {
  version: string;
  cursor: CapabilityAttentionCursor;
  evidence: CapabilityAttentionEvidence | null;
};
export type CapabilityAttentionCommit = {
  scopeKey: string;
  expectedVersion: string | null;
  cursor: CapabilityAttentionCursor;
  evidence: CapabilityAttentionEvidence | null;
  item: CapabilityAttentionItem;
  intent: Projected["intent"];
};
/**
 * Required service-owned durable backend. compareAndSwap MUST atomically store
 * cursor, retained sanitized evidence, current item, and unique intent/outbox key.
 * Conflict writes nothing. Cancellation can leave a remote commit uncertain.
 * No implementation exists in this source slice; test fixtures are not durability.
 */
export type CapabilityAttentionStore = {
  load(scopeKey: string, signal: AbortSignal): Promise<CapabilityAttentionSnapshot | null>;
  compareAndSwap(commit: CapabilityAttentionCommit, signal: AbortSignal): Promise<"committed" | "conflict">;
};
export type CapabilityAttentionRuntimeInput = {
  metadata: unknown;
  reviewedMetadata: readonly CapabilityAttentionMetadata[];
  /** Undefined performs a stale-evidence sweep using the stored evidence. */
  evidence?: unknown;
  now: string;
  signal?: AbortSignal;
};
export type CapabilityAttentionRuntimeResult =
  | { state: "committed"; item: CapabilityAttentionItem; generation: number; transitionStored: boolean }
  | { state: "dependency_unavailable" }
  | { state: "rejected"; reasonCode: string }
  | { state: "conflict" }
  | { state: "failed"; reasonCode: "store_read_failed" }
  | { state: "uncertain"; reasonCode: "store_commit_unknown" };

function snapshotShape(value: unknown): value is CapabilityAttentionSnapshot | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 3 && ["version", "cursor", "evidence"].every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  }) && typeof (value as CapabilityAttentionSnapshot).version === "string"
    && /^[a-zA-Z0-9._:-]{1,128}$/.test((value as CapabilityAttentionSnapshot).version)
    && (value as CapabilityAttentionSnapshot).cursor !== null
    && typeof (value as CapabilityAttentionSnapshot).cursor === "object";
}

/** Strip optional free text; validation remains exclusively in the projection. */
function retainedEvidence(value: unknown, projected: Projected): CapabilityAttentionEvidence | null {
  if (projected.item.observedAt === null || projected.item.expiresAt === null) return null;
  const source = value as CapabilityAttentionEvidence;
  return {
    observedAt: projected.item.observedAt, expiresAt: projected.item.expiresAt,
    observationRevision: source.observationRevision,
    decision: {
      contractVersion: source.decision.contractVersion, classification: source.decision.classification,
      allowedExtensions: [...source.decision.allowedExtensions],
      reportedAddedExtensions: [...source.decision.reportedAddedExtensions],
      reportedRemovedExtensions: [...source.decision.reportedRemovedExtensions],
      evidenceRefs: [...source.decision.evidenceRefs],
      normalizedObservedMimeTypes: [...source.decision.normalizedObservedMimeTypes],
    },
  };
}

/**
 * Load/project/CAS once, without delivery or implicit retries. A stale sweep can
 * generate one transition without a new observation. Cross-run dedup only exists
 * when the supplied backend satisfies its atomic durable contract.
 */
export async function updateCapabilityAttention(
  store: CapabilityAttentionStore | null,
  input: CapabilityAttentionRuntimeInput,
): Promise<CapabilityAttentionRuntimeResult> {
  if (!store) return { state: "dependency_unavailable" };
  let committing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  try {
    const context = projectCapabilityAttention({ ...input, evidence: null, previous: null });
    if (context.state === "rejected") return { state: "rejected", reasonCode: context.reasonCode };
    if (input.signal?.aborted) return { state: "rejected", reasonCode: "aborted_before_store" };
    input.signal?.addEventListener("abort", relayAbort, { once: true });
    timer = setTimeout(relayAbort, 5_000);
    const aborted = new Promise<null>((resolve) => {
      abortListener = () => resolve(null);
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const loaded = await Promise.race([store.load(context.cursor.scopeKey, controller.signal).then((value) => ({ value })), aborted]);
    if (controller.signal.aborted || loaded === null) return { state: "failed", reasonCode: "store_read_failed" };
    const snapshot = loaded.value;
    if (!snapshotShape(snapshot)) return { state: "failed", reasonCode: "store_read_failed" };
    const evidence = input.evidence === undefined ? snapshot?.evidence ?? null : input.evidence;
    const result = projectCapabilityAttention({ ...input, evidence, previous: snapshot?.cursor ?? null });
    if (result.state === "rejected") return { state: "rejected", reasonCode: result.reasonCode };
    if (result.item.reasonCode === "source_malformed") return { state: "rejected", reasonCode: "source_malformed" };
    if (controller.signal.aborted) return { state: "failed", reasonCode: "store_read_failed" };
    const commit: CapabilityAttentionCommit = {
      scopeKey: result.cursor.scopeKey, expectedVersion: snapshot?.version ?? null,
      cursor: result.cursor, evidence: retainedEvidence(evidence, result), item: result.item, intent: result.intent,
    };
    committing = true;
    const status = await Promise.race([store.compareAndSwap(commit, controller.signal), aborted]);
    if (controller.signal.aborted || status === null) return { state: "uncertain", reasonCode: "store_commit_unknown" };
    if (status === "conflict") return { state: "conflict" };
    if (status !== "committed") return { state: "uncertain", reasonCode: "store_commit_unknown" };
    return { state: "committed", item: result.item, generation: result.cursor.generation, transitionStored: result.intent !== null };
  } catch {
    return committing ? { state: "uncertain", reasonCode: "store_commit_unknown" }
      : { state: "failed", reasonCode: "store_read_failed" };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", relayAbort);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
