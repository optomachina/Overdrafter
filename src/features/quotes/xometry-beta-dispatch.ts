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
  status: "denied" | "unknown";
};

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
    throw new Error("The Xometry confirmation scope is unavailable.");
  }
  return value;
}

function parseFile(value: unknown): XometryBetaDispatchFile {
  if (!isRecord(value)) {
    throw new Error("The Xometry confirmation scope is unavailable.");
  }

  const sha256 = requireString(value, "sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("The Xometry confirmation scope is unavailable.");
  }

  const sizeBytes = value.sizeBytes;
  if (
    sizeBytes !== null &&
    (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
  ) {
    throw new Error("The Xometry confirmation scope is unavailable.");
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
    throw new Error("The Xometry confirmation scope is unavailable.");
  }

  const scope = value.scope;
  if (!isRecord(scope.part) || !isRecord(scope.requirements)) {
    throw new Error("The Xometry confirmation scope is unavailable.");
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
    throw new Error("The Xometry confirmation scope is unavailable.");
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
    throw new Error("The Xometry confirmation scope is unavailable.");
  }

  const drawing = scope.part.drawing;
  const material = requireString(requirements, "material");
  const tolerance = requireNumber(requirements, "tightestToleranceInch");
  if (tolerance < 0) {
    throw new Error("The Xometry confirmation scope is unavailable.");
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

/** Identifies server-declared denials; transport failures remain deliberately ambiguous. */
export function isExplicitXometryBetaDispatchDenial(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /xometry_beta_|Founding Beta access|permission to request quotes|Declared model units|dispatch affirmations|pro_required|rollout_disabled|automatic_quote_unavailable/.test(
    message,
  );
}

/** Converts scope failures to bounded customer copy without exposing database details. */
export function getXometryBetaScopeFailureMessage(error: unknown): string {
  if (isExplicitXometryBetaDispatchDenial(error)) {
    return "This package is not currently eligible for controlled Xometry beta dispatch. Review its access, files, and manufacturing requirements.";
  }
  return "The current Xometry confirmation scope could not be verified. Try the scope check again.";
}
