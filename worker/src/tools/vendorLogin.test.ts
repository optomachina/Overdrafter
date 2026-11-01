// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionProbeEvidence } from "../providerSessionProbe";
import { PROVIDER_KILL_SWITCH_STATE_SCHEMA } from "../providerSettings";
import { BitwardenError, SecretString } from "./vendorLoginBitwarden";
import type { LoginFlowResult } from "./vendorLoginFlow";

const flow = vi.hoisted(() => ({
  login: [] as LoginFlowResult[],
  confirm: [] as LoginFlowResult[],
}));

vi.mock("./vendorLoginFlow", () => ({
  runVendorLoginFlow: vi.fn(async () => flow.login.shift()),
  confirmStorageState: vi.fn(async () => flow.confirm.shift()),
}));

const {
  assertHumanOrLaunchdCaller,
  appendStatusLine,
  loginVendors,
  minimalChildEnv,
  notificationFor,
  parseLoginCliArgs,
  statusLine,
  statusReporter,
} = await import("./vendorLogin");
const { runVendorLoginFlow } = await import("./vendorLoginFlow");
const { sessionStatePath } = await import("./vendorSession");
type VendorLoginDeps = import("./vendorLogin").VendorLoginDeps;
type VendorLoginResult = import("./vendorLogin").VendorLoginResult;

const PASSWORD = "fixture-vendor-password-SENTINEL";
const USERNAME = "fixture-user@example.test";

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovd-vendor-login-")));
  flow.login.length = 0;
  flow.confirm.length = 0;
});

afterEach(async () => {
  vi.mocked(runVendorLoginFlow).mockClear();
  await fs.rm(stateDir, { recursive: true, force: true });
});

const cookie = (name: string, domain: string) => ({
  name, value: `${name}-value`, domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const,
});

const loggedInState = {
  cookies: [cookie("qp_session", "quickquote.quickparts.com"), cookie("NID", ".google.com")],
  origins: [],
};

function probeEvidence(outcome: SessionProbeEvidence["outcome"], reason: SessionProbeEvidence["reason"]): SessionProbeEvidence {
  return {
    provider: "quickparts", timestamp: "2026-10-22T00:00:00.000Z", outcome, reason,
    finalHost: "quickquote.quickparts.com", httpStatus: 200, navigations: 1, blockedRequests: 0,
  };
}

const authenticatedEvidence = () => probeEvidence("authenticated", "authenticated_marker_found");

function probeReturning(result: SessionProbeEvidence): VendorLoginDeps["sessionDeps"] {
  return {
    probe: async (options) => {
      if (result.outcome === "authenticated") await options.onAuthenticated?.(options.storageState);
      return result;
    },
  };
}

function fakeVault(options: { failOpen?: BitwardenError } = {}) {
  const vault = {
    open: vi.fn(async () => {
      if (options.failOpen) throw options.failOpen;
    }),
    loginItem: vi.fn(async () => ({ username: new SecretString(USERNAME), password: new SecretString(PASSWORD) })),
    close: vi.fn(async () => undefined),
  };
  return vault;
}

const fakeBrowser = () => ({
  newContext: vi.fn(async () => ({})),
  close: vi.fn(async () => undefined),
}) as unknown as Browser;

function deps(overrides: Partial<VendorLoginDeps> = {}): VendorLoginDeps & { reported: VendorLoginResult[] } {
  const reported: VendorLoginResult[] = [];
  return {
    config: {
      headless: true,
      bitwarden: { cliPath: "bw", unlock: "session-env" },
      vendors: { quickparts: { item: "fixture-quickparts-item" }, weerg: { item: "fixture-weerg-item" } },
    },
    stateDir,
    force: false,
    env: {},
    vault: fakeVault(),
    launchBrowser: async () => fakeBrowser(),
    sessionDeps: {
      probe: async (options) => {
        await options.onAuthenticated?.(options.storageState);
        return authenticatedEvidence();
      },
    },
    report: async (result) => {
      reported.push(result);
    },
    reported,
    ...overrides,
  };
}

