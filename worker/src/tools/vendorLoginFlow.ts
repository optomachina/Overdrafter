import type { BrowserContext, Frame, Locator, Page, Request, Route } from "playwright";
import { isAllowedProviderUrl, isAllowedProviderWebSocketUrl } from "../adapters/providerPortalKernel.js";
import type { LoginCredential } from "./vendorLoginBitwarden.js";
import { secretForms, sessionStateAccepted, signedInEvidence, type VendorSessionProfile } from "./vendorSession.js";

/**
 * OVD-1060: fills one vendor's login form with generic heuristics and stops,
 * without retrying, at anything it does not recognize.
 *
 * - The password is typed only into a visible sign-in field of the main frame
 *   while the page is on one of the vendor's reviewed hosts, re-checked
 *   immediately before typing and again before the single submit.
 * - A form that submits to another host or into another frame or window is a
 *   stop before anything is typed.
 * - A credential may only travel to an exact reviewed origin: https on the
 *   default port to one of the vendor's session hosts or definition hosts.
 *   A subdomain, another port or the off-host subresource allowlist is not
 *   one, as in the portal kernel.
 * - Script navigation of the main frame to another host is aborted, popups
 *   never load, and a state-changing request (POST and the like) from any
 *   frame to an origin that is not reviewed is aborted. Workers are disabled
 *   before any page script runs because socket routing only covers frames. A
 *   WebSocket to anything but a reviewed wss origin is refused. Once the
 *   password is typed, any navigation of a child frame to such an origin,
 *   and any request to one whose URL carries the password, is aborted too.
 *   Document redirects are refused so the worker policy cannot be skipped.
 *   Other server redirects bypass routing; a submission redirected to an
 *   unreviewed host is detected afterwards and stops without saving.
 * - A visible CAPTCHA (in any frame), a second-factor prompt, an unknown page,
 *   a sign-up form, or a rejected login is a stop. Nothing is solved,
 *   bypassed or resubmitted, and no stealth or anti-detection measure is used.
 * - Success needs positive evidence on the vendor's landing page: a log out
 *   control, or content that `signedInEvidence` accepts. The vendor
 *   definition's own classifier must also accept the page.
 */

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type LoginStopOutcome = "captcha" | "two_factor" | "unknown_page" | "login_failed";

export type LoginFlowResult =
  | { outcome: "authenticated"; storageState: StorageState }
  | { outcome: LoginStopOutcome; reason: string; host: string | null };

/** Reviewed, non-secret selector hints for a vendor whose page defeats the heuristics. */
export type VendorLoginOverrides = {
  openLogin?: string;
  username?: string;
  password?: string;
  submit?: string;
};

/**
 * No vendor needs a hint yet. Add one only from a reviewed observation of the
 * live login page; never put captured page content in this file.
 */
export const VENDOR_LOGIN_OVERRIDES: Partial<Record<VendorSessionProfile["vendor"], VendorLoginOverrides>> = {};

export type LoginFlowTimings = {
  settleMs: number;
  outcomeMs: number;
  pollMs: number;
};

const DEFAULT_TIMINGS: LoginFlowTimings = { settleMs: 8_000, outcomeMs: 25_000, pollMs: 500 };

type PageSignals = {
  captcha: boolean;
  passwordVisible: boolean;
  otpField: boolean;
  twoFactorText: boolean;
  approvalPrompt: boolean;
  loginError: boolean;
  locked: boolean;
  logoutControl: boolean;
};

/**
 * Read-only DOM inspection, kept as a plain string for the reason given on
 * PAGE_SIGNALS_SCRIPT in providerSessionProbe.ts (tsx helper names do not
 * exist in the page). It runs in every frame; only the CAPTCHA flag is taken
 * from child frames. An invisible reCAPTCHA badge or a hidden challenge frame
 * is not a challenge; a visible widget, challenge frame or interstitial is.
 */
