import { resolveRequirementProcess } from "../partContext.js";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import {
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type WorkerConfig,
} from "../types.js";
import { VendorAdapter } from "./base.js";
import {
  PortalQuoteWorkflowAdapter,
  type PortalQuoteWorkflow,
} from "./portalWorkflow.js";

export const OSHCUT_ENVELOPE_REVISION = "oshcut-sheet-laser-6061-t6.v1" as const;

/**
 * Conservative OSH Cut capability envelope reviewed from first-party pages.
 * It certifies provider fit, not manufacturability or production dispatch.
 */
export const OSHCUT_PROVIDER_ENVELOPE = {
  provider: "oshcut",
  revision: OSHCUT_ENVELOPE_REVISION,
  evidenceReviewedAt: "2026-08-26",
  process: "laser_cutting",
  material: "aluminum_6061_t6",
  geometryFamilies: ["flat_sheet"],
  supportedFileExtensions: [
    "dxf",
    "svg",
    "ai",
    "step",
    "stp",
    "sldprt",
    "catpart",
    "ipt",
    "igs",
    "par",
    "iges",
    "nx",
    "solidedge",
    "jt",
    "3dm",
    "x_t",
    "sat",
    "sab",
  ],
  quantity: {
    minimum: 1,
    certifiedMaximum: 10_000,
  },
  drawingUpload: "unsupported_by_current_adapter",
  account: {
    isolatedAuthenticatedSessionRequired: true,
    productionAdmissionRequired: true,
    actionTimeDisclosurePermitRequired: true,
    immediatePreflightRequired: true,
    currentProductionState: "unavailable_pending_provider_neutral_preflight",
  },
  geometryBoundary:
    "Flat-sheet classification only; stock thickness, size, features, and final manufacturability remain provider-determined.",
  evidence: [
    {
      url: "https://www.oshcut.com/online-metal-fabrication/",
      supports: [
        "instant_sheet_laser_and_bending_pricing",
        "quantity_one_through_tens_of_thousands",
        "2d_and_3d_upload_formats",
      ],
    },
    {
      url: "https://www.oshcut.com/tutorials/osh-cut-online-quoting-app",
      supports: ["upload_then_units_material_and_quantity_configuration"],
    },
    {
      url: "https://www.oshcut.com/minimum-maximum-material-sizes",
      supports: ["aluminum_6061_t6_sheet_catalog", "catalog_bound_geometry_limits"],
    },
  ],
  guarantees: {
    quoteOnly: true,
    orderAuthority: false,
    checkoutAllowed: false,
  },
} as const;

export type OshcutOperationalState =
  | "eligible"
  | "unsupported"
  | "unavailable"
  | "manual_followup"
  /** Reserved for a future admitted production result; current code never emits it. */
  | "live_offer";

export type OshcutEligibilityAssessment = {
  state: "eligible" | "unsupported" | "manual_followup";
  reasonCode: string;
  guidance: string;
  envelopeRevision: typeof OSHCUT_ENVELOPE_REVISION;
};

function readStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== "string") {
    return null;
  }

  const normalized = candidate.trim().toLowerCase();
  return normalized || null;
}

function normalizeProcess(process: string | null) {
  return process?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? null;
}

function fileExtension(input: VendorQuoteAdapterInput) {
  const name = input.cadFile?.original_name ?? input.stagedCadFile?.originalName ?? "";
  const separatorIndex = name.lastIndexOf(".");
  if (separatorIndex < 0 || separatorIndex === name.length - 1) {
    return null;
  }

  return name.slice(separatorIndex + 1).toLowerCase();
}

function isExact6061T6(material: string) {
  const normalized = material.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return [
    "aluminum 6061 t6",
    "6061 t6 aluminum",
    "6061 aluminum t6",
  ].includes(normalized);
}

function assessment(
  state: OshcutEligibilityAssessment["state"],
  reasonCode: string,
  guidance: string,
): OshcutEligibilityAssessment {
  return {
    state,
    reasonCode,
    guidance,
    envelopeRevision: OSHCUT_ENVELOPE_REVISION,
  };
}

