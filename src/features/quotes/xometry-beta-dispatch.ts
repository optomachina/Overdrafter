import type { Json } from "@/integrations/supabase/types";

export type XometryBetaModelUnits = "inch" | "millimeter";

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
  provider: "xometry";
  requestedQuantity: number;
  scopeVersion: number;
  scopeFingerprint: string;
  declaredModelUnits: XometryBetaModelUnits;
  policyRevision: string;
  envelopeRevision: string;
  scope: {
    schema: "quote-lane-scope.v1";
    vendor: "xometry";
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

export type XometryBetaDenialCode = 
  | "xometry_beta_confirmed_sourcing_address_required"
  | "xometry_beta_tightest_tolerance_required"
  | "xometry_beta_exact_scope_required"
  | "xometry_beta_scope_changed"
  | "xometry_beta_notice_changed"
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }
  return value;
}

function parseFile(value: unknown): XometryBetaDispatchFile {
  if (!isRecord(value)) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }

  const sha256 = requireString(value, "sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }

  const sizeBytes = value.sizeBytes;
  if (
    sizeBytes !== null &&
    (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
  ) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }

  return {
    fileId: requireString(value, "fileId"),
    sha256,
    name: requireString(value, "name"),
    mimeType: optionalString(value, "mimeType"),
    sizeBytes: sizeBytes as number | null,
  };
}

/** Parses the server-authored disclosure contract and fails closed on drift. */
export function parseXometryBetaDispatchScope(value: unknown): XometryBetaDispatchScope {
  if (!isRecord(value) || !isRecord(value.scope)) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }

  const scope = value.scope;
  if (!isRecord(scope.part) || !isRecord(scope.requirements) || !isRecord(scope.destination)) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }

  const provider = requireString(value, "provider");
  const schema = requireString(scope, "schema");
  const scopeVendor = requireString(scope, "vendor");
  const declaredModelUnits = requireString(value, "declaredModelUnits");
  if (
    provider !== "xometry" ||
    scopeVendor !== "xometry" ||
    schema !== "quote-lane-scope.v1" ||
    (declaredModelUnits !== "inch" && declaredModelUnits !== "millimeter")
  ) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }

  const quantity = requireNumber(scope, "quantity");
  const requestedQuantity = requireNumber(value, "requestedQuantity");
  const scopeVersion = requireNumber(value, "scopeVersion");
  const scopeFingerprint = requireString(value, "scopeFingerprint");
  const partId = requireString(value, "partId");
  const nestedPartId = requireString(scope.part, "id");
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
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }

  const drawing = scope.part.drawing;
  const destination = scope.destination;
  if (destination.state !== "confirmed") {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }
  const country = requireString(destination, "country");
  const region = optionalString(destination, "region");
  if (country === "US" && (!region || region.trim().length === 0)) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }
  const confirmationRevision = requireString(destination, "confirmationRevision");
  if (!/^[1-9]\d*$/.test(confirmationRevision)) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }
  const confirmedDestination = {
    confirmationRevision,
    state: "confirmed" as const,
    street: requireString(destination, "street"),
    city: requireString(destination, "city"),
    region,
    postalCode: requireString(destination, "postalCode"),
    country,
  };
  const material = requireString(requirements, "material");
  const tolerance = requireNumber(requirements, "tightestToleranceInch");
  if (tolerance < 0) {
    throw new TypeError("The Xometry confirmation scope is unavailable.");
  }

  return {
    organizationId: requireString(value, "organizationId"),
    jobId: requireString(value, "jobId"),
    partId,
    provider: "xometry",
    requestedQuantity,
    scopeVersion,
    scopeFingerprint,
    declaredModelUnits,
    policyRevision: requireString(value, "policyRevision"),
    envelopeRevision: requireString(value, "envelopeRevision"),
    scope: {
      schema: "quote-lane-scope.v1",
      vendor: "xometry",
      quantity,
      destination: confirmedDestination,
      part: {
        id: nestedPartId,
        cad: parseFile(scope.part.cad),
        drawing: drawing === null ? null : parseFile(drawing),
      },
      requirements: {
        id: requireString(requirements, "id"),
        capturedAt: requireString(requirements, "capturedAt"),
        description: optionalString(requirements, "description"),
        partNumber: optionalString(requirements, "partNumber"),
        revision: optionalString(requirements, "revision"),
        material,
        finish: optionalString(requirements, "finish"),
        tightestToleranceInch: tolerance,
        requestedDeliveryDate: optionalString(requirements, "requestedDeliveryDate"),
        specification: specification as Record<string, Json | undefined>,
      },
    },
  };
}

/** Parses the atomic dispatch response and rejects anything short of a queued permit. */
export function parseXometryBetaDispatchResult(value: unknown): XometryBetaDispatchResult {
  if (!isRecord(value) || value.accepted !== true || value.status !== "queued") {
    throw new Error("The Xometry quote request was not queued.");
  }

  return {
    accepted: true,
    created: value.created === true,
    deduplicated: value.deduplicated === true,
    permitId: requireString(value, "permitId"),
    quoteRequestId: requireString(value, "quoteRequestId"),
    quoteRunId: requireString(value, "quoteRunId"),
    scopeFingerprint: requireString(value, "scopeFingerprint"),
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

/** Identifies server-declared denials, including Supabase's plain PostgrestError objects. */
export function isExplicitXometryBetaDispatchDenial(error: unknown): boolean {
  const message = getFailureMessage(error);
  return /xometry_beta_|\bprovider_dispatch_job_busy\b|Founding Beta access|permission to request quotes|Declared model units|dispatch affirmations|pro_required|rollout_disabled|automatic_quote_disabled|automatic_quote_unavailable|free_allowance_unavailable|free_policy_unavailable/.test(
    message,
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

/** Extracts specific denial code from error message if present */
export function extractDenialCode(error: unknown): string | null {
  const message = getFailureMessage(error);

  // Check for specific Xometry beta error codes
  if (/xometry_beta_confirmed_sourcing_address_required/.test(message)) {
    return "xometry_beta_confirmed_sourcing_address_required";
  }
  if (/xometry_beta_tightest_tolerance_required/.test(message)) {
    return "xometry_beta_tightest_tolerance_required";
  }
  if (/xometry_beta_exact_scope_required/.test(message)) {
    return "xometry_beta_exact_scope_required";
  }
  if (/xometry_beta_scope_changed/.test(message)) {
    return "xometry_beta_scope_changed";
  }
  if (/xometry_beta_notice_changed/.test(message)) {
    return "xometry_beta_notice_changed";
  }

  return null;
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
export function getXometryBetaScopeFailureMessage(error: unknown): string {
  const denialCode = extractDenialCode(error);
  
  if (denialCode === "xometry_beta_confirmed_sourcing_address_required") {
    return "Xometry requires a confirmed shipping address. Please enter and confirm your organization's shipping address in Settings before requesting a quote.";
  }
  
  if (denialCode === "xometry_beta_tightest_tolerance_required") {
    return "Xometry requires the tightest tolerance specification. Please provide the tightest tolerance for this part before requesting a quote.";
  }
  
  if (denialCode === "xometry_beta_exact_scope_required") {
    return "This part's current specifications do not meet Xometry's requirements. Please review the manufacturing requirements and ensure they are complete.";
  }
  
  if (isExplicitXometryBetaDispatchDenial(error)) {
    return "This package is not currently eligible for controlled Xometry beta dispatch. Review its access, files, and manufacturing requirements.";
  }
  
  return "The current Xometry confirmation scope could not be verified. Try the scope check again.";
}
