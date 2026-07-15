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
  result: VendorQuoteAdapterOutput;
};

/**
 * Builds the normalized offer row while preserving the approved requested process.
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
      requestedQuantity: input.requestedQuantity,
    },
  };
}
