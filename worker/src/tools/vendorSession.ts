import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "playwright";
import { getExtendedVendorWorkflow } from "../adapters/extendedVendorWorkflows.js";
import { buildGeomiqProductionPortalDefinition } from "../adapters/geomiqProductionPortal.js";
import { refuseOshcutPortalAutomation } from "../adapters/oshcutPortalDisabled.js";
import {
  effectiveOffHostAllowlist,
  isAllowedProviderUrl,
  resolveIsolatedProviderStorageState,
  type ProviderPortalDefinition,
  type ProviderPortalSnapshot,
  type ProviderPortalState,
} from "../adapters/providerPortalKernel.js";
import { buildQuickpartsProductionPortalDefinition } from "../adapters/quickpartsPortal.js";
import { buildWeergProductionPortalDefinition } from "../adapters/weergPortal.js";
import {
  runBoundedBrowserSessionProbe,
  type BrowserProbeOptions,
  type SessionProbeEvidence,
  type SettledPageVerdict,
} from "../providerSessionProbe.js";
import type { ProviderKillSwitchReader } from "../providerSettings.js";
import { assertOperatorProvidersEnabled, envProviderKillSwitchReader } from "./operatorKillSwitchGate.js";
import { writePrivateStorageState } from "./privateStorageState.js";
import { scopeStorageStateToHosts, sessionHostsFor } from "./vendorAuth.js";
import { minimalChildEnv } from "./vendorLoginBitwarden.js";
import { readVendorLoginConfig, resolveStateDir, type VendorLoginConfig } from "./vendorLoginConfig.js";

/**
 * OVD-1060: the session half of unattended vendor login. `session:check` and
 * `session:refresh` never read credentials, fill a form, click, or upload;
 * the bounded probe they share sends only GET and HEAD requests to the vendor.
 * Agents may run both. `login:vendors` (Blaine's terminal or LaunchAgent only) reuses
 * the same check to decide whether a password login is needed at all.
 */

/** Vendors with a reviewed production definition and exact session hosts. OSH Cut stays refused (OVD-1022). */
export const UNATTENDED_LOGIN_VENDORS = ["quickparts", "geomiq", "weerg"] as const;
export type UnattendedLoginVendor = (typeof UNATTENDED_LOGIN_VENDORS)[number];

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type VendorSessionProfile = {
  vendor: UnattendedLoginVendor;
  displayName: string;
  /** The workflow's login page. */
  loginUrl: string;
  /** The page the kernel opens first; a session is judged there. */
  landingUrl: string;
  /** Hosts a saved session may keep (OVD-1059). */
  sessionHosts: readonly string[];
  /** Hosts the GET-only probe may request: the definition's hosts plus its reviewed off-host allowlist. */
  probeHosts: readonly string[];
  definition: ProviderPortalDefinition;
};

const DEFINITIONS: Record<UnattendedLoginVendor, () => ProviderPortalDefinition> = {
  quickparts: buildQuickpartsProductionPortalDefinition,
  geomiq: buildGeomiqProductionPortalDefinition,
  weerg: buildWeergProductionPortalDefinition,
};

export function isUnattendedLoginVendor(vendor: string): vendor is UnattendedLoginVendor {
  return (UNATTENDED_LOGIN_VENDORS as readonly string[]).includes(vendor);
}

export function resolveVendorSessionProfile(vendor: string): VendorSessionProfile {
  if (vendor === "oshcut") refuseOshcutPortalAutomation();
  const workflow = getExtendedVendorWorkflow(vendor);
  if (!workflow || !isUnattendedLoginVendor(workflow.vendor)) {
    throw new Error(`Unsupported vendor "${vendor}". Expected one of: ${UNATTENDED_LOGIN_VENDORS.join(", ")}.`);
  }
  const definition = DEFINITIONS[workflow.vendor]();
  const sessionHosts = sessionHostsFor(workflow);
  const landingUrl = definition.routes.uploadUrl;
  if (!isAllowedProviderUrl(workflow.loginUrl, sessionHosts) || !isAllowedProviderUrl(landingUrl, sessionHosts)) {
    throw new Error(`${workflow.displayName} login or landing route is outside its reviewed session hosts.`);
  }
  return {
    vendor: workflow.vendor,
    displayName: workflow.displayName,
    loginUrl: workflow.loginUrl,
    landingUrl,
    sessionHosts,
    probeHosts: [...new Set([...definition.allowedHosts, ...effectiveOffHostAllowlist(definition)])],
    definition,
  };
}

