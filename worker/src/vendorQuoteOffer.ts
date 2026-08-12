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

function normalizeTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00.000Z`;
  }

  return Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeInclusiveValidUntil(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T23:59:59.999999Z`;
  }

  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Builds the normalized offer row while preserving the approved requested process
 * and the requirement capture timestamp used to validate offer freshness.
 */
export function buildVendorQuoteOfferPayload(input: VendorQuoteOfferPayloadInput) {
  const quotedAt = normalizeTimestamp(input.result.quotedAt);
  const validUntil = normalizeInclusiveValidUntil(input.result.validUntil);
  const validityDurationDays = Number.isInteger(input.result.validityDurationDays)
    && Number(input.result.validityDurationDays) > 0
    ? Number(input.result.validityDurationDays)
    : null;
  const validitySource = input.result.validitySource === "vendor_date"
    ? (validUntil ? input.result.validitySource : null)
    : (validityDurationDays ? input.result.validitySource ?? null : null);

  return {
    vendor_quote_result_id: input.vendorQuoteResultId,
    organization_id: input.organizationId,
    offer_key: `${input.vendor}-${input.requestedQuantity}`,
    supplier: input.vendor,
    lane_label: `${input.vendor} quote`,
    sourcing: "automated",
    tier: input.result.status === "official_quote_received" ? "Official" : "Instant",
    quoted_at: quotedAt,
    valid_until: validUntil,
    validity_duration_days: validityDurationDays,
    validity_source: validitySource,
    validity_terms: input.result.validityTerms ?? null,
    provenance_status: isTrustedLiveAdapter(input.vendor, input.result.rawPayload)
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

function isTrustedLiveAdapter(vendor: VendorName, rawPayload: Record<string, unknown>) {
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
  return vendor === "xometry"
    && automationVersion.startsWith("xometry-worker-")
    && detectedFlow !== "simulate";
}
