import { createHash } from "node:crypto";
import {
  projectCapabilityAttention,
  type CapabilityAttentionCursor,
  type CapabilityAttentionEvidence,
  type CapabilityAttentionItem,
  type CapabilityAttentionMetadata,
} from "./providerCapabilityAttention.js";
import type { CapabilityAttentionCommit } from "./providerCapabilityAttentionRuntime.js";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalidInput = () => new Error("attention_store_invalid_input");
const invalidResponse = () => new Error("attention_store_invalid_response");

/** Snapshot only JSON data, rejecting accessors, unusual prototypes and unbounded data. */
function jsonSnapshot(value: unknown): unknown {
  let nodes = 0;
  function copy(source: unknown, depth: number): unknown {
    if (++nodes > 2000 || depth > 12) throw invalidInput();
    if (source === null || typeof source === "boolean") return source;
    if (typeof source === "string") {
      if (source.length > 1024) throw invalidInput();
      return source;
    }
    if (typeof source === "number" && Number.isFinite(source)) return source;
    if (!source || typeof source !== "object") throw invalidInput();
    if (Array.isArray(source)) {
      if (Object.getPrototypeOf(source) !== Array.prototype || source.length > 128
        || Reflect.ownKeys(source).length !== source.length + 1) throw invalidInput();
      return Array.from({ length: source.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(source, String(index));
        if (!property || !("value" in property) || !property.enumerable) throw invalidInput();
        return copy(property.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(source) !== Object.prototype) throw invalidInput();
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string" || key.length > 80 || ["__proto__", "constructor", "prototype"].includes(key)) throw invalidInput();
      const property = Object.getOwnPropertyDescriptor(source, key);
      if (!property || !("value" in property) || !property.enumerable) throw invalidInput();
      output[key] = copy(property.value, depth + 1);
    }
    return output;
  }
  const result = copy(value, 0);
  if (JSON.stringify(result).length > 32_768) throw invalidInput();
  return result;
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

type ProjectionFields = {
  cursor: CapabilityAttentionCursor;
  item: CapabilityAttentionItem;
  evidence: CapabilityAttentionEvidence | null;
};
/** Backend metadata never serves as its own approval: use only the captured caller allowlist. */
function validateProjection(value: Record<string, unknown>, scopeKey: string, reviewedMetadata: readonly CapabilityAttentionMetadata[]): ProjectionFields {
  if (!record(value.cursor, ["scopeKey", "fingerprint", "generation", "lastObservationRevision", "lastObservedAt", "lastEvidenceHash", "evaluatedAt"])
    || !value.item || typeof value.item !== "object" || Array.isArray(value.item)) throw invalidInput();
  const item = value.item as Record<string, unknown>;
  if (value.evidence !== null) {
    if (!record(value.evidence, ["decision", "observedAt", "expiresAt", "observationRevision"])
      || !record(value.evidence.decision, ["contractVersion", "classification", "allowedExtensions", "reportedAddedExtensions", "reportedRemovedExtensions", "evidenceRefs", "normalizedObservedMimeTypes"])) throw invalidInput();
  }
  const projected = projectCapabilityAttention({
    metadata: item.metadata, reviewedMetadata, evidence: value.evidence,
    previous: value.cursor, now: value.cursor.evaluatedAt as string,
  });
  if (projected.state !== "projected" || projected.cursor.scopeKey !== scopeKey
    || projected.item.reasonCode === "source_malformed" || canonical(projected.cursor) !== canonical(value.cursor)
    || canonical(projected.item) !== canonical(value.item)) throw invalidInput();
  return { cursor: projected.cursor, item: projected.item, evidence: value.evidence as CapabilityAttentionEvidence | null };
}
function validateIntent(intent: unknown, projection: ProjectionFields): CapabilityAttentionCommit["intent"] {
  if (intent === null) return null;
  if (!record(intent, ["key", "itemKey", "generation", "kind", "reasonCode"])) throw invalidInput();
  const { cursor, item } = projection;
  // Verify the existing projector's intent identity; this does not advance its state.
  const key = createHash("sha256").update(JSON.stringify([cursor.scopeKey, cursor.generation, cursor.fingerprint])).digest("hex");
  if (cursor.generation < 1 || intent.key !== key || intent.itemKey !== item.key
    || intent.generation !== cursor.generation || intent.reasonCode !== item.reasonCode
    || intent.kind !== (item.severity === "healthy" ? "recovery" : "attention")) throw invalidInput();
  return intent as CapabilityAttentionCommit["intent"];
}

/** Bound every injected operation by the caller signal, including durable retention. */
async function withSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw invalidInput();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(invalidInput());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    if (signal.aborted) throw invalidInput();
    const result = await Promise.race([operation(), aborted]);
    if (signal.aborted) throw invalidInput();
    return result;
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

export type PreparedCapabilityAttentionCommit = {
  readonly p_input: {
    readonly expectedVersion: number;
    readonly evaluationKey: string;
    readonly cursor: CapabilityAttentionCursor;
    readonly item: CapabilityAttentionItem;
    readonly intent: CapabilityAttentionCommit["intent"];
    readonly evidence: CapabilityAttentionEvidence | null;
  };
};
export type CapabilityAttentionTransport = {
  read(input: { p_scope_key: string }, signal: AbortSignal): Promise<unknown>;
  commit(input: PreparedCapabilityAttentionCommit, signal: AbortSignal): Promise<unknown>;
};

function readVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function expectedVersion(value: unknown): number {
  if (value === null) return 0;
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value)) throw invalidInput();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > Number.MAX_SAFE_INTEGER - 1 || String(parsed) !== value) throw invalidInput();
  return parsed;
}