/** The kernel's default session file name inside `QUOTE_VENDOR_STORAGE_STATE_DIR`. */
export function sessionStatePath(stateDir: string, vendor: UnattendedLoginVendor): string {
  return path.join(stateDir, `${vendor}-storage-state.json`);
}

/**
 * Portal states that mean the kernel would stop before quoting because of
 * the session or the portal itself. Anything else (ready, selector drift,
 * configuration or review prompts) is a page the session reached signed in.
 */
const SESSION_BLOCKING_STATES: ReadonlySet<ProviderPortalState> = new Set([
  "login_required",
  "missing_session",
  "captcha",
  "unexpected_origin",
  "unavailable",
]);

export function sessionStateAccepted(state: ProviderPortalState): boolean {
  return !SESSION_BLOCKING_STATES.has(state);
}

/**
 * Text a settled signed-in page should not show. The kernel classifier calls
 * any page without a failure pattern ready, so a blank shell, a spinner, an
 * error page or an anonymous page with a sign-in link would otherwise pass.
 */
const NOT_SIGNED_IN_TEXT = [
  /\b(log ?in|sign ?in|sign ?up|register|create (an |your )?account|forgot (your )?password)\b/i,
  /\b(loading|please wait|something went wrong|error|not found|try again|oops|access denied|forbidden|session expired)\b/i,
  /\b(two[- ]factor|two[- ]step|verification code|authenticator|enter the code|security code|verify your (email|account)|approve (the |this )?(sign[- ]?in|log[- ]?in|request))\b/i,
];
const MIN_SIGNED_IN_TEXT = 40;

/**
 * Signed-in evidence from page content alone, used when a page has no log
 * out control: the vendor definition's classifier must accept the page, and
 * the page must have real content with no password field and no sign-in,
 * loading, error or second-factor text. Anything doubtful is a no.
 */
export async function signedInEvidence(
  snapshot: ProviderPortalSnapshot,
  definition: Pick<ProviderPortalDefinition, "hooks">,
): Promise<boolean> {
  if (!sessionStateAccepted(await definition.hooks.classifyPortalState(snapshot))) return false;
  if (snapshot.passwordInputCount > 0) return false;
  const text = snapshot.bodyText.replace(/\s+/g, " ").trim();
  if (text.replace(/\s/g, "").length < MIN_SIGNED_IN_TEXT) return false;
  return !NOT_SIGNED_IN_TEXT.some((pattern) => pattern.test(text));
}

const SIGNED_OUT_TEXT = /\b(log ?in|sign ?in|session expired)\b/i;
/** A second-factor prompt or an error page; either can carry a log out control. */
const STOP_TEXT = [
  NOT_SIGNED_IN_TEXT[1],
  NOT_SIGNED_IN_TEXT[2],
];

/**
 * The probe's verdict for a settled page: a second-factor or error page is
 * indeterminate even with a log out control. Otherwise a log out control is
 * signed in; without one, signed in only on `signedInEvidence`. Signed out
 * when the classifier or the page says so; anything else (an error, a
 * spinner, a second-factor or challenge page) is indeterminate, so it is
 * never mistaken for a session worth a password.
 */
export async function settledPageVerdict(
  snapshot: ProviderPortalSnapshot,
  definition: Pick<ProviderPortalDefinition, "hooks">,
  page: { logoutControl: boolean } = { logoutControl: false },
): Promise<SettledPageVerdict> {
  const state = await definition.hooks.classifyPortalState(snapshot);
  if (state === "login_required" || state === "missing_session") return "signed_out";
  if (!sessionStateAccepted(state)) return "indeterminate";
  if (STOP_TEXT.some((pattern) => pattern.test(snapshot.bodyText))) return "indeterminate";
  if (page.logoutControl) return "signed_in";
  if (await signedInEvidence(snapshot, definition)) return "signed_in";
  return SIGNED_OUT_TEXT.test(snapshot.bodyText) ? "signed_out" : "indeterminate";
}

export type VendorSessionState = "valid" | "login_required" | "missing" | "unopenable_by_kernel" | "check_failed";

export type VendorSessionCheck = {
  vendor: UnattendedLoginVendor;
  state: VendorSessionState;
  /** Fixed vocabulary: a probe reason or a local file reason. Never page text. */
  reason: string;
};

