// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserProbeOptions, SessionProbeEvidence } from "../providerSessionProbe";
import { PROVIDER_KILL_SWITCH_STATE_SCHEMA } from "../providerSettings";
import {
  acquireSessionLock,
  checkVendorSession,
  parseSessionCliArgs,
  parseVendorList,
  probeStorageState,
  refreshVendorSession,
  refuseDiagnostics,
  resolveVendorSessionProfile,
  saveScopedSession,
  sessionStatePath,
  settledPageVerdict,
  signedInEvidence,
  storageStateHoldsSecret,
  vendorKillSwitchDecision,
  workerSessionOverride,
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

const isAnonymous = (options: BrowserProbeOptions) => options.storageState.cookies.length === 0 && options.storageState.origins.length === 0;

/** A probe that signs in only with a session; an anonymous visit gets `anonymous` (logged out unless given). */
function fakeProbe(
  result: SessionProbeEvidence,
  rotated?: unknown,
  anonymous: SessionProbeEvidence = evidence("logged_out", "login_form"),
): { probe: SessionProbe; calls: BrowserProbeOptions[] } {
  const calls: BrowserProbeOptions[] = [];
  const probe: SessionProbe = async (options) => {
    calls.push(options);
    const outcome = isAnonymous(options) ? anonymous : result;
    if (outcome.outcome === "authenticated") await options.onAuthenticated?.((rotated ?? options.storageState) as never);
    return outcome;
  };
  return { probe, calls };
}

const SIGNED_IN_TEXT = "Upload a part to get an instant quote. Recent quotes: bracket rev B, enclosure lid, mounting plate.";

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

  it("refuses to probe a session with Playwright or Node diagnostics enabled", async () => {
    await writeState("quickparts", quickpartsState);
    const fake = fakeProbe(evidence("authenticated", "authenticated_marker_found"));
    for (const env of [{ DEBUG: "pw:protocol" }, { DEBUG: "*" }, { PWDEBUG: "1" }, { DEBUG_FILE: "/tmp/x" }, { NODE_DEBUG: "child_process" }, { NODE_OPTIONS: "--inspect=0" }]) {
      expect(() => refuseDiagnostics(env)).toThrow(/diagnostics enabled/);
      await expect(checkVendorSession(profile, stateDir, { probe: fake.probe, env })).rejects.toThrow(/diagnostics enabled/);
      await expect(refreshVendorSession(profile, stateDir, { probe: fake.probe, env })).rejects.toThrow(/diagnostics enabled/);
      await expect(probeStorageState(profile, quickpartsState, { probe: fake.probe, env })).rejects.toThrow(/diagnostics enabled/);
    }
    expect(fake.calls).toHaveLength(0);
    expect(() => refuseDiagnostics({ DEBUG: " ", NODE_OPTIONS: "--max-old-space-size=4096" })).not.toThrow();
    await expect(checkVendorSession(profile, stateDir, { probe: fake.probe, env: {} })).resolves.toMatchObject({ state: "valid" });
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
    // The probe's Chromium gets no vault session and no worker secrets.
    expect(Object.keys(options.browserEnv ?? { missing: true }).every((name) => ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "NODE_EXTRA_CA_CERTS"].includes(name))).toBe(true);
    const verdict = options.settledPageVerdict!;
    await expect(verdict({ url: "https://quickquote.quickparts.com/#/quotes", bodyText: SIGNED_IN_TEXT, passwordInputCount: 0 })).resolves.toBe("signed_in");
    await expect(verdict({ url: "https://quickquote.quickparts.com/#/login", bodyText: "Sign in", passwordInputCount: 1 })).resolves.toBe("signed_out");
    await expect(verdict({ url: "https://quickquote.quickparts.com/", bodyText: "Please verify you are human", passwordInputCount: 0 })).resolves.toBe("indeterminate");
    await expect(verdict({ url: "https://evil.example.test/", bodyText: "Upload", passwordInputCount: 0 })).resolves.toBe("indeterminate");
  });
});

