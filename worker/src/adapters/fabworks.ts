import path from "node:path";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import {
  VendorAutomationError,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type WorkerConfig,
} from "../types.js";
import { VendorAdapter } from "./base.js";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows.js";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow.js";

type NormalizedProcess =
  | "sheet_metal_laser_cutting"
  | "sheet_metal_bending"
  | "tube_laser_cutting";

type NormalizedGeometry = "flat_sheet_2d" | "bent_sheet_3d" | "tube_3d";

type NormalizedMaterial =
  | "5052-H32 aluminum"
  | "6061-T6 aluminum"
  | "7075-T6 aluminum"
  | "1008 steel"
  | "A36 steel"
  | "A513 steel"
  | "A519 steel"
  | "304-2B stainless steel"
  | "G90 galvanized steel";

type FabworksFileExtension = "dxf" | "step" | "stp";

type FabworksCompatibilityRow = {
  process: NormalizedProcess;
  geometryFamily: NormalizedGeometry;
  fileExtensions: readonly FabworksFileExtension[];
  materials: readonly NormalizedMaterial[];
};

const FABWORKS_COMPATIBILITY_MATRIX = [
  {
    process: "sheet_metal_laser_cutting",
    geometryFamily: "flat_sheet_2d",
    fileExtensions: ["dxf", "step", "stp"],
    materials: [
      "5052-H32 aluminum",
      "6061-T6 aluminum",
      "7075-T6 aluminum",
      "1008 steel",
      "A36 steel",
      "304-2B stainless steel",
      "G90 galvanized steel",
    ],
  },
  {
    process: "sheet_metal_bending",
    geometryFamily: "bent_sheet_3d",
    fileExtensions: ["step", "stp"],
    materials: [
      "5052-H32 aluminum",
      "6061-T6 aluminum",
      "7075-T6 aluminum",
      "1008 steel",
      "A36 steel",
      "304-2B stainless steel",
      "G90 galvanized steel",
    ],
  },
  {
    process: "tube_laser_cutting",
    geometryFamily: "tube_3d",
    fileExtensions: ["step", "stp"],
    materials: ["6061-T6 aluminum"],
  },
] as const satisfies readonly FabworksCompatibilityRow[];

const FABWORKS_COMPATIBILITY_ROWS: readonly FabworksCompatibilityRow[] =
  FABWORKS_COMPATIBILITY_MATRIX;

export const FABWORKS_ENVELOPE = {
  schemaVersion: "provider-envelope.v1",
  revision: "fabworks-sheet-tube-envelope.2026-08-26.v1",
  evidenceReviewedAt: "2026-08-26",
  evidence: [
    {
      url: "https://www.fabworks.com/",
      supports: [
        "instant_quote_workflow",
        "sheet_and_tube_processes",
        "materials",
        "file_formats",
        "file_size",
        "quantity",
      ],
    },
    {
      url: "https://www.fabworks.com/services/laser-cutting",
      supports: ["sheet_laser_process", "quantity"],
    },
  ],
  compatibilityMatrix: FABWORKS_COMPATIBILITY_MATRIX,
  files: {
    maxBytes: 24_000_000,
  },
  quantity: {
    minimum: 1,
    maximum: null,
  },
  account: {
    automationSession: "required",
  },
  productionControls: {
    providerAdmission: "required_unavailable",
    actionTimeDisclosureAuthorization: "required_unavailable",
    immediatePreflight: "required_unavailable",
    sessionIsolation: "one_browser_context_per_attempt",
    intent: "quote_only",
    orderActions: "prohibited",
  },
} as const;

export type FabworksInterfaceState =
  | "eligible"
  | "unsupported"
  | "unavailable"
  | "manual_follow_up";

export type FabworksEligibilityDecision = {
  state: FabworksInterfaceState;
  reason: string;
  envelopeRevision: typeof FABWORKS_ENVELOPE.revision;
  process: string | null;
  material: string | null;
  geometryFamily: string | null;
  fileExtension: string | null;
  quantity: number;
};

type FabworksEligibilityInput = {
  process: string | null;
  material: string;
  geometryFamily: string | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  quantity: number;
  accountAvailable: boolean;
};

type FabworksDelegate = Pick<VendorAdapter, "quote">;

