import { createHash } from "node:crypto";
import { PROVIDER_CATALOG } from "./generated/provider-catalog.js";
import {
  isCurrentApprovedAdmission,
  isCurrentXometryControlledBetaAdmission,
} from "./providerUploadCapability.js";
import type { ProviderUploadCapabilityAdmissionResolverResult } from "./providerUploadCapabilityTypes.js";
import type { VendorName, XometryDispatchAuthorization } from "./types.js";
import { XOMETRY_ENVELOPE_REVISION } from "./xometryDispatchPreflight.js";

/**
 * OVD-457 provider-neutral dispatch envelope and admission contract.
 *
 * This module is a contract layer only. It creates no permit, task, session,
 * or provider work, and nothing in it can enable a provider: an envelope is
 * admitted only when the authoritative service-only evidence (OVD-379 admission
 * resolver, rollout control, and permit state) independently agrees with every
 * bound field. The canonical serialization is byte-identical to PostgreSQL
 * `jsonb::text` for the canonical object, so the service-only resolver can
 * compute the same fingerprint with
 * `encode(digest(convert_to(envelope::text, 'UTF8'), 'sha256'), 'hex')`.
 */

export const PROVIDER_DISPATCH_ENVELOPE_SCHEMA = "provider-dispatch-envelope.v1" as const;
export const SUPPORTED_PROVIDER_DISPATCH_ENVELOPE_SCHEMAS: readonly string[] = [
  PROVIDER_DISPATCH_ENVELOPE_SCHEMA,
];

/** Closed, stable fail-closed vocabulary. Only `preflight_unavailable` is retryable. */
export const PROVIDER_DISPATCH_DENIAL_CODES = [
  "envelope_malformed",
  "envelope_version_unsupported",
  "provider_unknown",
  "provider_envelope_unknown",
  "provider_mismatch",
  "provider_envelope_mismatch",
  "admission_binding_mismatch",
  "notice_mismatch",
  "organization_mismatch",
  "actor_mismatch",
  "job_mismatch",
  "part_mismatch",
  "source_file_mismatch",
  "derivative_mismatch",
  "scope_mismatch",
  "task_lane_mismatch",
  "task_inactive",
  "permit_mismatch",
  "session_binding_mismatch",
  "rollout_binding_mismatch",
  "expiry_mismatch",
  "current_evidence_malformed",
  "permit_state_missing",
  "permit_revoked",
  "permit_not_yet_valid",
  "permit_expired",
  "admission_evidence_missing",
  "admission_evidence_malformed",
  "admission_disabled",
  "admission_expired",
  "admission_stale",
  "rollout_evidence_missing",
  "rollout_disabled",
  "rollout_stale",
  "access_revoked",
  "provider_not_enabled",
  "observation_denied",
  "preflight_rejected",
  "preflight_unavailable",
] as const;

export type ProviderDispatchDenialCode = (typeof PROVIDER_DISPATCH_DENIAL_CODES)[number];

const RETRYABLE_DENIALS: ReadonlySet<ProviderDispatchDenialCode> = new Set(["preflight_unavailable"]);

export function isRetryableProviderDispatchDenial(code: ProviderDispatchDenialCode): boolean {
  return RETRYABLE_DENIALS.has(code);
}

export type ProviderDispatchFileRole = "cad" | "drawing";
export type ProviderDispatchModelUnits = "inch" | "millimeter";

export type ProviderDispatchSourceFile = {
  role: ProviderDispatchFileRole;
  fileId: string;
  sha256: string;
};

/** Exact outbound bytes. v1 discloses source bytes unchanged (`identity`). */
export type ProviderDispatchOutboundFile = {
  role: ProviderDispatchFileRole;
  sourceSha256: string;
  sha256: string;
  derivation: "identity";
};

export type ProviderDispatchEnvelope = {
  schema: typeof PROVIDER_DISPATCH_ENVELOPE_SCHEMA;
  provider: VendorName;
  /** Reviewed provider envelope; legacy text form is `${id}.v${version}`. */
  envelope: { id: string; version: number };
  /** OVD-379 admission policy revision and evidence reference at mint time. */
  admission: { policyRevision: string; evidenceReference: string };
  /** Founding Beta notice revision (the legacy Xometry `policyRevision` key). */
  noticeRevision: string;
  purpose: "quote_only";
  affirmations: { authorityToShare: true; nonExportControlled: true; quoteOnly: true };
  subject: { actorUserId: string; organizationId: string; jobId: string; partId: string };
  scope: {
    schema: "quote-lane-scope.v1";
    version: number;
    /** Opaque SQL-authoritative quote-lane scope fingerprint; never recomputed here. */
    fingerprint: string;
    requestedQuantity: number;
    declaredModelUnits: ProviderDispatchModelUnits;
  };
  sourceFiles: ProviderDispatchSourceFile[];
  outboundFiles: ProviderDispatchOutboundFile[];
  task: {
    quoteRequestId: string;
    quoteRunId: string;
    vendorQuoteResultId: string;
    quoteRequestLaneId: string;
    workQueueTaskId: string;
  };
  permit: { permitId: string; approvalReference: string };
  /** Opaque session-lease identifier. Never credentials or session material. */
  sessionBindingId: string;
  rollout: { capability: "automatic_quote_collection"; revision: number };
  issuedAt: string;
  expiresAt: string;
};

export type ProviderDispatchParseResult =
  | { ok: true; envelope: ProviderDispatchEnvelope }
  | { ok: false; denial: ProviderDispatchDenialCode };

