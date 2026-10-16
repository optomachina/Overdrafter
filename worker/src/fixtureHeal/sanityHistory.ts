import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceHistory } from "./sanity.js";

/**
 * OVD-813: the history and peer read behind the outlier rules (design §3.4).
 * One service-role select on `public.vendor_quote_results`, no migration: it
 * keys on the part package identity the gate records in
 * `raw_payload.fixtureSanity.packageId` (or the pipeline's
 * `raw_payload.providerResultProvenance.packageId`) and the requested quantity.
 * Only accepted statuses with a price count, so a held, failed or internal
 * result never becomes the baseline for the next one. Any read failure comes
 * back as `available: false`, which the gate holds on (fail closed).
 */

export const HISTORY_WINDOW_DAYS = 90;
export const PEER_WINDOW_DAYS = 30;
export const HISTORY_ROW_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCEPTED_STATUSES = ["instant_quote_received", "official_quote_received"] as const;
const PACKAGE_ID = /^[a-f0-9]{64}$/;

export type SanityHistoryQuery = {
  provider: string;
  /** sha256 package identity of the disclosed files; null when none could be derived. */
  packageId: string | null;
  requestedQuantity: number;
  /** The result being checked, never compared with itself. */
  excludeResultId: string;
  nowMs: number;
};

export type SanityHistoryRow = { vendor: string; unit_price_usd: number | string | null; created_at: string };

export type SanityHistoryReader = (query: SanityHistoryQuery) => Promise<PriceHistory>;

/** Pure: splits rows into this supplier's 90 day history and the cheapest 30 day price per other supplier. */
export function summarizeSanityHistory(rows: readonly SanityHistoryRow[], query: SanityHistoryQuery): PriceHistory {
  const history: number[] = [];
  const cheapestPeer = new Map<string, number>();
  const historySince = query.nowMs - HISTORY_WINDOW_DAYS * DAY_MS;
  const peerSince = query.nowMs - PEER_WINDOW_DAYS * DAY_MS;
  for (const row of rows) {
    const unit = Number(row.unit_price_usd);
    const createdMs = Date.parse(row.created_at);
    if (row.unit_price_usd === null || !Number.isFinite(unit) || unit <= 0 || !Number.isFinite(createdMs)) continue;
    if (row.vendor === query.provider) {
      if (createdMs >= historySince) history.push(unit);
    } else if (createdMs >= peerSince) {
      cheapestPeer.set(row.vendor, Math.min(cheapestPeer.get(row.vendor) ?? Number.POSITIVE_INFINITY, unit));
    }
  }
  return { available: true, history, peers: [...cheapestPeer.values()] };
}

export function createSupabaseSanityHistoryReader(supabase: SupabaseClient): SanityHistoryReader {
  return async (query) => {
    // No package identity means nothing comparable exists; that is not a read failure.
    if (query.packageId === null) return { available: true, history: [], peers: [] };
    // The id is interpolated into a PostgREST filter, so only a bare sha256 is accepted.
    if (!PACKAGE_ID.test(query.packageId)) return { available: false, reason: "package_id_malformed" };
    try {
      const { data, error } = await supabase
        .from("vendor_quote_results")
        .select("vendor, unit_price_usd, created_at")
        .eq("requested_quantity", query.requestedQuantity)
        .in("status", [...ACCEPTED_STATUSES])
        .neq("id", query.excludeResultId)
        .gte("created_at", new Date(query.nowMs - HISTORY_WINDOW_DAYS * DAY_MS).toISOString())
        .or(
          `raw_payload->fixtureSanity->>packageId.eq.${query.packageId},` +
            `raw_payload->providerResultProvenance->>packageId.eq.${query.packageId}`,
        )
        .order("created_at", { ascending: false })
        .limit(HISTORY_ROW_LIMIT);
      if (error || !Array.isArray(data)) return { available: false, reason: "history_read_failed" };
      return summarizeSanityHistory(data as SanityHistoryRow[], query);
    } catch {
      return { available: false, reason: "history_read_failed" };
    }
  };
}
