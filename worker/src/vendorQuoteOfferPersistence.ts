import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeWorkerError } from "./errorSummary.js";
import { VendorAutomationError } from "./types.js";
import type { buildVendorQuoteOfferPayloads } from "./vendorQuoteOffer.js";

type VendorQuoteOfferPayload = ReturnType<typeof buildVendorQuoteOfferPayloads>[number];

export type VendorQuoteResultFinalization = {
  status: string;
  unit_price_usd: number | null;
  total_price_usd: number | null;
  lead_time_business_days: number | null;
  quote_url: string | null;
  dfm_issues: unknown;
  notes: unknown;
  raw_payload: unknown;
};

/** Atomically finalizes the parent result and its complete provider-variant set. */
export async function finalizeVendorQuoteResult(
  supabase: SupabaseClient,
  vendorQuoteResultId: string,
  result: VendorQuoteResultFinalization,
  offerPayloads: readonly VendorQuoteOfferPayload[],
) {
  const { error } = await supabase.rpc("reconcile_vendor_quote_offers", {
    p_vendor_quote_result_id: vendorQuoteResultId,
    p_result: result,
    p_offers: [...offerPayloads],
  });

  if (error) {
    throw new VendorAutomationError(
      `Vendor quote result finalization failed: ${summarizeWorkerError(error)}`,
      "persistence_failure",
      {
        reason: "quote_result_finalization_failed",
        vendorQuoteResultId,
        offerKeys: offerPayloads.map((offer) => offer.offer_key),
      },
    );
  }
}
