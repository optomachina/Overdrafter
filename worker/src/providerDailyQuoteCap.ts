import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorName } from "./types.js";

/**
 * Per provider daily quote cap, counted per UTC day and enforced before dispatch.
 *
 * Shared by OSH Cut (`adapters/oshcut.ts`) and the RMFG transport
 * (`rmfgHttpTransport.ts`): the count lives in process memory keyed by provider, so constructing another adapter cannot
 * reset it. It is NOT durable across worker processes or restarts; the only
 * durable ledger (`api_reserve_spend`) counts USD per organization, not quotes
 * per provider. A durable count needs a new table, which is a follow-up behind
 * a reviewed migration. Until then run one worker per provider, so the
 * effective ceiling is cap x worker processes.
 *
 * OVD-828: the cap itself is a per-provider admin setting next to the OVD-722
 * kill switch (`private.provider_kill_switches.daily_quote_cap`), read through
 * `api_worker_provider_daily_quote_cap` at every dispatch with no caching. It
 * defaults to 20, can be raised to any positive integer, or set to unlimited.
 * When the setting cannot be read (for example the OVD-828 migration is not
 * applied yet) the worker falls back to its env default.
 */
export const PROVIDER_DAILY_QUOTE_CAP_DEFAULT = 20;
export const PROVIDER_DAILY_QUOTE_CAP_UNLIMITED = "unlimited" as const;
export const PROVIDER_DAILY_QUOTE_CAP_RPC = "api_worker_provider_daily_quote_cap";
export const PROVIDER_DAILY_QUOTE_CAP_SCHEMA = "provider-daily-quote-cap.v1" as const;
export const PROVIDER_DAILY_QUOTE_CAP_TIMEOUT_MS = 2_000;

/** A positive integer number of quotes per UTC day, or no cap at all. */
export type ProviderDailyQuoteCap = number | typeof PROVIDER_DAILY_QUOTE_CAP_UNLIMITED;

export type ProviderDailyQuoteCapDenial = {
  reason: "provider_daily_cap_reached";
  provider: string;
  cap: number;
  quotesToday: number;
  utcDay: string;
};

/** Returns the raw RPC payload for one provider; throws on any transport or SQL error. */
export type ProviderDailyQuoteCapReader = (provider: VendorName) => Promise<unknown>;

export type ResolvedProviderDailyQuoteCap = {
  cap: ProviderDailyQuoteCap;
  /** `admin_setting` when the admin row decided it; `env_default` otherwise. */
  source: "admin_setting" | "env_default";
};

type CapState = { day: string; count: number };
const capState = new Map<string, CapState>();

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isValidProviderDailyQuoteCap(cap: unknown): cap is ProviderDailyQuoteCap {
  return cap === PROVIDER_DAILY_QUOTE_CAP_UNLIMITED || (Number.isSafeInteger(cap) && (cap as number) >= 1);
}

/**
 * Claims one quote slot for `provider` today. Returns null when the slot was
 * claimed, or a denial when the cap is reached (nothing is counted then).
 * An unlimited cap never denies but still counts. An invalid cap fails closed.
 */
export function claimProviderDailyQuote(
  provider: string,
  cap: ProviderDailyQuoteCap,
  now: Date = new Date(),
): ProviderDailyQuoteCapDenial | null {
  const day = utcDayKey(now);
  let state = capState.get(provider);
  if (!state || state.day !== day) {
    state = { day, count: 0 };
    capState.set(provider, state);
  }
  if (cap !== PROVIDER_DAILY_QUOTE_CAP_UNLIMITED) {
    const validCap = isValidProviderDailyQuoteCap(cap) ? cap : 0;
    if (state.count >= validCap) {
      return { reason: "provider_daily_cap_reached", provider, cap: validCap, quotesToday: state.count, utcDay: day };
    }
  }
  state.count += 1;
  return null;
}

/** Quotes claimed for `provider` on the UTC day of `now`, denials excluded. */
export function providerDailyQuotesToday(provider: string, now: Date = new Date()): number {
  const state = capState.get(provider);
  return state && state.day === utcDayKey(now) ? state.count : 0;
}

/** Test hook: clears every provider's daily count. */
export function resetProviderDailyQuoteCapsForTests(): void {
  capState.clear();
}

export function supabaseProviderDailyQuoteCapReader(supabase: SupabaseClient): ProviderDailyQuoteCapReader {
  return async (provider) => {
    const { data, error } = await supabase.rpc(PROVIDER_DAILY_QUOTE_CAP_RPC, { p_provider: provider });
    if (error) throw new Error("provider daily quote cap read failed");
    return data;
  };
}

const SETTING_KEYS = ["schema", "provider", "dailyQuoteCap", "unlimited"] as const;

/**
 * Strict parse of the v1 payload. Returns the admin cap, `null` when the
 * provider has no cap set (use the env default), or `undefined` when the
 * payload is not an exact v1 object for the requested provider.
 */
export function parseProviderDailyQuoteCapSetting(
  data: unknown,
  provider: VendorName,
): ProviderDailyQuoteCap | null | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  if (Object.getPrototypeOf(data) !== Object.prototype) return undefined;
  const keys = Object.keys(data);
  if (keys.length !== SETTING_KEYS.length || !SETTING_KEYS.every((key) => keys.includes(key))) return undefined;
  const setting = data as Record<(typeof SETTING_KEYS)[number], unknown>;
  if (setting.schema !== PROVIDER_DAILY_QUOTE_CAP_SCHEMA || setting.provider !== provider) return undefined;
  if (setting.unlimited === true) {
    return setting.dailyQuoteCap === null ? PROVIDER_DAILY_QUOTE_CAP_UNLIMITED : undefined;
  }
  if (setting.unlimited !== false) return undefined;
  if (setting.dailyQuoteCap === null) return null;
  return isValidProviderDailyQuoteCap(setting.dailyQuoteCap) ? setting.dailyQuoteCap : undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("provider daily quote cap read timed out")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reads the admin cap for `provider` fresh on every call. With no reader, a
 * failed or slow read, a malformed payload, or no cap set, the env `fallback`
 * applies (20 unless the operator changed it). An invalid fallback still fails
 * closed in `claimProviderDailyQuote`.
 */
export async function resolveProviderDailyQuoteCap(input: {
  reader?: ProviderDailyQuoteCapReader;
  provider: VendorName;
  fallback?: ProviderDailyQuoteCap;
  timeoutMs?: number;
}): Promise<ResolvedProviderDailyQuoteCap> {
  const envDefault: ResolvedProviderDailyQuoteCap = {
    cap: input.fallback ?? PROVIDER_DAILY_QUOTE_CAP_DEFAULT,
    source: "env_default",
  };
  const reader = input.reader;
  if (!reader) return envDefault;
  let data: unknown;
  try {
    data = await withTimeout(
      Promise.resolve().then(() => reader(input.provider)),
      input.timeoutMs ?? PROVIDER_DAILY_QUOTE_CAP_TIMEOUT_MS,
    );
  } catch {
    return envDefault;
  }
  const setting = parseProviderDailyQuoteCapSetting(data, input.provider);
  return setting == null ? envDefault : { cap: setting, source: "admin_setting" };
}
