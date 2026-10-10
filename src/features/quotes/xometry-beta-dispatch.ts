import type { Json } from "@/integrations/supabase/types";

export type XometryBetaModelUnits = "inch" | "millimeter";

/**
 * Providers with a customer-confirmed production dispatch path. Xometry keeps
 * its legacy controlled-beta RPCs; every other provider uses the generic
 * provider-dispatch RPCs (OVD-458/OVD-673), which stay default-deny until the
 * provider is admitted server-side.
 */
export type LiveDispatchProvider = "xometry" | "fictiv";

export const LIVE_DISPATCH_PROVIDER_LABELS: Readonly<Record<LiveDispatchProvider, string>> = {
  xometry: "Xometry",
  fictiv: "Fictiv",
};

export function isLiveDispatchProvider(value: unknown): value is LiveDispatchProvider {
  return value === "xometry" || value === "fictiv";
}

export type XometryBetaDispatchFile = {
  fileId: string;
  sha256: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
};

export type XometryBetaDispatchScope = {
  organizationId: string;
  jobId: string;
  partId: string;
  provider: LiveDispatchProvider;
  requestedQuantity: number;
  scopeVersion: number;
  scopeFingerprint: string;
  declaredModelUnits: XometryBetaModelUnits;
  /** Founding Beta notice revision (`noticeRevision` on the generic contract). */
  policyRevision: string;
  envelopeRevision: string;
  scope: {
    schema: "quote-lane-scope.v1";
    vendor: LiveDispatchProvider;
    quantity: number;
    destination: {
      confirmationRevision: string;
      state: "confirmed";
      street: string;
      city: string;
      region: string | null;
      postalCode: string;
      country: string;
    };
    part: {
      id: string;
      cad: XometryBetaDispatchFile;
      drawing: XometryBetaDispatchFile | null;
    };
    requirements: {
      id: string;
      capturedAt: string;
      description: string | null;
      partNumber: string | null;
      revision: string | null;
      material: string;
      finish: string | null;
      tightestToleranceInch: number;
      requestedDeliveryDate: string | null;
      specification: Record<string, Json | undefined>;
    };
  };
};

/** Provider-neutral name for the parsed confirmation scope. */
export type ProviderDispatchScope = XometryBetaDispatchScope;

export type XometryBetaDispatchResult = {
  accepted: true;
  created: boolean;
  deduplicated: boolean;
  permitId: string;
  quoteRequestId: string;
  quoteRunId: string;
  scopeFingerprint: string;
  status: "queued";
};

export type XometryBetaDispatchFailure = {
  accepted: false;
  created: false;
  diagnosticCode: XometryBetaDispatchDiagnosticCode;
  status: "denied" | "unknown";
};

export type XometryBetaDispatchDiagnosticCode =
  | "explicit_server_denial"
  | "invalid_server_response"
  | "network_failure"
  | "postgrest_failure"
  | "unknown_failure";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeUnavailable(provider: LiveDispatchProvider): TypeError {
  return new TypeError(`The ${LIVE_DISPATCH_PROVIDER_LABELS[provider]} confirmation scope is unavailable.`);
}

function requireString(record: Record<string, unknown>, key: string, provider: LiveDispatchProvider): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw scopeUnavailable(provider);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, provider: LiveDispatchProvider): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw scopeUnavailable(provider);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, provider: LiveDispatchProvider): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw scopeUnavailable(provider);
  }
  return value;
}

function parseFile(value: unknown, provider: LiveDispatchProvider): XometryBetaDispatchFile {
  if (!isRecord(value)) {
    throw scopeUnavailable(provider);
  }

  const sha256 = requireString(value, "sha256", provider);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw scopeUnavailable(provider);
  }

  const sizeBytes = value.sizeBytes;
  if (
    sizeBytes !== null &&
    (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
  ) {
    throw scopeUnavailable(provider);
  }

  return {
    fileId: requireString(value, "fileId", provider),
    sha256,
    name: requireString(value, "name", provider),
    mimeType: optionalString(value, "mimeType", provider),
    sizeBytes: sizeBytes as number | null,
  };
}

/** Parses the server-authored legacy Xometry disclosure contract and fails closed on drift. */
export function parseXometryBetaDispatchScope(value: unknown): XometryBetaDispatchScope {
  return parseProviderDispatchScope(value, "xometry");
}

/**
 * Parses the disclosure contract for exactly `provider` and fails closed on
 * drift. Xometry uses the legacy preview (`policyRevision`); every other
 * provider uses `provider-dispatch-scope.v1`, whose `noticeRevision` is carried
 * as `policyRevision` so the confirmation flow stays provider-neutral.
 */