/** Reviewed provider envelope revisions. Presence here never admits a provider. */
export type ReviewedProviderDispatchEnvelope = {
  provider: VendorName;
  id: string;
  version: number;
  /**
   * Which current OVD-379 admission form the envelope requires: the reviewed
   * Xometry controlled-beta form, or an approved generically dispatchable
   * policy (OVD-459). No generic envelope is listed below, so the generic form
   * admits nothing until a reviewed envelope is added here in code as well as
   * in private.provider_dispatch_envelope_reviews.
   */
  requiredAdmission: "xometry_controlled_beta" | "generic_dispatch";
};

export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES: readonly ReviewedProviderDispatchEnvelope[] = [
  {
    provider: "xometry",
    id: "xometry-controlled-beta-envelope",
    version: 1,
    requiredAdmission: "xometry_controlled_beta",
  },
];

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(PROVIDER_CATALOG));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-z0-9][a-z0-9._-]{2,199}$/;
const EVIDENCE_REFERENCE = /^OVD-[1-9]\d{0,9}$/;
const ENVELOPE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVELOPE_REVISION_TEXT = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.v([1-9]\d{0,8})$/;
const SESSION_BINDING_ID = /^[a-z0-9][a-z0-9._:-]{7,199}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FILE_ROLES: ReadonlySet<string> = new Set<ProviderDispatchFileRole>(["cad", "drawing"]);
/**
 * Resolver timestamps (PostgREST `timestamptz` text). An explicit offset is
 * required so the instant never depends on the host time zone.
 */
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

class EnvelopeDenial extends Error {
  constructor(readonly denial: ProviderDispatchDenialCode) {
    super(denial);
    this.name = "EnvelopeDenial";
  }
}

function deny(denial: ProviderDispatchDenialCode = "envelope_malformed"): never {
  throw new EnvelopeDenial(denial);
}

/**
 * Copies the own data properties of a plain JSON object exactly once. Class
 * instances, accessors, symbols, and non-enumerable keys fail closed, so no
 * getter can return different values to validation and to the result.
 */
function plainSnapshot(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) deny();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) deny();
  if (Object.getOwnPropertySymbols(value).length > 0) deny();
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) deny();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** Copies the elements of a plain dense array exactly once. */
function plainArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) deny();
  if (Object.getOwnPropertySymbols(value).length > 0) deny();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length: unknown = descriptors.length?.value;
  if (typeof length !== "number" || Object.keys(descriptors).length !== length + 1) deny();
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) deny();
    items.push(descriptor.value);
  }
  return items;
}

/** Requires exactly the listed keys; unknown and missing keys both fail closed. */
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const snapshot = plainSnapshot(value);
  const actual = Object.keys(snapshot);
  if (actual.length !== keys.length || !keys.every((key) => key in snapshot)) deny();
  return snapshot;
}

function matching(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) deny();
  return value;
}

function literal<T extends string | boolean>(value: unknown, expected: T): T {
  if (value !== expected) deny();
  return expected;
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) deny();
  return value;
}

function timestamp(value: unknown): string {
  const text = matching(value, CANONICAL_TIMESTAMP);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) deny();
  return text;
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function roleOrder(left: { role: string }, right: { role: string }): number {
  return compareCodePoints(left.role, right.role);
}

function fileRole(value: unknown): ProviderDispatchFileRole {
  if (typeof value !== "string" || !FILE_ROLES.has(value)) deny();
  return value as ProviderDispatchFileRole;
}

function parseSourceFiles(value: unknown): ProviderDispatchSourceFile[] {
  const items = plainArray(value);
  if (items.length === 0 || items.length > FILE_ROLES.size) deny();
  const files = items.map((item) => {
    const file = exactRecord(item, ["role", "fileId", "sha256"]);
    return {
      role: fileRole(file.role),
      fileId: matching(file.fileId, UUID),
      sha256: matching(file.sha256, SHA256),
    };
  });
  const roles = new Set(files.map((file) => file.role));
  const fileIds = new Set(files.map((file) => file.fileId));
  if (roles.size !== files.length || fileIds.size !== files.length || !roles.has("cad")) deny();
  return files.sort(roleOrder);
}

function parseOutboundFiles(
  value: unknown,
  sources: readonly ProviderDispatchSourceFile[],
): ProviderDispatchOutboundFile[] {
  const items = plainArray(value);
  if (items.length === 0 || items.length > sources.length) deny();
  const files = items.map((item) => {
    const file = exactRecord(item, ["role", "sourceSha256", "sha256", "derivation"]);
    const role = fileRole(file.role);
    const source = sources.find((candidate) => candidate.role === role);
    const sourceSha256 = matching(file.sourceSha256, SHA256);
    const sha256 = matching(file.sha256, SHA256);
    literal(file.derivation, "identity");
    if (source?.sha256 !== sourceSha256 || sha256 !== sourceSha256) deny();
    return { role: source.role, sourceSha256, sha256, derivation: "identity" as const };
  });
  if (new Set(files.map((file) => file.role)).size !== files.length) deny();
  if (!files.some((file) => file.role === "cad")) deny();
  return files.sort(roleOrder);
}

function parseEnvelopeIdentity(provider: VendorName, value: unknown): { id: string; version: number } {
  const envelope = exactRecord(value, ["id", "version"]);
  const id = matching(envelope.id, ENVELOPE_ID);
  const version = integer(envelope.version, 1);
  if (!id.startsWith(`${provider}-`)) deny("provider_envelope_mismatch");
  return { id, version };
}