describe("signed-in evidence without a log out control", () => {
  const { definition } = resolveVendorSessionProfile("weerg");
  const url = "https://www.weerg.com/en/global/quotation-tool/upload";

  it("accepts a settled content page and refuses shells, spinners, errors, sign-in links and second-factor text", async () => {
    await expect(signedInEvidence({ url, bodyText: SIGNED_IN_TEXT, passwordInputCount: 0 }, definition)).resolves.toBe(true);
    for (const bodyText of [
      "",
      "Loading…",
      "Something went wrong. Please try again later, our team has been notified of the problem.",
      `${SIGNED_IN_TEXT} Login | Register`,
      `${SIGNED_IN_TEXT} Approve the request in your authenticator app.`,
      "Upload a part",
    ]) {
      await expect(signedInEvidence({ url, bodyText, passwordInputCount: 0 }, definition)).resolves.toBe(false);
    }
    await expect(signedInEvidence({ url, bodyText: SIGNED_IN_TEXT, passwordInputCount: 1 }, definition)).resolves.toBe(false);
    await expect(signedInEvidence({ url: "https://evil.example.test/", bodyText: SIGNED_IN_TEXT, passwordInputCount: 0 }, definition)).resolves.toBe(false);
  });

  it("keeps an error, spinner or second-factor page apart from a signed-out one", async () => {
    const page = (bodyText: string) => settledPageVerdict({ url, bodyText, passwordInputCount: 0 }, definition);
    await expect(page("Loading…")).resolves.toBe("indeterminate");
    await expect(page("Enter the verification code we sent to your phone to continue to your quotes.")).resolves.toBe("indeterminate");
    await expect(page("Something went wrong. Please try again later, our team has been notified.")).resolves.toBe("indeterminate");
    await expect(page(`${SIGNED_IN_TEXT} Log in to see prices`)).resolves.toBe("signed_out");
    await expect(page(SIGNED_IN_TEXT)).resolves.toBe("signed_in");
  });

  it("never takes a log out control on a second-factor or error page as signed in", async () => {
    const { definition, landingUrl: url } = resolveVendorSessionProfile("quickparts");
    const withLogout = (bodyText: string) => settledPageVerdict({ url, bodyText, passwordInputCount: 0 }, definition, { logoutControl: true });
    await expect(withLogout("Enter the verification code we sent to your phone. Log out")).resolves.toBe("indeterminate");
    await expect(withLogout("Approve the request in your authenticator app. Log out")).resolves.toBe("indeterminate");
    await expect(withLogout("Something went wrong. Log out")).resolves.toBe("indeterminate");
    await expect(withLogout("Approve the sign-in request on your phone to continue. Log out")).resolves.toBe("indeterminate");
    await expect(withLogout("An error occurred. Please try again. Log out")).resolves.toBe("indeterminate");
    await expect(withLogout("Loading… Please wait. Log out")).resolves.toBe("indeterminate");
    await expect(withLogout("Upload a part. Log out")).resolves.toBe("signed_in");
  });

  it("needs a clearly signed-out anonymous visit to confirm content-only evidence", async () => {
    await writeState("quickparts", quickpartsState);
    const profile = resolveVendorSessionProfile("quickparts");
    const fake = fakeProbe(evidence("authenticated", "terminal_signals_ready"), undefined, evidence("error", "navigation_failed"));
    await expect(checkVendorSession(profile, stateDir, { probe: fake.probe, env: {} }))
      .resolves.toMatchObject({ state: "check_failed", reason: "anonymous_comparison_inconclusive" });
  });

  it("reports a landing page an anonymous visit also passes as unconfirmable, not valid", async () => {
    await writeState("quickparts", quickpartsState);
    const profile = resolveVendorSessionProfile("quickparts");
    const publicLanding = evidence("authenticated", "terminal_signals_ready");
    const fake = fakeProbe(publicLanding, undefined, publicLanding);
    await expect(checkVendorSession(profile, stateDir, { probe: fake.probe, env: {} }))
      .resolves.toMatchObject({ state: "check_failed", reason: "unconfirmable_public_landing", refreshedState: null });
    expect(fake.calls.map(isAnonymous)).toEqual([false, true]);

    const marker = fakeProbe(evidence("authenticated", "authenticated_marker_found"), undefined, publicLanding);
    await expect(checkVendorSession(profile, stateDir, { probe: marker.probe, env: {} })).resolves.toMatchObject({ state: "valid" });
    expect(marker.calls).toHaveLength(1);
  });
});

