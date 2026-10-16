// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { claimProviderDailyQuote, resetProviderDailyQuoteCapsForTests } from "./providerDailyQuoteCap";

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

  it.each([0, -1, 1.5, Number.NaN])("fails closed on an invalid cap (%s)", (cap) => {
    expect(claimProviderDailyQuote("oshcut", cap, DAY)).toMatchObject({ reason: "provider_daily_cap_reached", cap: 0 });
  });
});
