import type { CapabilityRetentionPort, PreparedCapabilityClaim, CapabilityPreparedPage } from "./providerCapabilityRetention.js";
import { projectCapabilityAttention, type CapabilityAttentionMetadata } from "./providerCapabilityAttention.js";
import type { CapabilityAttentionCommit, CapabilityWindowCompletion } from "./providerCapabilityRuntimePersistence.js";
import type { CapabilityPersistenceTransport } from "./providerCapabilityPersistenceTransport.js";
import { createCanaryFencedAttempt, canaryFencedTime } from "./providerCapabilityCanaryFenced.js";
import { createCapabilityAttentionStoreAdapter, type PreparedCapabilityAttentionCommit } from "./providerCapabilityAttentionStoreAdapter.js";
import type { createCapabilityAttentionService } from "./providerCapabilityAttentionService.js";

type Stage = <T>(operation: () => Promise<T>) => Promise<T>;
type Budget = { signal: AbortSignal; deadlineMs: number };
type Failure = { state: "disabled" | "unavailable" | "invalid_request" | "invalid_response" | "cancelled" | "uncertain" };
type Read<T> = Failure | { state: "absent" } | { state: "value"; value: T };
type Page<T> = Failure | { state: "page"; page: CapabilityPreparedPage<T> };
type Port = Pick<CapabilityRetentionPort, "readClaim" | "readCompletion" | "readAttention" | "listClaims" | "listAttention">;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WINDOW = /^canary:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const d = Object.getOwnPropertyDescriptor(value, key); return d && "value" in d && d.enumerable;
    });
}
/** Bounded JSON detachment without invoking getters; returned data cannot mutate retained source. */
function snapshot(value: unknown, depth = 0, budget = { left: 100000 }): unknown {
  if (--budget.left < 0 || depth > 12) throw Error();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= 2048) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") throw Error();
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw Error();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 101 || (array && keys.length !== value.length + 1)) throw Error();
  if (array) return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const d = Object.getOwnPropertyDescriptor(value, String(index));
    if (!d || !("value" in d) || !d.enumerable) throw Error();
    return snapshot(d.value, depth + 1, budget);
  }));
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !d || !("value" in d) || !d.enumerable) throw Error();
    Object.defineProperty(copy, key, { value: snapshot(d.value, depth + 1, budget), enumerable: true });
  }
  return Object.freeze(copy);
}
const decimal = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,511}$/.test(value);
const greater = (a: string, b: string) => a.length > b.length || (a.length === b.length && a > b);
const unavailable = async (): Promise<never> => { throw Error("recovery_only"); };

