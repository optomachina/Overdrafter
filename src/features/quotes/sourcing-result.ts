import { scoreCapabilityMatch } from "@/features/quotes/scoring";
import type {
  PartAggregate,
  VendorCapabilityProfileRecord,
} from "@/features/quotes/types";
import { getVendorDisplayName } from "@/features/quotes/vendor-colors";
import type { Json, VendorName, VendorStatus } from "@/integrations/supabase/types";

const OFFICIAL_RFQ_URLS: Partial<Record<VendorName, string>> = {
  xometry: "https://www.xometry.com/quoting/home/",
  fictiv: "https://app.fictiv.com/pages/quotes/upload",
  protolabs: "https://www.protolabs.com/request-a-quote/",
  sendcutsend: "https://app.sendcutsend.com/",
};

const LIVE_OFFER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LIVE_OFFER_STATUSES = new Set<VendorStatus>([
  "instant_quote_received",
  "official_quote_received",
]);

export type SourcingLiveOfferCandidate = {
  offerKey: string;
  vendorKey: VendorName;
  vendorStatus?: VendorStatus;
  requestedQuantity: number;
  quoteDateIso: string | null;
  offerCreatedAt?: string;
  quoteUrl?: string | null;
  quoteResultCreatedAt?: string;
  quoteResultUpdatedAt?: string;
  quoteResultRawPayload?: Json;
};

export type ProviderRecommendation = {
  vendorName: VendorName;
  vendorLabel: string;
  fitScore: number;
  fitReasons: string[];
  officialRfqUrl: string;
  capabilityReviewedAt: string;
  provenance: "reviewed_provider_capability_profile";
};

export type UnsupportedPackageReason =
  | "part_not_ready"
  | "step_required"
  | "material_unresolved"
  | "unsupported_material"
  | "process_unresolved"
  | "unsupported_process"
  | "capability_data_unavailable"
  | "no_reviewed_provider_match";

export type ClientSourcingResult =
  | {
      outcome: "live_offers_available";
      liveOfferCount: number;
      liveOfferKeys: string[];
      recommendations: ProviderRecommendation[];
    }
  | {
      outcome: "provider_recommendations_available";
      reason: "free_preview" | "automatic_collection_fallback";
      recommendations: ProviderRecommendation[];
    }
  | {
      outcome: "unsupported_package";
      reason: UnsupportedPackageReason;
      title: string;
      explanation: string;
      nextAction: string;
    };

type SupportedRequirement = {
  processType: "cnc_milling" | "cnc_turning";
  material: "aluminum";
  quantity: number;
  toleranceRequiredMm?: number;
  reviewedAt?: string;
};

function readApprovedProcess(part: PartAggregate) {
  const snapshot = part.approvedRequirement?.spec_snapshot;

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }

  const process = snapshot.process;
  return typeof process === "string" ? process : null;
}

function normalizeProcess(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";

  if (normalized.includes("mill")) {
    return "cnc_milling" as const;
  }

  if (normalized.includes("turn") || normalized.includes("lathe")) {
    return "cnc_turning" as const;
  }

  return null;
}

function isMachiningProcess(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.includes("cnc") || normalized.includes("machin");
}

function normalizeMaterial(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";

  if (
    normalized.includes("aluminum") ||
    normalized.includes("aluminium") ||
    /\b(?:2024|5052|6061|6063|6082|7050|7075)\b/.test(normalized)
  ) {
    return "aluminum" as const;
  }

  return null;
}

function isStepFileName(fileName: string | null | undefined) {
  const normalized = fileName?.trim().toLowerCase() ?? "";
  return normalized.endsWith(".step") || normalized.endsWith(".stp");
}

function asRecord(value: Json | undefined): Record<string, Json | undefined> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value;
}

function isTrustedLiveAdapterOffer(offer: SourcingLiveOfferCandidate) {
  if (!offer.vendorStatus || !LIVE_OFFER_STATUSES.has(offer.vendorStatus)) {
    return false;
  }

  if (!offer.quoteUrl?.startsWith("https://")) {
    return false;
  }

  const payload = asRecord(offer.quoteResultRawPayload);
  if (!payload || payload.mode === "simulate" || payload.detectedFlow === "simulate") {
    return false;
  }

  if (offer.vendorKey === "fictiv") {
    return payload.source === "fictiv-live-adapter";
  }

  if (offer.vendorKey === "xometry") {
    return (
      typeof payload.automationVersion === "string" &&
      payload.automationVersion.startsWith("xometry-worker-")
    );
  }

  return false;
}

