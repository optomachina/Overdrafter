import { afterEach, describe, expect, it, vi } from "vitest";

const callUntypedRpcMock = vi.hoisted(() => vi.fn());
vi.mock("./shared/rpc", () => ({ callUntypedRpc: callUntypedRpcMock }));

import {
  fetchProviderKillSwitches,
  parseProviderKillSwitchList,
  setProviderKillSwitch,
  setProviderSettings,
} from "./provider-kill-switch-api";

afterEach(() => callUntypedRpcMock.mockReset());

describe("provider kill switch admin API (OVD-722)", () => {
  it("parses the admin list and treats a missing global row as engaged", () => {
    expect(parseProviderKillSwitchList({
      schema: "provider-kill-switch-admin.v1",
      global: null,
      providers: [
        { provider: "fictiv", engaged: true, reason: "cease and desist", changedBy: "u", changedAt: "t", version: 3 },
        { provider: "rmfg", engaged: false, reason: null, changedBy: null, changedAt: null, version: -1 },
      ],
    })).toEqual({
      available: true,
      global: { engaged: true, reason: null, changedBy: null, changedAt: null, version: null },
      providers: [
        { provider: "fictiv", engaged: true, reason: "cease and desist", changedBy: "u", changedAt: "t", version: 3 },
        { provider: "rmfg", engaged: false, reason: null, changedBy: null, changedAt: null, version: null },
      ],
    });
    expect(() => parseProviderKillSwitchList({ schema: "other", providers: [] })).toThrow(/malformed/);
    expect(() => parseProviderKillSwitchList({
      schema: "provider-kill-switch-admin.v1", global: null, providers: [{ provider: "fictiv", engaged: "no" }],
    })).toThrow(/malformed/);
  });

  it("reports unavailable only when the RPC is missing (migration pending)", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: null, error: { code: "PGRST202", message: "Could not find the function public.api_admin_list_provider_kill_switches" },
    });
    await expect(fetchProviderKillSwitches()).resolves.toEqual({ available: false });
    callUntypedRpcMock.mockResolvedValue({ data: null, error: { code: "42501", message: "platform_admin_required" } });
    await expect(fetchProviderKillSwitches()).rejects.toMatchObject({ message: "platform_admin_required" });
  });

  it("refuses a short reason before calling the database and routes provider/global flips", async () => {
    await expect(setProviderKillSwitch({ provider: "fictiv", engaged: true, reason: " short " })).rejects.toThrow(/at least 10/);
    expect(callUntypedRpcMock).not.toHaveBeenCalled();

    callUntypedRpcMock.mockResolvedValue({ data: { engaged: true }, error: null });
    await setProviderKillSwitch({ provider: "fictiv", engaged: true, reason: " cease and desist " });
    expect(callUntypedRpcMock).toHaveBeenLastCalledWith("api_admin_set_provider_kill_switch",
      { p_provider: "fictiv", p_engaged: true, p_reason: "cease and desist" });
    await setProviderKillSwitch({ provider: null, engaged: false, reason: "incident resolved", expectedVersion: 5 });
    expect(callUntypedRpcMock).toHaveBeenLastCalledWith("api_admin_set_global_kill_switch",
      { p_engaged: false, p_reason: "incident resolved", p_expected_version: 5 });
  });

  it("engage never sends a version; release requires one and maps a stale conflict", async () => {
    callUntypedRpcMock.mockResolvedValue({ data: { engaged: true }, error: null });
    await setProviderKillSwitch({ provider: "fictiv", engaged: true, reason: "cease and desist", expectedVersion: 2 });
    expect(callUntypedRpcMock).toHaveBeenLastCalledWith("api_admin_set_provider_kill_switch",
      { p_provider: "fictiv", p_engaged: true, p_reason: "cease and desist" });

    callUntypedRpcMock.mockClear();
    await expect(setProviderKillSwitch({ provider: "fictiv", engaged: false, reason: "counsel cleared it" }))
      .rejects.toThrow(/changed since you loaded it/);
    expect(callUntypedRpcMock).not.toHaveBeenCalled();

    callUntypedRpcMock.mockResolvedValue({
      data: null, error: { code: "P0001", message: "kill_switch_version_conflict" },
    });
    await expect(setProviderKillSwitch({ provider: "fictiv", engaged: false, reason: "counsel cleared it", expectedVersion: 2 }))
      .rejects.toThrow(/changed since you loaded it/);
    expect(callUntypedRpcMock).toHaveBeenLastCalledWith("api_admin_set_provider_kill_switch",
      { p_provider: "fictiv", p_engaged: false, p_reason: "counsel cleared it", p_expected_version: 2 });
  });
});