export type SessionProbe = (options: BrowserProbeOptions) => Promise<SessionProbeEvidence>;

export type VendorSessionDeps = {
  probe?: SessionProbe;
  /** Read for the diagnostics refusal; the process environment when absent. */
  env?: NodeJS.ProcessEnv;
  sandbox?: BrowserProbeOptions["sandbox"];
  /** Test seams for loopback fixtures; never set by the CLI. */
  probeOverrides?: Pick<BrowserProbeOptions, "allowLoopbackHttp" | "executablePath" | "settleMs" | "confirmMs" | "timeoutMs">;
};

/**
 * Playwright debug namespaces (including DEBUG=*) log protocol traffic in
 * this process, which carries restored cookies, local-storage tokens and
 * filled values; Node's child_process diagnostics echo child environments,
 * and an inspector can read memory. Sanitizing Chromium's environment does
 * not switch off logging in this process, so every command that opens a
 * session or a credential refuses to start with any of them set.
 */
export function refuseDiagnostics(env: NodeJS.ProcessEnv): void {
  const diagnostics = ["DEBUG", "DEBUG_FILE", "PWDEBUG", "NODE_DEBUG"].filter((name) => env[name]?.trim());
  if (/--inspect/.test(env.NODE_OPTIONS ?? "")) diagnostics.push("NODE_OPTIONS=--inspect");
  if (diagnostics.length > 0) {
    throw new Error(`Refusing to run with diagnostics enabled (${diagnostics.join(", ")}). Unset them first.`);
  }
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export function sandboxFromEnv(): BrowserProbeOptions["sandbox"] {
  return {
    playwrightDisableSandbox: envFlag("PLAYWRIGHT_DISABLE_SANDBOX", false),
    playwrightDisableDevShmUsage: envFlag("PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", true),
  };
}

/** Parses session bytes exactly as the kernel does; null means a live run could not open them. */
export async function kernelOpensStorageState(
  profile: VendorSessionProfile,
  source: { path: string } | { state: StorageState },
): Promise<StorageState | null> {
  const opened = await resolveIsolatedProviderStorageState(profile.definition, {
    vendorStorageStateDir: null,
    vendorStorageStatePaths: "path" in source ? { [profile.vendor]: source.path } : {},
    vendorStorageStateJson: "state" in source ? { [profile.vendor]: JSON.stringify(source.state) } : {},
  });
  return opened as StorageState | null;
}

function mapEvidence(vendor: UnattendedLoginVendor, evidence: SessionProbeEvidence): VendorSessionCheck {
  if (evidence.outcome === "authenticated") return { vendor, state: "valid", reason: evidence.reason };
  if (evidence.outcome === "logged_out") return { vendor, state: "login_required", reason: evidence.reason };
  return { vendor, state: "check_failed", reason: evidence.reason };
}

/**
 * Probes an in-memory session with GETs only and, when it is valid, hands
 * back the context's storage state so a caller can re-save a session the
 * provider may have rotated during the visit.
 */
export async function probeStorageState(
  profile: VendorSessionProfile,
  storageState: StorageState,
  deps: VendorSessionDeps = {},
): Promise<VendorSessionCheck & { refreshedState: StorageState | null }> {
  // Before the session reaches a browser: protocol logging would print it.
  refuseDiagnostics(deps.env ?? process.env);
  const probe = deps.probe ?? runBoundedBrowserSessionProbe;
  const run = async (state: StorageState) => {
    let captured: StorageState | null = null;
    const evidence = await probe({
      target: { provider: profile.vendor, adapterKind: "portal", landingUrl: profile.landingUrl, allowedHosts: profile.probeHosts },
      storageState: state as BrowserProbeOptions["storageState"],
      sandbox: deps.sandbox ?? sandboxFromEnv(),
      settledPageVerdict: (snapshot, page) => settledPageVerdict(snapshot, profile.definition, page),
      browserEnv: minimalChildEnv(process.env),
      onAuthenticated: (refreshed) => {
        captured = refreshed as unknown as StorageState;
      },
      ...deps.probeOverrides,
    });
    return { check: mapEvidence(profile.vendor, evidence), captured: captured as StorageState | null };
  };
  const result = await run(storageState);
  // Content-only evidence must also tell a session apart from no session at all:
  // the same visit without the session has to come back clearly signed out.
  if (result.check.state === "valid" && result.check.reason === "terminal_signals_ready") {
    const anonymous = await run({ cookies: [], origins: [] });
    if (anonymous.check.state !== "login_required") {
      const reason = anonymous.check.state === "valid" ? "unconfirmable_public_landing" : "anonymous_comparison_inconclusive";
      return { vendor: profile.vendor, state: "check_failed", reason, refreshedState: null };
    }
  }
  return { ...result.check, refreshedState: result.captured };
}

async function sessionFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const WORKER_SESSION_OVERRIDES = ["QUOTE_VENDOR_STORAGE_STATE_JSON", "QUOTE_VENDOR_STORAGE_STATE_PATHS"] as const;

/**
 * The worker reads a vendor's session from these variables before the state
 * directory. When one names the vendor (or cannot be parsed), a file in the
 * directory is not what a live run would use.
 */
export function workerSessionOverride(vendor: UnattendedLoginVendor, env: NodeJS.ProcessEnv): string | null {
  for (const name of WORKER_SESSION_OVERRIDES) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return name;
      if (Object.keys(parsed).some((key) => key.trim().toLowerCase() === vendor)) return name;
    } catch {
      return name;
    }
  }
  return null;
}

