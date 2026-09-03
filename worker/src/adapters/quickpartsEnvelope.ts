import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";

const QUICKPARTS_ENVELOPE = PROVIDER_CATALOG.quickparts.capabilityEnvelope;
const QUICKPARTS_MANUAL_REVIEW_EXTENSIONS = new Set(["sldprt"]);

export const QUICKPARTS_ENVELOPE_REVISION =
  `quickparts-envelope.v${QUICKPARTS_ENVELOPE.version}` as const;

export const QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY =
  "This offline decision does not authorize provider interaction, production admission, ordering, or checkout.";

export type QuickpartsEnvelopeInput = {
  process: string | null;
  material: string | null;
  fileName: string | null;
  quantity: number;
  accountMode: string | null;
  drawingIncluded: boolean | null;
  explicitToleranceRequirement: boolean | null;
  explicitGeometryRequirements: boolean | null;
};

export type QuickpartsEnvelopeState =
  | "eligible_for_evaluation"
  | "manual_review"
  | "unsupported"
  | "unknown";

export type QuickpartsEnvelopeReason =
  | "eligible_evidence_backed_envelope"
  | "account_mode_unknown"
  | "drawing_requirement_unknown"
  | "file_format_unknown"
  | "geometry_requirement_unknown"
  | "material_unknown"
  | "process_unknown"
  | "quantity_above_reviewed_minimum_unknown"
  | "quantity_invalid"
  | "sldprt_requires_manual_quote"
  | "tolerance_requirement_unknown";

export type QuickpartsEnvelopeDecision = {
  state: QuickpartsEnvelopeState;
  envelopeRevision: typeof QUICKPARTS_ENVELOPE_REVISION;
  reasonCodes: QuickpartsEnvelopeReason[];
  normalized: {
    process: string | null;
    material: string | null;
    fileExtension: string | null;
    quantity: number;
    accountMode: string | null;
    drawingIncluded: boolean | null;
    explicitToleranceRequirement: boolean | null;
    explicitGeometryRequirements: boolean | null;
  };
  authorizationBoundary: typeof QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY;
};

function normalizeStableValue(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function normalizeFileExtension(fileName: string | null | undefined) {
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
) {
  return section.status === "supported" && value !== null && section.values.includes(value);
}

/**
 * Classifies a package against Quickparts' public, evidence-backed envelope.
 * This function is pure and deliberately has no interaction or I/O capability.
 */
export function evaluateQuickpartsEnvelope(
  input: QuickpartsEnvelopeInput,
): QuickpartsEnvelopeDecision {
  const process = normalizeStableValue(input.process);
  const material = normalizeStableValue(input.material);
  const fileExtension = normalizeFileExtension(input.fileName);
  const accountMode = normalizeStableValue(input.accountMode);
  const reasonCodes: QuickpartsEnvelopeReason[] = [];

  if (!Number.isFinite(input.quantity) || !Number.isInteger(input.quantity) || input.quantity <= 0) {
    reasonCodes.push("quantity_invalid");
  }
  if (!includesEnvelopeValue(QUICKPARTS_ENVELOPE.processes, process)) {
    reasonCodes.push("process_unknown");
  }
  if (!includesEnvelopeValue(QUICKPARTS_ENVELOPE.materials, material)) {
    reasonCodes.push("material_unknown");
  }
  if (
    !fileExtension ||
    (!QUICKPARTS_MANUAL_REVIEW_EXTENSIONS.has(fileExtension) &&
      !includesEnvelopeValue(QUICKPARTS_ENVELOPE.files, fileExtension))
  ) {
    reasonCodes.push("file_format_unknown");
  }
  if (!includesEnvelopeValue(QUICKPARTS_ENVELOPE.accountModes, accountMode)) {
    reasonCodes.push("account_mode_unknown");
  }
  if (
    Number.isInteger(input.quantity) &&
    input.quantity > (QUICKPARTS_ENVELOPE.quantity.minimum ?? Number.POSITIVE_INFINITY)
  ) {
    reasonCodes.push("quantity_above_reviewed_minimum_unknown");
  }
  if (input.drawingIncluded !== false) {
    reasonCodes.push("drawing_requirement_unknown");
  }
  if (input.explicitToleranceRequirement !== false) {
    reasonCodes.push("tolerance_requirement_unknown");
  }
  if (input.explicitGeometryRequirements !== false) {
    reasonCodes.push("geometry_requirement_unknown");
  }
  if (fileExtension && QUICKPARTS_MANUAL_REVIEW_EXTENSIONS.has(fileExtension)) {
    reasonCodes.push("sldprt_requires_manual_quote");
  }

  let state: QuickpartsEnvelopeState;
  if (reasonCodes.includes("quantity_invalid")) {
    state = "unsupported";
  } else if (reasonCodes.some((code) => code.endsWith("_unknown"))) {
    state = "unknown";
  } else if (reasonCodes.includes("sldprt_requires_manual_quote")) {
    state = "manual_review";
  } else {
    state = "eligible_for_evaluation";
    reasonCodes.push("eligible_evidence_backed_envelope");
  }

  return {
    state,
    envelopeRevision: QUICKPARTS_ENVELOPE_REVISION,
    reasonCodes,
    normalized: {
      process,
      material,
      fileExtension,
      quantity: input.quantity,
      accountMode,
      drawingIncluded: input.drawingIncluded,
      explicitToleranceRequirement: input.explicitToleranceRequirement,
      explicitGeometryRequirements: input.explicitGeometryRequirements,
    },
    authorizationBoundary: QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY,
  };
}
