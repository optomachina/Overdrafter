import { describe, expect, it, vi } from "vitest";
import type { VendorName } from "@/integrations/supabase/types";
import { PROVIDER_CATALOG } from "@/features/quotes/generated/provider-catalog";
import {
  PROVIDER_DAILY_QUOTE_CAP,
  PROVIDER_PROCESS_CAPABILITIES,
  classifyFanoutProcess,
  getFanoutDenialSkipReason,
  planProviderFanout,
  resolveMultiProviderFanoutEnabled,
  runProviderFanout,
  type ProviderFanoutGuards,
  type ProviderFanoutOutcome,
} from "@/features/quotes/provider-fanout";

const CLEAN_GUARDS: ProviderFanoutGuards = {
  killSwitchedProviders: [],
  exportDeclaration: "clean",
  dailyQuoteCounts: {},
};

const CANDIDATES: VendorName[] = ["xometry", "fictiv", "sendcutsend", "rmfg", "oshcut"];

describe("resolveMultiProviderFanoutEnabled", () => {
  it("defaults off and turns on only for the exact value true", () => {
    expect(resolveMultiProviderFanoutEnabled(undefined)).toBe(false);
    expect(resolveMultiProviderFanoutEnabled(null)).toBe(false);
    expect(resolveMultiProviderFanoutEnabled("")).toBe(false);
    expect(resolveMultiProviderFanoutEnabled("1")).toBe(false);
    expect(resolveMultiProviderFanoutEnabled("yes")).toBe(false);
    expect(resolveMultiProviderFanoutEnabled(" TRUE ")).toBe(true);
  });
});

describe("classifyFanoutProcess", () => {
  it("separates CNC from sheet metal and refuses ambiguous text", () => {
    expect(classifyFanoutProcess("CNC mill")).toBe("cnc");
    expect(classifyFanoutProcess("CNC turning")).toBe("cnc");
    expect(classifyFanoutProcess("Sheet metal")).toBe("sheet_metal");
    expect(classifyFanoutProcess("Laser cut and bend")).toBe("sheet_metal");
    expect(classifyFanoutProcess("CNC machined sheet metal")).toBeNull();
    expect(classifyFanoutProcess("Injection molding")).toBeNull();
    expect(classifyFanoutProcess(null)).toBeNull();
  });
});

describe("planProviderFanout eligibility", () => {
  it("never sends a CNC part to a sheet metal only shop", () => {
    const plan = planProviderFanout({ primary: "xometry", candidates: CANDIDATES, process: "CNC mill", guards: CLEAN_GUARDS });

    expect(plan.send).toEqual(["xometry", "fictiv"]);
    expect(plan.skipped).toEqual([
      { provider: "sendcutsend", reason: "process_ineligible" },
      { provider: "rmfg", reason: "process_ineligible" },
      { provider: "oshcut", reason: "process_ineligible" },
    ]);
  });

  it("never sends a sheet metal part to a CNC only shop", () => {
    const plan = planProviderFanout({ primary: "xometry", candidates: CANDIDATES, process: "Sheet metal", guards: CLEAN_GUARDS });

    expect(plan.send).toEqual(["xometry", "sendcutsend", "rmfg", "oshcut"]);
    expect(plan.skipped).toEqual([{ provider: "fictiv", reason: "process_ineligible" }]);
  });

  it("skips the primary too when its declared capability excludes the part's process", () => {
    const plan = planProviderFanout({ primary: "fictiv", candidates: CANDIDATES, process: "Sheet metal", guards: CLEAN_GUARDS });

    expect(plan.send).not.toContain("fictiv");
    expect(plan.skipped[0]).toEqual({ provider: "fictiv", reason: "process_ineligible" });
  });

  it("keeps only the primary when the process cannot be classified", () => {
    const plan = planProviderFanout({ primary: "xometry", candidates: CANDIDATES, process: "Injection molding", guards: CLEAN_GUARDS });

    expect(plan.send).toEqual(["xometry"]);
    expect(plan.skipped.every((entry) => entry.reason === "process_ineligible")).toBe(true);
  });

  it("matches every catalog process family the generator declares", () => {
    for (const [provider, entry] of Object.entries(PROVIDER_CATALOG) as [VendorName, { processFamily: string; adapterKind: string }][]) {
      const capabilities = PROVIDER_PROCESS_CAPABILITIES[provider];
      if (entry.processFamily === "cnc_machining") expect(capabilities, provider).toEqual(["cnc"]);
      if (entry.processFamily.startsWith("sheet_")) expect(capabilities, provider).toEqual(["sheet_metal"]);
      if (entry.adapterKind === "guidance_only" && entry.processFamily === "unknown") expect(capabilities, provider).toEqual([]);
    }
  });
});

