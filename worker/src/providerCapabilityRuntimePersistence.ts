import type { SupabaseClient } from "@supabase/supabase-js";
import type { CapabilityRecordInput } from "./providerUploadCapabilityPersistence.js";
import type { CapabilityAttentionEvidence, CapabilityAttentionResult } from "./providerCapabilityAttention.js";

type Projection = Extract<CapabilityAttentionResult, { state: "projected" }>;
export type CapabilityWindowClaim = {
  windowKey: string; resourceKey: string; configDigest: string; requestKey: string;
  provider: string; route: string; surface: string; surfaceRevision: string;
  windowStart: string; windowEnd: string; leaseSeconds: number;
};
export type CapabilityWindowReceipt = {
  status: "claimed" | "replay" | "expired" | "completed";
  windowKey: string; fence: string; generation: 1; owner: string;
  observationRevision: number; deadline: string;
};
export type CapabilityWindowCompletion = {
  windowKey: string; requestKey: string; fence: string; completionKey: string;
  resourceReleased: true; candidate: Omit<CapabilityRecordInput, "observationRevision">;
};
export type CapabilityAttentionCommit = {
  expectedVersion: number; evaluationKey: string; cursor: Projection["cursor"];
  item: Projection["item"]; intent: Projection["intent"]; evidence: CapabilityAttentionEvidence | null;
};
export type CapabilityAttentionSnapshot = Pick<CapabilityAttentionCommit, "cursor" | "item" | "evidence"> & { version: number };
export type PersistenceResult<T> = { ok: true; value: T } | { ok: false; reasonCode: "invalid_input" | "rpc_denied" | "invalid_response" | "transport_error" };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WINDOW = /^canary:[a-f0-9]{64}$/;
const SLUG = /^[a-z][a-z0-9._-]{0,79}$/;
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === "string" && pattern.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return object(v) && Reflect.ownKeys(v).length === keys.length && keys.every((k) => {
    const d = Object.getOwnPropertyDescriptor(v, k); return d !== undefined && "value" in d && d.enumerable;
  });
}
/** Reject accessors, cycles, non-JSON values and excessive depth before serialization. */
function bounded(v: unknown, depth = 0, seen = new Set<object>(), budget = { remaining: 20000 }): boolean {
  if (--budget.remaining < 0 || depth > 8) return false;
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length <= 512;
  if ((!object(v) && !Array.isArray(v)) || seen.has(v as object)) return false;
  if ("toJSON" in (v as object)) return false;
  if (Array.isArray(v) && (Object.getPrototypeOf(v) !== Array.prototype || v.length > 100 || Object.keys(v).length !== v.length
    || !Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean)
    || Reflect.ownKeys(v).some(k => k !== "length" && (typeof k !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(k))))) return false;
  seen.add(v as object);
  const keys = Reflect.ownKeys(v as object);
  if (keys.length > (Array.isArray(v) ? 101 : 40)) return false;
  const result = keys.every((k) => {
    if (Array.isArray(v) && k === "length") return true;
    const d = Object.getOwnPropertyDescriptor(v, k);
    return typeof k === "string" && d !== undefined && "value" in d && d.enumerable && bounded(d.value, depth + 1, seen, budget);
  });
  seen.delete(v as object); return result;
}
function date(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+]00:00)$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString().slice(0, 19) === v.slice(0, 19);
}
const reasons = new Set(["matches_policy", "format_added", "format_removed", "reviewed_missing_accept_xometry", "accept_missing", "unsupported", "denied", "observation_missing", "observation_stale", "formats_loading", "ambiguous_input", "route_or_selector_drift", "authentication_required", "anti_bot_or_challenge", "provider_error", "unclassified_response", "source_malformed"]);
function tokens(v: unknown, pattern: RegExp): boolean { return Array.isArray(v) && v.length <= 32 && v.every((x) => matches(x, pattern)); }
function evidence(v: unknown): boolean {
  if (v === null) return true;
  if (!exact(v, ["decision", "observedAt", "expiresAt", "observationRevision"]) || !date(v.observedAt) || !date(v.expiresAt) || !integer(v.observationRevision)) return false;
  const d = v.decision;
  return exact(d, ["contractVersion", "classification", "allowedExtensions", "reportedAddedExtensions", "reportedRemovedExtensions", "evidenceRefs", "normalizedObservedMimeTypes"])
    && d.contractVersion === "provider-upload-capability.v1" && reasons.has(d.classification as string)
    && [d.allowedExtensions, d.reportedAddedExtensions, d.reportedRemovedExtensions].every((x) => tokens(x, /^[a-z0-9][a-z0-9_-]{0,31}$/))
    && tokens(d.evidenceRefs, /^issue:OVD-[1-9]\d{0,9}$/) && tokens(d.normalizedObservedMimeTypes, /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/);
}
function projection(cursor: unknown, item: unknown): boolean {
  if (!exact(cursor, ["scopeKey", "fingerprint", "generation", "lastObservationRevision", "lastObservedAt", "lastEvidenceHash", "evaluatedAt"]) || !matches(cursor.scopeKey, HASH) || !matches(cursor.fingerprint, HASH)
    || !Number.isSafeInteger(cursor.generation) || (cursor.generation as number) < 0 || (cursor.generation as number) > 1000000 || !date(cursor.evaluatedAt)
    || !(cursor.lastObservationRevision === null ? cursor.lastObservedAt === null && cursor.lastEvidenceHash === null : integer(cursor.lastObservationRevision) && date(cursor.lastObservedAt) && matches(cursor.lastEvidenceHash, HASH))) return false;
  if (!exact(item, ["key", "category", "metadata", "severity", "reasonCode", "summary", "freshness", "observedAt", "expiresAt", "checkedAt", "formatCounts", "occurrenceCount", "firstSeenAt", "lastChangedAt", "action"])) return false;
  const m = item.metadata;
  return exact(m, ["provider", "route", "surface", "surfaceRevision", "policyRevision", "adapterRevision", "workerBuild"])
    && Object.entries(m).every(([k, v]) => ((k === "adapterRevision" || k === "workerBuild") && v === null) || (typeof v === "string" && matches(v, SLUG)))
    && item.key === `capability:${cursor.scopeKey}` && item.category === "provider_upload_capability" && ["healthy", "attention", "blocked", "unknown"].includes(item.severity as string)
    && reasons.has(item.reasonCode as string) && ["current", "stale", "unknown"].includes(item.freshness as string)
    && ["Upload capability matches the reviewed policy.", "Observed upload formats changed and require review.", "Upload capability requires operator review.", "Upload capability evidence is stale.", "Upload capability evidence is missing or invalid."].includes(item.summary as string)
    && (item.observedAt === null || date(item.observedAt)) && (item.expiresAt === null || date(item.expiresAt)) && item.checkedAt === cursor.evaluatedAt
    && [item.action, item.occurrenceCount, item.firstSeenAt, item.lastChangedAt].every((x) => x === null)
    && (item.formatCounts === null || (exact(item.formatCounts, ["allowed", "added", "removed"]) && Object.values(item.formatCounts).every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 32)));
}
function candidate(v: unknown): boolean {
  return exact(v, ["provider", "route", "surface", "revision", "state", "extensions", "mimeTypes", "acceptAttributePresent", "observedAt", "expiresAt", "actorKind", "sourceKind", "sourceVersion", "evidenceReference", "idempotencyKey"])
    && [v.provider, v.route, v.surface, v.revision, v.sourceVersion].every((x) => typeof x === "string" && matches(x, SLUG))
    && ["fresh", "loading", "route_or_selector_drift", "authentication_required", "anti_bot_or_challenge", "provider_error", "unclassified_response", "ambiguous"].includes(v.state as string)
    && tokens(v.extensions, /^[a-z0-9][a-z0-9_-]{0,31}$/) && tokens(v.mimeTypes, /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/)
    && (v.acceptAttributePresent === null || typeof v.acceptAttributePresent === "boolean") && date(v.observedAt) && date(v.expiresAt)
    && v.actorKind === "scheduled_canary" && v.sourceKind === "scheduled_canary" && matches(v.evidenceReference, /^issue:OVD-[1-9]\d{0,9}$/) && matches(v.idempotencyKey, WINDOW);
}
function receipt(v: unknown, windowKey: string, owner: string, allowClaimed: boolean): v is CapabilityWindowReceipt {
  if (!exact(v, ["status", "windowKey", "fence", "generation", "owner", "observationRevision", "deadline"])) return false;
  return ["replay", "expired", "completed", ...(allowClaimed ? ["claimed"] : [])].includes(v.status as string)
    && v.windowKey === windowKey && v.owner === owner && matches(v.fence, UUID)
    && v.generation === 1 && integer(v.observationRevision) && date(v.deadline);
}
async function call<T>(client: SupabaseClient, name: string, args: Record<string, unknown>, valid: boolean, parse: (v: unknown) => v is T): Promise<PersistenceResult<T>> {
  if (!valid || !bounded(args)) return { ok: false, reasonCode: "invalid_input" };
  const serialized = JSON.stringify(args);
  if (serialized.length > 16384) return { ok: false, reasonCode: "invalid_input" };
  // Detach before the SDK thenable can serialize or the caller can mutate input.
  const request = JSON.parse(serialized) as Record<string, unknown>;
  try {
    const { data, error } = await client.rpc(name, request);
    if (error) return { ok: false, reasonCode: "rpc_denied" };
    if (!bounded(data) || JSON.stringify(data).length > 1048576 || !parse(data)) return { ok: false, reasonCode: "invalid_response" };
    return { ok: true, value: data };
  } catch { return { ok: false, reasonCode: "transport_error" }; }
}
/** Only a newly returned claimed result permits the owner's single probe. Never retry a probe on reply loss. */
export function claimCapabilityWindow(client: SupabaseClient, input: CapabilityWindowClaim) {
  const valid = bounded(input) && exact(input, ["windowKey", "resourceKey", "configDigest", "requestKey", "provider", "route", "surface", "surfaceRevision", "windowStart", "windowEnd", "leaseSeconds"])
    && matches(input.windowKey, WINDOW) && matches(input.resourceKey, HASH) && matches(input.configDigest, HASH) && matches(input.requestKey, UUID)
    && [input.provider, input.route, input.surface, input.surfaceRevision].every((v) => matches(v, SLUG))
    && date(input.windowStart) && date(input.windowEnd) && integer(input.leaseSeconds) && input.leaseSeconds <= 300;
  const windowKey = valid ? input.windowKey : "";
  const requestKey = valid ? input.requestKey : "";
  return call<CapabilityWindowReceipt | { status: "busy" }>(client, "api_claim_capability_window", { p_input: input }, valid,
    (v): v is CapabilityWindowReceipt | { status: "busy" } => receipt(v, windowKey, requestKey, true) || (exact(v, ["status"]) && v.status === "busy"));
}
export function getCapabilityWindow(client: SupabaseClient, windowKey: string, requestKey: string) {
  return call<CapabilityWindowReceipt | { status: "unknown" }>(client, "api_get_capability_window", { p_window_key: windowKey, p_request_key: requestKey }, matches(windowKey, WINDOW) && matches(requestKey, UUID),
    (v): v is CapabilityWindowReceipt | { status: "unknown" } => receipt(v, windowKey, requestKey, false) || (exact(v, ["status"]) && v.status === "unknown"));
}
export function completeCapabilityWindow(client: SupabaseClient, input: CapabilityWindowCompletion) {
  const valid = bounded(input) && exact(input, ["windowKey", "requestKey", "fence", "completionKey", "resourceReleased", "candidate"])
    && matches(input.windowKey, WINDOW) && matches(input.requestKey, UUID) && matches(input.fence, UUID) && matches(input.completionKey, UUID)
    && input.resourceReleased === true && candidate(input.candidate) && input.candidate.idempotencyKey === input.windowKey;
  const windowKey = valid ? input.windowKey : "";
  return call<{ status: "completed"; windowKey: string; observationRevision: number }>(client, "api_complete_capability_window", { p_input: input }, valid,
    (v): v is { status: "completed"; windowKey: string; observationRevision: number } => exact(v, ["status", "windowKey", "observationRevision"]) && v.status === "completed" && v.windowKey === windowKey && integer(v.observationRevision));
}
export function commitCapabilityAttention(client: SupabaseClient, input: CapabilityAttentionCommit) {
  const valid = bounded(input) && exact(input, ["expectedVersion", "evaluationKey", "cursor", "item", "intent", "evidence"])
    && Number.isSafeInteger(input.expectedVersion) && input.expectedVersion >= 0 && input.expectedVersion < Number.MAX_SAFE_INTEGER && matches(input.evaluationKey, UUID) && projection(input.cursor, input.item) && evidence(input.evidence)
    && (input.intent === null || (exact(input.intent, ["key", "itemKey", "generation", "kind", "reasonCode"]) && matches(input.intent.key, HASH) && input.intent.itemKey === input.item.key && input.intent.generation === input.cursor.generation && ["attention", "recovery"].includes(input.intent.kind) && input.intent.reasonCode === input.item.reasonCode));
  const expectedVersion = valid ? input.expectedVersion : -1;
  return call<{ status: "committed"; version: number } | { status: "conflict" }>(client, "api_commit_capability_attention", { p_input: input }, valid,
    (v): v is { status: "committed"; version: number } | { status: "conflict" } => (exact(v, ["status"]) && v.status === "conflict") || (exact(v, ["status", "version"]) && v.status === "committed" && v.version === expectedVersion + 1));
}
function snapshot(v: unknown): v is CapabilityAttentionSnapshot {
  return exact(v, ["version", "cursor", "item", "evidence"]) && integer(v.version)
    && projection(v.cursor, v.item) && evidence(v.evidence);
}
export function readCapabilityAttention(client: SupabaseClient, scopeKey: string) {
  return call<CapabilityAttentionSnapshot | null>(client, "api_read_capability_attention", { p_scope_key: scopeKey }, matches(scopeKey, HASH),
    (v): v is CapabilityAttentionSnapshot | null => v === null || (snapshot(v) && v.cursor.scopeKey === scopeKey));
}
export function listDueCapabilityAttention(client: SupabaseClient, limit: number) {
  return call<CapabilityAttentionSnapshot[]>(client, "api_list_due_capability_attention", { p_limit: limit }, integer(limit) && limit <= 100,
    (v): v is CapabilityAttentionSnapshot[] => Array.isArray(v) && v.length <= limit && v.every(snapshot));
}
