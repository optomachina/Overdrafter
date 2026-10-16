// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { dispatchAuthorizationFailure } from "./dispatchRouting";
import { createProviderMutationPhase } from "./providerMutationPhase";
import {
  assertProviderDispatchAllowed,
  DEFAULT_PROVIDER_DAILY_QUOTE_CAP,
  getProviderSettings,
  guardProviderDispatch,
  PROVIDER_DAILY_CAP_REACHED,
  PROVIDER_DISPATCH_COUNTER_UNAVAILABLE,
  PROVIDER_DISPATCH_RESERVATION_SCHEMA,
  PROVIDER_KILL_SWITCH_ENGAGED,
  PROVIDER_KILL_SWITCH_STATE_SCHEMA,
  PROVIDER_KILL_SWITCH_UNAVAILABLE,
  PROVIDER_DURABLE_DISPATCH_CAP_ENV,
  PROVIDER_SETTINGS_STATE_SCHEMA,
  ProcessLocalDispatchCounter,
  providerDispatchCapMode,
  providerDispatchCapModeFromEnv,
  ProviderDispatchRefusedError,
  ProviderKillSwitchError,
  type ProviderSettingsPort,
} from "./providerSettings";
import { classifyProviderAdapterFailure } from "./providerTaskPipeline";
import type { VendorName, VendorQuoteAdapterInput } from "./types";

/**
 * OVD-829 (OVD-828 S1): the universal per-supplier settings gate. The store
 * below mirrors docs/migration-drafts/ovd-828-s1.sql: the settings row
 * (engaged, daily_quote_cap; a missing row is engaged), the global switch, and
 * the durable per UTC day counter behind api_worker_reserve_provider_dispatch.
 * Its state lives outside the guard, the way the database does: nothing is
 * counted in the worker process.
 */
function settingsStore(initial: Partial<Record<VendorName, { engaged?: boolean; cap?: number | null }>> = {}) {
  const rows = new Map<VendorName, { engaged: boolean; cap: number | null }>();
  for (const [provider, row] of Object.entries(initial) as [VendorName, { engaged?: boolean; cap?: number | null }][]) {
    rows.set(provider, { engaged: row.engaged ?? false, cap: row.cap === undefined ? DEFAULT_PROVIDER_DAILY_QUOTE_CAP : row.cap });
  }
  const usage = new Map<string, number>();
  const store = {
    global: false,
    day: "2026-10-16",
    rows,
    used: (provider: VendorName) => usage.get(`${provider}:${store.day}`) ?? 0,
    port: {
      readKillSwitch: vi.fn(async (provider: VendorName) => ({
        schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA,
        provider,
        engaged: rows.get(provider)?.engaged ?? true,
        globalEngaged: store.global,
      })),
      readSettings: vi.fn(async (provider: VendorName) => ({
        schema: PROVIDER_SETTINGS_STATE_SCHEMA,
        provider,
        globalEngaged: store.global,
        engaged: rows.get(provider)?.engaged ?? true,
        dailyQuoteCap: rows.get(provider)?.cap ?? null,
        usedToday: store.used(provider),
      })),
      reserveDispatch: vi.fn(async (provider: VendorName) => {
        const row = rows.get(provider);
        const used = store.used(provider);
        const base = { schema: PROVIDER_DISPATCH_RESERVATION_SCHEMA, provider, cap: row?.cap ?? null };
        if (store.global || !row || row.engaged) return { ...base, allowed: false, reason: "provider_disabled", used };
        if (row.cap !== null && used >= row.cap) return { ...base, allowed: false, reason: PROVIDER_DAILY_CAP_REACHED, used };
        usage.set(`${provider}:${store.day}`, used + 1);
        return { ...base, allowed: true, reason: null, used: used + 1 };
      }),
    } satisfies ProviderSettingsPort,
  };
  return store;
}

/** A supplier added after OVD-829, with no cap, counter, or switch code of its own. */
class BrandNewSupplierAdapter {
  calls = 0;
  async quote(_input: VendorQuoteAdapterInput) {
    this.calls += 1;
    return { status: "instant_quote_received" as const };
  }
}

