import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { CapabilityWindowClaim, CapabilityWindowCompletion, CapabilityAttentionCommit, PersistenceResult } from "./providerCapabilityRuntimePersistence.js";

export type PreparedClaim = { request: CapabilityWindowClaim; completionKey: string };
export type PreparationAck<T> = { state: "created" | "existing"; retained: T };
export type PreparationCursor = string;
export type PreparedAttentionEntry = { cursor: PreparationCursor; input: CapabilityAttentionCommit };
export type PreparedAttentionPage = { entries: PreparedAttentionEntry[]; nextCursor: PreparationCursor | null; hasMore: boolean };
export type PreparedClaimEntry = { cursor: PreparationCursor; input: PreparedClaim };
export type PreparedClaimPage = { entries: PreparedClaimEntry[]; nextCursor: PreparationCursor | null; hasMore: boolean };

// Canonical sanitized schemas mirror providerCapabilityRuntimePersistence's private
// validators. Cross-checks cover compatibility; neither helper changes SQL authority.
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WINDOW = /^canary:[a-f0-9]{64}$/;
const SLUG = /^[a-z][a-z0-9._-]{0,79}$/;
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
function bounded(v: unknown, depth = 0, seen = new Set<object>(), budget = { remaining: 50000 }): boolean {
  if (--budget.remaining < 0 || depth > 12) return false;
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length <= 512;
  if ((!object(v) && !Array.isArray(v)) || seen.has(v as object)) return false;
  // JSON.stringify consults inherited toJSON before traversing data. Inspect
  // descriptors without reading hooks, and admit only the standard array proto.
  if (Array.isArray(v) && Object.getPrototypeOf(v) !== Array.prototype) return false;
  if ([v, Object.prototype, ...(Array.isArray(v) ? [Array.prototype] : [])]
    .some(value => Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined)) return false;
  if (Array.isArray(v) && (v.length > 100 || Object.keys(v).length !== v.length
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
function tokens(v: unknown, pattern: RegExp): boolean { return Array.isArray(v) && v.length <= 32 && v.every((x) => typeof x === "string" && pattern.test(x)); }
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
    && Object.entries(m).every(([k, v]) => ((k === "adapterRevision" || k === "workerBuild") && v === null) || (typeof v === "string" && SLUG.test(v)))
    && item.key === `capability:${cursor.scopeKey}` && item.category === "provider_upload_capability" && ["healthy", "attention", "blocked", "unknown"].includes(item.severity as string)
    && reasons.has(item.reasonCode as string) && ["current", "stale", "unknown"].includes(item.freshness as string)
    && ["Upload capability matches the reviewed policy.", "Observed upload formats changed and require review.", "Upload capability requires operator review.", "Upload capability evidence is stale.", "Upload capability evidence is missing or invalid."].includes(item.summary as string)
    && (item.observedAt === null || date(item.observedAt)) && (item.expiresAt === null || date(item.expiresAt)) && item.checkedAt === cursor.evaluatedAt
    && [item.action, item.occurrenceCount, item.firstSeenAt, item.lastChangedAt].every((x) => x === null)
    && (item.formatCounts === null || (exact(item.formatCounts, ["allowed", "added", "removed"]) && Object.values(item.formatCounts).every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 32)));
}
function candidate(v: unknown): boolean {
  return exact(v, ["provider", "route", "surface", "revision", "state", "extensions", "mimeTypes", "acceptAttributePresent", "observedAt", "expiresAt", "actorKind", "sourceKind", "sourceVersion", "evidenceReference", "idempotencyKey"])
    && [v.provider, v.route, v.surface, v.revision, v.sourceVersion].every((x) => typeof x === "string" && SLUG.test(x))
    && ["fresh", "loading", "route_or_selector_drift", "authentication_required", "anti_bot_or_challenge", "provider_error", "unclassified_response", "ambiguous"].includes(v.state as string)
    && tokens(v.extensions, /^[a-z0-9][a-z0-9_-]{0,31}$/) && tokens(v.mimeTypes, /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/)
    && (v.acceptAttributePresent === null || typeof v.acceptAttributePresent === "boolean") && date(v.observedAt) && date(v.expiresAt)
    && v.actorKind === "scheduled_canary" && v.sourceKind === "scheduled_canary" && matches(v.evidenceReference, /^issue:OVD-[1-9]\d{0,9}$/) && matches(v.idempotencyKey, WINDOW);
}
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function claim(value: unknown): value is CapabilityWindowClaim {
  return exact(value, ["windowKey", "resourceKey", "configDigest", "requestKey", "provider", "route", "surface", "surfaceRevision", "windowStart", "windowEnd", "leaseSeconds"])
    && matches(value.windowKey, WINDOW) && matches(value.resourceKey, HASH) && matches(value.configDigest, HASH) && matches(value.requestKey, UUID)
    && [value.provider, value.route, value.surface, value.surfaceRevision].every(v => matches(v, SLUG))
    && date(value.windowStart) && date(value.windowEnd) && integer(value.leaseSeconds) && value.leaseSeconds <= 300;
}
function completion(value: unknown): value is CapabilityWindowCompletion {
  return exact(value, ["windowKey", "requestKey", "fence", "completionKey", "resourceReleased", "candidate"])
    && matches(value.windowKey, WINDOW) && matches(value.requestKey, UUID) && matches(value.fence, UUID) && matches(value.completionKey, UUID)
    && value.resourceReleased === true && candidate(value.candidate) && (value.candidate as Record<string, unknown>).idempotencyKey === value.windowKey;
}
function attention(value: unknown): value is CapabilityAttentionCommit {
  if (!exact(value, ["expectedVersion", "evaluationKey", "cursor", "item", "intent", "evidence"])
    || !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0 || (value.expectedVersion as number) >= Number.MAX_SAFE_INTEGER
    || !matches(value.evaluationKey, UUID) || !projection(value.cursor, value.item) || !evidence(value.evidence)) return false;
  const c = value.cursor as CapabilityAttentionCommit["cursor"], i = value.item as CapabilityAttentionCommit["item"];
  const m = i.metadata;
  const scope = createHash("sha256").update(JSON.stringify({ provider: m.provider, route: m.route, surface: m.surface, surfaceRevision: m.surfaceRevision,
    policyRevision: m.policyRevision, adapterRevision: m.adapterRevision, workerBuild: m.workerBuild })).digest("hex");
  return c.scopeKey === scope && (value.intent === null || (exact(value.intent, ["key", "itemKey", "generation", "kind", "reasonCode"])
    && matches(value.intent.key, HASH) && value.intent.itemKey === i.key && value.intent.generation === c.generation
    && ["attention", "recovery"].includes(value.intent.kind as string) && value.intent.reasonCode === i.reasonCode));
}
function claimEntry(v: unknown): v is PreparedClaim {
  return exact(v, ["request", "completionKey"]) && claim(v.request) && matches(v.completionKey, UUID) && size(v) <= 16384;
}
function completionEntry(v: unknown): v is CapabilityWindowCompletion { return completion(v) && size(v) <= 16384; }
function attentionEntry(v: unknown): v is CapabilityAttentionCommit { return attention(v) && size(v) <= 16384; }
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((v, i) => same(v, right[i]));
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}
function cursor(v: unknown): v is string { return typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n; }
async function call<T>(client: SupabaseClient, rpc: string, input: Record<string, unknown>, valid: (args: Record<string, unknown>) => boolean,
  parse: (value: unknown, args: Record<string, unknown>) => value is T, wire: (args: Record<string, unknown>) => Record<string, unknown> = args => args): Promise<PersistenceResult<T>> {
  let args: Record<string, unknown>;
  try {
    if (!bounded(input) || !valid(input)) return { ok: false, reasonCode: "invalid_input" };
    // Freeze the dispatched semantic value for response binding across an await.
    args = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  } catch { return { ok: false, reasonCode: "invalid_input" }; }
  let response;
  try { response = await client.rpc(rpc, wire(args)); }
  catch { return { ok: false, reasonCode: "transport_error" }; }
  try {
    if (!object(response)) return { ok: false, reasonCode: "invalid_response" };
    const dataField = Object.getOwnPropertyDescriptor(response, "data"), errorField = Object.getOwnPropertyDescriptor(response, "error");
    if (!dataField || !("value" in dataField) || !errorField || !("value" in errorField)) return { ok: false, reasonCode: "invalid_response" };
    if (errorField.value) return { ok: false, reasonCode: "rpc_denied" };
    const data: unknown = dataField.value;
    if (!bounded(data) || size(data) > 2000000 || !parse(data, args)) return { ok: false, reasonCode: "invalid_response" };
    return { ok: true, value: data };
  } catch { return { ok: false, reasonCode: "invalid_response" }; }
}
function prepare<T>(client: SupabaseClient, name: string, input: T, validate: (v: unknown) => v is T) {
  return call<PreparationAck<T>>(client, name, { p_input: input }, args => validate(args.p_input),
    (value, args): value is PreparationAck<T> => exact(value, ["state", "retained"]) && ["created", "existing"].includes(value.state as string)
      && validate(value.retained) && same(value.retained, args.p_input));
}
/** Existing/read/uncertain replies never recreate authority to probe. */
export function prepareCapabilityClaim(client: SupabaseClient, input: PreparedClaim) {
  return prepare(client, "api_prepare_capability_claim", input, claimEntry);
}
export function readPreparedCapabilityClaim(client: SupabaseClient, requestKey: string) {
  return call<PreparedClaim | null>(client, "api_read_prepared_capability_claim", { p_request_key: requestKey }, args => matches(args.p_request_key, UUID),
    (value, args): value is PreparedClaim | null => value === null || claimEntry(value) && value.request.requestKey === args.p_request_key);
}
export function prepareCapabilityCompletion(client: SupabaseClient, input: CapabilityWindowCompletion) {
  return prepare(client, "api_prepare_capability_completion", input, completionEntry);
}
export function readPreparedCapabilityCompletion(client: SupabaseClient, completionKey: string) {
  return call<CapabilityWindowCompletion | null>(client, "api_read_prepared_capability_completion", { p_completion_key: completionKey }, args => matches(args.p_completion_key, UUID),
    (value, args): value is CapabilityWindowCompletion | null => value === null || completionEntry(value) && value.completionKey === args.p_completion_key);
}
export function prepareCapabilityAttention(client: SupabaseClient, input: CapabilityAttentionCommit) {
  return prepare(client, "api_prepare_capability_attention", input, attentionEntry);
}
export function readPreparedCapabilityAttention(client: SupabaseClient, evaluationKey: string) {
  return call<CapabilityAttentionCommit | null>(client, "api_read_prepared_capability_attention", { p_evaluation_key: evaluationKey }, args => matches(args.p_evaluation_key, UUID),
    (value, args): value is CapabilityAttentionCommit | null => value === null || attentionEntry(value) && value.evaluationKey === args.p_evaluation_key);
}
function page<T>(value: unknown, after: unknown, limit: number, validate: (v: unknown) => v is T, identity: (v: T) => string): value is { entries: Array<{ cursor: string; input: T }>; nextCursor: string | null; hasMore: boolean } {
  if (!exact(value, ["entries", "nextCursor", "hasMore"]) || !Array.isArray(value.entries) || value.entries.length > limit
    || typeof value.hasMore !== "boolean" || value.hasMore && value.entries.length !== limit) return false;
  let previous = after === null ? 0n : BigInt(after as string);
  const seen = new Set<string>();
  for (const row of value.entries) {
    if (!exact(row, ["cursor", "input"]) || !cursor(row.cursor) || BigInt(row.cursor) <= previous || !validate(row.input)) return false;
    const key = identity(row.input);
    if (seen.has(key)) return false;
    previous = BigInt(row.cursor); seen.add(key);
  }
  return value.nextCursor === (value.entries.length ? value.entries.at(-1).cursor : null);
}
export function listPreparedCapabilityAttention(client: SupabaseClient, input: { scopeKey: string; afterCursor: string | null; limit: number }) {
  return call<PreparedAttentionPage>(client, "api_list_prepared_capability_attention", input,
    args => exact(args, ["scopeKey", "afterCursor", "limit"]) && matches(args.scopeKey, HASH) && (args.afterCursor === null || cursor(args.afterCursor)) && integer(args.limit) && args.limit <= 100,
    (value, args): value is PreparedAttentionPage => page(value, args.afterCursor, args.limit as number,
      (v): v is CapabilityAttentionCommit => attentionEntry(v) && v.cursor.scopeKey === args.scopeKey, v => v.evaluationKey),
    args => ({ p_scope_key: args.scopeKey, p_after_cursor: args.afterCursor, p_limit: args.limit }));
}
export function listPreparedCapabilityClaims(client: SupabaseClient, input: { windowKey: string; afterCursor: string | null; limit: number }) {
  return call<PreparedClaimPage>(client, "api_list_prepared_capability_claims", input,
    args => exact(args, ["windowKey", "afterCursor", "limit"]) && matches(args.windowKey, WINDOW) && (args.afterCursor === null || cursor(args.afterCursor)) && integer(args.limit) && args.limit <= 100,
    (value, args): value is PreparedClaimPage => page(value, args.afterCursor, args.limit as number,
      (v): v is PreparedClaim => claimEntry(v) && v.request.windowKey === args.windowKey, v => v.request.requestKey)
      && new Set(value.entries.map(row => row.input.completionKey)).size === value.entries.length,
    args => ({ p_window_key: args.windowKey, p_after_cursor: args.afterCursor, p_limit: args.limit }));
}