const LOGIN_SIGNALS_SCRIPT = `(() => {
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0;
  };
  const frames = Array.from(document.querySelectorAll("iframe"));
  const src = (frame) => (frame.getAttribute("src") || "").toLowerCase();
  const recaptchaWidget = frames.some((f) => /\\/recaptcha\\/(api2|enterprise)\\/anchor/.test(src(f)) && !/[?&]size=invisible/.test(src(f)) && visible(f));
  const recaptchaChallenge = frames.some((f) => /\\/recaptcha\\/(api2|enterprise)\\/bframe/.test(src(f)) && visible(f) && f.getBoundingClientRect().height > 100);
  const otherWidget = frames.some((f) => /hcaptcha\\.com|challenges\\.cloudflare\\.com|captcha-delivery\\.com|arkoselabs\\.com|funcaptcha|geetest|awswaf|perimeterx|px-cloud\\.net|px-cdn\\.net/.test(src(f)) && visible(f));
  const widgetElement = Array.from(document.querySelectorAll('#px-captcha, .geetest_panel, .geetest_holder, #captcha-container, awswaf-captcha, [id^="ddv1-captcha"], #arkose, [data-callback="onCaptcha"]')).some(visible);
  const cloudflare = typeof window._cf_chl_opt !== "undefined" || document.querySelector('#challenge-form, form[action*="__cf_chl"], [id^="cf-chl-"]') !== null;
  const title = (document.title || "").toLowerCase();
  const challengeTitle = /^\\s*(just a moment|attention required|checking your browser|verifying you are human|verify you are human|one more step|ddos-guard|access to this page has been denied|human verification)/.test(title);
  const passwordVisible = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  const otpField = Array.from(document.querySelectorAll("input")).some((el) => visible(el) && (
    (el.getAttribute("autocomplete") || "").toLowerCase() === "one-time-code" ||
    /(otp|totp|mfa|2fa|one.?time|verification.?code|security.?code|auth.?code)/i.test([el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" "))
  ));
  const text = ((document.body && document.body.innerText) || "").slice(0, 20000);
  const twoFactorText = /\\b(two[- ]factor|two[- ]step|2[- ]step|multi[- ]factor|verification code|authenticator app|enter the code|security code|one[- ]time (pass)?code)\\b/i.test(text);
  const approvalPrompt = /\\b(approve (the |this )?(sign[- ]?in|log[- ]?in|request)|open (your|the) authenticator|enter the (\\d-digit )?code (we|that we) (sent|texted|emailed)|check your (phone|email) (for|to) (a|the) code)\\b/i.test(text);
  const alerts = Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"], .error, .alert, .invalid-feedback, .mat-error, .help-block'))
    .filter(visible).map((el) => el.innerText || "").join("\\n");
  const credentialError = /\\b(invalid|incorrect|wrong|not recogni[sz]ed|does not match|failed|unable to (log|sign) ?in)\\b/i.test(alerts) ||
    /\\b(invalid (email|username|user name|password|credentials|login)|incorrect (email|username|password)|wrong (email|username|password)|(email|username|password) (is )?(incorrect|invalid))\\b/i.test(text);
  const locked = /\\b(account (is |has been )?(locked|disabled|suspended)|too many (failed |login )?attempts|temporarily (locked|blocked))\\b/i.test(text);
  const logoutControl =
    document.querySelector('a[href*="logout" i], a[href*="log-out" i], a[href*="signout" i], a[href*="sign-out" i], [data-testid*="logout" i], [data-testid*="sign-out" i]') !== null ||
    Array.from(document.querySelectorAll('a, button, [role="menuitem"]')).some((el) => /^\\s*(log\\s?out|sign\\s?out)\\s*$/i.test(el.textContent || ""));
  return {
    captcha: recaptchaWidget || recaptchaChallenge || otherWidget || widgetElement || cloudflare || challengeTitle,
    passwordVisible,
    otpField,
    twoFactorText,
    approvalPrompt,
    loginError: credentialError,
    locked,
    logoutControl,
  };
})()`;

