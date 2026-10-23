import "dotenv/config";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { chromiumSandboxLaunchOptions } from "../chromiumLaunchOptions.js";
import type { ProviderKillSwitchReader } from "../providerSettings.js";
import { BitwardenError, BitwardenVault, type LoginCredential } from "./vendorLoginBitwarden.js";
import {
  readVendorLoginConfig,
  resolveLogPath,
  resolveStateDir,
  type VendorLoginConfig,
} from "./vendorLoginConfig.js";
import { confirmStorageState, runVendorLoginFlow, type LoginFlowResult, type LoginFlowTimings } from "./vendorLoginFlow.js";
import { scopeStorageStateToHosts } from "./vendorAuth.js";
import {
  checkVendorSession,
  kernelOpensStorageState,
  parseVendorList,
  probeStorageState,
  resolveVendorSessionProfile,
  sandboxFromEnv,
  saveScopedSession,
  vendorKillSwitchDecision,
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
 * again), then one password login. A CAPTCHA, a second factor, an unknown
 * page or a failed login stops that vendor, raises a macOS notification and
 * writes one scrubbed status line to a log outside the repository.
 */

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const LAUNCHD_LABEL = "com.overdrafter.vendor-login";

export type VendorLoginOutcome = "saved" | "refreshed" | "skipped_kill_switch" | "stopped";

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
  const marker = AGENT_ENV_MARKERS.find((name) => env[name]);
  if (marker) {
    throw new Error("login:vendors runs only from Blaine's terminal or LaunchAgent. Agents run session:check and ask Blaine to log in.");
  }
  const launchd = env.OVD_VENDOR_LOGIN_LAUNCHD === "1" && env.XPC_SERVICE_NAME === LAUNCHD_LABEL;
  if (!stdinIsTTY && !launchd) {
    throw new Error("login:vendors needs an interactive terminal or the com.overdrafter.vendor-login LaunchAgent.");
  }
  // Playwright debug logging could echo filled values.
  if (/pw:/.test(env.DEBUG ?? "") || env.PWDEBUG) {
    throw new Error("Refusing to run with Playwright debug logging (DEBUG=pw:* or PWDEBUG) enabled.");
  }
}

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

  if (!deps.force) {
    const current = await checkVendorSession(profile, deps.stateDir, deps.sessionDeps);
    if (current.state === "valid" && current.refreshedState) {
      return await saveScopedSession(profile, deps.stateDir, current.refreshedState)
        ? { vendor, outcome: "refreshed", reason: current.reason, host: null, killSwitch, check: `valid:${current.reason}` }
        : stopped(vendor, "refreshed_state_refused_by_kernel", killSwitch);
    }
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

  const saved: StorageState = login.storageState;
  if (!(await saveScopedSession(profile, deps.stateDir, saved))) {
    return stopped(vendor, "login_failed:scoped_session_refused_by_kernel", killSwitch);
  }
  // The agent-facing GET-only check, run once so a vendor it cannot confirm is visible on the first run.
  // Its visit may rotate session tokens, so a valid verdict's state replaces the file just written.
  const verdict = await probeStorageState(profile, scopeStorageStateToHosts(saved, profile.sessionHosts), deps.sessionDeps);
  if (verdict.state === "valid" && verdict.refreshedState) {
    await saveScopedSession(profile, deps.stateDir, verdict.refreshedState);
  }
  return { vendor, outcome: "saved", reason: "password_login_confirmed", host: null, killSwitch, check: `${verdict.state}:${verdict.reason}` };
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
      await deps.report(result);
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

export async function appendStatusLine(logPath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

function appleScriptString(value: string): string {
  return `"${value.replace(/[\\"]/g, (match) => `\\${match}`).replace(/[\r\n]+/g, " ")}"`;
}

export type Notifier = (message: string) => Promise<void>;

/** macOS notification through osascript (no shell); a failure to notify never fails the run. */
export const osascriptNotifier: Notifier = (message) => new Promise((resolve) => {
  const script = `display notification ${appleScriptString(message)} with title "OverDrafter vendor login"`;
  execFile("/usr/bin/osascript", ["-e", script], { timeout: 10_000, shell: false }, () => resolve());
});

export function notificationFor(result: VendorLoginResult, displayName: string): string | null {
  if (result.outcome !== "stopped") return null;
  return `${displayName} login stopped (${token(result.reason)}). Log in by hand with auth:vendor ${result.vendor}.`;
}

/** Holds a per-machine lock so a manual run and the LaunchAgent never log in at once. */
async function acquireRunLock(lockPath: string, staleMs = 30 * 60_000): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return () => fs.rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stats = await fs.stat(lockPath).catch(() => null);
      if (attempt === 0 && stats && Date.now() - stats.mtimeMs > staleMs) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
    }
  }
  throw new Error("Another login:vendors run holds the lock.");
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
  const release = await acquireRunLock(path.join(path.dirname(logPath), "vendor-login.lock"));
  const headless = args.headed ? false : config.headless;
  try {
    const results = await loginVendors(vendors, {
      config,
      stateDir,
      force: args.force,
      env: process.env,
      vault: new BitwardenVault(config.bitwarden, process.env),
      launchBrowser: () => chromium.launch({ headless, ...chromiumSandboxLaunchOptions(sandboxFromEnv()) }),
      report: async (result) => {
        const line = statusLine(result, new Date());
        console.log(line);
        await appendStatusLine(logPath, line);
        const message = notificationFor(result, resolveVendorSessionProfile(result.vendor).displayName);
        if (message) await osascriptNotifier(message);
      },
    });
    process.exitCode = results.some((result) => result.outcome === "stopped") ? 1 : 0;
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