const INPUT = { organizationId: "org-1", quoteRunId: "run-1", requestedQuantity: 1 } as unknown as VendorQuoteAdapterInput;
// Any vendor name works; the gate holds no per-supplier list.
const NEW_SUPPLIER = "sendcutsend" as VendorName;

function guarded(store: ReturnType<typeof settingsStore>, provider: VendorName = NEW_SUPPLIER) {
  const adapter = new BrandNewSupplierAdapter();
  const onLaunch = vi.fn();
  const quote = guardProviderDispatch({
    provider, port: store.port, capMode: "durable", quote: (input) => adapter.quote(input), onLaunch,
  });
  return { adapter, quote, onLaunch };
}

async function dispatchMany(quote: (input: VendorQuoteAdapterInput) => Promise<unknown>, count: number) {
  const outcomes: ("ok" | string)[] = [];
  for (let n = 0; n < count; n += 1) {
    outcomes.push(await quote(INPUT).then(() => "ok", (error: { reasonCode?: string }) => error.reasonCode ?? "error"));
  }
  return outcomes;
}

describe("universal supplier settings gate (OVD-829)", () => {
  it("refuses a brand new adapter with no gate code of its own when its supplier is switched off", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { engaged: true } });
    const { adapter, quote, onLaunch } = guarded(store);
    const error = await quote(INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderKillSwitchError);
    expect(error).toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED, checkpoint: "before_launch" });
    expect(adapter.calls).toBe(0);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(store.port.reserveDispatch).not.toHaveBeenCalled();
  });

  it("refuses a brand new adapter with no gate code of its own once its supplier's cap is reached", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 2 } });
    const { adapter, quote } = guarded(store);
    expect(await dispatchMany(quote, 3)).toEqual(["ok", "ok", PROVIDER_DAILY_CAP_REACHED]);
    expect(adapter.calls).toBe(2);
    expect(store.used(NEW_SUPPLIER)).toBe(2);
  });

  it("a supplier with no settings row is off (fail closed)", async () => {
    const { adapter, quote } = guarded(settingsStore());
    await expect(quote(INPUT)).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
    expect(adapter.calls).toBe(0);
  });

  it("turning a supplier off stops the very next dispatch, with no restart and nothing cached", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: {} });
    const { adapter, quote } = guarded(store);
    expect(await dispatchMany(quote, 2)).toEqual(["ok", "ok"]);
    store.rows.get(NEW_SUPPLIER)!.engaged = true;
    expect(await dispatchMany(quote, 1)).toEqual([PROVIDER_KILL_SWITCH_ENGAGED]);
    store.rows.get(NEW_SUPPLIER)!.engaged = false;
    expect(await dispatchMany(quote, 1)).toEqual(["ok"]);
    expect(adapter.calls).toBe(3);
  });

  it("a supplier switched off between the switch read and the reservation is refused provider_disabled by the counter", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: {} });
    store.port.readKillSwitch.mockImplementationOnce(async (provider: VendorName) => {
      const state = { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider, engaged: false, globalEngaged: false };
      store.rows.get(NEW_SUPPLIER)!.engaged = true;
      return state;
    });
    const { adapter, quote } = guarded(store);
    await expect(quote(INPUT)).rejects.toMatchObject({ name: "ProviderKillSwitchError", reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
    expect(adapter.calls).toBe(0);
    expect(store.used(NEW_SUPPLIER)).toBe(0);
  });

  it("the kill switch beats the cap: an engaged supplier is provider_disabled whatever its cap", async () => {
    for (const cap of [null, 1, 50]) {
      const store = settingsStore({ [NEW_SUPPLIER]: { engaged: true, cap } });
      await expect(assertProviderDispatchAllowed(NEW_SUPPLIER, store.port))
        .rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
      // The counter answers the same way under its own lock.
      await expect(store.port.reserveDispatch(NEW_SUPPLIER)).resolves.toMatchObject({ reason: "provider_disabled" });
    }
    const atCap = settingsStore({ [NEW_SUPPLIER]: { cap: 1 } });
    await assertProviderDispatchAllowed(NEW_SUPPLIER, atCap.port);
    atCap.rows.get(NEW_SUPPLIER)!.engaged = true;
    await expect(assertProviderDispatchAllowed(NEW_SUPPLIER, atCap.port))
      .rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
  });

  it("the global switch refuses every supplier whatever its cap", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: null } });
    store.global = true;
    await expect(assertProviderDispatchAllowed(NEW_SUPPLIER, store.port))
      .rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
  });

  it("a null cap is unlimited: never refuses, still counts", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: null } });
    const { quote } = guarded(store);
    const outcomes = await dispatchMany(quote, 120);
    expect(outcomes.every((outcome) => outcome === "ok")).toBe(true);
    expect(store.used(NEW_SUPPLIER)).toBe(120);
  });

  it("a cap raised to 50 allows the 21st through 50th dispatch and refuses the 51st", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 50 } });
    const { adapter, quote } = guarded(store);
    const outcomes = await dispatchMany(quote, 51);
    expect(outcomes.slice(20, 50).every((outcome) => outcome === "ok")).toBe(true);
    expect(outcomes[50]).toBe(PROVIDER_DAILY_CAP_REACHED);
    expect(adapter.calls).toBe(50);
  });

  it.each([1, 5, 20])("cap %i refuses at cap + 1", async (cap) => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap } });
    const { quote } = guarded(store);
    const outcomes = await dispatchMany(quote, cap + 1);
    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(cap);
    const refused = await quote(INPUT).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(ProviderDispatchRefusedError);
    expect(refused).toMatchObject({ reasonCode: PROVIDER_DAILY_CAP_REACHED, dailyQuoteCap: cap, usedToday: cap, retryable: false });
  });

  it("the cap is per UTC day: a new day starts from zero", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 1 } });
    const { quote } = guarded(store);
    expect(await dispatchMany(quote, 2)).toEqual(["ok", PROVIDER_DAILY_CAP_REACHED]);
    store.day = "2026-10-17";
    expect(await dispatchMany(quote, 1)).toEqual(["ok"]);
  });

  it("an admin cap change applies to the next dispatch", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 2 } });
    const { quote } = guarded(store);
    expect(await dispatchMany(quote, 3)).toEqual(["ok", "ok", PROVIDER_DAILY_CAP_REACHED]);
    store.rows.get(NEW_SUPPLIER)!.cap = 3;
    expect(await dispatchMany(quote, 2)).toEqual(["ok", PROVIDER_DAILY_CAP_REACHED]);
  });
});

