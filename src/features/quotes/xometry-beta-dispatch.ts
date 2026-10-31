import type { Json, VendorName } from "@/integrations/supabase/types";
import { PROVIDER_CATALOG } from "@/features/quotes/generated/provider-catalog";

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

/** Label for any dispatch provider, including fan out targets beyond the live pair. */
export function getDispatchProviderLabel(provider: VendorName): string {
  return isLiveDispatchProvider(provider)
    ? LIVE_DISPATCH_PROVIDER_LABELS[provider]
    : PROVIDER_CATALOG[provider]?.displayName ?? provider;
}

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
  provider: VendorName;
  requestedQuantity: number;
  scopeVersion: number;
  scopeFingerprint: string;
  declaredModelUnits: XometryBetaModelUnits;
  /** Founding Beta notice revision (`noticeRevision` on the generic contract). */
  policyRevision: string;
  envelopeRevision: string;
  scope: {
    schema: "quote-lane-scope.v1";
    vendor: VendorName;
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
  | "local_plan_refusal"
  | "network_failure"
  | "postgrest_failure"
  | "unknown_failure";

/** Server denials the customer can resolve directly from the dispatch dialog. */
export type XometryBetaScopeDenialCode =
  | "xometry_beta_confirmed_sourcing_address_required"
  | "xometry_beta_standard_tolerance_required"
  // OVD-981: request fields the controlled beta envelope refuses, named in the dialog.
  | "xometry_beta_quantity_one_required"
  // OVD-998 (OVD-987 P2): raised instead of the code above once the user quantity switch is on.
  | "xometry_beta_single_quantity_required"
  | "xometry_beta_special_delivery_date_not_supported"
  | "xometry_beta_special_requirements_not_supported"
  | "provider_dispatch_special_requirements_not_supported"
  | "provider_dispatch_exact_scope_required"
  // OVD-1068: the generic path's missing confirmed destination, resolved inline like Xometry's.
  | "provider_dispatch_confirmed_destination_required";

const ACTIONABLE_SCOPE_DENIAL_CODES: readonly XometryBetaScopeDenialCode[] = [
  "xometry_beta_confirmed_sourcing_address_required",
  "xometry_beta_standard_tolerance_required",
  "xometry_beta_quantity_one_required",
  "xometry_beta_single_quantity_required",
  "xometry_beta_special_delivery_date_not_supported",
  "xometry_beta_special_requirements_not_supported",
  "provider_dispatch_special_requirements_not_supported",
  "provider_dispatch_exact_scope_required",
  "provider_dispatch_confirmed_destination_required",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeUnavailable(provider: VendorName): TypeError {
  return new TypeError(`The ${getDispatchProviderLabel(provider)} confirmation scope is unavailable.`);
}

function requireString(record: Record<string, unknown>, key: string, provider: VendorName): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw scopeUnavailable(provider);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, provider: VendorName): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw scopeUnavailable(provider);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, provider: VendorName): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw scopeUnavailable(provider);
  }
  return value;
}

