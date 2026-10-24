import "dotenv/config";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { chromiumSandboxLaunchOptions } from "../chromiumLaunchOptions.js";
import type { ProviderKillSwitchReader } from "../providerSettings.js";
import { BitwardenError, BitwardenVault, minimalChildEnv, type LoginCredential } from "./vendorLoginBitwarden.js";
import {
  readVendorLoginConfig,
  resolveLogPath,
  resolveStateDir,
  type VendorLoginConfig,
} from "./vendorLoginConfig.js";
import { confirmStorageState, runVendorLoginFlow, type LoginFlowResult, type LoginFlowTimings } from "./vendorLoginFlow.js";
import { scopeStorageStateToHosts } from "./vendorAuth.js";
import {
  acquireSessionLock,
  checkVendorSession,
  kernelOpensStorageState,
  parseVendorList,
  probeStorageState,
  refuseDiagnostics,
  resolveVendorSessionProfile,
  sandboxFromEnv,
  saveScopedSession,
  sessionStatePath,
  vendorKillSwitchDecision,
  workerSessionOverride,
  type KillSwitchDecision,
  type UnattendedLoginVendor,
  type VendorSessionDeps,
  type VendorSessionProfile,
} from "./vendorSession.js";

/**
 * OVD-1060 `login:vendors`: logs in to vendor portals from Bitwarden so Blaine
 * stops being the manual login step.
 *
 * Only Blaine's own terminal or his LaunchAgent runs this. Agents never do:
 * they run `session:check` / `session:refresh` and batch re-login requests
 * to Blaine. The caller check below is a tripwire against an accidental
 * agent run, not a security boundary.
 *
 * Per vendor: kill switch (when credentials to read it exist), then the
 * GET-only session check (a still-valid session is refreshed, not logged in
 * again; a challenge or failed check stops the vendor), then one password
 * login. A CAPTCHA, a second factor, an unknown page or a failed login stops
 * that vendor, raises a macOS notification and writes one scrubbed status
 * line to a log outside the repository. A saved session that the GET-only
 * check cannot confirm is reported as `saved_unconfirmed` and notified too.
 */

export const LAUNCHD_LABEL = "com.overdrafter.vendor-login";

export type VendorLoginOutcome = "saved" | "saved_unconfirmed" | "refreshed" | "skipped_kill_switch" | "stopped";

export type VendorLoginResult = {
  vendor: UnattendedLoginVendor;
  outcome: VendorLoginOutcome;
  /** Fixed vocabulary; never page, vault or account text. */
  reason: string;
  host: string | null;
  killSwitch: KillSwitchDecision;
  /** The GET-only session check's verdict after a save, as `state:reason`. */
  check: string | null;
};

export type VendorVault = Pick<BitwardenVault, "open" | "loginItem" | "close">;

export type VendorLoginDeps = {
  config: VendorLoginConfig;
  stateDir: string;
  force: boolean;
  env: NodeJS.ProcessEnv;
  vault: VendorVault;
  launchBrowser: () => Promise<Browser>;
  /** Test seam: installs synthetic routes before any navigation. */
  prepareContext?: (context: BrowserContext) => Promise<void>;
  sessionDeps?: VendorSessionDeps;
  killSwitchReader?: ProviderKillSwitchReader;
  timings?: Partial<LoginFlowTimings>;
  report: (result: VendorLoginResult) => Promise<void>;
};

/** Variables agent runtimes set for the processes they spawn (not user configuration a shell profile might export). */
const AGENT_ENV_MARKERS = [
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "CURSOR_AGENT",
];

/**
 * Allows Blaine's interactive terminal or the LaunchAgent this tool ships.
 * Refuses any environment an agent runtime marks as its own.
 */
export function assertHumanOrLaunchdCaller(env: NodeJS.ProcessEnv, stdinIsTTY: boolean): void {
  if (AGENT_ENV_MARKERS.some((name) => env[name])) {
    throw new Error("login:vendors runs only from Blaine's terminal or LaunchAgent. Agents run session:check and ask Blaine to log in.");
  }
  const launchd = env.OVD_VENDOR_LOGIN_LAUNCHD === "1" && env.XPC_SERVICE_NAME === LAUNCHD_LABEL;
  if (!stdinIsTTY && !launchd) {
    throw new Error("login:vendors needs an interactive terminal or the com.overdrafter.vendor-login LaunchAgent.");
  }
  refuseDiagnostics(env);
}

