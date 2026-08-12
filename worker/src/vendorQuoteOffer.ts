import { resolveRequirementProcess } from "./partContext.js";
import type {
  ApprovedRequirementRecord,
  VendorName,
  VendorQuoteAdapterOutput,
} from "./types.js";

type VendorQuoteOfferPayloadInput = {
  vendorQuoteResultId: string;
  organizationId: string;
  vendor: VendorName;
  requestedQuantity: number;
  requirement: ApprovedRequirementRecord;
  requirementCapturedAt: string;
  result: VendorQuoteAdapterOutput;
};

/**
 * Builds the normalized offer row while preserving the approved requested process
 * and the requirement capture timestamp used to validate offer freshness.
 */
export function buildVendorQuoteOfferPayload(input: VendorQuoteOfferPayloadInput) {
  return {
    vendor_quote_result_id: input.vendorQuoteResultId,
    organization_id: input.organizationId,
    offer_key: `${input.vendor}-${input.requestedQuantity}`,
    supplier: input.vendor,
    lane_label: `${input.vendor} quote`,
    sourcing: "automated",
    tier: input.result.status === "official_quote_received" ? "Official" : "Instant",
    quoted_at: input.result.quotedAt ?? null,
    valid_until: input.result.validUntil ?? null,
    validity_duration_days: input.result.validityDurationDays ?? null,
    validity_source: input.result.validitySource ?? null,
    validity_terms: input.result.validityTerms ?? null,
    provenance_status: isTrustedLiveAdapter(input.result.rawPayload)
      ? "trusted_adapter"
      : "unverified",
    unit_price_usd: input.result.unitPriceUsd,
    total_price_usd: input.result.totalPriceUsd,
    lead_time_business_days: input.result.leadTimeBusinessDays,
    process: resolveRequirementProcess(input.requirement.spec_snapshot),
    material: input.requirement.material,
    finish: input.requirement.finish,
    tightest_tolerance:
      input.requirement.tightest_tolerance_inch?.toString() ?? null,
    notes: input.result.notes.join("\n") || null,
    raw_payload: {
      ...input.result.rawPayload,
      quoteUrl: input.result.quoteUrl,
      quotedAt: input.result.quotedAt ?? null,
      validUntil: input.result.validUntil ?? null,
      validityDurationDays: input.result.validityDurationDays ?? null,
      validitySource: input.result.validitySource ?? null,
      validityTerms: input.result.validityTerms ?? null,
      requestedQuantity: input.requestedQuantity,
      requirementCapturedAt: input.requirementCapturedAt,
    },
  };
}

function isTrustedLiveAdapter(rawPayload: Record<string, unknown>) {
  const source = typeof rawPayload.source === "string" ? rawPayload.source : "";
  if (source.endsWith("-live-adapter")) {
    return true;
  }

  const automationVersion =
    typeof rawPayload.automationVersion === "string"
      ? rawPayload.automationVersion
      : "";
  const detectedFlow =
    typeof rawPayload.detectedFlow === "string" ? rawPayload.detectedFlow : "";
  return automationVersion.startsWith("xometry-worker-") && detectedFlow !== "simulate";
}
