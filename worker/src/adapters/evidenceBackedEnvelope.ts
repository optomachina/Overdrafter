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
};

export type EvidenceBackedEnvelopeState =
  | "eligible_for_evaluation"
  | "manual_review"
  | "unsupported"
  | "unknown";

export type EvidenceBackedEnvelopeReason =
  | "eligible_evidence_backed_envelope"
  | "account_mode_unknown"
  | "drawing_requirement_unknown"
  | "drawings_require_manual_review"
  | "file_format_unknown"
  | "file_requires_manual_review"
  | "geometry_requirement_unknown"
  | "geometry_requires_manual_review"
  | "guidance_only_provider"
  | "material_unknown"
  | "process_unknown"
  | "quantity_above_reviewed_minimum_unknown"
  | "quantity_invalid"
  | "quantity_outside_supported_range"
  | "tolerance_requirement_unknown"
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

function includesEnvelopeValue(
  section: { status: string; values: readonly string[] },
  value: string | null,
): boolean {
  return section.status === "supported" && value !== null && section.values.includes(value);
}

function classifyRequirement(
  included: boolean | null,
  disposition: "supported" | "manual_review" | "unknown",
  unknownReason: EvidenceBackedEnvelopeReason,
  manualReason: EvidenceBackedEnvelopeReason,
  reasons: EvidenceBackedEnvelopeReason[],
): void {
  if (included === false) {
    return;
  }
  if (included === null || disposition === "unknown") {
    reasons.push(unknownReason);
    return;
  }
  if (disposition === "manual_review") {
    reasons.push(manualReason);
  }
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

    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      reasonCodes.push("quantity_invalid");
    }
    if (!includesEnvelopeValue(policy.envelope.processes, process)) {
      reasonCodes.push("process_unknown");
    }
    if (!includesEnvelopeValue(policy.envelope.materials, material)) {
      reasonCodes.push("material_unknown");
    }
    if (
      !fileExtension
      || (!manualExtensions.has(fileExtension)
        && !includesEnvelopeValue(policy.envelope.files, fileExtension))
    ) {
      reasonCodes.push("file_format_unknown");
    }
    if (!includesEnvelopeValue(policy.envelope.accountModes, accountMode)) {
      reasonCodes.push("account_mode_unknown");
    }

    const minimum = policy.envelope.quantity.minimum;
    const maximum = policy.envelope.quantity.maximum;
    if (Number.isSafeInteger(input.quantity) && input.quantity > 0) {
      if (minimum !== null && input.quantity < minimum) {
        reasonCodes.push("quantity_outside_supported_range");
      } else if (policy.quantityMaximum === "bounded") {
        if (maximum === null || input.quantity > maximum) {
          reasonCodes.push("quantity_outside_supported_range");
        }
      } else if (
        policy.quantityMaximum === "unknown"
        && minimum !== null
        && input.quantity > minimum
      ) {
        reasonCodes.push("quantity_above_reviewed_minimum_unknown");
      }
    }

    classifyRequirement(
      input.drawingIncluded,
      policy.drawingDisposition,
      "drawing_requirement_unknown",
      "drawings_require_manual_review",
      reasonCodes,
    );
    classifyRequirement(
      input.explicitToleranceRequirement,
      policy.toleranceDisposition,
      "tolerance_requirement_unknown",
      "tolerance_requires_manual_review",
      reasonCodes,
    );
    classifyRequirement(
      input.explicitGeometryRequirements,
      policy.geometryDisposition,
      "geometry_requirement_unknown",
      "geometry_requires_manual_review",
      reasonCodes,
    );

    if (
      input.explicitToleranceRequirement === true
      && policy.toleranceDisposition === "supported"
    ) {
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
        reasonCodes.push("tolerance_requirement_unknown");
      }
    }
    if (fileExtension && manualExtensions.has(fileExtension)) {
      reasonCodes.push("file_requires_manual_review");
    }
    if (policy.guidanceOnly) {
      reasonCodes.push("guidance_only_provider");
    }

    let state: EvidenceBackedEnvelopeState;
    if (
      reasonCodes.includes("quantity_invalid")
      || reasonCodes.includes("quantity_outside_supported_range")
    ) {
      state = "unsupported";
    } else if (reasonCodes.some((reason) => reason.endsWith("_unknown"))) {
      state = "unknown";
    } else if (
      reasonCodes.includes("file_requires_manual_review")
      || reasonCodes.includes("drawings_require_manual_review")
      || reasonCodes.includes("tolerance_requires_manual_review")
      || reasonCodes.includes("geometry_requires_manual_review")
      || reasonCodes.includes("guidance_only_provider")
    ) {
      state = "manual_review";
    } else {
      state = "eligible_for_evaluation";
      reasonCodes.push("eligible_evidence_backed_envelope");
    }

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
      },
      authorizationBoundary: OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
    };
  };
}