const CNC_MILLING_PATTERN = /\b(?:cnc\s*)?(?:mill(?:ing|ed)?|machin(?:e|ing))\b/i;
const BROAD_SUPPORTED_MATERIAL_PATTERN = /\b(?:aluminum|steel|stainless|galvanized)\b/i;

function normalizedToken(value: string) {
  return value.trim().toLowerCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");
}

function normalizeProcess(value: string): NormalizedProcess | null {
  const token = normalizedToken(value);
  if (token === "laser cutting" || token === "sheet metal laser cutting") {
    return "sheet_metal_laser_cutting";
  }
  if (token === "sheet metal bending" || token === "bending") {
    return "sheet_metal_bending";
  }
  if (token === "tube laser cutting" || token === "tube cutting") {
    return "tube_laser_cutting";
  }
  return null;
}

function normalizeGeometry(value: string): NormalizedGeometry | null {
  const token = normalizedToken(value);
  if (["flat sheet", "flat sheet 2d", "2d sheet", "flat 2d"].includes(token)) {
    return "flat_sheet_2d";
  }
  if (["bent sheet", "bent sheet 3d", "3d sheet", "bent 3d"].includes(token)) {
    return "bent_sheet_3d";
  }
  if (
    [
      "tube",
      "tube 3d",
      "round tube",
      "square tube",
      "rectangular tube",
    ].includes(token)
  ) {
    return "tube_3d";
  }
  return null;
}

function normalizeMaterial(value: string): NormalizedMaterial | null {
  const token = value.trim().toUpperCase().replaceAll(/\s+/g, " ");
  if (/\b5052-?H32\b/.test(token)) return "5052-H32 aluminum";
  if (/\b6061-?T6\b/.test(token)) return "6061-T6 aluminum";
  if (/\b7075-?T6\b/.test(token)) return "7075-T6 aluminum";
  if (/\b1008\b/.test(token)) return "1008 steel";
  if (/\bA36\b/.test(token)) return "A36 steel";
  if (/\bA513\b/.test(token)) return "A513 steel";
  if (/\bA519\b/.test(token)) return "A519 steel";
  if (/\b304-?2B\b/.test(token)) return "304-2B stainless steel";
  if (/\bG90\b/.test(token)) return "G90 galvanized steel";
  return null;
}

function decision(
  input: FabworksEligibilityInput,
  state: FabworksInterfaceState,
  reason: string,
  normalized: {
    process?: string | null;
    material?: string | null;
    geometryFamily?: string | null;
    fileExtension?: string | null;
  } = {},
): FabworksEligibilityDecision {
  return {
    state,
    reason,
    envelopeRevision: FABWORKS_ENVELOPE.revision,
    process: normalized.process ?? input.process,
    material: normalized.material ?? null,
    geometryFamily: normalized.geometryFamily ?? input.geometryFamily,
    fileExtension: normalized.fileExtension ?? null,
    quantity: input.quantity,
  };
}