describe("fail closed reads (OVD-829)", () => {
  it("an unreadable on/off switch refuses before the counter is touched", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: {} });
    store.port.readKillSwitch.mockRejectedValueOnce(new Error("rpc down"));
    const { adapter, quote } = guarded(store);
    await expect(quote(INPUT)).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE });
    expect(store.port.reserveDispatch).not.toHaveBeenCalled();
    expect(adapter.calls).toBe(0);
  });

  it.each([
    ["an RPC error", () => Promise.reject(new Error("function does not exist"))],
    ["null", async () => null],
    ["a wrong schema", async () => ({ schema: "v0", provider: NEW_SUPPLIER, allowed: true, reason: null, cap: 20, used: 1 })],
    ["another provider", async () => ({ schema: PROVIDER_DISPATCH_RESERVATION_SCHEMA, provider: "xometry", allowed: true, reason: null, cap: 20, used: 1 })],
    ["allowed as a string", async () => ({ schema: PROVIDER_DISPATCH_RESERVATION_SCHEMA, provider: NEW_SUPPLIER, allowed: "true", reason: null, cap: 20, used: 1 })],
    ["an unknown reason", async () => ({ schema: PROVIDER_DISPATCH_RESERVATION_SCHEMA, provider: NEW_SUPPLIER, allowed: false, reason: "nope", cap: 20, used: 1 })],
    ["a zero cap", async () => ({ schema: PROVIDER_DISPATCH_RESERVATION_SCHEMA, provider: NEW_SUPPLIER, allowed: true, reason: null, cap: 0, used: 1 })],
  ])("a counter answering with %s refuses provider_dispatch_counter_unavailable", async (_label, answer) => {
    const store = settingsStore({ [NEW_SUPPLIER]: {} });
    store.port.reserveDispatch.mockImplementationOnce(answer as never);
    const { adapter, quote } = guarded(store);
    const error = await quote(INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderDispatchRefusedError);
    expect(error).toMatchObject({ reasonCode: PROVIDER_DISPATCH_COUNTER_UNAVAILABLE, retryable: true });
    expect(adapter.calls).toBe(0);
  });

  it("a counter slower than the timeout refuses", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: {} });
    store.port.reserveDispatch.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(assertProviderDispatchAllowed(NEW_SUPPLIER, store.port, { timeoutMs: 10 }))
      .rejects.toMatchObject({ reasonCode: PROVIDER_DISPATCH_COUNTER_UNAVAILABLE });
  });
});