const TOP_LEVEL_KEYS = [
  "schema",
  "provider",
  "envelope",
  "admission",
  "noticeRevision",
  "purpose",
  "affirmations",
  "subject",
  "scope",
  "sourceFiles",
  "outboundFiles",
  "task",
  "permit",
  "sessionBindingId",
  "rollout",
  "issuedAt",
  "expiresAt",
] as const;

function modelUnits(value: unknown): ProviderDispatchModelUnits {
  if (value !== "inch" && value !== "millimeter") deny();
  return value;
}

function parseStrict(value: unknown): ProviderDispatchEnvelope {
  const raw = plainSnapshot(value);
  if (typeof raw.schema !== "string") deny();
  if (!SUPPORTED_PROVIDER_DISPATCH_ENVELOPE_SCHEMAS.includes(raw.schema)) {
    deny("envelope_version_unsupported");
  }
  const root = exactRecord(raw, TOP_LEVEL_KEYS);
  if (typeof root.provider !== "string") deny();
  if (!KNOWN_PROVIDERS.has(root.provider)) deny("provider_unknown");
  const provider = root.provider as VendorName;

  const admission = exactRecord(root.admission, ["policyRevision", "evidenceReference"]);
  const affirmations = exactRecord(root.affirmations, [
    "authorityToShare",
    "nonExportControlled",
    "quoteOnly",
  ]);
  const subject = exactRecord(root.subject, ["actorUserId", "organizationId", "jobId", "partId"]);
  const scope = exactRecord(root.scope, [
    "schema",
    "version",
    "fingerprint",
    "requestedQuantity",
    "declaredModelUnits",
  ]);
  const task = exactRecord(root.task, [
    "quoteRequestId",
    "quoteRunId",
    "vendorQuoteResultId",
    "quoteRequestLaneId",
    "workQueueTaskId",
  ]);
  const permit = exactRecord(root.permit, ["permitId", "approvalReference"]);
  const rollout = exactRecord(root.rollout, ["capability", "revision"]);

  const sourceFiles = parseSourceFiles(root.sourceFiles);
  const issuedAt = timestamp(root.issuedAt);
  const expiresAt = timestamp(root.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) deny();

  return {
    schema: PROVIDER_DISPATCH_ENVELOPE_SCHEMA,
    provider,
    envelope: parseEnvelopeIdentity(provider, root.envelope),
    admission: {
      policyRevision: matching(admission.policyRevision, REVISION),
      evidenceReference: matching(admission.evidenceReference, EVIDENCE_REFERENCE),
    },
    noticeRevision: matching(root.noticeRevision, REVISION),
    purpose: literal(root.purpose, "quote_only"),
    affirmations: {
      authorityToShare: literal(affirmations.authorityToShare, true),
      nonExportControlled: literal(affirmations.nonExportControlled, true),
      quoteOnly: literal(affirmations.quoteOnly, true),
    },
    subject: {
      actorUserId: matching(subject.actorUserId, UUID),
      organizationId: matching(subject.organizationId, UUID),
      jobId: matching(subject.jobId, UUID),
      partId: matching(subject.partId, UUID),
    },
    scope: {
      schema: literal(scope.schema, "quote-lane-scope.v1"),
      version: integer(scope.version, 1),
      fingerprint: matching(scope.fingerprint, SHA256),
      requestedQuantity: integer(scope.requestedQuantity, 1),
      declaredModelUnits: modelUnits(scope.declaredModelUnits),
    },
    sourceFiles,
    outboundFiles: parseOutboundFiles(root.outboundFiles, sourceFiles),
    task: {
      quoteRequestId: matching(task.quoteRequestId, UUID),
      quoteRunId: matching(task.quoteRunId, UUID),
      vendorQuoteResultId: matching(task.vendorQuoteResultId, UUID),
      quoteRequestLaneId: matching(task.quoteRequestLaneId, UUID),
      workQueueTaskId: matching(task.workQueueTaskId, UUID),
    },
    permit: {
      permitId: matching(permit.permitId, UUID),
      approvalReference: matching(permit.approvalReference, UUID),
    },
    sessionBindingId: matching(root.sessionBindingId, SESSION_BINDING_ID),
    rollout: {
      capability: literal(rollout.capability, "automatic_quote_collection"),
      revision: integer(rollout.revision, 0),
    },
    issuedAt,
    expiresAt,
  };
}

function capture<T>(operation: () => T): { ok: true; value: T } | { ok: false; denial: ProviderDispatchDenialCode } {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    if (error instanceof EnvelopeDenial) return { ok: false, denial: error.denial };
    throw error;
  }
}

/** Copies the own data properties of a plain JSON object once, or returns null. */
export function readPlainRecord(value: unknown): Record<string, unknown> | null {
  const result = capture(() => plainSnapshot(value));
  return result.ok ? result.value : null;
}

/**
 * Reads exactly the listed own data keys of a plain JSON object once, or
 * returns null for unknown/missing keys, accessors, symbols, or class instances.
 */
export function readExactPlainRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const result = capture(() => exactRecord(value, keys));
  return result.ok ? result.value : null;
}

/** Strictly parses one envelope; unknown keys, versions, and providers fail closed. */
export function parseProviderDispatchEnvelope(value: unknown): ProviderDispatchParseResult {
  const result = capture(() => parseStrict(value));
  return result.ok ? { ok: true, envelope: result.value } : result;
}

