// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  PROVIDER_KILL_SWITCH_STATE_SCHEMA,
  ProviderKillSwitchError,
} from "../providerKillSwitch";
import { assertOperatorProvidersEnabled, envProviderKillSwitchReader, guardOperatorQuote } from "./operatorKillSwitchGate";

function state(provider: string, engaged: boolean, globalEngaged: boolean) {
  return { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider, engaged, globalEngaged };
}

describe("assertOperatorProvidersEnabled", () => {
  it("resolves when the switch is off and reads each provider once", async () => {
    const reader = vi.fn(async (provider: string) => state(provider, false, false));
    await expect(assertOperatorProvidersEnabled(["fictiv", "xometry", "fictiv"], reader)).resolves.toBeUndefined();
    expect(reader.mock.calls.map(([provider]) => provider)).toEqual(["fictiv", "xometry"]);
  });

  it("refuses when the provider switch is engaged", async () => {
    const reader = async (provider: string) => state(provider, true, false);
    const error = await assertOperatorProvidersEnabled(["xometry"], reader).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderKillSwitchError);
    expect(error.reasonCode).toBe("provider_kill_switch_engaged");
    expect(error.message).toBe("The xometry kill switch is engaged; refused at before_launch.");
  });

  it("refuses when only the global switch is engaged", async () => {
    const reader = async (provider: string) => state(provider, false, true);
    await expect(assertOperatorProvidersEnabled(["fictiv"], reader)).rejects.toMatchObject({
      reasonCode: "provider_kill_switch_engaged",
    });
  });

  it("fails closed when the state cannot be read", async () => {
    const reader = async () => {
      throw new Error("network down");
    };
    await expect(assertOperatorProvidersEnabled(["fictiv"], reader)).rejects.toMatchObject({
      reasonCode: "provider_kill_switch_unavailable",
    });
  });

  it("fails closed on a malformed response", async () => {
    await expect(assertOperatorProvidersEnabled(["fictiv"], async () => ({ engaged: false }))).rejects.toMatchObject({
      reasonCode: "provider_kill_switch_unavailable",
    });
  });

  it("stops at the first refused provider", async () => {
    const reader = vi.fn(async (provider: string) => state(provider, provider === "fictiv", false));
    await expect(assertOperatorProvidersEnabled(["fictiv", "xometry"], reader)).rejects.toBeInstanceOf(
      ProviderKillSwitchError,
    );
    expect(reader).toHaveBeenCalledTimes(1);
  });
});

describe("envProviderKillSwitchReader", () => {
  it("fails closed without a network call when credentials are missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(assertOperatorProvidersEnabled(["fictiv"], envProviderKillSwitchReader({}))).rejects.toMatchObject({
      reasonCode: "provider_kill_switch_unavailable",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("assertOperatorProvidersEnabled with no live providers", () => {
  it("needs no credentials and makes no read when the run is strictly offline", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    await expect(assertOperatorProvidersEnabled([])).resolves.toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe("guardOperatorQuote", () => {
  it("rechecks before every launch so engaging between quotes blocks the next one", async () => {
    let engaged = false;
    const reader = async (provider: string) => state(provider, engaged, false);
    const quote = vi.fn(async () => "quoted");
    const guarded = guardOperatorQuote("xometry", quote, reader);

    await expect(guarded({} as never)).resolves.toBe("quoted");
    engaged = true;
    await expect(guarded({} as never)).rejects.toMatchObject({ reasonCode: "provider_kill_switch_engaged" });
    expect(quote).toHaveBeenCalledOnce();
  });

  it("passes the guard to the adapter as its checkpoint", async () => {
    let engaged = false;
    const reader = async (provider: string) => state(provider, engaged, false);
    const guarded = guardOperatorQuote("xometry", async (input) => {
      engaged = true;
      await input.providerKillSwitchCheckpoint?.("before_save");
    }, reader);

    await expect(guarded({} as never)).rejects.toMatchObject({ checkpoint: "before_save" });
  });
});