export { minimalChildEnv };

function stopped(
  vendor: UnattendedLoginVendor,
  reason: string,
  killSwitch: KillSwitchDecision,
  host: string | null = null,
): VendorLoginResult {
  return { vendor, outcome: "stopped", reason, host, killSwitch, check: null };
}

async function withBrowserContext<T>(
  deps: VendorLoginDeps,
  options: Parameters<Browser["newContext"]>[0],
  run: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const browser = await deps.launchBrowser();
  try {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ...options });
    await deps.prepareContext?.(context);
    return await run(context);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** One password login, then a fresh-context confirmation that holds only the scoped session. */
async function passwordLogin(
  profile: VendorSessionProfile,
  credential: LoginCredential,
  deps: VendorLoginDeps,
): Promise<LoginFlowResult> {
  let login: LoginFlowResult;
  try {
    login = await withBrowserContext(deps, {}, (context) => runVendorLoginFlow({
      profile, credential, context, timings: deps.timings,
    }));
  } catch {
    return { outcome: "unknown_page", reason: "browser_launch_failed", host: null };
  }
  if (login.outcome !== "authenticated") return login;
  const scoped = scopeStorageStateToHosts(login.storageState, profile.sessionHosts);
  if (scoped.cookies.length === 0 && scoped.origins.length === 0) {
    return { outcome: "login_failed", reason: "scoped_session_empty", host: null };
  }
  const opened = await kernelOpensStorageState(profile, { state: scoped });
  if (!opened) return { outcome: "login_failed", reason: "scoped_session_refused_by_kernel", host: null };
  try {
    return await withBrowserContext(deps, { storageState: opened }, (context) => confirmStorageState({
      profile, context, timings: deps.timings,
    }));
  } catch {
    return { outcome: "unknown_page", reason: "browser_launch_failed", host: null };
  }
}

export async function loginVendor(
  vendor: UnattendedLoginVendor,
  deps: VendorLoginDeps,
  openVault: () => Promise<void>,
): Promise<VendorLoginResult> {
  const profile = resolveVendorSessionProfile(vendor);
  const killSwitch = await vendorKillSwitchDecision(vendor, deps.env, deps.killSwitchReader);
  if (killSwitch === "engaged_or_unreadable") {
    return { vendor, outcome: "skipped_kill_switch", reason: "kill_switch_engaged_or_unreadable", host: null, killSwitch, check: null };
  }

  if (workerSessionOverride(vendor, deps.env)) return stopped(vendor, "worker_reads_session_from_env", killSwitch);

  if (!deps.force) {
    const settled = await refreshOrStop(profile, deps, killSwitch);
    if (settled) return settled;
  }

  const item = deps.config.vendors[vendor]?.item;
  if (!item) return stopped(vendor, "config_missing_item", killSwitch);
  let credential: LoginCredential;
  try {
    await openVault();
    credential = await deps.vault.loginItem(item, profile.sessionHosts);
  } catch (error) {
    return stopped(vendor, `credential_${error instanceof BitwardenError ? error.code : "unavailable"}`, killSwitch);
  }

  const login = await passwordLogin(profile, credential, deps);
  if (login.outcome !== "authenticated") return stopped(vendor, `${login.outcome}:${login.reason}`, killSwitch, login.host);

  return saveAndVerify(profile, deps, killSwitch, login.storageState, [credential.password.reveal()]);
}

/**
 * The GET-only session check before a password is spent: a valid session is
 * refreshed (result returned), a failed check stops the vendor (result
 * returned), and a missing, unusable or signed-out session returns null so
 * the caller logs in.
 */
async function refreshOrStop(
  profile: VendorSessionProfile,
  deps: VendorLoginDeps,
  killSwitch: KillSwitchDecision,
): Promise<VendorLoginResult | null> {
  const vendor = profile.vendor;
  const current = await checkVendorSession(profile, deps.stateDir, { ...deps.sessionDeps, env: deps.env });
  if (current.state === "valid") {
    const refreshed = current.refreshedState
      ? await saveScopedSession(profile, deps.stateDir, current.refreshedState)
      : { saved: false as const, reason: "refreshed_state_missing" };
    return refreshed.saved
      ? { vendor, outcome: "refreshed", reason: current.reason, host: null, killSwitch, check: `valid:${current.reason}` }
      : stopped(vendor, `refresh_not_saved:${refreshed.reason}`, killSwitch);
  }
  // A challenge, denial or failed check is a stop, not a reason to try logging in.
  if (current.state === "check_failed") return stopped(vendor, `session_check_failed:${current.reason}`, killSwitch);
  return null;
}