/** Picks the single mutually supported schema version or fails closed. */
export function negotiateProviderDispatchEnvelopeSchema(
  offered: unknown,
): { ok: true; schema: typeof PROVIDER_DISPATCH_ENVELOPE_SCHEMA } | { ok: false; denial: "envelope_version_unsupported" } {
  if (
    Array.isArray(offered) &&
    offered.length <= 16 &&
    offered.every((item) => typeof item === "string") &&
    offered.includes(PROVIDER_DISPATCH_ENVELOPE_SCHEMA)
  ) {
    return { ok: true, schema: PROVIDER_DISPATCH_ENVELOPE_SCHEMA };
  }
  return { ok: false, denial: "envelope_version_unsupported" };
}

export function findReviewedProviderDispatchEnvelope(
  envelope: Pick<ProviderDispatchEnvelope, "provider" | "envelope">,
  reviewedEnvelopes: readonly ReviewedProviderDispatchEnvelope[] = REVIEWED_PROVIDER_DISPATCH_ENVELOPES,
): ReviewedProviderDispatchEnvelope | null {
  return (
    reviewedEnvelopes.find(
      (reviewed) =>
        reviewed.provider === envelope.provider &&
        reviewed.id === envelope.envelope.id &&
        reviewed.version === envelope.envelope.version,
    ) ?? null
  );
}

export function formatProviderEnvelopeRevision(envelope: { id: string; version: number }): string {
  return `${envelope.id}.v${envelope.version}`;
}

export function parseProviderEnvelopeRevision(value: unknown): { id: string; version: number } | null {
  if (typeof value !== "string") return null;
  const match = ENVELOPE_REVISION_TEXT.exec(value);
  if (!match) return null;
  return { id: match[1], version: Number(match[2]) };
}

type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson };

/** PostgreSQL jsonb key order: shorter keys first, then bytewise. */
function compareJsonbKeys(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return compareCodePoints(left, right);
}

/**
 * Serializes exactly as PostgreSQL renders `jsonb::text`. Envelope strings are
 * restricted to ASCII identifier alphabets, so no escape-form divergence exists.
 */
