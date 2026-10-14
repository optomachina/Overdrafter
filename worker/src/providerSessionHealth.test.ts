// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLOCKED_COOLDOWN_MS,
  createInMemoryHealthStore,
  isProbeDue,
  mapProbeOutcomeToHealth,
  runProviderHealthCheck,
  shouldProbeBeforeDispatch,
  type HealthProbe,
  type HealthProbeEvidence,
  type HealthProvider,
  type ProviderHealthRecord,
} from "./providerSessionHealth";
import { PROVIDER_KILL_SWITCH_ENGAGED, PROVIDER_KILL_SWITCH_UNAVAILABLE, ProviderKillSwitchError } from "./providerKillSwitch";

const T0 = new Date("2026-10-14T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 60 * 60 * 1000;

function fakeProbe(script: Partial<Record<HealthProvider, HealthProbeEvidence | Error>>) {
  const calls: HealthProvider[] = [];
  const probe: HealthProbe = async (provider) => {
    calls.push(provider);
    const next = script[provider];
    if (next instanceof Error) throw next;
    return next ?? { outcome: "authenticated", reason: "authenticated_marker_found" };
  };
  return { probe, calls };
}

function record(overrides: Partial<ProviderHealthRecord> = {}): ProviderHealthRecord {
  return {
    provider: "fictiv",
    status: "healthy",
    reason: "authenticated_marker_found",
    checkedAt: T0.toISOString(),
    consecutiveFailures: 0,
    lastHealthyAt: T0.toISOString(),
    changed: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mapProbeOutcomeToHealth", () => {
  it("maps outcomes to statuses", () => {
    expect(mapProbeOutcomeToHealth({ outcome: "authenticated", reason: "authenticated_marker_found" })).toBe("healthy");
    expect(mapProbeOutcomeToHealth({ outcome: "logged_out", reason: "login_form" })).toBe("logged_out");
    expect(mapProbeOutcomeToHealth({ outcome: "blocked", reason: "challenge_page" })).toBe("blocked");
    expect(mapProbeOutcomeToHealth({ outcome: "error", reason: "navigation_failed" })).toBe("error");
  });

  it("reads an HTTP 401 as logged_out even when the probe classed it as blocked", () => {
    expect(mapProbeOutcomeToHealth({ outcome: "blocked", reason: "http_unauthorized" })).toBe("logged_out");
  });
});

describe("runProviderHealthCheck", () => {
  it("records healthy when the probe is authenticated", async () => {
    const store = createInMemoryHealthStore();
    const { probe } = fakeProbe({});
    const [result] = await runProviderHealthCheck({ providers: ["fictiv"], probe, store, now: () => T0 });
    expect(result).toEqual({
      provider: "fictiv",
      status: "healthy",
      reason: "authenticated_marker_found",
      checkedAt: T0.toISOString(),
      consecutiveFailures: 0,
      lastHealthyAt: T0.toISOString(),
      changed: true,
    });
    expect(await store.get("fictiv")).toEqual(result);
  });

  it("increments failures on an expired session and flags changed only on transitions", async () => {
    const store = createInMemoryHealthStore();
    const run = async (evidence: HealthProbeEvidence, offset: number) => {
      const { probe } = fakeProbe({ quickparts: evidence });
      const [result] = await runProviderHealthCheck({ providers: ["quickparts"], probe, store, now: () => at(offset) });
      return result;
    };
    const healthy = await run({ outcome: "authenticated", reason: "authenticated_marker_found" }, 0);
    const first = await run({ outcome: "logged_out", reason: "login_form" }, HOUR);
    const second = await run({ outcome: "logged_out", reason: "login_form" }, 2 * HOUR);
    const recovered = await run({ outcome: "authenticated", reason: "authenticated_marker_found" }, 3 * HOUR);

    expect(healthy).toMatchObject({ status: "healthy", changed: true, consecutiveFailures: 0 });
    expect(first).toMatchObject({ status: "logged_out", changed: true, consecutiveFailures: 1 });
    expect(first.lastHealthyAt).toBe(T0.toISOString());
    expect(second).toMatchObject({ status: "logged_out", changed: false, consecutiveFailures: 2 });
    expect(recovered).toMatchObject({ status: "healthy", changed: true, consecutiveFailures: 0, lastHealthyAt: at(3 * HOUR).toISOString() });
  });

  it("probes each provider exactly once and never retries a failure", async () => {
    const { probe, calls } = fakeProbe({ xometry: { outcome: "error", reason: "navigation_failed" } });
    const results = await runProviderHealthCheck({
      providers: ["fictiv", "xometry", "rmfg"],
      probe,
      store: createInMemoryHealthStore(),
      now: () => T0,
    });
    expect(calls).toEqual(["fictiv", "xometry", "rmfg"]);
    expect(results.map((r) => r.status)).toEqual(["healthy", "error", "healthy"]);
  });

  it("reads an rmfg 401 as logged_out and unhealthy", async () => {
    const { probe } = fakeProbe({ rmfg: { outcome: "blocked", reason: "http_unauthorized" } });
    const [result] = await runProviderHealthCheck({
      providers: ["rmfg"],
      probe,
      store: createInMemoryHealthStore(),
      now: () => T0,
    });
    expect(result).toMatchObject({ provider: "rmfg", status: "logged_out", reason: "http_unauthorized", consecutiveFailures: 1 });
  });

  it("records a thrown error as probe_threw without the message, in the record or on the console", async () => {
    const secret = "sk_live_SUPERSECRETKEY123";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const store = createInMemoryHealthStore();
    const { probe } = fakeProbe({ rmfg: new Error(`request failed with Authorization: Bearer ${secret}`) });

    const results = await runProviderHealthCheck({ providers: ["rmfg"], probe, store, now: () => T0 });

    expect(results[0]).toMatchObject({ status: "error", reason: "probe_threw", consecutiveFailures: 1 });
    expect(JSON.stringify(results)).not.toContain(secret);
    expect(JSON.stringify(await store.get("rmfg"))).not.toContain(secret);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  });

  it("replaces a free text reason from a probe with a fixed code", async () => {
    const { probe } = fakeProbe({ fictiv: { outcome: "error", reason: "failed: cookie=abc123; token=zzz" } });
    const [result] = await runProviderHealthCheck({
      providers: ["fictiv"],
      probe,
      store: createInMemoryHealthStore(),
      now: () => T0,
    });
    expect(result.reason).toBe("probe_reason_invalid");
    expect(JSON.stringify(result)).not.toContain("abc123");
  });

  it("only stores provider, status, reason, timestamps and counts", async () => {
    const { probe } = fakeProbe({});
    const [result] = await runProviderHealthCheck({
      providers: ["fictiv"],
      probe,
      store: createInMemoryHealthStore(),
      now: () => T0,
    });
    expect(Object.keys(result).sort()).toEqual(
      ["changed", "checkedAt", "consecutiveFailures", "lastHealthyAt", "provider", "reason", "status"].sort(),
    );
  });

  it("does not probe a provider whose kill switch is engaged and leaves its status unchanged", async () => {
    const prior = record({ provider: "fictiv", status: "logged_out", reason: "login_form", consecutiveFailures: 2, lastHealthyAt: null });
    const store = createInMemoryHealthStore([prior]);
    const { probe, calls } = fakeProbe({});
    const killSwitchGuard = (provider: HealthProvider) => async () => {
      if (provider === "fictiv") throw new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_ENGAGED, "fictiv", "before_launch");
    };

    const results = await runProviderHealthCheck({
      providers: ["fictiv", "quickparts"],
      probe,
      store,
      now: () => at(HOUR),
      killSwitchGuard,
    });

    expect(calls).toEqual(["quickparts"]);
    expect(results[0]).toEqual({ ...prior, reason: "provider_kill_switch_engaged", changed: false });
    expect(results[1]).toMatchObject({ provider: "quickparts", status: "healthy" });
  });

  it("fails closed when the kill switch cannot be read", async () => {
    const { probe, calls } = fakeProbe({});
    const [result] = await runProviderHealthCheck({
      providers: ["xometry"],
      probe,
      store: createInMemoryHealthStore(),
      now: () => T0,
      killSwitchGuard: () => async () => {
        throw new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_UNAVAILABLE, "xometry", "before_launch");
      },
    });
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ status: "unknown", reason: "provider_kill_switch_unavailable", changed: false });
  });
});