/**
 * Saves a confirmed login, then runs the agent-facing GET-only check: a login
 * it cannot confirm is not reported as a plain save. Its visit may rotate
 * session tokens, so a valid verdict's state replaces the file just written.
 */
async function saveAndVerify(
  profile: VendorSessionProfile,
  deps: VendorLoginDeps,
  killSwitch: KillSwitchDecision,
  state: Parameters<typeof saveScopedSession>[2],
  forbidden: readonly string[],
): Promise<VendorLoginResult> {
  const vendor = profile.vendor;
  const saved = await saveScopedSession(profile, deps.stateDir, state, forbidden);
  if (!saved.saved) return stopped(vendor, `not_saved:${saved.reason}`, killSwitch);
  const opened = await kernelOpensStorageState(profile, { path: sessionStatePath(deps.stateDir, vendor) });
  const verdict = opened
    ? await probeStorageState(profile, opened, { ...deps.sessionDeps, env: deps.env })
    : { state: "unopenable_by_kernel" as const, reason: "kernel_refused_session", refreshedState: null };
  const check = `${verdict.state}:${verdict.reason}`;
  if (verdict.state !== "valid") {
    return { vendor, outcome: "saved_unconfirmed", reason: "session_check_not_valid", host: null, killSwitch, check };
  }
  if (verdict.refreshedState) {
    const resaved = await saveScopedSession(profile, deps.stateDir, verdict.refreshedState, forbidden);
    if (!resaved.saved) {
      return { vendor, outcome: "saved_unconfirmed", reason: `refresh_not_saved:${resaved.reason}`, host: null, killSwitch, check };
    }
  }
  return { vendor, outcome: "saved", reason: "password_login_confirmed", host: null, killSwitch, check };
}

/** Runs vendors in order; the vault is unlocked at most once, only when a password login is needed. */
export async function loginVendors(vendors: readonly UnattendedLoginVendor[], deps: VendorLoginDeps): Promise<VendorLoginResult[]> {
  let vaultOpen: Promise<void> | null = null;
  const openVault = () => {
    vaultOpen ??= deps.vault.open();
    return vaultOpen;
  };
  const results: VendorLoginResult[] = [];
  try {
    for (const vendor of vendors) {
      let result: VendorLoginResult;
      try {
        result = await loginVendor(vendor, deps, openVault);
      } catch {
        result = stopped(vendor, "unexpected_failure", "not_checked");
      }
      results.push(result);
      // A failed status write must not stop the remaining vendors.
      await deps.report(result).catch(() => undefined);
    }
  } finally {
    if (vaultOpen) await deps.vault.close().catch(() => undefined);
  }
  return results;
}

const SAFE_TOKEN = /^[a-z0-9_.:-]{1,120}$/i;

function token(value: string | null): string {
  if (value === null) return "-";
  return SAFE_TOKEN.test(value) ? value : "redacted";
}

/** One scrubbed status line: fixed vocabulary and host names only. */
export function statusLine(result: VendorLoginResult, now: Date): string {
  return [
    now.toISOString(),
    `vendor=${result.vendor}`,
    `outcome=${result.outcome}`,
    `reason=${token(result.reason)}`,
    `host=${token(result.host)}`,
    `kill_switch=${result.killSwitch}`,
    `check=${token(result.check)}`,
  ].join(" ");
}

/**
 * Appends through a descriptor opened without following a symlink, then
 * forces owner-only permissions on it, so an older 0644 log or a planted
 * link never receives a status line.
 */
