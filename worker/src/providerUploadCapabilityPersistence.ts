import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decideProviderUploadCapability,
  normalizeProviderUploadExtensions,
  normalizeProviderUploadMimeTypes,
  PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION,
} from "./providerUploadCapability.js";
import type {
  ProviderUploadCapabilityAdmissionResolverResult,
  ProviderUploadCapabilityDecision,
  ProviderUploadCapabilityEnvelope,
  ProviderUploadCapabilityObservedState,
} from "./providerUploadCapabilityTypes.js";
import type { VendorName } from "./types.js";

const SLUG = /^[a-z][a-z0-9._-]{0,79}$/;
const IDEMPOTENCY_KEY = /^[a-z][a-z0-9._:-]{2,127}$/;
const EVIDENCE_REFERENCE = /^issue:OVD-[1-9]\d{0,9}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EXTENSION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const CURRENT_STATES = new Set([
  "fresh", "loading", "route_or_selector_drift", "authentication_required",
  "anti_bot_or_challenge", "provider_error", "unclassified_response",
]);
const RECORD_STATES = new Set([...CURRENT_STATES, "ambiguous"]);
const RESOLVER_KEYS = [
  "provider", "capability", "route", "surface", "surface_revision", "contract_version",
  "observation_state", "observed_extensions", "observed_mime_types",
  "accept_attribute_present", "observed_at", "expires_at", "freshness",
  "observation_revision",
];

export type CapabilityTelemetry = {
  reasonCode: string;
  state: ProviderUploadCapabilityObservedState | "invalid";
  revision: number | null;
};

type TelemetrySink = (event: CapabilityTelemetry) => void;

export type CapabilityRecordInput = {
  provider: VendorName;
  route: string;
  surface: string;
  revision: string;
  state: Exclude<ProviderUploadCapabilityObservedState, "missing" | "stale">;
  extensions: string[];
  mimeTypes: string[];
  acceptAttributePresent: boolean | null;
  observedAt: string;
  expiresAt: string;
  actorKind: "worker" | "operator" | "scheduled_canary" | "system";
  sourceKind: "provider_surface" | "controlled_probe" | "scheduled_canary";
  sourceVersion: string;
  evidenceReference: string;
  idempotencyKey: string;
  observationRevision: number;
};

export type CapabilityRecordResult =
  | { recorded: true; observationRevision: number }
  | { recorded: false; reasonCode: string };

export type CapabilityResolution = {
  decision: ProviderUploadCapabilityDecision;
  observationRevision: number | null;
  reasonCode: string;
};

function emit(sink: TelemetrySink | undefined, event: CapabilityTelemetry): void {
  try {
    sink?.(event);
  } catch {
    // Telemetry cannot change the service-boundary decision.
  }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
  // Date.parse normalizes impossible dates such as February 30. Validate the
  // written calendar before parsing the offset; retain its original precision.
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeScope(scope: Pick<ProviderUploadCapabilityEnvelope, "provider" | "route" | "surface" | "revision">): boolean {
  if (!scope || typeof scope.provider !== "string" || typeof scope.route !== "string" ||
      typeof scope.surface !== "string" || typeof scope.revision !== "string") return false;
  return SLUG.test(scope.provider) && SLUG.test(scope.route) &&
    SLUG.test(scope.surface) && SLUG.test(scope.revision);
}

function canonicalTokens(input: unknown, pattern: RegExp): input is string[] {
  if (!Array.isArray(input) || input.length > 32 ||
      !input.every((token) => typeof token === "string" && pattern.test(token))) return false;
  return new Set(input).size === input.length &&
    input.every((token, index) => index === 0 || input[index - 1] < token);
}

function denied(reasonCode: string, sink?: TelemetrySink, state: CapabilityTelemetry["state"] = "invalid"): CapabilityResolution {
  emit(sink, { reasonCode, state, revision: null });
  let classification: ProviderUploadCapabilityDecision["classification"] = "ambiguous_input";
  if (state === "missing") {
    classification = "observation_missing";
  } else if (state === "stale") {
    classification = "observation_stale";
  }
  return {
    decision: {
      contractVersion: PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION,
      classification,
      allowedExtensions: [],
      reportedAddedExtensions: [],
      reportedRemovedExtensions: [],
      evidenceRefs: [],
      normalizedObservedMimeTypes: [],
      reason: reasonCode,
    },
    observationRevision: null,
    reasonCode,
  };
}

function validRecord(input: CapabilityRecordInput): boolean {
  if (!input || typeof input !== "object") return false;
  const observedAt = timestamp(input.observedAt);
  const expiresAt = timestamp(input.expiresAt);
  if (!safeScope(input) || !RECORD_STATES.has(input.state) ||
      observedAt === null || expiresAt === null || expiresAt <= observedAt ||
      expiresAt - observedAt > 26 * 60 * 60 * 1000 || observedAt > Date.now() + 5 * 60 * 1000 ||
      typeof input.sourceVersion !== "string" || !SLUG.test(input.sourceVersion) ||
      typeof input.evidenceReference !== "string" || !EVIDENCE_REFERENCE.test(input.evidenceReference) ||
      typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      /^[a-f0-9]{32,}$/.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.observationRevision) || input.observationRevision <= 0 ||
      !["worker", "operator", "scheduled_canary", "system"].includes(input.actorKind) ||
      !["provider_surface", "controlled_probe", "scheduled_canary"].includes(input.sourceKind) ||
      !Array.isArray(input.extensions) || input.extensions.length > 32 ||
      !Array.isArray(input.mimeTypes) || input.mimeTypes.length > 32) return false;
  if (input.state !== "fresh") return input.extensions.length === 0 &&
    input.mimeTypes.length === 0 && input.acceptAttributePresent === null;
  return typeof input.acceptAttributePresent === "boolean";
}