describe("getProviderSettings (OVD-829)", () => {
  it("reads on/off and the cap fresh, counting nothing", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 50 } });
    await expect(getProviderSettings(NEW_SUPPLIER, store.port)).resolves.toEqual({
      provider: NEW_SUPPLIER, enabled: true, disabledReason: null, dailyQuoteCap: 50, capSource: "database",
    });
    store.rows.get(NEW_SUPPLIER)!.cap = null;
    await expect(getProviderSettings(NEW_SUPPLIER, store.port)).resolves.toMatchObject({ dailyQuoteCap: null, capSource: "database" });
    expect(store.port.reserveDispatch).not.toHaveBeenCalled();
  });

  it("falls back to a cap of 20 when the cap read fails", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 50 } });
    store.port.readSettings.mockRejectedValueOnce(new Error("rpc down"));
    await expect(getProviderSettings(NEW_SUPPLIER, store.port)).resolves.toEqual({
      provider: NEW_SUPPLIER, enabled: true, disabledReason: null, dailyQuoteCap: 20, capSource: "default",
    });
  });

  it.each([
    ["a malformed cap", { dailyQuoteCap: -1 }],
    ["a fractional cap", { dailyQuoteCap: 2.5 }],
    ["a wrong schema", { schema: "v0" }],
  ])("falls back to a cap of 20 on %s", async (_label, patch) => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 50 } });
    store.port.readSettings.mockImplementationOnce(async (provider: VendorName) => ({
      schema: PROVIDER_SETTINGS_STATE_SCHEMA, provider, globalEngaged: false, engaged: false, dailyQuoteCap: 50, usedToday: 0, ...patch,
    }));
    await expect(getProviderSettings(NEW_SUPPLIER, store.port)).resolves.toMatchObject({ dailyQuoteCap: 20, capSource: "default" });
  });

  it("reports a supplier off when the on/off read fails (fail closed)", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: {} });
    store.port.readKillSwitch.mockRejectedValueOnce(new Error("rpc down"));
    await expect(getProviderSettings(NEW_SUPPLIER, store.port))
      .resolves.toMatchObject({ enabled: false, disabledReason: PROVIDER_KILL_SWITCH_UNAVAILABLE });
  });

  it("reports a switched off supplier as not enabled", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { engaged: true } });
    await expect(getProviderSettings(NEW_SUPPLIER, store.port))
      .resolves.toMatchObject({ enabled: false, disabledReason: PROVIDER_KILL_SWITCH_ENGAGED });
  });
});