const INPUT_EXCLUSIONS = [
  ":not([type='hidden']):not([type='password']):not([type='search']):not([type='checkbox']):not([type='radio'])",
  ":not([type='submit']):not([type='button']):not([readonly]):not([disabled])",
  ":not([name*='search' i]):not([id*='search' i]):not([placeholder*='search' i]):not([aria-label*='search' i])",
  ":not([name*='newsletter' i]):not([id*='newsletter' i]):not([name*='subscribe' i]):not([id*='subscribe' i])",
].join("");

const USERNAME_SELECTORS = [
  "input[autocomplete~='username' i]",
  "input[type='email']",
  "input[name*='email' i]",
  "input[id*='email' i]",
  "input[name*='user' i]",
  "input[id*='user' i]",
  "input[name*='login' i]",
  "input[id*='login' i]",
  "input[type='text']",
  "input:not([type])",
].map((selector) => `${selector}${INPUT_EXCLUSIONS}`);

/** A sign-in password field; a field the page marks as a new password belongs to sign-up or reset. */
const SIGN_IN_PASSWORD = "input[type='password']:not([autocomplete~='new-password' i])";
const SUBMIT_IN_FORM = "button[type='submit'], input[type='submit'], button:not([type])";
const SUBMIT_TEXT = /^\s*(log ?in|sign ?in|continue|next|submit)\s*$/i;
const NEXT_TEXT = /^\s*(next|continue|log ?in|sign ?in)\s*$/i;
const REGISTRATION_TEXT = /\b(sign ?up|register|create (an |your )?account|join|subscribe|reset|send (a )?(reset )?link)\b/i;
/** Text only a sign-up or reset form carries; a sign-in form's "Sign up" link does not count. */
const REGISTRATION_FORM_TEXT = /\b(create (an |your )?account|confirm (your )?password|repeat (your )?password|choose a password|reset (your )?password|new password)\b/i;
const EXPLICIT_SIGN_IN_TEXT = /^\s*(log ?in|sign ?in)\s*$/i;
const SIGN_IN_CONTEXT_TEXT = /\b(log ?in|sign ?in)\b/i;
const OPEN_LOGIN_TEXT = /^\s*(log ?in|sign ?in)(\s*(\/|\||or|&)\s*(register|sign ?up))?\s*$/i;
const LOGIN_ROUTE = /(^|\/)(log-?in|sign-?in|signin|auth|authenticate|session\/new|users\/sign_in)(\/|$|\?)/i;
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function looksLikeLoginRoute(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return LOGIN_ROUTE.test(url.pathname) || LOGIN_ROUTE.test(url.hash.replace(/^#!?/, ""));
  } catch {
    return false;
  }
}

class LoginStop extends Error {
  constructor(readonly outcome: LoginStopOutcome, readonly reason: string, readonly host: string | null) {
    super(`${outcome}: ${reason}`);
  }
}

async function firstVisible(scope: Page | Frame | Locator, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidate = scope.locator(selector).filter({ visible: true }).first();
    if ((await candidate.count().catch(() => 0)) > 0) return candidate;
  }
  return null;
}

async function labelOf(candidate: Locator): Promise<string> {
  return (await candidate.innerText({ timeout: 1_000 }).catch(() => ""))
    || (await candidate.getAttribute("value").catch(() => null))
    || (await candidate.getAttribute("aria-label").catch(() => null))
    || "";
}

async function firstVisibleByText(scope: Page | Frame | Locator, selector: string, text: RegExp): Promise<Locator | null> {
  const candidates = scope.locator(selector).filter({ visible: true });
  const count = Math.min(await candidates.count().catch(() => 0), 40);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (text.test(await labelOf(candidate))) return candidate;
  }
  return null;
}

type GuardedPage = {
  page: Page;
  timings: LoginFlowTimings;
  allowed: (rawUrl: string) => boolean;
  refusedHost: () => string | null;
  redirectedSubmissionHost: () => string | null;
  blockedSubmissionHost: () => string | null;
  /** From here on, child-frame navigation and credential-bearing URLs to unreviewed hosts are aborted. */
  markPasswordTyped: (password: string) => void;
  markSubmitted: () => void;
  signals: () => Promise<PageSignals | null>;
  settle: () => Promise<void>;
  open: (url: string, reason: string) => Promise<void>;
  assertSafePage: () => Promise<void>;
};