export async function appendStatusLine(logPath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(logPath, flags, 0o600);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
      throw new Error("The vendor login log is not a regular file owned by this user.");
    }
    await handle.chmod(0o600);
    await handle.appendFile(`${line}\n`, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function appleScriptString(value: string): string {
  return `"${value.replace(/[\\"]/g, (match) => `\\${match}`).replace(/[\r\n]+/g, " ")}"`;
}

export type Notifier = (message: string) => Promise<void>;

/** macOS notification through osascript (no shell); a failure to notify never fails the run. */
export const osascriptNotifier: Notifier = (message) => new Promise((resolve) => {
  const script = `display notification ${appleScriptString(message)} with title "OverDrafter vendor login"`;
  execFile("/usr/bin/osascript", ["-e", script], { timeout: 10_000, shell: false, env: minimalChildEnv(process.env) }, () => resolve());
});

export function notificationFor(result: VendorLoginResult, displayName: string): string | null {
  if (result.outcome === "saved_unconfirmed") {
    return `${displayName} login saved, but session:check reports ${token(result.check)}. Agents will ask you to log in.`;
  }
  if (result.outcome !== "stopped") return null;
  return `${displayName} login stopped (${token(result.reason)}). Log in by hand with auth:vendor ${result.vendor}.`;
}

/**
 * Prints, logs and notifies one result. Logging and notifying are
 * independent: a failed log write still notifies, and says so.
 */
export function statusReporter(
  logPath: string,
  notify: Notifier,
  now: () => Date = () => new Date(),
): (result: VendorLoginResult) => Promise<void> {
  return async (result) => {
    const line = statusLine(result, now());
    console.log(line);
    const logged = await appendStatusLine(logPath, line).then(() => true, () => false);
    const message = notificationFor(result, resolveVendorSessionProfile(result.vendor).displayName);
    if (message || !logged) {
      const base = message ?? `${result.vendor}: ${result.outcome}.`;
      await notify(logged ? base : `${base} The status log could not be written.`);
    }
  };
}

type LoginCliArgs = {
  vendors: UnattendedLoginVendor[] | null;
  force: boolean;
  headed: boolean;
  configPath: string | null;
  stateDir: string | null;
};

const LOGIN_USAGE = [
  "Usage: npm --prefix worker run login:vendors -- [vendor,vendor] [--force] [--headed] [--config <path>] [--state-dir <dir>]",
  "",
  "Blaine's terminal or LaunchAgent only. Agents never run this; they run session:check.",
  "Without a vendor list, every vendor in the login config is used. A still-valid session is refreshed",
  "with GET requests instead of a new login unless --force is given.",
].join("\n");

export function parseLoginCliArgs(argv: readonly string[]): LoginCliArgs {
  const args: LoginCliArgs = { vendors: null, force: false, headed: false, configPath: null, stateDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--force") args.force = true;
    else if (value === "--headed") args.headed = true;
    else if (value === "--config" || value === "--state-dir") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} needs a value.\n\n${LOGIN_USAGE}`);
      if (value === "--config") args.configPath = path.resolve(next);
      else args.stateDir = path.resolve(next);
      index += 1;
    } else if (value === "--help" || value === "-h") throw new Error(LOGIN_USAGE);
    else if (!value.startsWith("--") && args.vendors === null) args.vendors = parseVendorList(value);
    else throw new Error(`Unexpected argument "${value}".\n\n${LOGIN_USAGE}`);
  }
  return args;
}

async function main() {
  assertHumanOrLaunchdCaller(process.env, process.stdin.isTTY === true);
  const args = parseLoginCliArgs(process.argv.slice(2));
  const config = await readVendorLoginConfig({ path: args.configPath });
  const vendors = args.vendors ?? parseVendorList(Object.keys(config.vendors).join(","));
  const stateDir = resolveStateDir({ flag: args.stateDir, env: process.env, config });
  const logPath = resolveLogPath(config);
  const release = await acquireSessionLock(stateDir);
  const headless = args.headed ? false : config.headless;
  // The vault keeps the exported session key; nothing launched later inherits it.
  const vault = new BitwardenVault(config.bitwarden, process.env);
  delete process.env.BW_SESSION;
  try {
    const results = await loginVendors(vendors, {
      config,
      stateDir,
      force: args.force,
      env: process.env,
      vault,
      launchBrowser: () => chromium.launch({
        headless,
        env: minimalChildEnv(process.env),
        ...chromiumSandboxLaunchOptions(sandboxFromEnv()),
      }),
      report: statusReporter(logPath, osascriptNotifier),
    });
    process.exitCode = results.some((result) => result.outcome === "stopped" || result.outcome === "saved_unconfirmed") ? 1 : 0;
  } finally {
    await release();
  }
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsScript) {
  try {
    await main();
  } catch (error) {
    // Setup errors are this tool's own text (usage, config, lock); never vault or page content.
    console.error(error instanceof Error ? error.message : String(error));
    if (process.env.OVD_VENDOR_LOGIN_LAUNCHD === "1") {
      await osascriptNotifier("login:vendors could not start. See the LaunchAgent log.");
    }
    process.exit(2);
  }
}
