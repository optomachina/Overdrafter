import type { BrowserContext, Frame, Locator, Page, Route } from "playwright";
import { isAllowedProviderUrl } from "../adapters/providerPortalKernel.js";
import type { LoginCredential } from "./vendorLoginBitwarden.js";
import { sessionStateAccepted, type VendorSessionProfile } from "./vendorSession.js";

/**
 * OVD-1060: fills one vendor's login form with generic heuristics and stops,
 * without retrying, at anything it does not recognize.
 *
 * - The password is typed only into a visible field of the main frame while
 *   the page is on one of the vendor's reviewed hosts. Main-frame navigation
 *   to any other host is aborted and ends the attempt.
 * - A visible CAPTCHA, a second-factor prompt, an unknown page, or a
 *   rejected login is a stop. Nothing is solved, bypassed or resubmitted, and
 *   no stealth or anti-detection measure is used.
 * - Success is judged on the vendor's landing page by the vendor definition's
 *   own terminal-signal classifier, exactly as the kernel would judge it.
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
  loginError: boolean;
  locked: boolean;
};

/**
 * Read-only DOM inspection, kept as a plain string for the reason given on
 * PAGE_SIGNALS_SCRIPT in providerSessionProbe.ts (tsx helper names do not
 * exist in the page). An invisible reCAPTCHA badge or a hidden challenge
 * frame is not a challenge; a visible checkbox widget or challenge is.
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
  const hcaptcha = frames.some((f) => /hcaptcha\\.com/.test(src(f)) && visible(f));
  const turnstile = frames.some((f) => /challenges\\.cloudflare\\.com/.test(src(f)) && visible(f));
  const cloudflare = typeof window._cf_chl_opt !== "undefined" || document.querySelector('#challenge-form, form[action*="__cf_chl"], [id^="cf-chl-"]') !== null;
  const title = (document.title || "").toLowerCase();
  const challengeTitle = /^\\s*(just a moment|attention required|checking your browser|verifying you are human|verify you are human|one more step|ddos-guard)/.test(title);
  const passwordVisible = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  const otpField = Array.from(document.querySelectorAll("input")).some((el) => visible(el) && (
    (el.getAttribute("autocomplete") || "").toLowerCase() === "one-time-code" ||
    /(otp|totp|mfa|2fa|one.?time|verification.?code|security.?code|auth.?code)/i.test([el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" "))
  ));
  const text = ((document.body && document.body.innerText) || "").slice(0, 20000);
  const twoFactorText = /\\b(two[- ]factor|two[- ]step|2[- ]step|multi[- ]factor|verification code|authenticator app|enter the code|security code|one[- ]time (pass)?code)\\b/i.test(text);
  const alerts = Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"], .error, .alert, .invalid-feedback, .mat-error, .help-block'))
    .filter(visible).map((el) => el.innerText || "").join("\\n");
  const credentialError = /\\b(invalid|incorrect|wrong|not recogni[sz]ed|does not match|failed|unable to (log|sign) ?in)\\b/i.test(alerts) ||
    /\\b(invalid (email|username|user name|password|credentials|login)|incorrect (email|username|password)|wrong (email|username|password)|(email|username|password) (is )?(incorrect|invalid))\\b/i.test(text);
  const locked = /\\b(account (is |has been )?(locked|disabled|suspended)|too many (failed |login )?attempts|temporarily (locked|blocked))\\b/i.test(text);
  return {
    captcha: recaptchaWidget || recaptchaChallenge || hcaptcha || turnstile || cloudflare || challengeTitle,
    passwordVisible,
    otpField,
    twoFactorText,
    loginError: credentialError,
    locked,
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

const SUBMIT_IN_FORM = ["button[type='submit']", "input[type='submit']", "button:not([type])"];
const SUBMIT_TEXT = /^\s*(log ?in|sign ?in|continue|next|submit)\s*$/i;
const NEXT_TEXT = /^\s*(next|continue|log ?in|sign ?in)\s*$/i;
const OPEN_LOGIN_TEXT = /^\s*(log ?in|sign ?in)(\s*(\/|\||or|&)\s*(register|sign ?up))?\s*$/i;
const LOGIN_ROUTE = /(^|\/)(log-?in|sign-?in|signin|auth|authenticate|session\/new|users\/sign_in)(\/|$|\?)/i;

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

async function firstVisibleByText(scope: Page | Frame | Locator, selector: string, text: RegExp): Promise<Locator | null> {
  const candidates = scope.locator(selector).filter({ visible: true });
  const count = Math.min(await candidates.count().catch(() => 0), 40);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const label = (await candidate.innerText({ timeout: 1_000 }).catch(() => ""))
      || (await candidate.getAttribute("value").catch(() => null))
      || (await candidate.getAttribute("aria-label").catch(() => null))
      || "";
    if (text.test(label)) return candidate;
  }
  return null;
}

type GuardedPage = {
  page: Page;
  timings: LoginFlowTimings;
  allowed: (rawUrl: string) => boolean;
  refusedHost: () => string | null;
  signals: () => Promise<PageSignals | null>;
  settle: () => Promise<void>;
  open: (url: string, reason: string) => Promise<void>;
  assertSafePage: () => Promise<void>;
};

/**
 * Opens the one page an attempt uses. Main-frame navigation off the
 * vendor's reviewed hosts is aborted and remembered; popups are closed.
 * Subresources (the vendor's own CAPTCHA script included) load normally.
 */