function isCurrentLiveOffer(
  offer: SourcingLiveOfferCandidate,
  requirement: SupportedRequirement,
  now: Date,
) {
  if (!isTrustedLiveAdapterOffer(offer)) {
    return false;
  }

  const collectionTimestamp =
    offer.quoteDateIso ?? offer.offerCreatedAt ?? offer.quoteResultCreatedAt;
  if (!collectionTimestamp) {
    return false;
  }

  const quotedAt = new Date(collectionTimestamp).getTime();
  const ageMs = now.getTime() - quotedAt;
  if (
    !Number.isFinite(quotedAt) ||
    ageMs < 0 ||
    ageMs > LIVE_OFFER_MAX_AGE_MS ||
    offer.requestedQuantity !== requirement.quantity
  ) {
    return false;
  }

  if (!requirement.reviewedAt) {
    return true;
  }

  const payload = asRecord(offer.quoteResultRawPayload);
  const capturedAt =
    typeof payload?.requirementCapturedAt === "string"
      ? payload.requirementCapturedAt
      : offer.quoteResultCreatedAt;
  if (!capturedAt) {
    return false;
  }

  const reviewedAt = new Date(requirement.reviewedAt).getTime();
  const requirementCapturedAt = new Date(capturedAt).getTime();
  return (
    Number.isFinite(reviewedAt) &&
    Number.isFinite(requirementCapturedAt) &&
    requirementCapturedAt >= reviewedAt
  );
}

