import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Request } from "playwright";
import { chromiumSandboxLaunchOptions } from "./chromiumLaunchOptions.js";
import { PROVIDER_CATALOG } from "./generated/provider-catalog.js";
import type { VendorName, WorkerConfig } from "./types.js";

/**
 * Bounded, read only session probe for stored provider credentials.
 *
 * Storage state providers get exactly one navigation (followed through at
 * most MAX_REDIRECT_HOPS checked redirect hops) to the first party landing
 * page, every request outside the provider's own domains is aborted, and the
 * page is only inspected, never clicked or submitted. The evidence
 * record carries no cookies, tokens, page content or URL beyond the final host.
 */

export const SESSION_PROBE_PROVIDERS = ["fictiv", "quickparts", "geomiq", "rmfg"] as const;
export type SessionProbeProvider = (typeof SESSION_PROBE_PROVIDERS)[number];

export type SessionProbeOutcome = "authenticated" | "logged_out" | "blocked" | "error";

export type SessionProbeReason =
  | "authenticated_marker_found"
  | "terminal_signals_ready"
  | "login_form"
  | "no_authenticated_marker"
  | "challenge_page"
  | "access_denied"
  | "off_host_redirect"
  | "login_redirect_off_host"
  | "non_https_target"
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
  | "browser_launch_failed"
  | "page_inspection_failed"
  | "storage_state_capture_failed"
  | "settled_page_indeterminate"
  | "probe_not_supported"
  | "rmfg_endpoint_not_configured"
  | "rmfg_key_invalid"
  | "rmfg_transport_error";

export type SessionProbeEvidence = {
  /** A session probe provider, or a portal vendor probed through an explicit target (OVD-1060). */
  provider: VendorName;
  timestamp: string;
  outcome: SessionProbeOutcome;
  reason: SessionProbeReason;
  finalHost: string | null;
  httpStatus: number | null;
  navigations: number;
  blockedRequests: number;
  /**
   * Set only for login_redirect_off_host: the host name (never a URL, path or
   * query) of the identity or login host the provider redirected to.
   */
  offHost?: string;
};

export type SessionProbeTarget = {
  provider: VendorName;
  adapterKind: "api" | "portal";
  landingUrl: string | null;
  allowedHosts: readonly string[];
};

const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|signin|sso|auth|authenticate|session\/new|users\/sign_in)(\/|$|\?)/i;

/**
 * Probe landing pages that differ from the catalog RFQ URL. The Quickparts
 * catalog URL is the marketing page; the signed in app lives on
 * quickquote.quickparts.com (the adapter's uploadUrl), inside the
 * quickparts.com allowlist.
 */
const PROBE_LANDING_OVERRIDES: Partial<Record<SessionProbeProvider, string>> = {
  quickparts: "https://quickquote.quickparts.com/",
};