/**
 * Exact hosts a credential may reach: the session hosts and the definition's
 * own hosts. The off-host allowlist admits only body-less subresources in the
 * kernel, so it is no credential destination here either.
 */
function submissionHosts(profile: VendorSessionProfile): readonly string[] {
  return [...new Set([...profile.sessionHosts, ...profile.definition.allowedHosts])];
}

/** An exact reviewed origin, by the kernel's own URL check: https, default port, no user info. */
function submissionHostAllowed(rawUrl: string, profile: VendorSessionProfile): boolean {
  return isAllowedProviderUrl(rawUrl, submissionHosts(profile));
}

type FrameKind = "main" | "sub" | "other";

function frameKindOf(request: Request, page: Page): FrameKind {
  // request.frame() throws for a navigation that opens a popup.
  try {
    const frame = request.frame();
    if (frame === page.mainFrame()) return "main";
    return frame.page() === page ? "sub" : "other";
  } catch {
    return "other";
  }
}

/**
 * Opens the one page an attempt uses and installs the request guard
 * described at the top of this file.
 */
async function guardedPage(
  context: BrowserContext,
  profile: VendorSessionProfile,
  timings: LoginFlowTimings,
): Promise<GuardedPage> {
  const page = await context.newPage();
  const allowed = (rawUrl: string) => isAllowedProviderUrl(rawUrl, profile.sessionHosts);
  let refusedNavigationHost: string | null = null;
  let redirectedSubmissionHost: string | null = null;
  let blockedSubmissionHost: string | null = null;
  let submitted = false;
  let passwordForms: string[] = [];
  let documentGuardFailed = false;

  context.on("page", (popup) => {
    if (popup !== page) void popup.close().catch(() => undefined);
  });
  // Server redirects bypass routing; a redirected submission is detected here instead.
  context.on("request", (request) => {
    if (!request.redirectedFrom() || READ_ONLY_METHODS.has(request.method().toUpperCase())) return;
    if (!submissionHostAllowed(request.url(), profile)) redirectedSubmissionHost ??= hostOf(request.url());
  });
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = request.url();
    const navigation = request.isNavigationRequest();
    const frameKind = frameKindOf(request, page);
    if (navigation && frameKind === "other") {
      await route.abort("blockedbyclient");
      return;
    }
    if (navigation && frameKind === "main" && !allowed(url)) {
      refusedNavigationHost ??= hostOf(url);
      await route.abort("blockedbyclient");
      return;
    }
    const offHost = !submissionHostAllowed(url, profile);
    const stateChanging = !READ_ONLY_METHODS.has(request.method().toUpperCase());
    const afterPassword = passwordForms.length > 0;
    const carriesPassword = afterPassword && passwordForms.some((form) => url.includes(form));
    // A child frame's or worker's script can POST the filled password as well as the page's own.
    if (offHost && (stateChanging || (afterPassword && navigation) || carriesPassword)) {
      if (submitted || carriesPassword) blockedSubmissionHost ??= hostOf(url);
      await route.abort("blockedbyclient");
      return;
    }
    if (navigation) {
      // Frame socket routing does not cover workers. A browser-enforced CSP
      // refuses dedicated/shared/service workers (including blob/data URLs)
      // before any script runs, and is inherited by about:blank/srcdoc frames.
      // Never follow redirects in the fetch transport or let an unguarded
      // redirect destination load. Refuse if the policy cannot be installed.
      try {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
        try {
          if (response.status() >= 300 && response.status() < 400) throw new Error("document_redirect");
          const headers = response.headers();
          headers["content-security-policy"] = [headers["content-security-policy"], "worker-src 'none'"].filter(Boolean).join(", ");
          await route.fulfill({ status: response.status(), headers, body: await response.body() });
        } finally {
          await response.dispose();
        }
      } catch {
        documentGuardFailed = true;
        await route.abort("blockedbyclient").catch(() => undefined);
      }
      return;
    }
    await route.fallback();
  });
  // Frame sockets only; workers are refused before page scripts run.
  await context.routeWebSocket("**/*", async (socket) => {
    if (isAllowedProviderWebSocketUrl(socket.url(), submissionHosts(profile))) {
      socket.connectToServer();
      return;
    }
    if (passwordForms.length > 0) blockedSubmissionHost ??= hostOf(socket.url());
    await socket.close({ code: 1008, reason: "unexpected_origin" });
  });

  const signals = async (): Promise<PageSignals | null> => {
    let main: PageSignals;
    try {
      main = (await page.mainFrame().evaluate(LOGIN_SIGNALS_SCRIPT)) as PageSignals;
    } catch {
      return null;
    }
    const children = page.frames().filter((frame) => frame !== page.mainFrame());
    const childCaptcha = await Promise.all(children.map((frame) => frame.evaluate(LOGIN_SIGNALS_SCRIPT)
      .then((result) => (result as PageSignals).captcha, () => false)));
    return { ...main, captcha: main.captcha || childCaptcha.some(Boolean) };
  };
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: timings.settleMs }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: timings.settleMs }).catch(() => undefined);
  };
  /** Every stop a page can show before anything is typed or clicked; an unreadable page is a stop too. */
  const assertSafePage = async () => {
    if (documentGuardFailed) throw new LoginStop("unknown_page", "worker_policy_unavailable", hostOf(page.url()));
    if (refusedNavigationHost) throw new LoginStop("unknown_page", "off_host_navigation", refusedNavigationHost);
    if (redirectedSubmissionHost) throw new LoginStop("unknown_page", "submission_redirected_off_host", redirectedSubmissionHost);
    if (!allowed(page.url())) throw new LoginStop("unknown_page", "off_host_page", hostOf(page.url()));
    let current = await signals();
    if (!current) {
      await page.waitForTimeout(timings.pollMs);
      current = await signals();
    }
    const host = hostOf(page.url());
    if (!current) throw new LoginStop("unknown_page", "page_inspection_failed", host);
    if (current.captcha) throw new LoginStop("captcha", "visible_challenge", host);
    if (current.otpField) throw new LoginStop("two_factor", "one_time_code_field", host);
    if (current.approvalPrompt) throw new LoginStop("two_factor", "approval_prompt", host);
    if (current.locked) throw new LoginStop("login_failed", "account_locked_or_rate_limited", host);
    if (current.loginError) throw new LoginStop("login_failed", "error_shown_before_submit", host);
  };
  const open = async (url: string, reason: string) => {
    const reached = await page.goto(url, { waitUntil: "domcontentloaded" }).then(() => true, () => false);
    if (!reached && !refusedNavigationHost && !allowed(page.url())) throw new LoginStop("unknown_page", reason, hostOf(url));
    await settle();
  };
  return {
    page,
    timings,
    allowed,
    refusedHost: () => refusedNavigationHost,
    redirectedSubmissionHost: () => redirectedSubmissionHost,
    blockedSubmissionHost: () => blockedSubmissionHost,
    markPasswordTyped: (password) => {
      passwordForms = secretForms(password);
    },
    markSubmitted: () => {
      submitted = true;
    },
    signals,
    settle,
    open,
    assertSafePage,
  };
}