/** An override, then `missing`, then `unopenable_by_kernel`, then the GET-only probe's verdict. */
export async function checkVendorSession(
  profile: VendorSessionProfile,
  stateDir: string,
  deps: VendorSessionDeps = {},
): Promise<VendorSessionCheck & { refreshedState: StorageState | null }> {
  if (workerSessionOverride(profile.vendor, deps.env ?? process.env)) {
    return { vendor: profile.vendor, state: "check_failed", reason: "worker_reads_session_from_env", refreshedState: null };
  }
  const filePath = sessionStatePath(stateDir, profile.vendor);
  if (!(await sessionFileExists(filePath))) {
    return { vendor: profile.vendor, state: "missing", reason: "session_file_missing", refreshedState: null };
  }
  const opened = await kernelOpensStorageState(profile, { path: filePath });
  if (!opened) {
    return { vendor: profile.vendor, state: "unopenable_by_kernel", reason: "kernel_refused_session", refreshedState: null };
  }
  return probeStorageState(profile, opened, deps);
}

export type SaveResult = { saved: true } | { saved: false; reason: string };

/** The forms a typed secret could take in a cookie, a local-storage value, a JSON document or a URL. */
export function secretForms(value: string): string[] {
  return [
    value,
    // Inside a JSON string, as JSON.stringify writes quotes, backslashes and control characters.
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
    Buffer.from(value, "utf8").toString("base64"),
  ].filter((form) => form.length >= 4);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Every key and string inside a value that parses as JSON, however deeply nested; nothing for other text. */
function jsonStrings(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const found: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 32) return;
    if (typeof node === "string") {
      found.push(node);
      // A JSON document stored as a string inside another one.
      if (depth < 4) found.push(...jsonStrings(node));
    } else if (Array.isArray(node)) node.forEach((item) => walk(item, depth + 1));
    else if (node && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        found.push(key);
        walk(item, depth + 1);
      }
    }
  };
  walk(parsed, 0);
  return found;
}

/**
 * True when any cookie or local-storage name or value holds one of `secrets`,
 * read as stored, URL-decoded, and as the strings of a JSON value.
 */
export function storageStateHoldsSecret(state: StorageState, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const forms = secrets.flatMap(secretForms);
  const values = [
    ...state.cookies.flatMap((cookie) => [cookie.name, cookie.value]),
    ...state.origins.flatMap((origin) => origin.localStorage.flatMap((entry) => [entry.name, entry.value])),
  ];
  const readings = (value: string) => {
    const decoded = safeDecode(value);
    return [value, decoded, ...jsonStrings(value), ...(decoded === value ? [] : jsonStrings(decoded))];
  };
  return values.some((value) => readings(value).some((text) => forms.some((form) => text.includes(form))));
}

/**
 * Scopes a session to the reviewed hosts and writes it 0600 over the old
 * file, only when it is not empty, holds none of `forbiddenValues` (the typed
 * password), the kernel would parse it, and the directory has no symlinked
 * component. The written file is then read back through the kernel's own
 * path resolver.
 */
