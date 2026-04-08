/**
 * Scoring integration for the worker (OVD-138).
 *
 * After all vendor quotes for a quote run are received, this module:
 * 1. Fetches all successful vendor quote results for the quote run
 * 2. Fetches vendor capability profiles
 * 3. Computes routing scores using the worker-side scoring engine
 * 4. Stores scores in vendor_routing_scores
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { rankVendors } from "./scoring.js";
import type { VendorName } from "./types.js";

/**
 * Attempts to compute and store routing scores for a quote run.
 *
 * This is called after a vendor quote task completes successfully.
 * It checks if all vendor quotes for the quote run are done, and if so,
 * computes scores for all successful vendors.
 *
 * Returns true if scores were computed, false if the quote run is not yet complete.
 */
export async function computeAndStoreRoutingScores(
  supabase: SupabaseClient,
  quoteRunId: string,
  organizationId: string,
): Promise<boolean> {
  // Fetch all vendor quote results for this quote run
  const { data: quoteResults, error: quoteResultsError } = await supabase
    .from("vendor_quote_results")
    .select("vendor, status, unit_price_usd, total_price_usd, lead_time_business_days")
    .eq("quote_run_id", quoteRunId);

  if (quoteResultsError || !quoteResults) {
    console.warn(
      JSON.stringify({
        service: "overdrafter-cad-worker",
        level: "warn",
        source: "worker.scoring",
        message: `Failed to fetch quote results for scoring: ${quoteResultsError?.message ?? "no data"}`,
        context: { quoteRunId },
      }),
    );
    return false;
  }

  // Check if all vendor quotes are in a terminal state
  const terminalStates = new Set([
    "instant_quote_received",
    "official_quote_received",
    "manual_vendor_followup",
    "failed",
    "stale",
  ]);

  const allDone = quoteResults.every((row) => terminalStates.has(row.status));

  if (!allDone) {
    // Not all quotes are done yet, skip scoring for now
    return false;
  }

  // Filter to only successful vendors (those with a quote result)
  const successfulVendors = quoteResults.filter(
    (row) =>
      row.status === "instant_quote_received" || row.status === "official_quote_received",
  );

  if (successfulVendors.length === 0) {
    // No successful vendors to score
    return false;
  }

  // Fetch vendor capability profiles for successful vendors
  const vendorNames = successfulVendors.map((row) => row.vendor) as VendorName[];
  const { data: profiles, error: profilesError } = await supabase
    .from("vendor_capability_profiles")
    .select("*")
    .in("vendor_name", vendorNames);

  if (profilesError || !profiles) {
    console.warn(
      JSON.stringify({
        service: "overdrafter-cad-worker",
        level: "warn",
        source: "worker.scoring",
        message: `Failed to fetch capability profiles for scoring: ${profilesError?.message ?? "no data"}`,
        context: { quoteRunId, vendorNames },
      }),
    );
    return false;
  }

  // Build price and lead time maps for scoring
  const prices: Record<string, number> = {};
  const leadTimes: Record<string, number> = {};

  for (const result of successfulVendors) {
    // Use total_price_usd if available, fall back to unit_price_usd
    const price = result.total_price_usd ?? result.unit_price_usd;
    if (price !== null && price !== undefined && !Number.isNaN(price) && price > 0) {
      prices[result.vendor] = price;
    }
    if (
      result.lead_time_business_days !== null &&
      result.lead_time_business_days !== undefined &&
      !Number.isNaN(result.lead_time_business_days) &&
      result.lead_time_business_days >= 0
    ) {
      leadTimes[result.vendor] = result.lead_time_business_days;
    }
  }

  // Build vendor list for scoring
  const vendorsForScoring = profiles.map((profile) => ({
    vendorName: profile.vendor_name,
    qualityScore: profile.quality_score != null ? Number(profile.quality_score) : 0,
    domesticUs: Boolean(profile.domestic_us),
  }));

  // Compute scores
  const scored = rankVendors(vendorsForScoring, prices, leadTimes);

  // Store scores in the database
  for (const score of scored) {
    const { error: insertError } = await supabase
      .from("vendor_routing_scores")
      .upsert(
        {
          vendor_name: score.vendorName,
          quote_run_id: quoteRunId,
          organization_id: organizationId,
          overall_score: Math.round(score.overallScore * 100) / 100,
          price_score: Math.round(score.priceScore * 100) / 100,
          lead_time_score: Math.round(score.leadTimeScore * 100) / 100,
          quality_score: Math.round(score.qualityScore * 100) / 100,
          capability_match_score: Math.round(score.capabilityMatchScore * 100) / 100,
          domestic_score: Math.round(score.domesticScore * 100) / 100,
          score_breakdown: {
            price: score.priceScore,
            leadTime: score.leadTimeScore,
            quality: score.qualityScore,
            capabilityMatch: score.capabilityMatchScore,
            domestic: score.domesticScore,
          },
        },
        {
          onConflict: "quote_run_id,vendor_name",
        },
      );

    if (insertError) {
      console.warn(
        JSON.stringify({
          service: "overdrafter-cad-worker",
          level: "warn",
          source: "worker.scoring",
          message: `Failed to store routing score for ${score.vendorName}: ${insertError.message}`,
          context: { quoteRunId, vendorName: score.vendorName },
        }),
      );
    }
  }

  console.log(
    JSON.stringify({
      service: "overdrafter-cad-worker",
      level: "info",
      source: "worker.scoring",
      message: `Computed routing scores for ${scored.length} vendor(s) in quote run ${quoteRunId}.`,
      context: {
        quoteRunId,
        vendorCount: scored.length,
        topVendor: scored[0]?.vendorName ?? null,
        topScore: scored[0]?.overallScore ?? null,
      },
    }),
  );

  return true;
}