async function guardedPage(
  context: BrowserContext,
  profile: VendorSessionProfile,
  timings: LoginFlowTimings,
): Promise<GuardedPage> {
  const page = await context.newPage();
  const allowed = (rawUrl: string) => isAllowedProviderUrl(rawUrl, profile.sessionHosts);
  let refusedNavigationHost: string | null = null;

  context.on("page", (popup) => {
    if (popup !== page) void popup.close().catch(() => undefined);
  });
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    let mainFrameNavigation = false;
    try {
      mainFrameNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      mainFrameNavigation = false;
    }
    if (mainFrameNavigation && !allowed(request.url())) {
      refusedNavigationHost ??= hostOf(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });

  const signals = async (): Promise<PageSignals | null> => {
    try {
      return (await page.mainFrame().evaluate(LOGIN_SIGNALS_SCRIPT)) as PageSignals;
    } catch {
      return null;
    }
  };
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: timings.settleMs }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: timings.settleMs }).catch(() => undefined);
  };
  const assertSafePage = async () => {
    if (refusedNavigationHost) throw new LoginStop("unknown_page", "off_host_navigation", refusedNavigationHost);
    if (!allowed(page.url())) throw new LoginStop("unknown_page", "off_host_page", hostOf(page.url()));
    const current = await signals();
    if (current?.captcha) throw new LoginStop("captcha", "visible_challenge", hostOf(page.url()));
    if (current?.otpField) throw new LoginStop("two_factor", "one_time_code_field", hostOf(page.url()));
  };
  /** One GET navigation; an unreachable page is a stop, and a refused redirect is reported by the next check. */
  const open = async (url: string, reason: string) => {
    const reached = await page.goto(url, { waitUntil: "domcontentloaded" }).then(() => true, () => false);
    if (!reached && !refusedNavigationHost && !allowed(page.url())) throw new LoginStop("unknown_page", reason, hostOf(url));
    await settle();
  };
  return { page, timings, allowed, refusedHost: () => refusedNavigationHost, signals, settle, open, assertSafePage };
}

/** Opens the landing page and judges it with the vendor definition's classifier, as the kernel would. */
async function confirmLanding(guarded: GuardedPage, profile: VendorSessionProfile): Promise<void> {
  const { page } = guarded;
  await guarded.open(profile.landingUrl, "landing_page_unreachable");
  await guarded.assertSafePage();
  const state = await profile.definition.hooks.classifyPortalState({
    url: page.url(),
    bodyText: await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    passwordInputCount: await page.locator("input[type='password']").count().catch(() => 0),
  });
  if (state === "captcha") throw new LoginStop("captcha", "terminal_signal_captcha", hostOf(page.url()));
  if (state === "unexpected_origin") throw new LoginStop("unknown_page", "landing_unexpected_origin", hostOf(page.url()));
  if (state === "unavailable") throw new LoginStop("unknown_page", "portal_unavailable", hostOf(page.url()));
  if (!sessionStateAccepted(state)) throw new LoginStop("login_failed", "landing_still_requires_login", hostOf(page.url()));
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
    const fields = frame.locator("input[type='password']").filter({ visible: true });
    const count = Math.min(await fields.count().catch(() => 0), 5);
    for (let index = 0; index < count; index += 1) {
      const field = fields.nth(index);
      const form = await formOf(field);
      const inForm = form ? await form.locator("input[type='password']").count().catch(() => 2) : 1;
      if (inForm === 1) return field;
    }
    return null;
  };

  const submitIn = async (form: Locator | null, text: RegExp): Promise<Locator | null> => {
    if (overrides.submit) return firstVisible(frame, [overrides.submit]);
    if (form) {
      const inForm = await firstVisible(form, SUBMIT_IN_FORM);
      if (inForm) return inForm;
    }
    return firstVisibleByText(form ?? frame, "button, [role='button'], input[type='submit']", text);
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
    // so a newsletter or search box on a home page is never filled.
    if (username && !usernameSubmitted && (openedLogin || looksLikeLoginRoute(page.url()))) {
      const next = await submitIn(await formOf(username), NEXT_TEXT);
      if (!next) throw new LoginStop("unknown_page", "username_step_without_next", hostOf(page.url()));
      await username.fill(credential.username.reveal());
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
  if (username) await username.fill(credential.username.reveal());
  else if (!usernameSubmitted) throw new LoginStop("unknown_page", "username_field_not_found", hostOf(page.url()));

  const submit = await submitIn(form, SUBMIT_TEXT);
  // Last check immediately before the password is typed.
  await guarded.assertSafePage();
  await password.fill(credential.password.reveal());
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
    const current = await guarded.signals();
    if (!current) continue;
    const host = hostOf(page.url());
    if (current.captcha) throw new LoginStop("captcha", "visible_challenge_after_submit", host);
    if (current.otpField || (current.twoFactorText && !current.passwordVisible)) {
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
  throw new LoginStop("login_failed", "still_on_login_form", hostOf(page.url()));
}
