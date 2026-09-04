import type { ProviderCapabilityEnvelope } from "../generated/provider-catalog.js";

export const OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY =
  "This offline decision does not authorize provider interaction, production admission, ordering, or checkout.";

export type EvidenceBackedEnvelopeInput = {
  process: string | null;
  material: string | null;
  fileName: string | null;
  quantity: number;
  accountMode: string | null;
  drawingIncluded: boolean | null;
  explicitToleranceRequirement: boolean | null;
  requestedToleranceMm?: number | null;
  explicitGeometryRequirements: boolean | null;
  geometryWithinReviewedEnvelope: boolean | null;
};

export type EvidenceBackedEnvelopeState =
  | "eligible_for_evaluation"
  | "manual_review"
  | "unsupported"
  | "unknown";

export type EvidenceBackedEnvelopeReason =
  | "eligible_evidence_backed_envelope"
  | "account_mode_unknown"
  | "account_mode_unsupported"
  | "drawing_requirement_unknown"
  | "drawings_unsupported"
  | "drawings_require_manual_review"
  | "file_format_unknown"
  | "file_format_unsupported"
  | "file_requires_manual_review"
  | "geometry_outside_supported_range"
  | "geometry_requirement_unknown"
  | "geometry_unsupported"
  | "geometry_requires_manual_review"
  | "guidance_only_provider"
  | "material_unknown"
  | "material_unsupported"
  | "process_unknown"
  | "process_unsupported"
  | "quantity_above_reviewed_minimum_unknown"
  | "quantity_invalid"
  | "quantity_outside_supported_range"
  | "quantity_requirement_unknown"
  | "quantity_unsupported"
  | "tolerance_requirement_unknown"
  | "tolerance_unsupported"
  | "tolerance_requires_manual_review";

export type EvidenceBackedEnvelopePolicy = {
  providerKey: string;
  envelopeRevision: string;
  envelope: ProviderCapabilityEnvelope;
  quantityMaximum: "bounded" | "unknown" | "unbounded";
  manualReviewFileExtensions?: readonly string[];
  drawingDisposition: "supported" | "manual_review" | "unknown";
  toleranceDisposition: "supported" | "manual_review" | "unknown";
  geometryDisposition: "supported" | "manual_review" | "unknown";
  guidanceOnly?: boolean;
};

export type EvidenceBackedEnvelopeDecision = {
  providerKey: string;
  state: EvidenceBackedEnvelopeState;
  envelopeRevision: string;
  reasonCodes: EvidenceBackedEnvelopeReason[];
  normalized: {
    process: string | null;
    material: string | null;
    fileExtension: string | null;
    quantity: number;
    accountMode: string | null;
    drawingIncluded: boolean | null;
    explicitToleranceRequirement: boolean | null;
    requestedToleranceMm: number | null;
    explicitGeometryRequirements: boolean | null;
    geometryWithinReviewedEnvelope: boolean | null;
  };
  authorizationBoundary: typeof OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY;
};

function normalizeStableValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function normalizeFileExtension(fileName: string | null | undefined): string | null {
  const normalized = fileName?.trim() ?? "";
  const separatorIndex = normalized.lastIndexOf(".");
  if (separatorIndex < 0 || separatorIndex === normalized.length - 1) {
    return null;
  }
  return normalized.slice(separatorIndex + 1).trim().toLowerCase() || null;
}

function appendValueDisposition(
  section: { status: string; values: readonly string[] },
  value: string | null,
  unknownReason: EvidenceBackedEnvelopeReason,
  unsupportedReason: EvidenceBackedEnvelopeReason,
  reasons: EvidenceBackedEnvelopeReason[],
): void {
  if (section.status === "unsupported") {
    reasons.push(unsupportedReason);
    return;
  }
  if (section.status !== "supported" || value === null || !section.values.includes(value)) {
    reasons.push(unknownReason);
  }
}