function serializeJsonb(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Canonical envelopes contain integers only.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(serializeJsonb).join(", ")}]`;
  const members = Object.keys(value)
    .sort(compareJsonbKeys)
    .map((key) => serializeJsonbMember(key, value[key]));
  return `{${members.join(", ")}}`;
}

function serializeJsonbMember(key: string, value: CanonicalJson): string {
  return JSON.stringify(key) + ": " + serializeJsonb(value);
}

/** Deterministic, versioned canonical text of a parsed envelope. */
export function canonicalizeProviderDispatchEnvelope(envelope: ProviderDispatchEnvelope): string {
  const parsed = parseProviderDispatchEnvelope(envelope);
  if (!parsed.ok) throw new TypeError(`Cannot canonicalize an invalid envelope: ${parsed.denial}`);
  return serializeJsonb(parsed.envelope as unknown as CanonicalJson);
}

export function fingerprintProviderDispatchEnvelope(envelope: ProviderDispatchEnvelope): string {
  return createHash("sha256").update(canonicalizeProviderDispatchEnvelope(envelope), "utf8").digest("hex");
}

function same(left: unknown, right: unknown): boolean {
  return serializeJsonb(left as CanonicalJson) === serializeJsonb(right as CanonicalJson);
}

/**
 * Ordered substitution checks between the authoritative binding and a
 * presented one. The first differing boundary is the stable denial.
 */
const BINDING_CHECKS: ReadonlyArray<
  [ProviderDispatchDenialCode, (envelope: ProviderDispatchEnvelope) => unknown]
> = [
  ["provider_mismatch", (envelope) => envelope.provider],
  ["provider_envelope_mismatch", (envelope) => envelope.envelope],
  ["admission_binding_mismatch", (envelope) => envelope.admission],
  ["notice_mismatch", (envelope) => envelope.noticeRevision],
  ["organization_mismatch", (envelope) => envelope.subject.organizationId],
  ["actor_mismatch", (envelope) => envelope.subject.actorUserId],
  ["job_mismatch", (envelope) => envelope.subject.jobId],
  ["part_mismatch", (envelope) => envelope.subject.partId],
  ["source_file_mismatch", (envelope) => envelope.sourceFiles],
  ["derivative_mismatch", (envelope) => envelope.outboundFiles],
  ["scope_mismatch", (envelope) => envelope.scope],
  ["task_lane_mismatch", (envelope) => envelope.task],
  ["permit_mismatch", (envelope) => envelope.permit],
  ["session_binding_mismatch", (envelope) => envelope.sessionBindingId],
  ["rollout_binding_mismatch", (envelope) => envelope.rollout],
  ["expiry_mismatch", (envelope) => [envelope.issuedAt, envelope.expiresAt]],
];

/** Strictly parses both envelopes, then reports the first differing boundary. */
export function compareProviderDispatchEnvelopes(
  expectedInput: unknown,
  presentedInput: unknown,
): { match: true } | { match: false; denial: ProviderDispatchDenialCode } {
  const presented = parseProviderDispatchEnvelope(presentedInput);
  if (!presented.ok) return { match: false, denial: presented.denial };
  const expected = parseProviderDispatchEnvelope(expectedInput);
  if (!expected.ok) return { match: false, denial: expected.denial };
  for (const [denial, select] of BINDING_CHECKS) {
    if (!same(select(expected.envelope), select(presented.envelope))) return { match: false, denial };
  }
  // schema, purpose, and affirmations are parse-time literals, so the checks
  // above cover every remaining field of the canonical envelope.
  return { match: true };
}

/** Bounded rollout evidence from private.commercial_rollout_controls. */
export type ProviderDispatchRolloutEvidence = {
  capability: string;
  enabled: boolean;
  revision: number;
};

/** Runtime observations (for example OVD-411 capability decisions) may only narrow. */
export type ProviderDispatchNarrowingObservation = {
  source: string;
  effect: "deny" | "none";
};

export type ProviderDispatchCurrentEvidence = {
  now: string;
  permitState: "active" | "revoked" | null;
  admission: ProviderUploadCapabilityAdmissionResolverResult | null;
  rollout: ProviderDispatchRolloutEvidence | null;
  observations?: readonly ProviderDispatchNarrowingObservation[];
};

export type ProviderDispatchAdmissionDecision =
  | {
      admitted: true;
      contractVersion: typeof PROVIDER_DISPATCH_ENVELOPE_SCHEMA;
      provider: VendorName;
      envelopeFingerprint: string;
      expiresAt: string;
    }
  | {
      admitted: false;
      contractVersion: typeof PROVIDER_DISPATCH_ENVELOPE_SCHEMA;
      denial: ProviderDispatchDenialCode;
      retryable: boolean;
    };

function denied(denial: ProviderDispatchDenialCode): ProviderDispatchAdmissionDecision {
  return {
    admitted: false,
    contractVersion: PROVIDER_DISPATCH_ENVELOPE_SCHEMA,
    denial,
    retryable: isRetryableProviderDispatchDenial(denial),
  };
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const ADMISSION_RESOLVER_KEYS = [
  "policy_present",
  "provider_admitted",
  "generically_dispatchable",
  "provider",
  "admission_state",
  "policy_revision",
  "evidence_reference",
  "permission_basis",
  "supported_processes",
  "accepted_file_extensions",
  "session_owner",
  "reviewed_at",
  "expires_at",
  "reason_code",
] as const;

/**
 * Null, or an offset-qualified ISO-8601 instant with a real calendar date and
 * clock time that parses to a finite time (Date.parse would roll 02-31 over).
 */
function isNullableOffsetTimestamp(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || !OFFSET_TIMESTAMP.test(value)) return false;
  const [year, month, day, hour, minute, second] = value
    .slice(0, 19)
    .split(/[-T:]/)
    .map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function isWellFormedAdmission(value: Record<string, unknown>): boolean {
  return (
    typeof value.policy_present === "boolean" &&
    typeof value.provider_admitted === "boolean" &&
    typeof value.generically_dispatchable === "boolean" &&
    typeof value.admission_state === "string" &&
    typeof value.reason_code === "string" &&
    ["provider", "policy_revision", "evidence_reference", "permission_basis", "session_owner", "reviewed_at", "expires_at"].every(
      (key) => isNullableString(value[key]),
    ) &&
    isNullableOffsetTimestamp(value.reviewed_at) &&
    isNullableOffsetTimestamp(value.expires_at) &&
    isStringArray(value.supported_processes) &&
    isStringArray(value.accepted_file_extensions)
  );
}

function classifyAdmission(
  envelope: ProviderDispatchEnvelope,
  reviewed: ReviewedProviderDispatchEnvelope,
  resolver: unknown,
  nowMs: number,
): ProviderDispatchDenialCode | null {
  if (resolver === null || resolver === undefined) return "admission_evidence_missing";
  const snapshot = capture(() => exactRecord(resolver, ADMISSION_RESOLVER_KEYS));
  if (!snapshot.ok || !isWellFormedAdmission(snapshot.value)) return "admission_evidence_malformed";
  const admission = snapshot.value as ProviderUploadCapabilityAdmissionResolverResult;
  return classifyWellFormedAdmission(envelope, reviewed, admission, nowMs);
}

function classifyWellFormedAdmission(
  envelope: ProviderDispatchEnvelope,
  reviewed: ReviewedProviderDispatchEnvelope,
  resolver: ProviderUploadCapabilityAdmissionResolverResult,
  nowMs: number,
): ProviderDispatchDenialCode | null {
  if (!resolver.policy_present || resolver.reason_code === "provider_unknown") return "admission_evidence_missing";
  if (resolver.provider !== envelope.provider) return "provider_mismatch";
  // expires_at is offset-qualified and finite here (isWellFormedAdmission).
  const expiresMs = resolver.expires_at === null ? null : Date.parse(resolver.expires_at);
  if (resolver.reason_code === "policy_expired" || (expiresMs !== null && expiresMs <= nowMs)) {
    return "admission_expired";
  }
  if (!resolver.provider_admitted) return "admission_disabled";
  if (
    resolver.policy_revision !== envelope.admission.policyRevision ||
    resolver.evidence_reference !== envelope.admission.evidenceReference
  ) {
    return "admission_stale";
  }
  const binding = {
    provider: envelope.provider,
    policyRevision: envelope.admission.policyRevision,
    evidenceReference: envelope.admission.evidenceReference,
  };
  if (reviewed.requiredAdmission === "generic_dispatch") {
    return isCurrentApprovedAdmission(resolver, binding, nowMs) ? null : "admission_disabled";
  }
  if (reviewed.requiredAdmission !== "xometry_controlled_beta") return "admission_disabled";
  return isCurrentXometryControlledBetaAdmission(resolver, binding, nowMs) ? null : "admission_disabled";
}

function classifyRollout(
  envelope: ProviderDispatchEnvelope,
  rollout: unknown,
): ProviderDispatchDenialCode | null {
  if (rollout === null || rollout === undefined) return "rollout_evidence_missing";
  const snapshot = capture(() => exactRecord(rollout, ["capability", "enabled", "revision"]));
  if (!snapshot.ok) return "current_evidence_malformed";
  const { capability, enabled, revision } = snapshot.value;
  if (
    capability !== envelope.rollout.capability ||
    typeof enabled !== "boolean" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision)
  ) {
    return "current_evidence_malformed";
  }
  if (!enabled) return "rollout_disabled";
  return revision === envelope.rollout.revision ? null : "rollout_stale";
}

function classifyObservations(observations: unknown): ProviderDispatchDenialCode | null {
  if (observations === undefined) return null;
  const items = capture(() => plainArray(observations).map((item) => exactRecord(item, ["source", "effect"])));
  if (!items.ok) return "current_evidence_malformed";
  for (const observation of items.value) {
    if (typeof observation.source !== "string") return "current_evidence_malformed";
    if (observation.effect !== "none") return "observation_denied";
  }
  return null;
}

const EVIDENCE_KEYS = ["now", "permitState", "admission", "rollout", "observations"];

/** Reads every evidence field once; `now` must be a canonical UTC timestamp. */
function readEvidence(value: unknown): Record<string, unknown> & { now: string } {
  const evidence = plainSnapshot(value);
  const keys = Object.keys(evidence);
  const required = EVIDENCE_KEYS.slice(0, 4);
  if (!keys.every((key) => EVIDENCE_KEYS.includes(key)) || !required.every((key) => key in evidence)) deny();
  return { ...evidence, now: timestamp(evidence.now) };
}

/**
 * Decides whether a presented envelope may proceed under current evidence.
 * Only the authoritative stored binding plus current service-only evidence can
 * admit; envelope fields and observations alone can never enable a provider.
 * `reviewedEnvelopes` defaults to the code-reviewed list; callers other than
 * tests must not pass it.
 */
export function evaluateProviderDispatchAdmission(input: {
  expected: unknown;
  presented: unknown;
  evidence: ProviderDispatchCurrentEvidence;
  reviewedEnvelopes?: readonly ReviewedProviderDispatchEnvelope[];
}): ProviderDispatchAdmissionDecision {
  const presented = parseProviderDispatchEnvelope(input.presented);
  if (!presented.ok) return denied(presented.denial);
  const expected = parseProviderDispatchEnvelope(input.expected);
  if (!expected.ok) return denied(expected.denial);

  const comparison = compareProviderDispatchEnvelopes(expected.envelope, presented.envelope);
  if (!comparison.match) return denied(comparison.denial);

  const envelope = expected.envelope;
  const reviewed = findReviewedProviderDispatchEnvelope(envelope, input.reviewedEnvelopes);
  if (!reviewed) return denied("provider_envelope_unknown");

  const snapshot = capture(() => readEvidence(input.evidence));
  if (!snapshot.ok) return denied("current_evidence_malformed");
  const evidence = snapshot.value;
  const nowMs = Date.parse(evidence.now);

  if (evidence.permitState === null || evidence.permitState === undefined) return denied("permit_state_missing");
  if (evidence.permitState === "revoked") return denied("permit_revoked");
  if (evidence.permitState !== "active") return denied("current_evidence_malformed");
  if (nowMs < Date.parse(envelope.issuedAt)) return denied("permit_not_yet_valid");
  if (nowMs >= Date.parse(envelope.expiresAt)) return denied("permit_expired");

  const finding =
    classifyAdmission(envelope, reviewed, evidence.admission, nowMs) ??
    classifyRollout(envelope, evidence.rollout) ??
    classifyObservations(evidence.observations);
  if (finding) return denied(finding);

  return {
    admitted: true,
    contractVersion: PROVIDER_DISPATCH_ENVELOPE_SCHEMA,
    provider: envelope.provider,
    envelopeFingerprint: fingerprintProviderDispatchEnvelope(envelope),
    expiresAt: envelope.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Explicit legacy Xometry compatibility (OVD-367/368). Legacy rows, payload
// keys, and fingerprints are mapped field-for-field and never reinterpreted.
// ---------------------------------------------------------------------------

/** Identity columns of private.xometry_beta_dispatch_permits (created_at is not an identity). */
export type LegacyXometryPermitRecord = {
  id: string;
  organization_id: string;
  job_id: string;
  part_id: string;
  quote_request_id: string;
  quote_run_id: string;
  vendor_quote_result_id: string;
  quote_request_lane_id: string;
  work_queue_task_id: string;
  actor_user_id: string;
  notice_revision: string;
  approval_reference: string;
  provider: "xometry";
  scope_version: number;
  scope_fingerprint: string;
  declared_model_units: ProviderDispatchModelUnits;
  envelope_revision: typeof XOMETRY_ENVELOPE_REVISION;
  authority_to_share: true;
  non_export_controlled: true;
  quote_only: true;
};

/** Keys api_request_xometry_beta_dispatch merges into the work_queue payload. */
export type LegacyXometryTaskPayloadBinding = {
  xometryBetaDispatchPermitId: string;
  xometryBetaEnvelopeRevision: typeof XOMETRY_ENVELOPE_REVISION;
  quoteLaneScopeFingerprint: string;
};

/** Neutral path for every legacy permit column. `envelope` means the `${id}.v${version}` text. */
export const LEGACY_XOMETRY_PERMIT_COLUMN_MAP = {
  id: "permit.permitId",
  organization_id: "subject.organizationId",
  job_id: "subject.jobId",
  part_id: "subject.partId",
  quote_request_id: "task.quoteRequestId",
  quote_run_id: "task.quoteRunId",
  vendor_quote_result_id: "task.vendorQuoteResultId",
  quote_request_lane_id: "task.quoteRequestLaneId",
  work_queue_task_id: "task.workQueueTaskId",
  actor_user_id: "subject.actorUserId",
  notice_revision: "noticeRevision",
  approval_reference: "permit.approvalReference",
  provider: "provider",
  scope_version: "scope.version",
  scope_fingerprint: "scope.fingerprint",
  declared_model_units: "scope.declaredModelUnits",
  envelope_revision: "envelope",
  authority_to_share: "affirmations.authorityToShare",
  non_export_controlled: "affirmations.nonExportControlled",
  quote_only: "affirmations.quoteOnly",
} as const satisfies Record<keyof LegacyXometryPermitRecord, string>;

export const LEGACY_XOMETRY_TASK_PAYLOAD_KEY_MAP = {
  xometryBetaDispatchPermitId: "permit.permitId",
  xometryBetaEnvelopeRevision: "envelope",
  quoteLaneScopeFingerprint: "scope.fingerprint",
} as const satisfies Record<keyof LegacyXometryTaskPayloadBinding, string>;

/** Worker preflight response keys (api_authorize_xometry_beta_worker_dispatch). */
export const LEGACY_XOMETRY_AUTHORIZATION_KEY_MAP = {
  permitId: "permit.permitId",
  provider: "provider",
  scopeFingerprint: "scope.fingerprint",
  envelopeRevision: "envelope",
  nonExportControlled: "affirmations.nonExportControlled",
} as const satisfies Record<keyof XometryDispatchAuthorization, string>;

/**
 * Scope-preview keys (api_get_xometry_beta_dispatch_scope). The legacy
 * `policyRevision` is the Founding Beta notice revision, not the OVD-379
 * admission policy revision; it maps to `noticeRevision`.
 */
export const LEGACY_XOMETRY_SCOPE_PREVIEW_KEY_MAP = {
  organizationId: "subject.organizationId",
  jobId: "subject.jobId",
  partId: "subject.partId",
  provider: "provider",
  requestedQuantity: "scope.requestedQuantity",
  scopeVersion: "scope.version",
  scopeFingerprint: "scope.fingerprint",
  declaredModelUnits: "scope.declaredModelUnits",
  policyRevision: "noticeRevision",
  envelopeRevision: "envelope",
} as const;

const LEGACY_PERMIT_KEYS = Object.keys(LEGACY_XOMETRY_PERMIT_COLUMN_MAP);

function isLegacyXometryEnvelope(envelope: ProviderDispatchEnvelope): boolean {
  return (
    envelope.provider === "xometry" &&
    formatProviderEnvelopeRevision(envelope.envelope) === XOMETRY_ENVELOPE_REVISION
  );
}

function parseLegacyPermitStrict(value: unknown): LegacyXometryPermitRecord {
  const row = exactRecord(value, LEGACY_PERMIT_KEYS);
  if (row.provider !== "xometry") deny("provider_mismatch");
  if (row.envelope_revision !== XOMETRY_ENVELOPE_REVISION) deny("provider_envelope_unknown");
  if (row.declared_model_units !== "inch" && row.declared_model_units !== "millimeter") deny();
  return {
    id: matching(row.id, UUID),
    organization_id: matching(row.organization_id, UUID),
    job_id: matching(row.job_id, UUID),
    part_id: matching(row.part_id, UUID),
    quote_request_id: matching(row.quote_request_id, UUID),
    quote_run_id: matching(row.quote_run_id, UUID),
    vendor_quote_result_id: matching(row.vendor_quote_result_id, UUID),
    quote_request_lane_id: matching(row.quote_request_lane_id, UUID),
    work_queue_task_id: matching(row.work_queue_task_id, UUID),
    actor_user_id: matching(row.actor_user_id, UUID),
    notice_revision: matching(row.notice_revision, REVISION),
    approval_reference: matching(row.approval_reference, UUID),
    provider: "xometry",
    scope_version: integer(row.scope_version, 1),
    scope_fingerprint: matching(row.scope_fingerprint, SHA256),
    declared_model_units: row.declared_model_units,
    envelope_revision: XOMETRY_ENVELOPE_REVISION,
    authority_to_share: literal(row.authority_to_share, true),
    non_export_controlled: literal(row.non_export_controlled, true),
    quote_only: literal(row.quote_only, true),
  };
}

function legacyScopeFile(role: ProviderDispatchFileRole, value: unknown): ProviderDispatchSourceFile {
  const file = plainSnapshot(value);
  return { role, fileId: matching(file.fileId, UUID), sha256: matching(file.sha256, SHA256) };
}

/** Reads only the file identities and quantity from a quote-lane-scope.v1 snapshot. */
function readLegacyScope(
  value: unknown,
  partId: string,
): { requestedQuantity: number; sourceFiles: ProviderDispatchSourceFile[] } {
  const scope = plainSnapshot(value);
  if (scope.schema !== "quote-lane-scope.v1") deny();
  if (scope.vendor !== "xometry") deny("provider_mismatch");
  const part = plainSnapshot(scope.part);
  if (part.id !== partId) deny("part_mismatch");
  const sourceFiles = [legacyScopeFile("cad", part.cad)];
  if (part.drawing !== null) sourceFiles.push(legacyScopeFile("drawing", part.drawing));
  return { requestedQuantity: integer(scope.quantity, 1), sourceFiles };
}

/** Bindings a legacy permit never recorded; they must be supplied, never defaulted. */
export type LegacyXometryLiftBindings = {
  admission: { policyRevision: string; evidenceReference: string };
  sessionBindingId: string;
  rollout: { capability: "automatic_quote_collection"; revision: number };
  issuedAt: string;
  expiresAt: string;
};

/**
 * Represents an existing Xometry permit as a neutral envelope. Every legacy
 * identifier is copied verbatim; bindings absent from the legacy row come only
 * from the explicit `bindings` argument.
 *
 * File hashes are taken from `scopeSnapshot`, so the snapshot must be bound to
 * the permit: `scopeSnapshotFingerprint` must be the SQL-authoritative
 * `private.quote_scope_fingerprint(scope_snapshot)` computed over the exact
 * snapshot supplied (for example the lane's stored `scope_snapshot`, read in
 * the same transaction). It is not recomputed here because jsonb numeric text
 * (for example tolerance scale) is not reproducible from parsed JSON numbers.
 * Any difference from the permit's `scope_fingerprint` fails as
 * `scope_mismatch`, so a swapped file for the same part cannot be lifted.
 */
export function liftLegacyXometryPermit(input: {
  permit: unknown;
  scopeSnapshot: unknown;
  scopeSnapshotFingerprint: unknown;
  bindings: LegacyXometryLiftBindings;
}): ProviderDispatchParseResult {
  const lifted = capture(() => {
    const permit = parseLegacyPermitStrict(input.permit);
    const scopeSnapshotFingerprint = matching(input.scopeSnapshotFingerprint, SHA256);
    if (scopeSnapshotFingerprint !== permit.scope_fingerprint) deny("scope_mismatch");
    const scope = readLegacyScope(input.scopeSnapshot, permit.part_id);
    const envelope = parseProviderEnvelopeRevision(permit.envelope_revision);
    if (!envelope) deny("provider_envelope_unknown");
    return {
      schema: PROVIDER_DISPATCH_ENVELOPE_SCHEMA,
      provider: permit.provider,
      envelope,
      admission: input.bindings.admission,
      noticeRevision: permit.notice_revision,
      purpose: "quote_only",
      affirmations: {
        authorityToShare: permit.authority_to_share,
        nonExportControlled: permit.non_export_controlled,
        quoteOnly: permit.quote_only,
      },
      subject: {
        actorUserId: permit.actor_user_id,
        organizationId: permit.organization_id,
        jobId: permit.job_id,
        partId: permit.part_id,
      },
      scope: {
        schema: "quote-lane-scope.v1",
        version: permit.scope_version,
        fingerprint: permit.scope_fingerprint,
        requestedQuantity: scope.requestedQuantity,
        declaredModelUnits: permit.declared_model_units,
      },
      sourceFiles: scope.sourceFiles,
      outboundFiles: scope.sourceFiles.map((file) => ({
        role: file.role,
        sourceSha256: file.sha256,
        sha256: file.sha256,
        derivation: "identity",
      })),
      task: {
        quoteRequestId: permit.quote_request_id,
        quoteRunId: permit.quote_run_id,
        vendorQuoteResultId: permit.vendor_quote_result_id,
        quoteRequestLaneId: permit.quote_request_lane_id,
        workQueueTaskId: permit.work_queue_task_id,
      },
      permit: { permitId: permit.id, approvalReference: permit.approval_reference },
      sessionBindingId: input.bindings.sessionBindingId,
      rollout: input.bindings.rollout,
      issuedAt: input.bindings.issuedAt,
      expiresAt: input.bindings.expiresAt,
    };
  });
  return lifted.ok ? parseProviderDispatchEnvelope(lifted.value) : lifted;
}

export type LegacyXometryProjection =
  | {
      ok: true;
      permit: LegacyXometryPermitRecord;
      taskPayload: LegacyXometryTaskPayloadBinding;
      authorization: XometryDispatchAuthorization;
    }
  | { ok: false; denial: ProviderDispatchDenialCode };

/** Projects a neutral Xometry envelope onto the exact legacy columns and keys. */
export function projectLegacyXometryBinding(value: unknown): LegacyXometryProjection {
  const parsed = parseProviderDispatchEnvelope(value);
  if (!parsed.ok) return parsed;
  const envelope = parsed.envelope;
  if (envelope.provider !== "xometry") return { ok: false, denial: "provider_mismatch" };
  if (!isLegacyXometryEnvelope(envelope)) return { ok: false, denial: "provider_envelope_mismatch" };
  return {
    ok: true,
    permit: {
      id: envelope.permit.permitId,
      organization_id: envelope.subject.organizationId,
      job_id: envelope.subject.jobId,
      part_id: envelope.subject.partId,
      quote_request_id: envelope.task.quoteRequestId,
      quote_run_id: envelope.task.quoteRunId,
      vendor_quote_result_id: envelope.task.vendorQuoteResultId,
      quote_request_lane_id: envelope.task.quoteRequestLaneId,
      work_queue_task_id: envelope.task.workQueueTaskId,
      actor_user_id: envelope.subject.actorUserId,
      notice_revision: envelope.noticeRevision,
      approval_reference: envelope.permit.approvalReference,
      provider: "xometry",
      scope_version: envelope.scope.version,
      scope_fingerprint: envelope.scope.fingerprint,
      declared_model_units: envelope.scope.declaredModelUnits,
      envelope_revision: XOMETRY_ENVELOPE_REVISION,
      authority_to_share: true,
      non_export_controlled: true,
      quote_only: true,
    },
    taskPayload: {
      xometryBetaDispatchPermitId: envelope.permit.permitId,
      xometryBetaEnvelopeRevision: XOMETRY_ENVELOPE_REVISION,
      quoteLaneScopeFingerprint: envelope.scope.fingerprint,
    },
    authorization: {
      permitId: envelope.permit.permitId,
      provider: "xometry",
      scopeFingerprint: envelope.scope.fingerprint,
      envelopeRevision: XOMETRY_ENVELOPE_REVISION,
      nonExportControlled: true,
    },
  };
}