/** Opens the landing page and requires positive signed-in evidence the vendor's classifier also accepts. */
async function confirmLanding(guarded: GuardedPage, profile: VendorSessionProfile): Promise<void> {
  const { page } = guarded;
  await guarded.open(profile.landingUrl, "landing_page_unreachable");
  await guarded.assertSafePage();
  const host = hostOf(page.url());
  const snapshot = {
    url: page.url(),
    bodyText: await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    passwordInputCount: await page.locator("input[type='password']").count().catch(() => 0),
  };
  const state = await profile.definition.hooks.classifyPortalState(snapshot);
  if (state === "captcha") throw new LoginStop("captcha", "terminal_signal_captcha", host);
  if (state === "unexpected_origin") throw new LoginStop("unknown_page", "landing_unexpected_origin", host);
  if (state === "unavailable") throw new LoginStop("unknown_page", "portal_unavailable", host);
  if (!sessionStateAccepted(state)) throw new LoginStop("login_failed", "landing_still_requires_login", host);
  const current = await guarded.signals();
  // A second-factor page can carry a log out control too.
  const signedIn = (current?.logoutControl === true && !current.passwordVisible && !current.twoFactorText)
    || await signedInEvidence(snapshot, profile.definition);
  if (!signedIn) throw new LoginStop("login_failed", "landing_not_signed_in", host);
}