function classifyRequirement(
  included: boolean | null,
  sectionStatus: string,
  disposition: "supported" | "manual_review" | "unknown",
  unknownReason: EvidenceBackedEnvelopeReason,
  manualReason: EvidenceBackedEnvelopeReason,
  unsupportedReason: EvidenceBackedEnvelopeReason,
  reasons: EvidenceBackedEnvelopeReason[],
): void {
  if (included === false) {
    return;
  }
  if (included === null) {
    reasons.push(unknownReason);
    return;
  }
  if (sectionStatus === "unsupported") {
    reasons.push(unsupportedReason);
    return;
  }
  if (sectionStatus !== "supported" || disposition === "unknown") {
    reasons.push(unknownReason);
    return;
  }
  if (disposition === "manual_review") {
    reasons.push(manualReason);
  }
}

function appendQuantityDisposition(
  input: EvidenceBackedEnvelopeInput,
  policy: EvidenceBackedEnvelopePolicy,
  reasons: EvidenceBackedEnvelopeReason[],
): void {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    reasons.push("quantity_invalid");
    return;
  }
  const quantity = policy.envelope.quantity;
  if (quantity.status === "unsupported") {
    reasons.push("quantity_unsupported");
    return;
  }
  if (quantity.status !== "supported") {
    reasons.push("quantity_requirement_unknown");
    return;
  }
  if (quantity.minimum !== null && input.quantity < quantity.minimum) {
    reasons.push("quantity_outside_supported_range");
    return;
  }
  if (policy.quantityMaximum === "bounded") {
    if (quantity.maximum === null || input.quantity > quantity.maximum) {
      reasons.push("quantity_outside_supported_range");
    }
    return;
  }
  if (
    policy.quantityMaximum === "unknown"
    && quantity.minimum !== null
    && input.quantity > quantity.minimum
  ) {
    reasons.push("quantity_above_reviewed_minimum_unknown");
  }
}

function appendGeometryDisposition(
  input: EvidenceBackedEnvelopeInput,
  policy: EvidenceBackedEnvelopePolicy,
  reasons: EvidenceBackedEnvelopeReason[],
): void {
  if (input.geometryWithinReviewedEnvelope === null) {
    reasons.push("geometry_requirement_unknown");
    return;
  }
  if (input.geometryWithinReviewedEnvelope === false) {
    reasons.push("geometry_outside_supported_range");
    return;
  }
  classifyRequirement(
    input.explicitGeometryRequirements,
    policy.envelope.geometry.status,
    policy.geometryDisposition,
    "geometry_requirement_unknown",
    "geometry_requires_manual_review",
    "geometry_unsupported",
    reasons,
  );
}

function appendToleranceRangeDisposition(
  input: EvidenceBackedEnvelopeInput,
  policy: EvidenceBackedEnvelopePolicy,
  requestedToleranceMm: number | null,
  reasons: EvidenceBackedEnvelopeReason[],
): void {
  if (
    input.explicitToleranceRequirement !== true
    || policy.toleranceDisposition !== "supported"
    || policy.envelope.tolerance.status !== "supported"
  ) {
    return;
  }
  const lower = policy.envelope.tolerance.minimumMm;
  const upper = policy.envelope.tolerance.maximumMm;
  if (
    requestedToleranceMm === null
    || !Number.isFinite(requestedToleranceMm)
    || requestedToleranceMm <= 0
    || lower === null
    || upper === null
    || requestedToleranceMm < lower
    || requestedToleranceMm > upper
  ) {
    reasons.push("tolerance_requirement_unknown");
  }
}