/** Resolves landing URL and allowed hosts from the generated provider catalog. */
export function resolveSessionProbeTarget(provider: string): SessionProbeTarget & { provider: SessionProbeProvider } {
  if (!(SESSION_PROBE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unsupported provider "${provider}". Expected one of: ${SESSION_PROBE_PROVIDERS.join(", ")}.`);
  }
  const entry = PROVIDER_CATALOG[provider as VendorName];
  const domains = entry.officialDomains.map((domain) => domain.toLowerCase());
  const landing = PROBE_LANDING_OVERRIDES[provider as SessionProbeProvider] ?? entry.officialRfqUrl;
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
  /** Test seam: permit plain http for 127.0.0.1 and 127.0.0.2 only. Never set by the CLI. */
  allowLoopbackHttp?: boolean;
};

export type ProbeUrlFailure = "off_host_redirect" | "non_https_target";

const LOOPBACK_TEST_HOST = /^127\.0\.0\.[12]$/;

/**
 * Why a URL may not be requested, or null when it may. Only https (or plain
 * http to the loopback test hosts when the test seam is on) to an allowed host
 * passes; about:, data:, blob:, javascript: and every other scheme fail with
 * non_https_target.
 */
export function probeUrlFailure(rawUrl: string, policy: ProbeUrlPolicy): ProbeUrlFailure | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "off_host_redirect";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "non_https_target";
  if (!policy.allowedHosts.some((allowed) => hostMatches(url.hostname, allowed))) return "off_host_redirect";
  if (url.protocol === "http:" && !(policy.allowLoopbackHttp === true && LOOPBACK_TEST_HOST.test(url.hostname))) {
    return "non_https_target";
  }
  return null;
}

export function isAllowedProbeUrl(rawUrl: string, policy: ProbeUrlPolicy): boolean {
  return probeUrlFailure(rawUrl, policy) === null;
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
 * Finds gcloud without consulting PATH. When GCLOUD_PATH is set it is the only
 * candidate and must be an absolute, executable path. Otherwise a fixed list,
 * then the SDK folder in the home directory.
 */
export async function findGcloud(): Promise<string | null> {
  const home = process.env.HOME;
  const explicit = process.env.GCLOUD_PATH;
  // An explicit GCLOUD_PATH is a decision: if it is wrong, fail closed
  // instead of quietly using a different gcloud (and a different account).
  const searched = [...GCLOUD_FIXED_LOCATIONS, home ? `${home}/google-cloud-sdk/bin/gcloud` : undefined].filter(
    (candidate): candidate is string => typeof candidate === "string" && path.isAbsolute(candidate),
  );
  let candidates = searched;
  if (explicit !== undefined && explicit !== "") candidates = path.isAbsolute(explicit) ? [explicit] : [];
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
 *
 * Body text never decides a block. A reCAPTCHA footer, a "Forbidden" word in
 * help text or a loading spinner that says "Just a moment" are ordinary on
 * logged in and login pages alike. Only a Cloudflare challenge marker, a
 * Turnstile widget on a page with neither a password field nor a log out
 * control, or a challenge or denial title counts. A present log out control
 * beats a CAPTCHA widget alone. The control is matched in the DOM whether or
 * not it is visible, because many sites keep it in a closed account menu.
 * Status codes are judged outside the page.
 */
const PAGE_SIGNALS_SCRIPT = `(() => {
  const title = (document.title || "").toLowerCase();
  const loginForm = Array.from(document.querySelectorAll('input[type="password"]')).some((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const cfInterstitial =
    typeof window._cf_chl_opt !== "undefined" ||
    document.querySelector('#challenge-form, form[action*="__cf_chl"], [id^="cf-chl-"], script[src*="/cdn-cgi/challenge-platform/"][src*="orchestrate"]') !== null;
  const marker =
    document.querySelector('a[href*="logout" i], a[href*="log-out" i], a[href*="signout" i], a[href*="sign-out" i], [data-testid*="logout" i], [data-testid*="sign-out" i]') !== null ||
    Array.from(document.querySelectorAll('a, button, [role="menuitem"]')).some((element) => /^\\s*(log\\s?out|sign\\s?out)\\s*$/i.test(element.textContent || ""));
  const turnstile = document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [name="cf-turnstile-response"]') !== null;
  const challengeTitle = /^\\s*(just a moment|attention required|checking your browser|verifying you are human|verify you are human|one more step|ddos-guard)/.test(title);
  const challenge = cfInterstitial || challengeTitle || (turnstile && !loginForm && !marker);
  const denied = /^\\s*(access denied|you have been blocked|error 1020|403 forbidden)/.test(title);
  return { loginForm, challenge, denied, marker };
})()`;

/** Hard cap on redirect hops for the landing navigation and for each subresource request. */
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
  /** Test only: replaces the page sampler, to force an inspection failure. */
  sampleSignals?: (page: Page) => Promise<unknown>;
  /** Gap before the confirming second page sample that must agree with the first. */
  confirmMs?: number;
  now?: () => Date;
  /**
   * Consulted once the settled page shows no login form, no login route and
   * no challenge (OVD-1060), with or without a log out control: a second
   * factor prompt or an error page can carry one too. `signed_in` reports
   * the session authenticated (by the marker, or without one by the provider
   * definition's own terminal signals), `signed_out` keeps the logged-out
   * answer, and `indeterminate` (an error, a spinner, a second-factor prompt)
   * reports an error rather than a logged-out session. The page text stays
   * inside this callback.
   */
  settledPageVerdict?: (
    snapshot: { url: string; bodyText: string; passwordInputCount: number },
    page: { logoutControl: boolean },
  ) => SettledPageVerdict | Promise<SettledPageVerdict>;
  /** Environment for the probe's Chromium; the caller's own environment when absent. */
  browserEnv?: NodeJS.ProcessEnv;
  /**
   * Receives the context's storage state after an authenticated outcome,
   * before the browser closes, so a caller can re-save a session the probe
   * kept alive with GETs only (OVD-1060).
   */
  onAuthenticated?: (storageState: StorageStateInput) => void | Promise<void>;
};

export type SettledPageVerdict = "signed_in" | "signed_out" | "indeterminate";

function baseEvidence(provider: VendorName, now: () => Date): SessionProbeEvidence {
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

function looksLikeLogin(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    // Hash routed apps (for example Quickparts at #/login) keep the route in the fragment.
    return LOGIN_PATH.test(url.pathname) || LOGIN_PATH.test(url.hash.replace(/^#!?/, ""));
  } catch {
    return false;
  }
}

const IDENTITY_HOST_LABEL = /^(login|logon|signin|sign-in|auth|sso|id|idp|identity|account|accounts|oauth|secure|passport)\d*$/;
const IDENTITY_HOST_SUFFIX = ["auth0.com", "okta.com", "oktapreview.com", "onelogin.com", "microsoftonline.com"];

/**
 * The host name of an identity or login target outside the allowlist, or null
 * when the URL is not recognizably a login or identity page. Only the host
 * name leaves this function.
 */
function offHostLoginHost(rawUrl: string, failure: ProbeUrlFailure | null): string | null {
  if (failure !== "off_host_redirect") return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const identityHost =
    host.split(".").some((label) => IDENTITY_HOST_LABEL.test(label)) ||
    IDENTITY_HOST_SUFFIX.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  return identityHost || looksLikeLogin(rawUrl) ? host : null;
}

function frameKindOf(request: Request, page: Page): "main" | "sub" | "other" {
  // request.frame() throws for a navigation that opens a popup, so an
  // unresolvable frame is treated as another page.
  try {
    const frame = request.frame();
    if (frame === page.mainFrame()) return "main";
    return frame.page() === page ? "sub" : "other";
  } catch {
    return "other";
  }
}

/**
 * Request headers for one hop without a Cookie header, so Playwright's fetch
 * reads the cookies for that exact URL from the context cookie jar and writes
 * every Set-Cookie it receives back into the jar, the way Chromium would.
 */
function hopHeaders(request: Request): Record<string, string> {
  const headers = { ...request.headers() };
  delete headers.cookie;
  return headers;
}

/** Same snapshot the portal kernel classifies; a read failure is indeterminate. */
async function settledPageVerdictOf(
  page: Page,
  url: string,
  verdict: NonNullable<BrowserProbeOptions["settledPageVerdict"]>,
  logoutControl: boolean,
): Promise<SettledPageVerdict> {
  try {
    return await verdict({
      url,
      bodyText: await page.locator("body").innerText({ timeout: 5_000 }),
      passwordInputCount: await page.locator("input[type='password']").count(),
    }, { logoutControl });
  } catch {
    return "indeterminate";
  }
}

/** The probe's own landing navigation, one routed page.goto per redirect hop. */
type LandingHop = { claimed: boolean; redirectTo: string | null };

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
  const landingFailure = probeUrlFailure(landing, policy);
  if (landingFailure) return { ...evidence, outcome: "error", reason: "probe_not_supported" };
  const timeoutMs = options.timeoutMs ?? 20_000;
  let browser: Browser | null = null;
  // Written by the route handler, read by the driver below.
  const state: {
    navigationFailure: ProbeUrlFailure | null;
    extraNavigations: number;
    extraNavigationLooksLikeLogin: boolean;
    nonGetNavigation: boolean;
    /** Host name of an off host identity or login target the run refused to request. */
    offHostLogin: string | null;
    landingHop: LandingHop | null;
  } = {
    navigationFailure: null,
    extraNavigations: 0,
    extraNavigationLooksLikeLogin: false,
    nonGetNavigation: false,
    offHostLogin: null,
    landingHop: null,
  };
  let redirectLimitExceeded = false;
  const navigations = () => 1 + state.extraNavigations;
  // A refused off host identity or login target is a logged out answer: the
  // provider sent the session to sign in elsewhere. Any other refusal is a block.
  const navigationFailureEvidence = (): SessionProbeEvidence =>
    state.navigationFailure === "off_host_redirect" && state.offHostLogin !== null
      ? { ...evidence, outcome: "logged_out", reason: "login_redirect_off_host", offHost: state.offHostLogin }
      : { ...evidence, outcome: "blocked", reason: state.navigationFailure ?? "off_host_redirect" };
  try {
    try {
      browser = await chromium.launch({
        headless: true,
        ...chromiumSandboxLaunchOptions(options.sandbox),
        executablePath: options.executablePath,
        ...(options.browserEnv ? { env: options.browserEnv } : {}),
      });
    } catch {
      return { ...evidence, outcome: "error", reason: "browser_launch_failed" };
    }
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

    // Chromium never follows a redirect on its own here: a 3xx is never handed
    // to the browser, because the browser would follow the rest of the chain
    // without calling this handler again. Each hop is fetched once with
    // maxRedirects 0, checked, and then either navigated to (landing chain) or
    // fetched (subresources).
    await context.route("**/*", async (route) => {
      const request: Request = route.request();
      const method = request.method().toUpperCase();
      const requestUrl = request.url();
      const navigation = request.isNavigationRequest();
      const frameKind = frameKindOf(request, page);
      const urlFailure = probeUrlFailure(requestUrl, policy);
      const getLike = ["GET", "HEAD"].includes(method);

      if (navigation && frameKind === "other") {
        // A popup (window.open) is a navigation too: it counts toward the
        // single navigation cap and is never sent.
        state.extraNavigations += 1;
        if (looksLikeLogin(requestUrl)) state.extraNavigationLooksLikeLogin = true;
        evidence.blockedRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }

      if (navigation && frameKind === "main") {
        const hop = state.landingHop;
        if (hop === null || hop.claimed) {
          // Any main frame navigation outside the probe's own chain.
          evidence.blockedRequests += 1;
          if (urlFailure) {
            state.navigationFailure = urlFailure;
            state.offHostLogin = offHostLoginHost(requestUrl, urlFailure);
          } else if (!getLike) state.nonGetNavigation = true;
          else {
            state.extraNavigations += 1;
            if (looksLikeLogin(requestUrl)) state.extraNavigationLooksLikeLogin = true;
          }
          await route.abort("blockedbyclient");
          return;
        }
        hop.claimed = true;
        if (urlFailure || !getLike) {
          evidence.blockedRequests += 1;
          state.navigationFailure = urlFailure ?? "off_host_redirect";
          state.offHostLogin = offHostLoginHost(requestUrl, urlFailure);
          await route.abort("blockedbyclient");
          return;
        }
        let upstream: Awaited<ReturnType<typeof route.fetch>>;
        try {
          upstream = await route.fetch({ headers: hopHeaders(request), maxRedirects: 0, maxRetries: 0 });
        } catch {
          await route.abort("failed");
          return;
        }
        const status = upstream.status();
        if (status >= 300 && status < 400) {
          const location = upstream.headers()["location"];
          let next: string | null = null;
          try {
            next = location ? new URL(location, requestUrl).toString() : null;
          } catch {
            next = null;
          }
          if (next === null) {
            // A 3xx without a usable Location has no next hop and nothing safe to hand over.
            evidence.blockedRequests += 1;
            await route.abort("failed");
            return;
          }
          const nextFailure = probeUrlFailure(next, policy);
          if (nextFailure) {
            evidence.blockedRequests += 1;
            state.navigationFailure = nextFailure;
            state.offHostLogin = offHostLoginHost(next, nextFailure);
            await route.abort("blockedbyclient");
            return;
          }
          // The driver navigates to the next hop with page.goto, so the next
          // request is Chromium's own, routed back through this handler.
          hop.redirectTo = next;
          await route.abort("aborted");
          return;
        }
        await route.fulfill({ response: upstream });
        return;
      }

      // Subresources and iframe documents. A failed check aborts this one
      // request and is counted; only the main frame ends the run.
      if (urlFailure || !getLike) {
        evidence.blockedRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }
      let currentUrl = requestUrl;
      let hops = 0;
      for (;;) {
        let upstream: Awaited<ReturnType<typeof route.fetch>>;
        try {
          upstream = await route.fetch({
            url: currentUrl,
            headers: hopHeaders(request),
            maxRedirects: 0,
            maxRetries: 0,
          });
        } catch {
          await route.abort("failed");
          return;
        }
        const status = upstream.status();
        if (status < 300 || status >= 400) {
          await route.fulfill({ response: upstream });
          return;
        }
        const location = upstream.headers()["location"];
        let next: string | null = null;
        try {
          next = location ? new URL(location, currentUrl).toString() : null;
        } catch {
          next = null;
        }
        hops += 1;
        if (next === null || hops > MAX_REDIRECT_HOPS || probeUrlFailure(next, policy) !== null) {
          evidence.blockedRequests += 1;
          await route.abort("blockedbyclient");
          return;
        }
        currentUrl = next;
      }
    });
    await context.routeWebSocket("**/*", (socket) => {
      void socket.close();
    });

    // Landing chain: one routed page.goto per hop, so cookies, origin,
    // storage and the document URL are exactly what Chromium would have after
    // following the same redirects. Total gotos stay within the hop cap + 1.
    let hopUrl = new URL(landing).toString();
    let hops = 0;
    let response: Awaited<ReturnType<typeof page.goto>> = null;
    for (;;) {
      const hop: LandingHop = { claimed: false, redirectTo: null };
      state.landingHop = hop;
      let failed = false;
      try {
        response = await page.goto(hopUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      } catch {
        failed = true;
      }
      if (state.navigationFailure) break;
      if (hop.redirectTo !== null) {
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          redirectLimitExceeded = true;
          break;
        }
        hopUrl = hop.redirectTo;
        continue;
      }
      if (failed) {
        evidence.navigations = navigations();
        return { ...evidence, outcome: "error", reason: "navigation_failed" };
      }
      break;
    }
    // From here on every main frame navigation is an extra one.
    state.landingHop = null;
    evidence.navigations = navigations();
    if (state.navigationFailure) return navigationFailureEvidence();
    if (redirectLimitExceeded) return { ...evidence, outcome: "blocked", reason: "redirect_limit_exceeded" };

    const status = response?.status() ?? null;
    evidence.httpStatus = status;
    evidence.finalHost = hostOf(hopUrl);
    // Judge the HTTP response before touching the page, so a 403, 429 or 503
    // is reported as blocked even if page inspection later fails.
    if (status === 429) return { ...evidence, outcome: "blocked", reason: "http_rate_limited" };
    if (status === 403) return { ...evidence, outcome: "blocked", reason: "http_forbidden" };
    if (status === 503) return { ...evidence, outcome: "blocked", reason: "challenge_page" };
    if (status === 401) return { ...evidence, outcome: "logged_out", reason: "http_unauthorized" };

    // Bounded wait so a client rendered page can show a login form, a
    // challenge or the account marker. Passive polling only. A decisive
    // sample must be confirmed by a second one a short moment later, so a
    // single page app that flashes a password form before its session check
    // finishes is not read as logged out.
    await page.waitForTimeout(options.settleMs ?? 1_500);
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    const confirmMs = options.confirmMs ?? 600;
    const sample = async () => (await (options.sampleSignals ?? ((target) => target.evaluate(PAGE_SIGNALS_SCRIPT)))(page)) as PageSignals;
    let signals: PageSignals;
    try {
      for (;;) {
        signals = await sample();
        // A refused navigation ends the run; the page is not worth sampling again.
        if (state.navigationFailure) break;
        const decisive = signals.loginForm || signals.challenge || signals.denied || signals.marker;
        if (decisive) {
          await page.waitForTimeout(confirmMs);
          const second = await sample();
          const agrees =
            second.loginForm === signals.loginForm &&
            second.challenge === signals.challenge &&
            second.denied === signals.denied &&
            second.marker === signals.marker;
          signals = second;
          if (agrees) break;
        }
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(250);
      }
    } catch {
      evidence.navigations = navigations();
      // A script redirect that was refused can destroy the page under the
      // sampler. The refusal is the answer, not an inspection failure.
      if (state.navigationFailure) return navigationFailureEvidence();
      return { ...evidence, outcome: "error", reason: "page_inspection_failed" };
    }
    evidence.navigations = navigations();
    // A same document route change (for example a hash route to #/login)
    // shows in page.url(). An aborted extra navigation leaves an error page
    // whose address is not allowed, so the landing URL is kept then.
    const pageUrl = page.url();
    const settledUrl = isAllowedProbeUrl(pageUrl, policy) ? pageUrl : hopUrl;
    evidence.finalHost = hostOf(settledUrl);
    if (state.navigationFailure) return navigationFailureEvidence();
    if (state.nonGetNavigation) return { ...evidence, outcome: "blocked", reason: "non_get_navigation" };

    if (signals.challenge) return { ...evidence, outcome: "blocked", reason: "challenge_page" };
    if (signals.denied) return { ...evidence, outcome: "blocked", reason: "access_denied" };
    if (state.extraNavigations > 0) {
      return state.extraNavigationLooksLikeLogin
        ? { ...evidence, outcome: "logged_out", reason: "login_form" }
        : { ...evidence, outcome: "blocked", reason: "unexpected_extra_navigation" };
    }
    if (looksLikeLogin(settledUrl) || signals.loginForm) {
      return { ...evidence, outcome: "logged_out", reason: "login_form" };
    }
    if (status === null || status < 200 || status >= 300) {
      return { ...evidence, outcome: "error", reason: "http_status_unexpected" };
    }
    // Without a verdict callback the marker alone decides, as before OVD-1060.
    let verdict: SettledPageVerdict = signals.marker ? "signed_in" : "signed_out";
    if (options.settledPageVerdict) {
      verdict = await settledPageVerdictOf(page, settledUrl, options.settledPageVerdict, signals.marker);
    }
    if (verdict === "indeterminate") return { ...evidence, outcome: "error", reason: "settled_page_indeterminate" };
    if (verdict === "signed_out") {
      return { ...evidence, outcome: "logged_out", reason: signals.marker ? "login_form" : "no_authenticated_marker" };
    }
    const reason: SessionProbeReason = signals.marker ? "authenticated_marker_found" : "terminal_signals_ready";
    if (options.onAuthenticated) {
      try {
        await options.onAuthenticated((await context.storageState()) as StorageStateInput);
      } catch {
        return { ...evidence, outcome: "error", reason: "storage_state_capture_failed" };
      }
    }
    return { ...evidence, outcome: "authenticated", reason };
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
 * One read only call to the account resource of the RMFG REST API. Host and
 * origin match RMFG_API_ORIGIN in adapters/rmfgHttpTransport.ts. The path
 * comes from RMFG's OpenAPI (GET /v1/account) and has not been checked against
 * a live account response from this repository.
 */
export const RMFG_PROBE_ENDPOINT: string | null = "https://api.rmfg.com/v1/account";

/**
 * Minimal fetch transport for the probe. It sends one GET with a bearer key,
 * follows no redirect, never reads the body and returns only the status. The
 * key is never placed in an error, so a failure carries no secret.
 */
export function createRmfgFetchTransport(fetchImpl: typeof fetch = fetch): RmfgProbeTransport {
  return async ({ method, url, apiKey, timeoutMs }) => {
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status };
  };
}

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
     * Test seam used by the CLI wrapper test. Accepted only as a plain
     * http://127.0.0.1:<port> URL, which narrows the probe to that one
     * loopback host. Any other value throws, so a mistyped seam can never
     * fall back to a real provider.
     */
    loopbackFixtureUrl?: string;
    executablePath?: string;
  },
): Promise<SessionProbeEvidence> {
  const now = deps.now ?? (() => new Date());
  let target = resolveSessionProbeTarget(args.provider);
  let fixture: string | null = null;
  if (deps.loopbackFixtureUrl !== undefined) {
    if (!LOOPBACK_FIXTURE_URL.test(deps.loopbackFixtureUrl)) {
      throw new Error("The loopback fixture URL must be plain http://127.0.0.1:<port>.");
    }
    fixture = deps.loopbackFixtureUrl;
  }
  if (fixture && target.adapterKind === "portal") {
    target = { ...target, landingUrl: fixture, allowedHosts: ["127.0.0.1"] };
  }
  try {
    if (target.adapterKind === "api") {
      // Decide before reading the secret: with no endpoint or transport there is nothing to call.
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