/** Classifies a package without contacting Fabworks or reading account secrets. */
export function evaluateFabworksEligibility(
  input: FabworksEligibilityInput,
): FabworksEligibilityDecision {
  if (!input.process) {
    return decision(input, "unavailable", "process_evidence_missing");
  }
  if (CNC_MILLING_PATTERN.test(input.process)) {
    return decision(input, "unsupported", "cnc_milling_not_certified");
  }

  const process = normalizeProcess(input.process);
  if (!process) {
    return decision(input, "unsupported", "process_outside_envelope");
  }

  const fileExtension = input.fileName
    ? path.extname(input.fileName).slice(1).toLowerCase() || null
    : null;
  if (!fileExtension) {
    return decision(input, "unavailable", "file_evidence_missing", { process });
  }
  const supportedFileExtension = FABWORKS_COMPATIBILITY_ROWS.some((row) =>
    row.fileExtensions.includes(fileExtension as FabworksFileExtension));
  if (!supportedFileExtension) {
    return decision(input, "unsupported", "file_format_outside_envelope", {
      process,
      fileExtension,
    });
  }
  if (input.fileSizeBytes === null || !Number.isFinite(input.fileSizeBytes)) {
    return decision(input, "unavailable", "file_size_evidence_missing", {
      process,
      fileExtension,
    });
  }
  if (input.fileSizeBytes <= 0 || input.fileSizeBytes > FABWORKS_ENVELOPE.files.maxBytes) {
    return decision(input, "unsupported", "file_size_outside_envelope", {
      process,
      fileExtension,
    });
  }

  let geometryFamily = input.geometryFamily
    ? normalizeGeometry(input.geometryFamily)
    : null;
  if (fileExtension === "dxf" && process === "sheet_metal_laser_cutting") {
    geometryFamily = "flat_sheet_2d";
  }
  if (!geometryFamily) {
    return decision(input, "manual_follow_up", "geometry_requires_review", {
      process,
      fileExtension,
    });
  }
  const material = normalizeMaterial(input.material);
  if (!material) {
    if (BROAD_SUPPORTED_MATERIAL_PATTERN.test(input.material)) {
      return decision(input, "manual_follow_up", "material_grade_requires_review", {
        process,
        geometryFamily,
        fileExtension,
      });
    }
    return decision(input, "unsupported", "material_outside_envelope", {
      process,
      geometryFamily,
      fileExtension,
    });
  }

  const supportedCombination = FABWORKS_COMPATIBILITY_ROWS.some((row) =>
    row.process === process
    && row.geometryFamily === geometryFamily
    && row.fileExtensions.includes(fileExtension as FabworksFileExtension)
    && row.materials.includes(material));
  if (!supportedCombination) {
    return decision(input, "unsupported", "combination_outside_envelope", {
      process,
      material,
      geometryFamily,
      fileExtension,
    });
  }

  if (!Number.isInteger(input.quantity) || input.quantity < FABWORKS_ENVELOPE.quantity.minimum) {
    return decision(input, "unsupported", "quantity_outside_envelope", {
      process,
      material,
      geometryFamily,
      fileExtension,
    });
  }
  if (!input.accountAvailable) {
    return decision(input, "unavailable", "authenticated_session_unavailable", {
      process,
      material,
      geometryFamily,
      fileExtension,
    });
  }

  return decision(input, "eligible", "package_within_envelope", {
    process,
    material,
    geometryFamily,
    fileExtension,
  });
}