function stopResult(error: unknown, page: Page | null): LoginFlowResult {
  if (error instanceof LoginStop) return { outcome: error.outcome, reason: error.reason, host: error.host };
  // Playwright messages can quote selectors or page text; keep only a fixed reason.
  return { outcome: "unknown_page", reason: "browser_step_failed", host: page ? hostOf(page.url()) : null };
}

/**
 * Re-judges a captured session in a fresh context that holds nothing but
 * that session, so a cookie lost to host scoping shows up before anything
 * is saved. Returns the context's state afterwards, since a visit may rotate
 * session tokens.
 */
export async function confirmStorageState(input: {
  profile: VendorSessionProfile;
  context: BrowserContext;
  timings?: Partial<LoginFlowTimings>;
}): Promise<LoginFlowResult> {
  let guarded: GuardedPage | null = null;
  try {
    guarded = await guardedPage(input.context, input.profile, { ...DEFAULT_TIMINGS, ...input.timings });
    await confirmLanding(guarded, input.profile);
    return { outcome: "authenticated", storageState: await input.context.storageState() };
  } catch (error) {
    return stopResult(error, guarded?.page ?? null);
  }
}

/**
 * Runs one login attempt in a fresh context the caller owns. The caller
 * closes the browser; this function never retries.
 */
export async function runVendorLoginFlow(input: {
  profile: VendorSessionProfile;
  credential: LoginCredential;
  context: BrowserContext;
  overrides?: VendorLoginOverrides;
  timings?: Partial<LoginFlowTimings>;
}): Promise<LoginFlowResult> {
  const { profile, credential, context } = input;
  const overrides = input.overrides ?? VENDOR_LOGIN_OVERRIDES[profile.vendor] ?? {};
  let guarded: GuardedPage | null = null;
  try {
    guarded = await guardedPage(context, profile, { ...DEFAULT_TIMINGS, ...input.timings });
    await attemptLogin(guarded, profile, credential, overrides);
    await confirmLanding(guarded, profile);
    return { outcome: "authenticated", storageState: await context.storageState() };
  } catch (error) {
    return stopResult(error, guarded?.page ?? null);
  }
}

