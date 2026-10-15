import { describe, expect, it } from "vitest";
import {
  checkAllProviderSessionHealth,
  checkProviderSessionHealth,
  classifyProbeResult,
  SESSION_HEALTH_PROVIDERS,
} from "./providerSessionHealth";
import {
  BACKOFF_MS,
  decideRefresh,
  KEEP_VERSIONS,
  KILL_SWITCH_AFTER_FAILED_CYCLES,
  MAX_LOGINS_PER_24H,
  nextBackoffMs,
  requiresHuman,
  shouldTripKillSwitch,
} from "./providerSessionRefreshPolicy";
import {
  createDashboardChannel,
  createEmailChannel,
  enabledAlertChannels,
} from "./alerts/channels";
import { createSessionAlertDispatcher } from "./alerts/dispatcher";

const fixedNow = () => new Date("2026-10-14T12:00:00.000Z");
const NOW = fixedNow().getTime();
const record = (state: Parameters<typeof requiresHuman>[0]["state"], reason = "x") =>
  ({ provider: "fictiv", state, reason, checkedAt: fixedNow().toISOString() }) as const;

describe("provider session health", () => {
  it("maps probe outcomes to health records with the injected clock", async () => {
    const probe = async () => ({ outcome: "logged_out" as const, reason: "login_form" as const });
    expect(await checkProviderSessionHealth("quickparts", { probe, now: fixedNow })).toEqual({
      provider: "quickparts",
      state: "logged_out",
      checkedAt: "2026-10-14T12:00:00.000Z",
      reason: "login_form",
    });
  });

  it("classifies mfa reasons as mfa_required", () => {
    expect(classifyProbeResult({ outcome: "blocked", reason: "mfa_challenge" as never })).toBe("mfa_required");
    expect(classifyProbeResult({ outcome: "authenticated", reason: "authenticated_marker_found" })).toBe("authenticated");
  });

  it("turns a throwing probe into an error record without leaking the message", async () => {
    const probe = async () => {
      throw new Error("token=SECRET");
    };
    const result = await checkProviderSessionHealth("xometry", { probe, now: fixedNow });
    expect(result.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("checks every provider", async () => {
    const seen: string[] = [];
    const probe = async (provider: string) => {
      seen.push(provider);
      return { outcome: "authenticated" as const, reason: "authenticated_marker_found" as const };
    };
    const records = await checkAllProviderSessionHealth({ probe, now: fixedNow });
    expect(seen.sort()).toEqual([...SESSION_HEALTH_PROVIDERS].sort());
    expect(records.every((r) => r.state === "authenticated")).toBe(true);
  });
});

describe("refresh policy", () => {
  const fresh = { loginAttemptsAt: [], consecutiveFailures: 0, lastAttemptAt: null };

  it("exposes the agreed constants", () => {
    expect([KEEP_VERSIONS, MAX_LOGINS_PER_24H, KILL_SWITCH_AFTER_FAILED_CYCLES]).toEqual([5, 3, 3]);
    expect(BACKOFF_MS).toEqual([60e3, 300e3, 1800e3]);
  });

  it("allows refresh for a logged out session and skips healthy ones", () => {
    expect(decideRefresh(record("logged_out"), fresh, NOW)).toEqual({ allowed: true });
    expect(decideRefresh(record("authenticated"), fresh, NOW)).toEqual({ allowed: false, reason: "healthy" });
  });

  it("never retries mfa or captcha", () => {
    expect(requiresHuman(record("mfa_required"))).toBe(true);
    expect(requiresHuman(record("blocked", "challenge_page"))).toBe(true);
    expect(requiresHuman(record("blocked", "access_denied"))).toBe(false);
    expect(decideRefresh(record("mfa_required"), fresh, NOW)).toEqual({ allowed: false, reason: "human_required" });
  });

  it("caps logins per rolling 24h", () => {
    const attempts = [NOW - 3600e3, NOW - 7200e3, NOW - 10800e3];
    const decision = decideRefresh(record("logged_out"), { ...fresh, loginAttemptsAt: attempts }, NOW);
    expect(decision).toEqual({ allowed: false, reason: "login_budget_exhausted", retryAt: NOW - 10800e3 + 86400e3 });
    const old = [NOW - 90000e3, ...attempts.slice(1)];
    expect(decideRefresh(record("logged_out"), { ...fresh, loginAttemptsAt: old }, NOW).allowed).toBe(true);
  });

  it("backs off after failures and then allows", () => {
    const history = { loginAttemptsAt: [], consecutiveFailures: 2, lastAttemptAt: NOW - 100e3 };
    expect(decideRefresh(record("error"), history, NOW)).toEqual({
      allowed: false,
      reason: "backoff",
      retryAt: NOW - 100e3 + 300e3,
    });
    expect(decideRefresh(record("error"), { ...history, lastAttemptAt: NOW - 301e3 }, NOW).allowed).toBe(true);
  });

  it("steps backoff and clamps at the last value", () => {
    expect([1, 2, 3, 9].map(nextBackoffMs)).toEqual([60e3, 300e3, 1800e3, 1800e3]);
  });

  it("trips the kill switch at the failed-cycle threshold", () => {
    expect([2, 3, 4].map(shouldTripKillSwitch)).toEqual([false, true, true]);
  });
});

describe("alert channels", () => {
  it("defaults to dashboard only and honours env flags", () => {
    expect(enabledAlertChannels({})).toEqual(["dashboard"]);
    expect(enabledAlertChannels({ ALERT_CHANNEL_EMAIL_ENABLED: "true", ALERT_CHANNEL_SMS_ENABLED: "1" })).toEqual([
      "email",
      "sms",
      "dashboard",
    ]);
    expect(enabledAlertChannels({ ALERT_CHANNEL_DASHBOARD_ENABLED: "false", ALERT_CHANNEL_SLACK_ENABLED: "maybe" })).toEqual([]);
  });

  it("sends one alert per state change to all channels", async () => {
    const dashboard = createDashboardChannel();
    const email = createEmailChannel();
    const dispatcher = createSessionAlertDispatcher([dashboard, email]);

    expect(await dispatcher.observe(record("authenticated"))).toBeNull();
    const alert = await dispatcher.observe(record("logged_out", "login_form"));
    expect(alert).toMatchObject({ provider: "fictiv", from: "authenticated", to: "logged_out" });
    expect(await dispatcher.observe(record("logged_out", "login_form"))).toBeNull();
    await dispatcher.observe(record("mfa_required"));

    expect(dashboard.events).toHaveLength(2);
    expect(email.sent).toHaveLength(2);
  });

  it("alerts when a provider is first seen unhealthy and survives a failing channel", async () => {
    const dashboard = createDashboardChannel();
    const broken = { name: "slack" as const, send: async () => Promise.reject(new Error("down")) };
    const dispatcher = createSessionAlertDispatcher([broken, dashboard]);
    await dispatcher.observe(record("blocked", "challenge_page"));
    expect(dashboard.events).toHaveLength(1);
  });
});
