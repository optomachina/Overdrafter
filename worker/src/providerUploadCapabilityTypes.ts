/** Closed vocabulary for provider upload capability decisions. */
export type ProviderUploadCapabilityClassification =
  | "matches_policy"
  | "format_added"
  | "format_removed"
  | "reviewed_missing_accept_xometry"
  | "accept_missing"
  | "unsupported"
  | "denied"
  | "observation_missing"
  | "observation_stale"
  | "formats_loading"
  | "ambiguous_input"
  | "route_or_selector_drift"
  | "authentication_required"
  | "anti_bot_or_challenge"
  | "provider_error"
  | "unclassified_response";

export type ProviderUploadCapabilityObservedState =
  | "fresh"
  | "missing"
  | "stale"
  | "ambiguous"
  | "loading"
  | "route_or_selector_drift"
  | "authentication_required"
  | "anti_bot_or_challenge"
  | "provider_error"
  | "unclassified_response";

export type ProviderUploadCapabilityEnvelope = {
  provider: string;
  route: string;
  surface: string;
  revision: string;
  extensions: string[];
  /** Exact OVD-379 revision expected by this reviewed release envelope. */
  policyRevision: string;
  /** Exact OVD-379 evidence reference expected by this reviewed release envelope. */
  evidenceReference: string;
};

/**
 * Private service-only result from private.resolve_quote_provider_admission_policy(text).
 * This mirrors the resolver's names instead of accepting caller assertions.
 */
export type ProviderUploadCapabilityAdmissionResolverResult = {
  policy_present: boolean;
  provider_admitted: boolean;
  generically_dispatchable: boolean;
  provider: string | null;
  admission_state: string;
  policy_revision: string | null;
  evidence_reference: string | null;
  permission_basis: string | null;
  supported_processes: string[];
  accepted_file_extensions: string[];
  session_owner: string | null;
  reviewed_at: string | null;
  expires_at: string | null;
  reason_code: string;
};

export type ProviderUploadCapabilityObserved = {
  state: ProviderUploadCapabilityObservedState;
  provider: string;
  route: string;
  surface: string;
  revision: string;
  extensions?: string[];
  mimeTypes?: string[];
  acceptAttributePresent: boolean;
  /** Provider response references only; never credentials, HTML, or raw payloads. */
  evidenceRefs?: string[];
};

export type ProviderUploadCapabilityDecision = {
  contractVersion: "provider-upload-capability.v1";
  classification: ProviderUploadCapabilityClassification;
  allowedExtensions: string[];
  reportedAddedExtensions: string[];
  reportedRemovedExtensions: string[];
  reason?: string;
  diagnostic?: string;
  evidenceRefs: string[];
  normalizedObservedMimeTypes: string[];
};