describe("scheduling helpers", () => {
  it("isProbeDue is true with no record, unknown status, or at least 6h since the last probe", () => {
    expect(isProbeDue(null, T0)).toBe(true);
    expect(isProbeDue(record({ status: "unknown" }), T0)).toBe(true);
    expect(isProbeDue(record(), at(6 * HOUR - 1))).toBe(false);
    expect(isProbeDue(record(), at(6 * HOUR))).toBe(true);
    expect(isProbeDue(record(), at(HOUR), HOUR)).toBe(true);
  });

  it("shouldProbeBeforeDispatch is true when the record is older than 15 minutes", () => {
    expect(shouldProbeBeforeDispatch(null, T0)).toBe(true);
    expect(shouldProbeBeforeDispatch(record(), at(14 * 60 * 1000))).toBe(false);
    expect(shouldProbeBeforeDispatch(record(), at(15 * 60 * 1000))).toBe(true);
    expect(shouldProbeBeforeDispatch(record(), at(HOUR), 2 * HOUR)).toBe(false);
  });

  it("treats an unparseable checkedAt as due", () => {
    expect(isProbeDue(record({ checkedAt: "not a date" }), T0)).toBe(true);
    expect(shouldProbeBeforeDispatch(record({ checkedAt: "not a date" }), T0)).toBe(true);
  });

  it("does not re-probe a blocked provider before the one day cooldown", () => {
    const blocked = record({ status: "blocked", reason: "challenge_page" });
    expect(isProbeDue(blocked, at(7 * HOUR))).toBe(false);
    expect(shouldProbeBeforeDispatch(blocked, at(HOUR))).toBe(false);
    expect(isProbeDue(blocked, at(BLOCKED_COOLDOWN_MS))).toBe(true);
  });
});