describe("worker session overrides", () => {
  it("notices when the worker would read a vendor's session from the environment instead", async () => {
    expect(workerSessionOverride("quickparts", {})).toBeNull();
    expect(workerSessionOverride("quickparts", { QUOTE_VENDOR_STORAGE_STATE_PATHS: JSON.stringify({ weerg: "/x" }) })).toBeNull();
    expect(workerSessionOverride("quickparts", { QUOTE_VENDOR_STORAGE_STATE_PATHS: JSON.stringify({ Quickparts: "/x" }) }))
      .toBe("QUOTE_VENDOR_STORAGE_STATE_PATHS");
    expect(workerSessionOverride("quickparts", { QUOTE_VENDOR_STORAGE_STATE_JSON: "not json" })).toBe("QUOTE_VENDOR_STORAGE_STATE_JSON");
    await writeState("quickparts", quickpartsState);
    const fake = fakeProbe(evidence("authenticated", "authenticated_marker_found"));
    await expect(checkVendorSession(resolveVendorSessionProfile("quickparts"), stateDir, {
      probe: fake.probe, env: { QUOTE_VENDOR_STORAGE_STATE_JSON: JSON.stringify({ quickparts: "{}" }) },
    })).resolves.toMatchObject({ state: "check_failed", reason: "worker_reads_session_from_env" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("scoped session save", () => {
  const profile = resolveVendorSessionProfile("quickparts");
  const PASSWORD = "fixture-password-SENTINEL";

  it("refuses an empty session, a session holding the typed password, and a symlinked directory", async () => {
    await expect(saveScopedSession(profile, stateDir, { cookies: [cookie("NID", ".google.com")], origins: [] }))
      .resolves.toEqual({ saved: false, reason: "scoped_session_empty" });
    const leaky = (value: string) => ({
      ...quickpartsState,
      origins: [{ origin: "https://quickquote.quickparts.com", localStorage: [{ name: "remember", value }] }],
    });
    for (const value of [PASSWORD, encodeURIComponent(`${PASSWORD}&`), Buffer.from(PASSWORD).toString("base64")]) {
      await expect(saveScopedSession(profile, stateDir, leaky(value), [PASSWORD])).resolves.toMatchObject({ saved: false });
    }
    const link = path.join(path.dirname(stateDir), `${path.basename(stateDir)}-link`);
    await fs.symlink(stateDir, link);
    try {
      await expect(saveScopedSession(profile, link, quickpartsState)).resolves.toEqual({ saved: false, reason: "state_dir_has_symlink" });
    } finally {
      await fs.rm(link, { force: true });
    }
    await expect(fs.readdir(stateDir)).resolves.toEqual([]);
  });

  it("writes a scoped session the kernel reads back from disk", async () => {
    await expect(saveScopedSession(profile, stateDir, quickpartsState, [PASSWORD])).resolves.toEqual({ saved: true });
    expect((await fs.stat(sessionStatePath(stateDir, "quickparts"))).mode & 0o777).toBe(0o600);
  });
});

describe("typed-password detection in saved state", () => {
  it("finds the password as stored and decoded, including quotes and backslashes JSON would escape", () => {
    const password = `pa"ss\\word+1 &x`;
    const state = (value: string) => ({ cookies: [], origins: [{ origin: "https://quickquote.quickparts.com", localStorage: [{ name: "k", value }] }] });
    for (const value of [
      password,
      encodeURIComponent(password),
      new URLSearchParams({ p: password }).toString(),
      Buffer.from(password).toString("base64"),
      // What a page writes with localStorage.setItem(key, JSON.stringify(...)): quotes and backslashes escaped.
      JSON.stringify({ password }),
      JSON.stringify({ form: { fields: [`prefix ${password} suffix`] } }),
      JSON.stringify({ nested: JSON.stringify({ password }) }),
      encodeURIComponent(JSON.stringify({ password })),
    ]) {
      expect(storageStateHoldsSecret(state(value), [password])).toBe(true);
    }
    expect(storageStateHoldsSecret(state("unrelated"), [password])).toBe(false);
    expect(storageStateHoldsSecret(state(password), [])).toBe(false);
  });
});

describe("session writer lock", () => {
  it("admits one writer per directory and takes over a lock whose holder is gone", async () => {
    const release = await acquireSessionLock(stateDir);
    await expect(acquireSessionLock(stateDir)).rejects.toThrow(/Another login:vendors or session:refresh/);
    await release();
    await expect(fs.stat(path.join(stateDir, ".vendor-session.lock"))).rejects.toThrow();

    await fs.writeFile(path.join(stateDir, ".vendor-session.lock"), "999999999\n");
    const takeover = await acquireSessionLock(stateDir);
    await takeover();
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
    expect(fake.calls).toHaveLength(1);
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

  it.each([
    "Approve the sign-in request on your phone to continue",
    "An error occurred. Please try again",
    "Loading… Please wait",
  ])("leaves storage unchanged for a logout page saying %s", async (bodyText) => {
    await writeState("quickparts", quickpartsState);
    const file = sessionStatePath(stateDir, "quickparts");
    const before = await fs.readFile(file, "utf8");
    const probe: SessionProbe = async (options) => {
      const verdict = await options.settledPageVerdict!({ url: profile.landingUrl, bodyText, passwordInputCount: 0 }, { logoutControl: true });
      if (verdict !== "signed_in") return evidence("error", "settled_page_indeterminate");
      await options.onAuthenticated?.({ ...quickpartsState, cookies: [cookie("rotated", "quickquote.quickparts.com")] });
      return evidence("authenticated", "authenticated_marker_found");
    };
    const result = await refreshVendorSession(profile, stateDir, { probe, env: {} });
    expect(result).toMatchObject({ state: "check_failed", reason: "settled_page_indeterminate", refreshed: false });
    expect(await fs.readFile(file, "utf8")).toBe(before);
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
