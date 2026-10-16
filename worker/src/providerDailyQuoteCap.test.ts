// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimProviderDailyQuote,
  parseProviderDailyQuoteCapSetting,
  providerDailyQuotesToday,
  resetProviderDailyQuoteCapsForTests,
  resolveProviderDailyQuoteCap,
  supabaseProviderDailyQuoteCapReader,
} from "./providerDailyQuoteCap";

const DAY = new Date("2026-10-15T23:59:59.000Z");
const NEXT_DAY = new Date("2026-10-16T00:00:00.000Z");

function claimTimes(times: number, cap: number, now = DAY) {
  for (let i = 0; i < times; i += 1) expect(claimProviderDailyQuote("oshcut", cap, now)).toBeNull();
}

describe("claimProviderDailyQuote", () => {
  beforeEach(() => resetProviderDailyQuoteCapsForTests());

  it("allows quotes under the cap", () => {
    claimTimes(20, 20);
  });

  it("denies at the cap with a clear reason and does not count the denial", () => {
    claimTimes(20, 20);
    const denial = { reason: "provider_daily_cap_reached", provider: "oshcut", cap: 20, quotesToday: 20, utcDay: "2026-10-15" };
    expect(claimProviderDailyQuote("oshcut", 20, DAY)).toEqual(denial);
    expect(claimProviderDailyQuote("oshcut", 20, DAY)).toEqual(denial);
  });

  it("resets at the UTC day boundary", () => {
    claimTimes(20, 20);
    expect(claimProviderDailyQuote("oshcut", 20, DAY)).not.toBeNull();
    claimTimes(20, 20, NEXT_DAY);
    expect(claimProviderDailyQuote("oshcut", 20, NEXT_DAY)).toMatchObject({ utcDay: "2026-10-16" });
  });

  it("counts each provider separately", () => {
    claimTimes(1, 1);
    expect(claimProviderDailyQuote("rmfg", 1, DAY)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("fails closed on an invalid cap (%s)", (cap) => {
    expect(claimProviderDailyQuote("oshcut", cap, DAY)).toMatchObject({ reason: "provider_daily_cap_reached", cap: 0 });
  });

  it("allows more than 20 quotes once the cap is raised above 20", () => {
    claimTimes(50, 50);
    expect(claimProviderDailyQuote("oshcut", 50, DAY)).toMatchObject({ cap: 50, quotesToday: 50 });
  });

  it("never denies an unlimited cap but still counts it", () => {
    for (let i = 0; i < 500; i += 1) expect(claimProviderDailyQuote("oshcut", "unlimited", DAY)).toBeNull();
    expect(providerDailyQuotesToday("oshcut", DAY)).toBe(500);
    expect(providerDailyQuotesToday("oshcut", NEXT_DAY)).toBe(0);
  });
});

const setting = (overrides: Record<string, unknown> = {}) => ({
  schema: "provider-daily-quote-cap.v1",
  provider: "oshcut",
  dailyQuoteCap: 35,
  unlimited: false,
  ...overrides,
});

describe("parseProviderDailyQuoteCapSetting", () => {
  it("reads a raised cap, unlimited, and an unset cap", () => {
    expect(parseProviderDailyQuoteCapSetting(setting(), "oshcut")).toBe(35);
    expect(parseProviderDailyQuoteCapSetting(setting({ dailyQuoteCap: null, unlimited: true }), "oshcut")).toBe("unlimited");
    expect(parseProviderDailyQuoteCapSetting(setting({ dailyQuoteCap: null }), "oshcut")).toBeNull();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["another schema", setting({ schema: "provider-daily-quote-cap.v2" })],
    ["another provider", setting({ provider: "rmfg" })],
    ["an extra key", { ...setting(), extra: 1 }],
    ["a zero cap", setting({ dailyQuoteCap: 0 })],
    ["a fractional cap", setting({ dailyQuoteCap: 2.5 })],
    ["a string cap", setting({ dailyQuoteCap: "35" })],
    ["unlimited with a number", setting({ unlimited: true })],
    ["a non-boolean unlimited flag", setting({ unlimited: "yes" })],
  ])("rejects %s", (_name, data) => {
    expect(parseProviderDailyQuoteCapSetting(data, "oshcut")).toBeUndefined();
  });
});

describe("resolveProviderDailyQuoteCap", () => {
  it("defaults to 20 when the setting is absent and no env fallback is set", async () => {
    await expect(resolveProviderDailyQuoteCap({ provider: "oshcut" })).resolves.toEqual({ cap: 20, source: "env_default" });
    await expect(resolveProviderDailyQuoteCap({ provider: "oshcut", reader: async () => setting({ dailyQuoteCap: null }) }))
      .resolves.toEqual({ cap: 20, source: "env_default" });
  });

  it("uses the admin setting over the env fallback", async () => {
    await expect(resolveProviderDailyQuoteCap({ provider: "oshcut", fallback: 5, reader: async () => setting({ dailyQuoteCap: 250 }) }))
      .resolves.toEqual({ cap: 250, source: "admin_setting" });
    await expect(resolveProviderDailyQuoteCap({
      provider: "oshcut", fallback: 5, reader: async () => setting({ dailyQuoteCap: null, unlimited: true }),
    })).resolves.toEqual({ cap: "unlimited", source: "admin_setting" });
  });

  it("falls back to the env default, with no upper bound, when the setting cannot be read", async () => {
    const missing = vi.fn(async () => { throw new Error("Could not find the function"); });
    await expect(resolveProviderDailyQuoteCap({ provider: "oshcut", fallback: 1000, reader: missing }))
      .resolves.toEqual({ cap: 1000, source: "env_default" });
    await expect(resolveProviderDailyQuoteCap({ provider: "oshcut", fallback: "unlimited", reader: async () => "garbage" }))
      .resolves.toEqual({ cap: "unlimited", source: "env_default" });
    await expect(resolveProviderDailyQuoteCap({
      provider: "oshcut", fallback: 7, timeoutMs: 5, reader: () => new Promise(() => undefined),
    })).resolves.toEqual({ cap: 7, source: "env_default" });
  });

  it("calls the Supabase RPC for the provider and throws on an RPC error", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: setting(), error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "function not found" } });
    const reader = supabaseProviderDailyQuoteCapReader({ rpc } as never);
    await expect(reader("oshcut")).resolves.toEqual(setting());
    expect(rpc).toHaveBeenCalledWith("api_worker_provider_daily_quote_cap", { p_provider: "oshcut" });
    await expect(reader("oshcut")).rejects.toThrow("provider daily quote cap read failed");
  });
});