function parseFile(value: unknown, provider: VendorName): XometryBetaDispatchFile {
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
  provider: VendorName,
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
  provider: VendorName,
): XometryBetaDispatchResult {
  const notQueued = () => new Error(`The ${getDispatchProviderLabel(provider)} quote request was not queued.`);
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

/**
 * OVD-722: the permit insert trigger refuses a switched-off provider and rolls
 * back the lane and task created in the same call, so this is a definite denial.
 */
const PROVIDER_KILL_SWITCH_DENIAL = /\bprovider_kill_switch_engaged\b/;

/** Identifies server-declared denials, including Supabase's plain PostgrestError objects. */
export function isExplicitXometryBetaDispatchDenial(error: unknown): boolean {
  const message = getFailureMessage(error);
  return (
    GENERIC_PROVIDER_DISPATCH_DENIAL.test(message) ||
    PROVIDER_KILL_SWITCH_DENIAL.test(message) ||
    /xometry_beta_|Founding Beta access|permission to request quotes|Declared model units|dispatch affirmations|pro_required|rollout_disabled|automatic_quote_disabled|automatic_quote_unavailable|free_allowance_unavailable|free_policy_unavailable/.test(
      message,
    )
  );
}

/** Returns the actionable denial code when the server raised exactly that code. */
export function getXometryBetaScopeDenialCode(error: unknown): XometryBetaScopeDenialCode | null {
  const message = getFailureMessage(error).trim();
  return ACTIONABLE_SCOPE_DENIAL_CODES.find((code) => code === message) ?? null;
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
  if (PROVIDER_KILL_SWITCH_DENIAL.test(getFailureMessage(error))) {
    return "This provider is temporarily unavailable.";
  }
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


/**
 * OVD-991: every request field that both server scope checks (the legacy Xometry
 * resolver and the generic provider resolver) refuse as a special requirement,
 * in the words of the request form. The list is the whole set so a customer with
 * no Notes is not left guessing. Condition source: the latest definitions of
 * private.resolve_xometry_beta_dispatch_scope_with_access (OVD-679) and
 * private.resolve_provider_dispatch_scope (OVD-628).
 */
const SPECIAL_REQUIREMENT_FIELDS =
  "Threads, Notes (including service, packaging, shipping, certification, sourcing and release notes), " +
  "required certifications, material certification, a certificate of conformance, " +
  "an inspection level other than Standard, preferred suppliers, a sourcing preference other than Best value, " +
  "material provisioning other than Supplier to source, or a release hold or block";

/**
 * The request's Threads field falls back to the thread callouts read from the
 * drawing when it is cleared, and any save records them, so a part with thread
 * callouts cannot clear Threads.
 */
const DRAWING_THREADS_NOTE =
  " Thread callouts read from the drawing are saved as Threads with the request and cannot be cleared, so a part with thread callouts is outside the beta.";

/** Facts about the request that sharpen a denial message. */
export type XometryBetaScopeFailureContext = {
  /** The drawing has thread callouts that the request's Threads field falls back to. */
  drawingThreads?: boolean;
};

/** Converts scope failures to bounded customer copy without exposing database details. */
export function getXometryBetaScopeFailureMessage(
  error: unknown,
  provider: LiveDispatchProvider = "xometry",
  context: XometryBetaScopeFailureContext = {},
): string {
  const label = LIVE_DISPATCH_PROVIDER_LABELS[provider];
  const drawingThreadsNote = context.drawingThreads === true ? DRAWING_THREADS_NOTE : "";
  switch (getXometryBetaScopeDenialCode(error)) {
    case "xometry_beta_confirmed_sourcing_address_required":
    case "provider_dispatch_confirmed_destination_required":
      return `${label} needs a confirmed shipping address for supplier quotes. Review and confirm your organization's shipping address.`;
    case "xometry_beta_standard_tolerance_required":
      return "Enter this part's tightest tolerance. The controlled Xometry beta accepts ±0.005 in (0.127 mm) or looser; tighter tolerances are outside the beta.";
    case "xometry_beta_quantity_one_required":
      return `The controlled ${label} beta quotes quantity 1 only. Set Qty to 1 and clear extra Quote quantities, then retry.`;
    case "xometry_beta_single_quantity_required":
      // OVD-987: with the user quantity switch on, the legacy Xometry resolver admits one quantity of any
      // size and denies several Quote quantities (or none above zero), so the copy must not say "quantity 1".
      return `The controlled ${label} beta quotes one quantity per request. Remove extra Quote quantities so exactly one quantity of 1 or more remains, then retry. To see another quantity, request it as its own quote.`;
    case "xometry_beta_special_delivery_date_not_supported":
      return `The controlled ${label} beta does not support a Need by date. Clear Need by in the request, then retry.`;
    case "xometry_beta_special_requirements_not_supported":
      return `The controlled ${label} beta cannot carry ${SPECIAL_REQUIREMENT_FIELDS}. If this part needs any of them, it is outside the beta. Remove them only if the part does not need them, then retry.${drawingThreadsNote}`;
    case "provider_dispatch_special_requirements_not_supported":
      return `The controlled ${label} beta cannot carry a Need by date, ${SPECIAL_REQUIREMENT_FIELDS}. If this part needs any of them, it is outside the beta. Remove them only if the part does not need them, then retry.${drawingThreadsNote}`;
    case "provider_dispatch_exact_scope_required":
      // Generic path only: it denies several Quote quantities (one lane per quantity) or a part or drawing
      // that no longer matches its approved files. A single quantity of any size is accepted.
      return `The controlled ${label} beta quotes one part at one quantity from its approved files. Remove extra Quote quantities so one quantity remains, then retry. If it still fails, the part or drawing does not match its approved files; contact support.`;
    default:
      break;
  }

  if (isExplicitXometryBetaDispatchDenial(error)) {
    return `This package is not currently eligible for controlled ${label} beta dispatch. Review its access, files, and manufacturing requirements.`;
  }

  return `The current ${label} confirmation scope could not be verified. Try the scope check again.`;
}
