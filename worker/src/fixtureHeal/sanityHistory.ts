import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceHistory } from "./sanity.js";

/**
 * OVD-813: the history and peer read behind the outlier rules (design §3.4).
 * Two service-role selects on `public.vendor_quote_results` (this supplier's
 * own rows and the other suppliers' rows, each limited), no migration: both
 * key on what the gate records in `raw_payload.fixtureSanity`, the part
 * package identity (`packageId`) and the requirement it was quoted to
 * (`requirementKey`: material, finish, process, tolerance, thickness), plus
 * the requested quantity. A row the gate never checked has no requirement key,
 * so it is not comparable and is not read. Each row contributes the cheapest
 * offer the gate saw (`cheapestUnitUsd`), the same measure the current quote
 * is checked with, so lead-time options compare like for like. Only accepted
 * statuses with a price count, so a held, failed or internal result never
 * becomes the baseline for the next one. Any read failure comes
 * back as `available: false`, which the gate holds on (fail closed).
 */

export const HISTORY_WINDOW_DAYS = 90;
export const PEER_WINDOW_DAYS = 30;
export const HISTORY_ROW_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCEPTED_STATUSES = ["instant_quote_received", "official_quote_received"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
export const HISTORY_COLUMNS = "vendor, unit_price_usd, cheapest_unit_usd:raw_payload->fixtureSanity->>cheapestUnitUsd, created_at";

export type SanityHistoryQuery = {
  provider: string;
  /** sha256 package identity of the disclosed files; null when none could be derived. */
  packageId: string | null;
  /** Requirement fingerprint (`requirementKey` in `gate.ts`); null when the requirement is unknown. */
  requirementKey: string | null;
  requestedQuantity: number;
  /** The result being checked, never compared with itself. */
  excludeResultId: string;
  nowMs: number;
};

export type SanityHistoryRow = {
  vendor: string;
  unit_price_usd: number | string | null;
  /** `raw_payload.fixtureSanity.cheapestUnitUsd`; null on rows written before v2. */
  cheapest_unit_usd?: number | string | null;
  created_at: string;
};

export type SanityHistoryReader = (query: SanityHistoryQuery) => Promise<PriceHistory>;

/** Pure: splits rows into this supplier's 90 day history and the cheapest 30 day price per other supplier. */
export function summarizeSanityHistory(rows: readonly SanityHistoryRow[], query: SanityHistoryQuery): PriceHistory {
  const history: number[] = [];
  const cheapestPeer = new Map<string, number>();
  const historySince = query.nowMs - HISTORY_WINDOW_DAYS * DAY_MS;
  const peerSince = query.nowMs - PEER_WINDOW_DAYS * DAY_MS;
  for (const row of rows) {
    const price = row.cheapest_unit_usd ?? row.unit_price_usd;
    const unit = Number(price);
    const createdMs = Date.parse(row.created_at);
    if (price === null || price === undefined || !Number.isFinite(unit) || unit <= 0 || !Number.isFinite(createdMs)) continue;
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
    // No package or requirement identity means nothing comparable exists; that is not a read failure.
    if (query.packageId === null || query.requirementKey === null) return { available: true, history: [], peers: [] };
    // Both keys go into PostgREST filters, so only a bare sha256 is accepted.
    if (!SHA256.test(query.packageId) || !SHA256.test(query.requirementKey)) {
      return { available: false, reason: "package_id_malformed" };
    }
    const { packageId, requirementKey } = query;
    // Two limited reads, so other suppliers' rows can never crowd this supplier's own history out of the limit.
    const read = async (own: boolean, windowDays: number) => {
      const base = supabase
        .from("vendor_quote_results")
        .select(HISTORY_COLUMNS)
        .eq("requested_quantity", query.requestedQuantity)
        .in("status", [...ACCEPTED_STATUSES])
        .neq("id", query.excludeResultId);
      const { data, error } = await (own ? base.eq("vendor", query.provider) : base.neq("vendor", query.provider))
        .gte("created_at", new Date(query.nowMs - windowDays * DAY_MS).toISOString())
        .eq("raw_payload->fixtureSanity->>packageId", packageId)
        .eq("raw_payload->fixtureSanity->>requirementKey", requirementKey)
        .order("created_at", { ascending: false })
        .limit(HISTORY_ROW_LIMIT);
      if (error || !Array.isArray(data)) throw new Error("history_read_failed");
      return data as SanityHistoryRow[];
    };
    try {
      const [own, peers] = await Promise.all([read(true, HISTORY_WINDOW_DAYS), read(false, PEER_WINDOW_DAYS)]);
      return summarizeSanityHistory([...own, ...peers], query);
    } catch {
      return { available: false, reason: "history_read_failed" };
    }
  };
}