describe("per-supplier settings admin API (OVD-829)", () => {
  const list = (providers: unknown[]) => ({ schema: "provider-kill-switch-admin.v1", global: null, providers });

  it("parses the daily cap and today's usage when the database returns them", () => {
    expect(parseProviderKillSwitchList(list([
      { provider: "fictiv", engaged: false, reason: null, changedBy: null, changedAt: null, version: 1, dailyQuoteCap: 20, usedToday: 3 },
      { provider: "rmfg", engaged: false, reason: null, changedBy: null, changedAt: null, version: 2, dailyQuoteCap: null, usedToday: 41 },
      { provider: "weerg", engaged: false, reason: null, changedBy: null, changedAt: null, version: 0 },
    ])).providers.map((row) => row.settings)).toEqual([
      { dailyQuoteCap: 20, usedToday: 3 },
      { dailyQuoteCap: null, usedToday: 41 },
      undefined,
    ]);
    for (const dailyQuoteCap of [0, -1, 2.5, "20"]) {
      expect(() => parseProviderKillSwitchList(list([
        { provider: "fictiv", engaged: false, version: 1, dailyQuoteCap },
      ]))).toThrow(/malformed/);
    }
  });

  it("sets a cap or unlimited through api_admin_set_provider_settings with the version the admin saw", async () => {
    callUntypedRpcMock.mockResolvedValue({ data: { dailyQuoteCap: 50 }, error: null });
    await setProviderSettings({ provider: "fictiv", engaged: false, dailyQuoteCap: 50, reason: " raise for the pilot ", expectedVersion: 4 });
    expect(callUntypedRpcMock).toHaveBeenLastCalledWith("api_admin_set_provider_settings", {
      p_provider: "fictiv", p_engaged: false, p_daily_quote_cap: 50, p_reason: "raise for the pilot", p_expected_version: 4,
    });
    await setProviderSettings({ provider: "fictiv", engaged: true, dailyQuoteCap: null, reason: "unlimited for the pilot", expectedVersion: 5 });
    expect(callUntypedRpcMock).toHaveBeenLastCalledWith("api_admin_set_provider_settings", {
      p_provider: "fictiv", p_engaged: true, p_daily_quote_cap: null, p_reason: "unlimited for the pilot", p_expected_version: 5,
    });
  });

  it("refuses a cap of 0, a negative or fractional cap, and a missing version before calling the database", async () => {
    for (const dailyQuoteCap of [0, -3, 1.5, Number.NaN]) {
      await expect(setProviderSettings({ provider: "fictiv", engaged: false, dailyQuoteCap, reason: "raise for the pilot", expectedVersion: 1 }))
        .rejects.toThrow(/whole number above 0/);
    }
    await expect(setProviderSettings({ provider: "fictiv", engaged: false, dailyQuoteCap: 5, reason: "raise for the pilot", expectedVersion: null }))
      .rejects.toThrow(/changed since you loaded them/);
    expect(callUntypedRpcMock).not.toHaveBeenCalled();
  });

  it("maps a version conflict to the stale settings message", async () => {
    callUntypedRpcMock.mockResolvedValue({ data: null, error: { code: "P0001", message: "kill_switch_version_conflict" } });
    await expect(setProviderSettings({ provider: "fictiv", engaged: false, dailyQuoteCap: 5, reason: "raise for the pilot", expectedVersion: 1 }))
      .rejects.toThrow(/changed since you loaded them/);
  });

  it("flips the switch through the settings RPC once the cap is known: engage is versionless, release keeps the cap", async () => {
    callUntypedRpcMock.mockResolvedValue({ data: { engaged: true }, error: null });
    await setProviderKillSwitch({ provider: "fictiv", engaged: true, reason: "cease and desist", expectedVersion: 2, dailyQuoteCap: 20 });
    expect(callUntypedRpcMock).toHaveBeenLastCalledWith("api_admin_set_provider_settings",
      { p_provider: "fictiv", p_engaged: true, p_daily_quote_cap: 20, p_reason: "cease and desist" });
    await setProviderKillSwitch({ provider: "fictiv", engaged: false, reason: "counsel cleared it", expectedVersion: 3, dailyQuoteCap: null });
    expect(callUntypedRpcMock).toHaveBeenLastCalledWith("api_admin_set_provider_settings",
      { p_provider: "fictiv", p_engaged: false, p_daily_quote_cap: null, p_reason: "counsel cleared it", p_expected_version: 3 });
  });
});