export async function saveScopedSession(
  profile: VendorSessionProfile,
  stateDir: string,
  state: StorageState,
  forbiddenValues: readonly string[] = [],
): Promise<SaveResult> {
  const scoped = scopeStorageStateToHosts(state, profile.sessionHosts);
  if (scoped.cookies.length === 0 && scoped.origins.length === 0) return { saved: false, reason: "scoped_session_empty" };
  if (storageStateHoldsSecret(scoped, forbiddenValues)) return { saved: false, reason: "session_contains_credential" };
  if (!(await kernelOpensStorageState(profile, { state: scoped }))) return { saved: false, reason: "scoped_session_refused_by_kernel" };
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(stateDir)) !== path.resolve(stateDir)) return { saved: false, reason: "state_dir_has_symlink" };
  const filePath = sessionStatePath(stateDir, profile.vendor);
  await writePrivateStorageState({ storageState: async () => scoped }, filePath);
  if (!(await kernelOpensStorageState(profile, { path: filePath }))) return { saved: false, reason: "saved_file_refused_by_kernel" };
  return { saved: true };
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One writer per session directory: `login:vendors` and `session:refresh`
 * both hold this lock while they may write, so neither overwrites a session
 * the other just saved. A lock whose holder process is gone is taken over.
 */
export async function acquireSessionLock(stateDir: string): Promise<() => Promise<void>> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, ".vendor-session.lock");
  const owner = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${owner}\n`);
      await handle.close();
      // A peer that recovered the same stale lock at the same moment may have replaced ours.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if ((await fs.readFile(lockPath, "utf8").catch(() => "")).trim() !== owner) break;
      return async () => {
        if ((await fs.readFile(lockPath, "utf8").catch(() => "")).trim() === owner) await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = (await fs.readFile(lockPath, "utf8").catch(() => "")).trim();
      const stats = await fs.stat(lockPath).catch(() => null);
      // A just-created lock may not hold its pid yet.
      const fresh = holder === "" && stats !== null && Date.now() - stats.mtimeMs < 5_000;
      if (attempt === 0 && !fresh && !processAlive(Number.parseInt(holder, 10))) {
        // Remove only the stale lock that was read, not one a peer has just written.
        if ((await fs.readFile(lockPath, "utf8").catch(() => "")).trim() === holder) await fs.rm(lockPath, { force: true });
        continue;
      }
    }
  }
  throw new Error("Another login:vendors or session:refresh run is writing sessions in this directory.");
}

export type KillSwitchDecision = "not_checked" | "disengaged" | "engaged_or_unreadable";

/**
 * Reads the provider kill switch only when service-role credentials exist.
 * With them, an engaged switch or a failed read skips the vendor.
 */
export async function vendorKillSwitchDecision(
  vendor: UnattendedLoginVendor,
  env: NodeJS.ProcessEnv = process.env,
  reader?: ProviderKillSwitchReader,
): Promise<KillSwitchDecision> {
  if (!reader && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) return "not_checked";
  try {
    await assertOperatorProvidersEnabled([vendor], reader ?? envProviderKillSwitchReader(env));
    return "disengaged";
  } catch {
    return "engaged_or_unreadable";
  }
}

export type VendorSessionRefresh = VendorSessionCheck & {
  refreshed: boolean;
  killSwitch: KillSwitchDecision;
};

/** Re-saves a still-valid session after a GET-only visit; never touches an invalid one. */
export async function refreshVendorSession(
  profile: VendorSessionProfile,
  stateDir: string,
  deps: VendorSessionDeps & { killSwitchReader?: ProviderKillSwitchReader } = {},
): Promise<VendorSessionRefresh> {
  const killSwitch = await vendorKillSwitchDecision(profile.vendor, deps.env, deps.killSwitchReader);
  if (killSwitch === "engaged_or_unreadable") {
    return { vendor: profile.vendor, state: "check_failed", reason: "kill_switch_engaged_or_unreadable", refreshed: false, killSwitch };
  }
  const { refreshedState, ...check } = await checkVendorSession(profile, stateDir, deps);
  if (check.state !== "valid") return { ...check, refreshed: false, killSwitch };
  const saved = refreshedState ? await saveScopedSession(profile, stateDir, refreshedState) : { saved: false as const, reason: "refreshed_state_missing" };
  if (!saved.saved) return { ...check, state: "check_failed", reason: saved.reason, refreshed: false, killSwitch };
  return { ...check, refreshed: true, killSwitch };
}

type SessionCliArgs = {
  command: "check" | "refresh";
  vendors: UnattendedLoginVendor[] | null;
  stateDir: string | null;
  configPath: string | null;
  json: boolean;
};

const SESSION_USAGE = [
  "Usage: npm --prefix worker run session:check -- [vendor,vendor] [--state-dir <dir>] [--config <path>] [--json]",
  "       npm --prefix worker run session:refresh -- [vendor,vendor] [--state-dir <dir>] [--config <path>] [--json]",
  "",
  `Vendors: ${UNATTENDED_LOGIN_VENDORS.join(", ")}. Without a list, the vendors in the login config are used.`,
  "The state directory is --state-dir, else QUOTE_VENDOR_STORAGE_STATE_DIR, else the login config's stateDir.",
  "Both send only GET and HEAD requests to the vendor and never read credentials. session:refresh also",
  "reads the provider kill switch from OverDrafter's Supabase when service-role credentials are set.",
].join("\n");

export function parseVendorList(raw: string): UnattendedLoginVendor[] {
  const vendors = raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (vendors.length === 0) throw new Error("No vendors given.");
  for (const vendor of vendors) {
    if (vendor === "oshcut") refuseOshcutPortalAutomation();
    if (!isUnattendedLoginVendor(vendor)) {
      throw new Error(`Unsupported vendor "${vendor}". Expected one of: ${UNATTENDED_LOGIN_VENDORS.join(", ")}.`);
    }
  }
  return [...new Set(vendors as UnattendedLoginVendor[])];
}

export function parseSessionCliArgs(argv: readonly string[]): SessionCliArgs {
  const [command, ...rest] = argv;
  if (command !== "check" && command !== "refresh") throw new Error(SESSION_USAGE);
  const args: SessionCliArgs = { command, vendors: null, stateDir: null, configPath: null, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--json") args.json = true;
    else if (value === "--state-dir" || value === "--config") {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} needs a value.\n\n${SESSION_USAGE}`);
      if (value === "--state-dir") args.stateDir = path.resolve(next);
      else args.configPath = path.resolve(next);
      index += 1;
    } else if (value === "--help" || value === "-h") throw new Error(SESSION_USAGE);
    else if (!value.startsWith("--") && args.vendors === null) args.vendors = parseVendorList(value);
    else throw new Error(`Unexpected argument "${value}".\n\n${SESSION_USAGE}`);
  }
  return args;
}

