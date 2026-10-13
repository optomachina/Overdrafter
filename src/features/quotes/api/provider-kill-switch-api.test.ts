import { afterEach, describe, expect, it, vi } from "vitest";

const callUntypedRpcMock = vi.hoisted(() => vi.fn());
vi.mock("./shared/rpc", () => ({ callUntypedRpc: callUntypedRpcMock }));

import {
  fetchProviderKillSwitches,
  parseProviderKillSwitchList,
  setProviderKillSwitch,
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
