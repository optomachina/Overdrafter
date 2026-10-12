import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { chromium, type Browser, type BrowserContextOptions, type Request } from "playwright";
import { chromiumSandboxLaunchOptions } from "./chromiumLaunchOptions.js";
import { PROVIDER_CATALOG } from "./generated/provider-catalog.js";
import type { VendorName, WorkerConfig } from "./types.js";

/**
 * Bounded, read only session probe for stored provider credentials.
 *
 * Storage state providers get exactly one navigation to the first party
 * landing page, every request outside the provider's own domains is aborted,
 * and the page is only inspected, never clicked or submitted. The evidence
 * record carries no cookies, tokens, page content or URL beyond the final host.
 */

export const SESSION_PROBE_PROVIDERS = ["fictiv", "quickparts", "geomiq", "rmfg"] as const;
export type SessionProbeProvider = (typeof SESSION_PROBE_PROVIDERS)[number];

export type SessionProbeOutcome = "authenticated" | "logged_out" | "blocked" | "error";

export type SessionProbeReason =
  | "authenticated_marker_found"
  | "login_form"
  | "no_authenticated_marker"
  | "challenge_page"
  | "access_denied"
  | "off_host_redirect"
  | "unexpected_extra_navigation"
  | "http_unauthorized"
  | "http_forbidden"
  | "http_rate_limited"
  | "http_status_unexpected"
  | "storage_state_invalid"
  | "secret_unavailable"
  | "navigation_failed"
  | "probe_not_supported"
  | "rmfg_endpoint_not_configured"
  | "rmfg_key_invalid"
  | "rmfg_transport_error";

export type SessionProbeEvidence = {
  provider: SessionProbeProvider;
  timestamp: string;
  outcome: SessionProbeOutcome;
  reason: SessionProbeReason;
  finalHost: string | null;
  httpStatus: number | null;
  navigations: number;
  blockedRequests: number;
};

export type SessionProbeTarget = {
  provider: SessionProbeProvider;
  adapterKind: "api" | "portal";
  landingUrl: string | null;
  allowedHosts: readonly string[];
};

const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|signin|sso|auth|authenticate|session\/new|users\/sign_in)(\/|$|\?)/i;