/**
 * Disconnected numeric-RPC/string-store mapping. Transport owns service identity,
 * SQL/CAS/outbox enforcement and exact evaluation replay. No SDK or RPC calls here.
 * onPrepared MUST durably retain the serializable UUID and exact frozen payload
 * before resolving, or reject; it must honor the caller's cancellation budget.
 * Its journal must reject changed payloads under an existing UUID across restarts.
 * compareAndSwap creates one evaluation; recovery uses the retained handle with
 * commitPrepared explicitly, never another compareAndSwap or a recomputed clock.
 */
export function createCapabilityAttentionStoreAdapter(options: {
  transport: CapabilityAttentionTransport;
  reviewedMetadata: readonly CapabilityAttentionMetadata[];
  issueEvaluationKey: () => string;
  onPrepared: (input: PreparedCapabilityAttentionCommit, signal: AbortSignal) => Promise<void>;
}) {
  const reviewed = freeze(jsonSnapshot(options.reviewedMetadata)) as readonly CapabilityAttentionMetadata[];
  const readTransport = options.transport.read.bind(options.transport);
  const commitTransport = options.transport.commit.bind(options.transport);
  const issueEvaluationKey = options.issueEvaluationKey;
  const onPrepared = options.onPrepared;
  const bindings = new Map<string, string>();

  function bind(prepared: PreparedCapabilityAttentionCommit): PreparedCapabilityAttentionCommit {
    const key = prepared.p_input.evaluationKey;
    const serialized = canonical(prepared);
    const previous = bindings.get(key);
    if (previous !== undefined && previous !== serialized) throw invalidInput();
    bindings.set(key, serialized);
    return freeze(prepared);
  }
  function validatePrepared(value: unknown): PreparedCapabilityAttentionCommit {
    const copied = jsonSnapshot(value);
    if (!record(copied, ["p_input"]) || !record(copied.p_input, ["expectedVersion", "evaluationKey", "cursor", "item", "intent", "evidence"])) throw invalidInput();
    const payload = copied.p_input;
    if (typeof payload.expectedVersion !== "number" || !Number.isSafeInteger(payload.expectedVersion)
      || Object.is(payload.expectedVersion, -0) || payload.expectedVersion < 0 || payload.expectedVersion > Number.MAX_SAFE_INTEGER - 1
      || typeof payload.evaluationKey !== "string" || !UUID.test(payload.evaluationKey)
      || !payload.cursor || typeof payload.cursor !== "object") throw invalidInput();
    const scopeKey = (payload.cursor as Record<string, unknown>).scopeKey;
    if (typeof scopeKey !== "string" || !HASH.test(scopeKey)) throw invalidInput();
    const projection = validateProjection(payload, scopeKey, reviewed);
    const intent = validateIntent(payload.intent, projection);
    return bind({ p_input: { expectedVersion: payload.expectedVersion, evaluationKey: payload.evaluationKey, ...projection, intent } });
  }

  function prepareCommit(commit: CapabilityAttentionCommit, evaluationKey: string): PreparedCapabilityAttentionCommit {
    const copied = jsonSnapshot(commit);
    if (!record(copied, ["scopeKey", "expectedVersion", "cursor", "evidence", "item", "intent"])
      || typeof copied.scopeKey !== "string" || !HASH.test(copied.scopeKey)) throw invalidInput();
    const projection = validateProjection(copied, copied.scopeKey, reviewed);
    return validatePrepared({ p_input: {
      expectedVersion: expectedVersion(copied.expectedVersion), evaluationKey, ...projection,
      intent: validateIntent(copied.intent, projection),
    } });
  }

  async function load(scopeKey: string, signal: AbortSignal) {
    try {
      if (typeof scopeKey !== "string" || !HASH.test(scopeKey)) throw invalidInput();
      const raw = await withSignal(signal, () => readTransport({ p_scope_key: scopeKey }, signal));
      if (raw === null) return null;
      const value = jsonSnapshot(raw);
      if (!record(value, ["version", "cursor", "item", "evidence"]) || !readVersion(value.version)) throw invalidResponse();
      const projection = validateProjection(value, scopeKey, reviewed);
      return { version: String(value.version), cursor: projection.cursor, evidence: projection.evidence };
    } catch {
      throw invalidResponse();
    }
  }

  async function commitPrepared(input: PreparedCapabilityAttentionCommit, signal: AbortSignal): Promise<"committed" | "conflict"> {
    try {
      const prepared = validatePrepared(input);
      await withSignal(signal, () => onPrepared(prepared, signal));
      const raw = await withSignal(signal, () => commitTransport(prepared, signal));
      const result = jsonSnapshot(raw);
      if (record(result, ["status"]) && result.status === "conflict") return "conflict";
      if (record(result, ["status", "version"]) && result.status === "committed" && readVersion(result.version)
        && result.version === prepared.p_input.expectedVersion + 1) return "committed";
      throw invalidResponse();
    } catch {
      throw new Error("attention_store_commit_unknown");
    }
  }

  async function compareAndSwap(commit: CapabilityAttentionCommit, signal: AbortSignal): Promise<"committed" | "conflict"> {
    try {
      const prepared = prepareCommit(commit, issueEvaluationKey());
      return await commitPrepared(prepared, signal);
    } catch {
      throw new Error("attention_store_commit_unknown");
    }
  }
  return { load, compareAndSwap, prepareCommit, commitPrepared };
}
