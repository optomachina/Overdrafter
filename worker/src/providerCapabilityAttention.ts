import { createHash } from "node:crypto";
import type { ProviderUploadCapabilityDecision } from "./providerUploadCapabilityTypes.js";

type Classification = ProviderUploadCapabilityDecision["classification"];
export type CapabilityAttentionMetadata = {
  provider: string;
  route: string;
  surface: string;
  surfaceRevision: string;
  policyRevision: string;
  adapterRevision: string | null;
  workerBuild: string | null;
};
export type CapabilityAttentionEvidence = {
  decision: ProviderUploadCapabilityDecision;
  observedAt: string;
  expiresAt: string;
  observationRevision: number;
};
type Severity = "healthy" | "attention" | "blocked" | "unknown";
type Reason = Classification | "source_malformed";
export type CapabilityAttentionItem = {
  key: string;
  category: "provider_upload_capability";
  metadata: CapabilityAttentionMetadata;
  severity: Severity;
  reasonCode: Reason;
  summary: string;
  freshness: "current" | "stale" | "unknown";
  observedAt: string | null;
  expiresAt: string | null;
  checkedAt: string;
  formatCounts: { allowed: number; added: number; removed: number } | null;
  occurrenceCount: null;
  firstSeenAt: null;
  lastChangedAt: null;
  action: null;
};
export type CapabilityAttentionCursor = {
  scopeKey: string;
  fingerprint: string;
  generation: number;
  lastObservationRevision: number | null;
  lastObservedAt: string | null;
  lastEvidenceHash: string | null;
  evaluatedAt: string;
};
export type CapabilityAttentionResult =
  | { state: "rejected"; reasonCode: "invalid_context" | "invalid_clock" | "invalid_cursor" | "observation_replay" | "generation_exhausted" }
  | {
    state: "projected";
    item: CapabilityAttentionItem;
    cursor: CapabilityAttentionCursor;
    intent: { key: string; itemKey: string; generation: number; kind: "attention" | "recovery"; reasonCode: Reason } | null;
  };

const VERSION = "provider-upload-capability.v1";
const METADATA_KEYS = ["provider", "route", "surface", "surfaceRevision", "policyRevision", "adapterRevision", "workerBuild"];
const EVIDENCE_KEYS = ["decision", "observedAt", "expiresAt", "observationRevision"];
const CURSOR_KEYS = ["scopeKey", "fingerprint", "generation", "lastObservationRevision", "lastObservedAt", "lastEvidenceHash", "evaluatedAt"];
const DECISION_REQUIRED = ["contractVersion", "classification", "allowedExtensions", "reportedAddedExtensions", "reportedRemovedExtensions", "evidenceRefs", "normalizedObservedMimeTypes"];
const CLASSIFICATIONS: readonly Classification[] = [
  "matches_policy", "format_added", "format_removed", "reviewed_missing_accept_xometry",
  "accept_missing", "unsupported", "denied", "observation_missing", "observation_stale",
  "formats_loading", "ambiguous_input", "route_or_selector_drift", "authentication_required",
  "anti_bot_or_challenge", "provider_error", "unclassified_response",
];
const MAX_GENERATION = 1_000_000;
const HASH = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z][a-z0-9._-]{0,79}$/;