/** Append one bounded observation through the OVD-513 service-only RPC. */
export async function recordProviderUploadCapabilityObservation(
  supabase: SupabaseClient,
  input: CapabilityRecordInput,
  telemetry?: TelemetrySink,
): Promise<CapabilityRecordResult> {
  if (!validRecord(input)) {
    emit(telemetry, { reasonCode: "record_invalid_input", state: "invalid", revision: null });
    return { recorded: false, reasonCode: "record_invalid_input" };
  }
  let extensions: string[];
  let mimeTypes: string[];
  try {
    extensions = normalizeProviderUploadExtensions(input.extensions);
    mimeTypes = normalizeProviderUploadMimeTypes(input.mimeTypes);
    if (!canonicalTokens(extensions, EXTENSION) || !canonicalTokens(mimeTypes, MIME)) {
      throw new TypeError("invalid formats");
    }
  } catch {
    emit(telemetry, { reasonCode: "record_invalid_input", state: "invalid", revision: null });
    return { recorded: false, reasonCode: "record_invalid_input" };
  }

  try {
    const { data, error } = await supabase.rpc("api_record_capability_observation", {
      p_provider: input.provider,
      p_capability: "provider_upload",
      p_route: input.route,
      p_surface: input.surface,
      p_surface_revision: input.revision,
      p_contract_version: PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION,
      p_observation_state: input.state,
      p_observed_extensions: extensions,
      p_observed_mime_types: mimeTypes,
      p_accept_attribute_present: input.acceptAttributePresent,
      p_observed_at: input.observedAt,
      p_expires_at: input.expiresAt,
      p_actor_kind: input.actorKind,
      p_source_kind: input.sourceKind,
      p_source_version: input.sourceVersion,
      p_evidence_reference: input.evidenceReference,
      p_idempotency_key: input.idempotencyKey,
      p_observation_revision: input.observationRevision,
    });
    if (error) {
      emit(telemetry, { reasonCode: "record_rpc_denied", state: "invalid", revision: null });
      return { recorded: false, reasonCode: "record_rpc_denied" };
    }
    if (!Number.isSafeInteger(data) || data !== input.observationRevision) {
      emit(telemetry, { reasonCode: "record_invalid_response", state: "invalid", revision: null });
      return { recorded: false, reasonCode: "record_invalid_response" };
    }
    emit(telemetry, { reasonCode: "recorded", state: input.state, revision: data as number });
    return { recorded: true, observationRevision: data as number };
  } catch {
    emit(telemetry, { reasonCode: "record_transport_error", state: "invalid", revision: null });
    return { recorded: false, reasonCode: "record_transport_error" };
  }
}

function parseNonCurrentRow(row: Record<string, unknown>): string {
  if (row.contract_version !== null || row.observation_revision !== null ||
      !canonicalTokens(row.observed_extensions, EXTENSION) ||
      !canonicalTokens(row.observed_mime_types, MIME) ||
      (row.observed_extensions as string[]).length > 0 ||
      (row.observed_mime_types as string[]).length > 0 ||
      row.accept_attribute_present !== null) return "resolver_invalid_response";
  if (row.freshness === "missing" && row.observation_state === "missing") return "resolver_missing";
  if (row.freshness === "stale" && row.observation_state === "stale") return "resolver_stale";
  if (row.freshness === "ambiguous" && row.observation_state === "ambiguous") return "resolver_ambiguous";
  if (row.freshness === "malformed" && row.observation_state === "ambiguous") return "resolver_malformed";
  return "resolver_invalid_response";
}