describe("deployment gate: process_local cap mode before the migration (OVD-829)", () => {
  function localGuarded(store: ReturnType<typeof settingsStore>, now = () => new Date("2026-10-16T12:00:00Z")) {
    const adapter = new BrandNewSupplierAdapter();
    const localCounter = new ProcessLocalDispatchCounter(now);
    const quote = guardProviderDispatch({
      provider: NEW_SUPPLIER, port: store.port, capMode: "process_local", localCounter, quote: (input) => adapter.quote(input),
    });
    return { adapter, quote, localCounter };
  }

  it("maps the worker setting and the operator env to a cap mode; only an explicit on is durable", () => {
    expect(providerDispatchCapMode("on")).toBe("durable");
    expect(providerDispatchCapMode("off")).toBe("process_local");
    expect(providerDispatchCapMode(undefined)).toBe("process_local");
    expect(providerDispatchCapModeFromEnv({ [PROVIDER_DURABLE_DISPATCH_CAP_ENV]: " on " })).toBe("durable");
    expect(providerDispatchCapModeFromEnv({ [PROVIDER_DURABLE_DISPATCH_CAP_ENV]: "yes" })).toBe("process_local");
    expect(providerDispatchCapModeFromEnv({})).toBe("process_local");
  });

  it("enforces the database cap read through getProviderSettings, never calling the durable counter", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 2 } });
    const { adapter, quote } = localGuarded(store);
    expect(await dispatchMany(quote, 3)).toEqual(["ok", "ok", PROVIDER_DAILY_CAP_REACHED]);
    expect(adapter.calls).toBe(2);
    expect(store.port.readSettings).toHaveBeenCalledTimes(3);
    expect(store.port.reserveDispatch).not.toHaveBeenCalled();
  });

  it("falls back to a cap of 20 when the settings RPC is missing (pre-migration), refusing the 21st dispatch", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: null } });
    store.port.readSettings.mockRejectedValue(new Error("function api_worker_provider_settings_state does not exist"));
    const { adapter, quote } = localGuarded(store);
    const outcomes = await dispatchMany(quote, DEFAULT_PROVIDER_DAILY_QUOTE_CAP + 1);
    expect(outcomes.slice(0, DEFAULT_PROVIDER_DAILY_QUOTE_CAP).every((outcome) => outcome === "ok")).toBe(true);
    expect(outcomes.at(-1)).toBe(PROVIDER_DAILY_CAP_REACHED);
    expect(adapter.calls).toBe(DEFAULT_PROVIDER_DAILY_QUOTE_CAP);
  });

  it("a null cap read from the database is unlimited", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: null } });
    const { adapter, quote } = localGuarded(store);
    expect((await dispatchMany(quote, 30)).every((outcome) => outcome === "ok")).toBe(true);
    expect(adapter.calls).toBe(30);
  });

  it("keeps the kill switch fail closed: engaged and unreadable both refuse with nothing counted", async () => {
    const engaged = settingsStore({ [NEW_SUPPLIER]: { engaged: true } });
    const first = localGuarded(engaged);
    await expect(first.quote(INPUT)).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED, checkpoint: "before_launch" });
    expect(first.localCounter.used(NEW_SUPPLIER)).toBe(0);

    const unreadable = settingsStore({ [NEW_SUPPLIER]: {} });
    unreadable.port.readKillSwitch.mockRejectedValue(new Error("rpc down"));
    const second = localGuarded(unreadable);
    await expect(second.quote(INPUT)).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE });
    expect(second.adapter.calls).toBe(0);
    expect(second.localCounter.used(NEW_SUPPLIER)).toBe(0);
  });

  it("starts a fresh allowance on the next UTC day", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: 1 } });
    let now = new Date("2026-10-16T23:59:59Z");
    const { quote } = localGuarded(store, () => now);
    expect(await dispatchMany(quote, 2)).toEqual(["ok", PROVIDER_DAILY_CAP_REACHED]);
    now = new Date("2026-10-17T00:00:00Z");
    expect(await dispatchMany(quote, 2)).toEqual(["ok", PROVIDER_DAILY_CAP_REACHED]);
  });

  it("durable mode never treats a missing reserve RPC as allowed, even when the settings read works", async () => {
    const store = settingsStore({ [NEW_SUPPLIER]: { cap: null } });
    store.port.reserveDispatch.mockRejectedValue(new Error("function api_worker_reserve_provider_dispatch does not exist"));
    const { adapter, quote } = guarded(store);
    await expect(quote(INPUT)).rejects.toMatchObject({ reasonCode: PROVIDER_DISPATCH_COUNTER_UNAVAILABLE });
    expect(adapter.calls).toBe(0);
  });
});