describe("planProviderFanout guards", () => {
  it("skips a provider whose kill switch is on, including the primary", () => {
    const plan = planProviderFanout({
      primary: "xometry",
      candidates: CANDIDATES,
      process: "CNC mill",
      guards: { ...CLEAN_GUARDS, killSwitchedProviders: ["fictiv"] },
    });
    expect(plan.send).toEqual(["xometry"]);
    expect(plan.skipped).toContainEqual({ provider: "fictiv", reason: "kill_switch" });

    const primaryOff = planProviderFanout({
      primary: "xometry",
      candidates: CANDIDATES,
      process: "CNC mill",
      guards: { ...CLEAN_GUARDS, killSwitchedProviders: ["xometry"] },
    });
    expect(primaryOff.send).toEqual(["fictiv"]);
    expect(primaryOff.skipped).toContainEqual({ provider: "xometry", reason: "kill_switch" });
  });

  it("skips foreign providers without a clean export declaration", () => {
    const candidates: VendorName[] = ["xometry", "geomiq", "weerg", "fictiv"];
    const blocked = planProviderFanout({
      primary: "xometry",
      candidates,
      process: "CNC mill",
      guards: { ...CLEAN_GUARDS, exportDeclaration: "not_clean" },
    });
    expect(blocked.send).toEqual(["xometry", "fictiv"]);
    expect(blocked.skipped).toEqual([
      { provider: "geomiq", reason: "export_control" },
      { provider: "weerg", reason: "export_control" },
    ]);

    const clean = planProviderFanout({ primary: "xometry", candidates, process: "CNC mill", guards: CLEAN_GUARDS });
    expect(clean.send).toEqual(["xometry", "geomiq", "weerg", "fictiv"]);
  });

  it("skips a provider at the daily cap of about 20 quotes", () => {
    expect(PROVIDER_DAILY_QUOTE_CAP).toBe(20);
    const plan = planProviderFanout({
      primary: "xometry",
      candidates: CANDIDATES,
      process: "Sheet metal",
      guards: { ...CLEAN_GUARDS, dailyQuoteCounts: { sendcutsend: 20, rmfg: 19 } },
    });
    expect(plan.send).toEqual(["xometry", "rmfg", "oshcut"]);
    expect(plan.skipped).toContainEqual({ provider: "sendcutsend", reason: "daily_cap" });
  });

  it("falls back to the primary alone when guards are unavailable", () => {
    const plan = planProviderFanout({ primary: "xometry", candidates: CANDIDATES, process: "CNC mill", guards: null });

    expect(plan.send).toEqual(["xometry"]);
    expect(plan.skipped.map((entry) => entry.reason)).toEqual([
      "guards_unavailable",
      "guards_unavailable",
      "guards_unavailable",
      "guards_unavailable",
    ]);
  });
});

describe("runProviderFanout", () => {
  it("keeps sending when one provider fails and reports each outcome as it settles", async () => {
    const seen: ProviderFanoutOutcome[] = [];
    const dispatch = vi.fn(async (provider: VendorName) => {
      if (provider === "sendcutsend") throw new Error("network down");
      if (provider === "rmfg") throw { message: "provider_dispatch_provider_not_enabled", code: "P0001" };
      return { created: true };
    });

    const outcomes = await runProviderFanout({
      providers: ["sendcutsend", "rmfg", "oshcut"],
      dispatch,
      classifyFailure: (error) => (error instanceof Error ? "unknown" : "denied"),
      onOutcome: (outcome) => seen.push(outcome),
    });

    expect(dispatch.mock.calls.map(([provider]) => provider)).toEqual(["sendcutsend", "rmfg", "oshcut"]);
    expect(outcomes).toEqual([
      { provider: "sendcutsend", status: "unknown", skipReason: undefined },
      { provider: "rmfg", status: "denied", skipReason: "not_admitted" },
      { provider: "oshcut", status: "queued", created: true },
    ]);
    expect(seen.map((outcome) => `${outcome.provider}:${outcome.status}`)).toEqual([
      "sendcutsend:pending",
      "sendcutsend:unknown",
      "rmfg:pending",
      "rmfg:denied",
      "oshcut:pending",
      "oshcut:queued",
    ]);
  });

  it("does not start the next provider until the previous one settles", async () => {
    let active = 0;
    let maxActive = 0;
    await runProviderFanout({
      providers: ["fictiv", "xometry"],
      dispatch: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { created: true };
      },
      classifyFailure: () => "unknown",
      onOutcome: () => undefined,
    });
    expect(maxActive).toBe(1);
  });

  it("maps worker guard denials to skip reasons", () => {
    expect(getFanoutDenialSkipReason(new Error("provider_disabled"))).toBe("kill_switch");
    expect(getFanoutDenialSkipReason({ message: "export_control_blocked" })).toBe("export_control");
    expect(getFanoutDenialSkipReason({ message: "provider_daily_cap_reached" })).toBe("daily_cap");
    expect(getFanoutDenialSkipReason(new Error("timeout"))).toBeUndefined();
  });
});