function specString(specSnapshot: unknown, keys: readonly string[]): string | null {
  if (!specSnapshot || typeof specSnapshot !== "object" || Array.isArray(specSnapshot)) {
    return null;
  }
  const record = specSnapshot as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function hasConfiguredSession(config: WorkerConfig) {
  return Boolean(
    config.vendorStorageStateJson?.fabworks || config.vendorStorageStatePaths?.fabworks,
  );
}

function policyPayload(decisionValue: FabworksEligibilityDecision) {
  return {
    source: "fabworks-provider-interface",
    automationVersion: "fabworks-interface-v1",
    fabworksState: decisionValue.state,
    eligibilityReason: decisionValue.reason,
    envelopeRevision: FABWORKS_ENVELOPE.revision,
    evidenceReviewedAt: FABWORKS_ENVELOPE.evidenceReviewedAt,
    process: decisionValue.process,
    material: decisionValue.material,
    geometryFamily: decisionValue.geometryFamily,
    fileExtension: decisionValue.fileExtension,
    requestedQuantity: decisionValue.quantity,
    quoteIntent: "quote_only",
    orderActions: "prohibited",
    productionControls: FABWORKS_ENVELOPE.productionControls,
  };
}

function finiteOutput(
  input: VendorQuoteAdapterInput,
  decisionValue: FabworksEligibilityDecision,
  state: Exclude<FabworksInterfaceState, "eligible">,
  reason: string,
  artifacts: VendorQuoteAdapterOutput["artifacts"] = [],
): VendorQuoteAdapterOutput {
  return {
    vendor: "fabworks",
    status: "manual_vendor_followup",
    unitPriceUsd: null,
    totalPriceUsd: null,
    leadTimeBusinessDays: null,
    quoteUrl: null,
    dfmIssues: [],
    notes: [reason],
    artifacts,
    rawPayload: {
      ...policyPayload({ ...decisionValue, state }),
      partId: input.part.id,
    },
  };
}

function isFinitePositivePrice(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasValidOfferPrices(result: VendorQuoteAdapterOutput): boolean {
  if (result.offers === undefined) {
    return true;
  }
  return result.offers.length > 0 && result.offers.every((offer) =>
    isFinitePositivePrice(offer.unitPriceUsd)
    && isFinitePositivePrice(offer.totalPriceUsd));
}

function isValidLiveOfferResult(result: VendorQuoteAdapterOutput): boolean {
  const liveStatus =
    result.status === "instant_quote_received"
    || result.status === "official_quote_received";
  return liveStatus
    && isFinitePositivePrice(result.unitPriceUsd)
    && isFinitePositivePrice(result.totalPriceUsd)
    && hasValidOfferPrices(result);
}

/**
 * Provider-local Fabworks adapter. Production disclosure remains disabled until
 * the provider-neutral admission, permit, and immediate-preflight contract is available.
 */
export class FabworksAdapter extends VendorAdapter {
  private readonly delegate: FabworksDelegate;

  constructor(
    config: WorkerConfig,
    delegate?: FabworksDelegate,
  ) {
    super("fabworks", config);
    const workflow = getExtendedVendorWorkflow("fabworks");
    if (!workflow) {
      throw new Error("Fabworks workflow configuration is missing.");
    }
    this.delegate = delegate ?? new PortalQuoteWorkflowAdapter("fabworks", config, workflow);
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    const authorizedEvaluationFiles = getAuthorizedLiveEvaluationFiles(input);
    const fileSizeBytes = authorizedEvaluationFiles?.cad.buffer.byteLength
      ?? input.cadFile?.size_bytes
      ?? null;
    const eligibility = evaluateFabworksEligibility({
      process: specString(input.requirement.spec_snapshot, ["process"]),
      material: input.requirement.material,
      geometryFamily: specString(input.requirement.spec_snapshot, [
        "geometryFamily",
        "geometry_family",
        "geometry",
      ]),
      fileName: input.stagedCadFile?.originalName ?? input.cadFile?.original_name ?? null,
      fileSizeBytes,
      quantity: input.requestedQuantity,
      accountAvailable: hasConfiguredSession(this.config),
    });

    if (eligibility.state !== "eligible") {
      return finiteOutput(
        input,
        eligibility,
        eligibility.state,
        `Fabworks did not receive this package: ${eligibility.reason}.`,
      );
    }

    if (this.config.workerMode !== "live") {
      return finiteOutput(
        input,
        eligibility,
        "manual_follow_up",
        "Fabworks simulation is guidance only and is not a live provider offer.",
      );
    }

    if (input.executionContext !== "live_evaluation" || !authorizedEvaluationFiles) {
      return finiteOutput(
        input,
        eligibility,
        "unavailable",
        "Fabworks production dispatch is unavailable until provider admission, action-time disclosure authorization, and immediate preflight are implemented.",
      );
    }

    try {
      const result = await this.delegate.quote(input);
      if (isValidLiveOfferResult(result)) {
        return {
          ...result,
          rawPayload: {
            ...result.rawPayload,
            ...policyPayload(eligibility),
            fabworksState: "live_offer",
            executionContext: "live_evaluation",
          },
        };
      }

      const invalidSuccessStatus =
        result.status === "instant_quote_received"
        || result.status === "official_quote_received";
      return {
        ...result,
        status: result.status === "manual_review_pending"
          ? "manual_review_pending"
          : "manual_vendor_followup",
        unitPriceUsd: null,
        totalPriceUsd: null,
        offers: undefined,
        quoteUrl: invalidSuccessStatus ? null : result.quoteUrl,
        rawPayload: {
          ...result.rawPayload,
          ...policyPayload(eligibility),
          fabworksState: "manual_follow_up",
          normalizationReason: invalidSuccessStatus
            ? "invalid_live_offer_payload"
            : "provider_manual_follow_up",
          executionContext: "live_evaluation",
        },
      };
    } catch (error) {
      if (!(error instanceof VendorAutomationError)) {
        throw error;
      }
      const unavailableCodes = new Set([
        "login_required",
        "captcha",
        "anti_detection_block",
        "profile_in_use",
        "not_implemented",
      ]);
      const state = unavailableCodes.has(error.code) ? "unavailable" : "manual_follow_up";
      return finiteOutput(
        input,
        eligibility,
        state,
        `Fabworks reached a finite ${state} state: ${error.code}.`,
        error.artifacts,
      );
    }
  }
}