describe("refusal outcomes (OVD-829)", () => {
  it("a spent cap goes to manual follow-up and a counter failure fails, both before any provider mutation", () => {
    const phase = createProviderMutationPhase();
    expect(classifyProviderAdapterFailure(new ProviderDispatchRefusedError(PROVIDER_DAILY_CAP_REACHED, "fictiv", 20, 20), phase))
      .toEqual({ failureClass: "manual_follow_up", code: PROVIDER_DAILY_CAP_REACHED });
    expect(classifyProviderAdapterFailure(new ProviderDispatchRefusedError(PROVIDER_DISPATCH_COUNTER_UNAVAILABLE, "fictiv"), phase))
      .toEqual({ failureClass: "failed", code: PROVIDER_DISPATCH_COUNTER_UNAVAILABLE });
  });

  it("the Xometry route reports the refusal as a provider_settings boundary failure", () => {
    expect(dispatchAuthorizationFailure(new ProviderDispatchRefusedError(PROVIDER_DAILY_CAP_REACHED, "xometry", 20, 20)))
      .toEqual({ boundary: "provider_settings", reasonCode: PROVIDER_DAILY_CAP_REACHED, retryable: false });
    expect(dispatchAuthorizationFailure(new ProviderDispatchRefusedError(PROVIDER_DISPATCH_COUNTER_UNAVAILABLE, "xometry")))
      .toEqual({ boundary: "provider_settings", reasonCode: PROVIDER_DISPATCH_COUNTER_UNAVAILABLE, retryable: true });
  });
});

describe("static boundaries (OVD-829)", () => {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|mts|js|mjs)$/.test(name) && !/\.(test|spec)\.|\.node-test\./.test(name) ? [full] : [];
    });
  }

  it("no adapter source references a daily cap constant, an in-process counter, or the settings tables", () => {
    const forbidden = /DAILY_QUOTE_CAP|dailyQuoteCap|daily_quote_cap|quotesToday|quotesStartedToday|provider_kill_switches|provider_daily_quote_usage|api_worker_reserve_provider_dispatch/;
    const offenders = sourceFiles(path.join(srcDir, "adapters"))
      .filter((file) => forbidden.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(srcDir, file));
    expect(offenders).toEqual([]);
  });

  // Every non-adapter source that calls an adapter's quote. Entry points must
  // wrap with the settings gate; pass-throughs only receive an adapter one of
  // the entry points already wrapped. A new caller fails here until it is
  // classified.
  const LIVE_DISPATCH_ENTRY_POINTS = [
    "index.ts",
    "dispatchRouting.ts",
    "tools/vendorWorkflowSmoke.ts",
    "tools/xometryQuantitySweep.ts",
  ];
  const WRAPPED_ADAPTER_PASS_THROUGHS = [
    "providerDispatchPreflight.ts",
    "providerTaskPipeline.ts",
    "xometryDispatchPreflight.ts",
  ];

  it("every source that calls an adapter's quote is a classified live dispatch caller", () => {
    const callers = sourceFiles(srcDir)
      .filter((file) => !file.startsWith(path.join(srcDir, "adapters") + path.sep))
      .filter((file) => /\.quote\(|evaluateLocally\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(srcDir, file).split(path.sep).join("/"))
      .sort();
    expect(callers).toEqual([...LIVE_DISPATCH_ENTRY_POINTS, ...WRAPPED_ADAPTER_PASS_THROUGHS].sort());
  });

  it("every live dispatch entry point, operator tools included, goes through the settings gate", () => {
    for (const file of LIVE_DISPATCH_ENTRY_POINTS) {
      const source = readFileSync(path.join(srcDir, file), "utf8");
      expect(source, file).toMatch(/guardProviderDispatch\(|guardOperatorQuote\(/);
      expect(source, file).not.toContain("guardProviderQuote(");
      expect(source, file).not.toContain("createProviderKillSwitchGuard(");
    }
    const operatorGate = readFileSync(path.join(srcDir, "tools/operatorKillSwitchGate.ts"), "utf8");
    expect(operatorGate).toContain("guardProviderDispatch(");
    expect(operatorGate).not.toContain("guardProviderQuote(");
  });

  it("only the settings gate itself builds the bare kill-switch guard", () => {
    const offenders = sourceFiles(srcDir)
      .filter((file) => path.basename(file) !== "providerSettings.ts")
      .filter((file) => /guardProviderQuote\(|createProviderKillSwitchGuard\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(srcDir, file));
    expect(offenders).toEqual([]);
  });
});
