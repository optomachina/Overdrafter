import type {
  ProviderUploadCapabilityAdmissionResolverResult,
  ProviderUploadCapabilityClassification,
  ProviderUploadCapabilityDecision,
  ProviderUploadCapabilityEnvelope,
  ProviderUploadCapabilityObserved,
} from "./providerUploadCapabilityTypes.js";

const SAFE_EXTENSION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PUBLIC_EVIDENCE_REFERENCE = /^issue:OVD-[1-9]\d{0,9}$/;
const ADMISSION_EVIDENCE_REFERENCE = /^OVD-[1-9]\d{0,9}$/;

/** Stable schema version for provider-neutral capability decisions. */
export const PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION = "provider-upload-capability.v1" as const;

/** Exact reviewed Xometry surface permitted to use the missing-accept fallback. */
export const REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY = {
  provider: "xometry",
  route: "quote_home",
  surface: "account_quote_modal",
  revision: "xometry-account-quote-modal.v1",
} as const;

function uniqueSorted(values: string[]): string[] {
  // NOSONAR: capability decisions need locale-independent code-point ordering.
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Normalize provider file extensions without permitting paths or compound suffixes. */
export function normalizeProviderUploadExtensions(input: unknown): string[] {
  if (!Array.isArray(input)) throw new TypeError("extensions must be an array");
  const normalized: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") throw new TypeError("extension must be a string");
    const token = value.trim().toLowerCase();
    const withoutDot = token.startsWith(".") ? token.slice(1) : token;
    if (!SAFE_EXTENSION.test(withoutDot)) throw new TypeError("unsafe extension");
    normalized.push(withoutDot);
  }
  return uniqueSorted(normalized);
}

/** Normalize MIME types independently from extension policy. Parameters are rejected. */
export function normalizeProviderUploadMimeTypes(input: unknown): string[] {
  if (!Array.isArray(input)) throw new TypeError("MIME types must be an array");
  const normalized: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") throw new TypeError("MIME type must be a string");
    const token = value.trim().toLowerCase();
    if (!SAFE_MIME.test(token)) throw new TypeError("unsafe MIME type");
    normalized.push(token);
  }
  return uniqueSorted(normalized);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

function safePublicEvidence(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return [];
  const refs = value.filter(
    (ref): ref is string => typeof ref === "string" && PUBLIC_EVIDENCE_REFERENCE.test(ref),
  );
  return uniqueSorted(refs);
}

