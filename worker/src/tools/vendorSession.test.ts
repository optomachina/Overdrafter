// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserProbeOptions, SessionProbeEvidence } from "../providerSessionProbe";
import { PROVIDER_KILL_SWITCH_STATE_SCHEMA } from "../providerSettings";
import {
  checkVendorSession,
  parseSessionCliArgs,
  parseVendorList,
  refreshVendorSession,
  resolveVendorSessionProfile,
  sessionStatePath,
  vendorKillSwitchDecision,
  type SessionProbe,
} from "./vendorSession";

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovd-vendor-session-")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

const cookie = (name: string, domain: string) => ({
  name, value: `${name}-value`, domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const,
});

const quickpartsState = {
  cookies: [cookie("qp_session", "quickquote.quickparts.com")],
  origins: [{ origin: "https://quickquote.quickparts.com", localStorage: [{ name: "token", value: "fixture" }] }],
};

async function writeState(vendor: "quickparts" | "geomiq" | "weerg", state: unknown) {
  await fs.writeFile(sessionStatePath(stateDir, vendor), JSON.stringify(state), { mode: 0o600 });
}

function evidence(outcome: SessionProbeEvidence["outcome"], reason: SessionProbeEvidence["reason"]): SessionProbeEvidence {
  return {
    provider: "quickparts", timestamp: "2026-10-22T00:00:00.000Z", outcome, reason,
    finalHost: "quickquote.quickparts.com", httpStatus: 200, navigations: 1, blockedRequests: 0,
  };
}

function fakeProbe(result: SessionProbeEvidence, rotated?: unknown): { probe: SessionProbe; calls: BrowserProbeOptions[] } {
  const calls: BrowserProbeOptions[] = [];
  const probe: SessionProbe = async (options) => {
    calls.push(options);
    if (result.outcome === "authenticated") await options.onAuthenticated?.((rotated ?? options.storageState) as never);
    return result;
  };
  return { probe, calls };
}

const killSwitchState = (engaged: boolean) => async () => ({
  schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider: "quickparts", engaged, globalEngaged: false,
});

describe("vendor session profiles", () => {
  it("judges each vendor on its kernel landing page with its reviewed hosts", () => {
    expect(resolveVendorSessionProfile("quickparts")).toMatchObject({
      loginUrl: "https://quickquote.quickparts.com/#/login",
      landingUrl: "https://quickquote.quickparts.com/",
      sessionHosts: ["quickparts.com", "quickquote.quickparts.com"],
    });
    expect(resolveVendorSessionProfile("geomiq")).toMatchObject({
      loginUrl: "https://app.geomiq.com/",
      landingUrl: "https://app.geomiq.com/",
      sessionHosts: ["app.geomiq.com", "geomiq.com"],
    });
    expect(resolveVendorSessionProfile("weerg")).toMatchObject({
      loginUrl: "https://www.weerg.com/",
      landingUrl: "https://www.weerg.com/en/global/quotation-tool/upload",
      sessionHosts: ["www.weerg.com"],
    });
  });

  it("refuses OSH Cut and vendors without a reviewed definition", () => {
    expect(() => resolveVendorSessionProfile("oshcut")).toThrow(/OVD-1022/);
    expect(() => resolveVendorSessionProfile("fabworks")).toThrow(/Unsupported vendor/);
    expect(() => parseVendorList("quickparts,oshcut")).toThrow(/OVD-1022/);
    expect(parseVendorList(" Quickparts ,weerg,quickparts")).toEqual(["quickparts", "weerg"]);
  });
});