function resolveSupportedRequirement(
  part: PartAggregate | null,
): SupportedRequirement | Exclude<ClientSourcingResult, { outcome: "live_offers_available" | "provider_recommendations_available" }> {
  if (!part) {
    return {
      outcome: "unsupported_package",
      reason: "part_not_ready",
      title: "Requirements are still being prepared",
      explanation: "OverDrafter needs a resolved part record before it can recommend providers.",
      nextAction: "Wait for extraction to finish, then review the part requirements.",
    };
  }

  if (!isStepFileName(part.cadFile?.original_name)) {
    return {
      outcome: "unsupported_package",
      reason: "step_required",
      title: "A STEP model is required",
      explanation: "The launch workflow supports machined aluminum parts supplied as .step or .stp CAD files, with an optional PDF drawing.",
      nextAction: "Attach a STEP model with the same filename stem as this part.",
    };
  }

  const material =
    part.clientRequirement?.material ??
    part.approvedRequirement?.material ??
    null;
  const normalizedMaterial = normalizeMaterial(material);

  if (!material?.trim()) {
    return {
      outcome: "unsupported_package",
      reason: "material_unresolved",
      title: "Confirm the material",
      explanation: "Provider fit cannot be reviewed until the material is known.",
      nextAction: "Set the material to the required aluminum alloy in the request details.",
    };
  }

  if (!normalizedMaterial) {
    return {
      outcome: "unsupported_package",
      reason: "unsupported_material",
      title: "This material is outside the launch scope",
      explanation: `OverDrafter currently supports machined aluminum parts; "${material}" was provided.`,
      nextAction: "Use an aluminum alloy or follow the official provider links outside OverDrafter.",
    };
  }

  const process =
    part.clientRequirement?.process ??
    readApprovedProcess(part);
  const normalizedProcess = normalizeProcess(process);

  if (!process?.trim() || isMachiningProcess(process)) {
    if (!normalizedProcess) {
      return {
        outcome: "unsupported_package",
        reason: "process_unresolved",
        title: "Confirm milling or turning",
        explanation: "The launch workflow supports CNC milling and CNC turning, but the current process is not specific enough to rank provider fit.",
        nextAction: "Choose CNC milling or CNC turning in the request details.",
      };
    }
  }

  if (!normalizedProcess) {
    return {
      outcome: "unsupported_package",
      reason: "unsupported_process",
      title: "This process is outside the launch scope",
      explanation: `OverDrafter currently supports CNC milling and CNC turning; "${process}" was provided.`,
      nextAction: "Select a supported machining process or use a provider's official RFQ flow.",
    };
  }

  const quantity =
    part.clientRequirement?.quantity ??
    part.approvedRequirement?.quantity ??
    part.quantity ??
    1;
  const toleranceInch =
    part.clientRequirement?.tightestToleranceInch ??
    part.approvedRequirement?.tightest_tolerance_inch ??
    null;

  const requirementRevisionTimes = [
    part.approvedRequirement?.updated_at,
    part.clientRequirement?.projectPartProperties?.updatedAt,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => ({ value, timestamp: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => right.timestamp - left.timestamp);

  return {
    processType: normalizedProcess,
    material: normalizedMaterial,
    quantity: Math.max(1, quantity),
    reviewedAt: requirementRevisionTimes[0]?.value,
    ...(toleranceInch === null
      ? {}
      : { toleranceRequiredMm: Math.abs(toleranceInch) * 25.4 }),
  };
}

function buildFitReasons(
  profile: VendorCapabilityProfileRecord,
  requirement: SupportedRequirement,
) {
  const reasons = [
    requirement.processType === "cnc_milling"
      ? "Reviewed for CNC milling"
      : "Reviewed for CNC turning",
    "Reviewed capability data includes aluminum",
  ];

  if (requirement.toleranceRequiredMm !== undefined) {
    reasons.push(
      `Reviewed tolerance capability supports ±${(requirement.toleranceRequiredMm / 25.4).toFixed(4)} in`,
    );
  }

  if (profile.domestic_us) {
    reasons.push("US-based provider");
  }

  if (profile.certifications.length > 0) {
    reasons.push(`Capabilities list ${profile.certifications.slice(0, 2).join(" and ")}`);
  }

  return reasons;
}

function profileSupportsMaterial(profile: VendorCapabilityProfileRecord) {
  return profile.materials.some((material) => normalizeMaterial(material) === "aluminum");
}

function profileSupportsTolerance(
  profile: VendorCapabilityProfileRecord,
  toleranceRequiredMm: number | undefined,
) {
  if (toleranceRequiredMm === undefined) {
    return true;
  }

  if (
    profile.tolerance_min_mm !== null &&
    toleranceRequiredMm < profile.tolerance_min_mm
  ) {
    return false;
  }

  return profile.tolerance_min_mm !== null;
}

function buildRecommendations(
  profiles: readonly VendorCapabilityProfileRecord[],
  requirement: SupportedRequirement,
) {
  return profiles
    .flatMap((profile) => {
      const officialRfqUrl = OFFICIAL_RFQ_URLS[profile.vendor_name];

      if (!officialRfqUrl) {
        return [];
      }

      if (
        !profileSupportsMaterial(profile) ||
        !profileSupportsTolerance(profile, requirement.toleranceRequiredMm)
      ) {
        return [];
      }

      const capabilityScore = scoreCapabilityMatch(
        {
          vendorName: profile.vendor_name,
          processTypes: profile.process_types,
          materials: profile.materials,
          toleranceMinMm: profile.tolerance_min_mm,
          toleranceMaxMm: null,
          maxPartSizeMm: profile.max_part_size_mm,
          minQuantity: profile.min_quantity,
          maxQuantity: profile.max_quantity,
          geographicRegion: profile.geographic_region,
          certifications: profile.certifications,
          qualityScore: profile.quality_score,
          leadTimeReliability: profile.lead_time_reliability,
          costCompetitiveness: profile.cost_competitiveness,
          domesticUs: profile.domestic_us,
        },
        {
          processType: requirement.processType,
          materials: [requirement.material],
          quantity: requirement.quantity,
          toleranceRequiredMm: requirement.toleranceRequiredMm,
        },
      );

      if (capabilityScore === 0) {
        return [];
      }

      const supportingScore =
        (profile.quality_score ?? 0) * 0.4 +
        (profile.lead_time_reliability ?? 0) * 0.35 +
        (profile.cost_competitiveness ?? 0) * 0.25;

      return [{
        vendorName: profile.vendor_name,
        vendorLabel: getVendorDisplayName(profile.vendor_name),
        fitScore: Math.round(capabilityScore * 0.75 + supportingScore * 0.25),
        fitReasons: buildFitReasons(profile, requirement),
        officialRfqUrl,
        capabilityReviewedAt: profile.updated_at,
        provenance: "reviewed_provider_capability_profile" as const,
      }];
    })
    .sort((left, right) =>
      right.fitScore - left.fitScore ||
      left.vendorLabel.localeCompare(right.vendorLabel),
    )
    .slice(0, 3);
}

/**
 * Builds the client-safe sourcing terminal state.
 *
 * Live prices are admitted only from successful Xometry/Fictiv live-adapter
 * payloads quoted within 14 days, for the current quantity, and after the
 * latest approved-requirement or client-override revision.
 * All other supported packages
 * degrade to recommendations derived from reviewed capability profiles.
 */
export function buildClientSourcingResult(input: {
  part: PartAggregate | null;
  profiles: readonly VendorCapabilityProfileRecord[];
  liveOffers: readonly SourcingLiveOfferCandidate[];
  automaticCollectionEnabled: boolean;
  capabilityDataAvailable?: boolean;
  now?: Date;
}): ClientSourcingResult {
  const requirement = resolveSupportedRequirement(input.part);

  if ("outcome" in requirement) {
    return requirement;
  }

  const liveOfferKeys = input.liveOffers
    .filter((offer) =>
      isCurrentLiveOffer(offer, requirement, input.now ?? new Date()),
    )
    .map((offer) => offer.offerKey);
  const liveOfferCount = liveOfferKeys.length;

  if (liveOfferCount > 0) {
    return {
      outcome: "live_offers_available",
      liveOfferCount,
      liveOfferKeys,
      recommendations:
        input.capabilityDataAvailable === false
          ? []
          : buildRecommendations(input.profiles, requirement),
    };
  }

  if (input.capabilityDataAvailable === false) {
    return {
      outcome: "unsupported_package",
      reason: "capability_data_unavailable",
      title: "Provider guidance is temporarily unavailable",
      explanation: "OverDrafter could not load the reviewed capability data needed to rank provider fit.",
      nextAction: "Refresh this page. Your uploaded package and reviewed requirements are preserved.",
    };
  }

  const recommendations = buildRecommendations(input.profiles, requirement);

  if (recommendations.length === 0) {
    return {
      outcome: "unsupported_package",
      reason: "no_reviewed_provider_match",
      title: "No reviewed provider match is available",
      explanation: "The current quantity or tolerance falls outside the reviewed capability data.",
      nextAction: "Adjust the requirement if appropriate or use a provider's official RFQ flow.",
    };
  }

  return {
    outcome: "provider_recommendations_available",
    reason: input.automaticCollectionEnabled
      ? "automatic_collection_fallback"
      : "free_preview",
    recommendations,
  };
}