export function parseProviderDispatchScope(
  value: unknown,
  provider: LiveDispatchProvider,
): ProviderDispatchScope {
  const p = provider;
  if (!isRecord(value) || !isRecord(value.scope)) {
    throw scopeUnavailable(p);
  }

  const scope = value.scope;
  if (!isRecord(scope.part) || !isRecord(scope.requirements) || !isRecord(scope.destination)) {
    throw scopeUnavailable(p);
  }

  const genericContract = p !== "xometry";
  if (genericContract && value.schema !== "provider-dispatch-scope.v1") {
    throw scopeUnavailable(p);
  }
  const scopeProvider = requireString(value, "provider", p);
  const schema = requireString(scope, "schema", p);
  const scopeVendor = requireString(scope, "vendor", p);
  const declaredModelUnits = requireString(value, "declaredModelUnits", p);
  if (
    scopeProvider !== p ||
    scopeVendor !== p ||
    schema !== "quote-lane-scope.v1" ||
    (declaredModelUnits !== "inch" && declaredModelUnits !== "millimeter")
  ) {
    throw scopeUnavailable(p);
  }

  const quantity = requireNumber(scope, "quantity", p);
  const requestedQuantity = requireNumber(value, "requestedQuantity", p);
  const scopeVersion = requireNumber(value, "scopeVersion", p);
  const scopeFingerprint = requireString(value, "scopeFingerprint", p);
  const partId = requireString(value, "partId", p);
  const nestedPartId = requireString(scope.part, "id", p);
  const requirements = scope.requirements;
  const specification = requirements.specification;
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity !== requestedQuantity ||
    !Number.isSafeInteger(scopeVersion) ||
    scopeVersion <= 0 ||
    !/^[a-f0-9]{64}$/.test(scopeFingerprint) ||
    partId !== nestedPartId ||
    !isRecord(specification)
  ) {
    throw scopeUnavailable(p);
  }

  const drawing = scope.part.drawing;
  const destination = scope.destination;
  if (destination.state !== "confirmed") {
    throw scopeUnavailable(p);
  }
  const country = requireString(destination, "country", p);
  const region = optionalString(destination, "region", p);
  if (country === "US" && (!region || region.trim().length === 0)) {
    throw scopeUnavailable(p);
  }
  const confirmationRevision = requireString(destination, "confirmationRevision", p);
  if (!/^[1-9]\d*$/.test(confirmationRevision)) {
    throw scopeUnavailable(p);
  }
  const confirmedDestination = {
    confirmationRevision,
    state: "confirmed" as const,
    street: requireString(destination, "street", p),
    city: requireString(destination, "city", p),
    region,
    postalCode: requireString(destination, "postalCode", p),
    country,
  };
  const material = requireString(requirements, "material", p);
  const tolerance = requireNumber(requirements, "tightestToleranceInch", p);
  if (tolerance < 0) {
    throw scopeUnavailable(p);
  }

  return {
    organizationId: requireString(value, "organizationId", p),
    jobId: requireString(value, "jobId", p),
    partId,
    provider: p,
    requestedQuantity,
    scopeVersion,
    scopeFingerprint,
    declaredModelUnits,
    policyRevision: requireString(value, genericContract ? "noticeRevision" : "policyRevision", p),
    envelopeRevision: requireString(value, "envelopeRevision", p),
    scope: {
      schema: "quote-lane-scope.v1",
      vendor: p,
      quantity,
      destination: confirmedDestination,
      part: {
        id: nestedPartId,
        cad: parseFile(scope.part.cad, p),
        drawing: drawing === null ? null : parseFile(drawing, p),
      },
      requirements: {
        id: requireString(requirements, "id", p),
        capturedAt: requireString(requirements, "capturedAt", p),
        description: optionalString(requirements, "description", p),
        partNumber: optionalString(requirements, "partNumber", p),
        revision: optionalString(requirements, "revision", p),
        material,
        finish: optionalString(requirements, "finish", p),
        tightestToleranceInch: tolerance,
        requestedDeliveryDate: optionalString(requirements, "requestedDeliveryDate", p),
        specification: specification as Record<string, Json | undefined>,
      },
    },
  };
}

/** Parses the atomic dispatch response and rejects anything short of a queued permit. */
export function parseXometryBetaDispatchResult(value: unknown): XometryBetaDispatchResult {
  return parseProviderDispatchResult(value, "xometry");
}

/** Parses either admission path's response; a generic response must name `provider`. */
export function parseProviderDispatchResult(
  value: unknown,
  provider: LiveDispatchProvider,
): XometryBetaDispatchResult {
  const notQueued = () => new Error(`The ${LIVE_DISPATCH_PROVIDER_LABELS[provider]} quote request was not queued.`);
  if (!isRecord(value) || value.accepted !== true || value.status !== "queued") {
    throw notQueued();
  }
  if (provider !== "xometry" && value.provider !== provider) {
    throw notQueued();
  }

  return {
    accepted: true,
    created: value.created === true,
    deduplicated: value.deduplicated === true,
    permitId: requireString(value, "permitId", provider),
    quoteRequestId: requireString(value, "quoteRequestId", provider),
    quoteRunId: requireString(value, "quoteRunId", provider),
    scopeFingerprint: requireString(value, "scopeFingerprint", provider),
    status: "queued",
  };
}

function getFailureRecord(error: unknown): Record<string, unknown> | null {
  return isRecord(error) ? error : null;
}

function getFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const message = getFailureRecord(error)?.message;
  return typeof message === "string" ? message : "";
}