describe("session:check", () => {
  const profile = resolveVendorSessionProfile("quickparts");

  it("reports a missing file without probing", async () => {
    const fake = fakeProbe(evidence("authenticated", "authenticated_marker_found"));
    await expect(checkVendorSession(profile, stateDir, { probe: fake.probe })).resolves.toMatchObject({ state: "missing" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reports a session the kernel would refuse (third-party cookie, symlink, bad JSON) without probing", async () => {
    const fake = fakeProbe(evidence("authenticated", "authenticated_marker_found"));
    await writeState("quickparts", { ...quickpartsState, cookies: [...quickpartsState.cookies, cookie("NID", ".google.com")] });
    await expect(checkVendorSession(profile, stateDir, { probe: fake.probe })).resolves.toMatchObject({ state: "unopenable_by_kernel" });

    await fs.writeFile(sessionStatePath(stateDir, "quickparts"), "{not json");
    await expect(checkVendorSession(profile, stateDir, { probe: fake.probe })).resolves.toMatchObject({ state: "unopenable_by_kernel" });

    await fs.rm(sessionStatePath(stateDir, "quickparts"));
    const real = path.join(stateDir, "real.json");
    await fs.writeFile(real, JSON.stringify(quickpartsState));
    await fs.symlink(real, sessionStatePath(stateDir, "quickparts"));
    await expect(checkVendorSession(profile, stateDir, { probe: fake.probe })).resolves.toMatchObject({ state: "unopenable_by_kernel" });
    expect(fake.calls).toHaveLength(0);
  });

  it("maps the GET-only probe verdict to valid, login_required or check_failed", async () => {
    await writeState("quickparts", quickpartsState);
    const cases: Array<[SessionProbeEvidence, string]> = [
      [evidence("authenticated", "authenticated_marker_found"), "valid"],
      [evidence("authenticated", "terminal_signals_ready"), "valid"],
      [evidence("logged_out", "login_form"), "login_required"],
      [evidence("logged_out", "no_authenticated_marker"), "login_required"],
      [evidence("blocked", "challenge_page"), "check_failed"],
      [evidence("error", "navigation_failed"), "check_failed"],
    ];
    for (const [result, state] of cases) {
      const outcome = await checkVendorSession(profile, stateDir, { probe: fakeProbe(result).probe });
      expect(outcome.state).toBe(state);
      expect(outcome.reason).toBe(result.reason);
    }
  });

  it("probes the landing page with the kernel-parsed session and the definition's own classifier", async () => {
    await writeState("quickparts", quickpartsState);
    const fake = fakeProbe(evidence("authenticated", "terminal_signals_ready"));
    await checkVendorSession(profile, stateDir, { probe: fake.probe });
    const [options] = fake.calls;
    expect(options.target).toEqual({
      provider: "quickparts", adapterKind: "portal", landingUrl: "https://quickquote.quickparts.com/",
      allowedHosts: ["quickparts.com", "quickquote.quickparts.com"],
    });
    expect(options.storageState).toEqual(quickpartsState);
    expect(options.allowLoopbackHttp).toBeUndefined();
    const accepts = options.settledPageAccepts!;
    await expect(accepts({ url: "https://quickquote.quickparts.com/#/quotes", bodyText: "Upload a part", passwordInputCount: 0 })).resolves.toBe(true);
    await expect(accepts({ url: "https://quickquote.quickparts.com/#/login", bodyText: "Sign in", passwordInputCount: 1 })).resolves.toBe(false);
    await expect(accepts({ url: "https://quickquote.quickparts.com/", bodyText: "Please verify you are human", passwordInputCount: 0 })).resolves.toBe(false);
    await expect(accepts({ url: "https://evil.example.test/", bodyText: "Upload", passwordInputCount: 0 })).resolves.toBe(false);
  });
});

describe("session:refresh", () => {
  const profile = resolveVendorSessionProfile("quickparts");

  it("re-saves a still-valid session scoped to the reviewed hosts, owner-only", async () => {
    await writeState("quickparts", quickpartsState);
    const rotated = {
      cookies: [cookie("qp_session", "quickquote.quickparts.com"), cookie("qp_rotated", ".quickparts.com"), cookie("_ga", ".google-analytics.com")],
      origins: [...quickpartsState.origins, { origin: "https://www.google.com", localStorage: [] }],
    };
    const fake = fakeProbe(evidence("authenticated", "authenticated_marker_found"), rotated);
    const result = await refreshVendorSession(profile, stateDir, { probe: fake.probe, env: {} });
    expect(result).toMatchObject({ state: "valid", refreshed: true, killSwitch: "not_checked" });
    const filePath = sessionStatePath(stateDir, "quickparts");
    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(saved.cookies.map((entry: { name: string }) => entry.name)).toEqual(["qp_session", "qp_rotated"]);
    expect(saved.origins.map((entry: { origin: string }) => entry.origin)).toEqual(["https://quickquote.quickparts.com"]);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("never rewrites a session that is not valid", async () => {
    await writeState("quickparts", quickpartsState);
    const before = await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8");
    for (const result of [evidence("logged_out", "login_form"), evidence("blocked", "challenge_page")]) {
      const outcome = await refreshVendorSession(profile, stateDir, { probe: fakeProbe(result).probe, env: {} });
      expect(outcome.refreshed).toBe(false);
    }
    expect(await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8")).toBe(before);
  });

  it("skips the provider entirely when a readable kill switch is engaged or unreadable", async () => {
    await writeState("quickparts", quickpartsState);
    const fake = fakeProbe(evidence("authenticated", "authenticated_marker_found"));
    const engaged = await refreshVendorSession(profile, stateDir, {
      probe: fake.probe, killSwitchReader: killSwitchState(true),
    });
    expect(engaged).toMatchObject({ refreshed: false, killSwitch: "engaged_or_unreadable" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("kill switch decision", () => {
  it("is not checked without service-role credentials, and refuses on any failed read", async () => {
    await expect(vendorKillSwitchDecision("quickparts", {})).resolves.toBe("not_checked");
    await expect(vendorKillSwitchDecision("quickparts", {}, async () => { throw new Error("down"); })).resolves.toBe("engaged_or_unreadable");
    await expect(vendorKillSwitchDecision("quickparts", {}, killSwitchState(false))).resolves.toBe("disengaged");
    await expect(vendorKillSwitchDecision("quickparts", {}, async () => ({ engaged: false }))).resolves.toBe("engaged_or_unreadable");
  });
});

describe("session CLI arguments", () => {
  it("parses the command, vendor list and flags", () => {
    expect(parseSessionCliArgs(["check", "quickparts,geomiq", "--state-dir", "/tmp/state", "--json"])).toEqual({
      command: "check", vendors: ["quickparts", "geomiq"], stateDir: "/tmp/state", configPath: null, json: true,
    });
    expect(parseSessionCliArgs(["refresh"])).toMatchObject({ command: "refresh", vendors: null });
    expect(() => parseSessionCliArgs(["login"])).toThrow(/Usage/);
    expect(() => parseSessionCliArgs(["check", "--state-dir"])).toThrow(/needs a value/);
    expect(() => parseSessionCliArgs(["check", "quickparts", "weerg"])).toThrow(/Unexpected argument/);
  });
});
