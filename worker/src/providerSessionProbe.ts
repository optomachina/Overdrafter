import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Request } from "playwright";
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
  | "redirect_limit_exceeded"
  | "non_get_navigation"
  | "unexpected_extra_navigation"
  | "http_unauthorized"
  | "http_forbidden"
  | "http_rate_limited"
  | "http_status_unexpected"
  | "storage_state_invalid"
  | "secret_unavailable"
  | "navigation_failed"
  | "page_inspection_failed"
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

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
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

const GCLOUD_FIXED_LOCATIONS = [
  "/usr/local/bin/gcloud",
  "/usr/bin/gcloud",
  "/opt/homebrew/bin/gcloud",
  "/snap/bin/gcloud",
  "/usr/lib/google-cloud-sdk/bin/gcloud",
];

/**
 * Finds gcloud without consulting PATH: GCLOUD_PATH (an absolute path) first,
 * then a fixed list, then the SDK folder in the home directory.
 */
async function findGcloud(): Promise<string | null> {
  const home = process.env.HOME;
  const candidates = [
    process.env.GCLOUD_PATH,
    ...GCLOUD_FIXED_LOCATIONS,
    home ? `${home}/google-cloud-sdk/bin/gcloud` : undefined,
  ].filter((candidate): candidate is string => typeof candidate === "string" && path.isAbsolute(candidate));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // try the next location
    }
  }
  return null;
}

/**
 * Default secret loader: asks gcloud for the latest version and keeps the value
 * in memory only. Errors are replaced with a fixed message so no stderr text
 * can carry a secret into logs.
 */
export function gcloudSecretLoader(project: string | undefined): SecretLoader {
  return async (secretName) => {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(secretName)) throw new Error("secret_unavailable");
    const gcloud = await findGcloud();
    if (!gcloud) throw new Error("secret_unavailable");
    const args = ["secrets", "versions", "access", "latest", `--secret=${secretName}`];
    if (project) args.push(`--project=${project}`);
    return new Promise<string>((resolve, reject) => {
      execFile(gcloud, args, { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }, (error, stdout) => {
        if (error || typeof stdout !== "string" || stdout.length === 0) {
          reject(new Error("secret_unavailable"));
          return;
        }
        resolve(stdout);
      });
    });
  };
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

/**
 * Runs inside the page as a plain JavaScript string. It is deliberately not a
 * TypeScript function: tsx and esbuild wrap named inner functions in a __name
 * helper that does not exist in the page, which would make evaluation throw.
 * Read only DOM inspection.
 */
function buildPageSignalsScript(httpStatus: number | null): string {
  const status = Number.isInteger(httpStatus) ? String(httpStatus) : "0";
  return `(() => {
  const status = ${status};
  const text = ((document.body && document.body.innerText) || "").slice(0, 20000).toLowerCase();
  const title = (document.title || "").toLowerCase();
  const haystack = title + "\\n" + text;
  const loginForm = Array.from(document.querySelectorAll('input[type="password"]')).some((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const challengeFrame = document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenge"], #challenge-form, .g-recaptcha, .h-captcha, .cf-turnstile') !== null;
  const cfMarker = document.querySelector('#cf-chl-widget, [id^="cf-chl"], [name="cf-turnstile-response"], script[src*="challenge-platform"], .cf-turnstile') !== null;
  // "Just a moment" alone is also what a loading single page app shows, so it
  // counts only together with a status, marker or title that says challenge.
  const titleChallenge = /^\\s*(just a moment|attention required)/.test(title);
  const justAMoment = /just a moment/.test(haystack);
  const challenge =
    /captcha|verify you are human|verifying you are human|checking your browser|attention required|are you a robot|security check/.test(haystack) ||
    challengeFrame ||
    (justAMoment && (status === 403 || status === 503 || cfMarker || titleChallenge));
  const denied = /access denied|you have been blocked|you are blocked|forbidden|unusual traffic|account (has been )?(suspended|banned|locked)|temporarily banned/.test(haystack);
  const marker =
    document.querySelector('a[href*="logout" i], a[href*="log-out" i], a[href*="signout" i], a[href*="sign-out" i], [data-testid*="logout" i], [data-testid*="sign-out" i]') !== null ||
    Array.from(document.querySelectorAll('a, button, [role="menuitem"]')).some((element) => /^\\s*(log\\s?out|sign\\s?out)\\s*$/i.test(element.textContent || ""));
  return { loginForm, challenge, denied, marker };
})()`;
}