/**
 * Exact refusals raised by the generic admission path (OVD-458/628). Listed
 * one by one so a lookalike or internal-invariant code (for example
 * provider_dispatch_created_lane_mismatch) stays an unconfirmed outcome.
 */
const GENERIC_PROVIDER_DISPATCH_DENIALS = [
  "admission_disabled",
  "admission_evidence_missing",
  "admission_expired",
  "affirmations_required",
  "approval_reference_required",
  "approval_reference_reused",
  "approved_requirements_required",
  "beta_access_required",
  "commercial_entitlement_required",
  "confirmed_destination_required",
  "drawing_not_admitted",
  "envelope_mismatch",
  "exact_scope_required",
  "exactly_one_part_required",
  "explicit_vendor_config_required",
  "job_busy",
  "manufacturing_quote_only",
  "new_lane_required",
  "notice_mismatch",
  "part_organization_mismatch",
  "permit_expired",
  "permit_revoked",
  "process_not_admitted",
  "provider_applicability_required",
  "provider_envelope_unknown",
  "provider_not_enabled",
  "provider_unknown",
  "requirement_organization_mismatch",
  "rollout_disabled",
  "scope_mismatch",
  "special_requirements_not_supported",
  "specialized_path_required",
  "trusted_cad_required",
] as const;
const GENERIC_PROVIDER_DISPATCH_DENIAL = new RegExp(
  `\\bprovider_dispatch_(?:${GENERIC_PROVIDER_DISPATCH_DENIALS.join("|")})\\b`,
);

/** Identifies server-declared denials, including Supabase's plain PostgrestError objects. */
export function isExplicitXometryBetaDispatchDenial(error: unknown): boolean {
  const message = getFailureMessage(error);
  return (
    GENERIC_PROVIDER_DISPATCH_DENIAL.test(message) ||
    /xometry_beta_|Founding Beta access|permission to request quotes|Declared model units|dispatch affirmations|pro_required|rollout_disabled|automatic_quote_disabled|automatic_quote_unavailable|free_allowance_unavailable|free_policy_unavailable/.test(
      message,
    )
  );
}

/** A concurrent edit held one of the job's rows, so the server refused the admission without waiting. */
export function isXometryBetaJobBusy(error: unknown): boolean {
  return /\bxometry_beta_job_busy\b/.test(getFailureMessage(error));
}

/**
 * The same busy refusal from either admission path: the legacy Xometry RPC
 * (xometry_beta_job_busy) or the generic provider RPC (provider_dispatch_job_busy).
 */
export function isDispatchJobBusy(error: unknown): boolean {
  return /\b(?:xometry_beta|provider_dispatch)_job_busy\b/.test(getFailureMessage(error));
}

/**
 * Customer copy for an explicit dispatch denial. The busy copy never claims
 * that nothing was queued: it can answer a replay of an uncertain attempt.
 */
export function getXometryBetaDispatchDenialMessage(error: unknown): string {
  return isDispatchJobBusy(error)
    ? "This part is being updated in another session. Try again in a moment."
    : "The current package was not queued. Review the refreshed scope and try again.";
}

/** Returns bounded operator evidence without forwarding server messages or request data. */
export function getXometryBetaDispatchDiagnosticCode(
  error: unknown,
): XometryBetaDispatchDiagnosticCode {
  if (isExplicitXometryBetaDispatchDenial(error)) {
    return "explicit_server_denial";
  }

  if (/failed to fetch|network|load failed/i.test(getFailureMessage(error))) {
    return "network_failure";
  }

  if (error instanceof TypeError) {
    return "invalid_server_response";
  }

  const record = getFailureRecord(error);
  const code = record?.code;
  if (typeof code === "string" && code.length > 0) {
    return "postgrest_failure";
  }

  return "unknown_failure";
}

/**
 * Converts an RPC rejection into the fail-closed controller result contract.
 * A busy denial of an exact uncertain replay stays unknown: the first attempt's
 * outcome is still unconfirmed, so the same-reference recovery stays open.
 */
export function classifyXometryBetaDispatchFailure(
  error: unknown,
  options: { uncertainReplay?: boolean } = {},
): XometryBetaDispatchFailure {
  const keepsUncertainty = options.uncertainReplay === true && isDispatchJobBusy(error);
  return {
    accepted: false,
    created: false,
    diagnosticCode: getXometryBetaDispatchDiagnosticCode(error),
    status: isExplicitXometryBetaDispatchDenial(error) && !keepsUncertainty ? "denied" : "unknown",
  };
}

/** Converts scope failures to bounded customer copy without exposing database details. */
export function getXometryBetaScopeFailureMessage(
  error: unknown,
  provider: LiveDispatchProvider = "xometry",
): string {
  const label = LIVE_DISPATCH_PROVIDER_LABELS[provider];
  if (isExplicitXometryBetaDispatchDenial(error)) {
    return `This package is not currently eligible for controlled ${label} beta dispatch. Review its access, files, and manufacturing requirements.`;
  }
  return `The current ${label} confirmation scope could not be verified. Try the scope check again.`;
}
