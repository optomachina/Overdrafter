import { resolveRequirementProcess } from "./partContext.js";
import type {
  ApprovedRequirementRecord,
  VendorQuoteAdapterOffer,
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
  const payload = buildVendorQuoteOfferPayloads(input)[0];
  if (!payload) {
    throw new Error("A compatibility offer requires both total and unit price.");
  }
  return payload;
}

function normalizedAdapterOffers(input: VendorQuoteOfferPayloadInput): VendorQuoteAdapterOffer[] {
  if (input.result.offers && input.result.offers.length > 0) {
    return input.result.offers;
  }

  if (
    input.result.totalPriceUsd === null ||
    input.result.unitPriceUsd === null
  ) {
    return [];
  }

  return [{
    providerOptionId: String(input.requestedQuantity),
    providerLabel: `${input.vendor} quote`,
    quoteRef: null,
    quoteUrl: input.result.quoteUrl,
    unitPriceUsd: input.result.unitPriceUsd,
    totalPriceUsd: input.result.totalPriceUsd,
    leadTimeBusinessDays: input.result.leadTimeBusinessDays,
    shipReceiveBy: null,
    tier: input.result.status === "official_quote_received" ? "Official" : "Instant",
    sourcing: "automated",
    geographicOrigin: "unknown",
    sortRank: 0,
    provenance: {
      containerSelector: "compatibility_summary",
      providerOptionIdSource: "provider_label",
      priceSource: "selector",
      leadTimeSource: input.result.leadTimeBusinessDays === null ? "none" : "selector",
      geographicOriginSource: "none",
    },
    rawPayload: {},
  }];
}

/** Builds one canonical persistence row per provider offer. */
export function buildVendorQuoteOfferPayloads(input: VendorQuoteOfferPayloadInput) {
  const quotedAt = normalizeTimestamp(input.result.quotedAt);
  const validUntil = normalizeInclusiveValidUntil(input.result.validUntil);
  const validityDurationDays = Number.isInteger(input.result.validityDurationDays)
    && Number(input.result.validityDurationDays) > 0
    ? Number(input.result.validityDurationDays)
    : null;
  const validitySource = input.result.validitySource === "vendor_date"
    ? (validUntil ? input.result.validitySource : null)
    : (validityDurationDays ? input.result.validitySource ?? null : null);

  const { offers: _offers, ...resultRawPayload } = input.result.rawPayload;

  return normalizedAdapterOffers(input).map((offer) => ({
    vendor_quote_result_id: input.vendorQuoteResultId,
    organization_id: input.organizationId,
    offer_key: `${input.vendor}-${offer.providerOptionId}`,
    supplier: input.vendor,
    lane_label: offer.providerLabel,
    sourcing: offer.sourcing,
    geographic_origin: offer.geographicOrigin,
    tier: offer.tier,
    quote_ref: offer.quoteRef,
    quote_date: quotedAt?.slice(0, 10) ?? null,
    quoted_at: quotedAt,
    valid_until: validUntil,
    validity_duration_days: validityDurationDays,
    validity_source: validitySource,
    validity_terms: input.result.validityTerms ?? null,
    provenance_status: isTrustedLiveAdapter(input.vendor, input.result.rawPayload)
      ? "trusted_adapter"
      : "unverified",
    unit_price_usd: offer.unitPriceUsd,
    total_price_usd: offer.totalPriceUsd,
    lead_time_business_days: offer.leadTimeBusinessDays,
    ship_receive_by: offer.shipReceiveBy,
    process: resolveRequirementProcess(input.requirement.spec_snapshot),
    material: input.requirement.material,
    finish: input.requirement.finish,
    tightest_tolerance:
      input.requirement.tightest_tolerance_inch?.toString() ?? null,
    notes: input.result.notes.join("\n") || null,
    sort_rank: offer.sortRank,
    raw_payload: {
      ...resultRawPayload,
      ...offer.rawPayload,
      providerOptionId: offer.providerOptionId,
      providerLabel: offer.providerLabel,
      quoteUrl: offer.quoteUrl,
      quotedAt: input.result.quotedAt ?? null,
      validUntil: input.result.validUntil ?? null,
      validityDurationDays: input.result.validityDurationDays ?? null,
      validitySource: input.result.validitySource ?? null,
      validityTerms: input.result.validityTerms ?? null,
      requestedQuantity: input.requestedQuantity,
      requirementCapturedAt: input.requirementCapturedAt,
      provenance: offer.provenance,
    },
  }));
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
