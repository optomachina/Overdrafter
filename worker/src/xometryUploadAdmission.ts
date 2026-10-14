import type { SupabaseClient } from "@supabase/supabase-js";
import { PROVIDER_KILL_SWITCH_TIMEOUT_MS } from "./providerKillSwitch.js";
import {
  decideProviderUploadCapability,
  PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION,
} from "./providerUploadCapability.js";
import type {
  ProviderUploadCapabilityAdmissionResolverResult,
  ProviderUploadCapabilityClassification,
  ProviderUploadCapabilityDecision,
  ProviderUploadCapabilityObserved,
} from "./providerUploadCapabilityTypes.js";
import type { VendorQuoteAdapterInput } from "./types.js";

/**
 * OVD-414 production wiring for the Xometry upload capability checkpoint.
 *
 * The admission result is read from the database on every checkpoint through
 * the service-role RPC `api_worker_resolve_xometry_admission` (draft:
 * docs/migration-drafts/ovd-414-service-admission-read.sql) and fed to the
 * shared `decideProviderUploadCapability`. Nothing is cached.
 *
 * Fail closed: an RPC error, a missing function, an empty or malformed
 * response, or a read slower than the kill-switch read timeout yields a
 * denying classification only. No database or provider detail is carried.
 */

export const XOMETRY_ADMISSION_RPC = "api_worker_resolve_xometry_admission";
export const XOMETRY_ADMISSION_SCHEMA = "xometry-admission-read.v1" as const;

const ADMISSION_KEYS = [
  "schema", "policy_present", "provider_admitted", "generically_dispatchable", "provider",
  "admission_state", "policy_revision", "evidence_reference", "permission_basis",
  "supported_processes", "accepted_file_extensions", "session_owner", "reviewed_at",
  "expires_at", "reason_code",
] as const;

/** Returns the raw RPC payload; throws on any transport or SQL error. */
export type XometryAdmissionReader = () => Promise<unknown>;

export function supabaseXometryAdmissionReader(supabase: Pick<SupabaseClient, "rpc">): XometryAdmissionReader {
  return async () => {
    const { data, error } = await supabase.rpc(XOMETRY_ADMISSION_RPC);
    if (error) throw new Error("xometry admission read failed");
    return data;
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Strict parse. Anything but the exact v1 shape is malformed (null). */
export function parseXometryAdmission(data: unknown): ProviderUploadCapabilityAdmissionResolverResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (Object.getPrototypeOf(data) !== Object.prototype) return null;
  const keys = Object.keys(data);
  if (keys.length !== ADMISSION_KEYS.length || !ADMISSION_KEYS.every((key) => keys.includes(key))) return null;
  const row = data as Record<(typeof ADMISSION_KEYS)[number], unknown>;
  if (
    row.schema !== XOMETRY_ADMISSION_SCHEMA ||
    typeof row.policy_present !== "boolean" ||
    typeof row.provider_admitted !== "boolean" ||
    typeof row.generically_dispatchable !== "boolean" ||
    typeof row.admission_state !== "string" ||
    typeof row.reason_code !== "string" ||
    !isNullableString(row.provider) ||
    !isNullableString(row.policy_revision) ||
    !isNullableString(row.evidence_reference) ||
    !isNullableString(row.permission_basis) ||
    !isNullableString(row.session_owner) ||
    !isNullableString(row.reviewed_at) ||
    !isNullableString(row.expires_at) ||
    !isStringArray(row.supported_processes) ||
    !isStringArray(row.accepted_file_extensions)
  ) {
    return null;
  }
  return {
    policy_present: row.policy_present,
    provider_admitted: row.provider_admitted,
    generically_dispatchable: row.generically_dispatchable,
    provider: row.provider,
    admission_state: row.admission_state,
    policy_revision: row.policy_revision,
    evidence_reference: row.evidence_reference,
    permission_basis: row.permission_basis,
    supported_processes: row.supported_processes,
    accepted_file_extensions: row.accepted_file_extensions,
    session_owner: row.session_owner,
    reviewed_at: row.reviewed_at,
    expires_at: row.expires_at,
    reason_code: row.reason_code,
  };
}

function denial(classification: ProviderUploadCapabilityClassification): ProviderUploadCapabilityDecision {
  return {
    contractVersion: PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION,
    classification,
    allowedExtensions: [],
    reportedAddedExtensions: [],
    reportedRemovedExtensions: [],
    evidenceRefs: [],
    normalizedObservedMimeTypes: [],
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("xometry admission read timed out")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Builds the checkpoint the Xometry adapter awaits before file selection.
 *
 * The release envelope is built from the facts the admission result carries
 * (policy revision, evidence reference, accepted extensions) and the adapter's
 * own surface identity. OVD-414 gap: no separately reviewed Xometry release
 * envelope exists to pin those values, so the check binds to the database's
 * current admission rather than to a reviewed constant.
 */
export function createXometryUploadCapabilityCheckpoint(
  reader: XometryAdmissionReader,
  timeoutMs: number = PROVIDER_KILL_SWITCH_TIMEOUT_MS,
): NonNullable<VendorQuoteAdapterInput["uploadCapabilityCheckpoint"]> {
  return async (observed: ProviderUploadCapabilityObserved) => {
    let data: unknown;
    try {
      data = await withTimeout(Promise.resolve().then(reader), timeoutMs);
    } catch {
      return denial("observation_missing");
    }
    if (data === null || data === undefined) return denial("observation_missing");
    const admission = parseXometryAdmission(data);
    if (!admission) return denial("ambiguous_input");
    return decideProviderUploadCapability({
      releaseEnvelope: {
        provider: "xometry",
        route: observed.route,
        surface: observed.surface,
        revision: observed.revision,
        extensions: admission.accepted_file_extensions,
        policyRevision: admission.policy_revision ?? "",
        evidenceReference: admission.evidence_reference ?? "",
      },
      admissionResolver: admission,
      observed,
    });
  };
}