async function attemptLogin(
  guarded: GuardedPage,
  profile: VendorSessionProfile,
  credential: LoginCredential,
  overrides: VendorLoginOverrides,
): Promise<void> {
  const { page } = guarded;
  const frame = page.mainFrame();

  const formOf = async (field: Locator): Promise<Locator | null> => {
    const form = field.locator("xpath=ancestor::form[1]");
    return (await form.count().catch(() => 0)) > 0 ? form : null;
  };

  /** The visible password field of a sign-in form; a sign-up form has two password fields. */
  const findPassword = async (): Promise<Locator | null> => {
    if (overrides.password) return firstVisible(frame, [overrides.password]);
    const preferred = await firstVisible(frame, ["input[type='password'][autocomplete~='current-password' i]"]);
    if (preferred) return preferred;
    const fields = frame.locator(SIGN_IN_PASSWORD).filter({ visible: true });
    const count = Math.min(await fields.count().catch(() => 0), 5);
    for (let index = 0; index < count; index += 1) {
      const field = fields.nth(index);
      const form = await formOf(field);
      const inForm = form ? await form.locator("input[type='password']").count().catch(() => 2) : 1;
      if (inForm === 1) return field;
    }
    return null;
  };

  /**
   * A form must submit to a reviewed host in this same window. Anything else
   * is a stop before a credential is typed into it.
   */
  const assertFormDestination = async (form: Locator | null) => {
    if (!form) return;
    const host = hostOf(page.url());
    const action = await form.getAttribute("action").catch(() => null);
    if (action && action.trim() && !action.trim().toLowerCase().startsWith("javascript:")) {
      let target: string;
      try {
        target = new URL(action, page.url()).toString();
      } catch {
        throw new LoginStop("unknown_page", "form_action_unreadable", host);
      }
      if (!submissionHostAllowed(target, profile)) throw new LoginStop("unknown_page", "form_submits_off_host", hostOf(target));
    }
    const windowTarget = (await form.getAttribute("target").catch(() => null))?.trim().toLowerCase() ?? "";
    if (windowTarget && windowTarget !== "_self") throw new LoginStop("unknown_page", "form_targets_other_window", host);
  };

  /** A sign-up or reset form is a stop; a generic button needs sign-in context around it. */
  const assertSignInForm = async (form: Locator | null, label: string) => {
    if (EXPLICIT_SIGN_IN_TEXT.test(label)) return;
    const formText = form ? await form.innerText({ timeout: 2_000 }).catch(() => "") : "";
    if (REGISTRATION_FORM_TEXT.test(formText)) throw new LoginStop("unknown_page", "registration_or_reset_form", hostOf(page.url()));
    const title = await page.title().catch(() => "");
    if (!SIGN_IN_CONTEXT_TEXT.test(formText) && !SIGN_IN_CONTEXT_TEXT.test(title) && !looksLikeLoginRoute(page.url())) {
      throw new LoginStop("unknown_page", "sign_in_form_unconfirmed", hostOf(page.url()));
    }
  };

  /**
   * The form's submit control, only when its label is sign-in vocabulary (or
   * it is the form's single unlabeled control) and the form is a sign-in
   * form. A sign-up, reset or subscribe control is a stop, never a click.
   */
  const chooseSubmit = async (form: Locator | null, text: RegExp, allowUnlabeled: boolean): Promise<Locator | null> => {
    if (overrides.submit) return firstVisible(frame, [overrides.submit]);
    if (!form) {
      const control = await firstVisibleByText(frame, "button, [role='button'], input[type='submit']", text);
      if (control) await assertSignInForm(null, await labelOf(control));
      return control;
    }
    const controls = form.locator(SUBMIT_IN_FORM).filter({ visible: true });
    const count = Math.min(await controls.count().catch(() => 0), 10);
    const labels: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const label = await labelOf(controls.nth(index));
      if (text.test(label)) {
        await assertSignInForm(form, label);
        return controls.nth(index);
      }
      labels.push(label);
    }
    if (labels.some((label) => REGISTRATION_TEXT.test(label))) {
      throw new LoginStop("unknown_page", "registration_or_reset_form", hostOf(page.url()));
    }
    if (allowUnlabeled && labels.length === 1 && labels[0].trim() === "") {
      await assertSignInForm(form, "");
      return controls.first();
    }
    if (labels.length > 0) throw new LoginStop("unknown_page", "submit_control_unrecognized", hostOf(page.url()));
    const control = await firstVisibleByText(form, "button, [role='button']", text);
    if (control) await assertSignInForm(form, await labelOf(control));
    return control;
  };

  await guarded.open(profile.loginUrl, "login_page_unreachable");

  let usernameSubmitted = false;
  let openedLogin = false;
  let password: Locator | null = null;
  for (let stage = 0; stage < 4 && !password; stage += 1) {
    await guarded.assertSafePage();
    password = await findPassword();
    if (password) break;

    const username = await firstVisible(frame, overrides.username ? [overrides.username] : USERNAME_SELECTORS);
    // A username-first step only on a sign-in route or after opening the sign-in control,
    // only behind a Next or sign-in button, and outside a form only on a sign-in route,
    // so a newsletter or search box on a home page is never filled.
    if (username && !usernameSubmitted && (openedLogin || looksLikeLoginRoute(page.url()))) {
      const form = await formOf(username);
      if (!form && !looksLikeLoginRoute(page.url())) throw new LoginStop("unknown_page", "username_step_outside_form", hostOf(page.url()));
      await assertFormDestination(form);
      const next = await chooseSubmit(form, NEXT_TEXT, false);
      if (!next) throw new LoginStop("unknown_page", "username_step_without_next", hostOf(page.url()));
      await username.fill(credential.username.reveal());
      await guarded.assertSafePage();
      await next.click({ timeout: 5_000 });
      usernameSubmitted = true;
      await guarded.settle();
      continue;
    }
    if (!openedLogin) {
      const control = overrides.openLogin
        ? await firstVisible(frame, [overrides.openLogin])
        : await firstVisibleByText(frame, "a, button, [role='button']", OPEN_LOGIN_TEXT);
      if (control) {
        openedLogin = true;
        await control.click({ timeout: 5_000 });
        await guarded.settle();
        continue;
      }
    }
    break;
  }
  if (!password) throw new LoginStop("unknown_page", "login_form_not_found", hostOf(page.url()));

  const form = await formOf(password);
  const username = await firstVisible(form ?? frame, overrides.username ? [overrides.username] : USERNAME_SELECTORS);
  if (!username && !usernameSubmitted) throw new LoginStop("unknown_page", "username_field_not_found", hostOf(page.url()));
  await assertFormDestination(form);
  const submit = await chooseSubmit(form, SUBMIT_TEXT, true);

  await guarded.assertSafePage();
  if (username) await username.fill(credential.username.reveal());
  // Last checks immediately before the password is typed, and again before the single submit.
  await guarded.assertSafePage();
  guarded.markPasswordTyped(credential.password.reveal());
  await password.fill(credential.password.reveal());
  await guarded.assertSafePage();
  guarded.markSubmitted();
  if (submit) await submit.click({ timeout: 5_000 });
  else await password.press("Enter");
  await waitForLoginOutcome(guarded);
}