function sameEnvelope(a: Pick<ProviderUploadCapabilityEnvelope, "provider" | "route" | "surface" | "revision">, b: Pick<ProviderUploadCapabilityEnvelope, "provider" | "route" | "surface" | "revision">): boolean {
  return a.provider === b.provider && a.route === b.route && a.surface === b.surface && a.revision === b.revision;
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

const APPROVED_PERMISSION_BASES = new Set([
  "provider_terms_allow_automation",
  "written_provider_authorization",
]);
const APPROVED_SESSION_OWNERS = new Set([
  "overdrafter_managed",
  "provider_api",
  "customer_managed",
]);

function hasCurrentAdmissionFacts(
  resolver: ProviderUploadCapabilityAdmissionResolverResult,
  release: ProviderUploadCapabilityEnvelope,
): boolean {
  if (
    resolver.policy_present !== true ||
    resolver.provider_admitted !== true ||
    !validIdentifier(resolver.provider) ||
    typeof resolver.admission_state !== "string" ||
    typeof resolver.policy_revision !== "string" ||
    typeof resolver.evidence_reference !== "string" ||
    !Array.isArray(resolver.supported_processes) ||
    resolver.supported_processes.length === 0 ||
    typeof resolver.reviewed_at !== "string" ||
    !Number.isFinite(Date.parse(resolver.reviewed_at)) ||
    typeof resolver.reason_code !== "string" ||
    resolver.provider !== release.provider ||
    resolver.policy_revision !== release.policyRevision ||
    resolver.evidence_reference !== release.evidenceReference ||
    resolver.reviewed_at === null ||
    !validIdentifier(release.policyRevision) ||
    !ADMISSION_EVIDENCE_REFERENCE.test(release.evidenceReference)
  ) {
    return false;
  }

  if (resolver.expires_at === null) return true;
  const expiry = Date.parse(resolver.expires_at);
  return Number.isFinite(expiry) && expiry > Date.now();
}

function isCurrentXometryControlledBetaAdmission(
  resolver: ProviderUploadCapabilityAdmissionResolverResult,
  release: ProviderUploadCapabilityEnvelope,
): boolean {
  return hasCurrentAdmissionFacts(resolver, release) &&
    resolver.generically_dispatchable === false &&
    resolver.provider === "xometry" &&
    resolver.admission_state === "controlled_beta_only" &&
    resolver.reason_code === "controlled_beta_only" &&
    resolver.permission_basis === "existing_controlled_beta_path" &&
    resolver.session_owner === "overdrafter_managed" &&
    resolver.supported_processes.includes("cnc_milling");
}

function isCurrentApprovedAdmission(
  resolver: ProviderUploadCapabilityAdmissionResolverResult,
  release: ProviderUploadCapabilityEnvelope,
): boolean {
  return hasCurrentAdmissionFacts(resolver, release) &&
    resolver.generically_dispatchable === true &&
    resolver.admission_state === "approved" &&
    resolver.reason_code === "provider_approved" &&
    APPROVED_PERMISSION_BASES.has(resolver.permission_basis ?? "") &&
    APPROVED_SESSION_OWNERS.has(resolver.session_owner ?? "");
}

function isCurrentAdmission(
  resolver: ProviderUploadCapabilityAdmissionResolverResult,
  release: ProviderUploadCapabilityEnvelope,
): boolean {
  return isCurrentXometryControlledBetaAdmission(resolver, release) ||
    isCurrentApprovedAdmission(resolver, release);
}

function admissionClassification(
  resolver: ProviderUploadCapabilityAdmissionResolverResult,
  release: ProviderUploadCapabilityEnvelope,
): ProviderUploadCapabilityClassification {
  if (!resolver.policy_present || resolver.reason_code === "provider_unknown") return "observation_missing";
  if (resolver.reason_code === "policy_expired") return "observation_stale";
  if (resolver.reason_code === "policy_incomplete") return "denied";
  if (
    resolver.provider !== release.provider ||
    resolver.policy_revision !== release.policyRevision ||
    resolver.evidence_reference !== release.evidenceReference
  ) {
    return "route_or_selector_drift";
  }
  return "denied";
}

function emptyDecision(
  classification: ProviderUploadCapabilityClassification,
  reason: string,
  diagnostic?: string,
  evidenceRefs: string[] = [],
): ProviderUploadCapabilityDecision {
  return {
    contractVersion: PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION,
    classification,
    allowedExtensions: [],
    reportedAddedExtensions: [],
    reportedRemovedExtensions: [],
    reason,
    diagnostic,
    evidenceRefs,
    normalizedObservedMimeTypes: [],
  };
}

type NormalizedCapabilityInput = {
  release: ProviderUploadCapabilityEnvelope;
  admissionExtensions: string[];
  observedExtensions: string[];
  evidenceRefs: string[];
  normalizedObservedMimeTypes: string[];
};

function normalizeCapabilityInput(input: {
  releaseEnvelope: ProviderUploadCapabilityEnvelope;
  admissionResolver: ProviderUploadCapabilityAdmissionResolverResult;
  observed: ProviderUploadCapabilityObserved;
}): NormalizedCapabilityInput {
  const evidenceRefs = safePublicEvidence(input.observed.evidenceRefs);
  const normalizedObservedMimeTypes = input.observed.mimeTypes === undefined
    ? []
    : normalizeProviderUploadMimeTypes(input.observed.mimeTypes);
  for (const envelope of [input.releaseEnvelope, input.observed]) {
    if (!validIdentifier(envelope.provider) || !validIdentifier(envelope.route) || !validIdentifier(envelope.surface) || !validIdentifier(envelope.revision)) {
      throw new TypeError("invalid identity");
    }
  }
  if (typeof input.observed.acceptAttributePresent !== "boolean") throw new TypeError("invalid capability boolean");
  return {
    release: { ...input.releaseEnvelope, extensions: normalizeProviderUploadExtensions(input.releaseEnvelope.extensions) },
    admissionExtensions: normalizeProviderUploadExtensions(input.admissionResolver.accepted_file_extensions),
    observedExtensions: input.observed.extensions === undefined ? [] : normalizeProviderUploadExtensions(input.observed.extensions),
    evidenceRefs,
    normalizedObservedMimeTypes,
  };
}

function decisionForObservedState(
  observed: ProviderUploadCapabilityObserved,
  evidenceRefs: string[],
  normalizedObservedMimeTypes: string[],
): ProviderUploadCapabilityDecision | undefined {
  if (observed.state === "fresh") return undefined;
  const states: Record<Exclude<ProviderUploadCapabilityObserved["state"], "fresh">, ProviderUploadCapabilityClassification> = {
    missing: "observation_missing", stale: "observation_stale", ambiguous: "ambiguous_input", loading: "formats_loading",
    route_or_selector_drift: "route_or_selector_drift", authentication_required: "authentication_required",
    anti_bot_or_challenge: "anti_bot_or_challenge", provider_error: "provider_error", unclassified_response: "unclassified_response",
  };
  if (!Object.hasOwn(states, observed.state)) throw new TypeError("invalid observed state");
  return {
    ...emptyDecision(states[observed.state], `observed provider state: ${observed.state}`, undefined, evidenceRefs),
    normalizedObservedMimeTypes,
  };
}

function decisionForMissingAccept(
  resolver: ProviderUploadCapabilityAdmissionResolverResult,
  release: ProviderUploadCapabilityEnvelope,
  observed: ProviderUploadCapabilityObserved,
  evidenceRefs: string[],
  normalizedObservedMimeTypes: string[],
): ProviderUploadCapabilityDecision | undefined {
  if (observed.acceptAttributePresent) return undefined;
  const reviewedXometry = isCurrentXometryControlledBetaAdmission(resolver, release) &&
    sameEnvelope(release, REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY) &&
    sameEnvelope(observed, REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY);
  if (reviewedXometry) return undefined;
  return {
    ...emptyDecision("accept_missing", "provider accept input is missing", undefined, evidenceRefs),
    normalizedObservedMimeTypes,
  };
}

function decideExtensions(
  resolver: ProviderUploadCapabilityAdmissionResolverResult,
  release: ProviderUploadCapabilityEnvelope,
  observed: ProviderUploadCapabilityObserved,
  normalized: NormalizedCapabilityInput,
): ProviderUploadCapabilityDecision {
  const policy = release.extensions.filter((extension) => normalized.admissionExtensions.includes(extension));
  if (policy.length === 0) return { ...emptyDecision("unsupported", "release and admission policies have no common extension", undefined, normalized.evidenceRefs), normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
  const added = difference(normalized.observedExtensions, policy);
  const removed = difference(policy, normalized.observedExtensions);
  const allowed = normalized.observedExtensions.filter((extension) => policy.includes(extension));
  const reviewedXometry = isCurrentXometryControlledBetaAdmission(resolver, release) &&
    sameEnvelope(release, REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY) &&
    sameEnvelope(observed, REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY);
  if (!observed.acceptAttributePresent && reviewedXometry && observed.extensions === undefined) {
    return { contractVersion: PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION, classification: "reviewed_missing_accept_xometry", allowedExtensions: policy, reportedAddedExtensions: [], reportedRemovedExtensions: [], evidenceRefs: normalized.evidenceRefs, normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
  }
  if (added.length > 0) return { contractVersion: PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION, classification: "format_added", allowedExtensions: allowed, reportedAddedExtensions: added, reportedRemovedExtensions: removed, evidenceRefs: normalized.evidenceRefs, normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
  if (removed.length > 0) return { contractVersion: PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION, classification: "format_removed", allowedExtensions: allowed, reportedAddedExtensions: [], reportedRemovedExtensions: removed, evidenceRefs: normalized.evidenceRefs, normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
  if (allowed.length === 0) return { ...emptyDecision("ambiguous_input", "no exact extension intersection", undefined, normalized.evidenceRefs), normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
  const classification = !observed.acceptAttributePresent && reviewedXometry
    ? "reviewed_missing_accept_xometry"
    : "matches_policy";
  return { contractVersion: PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION, classification, allowedExtensions: allowed, reportedAddedExtensions: [], reportedRemovedExtensions: [], evidenceRefs: normalized.evidenceRefs, normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
}

/**
 * Resolve the provider upload contract. This is pure: it performs no provider,
 * network, storage, or configuration access and always fails closed.
 */
export function decideProviderUploadCapability(input: {
  releaseEnvelope: ProviderUploadCapabilityEnvelope;
  admissionResolver: ProviderUploadCapabilityAdmissionResolverResult;
  observed: ProviderUploadCapabilityObserved;
}): ProviderUploadCapabilityDecision {
  try {
    const normalized = normalizeCapabilityInput(input);
    if (!sameEnvelope(normalized.release, input.observed)) return { ...emptyDecision("route_or_selector_drift", "provider route, surface, or revision drifted", undefined, normalized.evidenceRefs), normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
    if (!isCurrentAdmission(input.admissionResolver, normalized.release)) return { ...emptyDecision(admissionClassification(input.admissionResolver, normalized.release), "current admitted policy is required", undefined, normalized.evidenceRefs), normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
    const observedStateDecision = decisionForObservedState(input.observed, normalized.evidenceRefs, normalized.normalizedObservedMimeTypes);
    if (observedStateDecision) return observedStateDecision;
    const missingAcceptDecision = decisionForMissingAccept(input.admissionResolver, normalized.release, input.observed, normalized.evidenceRefs, normalized.normalizedObservedMimeTypes);
    if (missingAcceptDecision) return missingAcceptDecision;
    if (input.observed.acceptAttributePresent && input.observed.extensions === undefined) return { ...emptyDecision("ambiguous_input", "fresh provider observation omitted extensions", undefined, normalized.evidenceRefs), normalizedObservedMimeTypes: normalized.normalizedObservedMimeTypes };
    return decideExtensions(input.admissionResolver, normalized.release, input.observed, normalized);
  } catch {
    return emptyDecision("ambiguous_input", "capability input is malformed");
  }
}

export const resolveProviderUploadCapability = decideProviderUploadCapability;
