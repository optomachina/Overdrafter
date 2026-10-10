import { CANARY_PLANNING_POLICY } from "./providerCapabilityCanary.js";
import type { CapabilityRecordInput } from "./providerUploadCapabilityPersistence.js";

export type CanaryFencedRequest = {
  windowKey: string; resourceKey: string; configDigest: string; requestKey: string;
  provider: string; route: string; surface: string; surfaceRevision: string;
  windowStart: string; windowEnd: string; leaseSeconds: number;
};
export type CanaryFencedClaim = {
  status: "claimed" | "replay" | "expired" | "completed";
  windowKey: string; fence: string; generation: 1; owner: string;
  observationRevision: number; deadline: string;
};
export type CanaryFencedCandidate = Omit<CapabilityRecordInput, "observationRevision">;
export type CanaryFencedCompletion = {
  windowKey: string; requestKey: string; fence: string; completionKey: string;
  resourceReleased: true; candidate: CanaryFencedCandidate;
};
/** Release-owned transport only. No client, credentials, retry or RPC implementation here. */
export type CanaryFencedTransport = {
  claim(args: { p_input: CanaryFencedRequest }, signal: AbortSignal): Promise<unknown>;
  get(args: { p_window_key: string; p_request_key: string }, signal: AbortSignal): Promise<unknown>;
  complete(args: { p_input: CanaryFencedCompletion }, signal: AbortSignal): Promise<unknown>;
};
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const slug = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(v);
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype
    && Reflect.ownKeys(v).length === keys.length && keys.every(k => {
      const d = Object.getOwnPropertyDescriptor(v, k); return d && "value" in d && d.enumerable;
    });
}
function canonicalTime(v: unknown): number {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return NaN;
  const n = Date.parse(v); return Number.isFinite(n) && new Date(n).toISOString() === v ? n : NaN;
}
/** UTC persistence deadlines may carry microseconds; never round authority upward. */
function deadlineParts(v: unknown): { milliseconds: number; remainder: number } | null {
  if (typeof v !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(v);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const milliseconds = canonicalTime(`${match[1]}.${fraction.slice(0, 3)}Z`);
  return Number.isFinite(milliseconds) ? { milliseconds, remainder: Number(fraction.slice(3)) } : null;
}
/** Runtime clock precision is milliseconds: flooring may stop slightly early, never late. */
export function canaryFencedTime(v: unknown): number {
  return deadlineParts(v)?.milliseconds ?? NaN;
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function tokens(v: unknown, pattern: RegExp): boolean {
  return Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length <= 32
    && Reflect.ownKeys(v).length === v.length + 1 && Array.from({ length: v.length }, (_, i) => Object.getOwnPropertyDescriptor(v, String(i))).every(d => d && "value" in d && d.enumerable)
    && v.every((x, i) => typeof x === "string" && pattern.test(x) && (i === 0 || v[i - 1] < x));
}
/** One retained attempt. Recovery data is private service data, never an admin/public outcome. */
export function createCanaryFencedAttempt(input: { transport: CanaryFencedTransport; request: CanaryFencedRequest; completionKey: string }) {
  const r = input.request;
  const valid = exact(r, ["windowKey", "resourceKey", "configDigest", "requestKey", "provider", "route", "surface", "surfaceRevision", "windowStart", "windowEnd", "leaseSeconds"])
    && /^canary:[a-f0-9]{64}$/.test(r.windowKey) && hash(r.resourceKey) && hash(r.configDigest) && uuid(r.requestKey) && uuid(input.completionKey)
    && [r.provider, r.route, r.surface, r.surfaceRevision].every(slug)
    && canonicalTime(r.windowEnd) > canonicalTime(r.windowStart)
    && Number.isInteger(r.leaseSeconds) && r.leaseSeconds >= 1 && r.leaseSeconds <= 300;
  // Capture identities before the first asynchronous boundary.
  const request = valid ? freeze(structuredClone(r)) : null;
  const completionKey = input.completionKey;
  const transport = { ...input.transport };
  let claim: CanaryFencedClaim | null = null;
  let completion: CanaryFencedCompletion | null = null;
  let invoked = false;
  let recoveryOnly = false; // Terminal local authority fence; status never resumes execution.
  let completedInvoked = false;
  const clock = (n: number) => Number.isSafeInteger(n) && Math.abs(n) <= 8640000000000000;
  const active = (n: number) => request && clock(n) && n >= canonicalTime(request.windowStart) && n < canonicalTime(request.windowEnd);
  function receipt(v: unknown): v is CanaryFencedClaim {
    const deadline = exact(v, ["status", "windowKey", "fence", "generation", "owner", "observationRevision", "deadline"]) ? deadlineParts(v.deadline) : null;
    return !!request && exact(v, ["status", "windowKey", "fence", "generation", "owner", "observationRevision", "deadline"])
      && ["claimed", "replay", "expired", "completed"].includes(v.status as string)
      && v.windowKey === request.windowKey && v.owner === request.requestKey && uuid(v.fence) && v.generation === 1
      && Number.isSafeInteger(v.observationRevision) && (v.observationRevision as number) > 0
      // Lease starts at the service clock after lock acquisition, not at client dispatch.
      // The local runtime budget is independently bounded from its original start.
      && deadline !== null && deadline.milliseconds > canonicalTime(request.windowStart)
      && (deadline.milliseconds < canonicalTime(request.windowEnd)
        || (deadline.milliseconds === canonicalTime(request.windowEnd) && deadline.remainder === 0))
      && (!claim || (v.fence === claim.fence && v.observationRevision === claim.observationRevision && v.deadline === claim.deadline));
  }
  async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let rejectAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => { controller.abort(); reject(Error("uncertain")); }; });
    const timer = setTimeout(rejectAbort, 5000);
    signal.addEventListener("abort", rejectAbort, { once: true });
    try {
      if (signal.aborted) throw Error("aborted");
      return await Promise.race([action(controller.signal), aborted]);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", rejectAbort); }
  }
  return {
    async claim(nowMs: number, signal: AbortSignal): Promise<{state: "claimed"; claim: CanaryFencedClaim} | {state: "rejected" | "uncertain" | "not_authorized"}> {
      if (!request || !active(nowMs) || nowMs + request.leaseSeconds * 1000 > canonicalTime(request.windowEnd) || invoked || signal.aborted) return { state: "rejected" };
      invoked = true;
      try {
        const response = await bounded(s => transport.claim({ p_input: request }, s), signal);
        if (signal.aborted) return { state: "uncertain" };
        if (recoveryOnly) return { state: "not_authorized" };
        if (exact(response, ["status"]) && response.status === "busy") return { state: "not_authorized" };
        if (!receipt(response)) return { state: "uncertain" };
        if (response.status !== "claimed") return { state: "not_authorized" };
        if (canaryFencedTime(response.deadline) <= nowMs) return { state: "rejected" };
        claim = freeze(structuredClone(response));
        return { state: "claimed", claim };
      } catch { return { state: "uncertain" }; }
    },
    async reconcile(nowMs: number, signal: AbortSignal): Promise<{state: "completion_known" | "not_authorized" | "rejected" | "uncertain"}> {
      recoveryOnly = true;
      invoked = true;
      if (!request || !clock(nowMs) || signal.aborted) return { state: "rejected" };
      // A status/recovery attempt can never later become an executable attempt.
      try {
        const response = await bounded(s => transport.get({ p_window_key: request.windowKey, p_request_key: request.requestKey }, s), signal);
        if (signal.aborted) return { state: "uncertain" };
        if (exact(response, ["status"]) && response.status === "unknown") return { state: "not_authorized" };
        if (!receipt(response) || response.status === "claimed") return { state: "rejected" };
        return { state: response.status === "completed" ? "completion_known" : "not_authorized" };
      } catch { return { state: "uncertain" }; }
    },
    prepareCompletion(candidate: CanaryFencedCandidate, resourceReleased: true): boolean {
      if (!request || !claim || resourceReleased !== true || completedInvoked) return false;
      if (!exact(candidate, ["provider", "route", "surface", "revision", "state", "extensions", "mimeTypes", "acceptAttributePresent", "observedAt", "expiresAt", "actorKind", "sourceKind", "sourceVersion", "evidenceReference", "idempotencyKey"])) return false;
      const c = candidate;
      if (c.provider !== request.provider || c.route !== request.route || c.surface !== request.surface || c.revision !== request.surfaceRevision
        || c.idempotencyKey !== request.windowKey || c.actorKind !== "scheduled_canary" || c.sourceKind !== "scheduled_canary"
        || c.sourceVersion !== CANARY_PLANNING_POLICY || c.evidenceReference !== "issue:OVD-415"
        || !["fresh", "loading", "ambiguous", "route_or_selector_drift", "authentication_required", "anti_bot_or_challenge", "provider_error", "unclassified_response"].includes(c.state)
        || !tokens(c.extensions, /^[a-z0-9][a-z0-9_-]{0,31}$/) || !tokens(c.mimeTypes, /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/)
        || !(canonicalTime(c.observedAt) >= canonicalTime(request.windowStart))
        || !(canonicalTime(c.expiresAt) > canonicalTime(c.observedAt)) || canonicalTime(c.expiresAt) > canonicalTime(request.windowEnd)
        || canonicalTime(c.expiresAt) - canonicalTime(c.observedAt) > 3600000
        || (c.state === "fresh" ? typeof c.acceptAttributePresent !== "boolean" : c.acceptAttributePresent !== null || c.extensions.length !== 0 || c.mimeTypes.length !== 0)) return false;
      const value = { windowKey: request.windowKey, requestKey: request.requestKey, fence: claim.fence, completionKey, resourceReleased, candidate: c };
      if (completion) return JSON.stringify(completion) === JSON.stringify(value);
      completion = freeze(structuredClone(value)); return true;
    },
    async complete(nowMs: number, signal: AbortSignal): Promise<{state: "completed"; observationRevision: number} | {state: "rejected" | "uncertain"}> {
      if (recoveryOnly || !request || !claim || !completion || completedInvoked || !active(nowMs) || nowMs >= canaryFencedTime(claim.deadline)
        || canonicalTime(completion.candidate.observedAt) > nowMs || canonicalTime(completion.candidate.expiresAt) <= nowMs || signal.aborted) return { state: "rejected" };
      completedInvoked = true;
      try {
        const response = await bounded(s => transport.complete({ p_input: completion! }, s), signal);
        if (signal.aborted || !exact(response, ["status", "windowKey", "observationRevision"]) || response.status !== "completed"
          || response.windowKey !== request.windowKey || response.observationRevision !== claim.observationRevision) return { state: "uncertain" };
        return { state: "completed", observationRevision: claim.observationRevision };
      } catch { return { state: "uncertain" }; }
    },
    canExecuteClaim() { return claim !== null && !recoveryOnly; },
    recovery() { return freeze({ request, completionKey, claim, completion }); },
  };
}
export type CanaryFencedAttempt = ReturnType<typeof createCanaryFencedAttempt>;