/** Resolves landing URL and allowed hosts from the generated provider catalog. */
export function resolveSessionProbeTarget(provider: string): SessionProbeTarget {
  if (!(SESSION_PROBE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unsupported provider "${provider}". Expected one of: ${SESSION_PROBE_PROVIDERS.join(", ")}.`);
  }
  const entry = PROVIDER_CATALOG[provider as VendorName];
  const domains = entry.officialDomains.map((domain) => domain.toLowerCase());
  const landing = entry.officialRfqUrl;
  if (landing !== null) {
    const url = new URL(landing);
    if (url.protocol !== "https:" || !domains.some((domain) => hostMatches(url.hostname, domain))) {
      throw new Error(`The ${provider} landing URL is not a first party https URL.`);
    }
  }
  return {
    provider: provider as SessionProbeProvider,
    adapterKind: entry.adapterKind === "api" ? "api" : "portal",
    landingUrl: landing,
    allowedHosts: domains,
  };
}

export function hostMatches(hostname: string, allowed: string): boolean {
  const host = hostname.toLowerCase();
  return host === allowed || host.endsWith(`.${allowed}`);
}

export type ProbeUrlPolicy = {
  allowedHosts: readonly string[];
  /** Test seam: permit plain http for 127.0.0.1 only. Never set by the CLI. */
  allowLoopbackHttp?: boolean;
};

export function isAllowedProbeUrl(rawUrl: string, policy: ProbeUrlPolicy): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === "about:" || url.protocol === "data:" || url.protocol === "blob:") {
    // Inline documents never reach the network.
    return url.protocol === "about:";
  }
  const httpsOk = url.protocol === "https:";
  const loopbackOk = policy.allowLoopbackHttp === true && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (!httpsOk && !loopbackOk) return false;
  return policy.allowedHosts.some((allowed) => hostMatches(url.hostname, allowed));
}

export type SecretLoader = (secretName: string) => Promise<string>;

/**
 * Default secret loader: asks gcloud for the latest version and keeps the value
 * in memory only. Errors are replaced with a fixed message so no stderr text
 * can carry a secret into logs.
 */
export function gcloudSecretLoader(project: string | undefined): SecretLoader {
  return (secretName) =>
    new Promise((resolve, reject) => {
      if (!/^[A-Za-z0-9_-]{1,255}$/.test(secretName)) {
        reject(new Error("secret_unavailable"));
        return;
      }
      const args = ["secrets", "versions", "access", "latest", `--secret=${secretName}`];
      if (project) args.push(`--project=${project}`);
      execFile("gcloud", args, { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }, (error, stdout) => {
        if (error || typeof stdout !== "string" || stdout.length === 0) {
          reject(new Error("secret_unavailable"));
          return;
        }
        resolve(stdout);
      });
    });
}

export type StorageStateInput = {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
};

export function parseStorageState(raw: string): StorageStateInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("storage_state_invalid");
  }
  const candidate = parsed as { cookies?: unknown; origins?: unknown } | null;
  if (!candidate || !Array.isArray(candidate.cookies) || !Array.isArray(candidate.origins)) {
    throw new Error("storage_state_invalid");
  }
  return candidate as StorageStateInput;
}

export async function loadStorageState(
  source: { file?: string; secret?: string },
  loadSecret: SecretLoader,
): Promise<StorageStateInput> {
  if (source.file && source.secret) throw new Error("Pass either --storage-state or --secret, not both.");
  if (!source.file && !source.secret) throw new Error("Pass --storage-state <path> or --secret <name>.");
  let raw: string;
  try {
    raw = source.file ? await fs.readFile(source.file, "utf8") : await loadSecret(source.secret as string);
  } catch {
    throw new Error("secret_unavailable");
  }
  return parseStorageState(raw);
}

type PageSignals = {
  loginForm: boolean;
  challenge: boolean;
  denied: boolean;
  marker: boolean;
};

/** Runs inside the page. Read only DOM inspection; it must stay self contained. */
function inspectPageSignals(): PageSignals {
  const text = (document.body?.innerText ?? "").slice(0, 20_000).toLowerCase();
  const title = (document.title ?? "").toLowerCase();
  const haystack = `${title}\n${text}`;
  const isVisible = (element: Element) => {
    const rect = (element as HTMLElement).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const loginForm = Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible);
  const challenge =
    /captcha|verify you are human|verifying you are human|checking your browser|just a moment|attention required|are you a robot|security check/.test(
      haystack,
    ) ||
    document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenge"], #challenge-form, .g-recaptcha, .h-captcha, .cf-turnstile',
    ) !== null;
  const denied =
    /access denied|you have been blocked|you are blocked|forbidden|unusual traffic|account (has been )?(suspended|banned|locked)|temporarily banned/.test(
      haystack,
    );
  const marker =
    document.querySelector(
      'a[href*="logout" i], a[href*="log-out" i], a[href*="signout" i], a[href*="sign-out" i], [data-testid*="logout" i], [data-testid*="sign-out" i]',
    ) !== null ||
    Array.from(document.querySelectorAll('a, button, [role="menuitem"]')).some((element) =>
      /^\s*(log\s?out|sign\s?out)\s*$/i.test(element.textContent ?? ""),
    );
  return { loginForm, challenge, denied, marker };
}

export type BrowserProbeOptions = {
  target: SessionProbeTarget;
  storageState: StorageStateInput;
  /** Feeds chromiumSandboxLaunchOptions so the probe honors the same sandbox opt out as the worker. */
  sandbox: Pick<WorkerConfig, "playwrightDisableSandbox" | "playwrightDisableDevShmUsage">;
  /** Test only: a Chromium build other than the Playwright default. */
  executablePath?: string;
  /** Overrides the catalog landing URL. Tests only. */
  landingUrlOverride?: string;
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  /** Quiet period after load so a scripted redirect is observed before judging. */
  settleMs?: number;
  now?: () => Date;
};

function baseEvidence(provider: SessionProbeProvider, now: () => Date): SessionProbeEvidence {
  return {
    provider,
    timestamp: now().toISOString(),
    outcome: "error",
    reason: "navigation_failed",
    finalHost: null,
    httpStatus: null,
    navigations: 0,
    blockedRequests: 0,
  };
}

export async function runBoundedBrowserSessionProbe(options: BrowserProbeOptions): Promise<SessionProbeEvidence> {
  const now = options.now ?? (() => new Date());
  const evidence = baseEvidence(options.target.provider, now);
  const landing = options.landingUrlOverride ?? options.target.landingUrl;
  if (options.target.adapterKind !== "portal" || !landing) {
    return { ...evidence, outcome: "error", reason: "probe_not_supported" };
  }
  const policy: ProbeUrlPolicy = {
    allowedHosts: options.target.allowedHosts,
    allowLoopbackHttp: options.allowLoopbackHttp,
  };
  const timeoutMs = options.timeoutMs ?? 20_000;
  let browser: Browser | null = null;
  let offHostNavigation = false;
  let extraNavigation = false;
  let extraNavigationLooksLikeLogin = false;
  try {
    browser = await chromium.launch({
      headless: true,
      ...chromiumSandboxLaunchOptions(options.sandbox),
      executablePath: options.executablePath,
    });
    const context = await browser.newContext({
      storageState: options.storageState as BrowserContextOptions["storageState"],
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);
    const page = await context.newPage();
    let navigationChains = 0;

    await context.route("**/*", async (route) => {
      const request: Request = route.request();
      const method = request.method().toUpperCase();
      const mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
      const allowedUrl = isAllowedProbeUrl(request.url(), policy);
      if (!allowedUrl || !["GET", "HEAD"].includes(method)) {
        evidence.blockedRequests += 1;
        if (mainNavigation && !allowedUrl) offHostNavigation = true;
        await route.abort("blockedbyclient");
        return;
      }
      if (mainNavigation && request.redirectedFrom() === null) {
        navigationChains += 1;
        if (navigationChains > 1) {
          extraNavigation = true;
          try {
            extraNavigationLooksLikeLogin = LOGIN_PATH.test(new URL(request.url()).pathname);
          } catch {
            extraNavigationLooksLikeLogin = false;
          }
          evidence.blockedRequests += 1;
          await route.abort("blockedbyclient");
          return;
        }
      }
      // Fetch without following redirects so every hop is checked against the
      // host policy before the browser can send it.
      let upstream: Awaited<ReturnType<typeof route.fetch>>;
      try {
        upstream = await route.fetch({ maxRedirects: 0 });
      } catch {
        await route.abort("failed");
        return;
      }
      const location = upstream.headers()["location"];
      if (upstream.status() >= 300 && upstream.status() < 400 && location) {
        let next: string | null = null;
        try {
          next = new URL(location, request.url()).toString();
        } catch {
          next = null;
        }
        if (next === null || !isAllowedProbeUrl(next, policy)) {
          evidence.blockedRequests += 1;
          if (mainNavigation) offHostNavigation = true;
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.fulfill({ response: upstream });
    });
    await context.routeWebSocket("**/*", (socket) => {
      void socket.close();
    });

    let status: number | null = null;
    try {
      const response = await page.goto(landing, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      status = response?.status() ?? null;
      evidence.navigations = Math.max(navigationChains, 1);
    } catch {
      evidence.navigations = Math.max(navigationChains, 1);
      evidence.httpStatus = null;
      if (offHostNavigation) return { ...evidence, outcome: "blocked", reason: "off_host_redirect" };
      return { ...evidence, outcome: "error", reason: "navigation_failed" };
    }
    evidence.httpStatus = status;
    evidence.navigations = Math.max(navigationChains, 1);

    const finalUrl = new URL(page.url());
    evidence.finalHost = finalUrl.hostname;

    if (offHostNavigation || !isAllowedProbeUrl(page.url(), policy)) {
      return { ...evidence, outcome: "blocked", reason: "off_host_redirect" };
    }

    // Bounded wait so a client rendered page can show a login form, a
    // challenge or the account marker. Passive polling only.
    await page.waitForTimeout(options.settleMs ?? 1_500);
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    let signals: PageSignals = { loginForm: false, challenge: false, denied: false, marker: false };
    for (;;) {
      signals = await page.evaluate(inspectPageSignals);
      if (signals.loginForm || signals.challenge || signals.denied || signals.marker || Date.now() >= deadline) break;
      await page.waitForTimeout(250);
    }
    evidence.navigations = Math.max(navigationChains, 1);

    if (status === 429) return { ...evidence, outcome: "blocked", reason: "http_rate_limited" };
    if (signals.challenge) return { ...evidence, outcome: "blocked", reason: "challenge_page" };
    if (status === 403 || signals.denied) {
      return { ...evidence, outcome: "blocked", reason: status === 403 ? "http_forbidden" : "access_denied" };
    }
    if (extraNavigation) {
      return extraNavigationLooksLikeLogin
        ? { ...evidence, outcome: "logged_out", reason: "login_form" }
        : { ...evidence, outcome: "blocked", reason: "unexpected_extra_navigation" };
    }
    if (status === 401) return { ...evidence, outcome: "logged_out", reason: "http_unauthorized" };
    if (LOGIN_PATH.test(finalUrl.pathname) || signals.loginForm) {
      return { ...evidence, outcome: "logged_out", reason: "login_form" };
    }
    if (status === null || status < 200 || status >= 300) {
      return { ...evidence, outcome: "error", reason: "http_status_unexpected" };
    }
    if (!signals.marker) return { ...evidence, outcome: "logged_out", reason: "no_authenticated_marker" };
    return { ...evidence, outcome: "authenticated", reason: "authenticated_marker_found" };
  } catch {
    return { ...evidence, outcome: "error", reason: "navigation_failed" };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export type RmfgProbeResponse = { status: number };

export type RmfgProbeRequest = {
  method: "GET";
  /** https URL including the path of the one read only call. */
  url: string;
  apiKey: string;
  timeoutMs: number;
};

export type RmfgProbeTransport = (request: RmfgProbeRequest) => Promise<RmfgProbeResponse>;

/**
 * TODO(OVD-rmfg-probe): the repository has no RMFG HTTP client and no
 * documented account or health endpoint. rmfgQuoteTransport.ts is an offline
 * contract that covers materials, designs, analyze and quotes only, and the
 * materials catalog may be public, so a 200 there would not prove the key.
 * Blaine or the RMFG docs must name the endpoint before this is set. Until
 * then the probe makes no network call.
 */
export const RMFG_PROBE_ENDPOINT: string | null = null;

export function validateRmfgApiKey(value: string): string | null {
  const key = value.trim();
  if (key.length < 8 || key.length > 512 || /\s/.test(key)) return null;
  return key;
}

export async function runBoundedRmfgSessionProbe(options: {
  apiKey: string;
  endpointUrl?: string | null;
  transport?: RmfgProbeTransport;
  timeoutMs?: number;
  now?: () => Date;
}): Promise<SessionProbeEvidence> {
  const now = options.now ?? (() => new Date());
  const evidence = baseEvidence("rmfg", now);
  const endpoint = options.endpointUrl === undefined ? RMFG_PROBE_ENDPOINT : options.endpointUrl;
  if (endpoint === null || !options.transport) {
    return { ...evidence, reason: "rmfg_endpoint_not_configured" };
  }
  const key = validateRmfgApiKey(options.apiKey);
  if (!key) return { ...evidence, reason: "rmfg_key_invalid" };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ...evidence, reason: "rmfg_endpoint_not_configured" };
  }
  const rmfgDomains = PROVIDER_CATALOG.rmfg.officialDomains;
  if (url.protocol !== "https:" || !rmfgDomains.some((domain) => hostMatches(url.hostname, domain))) {
    return { ...evidence, reason: "rmfg_endpoint_not_configured" };
  }
  evidence.navigations = 0;
  evidence.finalHost = url.hostname;
  let status: number;
  try {
    const timeoutMs = Math.min(options.timeoutMs ?? 10_000, 10_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      ({ status } = await Promise.race([
        options.transport({ method: "GET", url: url.toString(), apiKey: key, timeoutMs }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]));
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return { ...evidence, reason: "rmfg_transport_error" };
  }
  evidence.httpStatus = status;
  if (status >= 200 && status < 300) return { ...evidence, outcome: "authenticated", reason: "authenticated_marker_found" };
  if (status === 401) return { ...evidence, outcome: "blocked", reason: "http_unauthorized" };
  if (status === 429) return { ...evidence, outcome: "blocked", reason: "http_rate_limited" };
  if (status === 403) return { ...evidence, outcome: "blocked", reason: "http_forbidden" };
  return { ...evidence, outcome: "error", reason: "http_status_unexpected" };
}

export type ProbeCliArgs = {
  provider: SessionProbeProvider;
  storageStatePath?: string;
  secretName?: string;
  project?: string;
  outPath?: string;
};

export function parseProbeCliArgs(argv: readonly string[]): ProbeCliArgs {
  const [providerArg, ...rest] = argv;
  if (!providerArg || providerArg.startsWith("--")) {
    throw new Error(`Usage: probe:session <${SESSION_PROBE_PROVIDERS.join("|")}> [--storage-state <path> | --secret <name>] [--project <id>] [--out <path>]`);
  }
  const target = resolveSessionProbeTarget(providerArg);
  const args: ProbeCliArgs = { provider: target.provider };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--storage-state") args.storageStatePath = value;
    else if (flag === "--secret") args.secretName = value;
    else if (flag === "--project") args.project = value;
    else if (flag === "--out") args.outPath = value;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (args.storageStatePath && args.secretName) throw new Error("Pass either --storage-state or --secret, not both.");
  if (!args.storageStatePath && !args.secretName) throw new Error("Pass --storage-state <path> or --secret <name>.");
  if (target.adapterKind === "api" && args.storageStatePath) {
    throw new Error("rmfg uses an API key; pass --secret <name>.");
  }
  return args;
}

export async function runSessionProbe(
  args: ProbeCliArgs,
  deps: {
    loadSecret: SecretLoader;
    sandbox: BrowserProbeOptions["sandbox"];
    rmfgTransport?: RmfgProbeTransport;
    now?: () => Date;
  },
): Promise<SessionProbeEvidence> {
  const now = deps.now ?? (() => new Date());
  const target = resolveSessionProbeTarget(args.provider);
  try {
    if (target.adapterKind === "api") {
      const raw = await deps.loadSecret(args.secretName as string);
      return await runBoundedRmfgSessionProbe({ apiKey: raw, transport: deps.rmfgTransport, now });
    }
    const storageState = await loadStorageState(
      { file: args.storageStatePath, secret: args.secretName },
      deps.loadSecret,
    );
    return await runBoundedBrowserSessionProbe({ target, storageState, sandbox: deps.sandbox, now });
  } catch (error) {
    const reason: SessionProbeReason =
      error instanceof Error && error.message === "storage_state_invalid" ? "storage_state_invalid" : "secret_unavailable";
    return { ...baseEvidence(args.provider, now), outcome: "error", reason };
  }
}