/** Returns a finite, fail-closed provider-local eligibility decision. */
export function assessOshcutEligibility(
  input: VendorQuoteAdapterInput,
): OshcutEligibilityAssessment {
  const process = normalizeProcess(resolveRequirementProcess(input.requirement.spec_snapshot));
  if (!process) {
    return assessment(
      "manual_followup",
      "process_confirmation_required",
      "Confirm sheet laser cutting before considering OSH Cut.",
    );
  }

  if (process === "cnc_milling" || process === "milling" || process === "cnc_machining") {
    return assessment(
      "unsupported",
      "cnc_milling_not_supported",
      "OSH Cut is not certified as a CNC-milling quote source; use a CNC-capable provider.",
    );
  }

  if (process !== OSHCUT_PROVIDER_ENVELOPE.process && process !== "sheet_laser_cutting") {
    return assessment(
      "unsupported",
      "process_outside_envelope",
      "This OSH Cut envelope supports only flat-sheet laser cutting.",
    );
  }

  const geometryFamily = readStringField(input.requirement.spec_snapshot, "geometryFamily");
  if (!geometryFamily) {
    return assessment(
      "manual_followup",
      "geometry_confirmation_required",
      "Confirm that the part is flat-sheet geometry before considering OSH Cut.",
    );
  }

  if (!OSHCUT_PROVIDER_ENVELOPE.geometryFamilies.includes(
    geometryFamily as (typeof OSHCUT_PROVIDER_ENVELOPE.geometryFamilies)[number],
  )) {
    return assessment(
      "unsupported",
      "geometry_outside_envelope",
      "This certified OSH Cut envelope does not cover machined solids, formed sheet, or tube geometry.",
    );
  }

  if (!input.requirement.material.trim()) {
    return assessment(
      "manual_followup",
      "material_confirmation_required",
      "Confirm Aluminum 6061-T6 before considering OSH Cut.",
    );
  }

  if (!isExact6061T6(input.requirement.material)) {
    return assessment(
      "unsupported",
      "material_outside_envelope",
      "This certified OSH Cut envelope supports only Aluminum 6061-T6.",
    );
  }

  const extension = fileExtension(input);
  if (!extension) {
    return assessment(
      "manual_followup",
      "file_format_confirmation_required",
      "Attach a CAD file with a supported extension before considering OSH Cut.",
    );
  }

  if (!OSHCUT_PROVIDER_ENVELOPE.supportedFileExtensions.includes(
    extension as (typeof OSHCUT_PROVIDER_ENVELOPE.supportedFileExtensions)[number],
  )) {
    return assessment(
      "unsupported",
      "file_format_outside_envelope",
      `The .${extension} file is outside the evidence-backed OSH Cut upload envelope.`,
    );
  }

  if (input.drawingFile || input.stagedDrawingFile) {
    return assessment(
      "unsupported",
      "drawing_upload_not_supported",
      "The current OSH Cut adapter cannot disclose a separate drawing and will not silently omit it.",
    );
  }

  if (
    !Number.isInteger(input.requestedQuantity) ||
    input.requestedQuantity < OSHCUT_PROVIDER_ENVELOPE.quantity.minimum ||
    input.requestedQuantity > OSHCUT_PROVIDER_ENVELOPE.quantity.certifiedMaximum
  ) {
    return assessment(
      "unsupported",
      "quantity_outside_envelope",
      `Use a whole-number quantity from ${OSHCUT_PROVIDER_ENVELOPE.quantity.minimum} through ${OSHCUT_PROVIDER_ENVELOPE.quantity.certifiedMaximum}.`,
    );
  }

  return assessment(
    "eligible",
    "static_envelope_match",
    "The package matches the static OSH Cut envelope; production dispatch remains unavailable until separate admission and exact preflight exist.",
  );
}

function boundedPayload(
  input: VendorQuoteAdapterInput,
  operationalState: Exclude<OshcutOperationalState, "live_offer">,
  reasonCode: string,
) {
  return {
    operationalContract: "oshcut-operational-adapter",
    provider: "oshcut",
    operationalState,
    reasonCode,
    envelopeRevision: OSHCUT_ENVELOPE_REVISION,
    requestedQuantity: input.requestedQuantity,
    quoteIntent: "quote_only",
    orderAuthority: false,
    checkoutAllowed: false,
    customerLiveOfferEligible: false,
  };
}

function finiteOutput(
  input: VendorQuoteAdapterInput,
  operationalState: "unsupported" | "unavailable" | "manual_followup",
  reasonCode: string,
  note: string,
): VendorQuoteAdapterOutput {
  return {
    vendor: "oshcut",
    status: operationalState === "manual_followup" ? "manual_vendor_followup" : "failed",
    unitPriceUsd: null,
    totalPriceUsd: null,
    leadTimeBusinessDays: null,
    quoteUrl: null,
    dfmIssues: [],
    notes: [note],
    artifacts: [],
    rawPayload: boundedPayload(input, operationalState, reasonCode),
  };
}

/**
 * Provider-local OSH Cut adapter behind the common `VendorAdapter.quote`
 * interface. Production remains zero-disclosure until OVD-380 supplies the
 * provider-neutral permit and immediate preflight contract.
 */
export class OshcutAdapter extends VendorAdapter {
  private readonly delegate: Pick<VendorAdapter, "quote">;

  constructor(
    config: WorkerConfig,
    workflow: PortalQuoteWorkflow,
    delegate?: Pick<VendorAdapter, "quote">,
  ) {
    super("oshcut", config);
    this.delegate = delegate ?? new PortalQuoteWorkflowAdapter("oshcut", config, workflow);
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    const eligibility = assessOshcutEligibility(input);
    if (eligibility.state !== "eligible") {
      return finiteOutput(
        input,
        eligibility.state,
        eligibility.reasonCode,
        eligibility.guidance,
      );
    }

    if (input.executionContext !== "live_evaluation") {
      return finiteOutput(
        input,
        "unavailable",
        "provider_neutral_preflight_unavailable",
        "OSH Cut production quoting is unavailable until provider admission, exact action-time disclosure authorization, and immediate preflight are implemented.",
      );
    }

    if (!getAuthorizedLiveEvaluationFiles(input)) {
      return finiteOutput(
        input,
        "unavailable",
        "evaluation_file_authorization_missing",
        "OSH Cut evaluation requires the private digest-bound file authorization produced by the standalone evaluation entry point.",
      );
    }

    const result = await this.delegate.quote(input);
    const manualFollowup =
      result.status === "manual_vendor_followup" || result.status === "manual_review_pending";
    const operationalState = manualFollowup ? "manual_followup" : "unavailable";
    const reasonCode = manualFollowup
      ? "provider_manual_followup"
      : "evaluation_result_not_customer_live_offer";

    const finiteResult = finiteOutput(
      input,
      operationalState,
      reasonCode,
      "Standalone evaluation evidence is local-only and is never a customer live offer or production authorization.",
    );

    return {
      ...finiteResult,
      notes: [...result.notes, ...finiteResult.notes],
      artifacts: result.artifacts,
      rawPayload: {
        ...result.rawPayload,
        ...finiteResult.rawPayload,
        executionContext: "live_evaluation",
      },
    };
  }
}