const killSwitch = (engaged: boolean) => async (provider: string) => ({
  schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider, engaged, globalEngaged: false,
});

describe("caller tripwire", () => {
  it("allows Blaine's terminal and the shipped LaunchAgent only", () => {
    expect(() => assertHumanOrLaunchdCaller({}, true)).not.toThrow();
    expect(() => assertHumanOrLaunchdCaller({ OVD_VENDOR_LOGIN_LAUNCHD: "1", XPC_SERVICE_NAME: "com.overdrafter.vendor-login" }, false)).not.toThrow();
    expect(() => assertHumanOrLaunchdCaller({}, false)).toThrow(/interactive terminal/);
    expect(() => assertHumanOrLaunchdCaller({ OVD_VENDOR_LOGIN_LAUNCHD: "1", XPC_SERVICE_NAME: "other" }, false)).toThrow();
  });

  it("refuses agent runtimes and Playwright debug logging", () => {
    for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }, { CODEX_SANDBOX: "seatbelt" }, { AI_AGENT: "1" }]) {
      expect(() => assertHumanOrLaunchdCaller(env, true)).toThrow(/Agents run session:check/);
    }
    for (const env of [{ DEBUG: "*" }, { DEBUG: "pw*" }, { DEBUG_FILE: "/tmp/x" }, { NODE_DEBUG: "child_process" }, { NODE_OPTIONS: "--inspect=9229" }]) {
      expect(() => assertHumanOrLaunchdCaller(env, true)).toThrow(/diagnostics enabled/);
    }
    // User configuration a shell profile might export is not an agent marker.
    expect(() => assertHumanOrLaunchdCaller({ CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/x" }, true)).not.toThrow();
    expect(() => assertHumanOrLaunchdCaller({ DEBUG: "pw:api" }, true)).toThrow(/diagnostics enabled/);
    expect(() => assertHumanOrLaunchdCaller({ PWDEBUG: "1" }, true)).toThrow(/diagnostics enabled/);
  });

  it("hands browsers and the notifier neither the vault session nor worker secrets", () => {
    const env = minimalChildEnv({ PATH: "/bin", HOME: "/h", BW_SESSION: "s", SUPABASE_SERVICE_ROLE_KEY: "k", BITWARDENCLI_APPDATA_DIR: "/b" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("login:vendors orchestration", () => {
  it("logs in, saves only the reviewed hosts owner-only, and reports the GET-only check", async () => {
    flow.login.push({ outcome: "authenticated", storageState: loggedInState });
    flow.confirm.push({ outcome: "authenticated", storageState: loggedInState });
    const run = deps();
    const [result] = await loginVendors(["quickparts"], run);
    expect(result).toEqual({
      vendor: "quickparts", outcome: "saved", reason: "password_login_confirmed", host: null,
      killSwitch: "not_checked", check: "valid:authenticated_marker_found",
    });
    const filePath = sessionStatePath(stateDir, "quickparts");
    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(saved.cookies.map((entry: { name: string }) => entry.name)).toEqual(["qp_session"]);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(run.vault.open).toHaveBeenCalledTimes(1);
    expect(run.vault.loginItem).toHaveBeenCalledWith("fixture-quickparts-item", ["quickparts.com", "quickquote.quickparts.com"]);
    expect(run.vault.close).toHaveBeenCalledTimes(1);
    expect(run.reported).toEqual([result]);
  });

  it("refreshes a still-valid session without unlocking the vault or logging in", async () => {
    await fs.writeFile(sessionStatePath(stateDir, "quickparts"), JSON.stringify({ cookies: [cookie("qp_session", "quickquote.quickparts.com")], origins: [] }));
    const run = deps();
    const [result] = await loginVendors(["quickparts"], run);
    expect(result).toMatchObject({ outcome: "refreshed", check: "valid:authenticated_marker_found" });
    expect(run.vault.open).not.toHaveBeenCalled();
    expect(runVendorLoginFlow).not.toHaveBeenCalled();
  });

  it("logs in again with --force even when the session is valid", async () => {
    await fs.writeFile(sessionStatePath(stateDir, "quickparts"), JSON.stringify({ cookies: [cookie("qp_session", "quickquote.quickparts.com")], origins: [] }));
    flow.login.push({ outcome: "authenticated", storageState: loggedInState });
    flow.confirm.push({ outcome: "authenticated", storageState: loggedInState });
    const [result] = await loginVendors(["quickparts"], deps({ force: true }));
    expect(result.outcome).toBe("saved");
  });

  it("skips a vendor whose kill switch is engaged before any vault or browser work", async () => {
    const launchBrowser = vi.fn(async () => fakeBrowser());
    const run = deps({ killSwitchReader: killSwitch(true), launchBrowser });
    const [result] = await loginVendors(["quickparts"], run);
    expect(result).toMatchObject({ outcome: "skipped_kill_switch", killSwitch: "engaged_or_unreadable" });
    expect(run.vault.open).not.toHaveBeenCalled();
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("stops a vendor at a CAPTCHA, a second factor, an unknown page or a failed login, without saving or retrying", async () => {
    const stops: LoginFlowResult[] = [
      { outcome: "captcha", reason: "visible_challenge", host: "quickquote.quickparts.com" },
      { outcome: "two_factor", reason: "second_factor_prompt", host: "quickquote.quickparts.com" },
      { outcome: "unknown_page", reason: "off_host_navigation", host: "sso.example.test" },
      { outcome: "login_failed", reason: "credentials_rejected", host: "quickquote.quickparts.com" },
    ];
    for (const stop of stops) {
      flow.login.push(stop);
      vi.mocked(runVendorLoginFlow).mockClear();
      const [result] = await loginVendors(["quickparts"], deps());
      expect(result).toMatchObject({ outcome: "stopped", reason: `${stop.outcome}:${stop.reason}`, host: stop.host });
      expect(runVendorLoginFlow).toHaveBeenCalledTimes(1);
      await expect(fs.stat(sessionStatePath(stateDir, "quickparts"))).rejects.toThrow();
    }
  });

  it("stops instead of logging in when the session check meets a challenge or fails", async () => {
    await fs.writeFile(sessionStatePath(stateDir, "quickparts"), JSON.stringify({ cookies: [cookie("qp_session", "quickquote.quickparts.com")], origins: [] }));
    const run = deps({ sessionDeps: probeReturning(probeEvidence("blocked", "challenge_page")) });
    const [result] = await loginVendors(["quickparts"], run);
    expect(result).toMatchObject({ outcome: "stopped", reason: "session_check_failed:challenge_page" });
    expect(run.vault.open).not.toHaveBeenCalled();
    expect(runVendorLoginFlow).not.toHaveBeenCalled();
  });

  it("stops instead of logging in when the saved session lands on an error or second-factor page", async () => {
    await fs.writeFile(sessionStatePath(stateDir, "quickparts"), JSON.stringify({ cookies: [cookie("qp_session", "quickquote.quickparts.com")], origins: [] }));
    const run = deps({ sessionDeps: probeReturning(probeEvidence("error", "settled_page_indeterminate")) });
    const [result] = await loginVendors(["quickparts"], run);
    expect(result).toMatchObject({ outcome: "stopped", reason: "session_check_failed:settled_page_indeterminate" });
    expect(run.vault.open).not.toHaveBeenCalled();
  });

  it("logs in again for a signed-out session", async () => {
    await fs.writeFile(sessionStatePath(stateDir, "quickparts"), JSON.stringify({ cookies: [cookie("qp_session", "quickquote.quickparts.com")], origins: [] }));
    flow.login.push({ outcome: "authenticated", storageState: loggedInState });
    flow.confirm.push({ outcome: "authenticated", storageState: loggedInState });
    let calls = 0;
    const run = deps({
      sessionDeps: {
        probe: async (options) => {
          calls += 1;
          if (calls === 1) return probeEvidence("logged_out", "login_form");
          await options.onAuthenticated?.(options.storageState);
          return authenticatedEvidence();
        },
      },
    });
    const [result] = await loginVendors(["quickparts"], run);
    expect(result).toMatchObject({ outcome: "saved", check: "valid:authenticated_marker_found" });
  });

  it("reports a save its own GET-only check cannot confirm as saved_unconfirmed", async () => {
    flow.login.push({ outcome: "authenticated", storageState: loggedInState });
    flow.confirm.push({ outcome: "authenticated", storageState: loggedInState });
    const [result] = await loginVendors(["quickparts"], deps({ sessionDeps: probeReturning(probeEvidence("logged_out", "no_authenticated_marker")) }));
    expect(result).toMatchObject({
      outcome: "saved_unconfirmed", reason: "session_check_not_valid", check: "login_required:no_authenticated_marker",
    });
    expect(notificationFor(result, "Quickparts")).toMatch(/session:check reports login_required:no_authenticated_marker/);
  });

  it("refuses to save a session holding the typed password, or one with nothing left after scoping", async () => {
    const leaky = {
      cookies: loggedInState.cookies,
      origins: [{ origin: "https://quickquote.quickparts.com", localStorage: [{ name: "remember", value: PASSWORD }] }],
    };
    flow.login.push({ outcome: "authenticated", storageState: leaky });
    flow.confirm.push({ outcome: "authenticated", storageState: leaky });
    const [leaked] = await loginVendors(["quickparts"], deps());
    expect(leaked).toMatchObject({ outcome: "stopped", reason: "not_saved:session_contains_credential" });
    await expect(fs.stat(sessionStatePath(stateDir, "quickparts"))).rejects.toThrow();

    flow.login.push({ outcome: "authenticated", storageState: { cookies: [cookie("NID", ".google.com")], origins: [] } });
    const [empty] = await loginVendors(["quickparts"], deps());
    expect(empty).toMatchObject({ outcome: "stopped", reason: "login_failed:scoped_session_empty" });
  });

  it("stops a vendor whose session the worker reads from the environment", async () => {
    const run = deps({ env: { QUOTE_VENDOR_STORAGE_STATE_PATHS: JSON.stringify({ quickparts: "/elsewhere.json" }) }, force: true });
    const [result] = await loginVendors(["quickparts"], run);
    expect(result).toMatchObject({ outcome: "stopped", reason: "worker_reads_session_from_env" });
    expect(run.vault.open).not.toHaveBeenCalled();
  });

  it("keeps going when a status write fails", async () => {
    const run = deps({ report: async () => { throw new Error("disk full"); } });
    const results = await loginVendors(["geomiq", "weerg"], { ...run, config: { ...run.config, vendors: {} } });
    expect(results.map((result) => result.reason)).toEqual(["config_missing_item", "config_missing_item"]);
  });

  it("does not save when the scoped session fails the fresh-context confirmation", async () => {
    flow.login.push({ outcome: "authenticated", storageState: loggedInState });
    flow.confirm.push({ outcome: "login_failed", reason: "landing_still_requires_login", host: "quickquote.quickparts.com" });
    const [result] = await loginVendors(["quickparts"], deps());
    expect(result).toMatchObject({ outcome: "stopped", reason: "login_failed:landing_still_requires_login" });
    await expect(fs.stat(sessionStatePath(stateDir, "quickparts"))).rejects.toThrow();
  });

  it("unlocks the vault at most once and stops every vendor that needs it when unlock fails", async () => {
    const vault = fakeVault({ failOpen: new BitwardenError("vault_locked") });
    const results = await loginVendors(["quickparts", "weerg"], deps({ vault }));
    expect(results.map((result) => result.reason)).toEqual(["credential_vault_locked", "credential_vault_locked"]);
    expect(vault.open).toHaveBeenCalledTimes(1);
    expect(vault.close).toHaveBeenCalledTimes(1);
  });

  it("stops a vendor with no Bitwarden item in the config", async () => {
    const run = deps();
    const [result] = await loginVendors(["geomiq"], run);
    expect(result).toMatchObject({ outcome: "stopped", reason: "config_missing_item" });
    expect(run.vault.open).not.toHaveBeenCalled();
  });
});

describe("status line and notification", () => {
  const result: VendorLoginResult = {
    vendor: "quickparts", outcome: "stopped", reason: "captcha:visible_challenge", host: "quickquote.quickparts.com",
    killSwitch: "not_checked", check: null,
  };

  it("tightens an older world-readable log and refuses a symlinked one", async () => {
    const logPath = path.join(stateDir, "logs", "vendor-login.log");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, "older line\n", { mode: 0o644 });
    await fs.chmod(logPath, 0o644);
    await appendStatusLine(logPath, "new line");
    expect((await fs.stat(logPath)).mode & 0o777).toBe(0o600);

    const target = path.join(stateDir, "elsewhere.log");
    await fs.writeFile(target, "");
    const link = path.join(stateDir, "logs", "linked.log");
    await fs.symlink(target, link);
    await expect(appendStatusLine(link, "line")).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("");
  });

  it("writes one scrubbed line per vendor to an owner-only log", async () => {
    const line = statusLine(result, new Date("2026-10-22T06:30:00.000Z"));
    expect(line).toBe("2026-10-22T06:30:00.000Z vendor=quickparts outcome=stopped reason=captcha:visible_challenge host=quickquote.quickparts.com kill_switch=not_checked check=-");
    const logPath = path.join(stateDir, "logs", "vendor-login.log");
    await appendStatusLine(logPath, line);
    await appendStatusLine(logPath, line);
    expect((await fs.readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await fs.stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("redacts anything outside the fixed vocabulary", () => {
    const line = statusLine({ ...result, reason: `password=${PASSWORD} ok`, host: "a b" }, new Date(0));
    expect(line).not.toContain(PASSWORD);
    expect(line).toContain("reason=redacted host=redacted");
  });

  it("still notifies when the status log cannot be written", async () => {
    const notices: string[] = [];
    const link = path.join(stateDir, "linked.log");
    await fs.symlink(path.join(stateDir, "elsewhere.log"), link);
    const report = statusReporter(link, async (message) => {
      notices.push(message);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await report(result);
    await report({ ...result, outcome: "refreshed", reason: "authenticated_marker_found" });
    expect(notices).toEqual([
      "Quickparts login stopped (captcha:visible_challenge). Log in by hand with auth:vendor quickparts. The status log could not be written.",
      "quickparts: refreshed. The status log could not be written.",
    ]);
  });

  it("notifies only for a stopped vendor, naming the hand fallback", () => {
    expect(notificationFor(result, "Quickparts")).toBe("Quickparts login stopped (captcha:visible_challenge). Log in by hand with auth:vendor quickparts.");
    expect(notificationFor({ ...result, outcome: "saved" }, "Quickparts")).toBeNull();
    expect(notificationFor({ ...result, outcome: "skipped_kill_switch" }, "Quickparts")).toBeNull();
  });
});

describe("login CLI arguments", () => {
  it("parses vendors and flags", () => {
    expect(parseLoginCliArgs(["quickparts,geomiq,weerg", "--headed", "--force"])).toEqual({
      vendors: ["quickparts", "geomiq", "weerg"], force: true, headed: true, configPath: null, stateDir: null,
    });
    expect(parseLoginCliArgs([])).toMatchObject({ vendors: null });
    expect(() => parseLoginCliArgs(["oshcut"])).toThrow(/OVD-1022/);
    expect(() => parseLoginCliArgs(["--config"])).toThrow(/needs a value/);
  });
});