async function optionalConfig(configPath: string | null): Promise<VendorLoginConfig | null> {
  try {
    return await readVendorLoginConfig({ path: configPath });
  } catch (error) {
    // An explicit --config must be readable; the default file is optional here.
    if (configPath) throw error;
    return null;
  }
}

function formatLine(result: VendorSessionCheck & { refreshed?: boolean }): string {
  let refreshed = "";
  if (result.refreshed !== undefined) refreshed = result.refreshed ? " refreshed" : " not_refreshed";
  return `${result.vendor.padEnd(11)} ${result.state} (${result.reason})${refreshed}`;
}

async function main() {
  refuseDiagnostics(process.env);
  const args = parseSessionCliArgs(process.argv.slice(2));
  const config = await optionalConfig(args.configPath);
  const vendors = args.vendors ?? (config ? parseVendorList(Object.keys(config.vendors).join(",")) : null);
  if (!vendors) throw new Error(`Name the vendors, or add them to the login config.\n\n${SESSION_USAGE}`);
  const stateDir = resolveStateDir({ flag: args.stateDir, env: process.env, config });
  let allValid = true;
  const release = args.command === "refresh" ? await acquireSessionLock(stateDir) : () => Promise.resolve();
  try {
    for (const vendor of vendors) {
      const profile = resolveVendorSessionProfile(vendor);
      let result: VendorSessionCheck & { refreshed?: boolean };
      if (args.command === "refresh") {
        result = await refreshVendorSession(profile, stateDir);
      } else {
        const check = await checkVendorSession(profile, stateDir);
        result = { vendor: check.vendor, state: check.state, reason: check.reason };
      }
      if (result.state !== "valid") allValid = false;
      console.log(args.json ? JSON.stringify(result) : formatLine(result));
    }
  } finally {
    await release();
  }
  process.exitCode = allValid ? 0 : 1;
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsScript) {
  try {
    await main();
  } catch (error) {
    // Usage and config errors are written by this tool, never page or vault text.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