function parseCurrentRow(
  data: unknown,
  release: ProviderUploadCapabilityEnvelope,
  now: number,
): { state: ProviderUploadCapabilityObservedState; extensions: string[]; mimeTypes: string[]; acceptAttributePresent: boolean; revision: number } | string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "resolver_invalid_response";
  const row = data as Record<string, unknown>;
  if (Object.keys(row).length !== RESOLVER_KEYS.length ||
      !RESOLVER_KEYS.every((key) => Object.hasOwn(row, key))) return "resolver_invalid_response";
  if (row.provider !== release.provider || row.capability !== "provider_upload" ||
      row.route !== release.route || row.surface !== release.surface ||
      row.surface_revision !== release.revision) return "resolver_scope_mismatch";
  if (row.freshness !== "current") return parseNonCurrentRow(row);
  if (!CURRENT_STATES.has(row.observation_state as string) ||
      row.contract_version !== PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION ||
      !Number.isSafeInteger(row.observation_revision) || (row.observation_revision as number) <= 0 ||
      !canonicalTokens(row.observed_extensions, EXTENSION) ||
      !canonicalTokens(row.observed_mime_types, MIME)) return "resolver_invalid_response";
  const observedAt = timestamp(row.observed_at);
  const expiresAt = timestamp(row.expires_at);
  if (observedAt === null || expiresAt === null || observedAt > now || expiresAt <= now ||
      expiresAt - observedAt > 26 * 60 * 60 * 1000) return "resolver_stale";
  if (row.observation_state === "fresh") {
    if (typeof row.accept_attribute_present !== "boolean") return "resolver_invalid_response";
  } else if (row.accept_attribute_present !== null ||
      (row.observed_extensions as string[]).length > 0 ||
      (row.observed_mime_types as string[]).length > 0) return "resolver_invalid_response";
  return {
    state: row.observation_state as ProviderUploadCapabilityObservedState,
    extensions: row.observed_extensions as string[],
    mimeTypes: row.observed_mime_types as string[],
    acceptAttributePresent: row.accept_attribute_present === true,
    revision: row.observation_revision as number,
  };
}

/** Read-only dependency; deliberately independent of an installed SDK class identity. */
export type CapabilityObservationReader = {
  rpc(name: "api_resolve_current_capability_observation", args: {
    p_provider: string;
    p_capability: "provider_upload";
    p_route: string;
    p_surface: string;
    p_surface_revision: string;
  }): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
};

/** Resolve exactly one sanitized current row, then reuse the pure child-1 decision. */
export async function resolveProviderUploadCapabilityObservation(
  supabase: CapabilityObservationReader,
  releaseEnvelope: ProviderUploadCapabilityEnvelope,
  admissionResolver: ProviderUploadCapabilityAdmissionResolverResult,
  telemetry?: TelemetrySink,
): Promise<CapabilityResolution> {
  if (!safeScope(releaseEnvelope)) return denied("resolver_invalid_scope", telemetry);
  try {
    const { data, error } = await supabase.rpc("api_resolve_current_capability_observation", {
      p_provider: releaseEnvelope.provider,
      p_capability: "provider_upload",
      p_route: releaseEnvelope.route,
      p_surface: releaseEnvelope.surface,
      p_surface_revision: releaseEnvelope.revision,
    }).maybeSingle();
    if (error) return denied("resolver_rpc_denied", telemetry);
    const parsed = parseCurrentRow(data, releaseEnvelope, Date.now());
    if (typeof parsed === "string") {
      let state: CapabilityTelemetry["state"] = "invalid";
      if (parsed === "resolver_missing") {
        state = "missing";
      } else if (parsed === "resolver_stale") {
        state = "stale";
      }
      return denied(parsed, telemetry, state);
    }
    const decision = decideProviderUploadCapability({
      releaseEnvelope,
      admissionResolver,
      observed: {
        state: parsed.state,
        provider: releaseEnvelope.provider,
        route: releaseEnvelope.route,
        surface: releaseEnvelope.surface,
        revision: releaseEnvelope.revision,
        extensions: parsed.extensions,
        mimeTypes: parsed.mimeTypes,
        acceptAttributePresent: parsed.acceptAttributePresent,
      },
    });
    const reasonCode = decision.classification;
    emit(telemetry, { reasonCode, state: parsed.state, revision: parsed.revision });
    return { decision, observationRevision: parsed.revision, reasonCode };
  } catch {
    return denied("resolver_transport_error", telemetry);
  }
}