/** Polls after the single submit until the form is gone, a stop shows, or time runs out. */
async function waitForLoginOutcome(guarded: GuardedPage): Promise<void> {
  const { page, timings } = guarded;
  const deadline = Date.now() + timings.outcomeMs;
  let formGoneOnce = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(timings.pollMs);
    const refused = guarded.refusedHost();
    if (refused) throw new LoginStop("unknown_page", "off_host_navigation", refused);
    const redirected = guarded.redirectedSubmissionHost();
    if (redirected) throw new LoginStop("unknown_page", "submission_redirected_off_host", redirected);
    const current = await guarded.signals();
    if (!current) continue;
    const host = hostOf(page.url());
    if (current.captcha) throw new LoginStop("captcha", "visible_challenge_after_submit", host);
    if (current.otpField || current.approvalPrompt || (current.twoFactorText && !current.passwordVisible)) {
      throw new LoginStop("two_factor", "second_factor_prompt", host);
    }
    if (current.locked) throw new LoginStop("login_failed", "account_locked_or_rate_limited", host);
    if (current.passwordVisible && current.loginError) throw new LoginStop("login_failed", "credentials_rejected", host);
    if (!current.passwordVisible && !looksLikeLoginRoute(page.url())) {
      if (formGoneOnce) return;
      formGoneOnce = true;
    } else {
      formGoneOnce = false;
    }
  }
  const blocked = guarded.blockedSubmissionHost();
  if (blocked) throw new LoginStop("login_failed", "submission_to_unreviewed_host_blocked", blocked);
  throw new LoginStop("login_failed", "still_on_login_form", hostOf(page.url()));
}