function classifyState(
  reasons: EvidenceBackedEnvelopeReason[],
): EvidenceBackedEnvelopeState {
  if (
    reasons.some((reason) => reason.endsWith("_unsupported"))
    || reasons.includes("quantity_invalid")
    || reasons.includes("quantity_outside_supported_range")
    || reasons.includes("geometry_outside_supported_range")
  ) {
    return "unsupported";
  }
  if (reasons.some((reason) => reason.endsWith("_unknown"))) {
    return "unknown";
  }
  if (
    reasons.includes("file_requires_manual_review")
    || reasons.includes("drawings_require_manual_review")
    || reasons.includes("tolerance_requires_manual_review")
    || reasons.includes("geometry_requires_manual_review")
    || reasons.includes("guidance_only_provider")
  ) {
    return "manual_review";
  }
  reasons.push("eligible_evidence_backed_envelope");
  return "eligible_for_evaluation";
}

/**
 * Builds a pure provider-specific classifier from a canonical manifest envelope
 * plus explicit conservative policy for facts the flat manifest cannot encode.
 */
export function createEvidenceBackedEnvelopeEvaluator(policy: EvidenceBackedEnvelopePolicy) {
  const manualExtensions = new Set(
    (policy.manualReviewFileExtensions ?? []).map((extension) => extension.toLowerCase()),
  );

  return (input: EvidenceBackedEnvelopeInput): EvidenceBackedEnvelopeDecision => {
    const process = normalizeStableValue(input.process);
    const material = normalizeStableValue(input.material);
    const fileExtension = normalizeFileExtension(input.fileName);
    const accountMode = normalizeStableValue(input.accountMode);
    const requestedToleranceMm = input.requestedToleranceMm ?? null;
    const reasonCodes: EvidenceBackedEnvelopeReason[] = [];

    appendQuantityDisposition(input, policy, reasonCodes);
    appendValueDisposition(
      policy.envelope.processes,
      process,
      "process_unknown",
      "process_unsupported",
      reasonCodes,
    );
    appendValueDisposition(
      policy.envelope.materials,
      material,
      "material_unknown",
      "material_unsupported",
      reasonCodes,
    );
    if (!fileExtension || !manualExtensions.has(fileExtension)) {
      appendValueDisposition(
        policy.envelope.files,
        fileExtension,
        "file_format_unknown",
        "file_format_unsupported",
        reasonCodes,
      );
    } else if (policy.envelope.files.status === "unsupported") {
      reasonCodes.push("file_format_unsupported");
    } else if (policy.envelope.files.status !== "supported") {
      reasonCodes.push("file_format_unknown");
    }
    appendValueDisposition(
      policy.envelope.accountModes,
      accountMode,
      "account_mode_unknown",
      "account_mode_unsupported",
      reasonCodes,
    );

    classifyRequirement(
      input.drawingIncluded,
      policy.envelope.drawings.status,
      policy.drawingDisposition,
      "drawing_requirement_unknown",
      "drawings_require_manual_review",
      "drawings_unsupported",
      reasonCodes,
    );
    classifyRequirement(
      input.explicitToleranceRequirement,
      policy.envelope.tolerance.status,
      policy.toleranceDisposition,
      "tolerance_requirement_unknown",
      "tolerance_requires_manual_review",
      "tolerance_unsupported",
      reasonCodes,
    );
    appendGeometryDisposition(input, policy, reasonCodes);
    appendToleranceRangeDisposition(input, policy, requestedToleranceMm, reasonCodes);
    if (fileExtension && manualExtensions.has(fileExtension)) {
      reasonCodes.push("file_requires_manual_review");
    }
    if (policy.guidanceOnly) {
      reasonCodes.push("guidance_only_provider");
    }

    const state = classifyState(reasonCodes);

    return {
      providerKey: policy.providerKey,
      state,
      envelopeRevision: policy.envelopeRevision,
      reasonCodes,
      normalized: {
        process,
        material,
        fileExtension,
        quantity: input.quantity,
        accountMode,
        drawingIncluded: input.drawingIncluded,
        explicitToleranceRequirement: input.explicitToleranceRequirement,
        requestedToleranceMm,
        explicitGeometryRequirements: input.explicitGeometryRequirements,
        geometryWithinReviewedEnvelope: input.geometryWithinReviewedEnvelope,
      },
      authorizationBoundary: OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
    };
  };
}