/** Restart reads grant no probe authority. Discovery never dispatches or automatically advances a cursor. */
export function createCapabilityRecoveryService(options: {
  enabled?: boolean; port?: Port | null; reviewedWindows?: readonly string[];
  reviewedMetadata?: readonly CapabilityAttentionMetadata[]; now?: () => number;
  status?: CapabilityPersistenceTransport["get"];
  complete?: CapabilityPersistenceTransport["complete"];
  attentionReplay?: ReturnType<typeof createCapabilityAttentionService>["replayPrepared"];
} = {}) {
  const enabled = options.enabled === true;
  const now = options.now;
  const windows = new Set(options.reviewedWindows ?? []);
  const reviewed = structuredClone(options.reviewedMetadata ?? []);
  const scopes = new Set(reviewed.map(metadata => {
    // Scope identity only; no observation or freshness is inferred at construction.
    const result = projectCapabilityAttention({ metadata, reviewedMetadata: reviewed, evidence: null, previous: null, now: "1970-01-01T00:00:00.000Z" });
    return result.state === "projected" ? result.cursor.scopeKey : "";
  }).filter(Boolean));
  const port = options.port;
  const readClaimPort = port?.readClaim.bind(port), readCompletionPort = port?.readCompletion.bind(port);
  const readAttentionPort = port?.readAttention.bind(port), listClaimsPort = port?.listClaims.bind(port), listAttentionPort = port?.listAttention.bind(port);
  const status = options.status, complete = options.complete, attentionReplay = options.attentionReplay;
  const validator = createCapabilityAttentionStoreAdapter({ reviewedMetadata: reviewed, issueEvaluationKey: () => { throw Error(); },
    onPrepared: unavailable, transport: { read: unavailable, commit: unavailable } });
  function attempt(input: PreparedCapabilityClaim) {
    return createCanaryFencedAttempt({ request: input.request, completionKey: input.completionKey,
      transport: { claim: unavailable, complete: unavailable, get: (args, signal) => status ? status(args.p_window_key, args.p_request_key, signal) : unavailable() } });
  }
  function claim(raw: unknown, windowKey: string, requestKey?: string): PreparedCapabilityClaim {
    const value = snapshot(raw);
    if (!exact(value, ["request", "completionKey"])) throw Error();
    const input = value as unknown as PreparedCapabilityClaim;
    if (!windows.has(windowKey) || input.request?.windowKey !== windowKey || (requestKey !== undefined && input.request.requestKey !== requestKey)
      || !attempt(input).recovery().request) throw Error();
    return input;
  }
  function attention(raw: unknown, scopeKey: string, evaluationKey?: string): CapabilityAttentionCommit {
    const value = snapshot(raw);
    if (!exact(value, ["expectedVersion", "evaluationKey", "cursor", "item", "intent", "evidence"])) throw Error();
    const input = value as unknown as CapabilityAttentionCommit;
    if (input.cursor?.scopeKey !== scopeKey || (evaluationKey !== undefined && input.evaluationKey !== evaluationKey)
      || !Number.isSafeInteger(input.expectedVersion) || Object.is(input.expectedVersion, -0)
      || input.expectedVersion < 0 || input.expectedVersion >= Number.MAX_SAFE_INTEGER) throw Error();
    return validator.prepareCommit({ scopeKey, expectedVersion: input.expectedVersion === 0 ? null : String(input.expectedVersion),
      cursor: input.cursor, item: input.item, evidence: input.evidence, intent: input.intent }, input.evaluationKey).p_input;
  }
  function completion(raw: unknown, retained: PreparedCapabilityClaim, completionKey: string): CapabilityWindowCompletion {
    const value = snapshot(raw);
    if (!exact(value, ["windowKey", "requestKey", "completionKey", "fence", "resourceReleased", "candidate"])) throw Error();
    const saved = value as unknown as CapabilityWindowCompletion;
    const c = saved.candidate, r = retained.request;
    if (!exact(c, ["provider", "route", "surface", "revision", "state", "extensions", "mimeTypes", "acceptAttributePresent", "observedAt", "expiresAt",
      "actorKind", "sourceKind", "sourceVersion", "evidenceReference", "idempotencyKey"])) throw Error();
    if (retained.completionKey !== completionKey || saved.windowKey !== r.windowKey || saved.requestKey !== r.requestKey
      || saved.completionKey !== completionKey || !UUID.test(saved.fence) || saved.resourceReleased !== true || !c
      || c.provider !== r.provider || c.route !== r.route || c.surface !== r.surface || c.revision !== r.surfaceRevision || c.idempotencyKey !== r.windowKey) throw Error();
    return saved;
  }
  function page<T>(raw: unknown, after: string | null, limit: number, parse: (value: unknown) => T, identity: (value: T) => string[]): CapabilityPreparedPage<T> {
    const value = snapshot(raw);
    if (!exact(value, ["entries", "nextCursor", "hasMore"]) || !Array.isArray(value.entries) || value.entries.length > limit || typeof value.hasMore !== "boolean") throw Error();
    if (value.entries.length === 0) {
      if (value.nextCursor !== null || value.hasMore) throw Error();
      return Object.freeze({ entries: Object.freeze([]) as unknown as { cursor: string; input: T }[], nextCursor: null, hasMore: false });
    }
    let previous = after;
    const seen = new Set<string>();
    const entries = value.entries.map(entry => {
      if (!exact(entry, ["cursor", "input"]) || !decimal(entry.cursor) || (previous !== null && !greater(entry.cursor, previous))) throw Error();
      previous = entry.cursor;
      const input = parse(entry.input);
      for (const key of identity(input)) { if (seen.has(key)) throw Error(); seen.add(key); }
      return Object.freeze({ cursor: entry.cursor, input });
    });
    if (value.nextCursor !== previous) throw Error();
    return Object.freeze({ entries: Object.freeze(entries) as typeof entries, nextCursor: previous, hasMore: value.hasMore });
  }
  async function bounded<T>(input: Budget, action: (signal: AbortSignal, time: number, stage: Stage) => Promise<T>): Promise<T | Failure> {
    if (!enabled) return { state: "disabled" };
    if (!port || !now) return { state: "unavailable" };
    const { signal: caller, deadlineMs } = input;
    let time: number;
    try { time = now(); } catch { return { state: "invalid_request" }; }
    if (!Number.isSafeInteger(time) || !Number.isSafeInteger(deadlineMs) || deadlineMs <= time || deadlineMs - time > 2147483647) return { state: "invalid_request" };
    if (caller.aborted) return { state: "cancelled" };
    const controller = new AbortController();
    let abort!: () => void;
    const cancelled = new Promise<Failure>(resolve => { abort = () => { controller.abort(); resolve({ state: "cancelled" }); }; });
    caller.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, deadlineMs - time);
    const check = () => {
      if (!withinBudget(controller.signal, deadlineMs)) { abort(); throw Error(); }
    };
    const stage: Stage = async operation => {
      check();
      const result = await operation();
      check();
      return result;
    };
    try {
      check();
      const result = await Promise.race([action(controller.signal, time, stage), cancelled]);
      check();
      return result;
    } catch { return { state: withinBudget(controller.signal, deadlineMs) ? "invalid_response" : "cancelled" }; }
    finally { clearTimeout(timer); caller.removeEventListener("abort", abort); }
  }
  function withinBudget(signal: AbortSignal, deadlineMs: number): boolean {
    try { const current = now!(); return !signal.aborted && Number.isSafeInteger(current) && current < deadlineMs; }
    catch { return false; }
  }
  function query(after: string | null, limit: number) { return (after === null || decimal(after)) && Number.isInteger(limit) && limit >= 1 && limit <= 100; }
  async function listClaims(input: Budget & { windowKey: string; afterCursor: string | null; limit: number }): Promise<Page<PreparedCapabilityClaim>> {
    const { windowKey, afterCursor, limit } = input;
    return bounded(input, async (signal, _time, stage) => {
      if (!WINDOW.test(windowKey) || !windows.has(windowKey) || !query(afterCursor, limit)) return { state: "invalid_request" } as const;
      const raw = await stage(() => listClaimsPort!({ windowKey, afterCursor, limit }, signal));
      return { state: "page", page: page(raw, afterCursor, limit, raw => claim(raw, windowKey), value => [`request:${value.request.requestKey}`, `completion:${value.completionKey}`]) } as const;
    });
  }
  async function listAttention(input: Budget & { scopeKey: string; afterCursor: string | null; limit: number }): Promise<Page<CapabilityAttentionCommit>> {
    const { scopeKey, afterCursor, limit } = input;
    return bounded(input, async (signal, _time, stage) => {
      if (!scopes.has(scopeKey) || !HASH.test(scopeKey) || !query(afterCursor, limit)) return { state: "invalid_request" } as const;
      const raw = await stage(() => listAttentionPort!({ scopeKey, afterCursor, limit }, signal));
      return { state: "page", page: page(raw, afterCursor, limit, raw => attention(raw, scopeKey), value => [value.evaluationKey]) } as const;
    });
  }
  async function readClaim(input: Budget & { windowKey: string; requestKey: string }): Promise<Read<PreparedCapabilityClaim>> {
    const { windowKey, requestKey } = input;
    return bounded(input, async (signal, _time, stage) => {
      if (!windows.has(windowKey) || !UUID.test(requestKey)) return { state: "invalid_request" } as const;
      const raw = await stage(() => readClaimPort!(requestKey, signal));
      return raw === null ? { state: "absent" } as const : { state: "value", value: claim(raw, windowKey, requestKey) } as const;
    });
  }
  async function readAttention(input: Budget & { scopeKey: string; evaluationKey: string }): Promise<Read<CapabilityAttentionCommit>> {
    const { scopeKey, evaluationKey } = input;
    return bounded(input, async (signal, _time, stage) => {
      if (!scopes.has(scopeKey) || !HASH.test(scopeKey) || !UUID.test(evaluationKey)) return { state: "invalid_request" } as const;
      const raw = await stage(() => readAttentionPort!(evaluationKey, signal));
      return raw === null ? { state: "absent" } as const : { state: "value", value: attention(raw, scopeKey, evaluationKey) } as const;
    });
  }
  async function reconcileClaim(input: Budget & { windowKey: string; requestKey: string }) {
    const { windowKey, requestKey } = input;
    return bounded(input, async (signal, time, stage) => {
      if (!status) return { state: "unavailable" } as const;
      if (!windows.has(windowKey) || !UUID.test(requestKey)) return { state: "invalid_request" } as const;
      const raw = await stage(() => readClaimPort!(requestKey, signal));
      if (raw === null) return { state: "absent" } as const;
      const result = await stage(() => attempt(claim(raw, windowKey, requestKey)).reconcile(time, signal));
      return { state: "reconciled", status: result.state } as const;
    });
  }
  async function replayAttention(input: Budget & { scopeKey: string; evaluationKey: string }) {
    const { scopeKey, evaluationKey, deadlineMs } = input;
    let dispatched = false;
    const result = await bounded(input, async (signal, _time, stage) => {
      if (!attentionReplay) return { state: "unavailable" } as const;
      if (!scopes.has(scopeKey) || !HASH.test(scopeKey) || !UUID.test(evaluationKey)) return { state: "invalid_request" } as const;
      const raw = await stage(() => readAttentionPort!(evaluationKey, signal));
      if (raw === null) return { state: "absent" } as const;
      const handle: PreparedCapabilityAttentionCommit = { p_input: attention(raw, scopeKey, evaluationKey) };
      if (!withinBudget(signal, deadlineMs)) return { state: "cancelled" } as const;
      try { return await stage(() => { dispatched = true; return attentionReplay(handle, { signal, deadlineMs }); }); }
      catch { return { state: dispatched ? "uncertain" : "cancelled" } as const; }
    });
    return dispatched && result.state === "cancelled" ? { state: "uncertain" } as const : result;
  }
  /** Private recovery data only; canonical complete owns full payload validation before dispatch. */
  async function readCompletion(input: Budget & { windowKey: string; requestKey: string; completionKey: string }): Promise<Read<CapabilityWindowCompletion>> {
    const { windowKey, requestKey, completionKey } = input;
    return bounded(input, async (signal, _time, stage) => {
      if (!windows.has(windowKey) || !UUID.test(requestKey) || !UUID.test(completionKey)) return { state: "invalid_request" } as const;
      const rawClaim = await stage(() => readClaimPort!(requestKey, signal));
      if (rawClaim === null) return { state: "absent" } as const;
      const retained = claim(rawClaim, windowKey, requestKey);
      if (retained.completionKey !== completionKey || signal.aborted) throw Error();
      const raw = await stage(() => readCompletionPort!(completionKey, signal));
      return raw === null ? { state: "absent" } as const : { state: "value", value: completion(raw, retained, completionKey) } as const;
    });
  }
  // Completion replay is separate from the executable attempt. No recovered claim authorizes a probe.
  async function replayCompletion(input: Budget & { windowKey: string; requestKey: string; completionKey: string }) {
    const { windowKey, requestKey, completionKey, deadlineMs } = input;
    let dispatched = false;
    const result = await bounded(input, async (signal, _time, stage) => {
      if (!status || !complete) return { state: "unavailable" } as const;
      if (!windows.has(windowKey) || !UUID.test(requestKey) || !UUID.test(completionKey)) return { state: "invalid_request" } as const;
      const rawClaim = await stage(() => readClaimPort!(requestKey, signal));
      if (rawClaim === null) return { state: "absent" } as const;
      const retained = claim(rawClaim, windowKey, requestKey);
      if (retained.completionKey !== completionKey || signal.aborted) throw Error();
      const raw = snapshot(await stage(() => readCompletionPort!(completionKey, signal)));
      if (raw === null) return { state: "absent" } as const;
      const saved = completion(raw, retained, completionKey);
      if (signal.aborted) return { state: "cancelled" } as const;
      const receipt = snapshot(await stage(() => status(windowKey, requestKey, signal)));
      if (!exact(receipt, ["status", "windowKey", "fence", "generation", "owner", "observationRevision", "deadline"])
        || !["replay", "expired", "completed"].includes(receipt.status as string) || receipt.windowKey !== windowKey || receipt.owner !== requestKey
        || receipt.fence !== saved.fence || receipt.generation !== 1 || !Number.isSafeInteger(receipt.observationRevision)
        || (receipt.observationRevision as number) <= 0 || !Number.isFinite(canaryFencedTime(receipt.deadline)) || signal.aborted) throw Error();
      if (!withinBudget(signal, deadlineMs)) return { state: "cancelled" } as const;
      try {
        // The canonical transport validates the full candidate before its single RPC; backend owns reservation/disposal and exact replay checks.
        const reply = snapshot(await stage(() => { dispatched = true; return complete(saved, signal); }));
        if (!signal.aborted && exact(reply, ["status", "windowKey", "observationRevision"]) && reply.status === "completed"
          && reply.windowKey === windowKey && reply.observationRevision === receipt.observationRevision) return { state: "recorded_attention_pending" } as const;
      } catch { /* A dispatched reply loss never permits an automatic resend. */ }
      return { state: dispatched ? "uncertain" : "cancelled" } as const;
    });
    return dispatched && result.state === "cancelled" ? { state: "uncertain" } as const : result;
  }
  return { listClaims, listAttention, readClaim, readCompletion, readAttention, reconcileClaim, replayAttention, replayCompletion };
}
