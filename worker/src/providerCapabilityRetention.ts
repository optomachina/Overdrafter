import type { CapabilityWindowClaim, CapabilityWindowCompletion, CapabilityAttentionCommit } from "./providerCapabilityRuntimePersistence.js";
import type { CanaryRetentionEntry } from "./providerCapabilityCanaryService.js";
import type { PreparedCapabilityAttentionCommit } from "./providerCapabilityAttentionStoreAdapter.js";

export type PreparedCapabilityClaim = { request: CapabilityWindowClaim; completionKey: string };
export type CapabilityRetentionReceipt<T> = { state: "created" | "existing"; retained: T };
export type CapabilityPreparedPage<T> = { entries: { cursor: string; input: T }[]; nextCursor: string | null; hasMore: boolean };
/** Semantic port over unwrapped canonical results, not RPC names or a storage implementation. */
export type CapabilityRetentionPort = {
  prepareClaim(input: PreparedCapabilityClaim, signal: AbortSignal): Promise<CapabilityRetentionReceipt<PreparedCapabilityClaim>>;
  readClaim(requestKey: string, signal: AbortSignal): Promise<PreparedCapabilityClaim | null>;
  prepareCompletion(input: CapabilityWindowCompletion, signal: AbortSignal): Promise<CapabilityRetentionReceipt<CapabilityWindowCompletion>>;
  readCompletion(completionKey: string, signal: AbortSignal): Promise<CapabilityWindowCompletion | null>;
  prepareAttention(input: CapabilityAttentionCommit, signal: AbortSignal): Promise<CapabilityRetentionReceipt<CapabilityAttentionCommit>>;
  readAttention(evaluationKey: string, signal: AbortSignal): Promise<CapabilityAttentionCommit | null>;
  listClaims(input: { windowKey: string; afterCursor: string | null; limit: number }, signal: AbortSignal): Promise<CapabilityPreparedPage<PreparedCapabilityClaim>>;
  listAttention(input: { scopeKey: string; afterCursor: string | null; limit: number }, signal: AbortSignal): Promise<CapabilityPreparedPage<CapabilityAttentionCommit>>;
};
export type CapabilityRetentionPreparationPort = Pick<CapabilityRetentionPort, "prepareClaim" | "prepareCompletion" | "prepareAttention">;
const unavailable = () => new Error("capability_retention_unavailable");
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const d = Object.getOwnPropertyDescriptor(value, key); return d && "value" in d && d.enumerable;
    });
}
/** Copy data properties only: no getter evaluation, private prototypes, holes or mutable caller references. */
function snapshot<T>(input: T): T {
  let remaining = 20000;
  const seen = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 12) throw unavailable();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string" && value.length <= 1024) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || seen.has(value)) throw unavailable();
    seen.add(value);
    let output: unknown;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100 || Reflect.ownKeys(value).length !== value.length + 1) throw unavailable();
      output = Array.from({ length: value.length }, (_, index) => {
        const d = Object.getOwnPropertyDescriptor(value, String(index));
        if (!d || !("value" in d) || !d.enumerable) throw unavailable();
        return copy(d.value, depth + 1);
      });
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length > 40) throw unavailable();
      const object: Record<string, unknown> = {};
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== "string")) throw unavailable();
      for (const key of (keys as string[]).sort()) {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key) || !d || !("value" in d) || !d.enumerable) throw unavailable();
        object[key] = copy(d.value, depth + 1);
      }
      output = object;
    }
    seen.delete(value); return Object.freeze(output);
  }
  const result = copy(input, 0);
  if (JSON.stringify(result).length > 16384) throw unavailable();
  return result as T;
}
function claimShape(value: PreparedCapabilityClaim): boolean {
  return exact(value, ["request", "completionKey"]) && exact(value.request, ["windowKey", "resourceKey", "configDigest", "requestKey", "provider", "route", "surface", "surfaceRevision", "windowStart", "windowEnd", "leaseSeconds"]);
}
function completionShape(value: CapabilityWindowCompletion): boolean {
  return exact(value, ["windowKey", "requestKey", "fence", "completionKey", "resourceReleased", "candidate"])
    && value.resourceReleased === true && exact(value.candidate, ["provider", "route", "surface", "revision", "state", "extensions", "mimeTypes", "acceptAttributePresent", "observedAt", "expiresAt", "actorKind", "sourceKind", "sourceVersion", "evidenceReference", "idempotencyKey"]);
}
function attentionShape(value: CapabilityAttentionCommit): boolean {
  return exact(value, ["expectedVersion", "evaluationKey", "cursor", "item", "intent", "evidence"]);
}
/** Hooks consume already validated runtime/attention payloads; canonical preparation remains the storage validator. */
export function createCapabilityRetentionHooks(options: {
  enabled?: boolean;
  port: CapabilityRetentionPreparationPort | null;
  budgetMs?: number;
}) {
  const enabled = options.enabled === true;
  const budgetMs = options.budgetMs ?? 5000;
  const validBudget = Number.isSafeInteger(budgetMs) && budgetMs >= 1 && budgetMs <= 5000;
  // Capture the injected method and receiver before the first await.
  const port = enabled && validBudget ? options.port : null;
  const claimMethod = port?.prepareClaim, completionMethod = port?.prepareCompletion, attentionMethod = port?.prepareAttention;
  const prepareClaim = typeof claimMethod === "function" ? claimMethod.bind(port) : undefined;
  const prepareCompletion = typeof completionMethod === "function" ? completionMethod.bind(port) : undefined;
  const prepareAttention = typeof attentionMethod === "function" ? attentionMethod.bind(port) : undefined;
  async function prepare<T>(input: T, method: ((input: T, signal: AbortSignal) => Promise<CapabilityRetentionReceipt<T>>) | undefined,
    signal: AbortSignal): Promise<{ state: "created" | "existing" }> {
    if (!enabled || !validBudget || !method || signal.aborted) throw unavailable();
    const retained = snapshot(input);
    const controller = new AbortController();
    let abort: () => void = () => undefined;
    const cancellation = new Promise<never>((_, reject) => { abort = () => { controller.abort(); reject(unavailable()); }; });
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, budgetMs);
    try {
      if (signal.aborted) throw unavailable();
      const response = await Promise.race([method(retained, controller.signal), cancellation]);
      if (signal.aborted || controller.signal.aborted || !exact(response, ["state", "retained"])
        || (response.state !== "created" && response.state !== "existing")
        || JSON.stringify(snapshot(response.retained)) !== JSON.stringify(retained)) throw unavailable();
      return { state: response.state };
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  return Object.freeze({
    async retainBeforeDispatch(entry: CanaryRetentionEntry, signal: AbortSignal): Promise<{ state: "created" | "existing" }> {
      // Snapshot the envelope before inspecting its discriminator.
      const value = snapshot(entry);
      if (exact(value, ["kind", "request", "completionKey"]) && value.kind === "claim_request") {
        const input = { request: value.request, completionKey: value.completionKey } as PreparedCapabilityClaim;
        if (!claimShape(input)) throw unavailable();
        return prepare(input, prepareClaim, signal);
      }
      if (exact(value, ["kind", "input"]) && value.kind === "completion" && completionShape(value.input as CapabilityWindowCompletion)) {
        return prepare(value.input as CapabilityWindowCompletion, prepareCompletion, signal);
      }
      throw unavailable();
    },
    async onPrepared(handle: PreparedCapabilityAttentionCommit, signal: AbortSignal): Promise<void> {
      const value = snapshot(handle);
      if (!exact(value, ["p_input"]) || !attentionShape(value.p_input as CapabilityAttentionCommit)) throw unavailable();
      // Exact-existing acknowledgement is allowed for the adapter's explicit exact replay.
      await prepare(value.p_input as CapabilityAttentionCommit, prepareAttention, signal);
    },
  });
}
