/**
 * Per provider daily quote cap, counted per UTC day and enforced before dispatch.
 *
 * Mirrors the RMFG transport cap (`rmfgHttpTransport.ts`): the count lives in
 * process memory keyed by provider, so constructing another adapter cannot
 * reset it. It is NOT durable across worker processes or restarts; the only
 * durable ledger (`api_reserve_spend`) counts USD per organization, not quotes
 * per provider. A durable count needs a new table, which is a follow-up behind
 * a reviewed migration. Until then run one worker per provider, so the
 * effective ceiling is cap x worker processes.
 */
export const PROVIDER_DAILY_QUOTE_CAP_DEFAULT = 20;

export type ProviderDailyQuoteCapDenial = {
  reason: "provider_daily_cap_reached";
  provider: string;
  cap: number;
  quotesToday: number;
  utcDay: string;
};

type CapState = { day: string; count: number };
const capState = new Map<string, CapState>();

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Claims one quote slot for `provider` today. Returns null when the slot was
 * claimed, or a denial when the cap is reached (nothing is counted then).
 * An invalid cap fails closed.
 */
export function claimProviderDailyQuote(
  provider: string,
  cap: number,
  now: Date = new Date(),
): ProviderDailyQuoteCapDenial | null {
  const day = utcDayKey(now);
  let state = capState.get(provider);
  if (!state || state.day !== day) {
    state = { day, count: 0 };
    capState.set(provider, state);
  }
  const validCap = Number.isInteger(cap) && cap >= 1 ? cap : 0;
  if (state.count >= validCap) {
    return { reason: "provider_daily_cap_reached", provider, cap: validCap, quotesToday: state.count, utcDay: day };
  }
  state.count += 1;
  return null;
}

/** Test hook: clears every provider's daily count. */
export function resetProviderDailyQuoteCapsForTests(): void {
  capState.clear();
}