/** Only plain JSON records with data properties; never invoke an input accessor. */
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => {
    if (typeof key !== "string" || ![...required, ...optional].includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}
function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function metadata(value: unknown): CapabilityAttentionMetadata | null {
  if (!record(value, METADATA_KEYS)) return null;
  for (const key of METADATA_KEYS) {
    if ((key === "adapterRevision" || key === "workerBuild") && value[key] === null) continue;
    if (typeof value[key] !== "string" || !SLUG.test(value[key])) return null;
  }
  return {
    provider: value.provider as string, route: value.route as string, surface: value.surface as string,
    surfaceRevision: value.surfaceRevision as string, policyRevision: value.policyRevision as string,
    adapterRevision: value.adapterRevision as string | null, workerBuild: value.workerBuild as string | null,
  };
}
function formats(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const result: string[] = [];
  for (const token of value) {
    if (typeof token !== "string" || !/^\.?[a-z0-9][a-z0-9_-]{0,31}$/i.test(token)) return null;
    result.push(token.replace(/^\./, "").toLowerCase());
  }
  return [...new Set(result)].sort();
}
/** Validate omitted evidence fields too: malformed contract data is never healthy. */
function boundedTokens(value: unknown, maximum: number, pattern: RegExp, maximumLength: number): boolean {
  if (!Array.isArray(value) || value.length > maximum) return false;
  for (const token of value) {
    if (typeof token !== "string" || token.length > maximumLength || !pattern.test(token)) return false;
  }
  return true;
}
function parseDecision(value: unknown, provider: string) {
  if (!record(value, DECISION_REQUIRED, ["reason", "diagnostic"]) || value.contractVersion !== VERSION
    || typeof value.classification !== "string" || !CLASSIFICATIONS.includes(value.classification as Classification)) return null;
  if (!boundedTokens(value.evidenceRefs, 8, /^issue:OVD-[1-9]\d{0,9}$/, 20)
    || !boundedTokens(value.normalizedObservedMimeTypes, 32, /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, 255)) return null;
  const allowed = formats(value.allowedExtensions);
  const added = formats(value.reportedAddedExtensions);
  const removed = formats(value.reportedRemovedExtensions);
  if (!allowed || !added || !removed || allowed.some((token) => added.includes(token) || removed.includes(token))
    || added.some((token) => removed.includes(token))) return null;
  const classification = value.classification as Classification;
  const passing = classification === "matches_policy" || classification === "reviewed_missing_accept_xometry";
  if ((passing && (allowed.length === 0 || added.length > 0 || removed.length > 0))
    || (classification === "format_added" && added.length === 0)
    || (classification === "format_removed" && (removed.length === 0 || added.length > 0))
    || (!passing && classification !== "format_added" && classification !== "format_removed"
      && (allowed.length > 0 || added.length > 0 || removed.length > 0))
    || (classification === "reviewed_missing_accept_xometry" && provider !== "xometry")) return null;
  return { classification, allowed, added, removed };
}
function parseEvidence(value: unknown, provider: string, now: number) {
  if (!record(value, EVIDENCE_KEYS)) return null;
  const observed = timestamp(value.observedAt);
  const expires = timestamp(value.expiresAt);
  const decision = parseDecision(value.decision, provider);
  if (!decision || observed === null || expires === null || observed > now || expires <= observed
    || expires - observed > 26 * 60 * 60 * 1000 || !positiveInteger(value.observationRevision)) return null;
  return { decision, observed, expires, revision: value.observationRevision,
    evidenceHash: hash([decision, observed, expires, value.observationRevision]) };
}
function cursor(value: unknown, scopeKey: string, now: number): CapabilityAttentionCursor | null {
  if (!record(value, CURSOR_KEYS) || value.scopeKey !== scopeKey || typeof value.fingerprint !== "string"
    || !HASH.test(value.fingerprint) || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0 || (value.generation as number) > MAX_GENERATION) return null;
  const evaluated = timestamp(value.evaluatedAt);
  if (evaluated === null || evaluated > now) return null;
  const noObservation = value.lastObservationRevision === null && value.lastObservedAt === null && value.lastEvidenceHash === null;
  const observed = timestamp(value.lastObservedAt);
  if (!noObservation && (!positiveInteger(value.lastObservationRevision) || observed === null || observed > evaluated
    || typeof value.lastEvidenceHash !== "string" || !HASH.test(value.lastEvidenceHash))) return null;
  return value as CapabilityAttentionCursor;
}

/**
 * Offline projection only. reviewedMetadata is an explicitly trusted caller-owned
 * allowlist, never derived from this observation or from slug syntax alone.
 * Context revisions select separate cursor scopes; changing them requires a new
 * scope cursor. Evidence time is supplied by the source, never guessed from IDs.
 * Identical concurrent calls return identical intents. A future integration must
 * atomically CAS the cursor and persist a unique outbox intent before delivery.
 * This function provides no durable exactly-once or admin-authorization guarantee.
 */
export function projectCapabilityAttention(input: {
  metadata: unknown;
  reviewedMetadata: readonly CapabilityAttentionMetadata[];
  evidence: unknown;
  previous: unknown;
  now: string;
}): CapabilityAttentionResult {
  const now = timestamp(input.now);
  if (now === null) return { state: "rejected", reasonCode: "invalid_clock" };
  const context = metadata(input.metadata);
  if (!context || !Array.isArray(input.reviewedMetadata) || input.reviewedMetadata.length > 100
    || !input.reviewedMetadata.some((candidate) => {
      const reviewed = metadata(candidate);
      return reviewed !== null && hash(reviewed) === hash(context);
    })) return { state: "rejected", reasonCode: "invalid_context" };
  const scopeKey = hash(context);
  const previous = input.previous === null ? null : cursor(input.previous, scopeKey, now);
  if (input.previous !== null && !previous) return { state: "rejected", reasonCode: "invalid_cursor" };
  const parsed = parseEvidence(input.evidence, context.provider, now);
  if (parsed && previous?.lastObservationRevision !== null && previous?.lastObservationRevision !== undefined) {
    if (parsed.revision < previous.lastObservationRevision || parsed.observed < timestamp(previous.lastObservedAt)!
      || (parsed.revision === previous.lastObservationRevision && parsed.evidenceHash !== previous.lastEvidenceHash)) {
      return { state: "rejected", reasonCode: "observation_replay" };
    }
  }
  const expired = parsed !== null && parsed.expires <= now;
  const reason: Reason = input.evidence === null ? "observation_missing" : !parsed ? "source_malformed"
    : expired ? "observation_stale" : parsed.decision.classification;
  const unknown = ["observation_missing", "observation_stale", "source_malformed"].includes(reason);
  const healthy = reason === "matches_policy" || reason === "reviewed_missing_accept_xometry";
  const severity: Severity = unknown ? "unknown" : healthy ? "healthy"
    : (reason === "format_added" || reason === "format_removed") && parsed!.decision.allowed.length > 0 ? "attention" : "blocked";
  const semanticFormats = unknown ? null : parsed!.decision;
  const fingerprint = hash([reason, severity, semanticFormats]);
  const changed = previous?.fingerprint !== fingerprint;
  const emit = changed && (previous !== null || severity !== "healthy");
  const generation = (previous?.generation ?? 0) + (emit ? 1 : 0);
  if (generation > MAX_GENERATION) return { state: "rejected", reasonCode: "generation_exhausted" };
  const itemKey = `capability:${scopeKey}`;
  const item: CapabilityAttentionItem = {
    key: itemKey, category: "provider_upload_capability", metadata: context, severity, reasonCode: reason,
    summary: severity === "healthy" ? "Upload capability matches the reviewed policy."
      : severity === "attention" ? "Observed upload formats changed and require review."
      : severity === "blocked" ? "Upload capability requires operator review."
      : reason === "observation_stale" ? "Upload capability evidence is stale."
      : "Upload capability evidence is missing or invalid.",
    freshness: unknown ? reason === "observation_stale" ? "stale" : "unknown" : "current",
    observedAt: parsed ? new Date(parsed.observed).toISOString() : null,
    expiresAt: parsed ? new Date(parsed.expires).toISOString() : null,
    checkedAt: input.now,
    formatCounts: semanticFormats ? { allowed: semanticFormats.allowed.length, added: semanticFormats.added.length, removed: semanticFormats.removed.length } : null,
    occurrenceCount: null, firstSeenAt: null, lastChangedAt: null, action: null,
  };
  return {
    state: "projected", item,
    cursor: {
      scopeKey, fingerprint, generation,
      lastObservationRevision: parsed?.revision ?? previous?.lastObservationRevision ?? null,
      lastObservedAt: parsed ? new Date(parsed.observed).toISOString() : previous?.lastObservedAt ?? null,
      lastEvidenceHash: parsed?.evidenceHash ?? previous?.lastEvidenceHash ?? null,
      evaluatedAt: input.now,
    },
    intent: emit ? { key: hash([scopeKey, generation, fingerprint]), itemKey, generation,
      kind: healthy ? "recovery" : "attention", reasonCode: reason } : null,
  };
}