/** Hard cap on redirect hops the probe follows itself for one request. */
export const MAX_REDIRECT_HOPS = 5;

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
  let nonGetNavigation = false;
  let redirectLimitExceeded = false;
  let mainFinalUrl: string | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      ...chromiumSandboxLaunchOptions(options.sandbox),
      executablePath: options.executablePath,
    });
    let context: BrowserContext;
    try {
      context = await browser.newContext({
        storageState: options.storageState as BrowserContextOptions["storageState"],
        serviceWorkers: "block",
        acceptDownloads: false,
      });
    } catch {
      return { ...evidence, outcome: "error", reason: "storage_state_invalid" };
    }
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);
    const page = await context.newPage();
    let navigationChains = 0;

    await context.route("**/*", async (route) => {
      const request: Request = route.request();
      const method = request.method().toUpperCase();
      // request.frame() throws for requests that belong to a popup. Treat an
      // unknown frame as not the main frame; method and host rules still apply.
      let mainFrame = false;
      try {
        mainFrame = request.frame() === page.mainFrame();
      } catch {
        mainFrame = false;
      }
      const mainNavigation = request.isNavigationRequest() && mainFrame;
      const allowedUrl = isAllowedProbeUrl(request.url(), policy);
      if (!allowedUrl || !["GET", "HEAD"].includes(method)) {
        evidence.blockedRequests += 1;
        if (mainNavigation && !allowedUrl) offHostNavigation = true;
        else if (mainNavigation) nonGetNavigation = true;
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
      // Follow redirects here, one fetch per hop with the browser's own
      // redirect following never involved: every hop is checked against the
      // host and https rules before it is sent, and only the final non 3xx
      // response is handed to the browser. A 3xx is never fulfilled, because
      // Chromium would follow the rest of the chain outside this handler.
      let currentUrl = request.url();
      let upstream: Awaited<ReturnType<typeof route.fetch>>;
      let hops = 0;
      for (;;) {
        try {
          upstream = await route.fetch({ url: currentUrl, maxRedirects: 0, maxRetries: 0 });
        } catch {
          await route.abort("failed");
          return;
        }
        const status = upstream.status();
        if (status < 300 || status >= 400) break;
        const location = upstream.headers()["location"];
        if (!location) break;
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          evidence.blockedRequests += 1;
          if (mainNavigation) redirectLimitExceeded = true;
          await route.abort("blockedbyclient");
          return;
        }
        let next: string | null = null;
        try {
          next = new URL(location, currentUrl).toString();
        } catch {
          next = null;
        }
        if (next === null || !isAllowedProbeUrl(next, policy)) {
          evidence.blockedRequests += 1;
          if (mainNavigation) offHostNavigation = true;
          await route.abort("blockedbyclient");
          return;
        }
        currentUrl = next;
      }
      if (upstream.status() >= 300 && upstream.status() < 400) {
        // A 3xx without Location has no next hop and nothing safe to hand over.
        evidence.blockedRequests += 1;
        await route.abort("failed");
        return;
      }
      // fulfill cannot change the document URL, so keep the final URL here.
      if (mainNavigation) mainFinalUrl = currentUrl;
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
      if (redirectLimitExceeded) return { ...evidence, outcome: "blocked", reason: "redirect_limit_exceeded" };
      return { ...evidence, outcome: "error", reason: "navigation_failed" };
    }
    evidence.httpStatus = status;
    evidence.navigations = Math.max(navigationChains, 1);
    // The browser URL stays at the requested address because redirects are
    // followed in the route handler; the handler's final URL is the real one.
    const landedUrl = mainFinalUrl ?? page.url();
    evidence.finalHost = hostOf(landedUrl);

    if (offHostNavigation || !isAllowedProbeUrl(landedUrl, policy)) {
      return { ...evidence, outcome: "blocked", reason: "off_host_redirect" };
    }
    // Judge the HTTP response before touching the page, so a 403 or 429 is
    // reported as blocked even if page inspection later fails.
    if (status === 429) return { ...evidence, outcome: "blocked", reason: "http_rate_limited" };
    if (status === 403) return { ...evidence, outcome: "blocked", reason: "http_forbidden" };
    if (status === 401) return { ...evidence, outcome: "logged_out", reason: "http_unauthorized" };

    // Bounded wait so a client rendered page can show a login form, a
    // challenge or the account marker. Passive polling only.
    await page.waitForTimeout(options.settleMs ?? 1_500);
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    let signals: PageSignals;
    try {
      for (;;) {
        signals = (await page.evaluate(buildPageSignalsScript(status))) as PageSignals;
        if (signals.loginForm || signals.challenge || signals.denied || signals.marker || Date.now() >= deadline) break;
        await page.waitForTimeout(250);
      }
    } catch {
      evidence.navigations = Math.max(navigationChains, 1);
      return { ...evidence, outcome: "error", reason: "page_inspection_failed" };
    }
    evidence.navigations = Math.max(navigationChains, 1);
    // An aborted extra navigation leaves the browser on an error page, so only
    // an allowed URL updates what is reported; off host attempts set the flag.
    const settledUrl = mainFinalUrl && isAllowedProbeUrl(mainFinalUrl, policy) ? mainFinalUrl : landedUrl;
    const finalUrl = new URL(settledUrl);
    evidence.finalHost = finalUrl.hostname;
    if (offHostNavigation) return { ...evidence, outcome: "blocked", reason: "off_host_redirect" };
    if (redirectLimitExceeded) return { ...evidence, outcome: "blocked", reason: "redirect_limit_exceeded" };
    if (nonGetNavigation) return { ...evidence, outcome: "blocked", reason: "non_get_navigation" };

    if (signals.challenge) return { ...evidence, outcome: "blocked", reason: "challenge_page" };
    if (signals.denied) return { ...evidence, outcome: "blocked", reason: "access_denied" };
    if (extraNavigation) {
      return extraNavigationLooksLikeLogin
        ? { ...evidence, outcome: "logged_out", reason: "login_form" }
        : { ...evidence, outcome: "blocked", reason: "unexpected_extra_navigation" };
    }
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

export const PROBE_USAGE = `probe:session <${SESSION_PROBE_PROVIDERS.join("|")}> [--storage-state <path> | --secret <name>] [--project <id>] [--out <path>]`;

export function parseProbeCliArgs(argv: readonly string[]): ProbeCliArgs {
  const [providerArg, ...rest] = argv;
  if (!providerArg || providerArg.startsWith("--")) {
    throw new Error(PROBE_USAGE);
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

const LOOPBACK_FIXTURE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}(\/[^\s]*)?$/;

export async function runSessionProbe(
  args: ProbeCliArgs,
  deps: {
    loadSecret: SecretLoader;
    sandbox: BrowserProbeOptions["sandbox"];
    rmfgTransport?: RmfgProbeTransport;
    now?: () => Date;
    /**
     * Test seam used by the CLI wrapper test. Honored only for a plain
     * http://127.0.0.1:<port> URL, which narrows the probe to that one
     * loopback host, so it can never point the probe at a real provider.
     */
    loopbackFixtureUrl?: string;
    executablePath?: string;
  },
): Promise<SessionProbeEvidence> {
  const now = deps.now ?? (() => new Date());
  let target = resolveSessionProbeTarget(args.provider);
  const fixture = deps.loopbackFixtureUrl && LOOPBACK_FIXTURE_URL.test(deps.loopbackFixtureUrl) ? deps.loopbackFixtureUrl : null;
  if (fixture && target.adapterKind === "portal") {
    target = { ...target, landingUrl: fixture, allowedHosts: ["127.0.0.1"] };
  }
  try {
    if (target.adapterKind === "api") {
      // Decide before reading the secret: with no endpoint there is nothing to call.
      if (RMFG_PROBE_ENDPOINT === null || !deps.rmfgTransport) {
        return { ...baseEvidence(args.provider, now), reason: "rmfg_endpoint_not_configured" };
      }
      const raw = await deps.loadSecret(args.secretName as string);
      return await runBoundedRmfgSessionProbe({ apiKey: raw, transport: deps.rmfgTransport, now });
    }
    const storageState = await loadStorageState(
      { file: args.storageStatePath, secret: args.secretName },
      deps.loadSecret,
    );
    return await runBoundedBrowserSessionProbe({
      target,
      storageState,
      sandbox: deps.sandbox,
      now,
      ...(fixture ? { allowLoopbackHttp: true, executablePath: deps.executablePath, settleMs: 300 } : {}),
    });
  } catch (error) {
    const reason: SessionProbeReason =
      error instanceof Error && error.message === "storage_state_invalid" ? "storage_state_invalid" : "secret_unavailable";
    return { ...baseEvidence(args.provider, now), outcome: "error", reason };
  }
}
