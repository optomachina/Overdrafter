import fs from "node:fs/promises";
import path from "node:path";
import {
  chromium as patchrightChromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "patchright";
import { Camoufox, launchOptions as camoufoxLaunchOptions } from "camoufox-js";
import {
  chromium as playwrightChromium,
  firefox as playwrightFirefox,
} from "playwright";
import { createRunDir, uniqueName } from "../files.js";
import {
  VendorAutomationError,
  type VendorArtifact,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type XometryDrawingUploadMode,
  type XometryQuoteRawPayload,
  type XometryValueSource,
} from "../types.js";
import {
  gateLeadTime,
  gateVendorPrice,
  priceGateEvidence,
  UNANCHORED_PRICE_NOTE,
} from "../extractedValue.js";
import { VendorAdapter } from "./base.js";
import { acquireXometryProfileLock } from "./persistentProfileLock.js";
import {
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  buildMaterialSummaryTerms,
  XOMETRY_LOCATORS,
  XOMETRY_URLS,
} from "./xometryConstraints.js";

export const XOMETRY_AUTOMATION_VERSION = "xometry-worker-v1";

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerptText(text: string) {
  return text.slice(0, 2000);
}

function trimTrailingSlashes(value: string) {
  let normalized = value;
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function normalizedQuantity(input: VendorQuoteAdapterInput) {
  return Math.max(1, input.requestedQuantity || input.requirement.quantity || input.part.quantity || 1);
}

function buildRawPayload(overrides: Partial<XometryQuoteRawPayload>): XometryQuoteRawPayload {
  return {
    automationVersion: XOMETRY_AUTOMATION_VERSION,
    detectedFlow: "quote_home",
    uploadSelector: null,
    drawingUploadMode: null,
    selectedMaterial: null,
    selectedFinish: null,
    priceSource: "none",
    leadTimeSource: "none",
    bodyExcerpt: "",
    artifactStoragePaths: [],
    retryCount: 0,
    failureCode: null,
    url: null,
    ...overrides,
  };
}

export function parseFirstCurrency(text: string): number | null {
  const match = text.match(/\$ ?([\d,]+(?:\.\d{2})?)/);
  if (!match) return null;

  const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function observedUsFederalHoliday(date: Date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const weekday = date.getUTCDay();

  const observedFixedDate = (holidayMonth: number, holidayDay: number) => {
    return [year - 1, year, year + 1].some((holidayYear) => {
      const holiday = new Date(Date.UTC(holidayYear, holidayMonth, holidayDay));
      const holidayWeekday = holiday.getUTCDay();
      if (holidayWeekday === 6) {
        holiday.setUTCDate(holiday.getUTCDate() - 1);
      } else if (holidayWeekday === 0) {
        holiday.setUTCDate(holiday.getUTCDate() + 1);
      }
      return (
        year === holiday.getUTCFullYear() &&
        month === holiday.getUTCMonth() &&
        day === holiday.getUTCDate()
      );
    });
  };

  const nthWeekday = (holidayMonth: number, holidayWeekday: number, occurrence: number) => {
    if (month !== holidayMonth || weekday !== holidayWeekday) return false;
    return Math.ceil(day / 7) === occurrence;
  };

  const lastWeekday = (holidayMonth: number, holidayWeekday: number) => {
    if (month !== holidayMonth || weekday !== holidayWeekday) return false;
    const nextWeek = new Date(Date.UTC(year, month, day + 7));
    return nextWeek.getUTCMonth() !== holidayMonth;
  };

  return (
    observedFixedDate(0, 1) ||
    nthWeekday(0, 1, 3) ||
    nthWeekday(1, 1, 3) ||
    lastWeekday(4, 1) ||
    observedFixedDate(5, 19) ||
    observedFixedDate(6, 4) ||
    nthWeekday(8, 1, 1) ||
    nthWeekday(9, 1, 2) ||
    observedFixedDate(10, 11) ||
    nthWeekday(10, 4, 4) ||
    observedFixedDate(11, 25)
  );
}

const ARRIVAL_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

const MAX_ARRIVAL_SPAN_DAYS = 400;
const MILLISECONDS_PER_DAY = 86_400_000;
const XOMETRY_POST_SAVE_TIMEOUT_FLOOR_MS = 120_000;
const XOMETRY_CONTROL_RENDER_TIMEOUT_MS = 10_000;
const XOMETRY_OPTION_RENDER_TIMEOUT_MS = 10_000;
const XOMETRY_UPLOAD_READINESS_POLL_MS = 500;
const XOMETRY_SUPPORTED_FILE_TYPES_LOADING_PATTERN =
  /supported file types are still loading/i;

function parseArrivalDate(text: string, today: Date) {
  const arrivalMatch =
    /arrives?\s+by\s+([a-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?/i.exec(text);
  if (!arrivalMatch) return null;

  const month = ARRIVAL_MONTHS.findIndex((candidate) =>
    arrivalMatch[1].toLowerCase().startsWith(candidate),
  );
  const day = Number.parseInt(arrivalMatch[2], 10);
  const hasExplicitYear = Boolean(arrivalMatch[3]);
  let year = hasExplicitYear
    ? Number.parseInt(arrivalMatch[3], 10)
    : today.getUTCFullYear();
  let arrival = new Date(Date.UTC(year, month, day));

  const validDate =
    month >= 0 &&
    arrival.getUTCFullYear() === year &&
    arrival.getUTCMonth() === month &&
    arrival.getUTCDate() === day;
  if (!validDate) return null;
  if (hasExplicitYear && arrival.getTime() < today.getTime()) return null;
  if (arrival.getTime() >= today.getTime()) return arrival;

  const boundedYearEndRollover =
    !hasExplicitYear && today.getUTCMonth() >= 10 && month <= 1;
  if (!boundedYearEndRollover) return null;

  year += 1;
  arrival = new Date(Date.UTC(year, month, day));
  return arrival;
}

function countUsFederalBusinessDays(today: Date, arrival: Date) {
  let businessDays = 0;
  const cursor = new Date(today);
  while (cursor.getTime() < arrival.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !observedUsFederalHoliday(cursor)) {
      businessDays += 1;
    }
  }
  return businessDays;
}

/**
 * Parses an explicit business-day duration or approximates an arrival date
 * using the US federal business calendar. Ambiguous stale yearless dates are
 * rejected except for a bounded November/December-to-January/February rollover.
 */
export function parseLeadTime(text: string, now = new Date()): number | null {
  const durationMatch =
    /\b(\d{1,4})\s+business\s+days?\b/i.exec(text) ??
    /\b(\d{1,4})\s+days?\b/i.exec(text);
  if (durationMatch) {
    const parsed = Number.parseInt(durationMatch[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const arrival = parseArrivalDate(text, today);
  if (!arrival) return null;

  const arrivalSpanDays = Math.ceil(
    (arrival.getTime() - today.getTime()) / MILLISECONDS_PER_DAY,
  );
  if (arrivalSpanDays > MAX_ARRIVAL_SPAN_DAYS) return null;

  return countUsFederalBusinessDays(today, arrival);
}

function isSignalPresent(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

export function isManualReviewText(text: string) {
  return isSignalPresent(text, XOMETRY_LOCATORS.manualReviewSignals);
}

function isAnonymousEmailGate(input: { text: string; url: string }) {
  return (
    input.url.startsWith(XOMETRY_URLS.quoteHome) &&
    XOMETRY_LOCATORS.anonymousEmailGateSignals.every((pattern) =>
      pattern.test(input.text),
    )
  );
}

/**
 * Classifies visible Xometry blocking signals for the current page.
 *
 * Anonymous quote-home copy maps to `login_required` only when `input.url`
 * starts with {@link XOMETRY_URLS.quoteHome}. The same copy on any other URL
 * must not be treated as an authentication failure.
 */
export function detectBlockingStateSignal(input: { text: string; url: string }) {
  if (isSignalPresent(input.text, XOMETRY_LOCATORS.captchaSignals)) {
    return "captcha";
  }

  if (input.url.includes("/login") || isSignalPresent(input.text, XOMETRY_LOCATORS.loginSignals)) {
    return "login_required";
  }

  if (isAnonymousEmailGate(input)) {
    return "login_required";
  }

  if (
    input.url.startsWith(XOMETRY_URLS.quoteHome) &&
    XOMETRY_LOCATORS.anonymousQuoteHomeSignals.every((pattern) => pattern.test(input.text))
  ) {
    return "login_required";
  }

  if (isSignalPresent(input.text, XOMETRY_LOCATORS.genericErrorSignals)) {
    return "anti_detection_block";
  }

  return null;
}

function buildManualVendorFollowupOutput(
  input: VendorQuoteAdapterInput,
  workerMode: "simulate" | "live",
  reason: string,
  details: Record<string, unknown>,
): VendorQuoteAdapterOutput {
  return {
    vendor: "xometry",
    status: "manual_vendor_followup",
    unitPriceUsd: null,
    totalPriceUsd: null,
    leadTimeBusinessDays: null,
    quoteUrl:
      workerMode === "live"
        ? XOMETRY_URLS.quoteHome
        : `simulated://xometry/manual/${input.part.id}`,
    dfmIssues: [],
    notes: [reason],
    artifacts: [],
    rawPayload: buildRawPayload({
      detectedFlow: "manual_vendor_followup",
      drawingUploadMode: input.stagedDrawingFile ? "not_needed" : "not_provided",
      bodyExcerpt: reason,
      requestedQuantity: input.requestedQuantity,
      url: XOMETRY_URLS.quoteHome,
      ...details,
    }),
  };
}

async function capturePageArtifacts(
  page: Page,
  runDir: string,
  label: string,
): Promise<VendorArtifact[]> {
  const baseName = sanitizeSegment(label);
  const screenshotPath = path.join(runDir, `${baseName}.png`);
  const htmlPath = path.join(runDir, `${baseName}.html`);

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  await fs.writeFile(htmlPath, await page.content(), "utf8");

  return [
    {
      kind: "screenshot",
      label: `${label}-screenshot`,
      localPath: screenshotPath,
      contentType: "image/png",
    },
    {
      kind: "html_snapshot",
      label: `${label}-dom`,
      localPath: htmlPath,
      contentType: "text/html",
    },
  ];
}

async function appendArtifacts(
  artifacts: VendorArtifact[],
  page: Page,
  runDir: string,
  label: string,
) {
  artifacts.push(...(await capturePageArtifacts(page, runDir, label)));
}

async function firstWorkingLocator(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);

    if (count > 0) {
      return { selector, locator };
    }
  }

  return null;
}

async function firstWorkingText(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);

    if (count < 1) {
      continue;
    }

    const text = await locator.innerText().catch(() => "");
    if (text.trim()) {
      return {
        selector,
        text: text.trim(),
      };
    }
  }

  return null;
}

async function readBodyText(page: Page) {
  return page.locator("body").innerText().catch(() => "");
}

async function waitForStandaloneQuoteUploader(
  page: Page,
  deadline: number,
) {
  const uploaderTimeoutMs = Math.max(0, deadline - Date.now());
  if (uploaderTimeoutMs === 0) return false;
  const uploaderReady = await page
    .locator(XOMETRY_LOCATORS.standaloneUploadInputs.join(", "))
    .first()
    .waitFor({ state: "attached", timeout: uploaderTimeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!uploaderReady) return false;

  const networkIdleTimeoutMs = Math.max(0, deadline - Date.now());
  if (networkIdleTimeoutMs > 0) {
    await page
      .waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs })
      .catch(() => undefined);
  }
  return true;
}

/**
 * Waits until clicking "Start a New Instant Quote" either attaches the
 * same-page instant-quote uploader or navigates away from the starting URL.
 * The uploader probe is capped at five seconds; any remaining timeout budget
 * is used for navigation. Returns false when neither readiness state occurs.
 */
async function waitForNewQuoteSurface(
  page: Page,
  startingUrl: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  const instantUpload = page.locator(XOMETRY_LOCATORS.uploadInputs[0]).first();
  const uploadReady = await instantUpload
    .waitFor({ state: "attached", timeout: Math.min(timeoutMs, 5_000) })
    .then(() => true)
    .catch(() => false);
  if (uploadReady) {
    return true;
  }

  if (page.url() !== startingUrl) {
    return waitForStandaloneQuoteUploader(page, deadline);
  }

  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    return false;
  }
  const navigated = await page
    .waitForURL((url) => url.toString() !== startingUrl, {
      timeout: remainingMs,
    })
    .then(() => true)
    .catch(() => false);
  if (navigated) {
    return waitForStandaloneQuoteUploader(page, deadline);
  }
  return false;
}

async function hasVisibleStartNewQuoteButton(page: Page) {
  for (const selector of XOMETRY_LOCATORS.startNewQuoteButtons) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function hasVisibleDashboardUploadButton(page: Page) {
  for (const selector of XOMETRY_LOCATORS.dashboardUploadButtons) {
    if (
      await page
        .locator(`${selector}:visible`)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
}

async function clickVisibleStartNewQuoteButton(
  page: Page,
  deadline: number,
) {
  for (const selector of XOMETRY_LOCATORS.startNewQuoteButtons) {
    const button = page.locator(selector).first();
    if ((await button.count().catch(() => 0)) === 0) continue;
    if (!(await button.isVisible().catch(() => false))) continue;

    const clickTimeoutMs = Math.min(
      5_000,
      Math.max(0, deadline - Date.now()),
    );
    if (clickTimeoutMs === 0) return false;
    const clicked = await button
      .click({ timeout: clickTimeoutMs })
      .then(() => true)
      .catch(() => false);
    if (clicked) return true;
  }
  return false;
}

async function clickNativeStartNewQuoteButton(page: Page) {
  return page
    .evaluate(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) =>
        /start\s+a\s+new\s+Instant\s+Quote/i.test(
          candidate.textContent ?? "",
        ),
      );
      if (!button) return false;
      button.click();
      return true;
    })
    .catch(() => false);
}

async function escapeDashboardIfNeeded(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: Math.max(1, deadline - Date.now()) })
    .catch(() => "");
  const hasDashboardCopy = XOMETRY_LOCATORS.dashboardSignals.some((pattern) => pattern.test(bodyText));
  const hasStartNewQuoteButton = await hasVisibleStartNewQuoteButton(page);
  const isDashboard = hasDashboardCopy || hasStartNewQuoteButton;
  if (!isDashboard) {
    return false;
  }
  if (await hasVisibleDashboardUploadButton(page)) {
    return false;
  }

  const startingUrl = page.url();

  // First try: Playwright synthetic click
  const clicked = await clickVisibleStartNewQuoteButton(page, deadline);
  if (clicked) {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (
      remainingMs > 0 &&
      await waitForNewQuoteSurface(
        page,
        startingUrl,
        Math.min(remainingMs, 8_000),
      )
    ) {
      return true;
    }
  }

  // Fallback: in-page JS click. React onClick handlers sometimes don't fire from Playwright's
  // synthetic click on custom button components but reliably fire from a native HTMLElement.click().
  if (Date.now() >= deadline) {
    return false;
  }
  const jsClicked = await clickNativeStartNewQuoteButton(page);

  if (jsClicked) {
    const remainingMs = Math.max(0, deadline - Date.now());
    return remainingMs > 0
      ? waitForNewQuoteSurface(page, startingUrl, remainingMs)
      : false;
  }

  return false;
}

async function waitForQuoteSignals(page: Page, timeoutMs: number) {
  await page.waitForFunction(
    (patterns) => {
      // Configuration page lands at /quoting/quote/Q##-XXXX after a successful upload.
      if (new RegExp(patterns.urlPattern).test(window.location.href)) {
        return true;
      }
      const body = document.body;
      if (!body) return false;
      const text = body.innerText ?? "";
      return [...patterns.readyPatterns, ...patterns.reviewPatterns].some((pattern) =>
        new RegExp(pattern, "i").test(text),
      );
    },
    {
      readyPatterns: XOMETRY_LOCATORS.quoteReadySignals.map((pattern) => pattern.source),
      reviewPatterns: XOMETRY_LOCATORS.manualReviewSignals.map((pattern) => pattern.source),
      urlPattern: XOMETRY_LOCATORS.quotePagePathPattern.source,
    },
    {
      timeout: timeoutMs,
    },
  );
}

async function navigateToQuoteConfigurationPage(
  page: Page,
  timeoutMs: number,
  runDir: string,
  nonExportControlled: boolean,
) {
  if (nonExportControlled !== true) {
    throw new VendorAutomationError(
      "Xometry export-control authorization is missing or ambiguous.",
      "unexpected_ui_state",
      {
        vendor: "xometry",
        reason: "export_control_authorization_missing",
      },
    );
  }

  // Three observed paths after upload:
  //   1. Modal "Continue" appears → click → page redirects to /quoting/quote/Q##-XXXX.
  //      Empirically the redirect can take 60-90s on Xometry's side as it
  //      processes the CAD upload before navigating.
  //   2. No modal — Xometry redirects directly to the quote URL.
  //   3. Modal or redirect fails — stop rather than opening an unrelated
  //      existing quote from the dashboard.
  // Strategy: give the modal up to 30 s to render, click it once it's there,
  // then hand off to page.waitForURL.
  const modalDeadline = Date.now() + Math.min(timeoutMs, 30_000);
  let modalSelector: string | null = null;

  while (Date.now() < modalDeadline && !modalSelector) {
    if (XOMETRY_LOCATORS.quotePagePathPattern.test(page.url())) {
      return { url: page.url(), via: "auto_redirect", modalSelector };
    }
    for (const selector of XOMETRY_LOCATORS.exportControlContinue) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      let nonExportControlledSelector: string | null = null;
      for (const noSelector of XOMETRY_LOCATORS.exportControlNo) {
        const noControl = page.locator(noSelector).first();
        const noVisible = await noControl.isVisible().catch(() => false);
        if (!noVisible) continue;
        try {
          await noControl.click();
          nonExportControlledSelector = noSelector;
          break;
        } catch {
          // Try the next dialog-scoped negative control.
        }
      }
      if (!nonExportControlledSelector) {
        throw new VendorAutomationError(
          "Xometry requested an export-control answer but no explicit non-export-controlled option was available.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: "export_control_state_ambiguous",
            url: page.url(),
          },
          [],
        );
      }
      try {
        await locator.click();
        modalSelector = selector;
        break;
      } catch {
        // Try the next candidate selector.
      }
    }
    if (!modalSelector) {
      await page.waitForTimeout(500).catch(() => undefined);
    }
  }

  // Snapshot: what was on the page right after the modal poll resolved (clicked
  // or gave up). This is the most useful debugging artifact for navigation
  // failures.
  const navigationArtifacts = await capturePageArtifacts(
    page,
    runDir,
    "post-modal-poll",
  ).catch(() => []);

  // Wait for navigation to the configuration URL using Playwright's native
  // event-based wait. Budget is the full timeoutMs since modal-click → redirect
  // can be slow.
  try {
    await page.waitForURL(XOMETRY_LOCATORS.quotePagePathPattern, { timeout: timeoutMs });
    return { url: page.url(), via: modalSelector ? "modal_redirect" : "auto_redirect", modalSelector };
  } catch {
    const timeoutArtifacts = await capturePageArtifacts(
      page,
      runDir,
      "wait-for-url-timeout",
    ).catch(() => []);
    throw new VendorAutomationError(
      "Xometry did not navigate to the newly created quote after upload.",
      "navigation_failure",
      {
        vendor: "xometry",
        reason: modalSelector ? "modal_no_redirect" : "no_modal_no_redirect",
        modalSelector,
        url: page.url(),
      },
      [...navigationArtifacts, ...timeoutArtifacts],
    );
  }
}

/** Attempts only upload inputs that are explicitly approved for the current Xometry surface. */
async function tryKnownUploadInputs(
  page: Page,
  files: string[],
  selectors: readonly string[],
  attemptedSelectors: string[],
  uploadErrors: Error[],
) {
  for (const selector of selectors) {
    attemptedSelectors.push(selector);
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count < 1) continue;
    try {
      await locator.setInputFiles(files);
      return { selector, attemptedSelectors };
    } catch (error) {
      if (error instanceof Error) {
        uploadErrors.push(error);
      }
    }
  }

  return null;
}

/**
 * Returns whether Xometry's loaded accept list explicitly supports a staged file.
 * An empty list is treated as not ready rather than permissive.
 */
export function uploadInputAcceptsFile(
  accept: string | null,
  filePath: string,
) {
  if (!accept) return false;

  const extension = path.extname(filePath).toLocaleLowerCase();
  if (!extension) return false;

  const acceptedTypes = new Set(
    accept
      .split(",")
      .map((candidate) => candidate.trim().toLocaleLowerCase())
      .filter(Boolean),
  );

  return acceptedTypes.has(extension) || acceptedTypes.has("*/*");
}

async function waitForDashboardUploadReadiness(
  page: Page,
  uploadInput: Locator,
  files: string[],
) {
  const attempts = Math.max(
    1,
    Math.ceil(
      XOMETRY_CONTROL_RENDER_TIMEOUT_MS / XOMETRY_UPLOAD_READINESS_POLL_MS,
    ),
  );
  let observedAccept: string | null = null;
  let loadingErrorVisible = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    observedAccept = await uploadInput
      .getAttribute("accept", {
        timeout: XOMETRY_UPLOAD_READINESS_POLL_MS,
      })
      .catch(() => null);
    const bodyText = await readBodyText(page);
    loadingErrorVisible =
      XOMETRY_SUPPORTED_FILE_TYPES_LOADING_PATTERN.test(bodyText);
    const acceptsEveryFile = files.every((filePath) =>
      uploadInputAcceptsFile(observedAccept, filePath),
    );

    if (acceptsEveryFile && !loadingErrorVisible) {
      return observedAccept;
    }
    if (observedAccept?.trim() && !loadingErrorVisible) {
      throw new VendorAutomationError(
        "Xometry does not support the staged CAD file type.",
        "upload_failure",
        {
          vendor: "xometry",
          reason: "unsupported_file_type",
          accept: observedAccept,
          requestedExtensions: files.map((filePath) =>
            path.extname(filePath).toLocaleLowerCase(),
          ),
          url: page.url(),
        },
      );
    }

    await page
      .waitForTimeout(XOMETRY_UPLOAD_READINESS_POLL_MS)
      .catch(() => undefined);
  }

  throw new VendorAutomationError(
    "Xometry's supported upload file types were not ready.",
    "upload_failure",
    {
      vendor: "xometry",
      reason: "supported_file_types_not_ready",
      accept: observedAccept,
      loadingErrorVisible,
      requestedExtensions: files.map((filePath) =>
        path.extname(filePath).toLocaleLowerCase(),
      ),
      url: page.url(),
    },
  );
}

async function waitForDashboardUploadProgress(
  page: Page,
  uploadPanel: Locator,
  files: string[],
) {
  const attempts = Math.max(
    1,
    Math.ceil(
      XOMETRY_CONTROL_RENDER_TIMEOUT_MS / XOMETRY_UPLOAD_READINESS_POLL_MS,
    ),
  );
  const filenames = files.map((filePath) => path.basename(filePath));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (XOMETRY_LOCATORS.quotePagePathPattern.test(page.url())) {
      return;
    }

    const panelText = await uploadPanel
      .innerText({
        timeout: XOMETRY_UPLOAD_READINESS_POLL_MS,
      })
      .catch(() => "");
    if (XOMETRY_SUPPORTED_FILE_TYPES_LOADING_PATTERN.test(panelText)) {
      throw new VendorAutomationError(
        "Xometry rejected the upload before supported file types were ready.",
        "upload_failure",
        {
          vendor: "xometry",
          reason: "supported_file_types_not_ready",
          filenames,
          url: page.url(),
        },
      );
    }

    if (
      filenames.every((filename) => hasVisibleFilename(panelText, filename))
    ) {
      return;
    }

    for (const selector of XOMETRY_LOCATORS.exportControlContinue) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return;
    }

    await page
      .waitForTimeout(XOMETRY_UPLOAD_READINESS_POLL_MS)
      .catch(() => undefined);
  }
}

async function uploadFilesThroughDashboardPanel(
  page: Page,
  files: string[],
  uploadSelector: string,
  panelSelector: string,
) {
  const uploadInput = page.locator(uploadSelector).first();
  await uploadInput.waitFor({
    state: "attached",
    timeout: XOMETRY_CONTROL_RENDER_TIMEOUT_MS,
  });
  const uploadPanel = page
    .locator(panelSelector)
    .first();
  await waitForDashboardUploadReadiness(page, uploadInput, files);
  await uploadInput.setInputFiles(files);
  await waitForDashboardUploadProgress(page, uploadPanel, files);
  return { selector: uploadSelector };
}

async function tryMountedDashboardUpload(
  page: Page,
  files: string[],
  attemptedSelectors: string[],
  uploadErrors: Error[],
  recordSelectors = true,
) {
  for (const [index, uploadSelector] of XOMETRY_LOCATORS.uploadInputs.entries()) {
    if (recordSelectors) {
      attemptedSelectors.push(uploadSelector);
    }
    const uploadInput = page.locator(uploadSelector).first();
    const count = await uploadInput.count().catch(() => 0);
    if (count < 1) continue;

    const panelSelector = XOMETRY_LOCATORS.dashboardUploadPanels[index];
    if (!panelSelector) continue;

    try {
      const result = await uploadFilesThroughDashboardPanel(
        page,
        files,
        uploadSelector,
        panelSelector,
      );
      return { ...result, attemptedSelectors };
    } catch (error) {
      if (error instanceof VendorAutomationError) {
        throw error;
      }
      if (error instanceof Error) {
        uploadErrors.push(error);
      }
    }
  }

  return null;
}

/** Opens Xometry's quote uploader and waits for its scoped input to mount. */
async function tryDashboardUploadButton(
  page: Page,
  files: string[],
  attemptedSelectors: string[],
  uploadErrors: Error[],
) {
  for (const selector of XOMETRY_LOCATORS.dashboardUploadButtons) {
    attemptedSelectors.push(selector);
    const button = page.locator(`${selector}:visible`).first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;

    try {
      await button.click({
        timeout: XOMETRY_CONTROL_RENDER_TIMEOUT_MS,
      });
      const result = await tryMountedDashboardUpload(
        page,
        files,
        attemptedSelectors,
        uploadErrors,
        false,
      );
      if (result) return result;
    } catch (error) {
      if (error instanceof VendorAutomationError) {
        throw error;
      }
      if (error instanceof Error) {
        uploadErrors.push(error);
      }
    }
  }

  return null;
}

async function setFilesOnUpload(page: Page, files: string[]) {
  const attemptedSelectors: string[] = [];
  const uploadErrors: Error[] = [];
  const quoteHomePath = trimTrailingSlashes(
    new URL(XOMETRY_URLS.quoteHome).pathname,
  );
  const currentPath = trimTrailingSlashes(new URL(page.url()).pathname);
  const isQuoteHome = currentPath === quoteHomePath;
  const eligibleSelectors = isQuoteHome
    ? XOMETRY_LOCATORS.uploadInputs
    : [
        ...XOMETRY_LOCATORS.uploadInputs,
        ...XOMETRY_LOCATORS.standaloneUploadInputs,
      ];
  const eligibleUploadSurfaces = isQuoteHome
    ? [...eligibleSelectors, ...XOMETRY_LOCATORS.dashboardUploadButtons]
    : [...eligibleSelectors];

  await page
    .locator(eligibleUploadSurfaces.join(", "))
    .first()
    .waitFor({
      state: "attached",
      timeout: XOMETRY_CONTROL_RENDER_TIMEOUT_MS,
    })
    .catch(() => undefined);

  const knownInputResult = isQuoteHome
    ? await tryMountedDashboardUpload(
        page,
        files,
        attemptedSelectors,
        uploadErrors,
      )
    : await tryKnownUploadInputs(
        page,
        files,
        eligibleSelectors,
        attemptedSelectors,
        uploadErrors,
      );
  if (knownInputResult) return knownInputResult;

  const dashboardResult = isQuoteHome
    ? await tryDashboardUploadButton(
        page,
        files,
        attemptedSelectors,
        uploadErrors,
      )
    : null;
  if (dashboardResult) return dashboardResult;

  throw new VendorAutomationError(
    "Xometry upload input was not found.",
    "selector_failure",
    {
      vendor: "xometry",
      failedSelector: XOMETRY_LOCATORS.uploadInputs[0],
      attemptedSelectors,
      nearbyAttributes: eligibleUploadSurfaces,
      url: page.url(),
      setInputErrorCount: uploadErrors.length,
    },
  );
}

async function findButtonAndOpen(
  page: Page,
  selectors: readonly string[],
  field: "material" | "finish",
) {
  const preferredSelector = selectors[0];
  const preferredLocator = page.locator(`${preferredSelector}:visible`).first();
  const preferredVisible = await preferredLocator
    .waitFor({ state: "visible", timeout: XOMETRY_CONTROL_RENDER_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  const fallbackMatch = preferredVisible
    ? null
    : await firstWorkingLocator(page, selectors.slice(1));
  let match = null;
  if (preferredVisible) {
    match = { selector: preferredSelector, locator: preferredLocator, isPreferred: true };
  } else if (fallbackMatch) {
    match = { ...fallbackMatch, isPreferred: false };
  }

  if (!match) {
    throw new VendorAutomationError(
      `Xometry ${field} control was not found.`,
      "selector_failure",
      {
        vendor: "xometry",
        field,
        failedSelector: selectors[0],
        attemptedSelectors: [...selectors],
        nearbyAttributes: [...selectors],
        url: page.url(),
      },
    );
  }

  const controlRole = await match.locator.getAttribute("role").catch(() => null);
  const alreadyExpanded = await match.locator
    .getAttribute("aria-expanded")
    .then((value) => value === "true")
    .catch(() => false);
  if (match.isPreferred && controlRole === "combobox") {
    await match.locator.press("ArrowDown");
  } else if (!alreadyExpanded) {
    await match.locator.click();
  }
  return match.selector;
}

async function chooseOptionByTerms(
  page: Page,
  terms: string[],
  optionSelectors: readonly string[],
  field: "material" | "finish",
  controlSelector: string,
) {
  for (const term of terms) {
    const roleOption = page
      .getByRole("option", { name: new RegExp(escapeRegex(term), "i") })
      .first();

    const roleOptionVisible = await roleOption
      .waitFor({ state: "visible", timeout: XOMETRY_OPTION_RENDER_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    if (roleOptionVisible) {
      await roleOption.click();
      return term;
    }

    for (const selector of optionSelectors) {
      const option = page
        .locator(selector)
        .filter({ hasText: new RegExp(escapeRegex(term), "i") })
        .first();

      if ((await option.count().catch(() => 0)) > 0) {
        await option.click();
        return term;
      }
    }
  }

  throw new VendorAutomationError(
    `Xometry ${field} option was not found for ${terms[0]}.`,
    "selector_failure",
    {
      vendor: "xometry",
      field,
      failedSelector: optionSelectors[0],
      attemptedSelectors: [...optionSelectors],
      nearbyAttributes: [...optionSelectors],
      requestedTerms: terms,
      controlSelector,
      bodyExcerpt: excerptText(await readBodyText(page)),
      url: page.url(),
    },
  );
}

async function configureRequiredOption(
  page: Page,
  terms: string[],
  controlSelectors: readonly string[],
  optionSelectors: readonly string[],
  field: "material" | "finish",
) {
  const controlSelector = await findButtonAndOpen(page, controlSelectors, field);
  return chooseOptionByTerms(page, terms, optionSelectors, field, controlSelector);
}

async function saveConfiguration(page: Page, timeoutMs: number) {
  // Xometry can take longer than the general browser timeout to recalculate a
  // configured quote. Keep this vendor-specific floor explicit and bounded.
  const postSaveTimeoutMs = Math.max(timeoutMs, XOMETRY_POST_SAVE_TIMEOUT_FLOOR_MS);

  for (const selector of XOMETRY_LOCATORS.saveConfigurationButtons) {
    const button = page.locator(selector).first();
    if ((await button.count().catch(() => 0)) < 1) {
      continue;
    }
    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }

    const configurationUrl = page.url();
    await button.click();
    const navigated = await page
      .waitForURL((url) => url.toString() !== configurationUrl, {
        timeout: postSaveTimeoutMs,
      })
      .then(() => true)
      .catch(() => false);

    if (!navigated) {
      const bodyText = await readBodyText(page);
      throw new VendorAutomationError(
        "Xometry did not leave the configuration page after Save Configuration.",
        "navigation_failure",
        {
          vendor: "xometry",
          field: "save_configuration",
          configurationUrl,
          url: page.url(),
          bodyExcerpt: excerptText(bodyText),
        },
      );
    }

    const settled = await page
      .waitForFunction(
        () => {
          const text = document.body?.innerText ?? "";
          const priceAvailable =
            /least expensive/i.test(text) && /\$\d[\d,]*\.\d{2}/.test(text);
          const manualReviewAvailable =
            /manual review|manually quoted|manually-quoted|requires review|drawing required/i.test(
              text,
            );
          return priceAvailable || manualReviewAvailable;
        },
        undefined,
        { timeout: postSaveTimeoutMs },
      )
      .then(() => true)
      .catch(() => false);

    if (!settled) {
      const bodyText = await readBodyText(page);
      throw new VendorAutomationError(
        "Xometry did not render a price or manual-review signal after Save Configuration.",
        "unexpected_ui_state",
        {
          vendor: "xometry",
          field: "save_configuration",
          url: page.url(),
          bodyExcerpt: excerptText(bodyText),
        },
      );
    }
    return selector;
  }

  const bodyText = await readBodyText(page);
  throw new VendorAutomationError(
    "Xometry Save Configuration control was not found.",
    "selector_failure",
    {
      vendor: "xometry",
      field: "save_configuration",
      failedSelector: XOMETRY_LOCATORS.saveConfigurationButtons[0],
      attemptedSelectors: [...XOMETRY_LOCATORS.saveConfigurationButtons],
      url: page.url(),
      bodyExcerpt: excerptText(bodyText),
    },
  );
}

async function setQuantity(page: Page, quantity: number) {
  const match = await firstWorkingLocator(page, XOMETRY_LOCATORS.quantityInputs);

  if (!match) {
    throw new VendorAutomationError(
      "Xometry quantity input was not found.",
      "selector_failure",
      {
        vendor: "xometry",
        failedSelector: XOMETRY_LOCATORS.quantityInputs[0],
        attemptedSelectors: [...XOMETRY_LOCATORS.quantityInputs],
        nearbyAttributes: [...XOMETRY_LOCATORS.quantityInputs],
        url: page.url(),
      },
    );
  }

  await match.locator.fill(String(quantity));
  await match.locator.press("Enter");
}

/**
 * Reads Xometry's quote summary and, only when it exposes no explicit quantity,
 * appends one synthetic `Quantity:` line from the first visible quantity input.
 * Explicit summary quantities always take precedence, including contradictory
 * values, so callers can use the result for fail-closed verification.
 */
async function readQuoteSummaryText(page: Page) {
  const bodyText = await readBodyText(page);
  const explicitQuantities = Array.from(
    bodyText.matchAll(/\bQuantity[\s:]*(\d+)\b/gi),
  );
  if (explicitQuantities.length > 0) {
    return bodyText;
  }

  for (const selector of XOMETRY_LOCATORS.quantityInputs) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) < 1) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const value = await locator.inputValue().catch(() => "");
    if (/^\d+$/.test(value)) {
      return `${bodyText}\nQuantity: ${value}`;
    }
  }

  return bodyText;
}

async function openPartConfigurationIfNeeded(
  page: Page,
  timeoutMs: number,
) {
  for (const selector of XOMETRY_LOCATORS.editConfigurationButtons) {
    const button = page.locator(selector).first();
    if (!(await button.isVisible().catch(() => false))) continue;

    await button.click();
    await page
      .locator(XOMETRY_LOCATORS.materialButtons[0])
      .first()
      .waitFor({ state: "attached", timeout: timeoutMs })
      .catch(() => undefined);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    return selector;
  }

  return null;
}

/**
 * Chooses the least-cost Xometry tier that is at least as tight as the
 * approved maximum tolerance.
 */
export function selectToleranceTier(toleranceInch: number | null) {
  if (toleranceInch === null) {
    return { selector: null, tier: null };
  }

  if (toleranceInch < 0.005) {
    return {
      selector: XOMETRY_LOCATORS.toleranceOptions.tighter,
      tier: "tighter",
    };
  }

  if (toleranceInch < 0.01) {
    return {
      selector: XOMETRY_LOCATORS.toleranceOptions.standard,
      tier: "standard",
    };
  }

  return {
    selector: XOMETRY_LOCATORS.toleranceOptions.looser,
    tier: "looser",
  };
}

async function setTolerance(page: Page, toleranceInch: number | null) {
  const selection = selectToleranceTier(toleranceInch);
  if (selection.selector === null) {
    return selection;
  }

  const radio = page.locator(selection.selector).first();
  if ((await radio.count().catch(() => 0)) < 1) {
    const bodyText = await readBodyText(page);
    throw new VendorAutomationError(
      `Xometry tolerance control was not found for ±${toleranceInch} in.`,
      "selector_failure",
      {
        vendor: "xometry",
        field: "tolerance",
        failedSelector: selection.selector,
        requestedToleranceInch: toleranceInch,
        url: page.url(),
        bodyExcerpt: excerptText(bodyText),
      },
    );
  }

  await radio.click();
  return selection;
}

async function waitForVisibleFilename(
  page: Page,
  filename: string,
  timeoutMs: number,
) {
  const visible = await page
    .waitForFunction(
      (expectedFilename) =>
        (document.body?.innerText ?? "")
          .toLocaleLowerCase()
          .includes(expectedFilename.toLocaleLowerCase()),
      filename,
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);

  return visible;
}

function quotePayloadHasDrawing(
  payload: unknown,
  uploadedPartId: string,
  drawingName: string,
) {
  const parts =
    payload &&
    typeof payload === "object" &&
    "parts" in payload &&
    payload.parts &&
    typeof payload.parts === "object"
      ? Object.values(payload.parts)
      : [];

  return parts.some((quotePart) => {
    if (
      !quotePart ||
      typeof quotePart !== "object" ||
      !("part" in quotePart) ||
      !quotePart.part ||
      typeof quotePart.part !== "object" ||
      !("_id" in quotePart.part) ||
      typeof quotePart.part._id !== "string" ||
      quotePart.part._id.toLocaleLowerCase() !==
        uploadedPartId.toLocaleLowerCase() ||
      !("revisions" in quotePart.part) ||
      !Array.isArray(quotePart.part.revisions)
    ) {
      return false;
    }
    const activeRevision = quotePart.part.revisions.at(-1);
    if (
      !activeRevision ||
      typeof activeRevision !== "object" ||
      !("drawings" in activeRevision) ||
      !Array.isArray(activeRevision.drawings)
    ) {
      return false;
    }
    return activeRevision.drawings.some(
      (drawing: unknown) =>
        drawing &&
        typeof drawing === "object" &&
        "original_filename" in drawing &&
        typeof drawing.original_filename === "string" &&
        drawing.original_filename.toLocaleLowerCase() ===
          drawingName.toLocaleLowerCase(),
    );
  });
}

async function confirmUploadedDrawing(
  page: Page,
  quoteId: string,
  uploadedPartId: string,
  drawingName: string,
  timeoutMs: number,
) {
  const pageWithResponseWait = page as Page & {
    waitForResponse?: Page["waitForResponse"];
  };
  if (typeof pageWithResponseWait.waitForResponse !== "function") {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  do {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) return false;
    const responseTimeoutMs = Math.min(5_000, remainingMs);
    const quoteResponse = pageWithResponseWait
      .waitForResponse(
        (response) => {
          if (
            response.request().method() !== "GET" ||
            response.status() !== 200
          ) {
            return false;
          }
          const responseUrl = new URL(response.url());
          return (
            responseUrl.pathname.toLocaleLowerCase() ===
            `/v2/quotes/${quoteId}`.toLocaleLowerCase()
          );
        },
        { timeout: responseTimeoutMs },
      )
      .catch(() => null);

    try {
      await page.reload({
        waitUntil: "load",
        timeout: remainingMs,
      });
      const networkIdleTimeoutMs = Math.min(
        5_000,
        Math.max(0, deadline - Date.now()),
      );
      if (networkIdleTimeoutMs > 0) {
        await page
          .waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs })
          .catch(() => undefined);
      }
    } catch {
      // A successful upload may still take time to appear in the quote payload.
      // Continue polling within the shared deadline.
    }
    const refreshedQuote = await quoteResponse;
    const refreshedPayload = await refreshedQuote?.json().catch(() => null);
    if (
      quotePayloadHasDrawing(
        refreshedPayload,
        uploadedPartId,
        drawingName,
      )
    ) {
      return true;
    }
    const pollDelayMs = Math.min(500, Math.max(0, deadline - Date.now()));
    if (pollDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollDelayMs);
      });
    }
  } while (Date.now() < deadline);

  return false;
}

type DrawingAttachmentResult = {
  selector: string;
  verification:
    | "upload_acknowledged_and_drawing_confirmed"
    | "visible_filename";
};

type DrawingAttachmentAttempt =
  | { outcome: "verified"; result: DrawingAttachmentResult }
  | { outcome: "terminal_failure" }
  | { outcome: "try_next" };

async function attemptDrawingAttachment(
  page: Page,
  locator: Locator,
  selector: string,
  drawingPath: string,
  drawingName: string,
  timeoutMs: number,
): Promise<DrawingAttachmentAttempt> {
  const pageWithResponseWait = page as Page & {
    waitForResponse?: Page["waitForResponse"];
  };
  const deadline = Date.now() + timeoutMs;
  const acknowledgementTimeoutMs = Math.min(
    10_000,
    Math.max(1, Math.floor((deadline - Date.now()) / 2)),
  );
  const uploadAcknowledgement =
    typeof pageWithResponseWait.waitForResponse === "function"
      ? pageWithResponseWait
          .waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              /\/v2\/quotes\/parts\/[^/]+\/upload_drawings(?:[/?#]|$)/i.test(
                response.url(),
              ),
            { timeout: acknowledgementTimeoutMs },
          )
          .catch(() => null)
      : Promise.resolve(null);

  await locator.setInputFiles(drawingPath, {
    timeout: acknowledgementTimeoutMs,
  });
  const uploadResponse = await uploadAcknowledgement;
  if (uploadResponse) {
    if (uploadResponse.status() < 200 || uploadResponse.status() >= 300) {
      return { outcome: "terminal_failure" };
    }
    const uploadedPartId =
      /\/v2\/quotes\/parts\/([^/?#]+)\/upload_drawings(?:[/?#]|$)/i.exec(
        uploadResponse.url(),
      )?.[1] ?? null;
    const quoteId = /\/quoting\/quote\/(Q\d{2}-[^/?#]+)/i.exec(
      page.url(),
    )?.[1];
    const confirmationTimeoutMs = Math.max(0, deadline - Date.now());
    const drawingPersisted =
      confirmationTimeoutMs > 0 &&
      Boolean(quoteId) &&
      Boolean(uploadedPartId) &&
      await confirmUploadedDrawing(
        page,
        quoteId ?? "",
        uploadedPartId ?? "",
        drawingName,
        confirmationTimeoutMs,
      ).catch(() => false);
    if (!drawingPersisted) {
      return { outcome: "terminal_failure" };
    }
    return {
      outcome: "verified",
      result: {
        selector,
        verification: "upload_acknowledged_and_drawing_confirmed",
      },
    };
  }

  const visibleFilenameTimeoutMs = Math.max(0, deadline - Date.now());
  const filenameVisible =
    visibleFilenameTimeoutMs > 0 &&
    await waitForVisibleFilename(
      page,
      drawingName,
      visibleFilenameTimeoutMs,
    );
  if (!filenameVisible) return { outcome: "try_next" };
  return {
    outcome: "verified",
    result: {
      selector,
      verification: "visible_filename",
    },
  };
}

async function attachDrawingFallback(
  page: Page,
  drawingPath: string,
  drawingName: string,
  timeoutMs: number,
) {
  for (const selector of XOMETRY_LOCATORS.drawingInputs) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);

    if (count < 1) continue;

    try {
      const attempt = await attemptDrawingAttachment(
        page,
        locator,
        selector,
        drawingPath,
        drawingName,
        timeoutMs,
      );
      if (attempt.outcome === "verified") return attempt.result;
      if (attempt.outcome === "terminal_failure") return null;
    } catch {
      // Try the next drawing-specific input.
    }
  }

  return null;
}

type SavedRequirementCheck = {
  quantity: number;
  materialTerms: string[];
  finishTerms: string[];
  toleranceTier: string | null;
  drawingName: string | null;
};

const QUOTE_SUMMARY_FIELD_LABELS = [
  "Quantity",
  "Material",
  "Finish",
  "Measurement",
  "Preferred Subprocess",
  "Precision Tolerance",
  "Threads and Tapped Holes",
  "Inserts",
  "Inspection",
  "Certificates and Supplier Qualifications",
  "Price and Lead Time",
] as const;

function readQuoteSummaryField(bodyText: string, label: string) {
  const summary = bodyText.replace(/\s+/g, " ").trim();
  const followingLabels = QUOTE_SUMMARY_FIELD_LABELS
    .filter((candidate) => candidate !== label)
    .map((candidate) => escapeRegex(candidate))
    .join("|");
  const match = new RegExp(
    String.raw`\b${escapeRegex(label)}\s*:\s*(.*?)(?=\s+(?:${followingLabels})\s*:|\s+Least Expensive\b|$)`,
    "i",
  ).exec(summary);
  return match?.[1]?.trim() ?? null;
}

function findExactTermMatch(text: string, terms: string[]) {
  return (
    terms.find((term) =>
      new RegExp(
        `(?:^|[^a-z0-9])${escapeRegex(term)}(?=$|[^a-z0-9])`,
        "i",
      ).test(text),
    ) ?? null
  );
}

export function hasVisibleFilename(text: string, filename: string) {
  return text.toLocaleLowerCase().includes(filename.toLocaleLowerCase());
}

/**
 * Matches Xometry's rendered Precision Tolerance summary against a selected
 * looser, standard, or tighter tier. A null tier means no configured tolerance
 * and therefore always matches.
 */
export function toleranceSummaryMatches(bodyText: string, tier: string | null) {
  const summary = bodyText.replace(/\s+/g, " ");
  switch (tier) {
    case null:
      return true;
    case "looser":
      return /Precision Tolerance:\s*±?\.010/i.test(summary);
    case "standard":
      return /Precision Tolerance:\s*±?\.005/i.test(summary);
    case "tighter":
      return /Precision Tolerance:.*(?:tighter than|<)\s*±?\.005/i.test(summary);
    default:
      return false;
  }
}

function verifySavedRequirements(
  bodyText: string,
  expected: SavedRequirementCheck,
) {
  const mismatches: string[] = [];
  const observedQuantities = Array.from(
    bodyText.matchAll(/\bQuantity[\s:]*(\d+)\b/gi),
    (match) => Number.parseInt(match[1], 10),
  );

  if (
    observedQuantities.length === 0 ||
    observedQuantities.some((quantity) => quantity !== expected.quantity)
  ) {
    mismatches.push("quantity");
  }
  const materialSummary = readQuoteSummaryField(bodyText, "Material");
  if (
    !materialSummary ||
    !findExactTermMatch(materialSummary, expected.materialTerms)
  ) {
    mismatches.push("material");
  }
  const finishSummary = readQuoteSummaryField(bodyText, "Finish");
  const finishMatches =
    expected.finishTerms.length > 0
      ? Boolean(
          finishSummary &&
            findExactTermMatch(finishSummary, expected.finishTerms),
        )
      : Boolean(
          finishSummary &&
            /^(?:Standard|As Machined|None)\b/i.test(finishSummary),
        );
  if (!finishMatches) {
    mismatches.push("finish");
  }

  if (!toleranceSummaryMatches(bodyText, expected.toleranceTier)) {
    mismatches.push("tolerance");
  }

  if (
    expected.drawingName &&
    !hasVisibleFilename(bodyText, expected.drawingName)
  ) {
    mismatches.push("drawing");
  }

  return mismatches;
}

async function detectBlockingState(page: Page, runDir: string) {
  const bodyText = await readBodyText(page);
  const signal = detectBlockingStateSignal({
    text: bodyText,
    url: page.url(),
  });

  if (signal === "captcha") {
    const artifacts = await capturePageArtifacts(page, runDir, "captcha");
    throw new VendorAutomationError(
      "Xometry presented a captcha challenge.",
      "captcha",
      {
        vendor: "xometry",
        url: page.url(),
      },
      artifacts,
    );
  }

  if (signal === "login_required") {
    const artifacts = await capturePageArtifacts(page, runDir, "login-required");
    const reason = isAnonymousEmailGate({ text: bodyText, url: page.url() })
      ? "anonymous_email_gate"
      : "session_authentication_required";
    throw new VendorAutomationError(
      "Xometry authentication is required. Refresh the stored Playwright session.",
      "login_required",
      {
        vendor: "xometry",
        reason,
        url: page.url(),
        expectedLoginUrl: XOMETRY_URLS.login,
      },
      artifacts,
    );
  }

  if (signal === "anti_detection_block") {
    const artifacts = await capturePageArtifacts(page, runDir, "anti-detection-block");
    throw new VendorAutomationError(
      "Xometry surfaced a generic error banner consistent with anti-detection blocking.",
      "anti_detection_block",
      {
        vendor: "xometry",
        url: page.url(),
        bodyExcerpt: excerptText(bodyText),
      },
      artifacts,
    );
  }

  return bodyText;
}

async function extractParsedValue(
  page: Page,
  selectors: readonly string[],
  parser: (text: string) => number | null,
  bodyText: string,
) {
  for (const selector of selectors) {
    const match = await firstWorkingText(page, [selector]);
    if (!match) {
      continue;
    }

    const value = parser(match.text);
    if (value !== null) {
      return {
        value,
        source: "selector" as XometryValueSource,
        selector: match.selector,
      };
    }
  }

  const fallbackValue = parser(bodyText);

  return {
    value: fallbackValue,
    source: fallbackValue !== null ? ("body_text" as XometryValueSource) : ("none" as XometryValueSource),
    selector: null,
  };
}

async function detectManualReview(page: Page, bodyText: string) {
  const match = await firstWorkingText(page, XOMETRY_LOCATORS.manualReviewText);

  if (match && isManualReviewText(match.text)) {
    return {
      manualReview: true,
      selector: match.selector,
    };
  }

  return {
    manualReview: isManualReviewText(bodyText),
    selector: null,
  };
}

export class XometryAdapter extends VendorAdapter {
  private simulateQuote(input: VendorQuoteAdapterInput): VendorQuoteAdapterOutput {
    const quantity = normalizedQuantity(input);
    const total = this.simulatedBaseAmount(input);
    const quoteUrl = `simulated://xometry/${input.part.id}`;

    return {
      vendor: "xometry",
      status: "instant_quote_received",
      unitPriceUsd: Math.round((total / quantity) * 100) / 100,
      totalPriceUsd: total,
      leadTimeBusinessDays: 6,
      quoteUrl,
      dfmIssues: [],
      notes: ["Simulated instant quote generated from the deterministic worker model."],
      artifacts: [],
      rawPayload: buildRawPayload({
        detectedFlow: "simulate",
        requestedQuantity: input.requestedQuantity,
        url: quoteUrl,
      }),
    };
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.simulateQuote(input);
    }

    const dispatchAuthorization = input.xometryDispatchAuthorization;
    if (
      dispatchAuthorization?.provider !== "xometry" ||
      dispatchAuthorization.envelopeRevision !== "xometry-controlled-beta-envelope.v1" ||
      dispatchAuthorization.nonExportControlled !== true ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        dispatchAuthorization.permitId,
      ) ||
      !/^[a-f0-9]{64}$/.test(dispatchAuthorization.scopeFingerprint)
    ) {
      throw new VendorAutomationError(
        "Live Xometry automation requires a current exact-scope dispatch authorization.",
        "unexpected_ui_state",
        {
          vendor: "xometry",
          reason: "dispatch_authorization_missing",
        },
      );
    }

    const materialTerms = buildMaterialSearchTerms(input.requirement.material);
    const materialSummaryTerms = buildMaterialSummaryTerms(
      input.requirement.material,
    );
    if (!materialTerms || !materialSummaryTerms) {
      return {
        ...buildManualVendorFollowupOutput(
          input,
          this.config.workerMode,
          `Material "${input.requirement.material}" is not mapped to a supported Xometry option.`,
          {
          selectedMaterial: null,
          unmappedField: "material",
          unmappedValue: input.requirement.material,
          },
        ),
      };
    }

    const finishTerms = buildFinishSearchTerms(input.requirement.finish);
    if (input.requirement.finish && finishTerms === null) {
      return {
        ...buildManualVendorFollowupOutput(
          input,
          this.config.workerMode,
          `Finish "${input.requirement.finish}" is not mapped to a supported Xometry option.`,
          {
          selectedFinish: null,
          unmappedField: "finish",
          unmappedValue: input.requirement.finish,
          },
        ),
      };
    }

    if (!input.stagedCadFile) {
      throw new VendorAutomationError(
        "Xometry requires a staged CAD file before quoting can start.",
        "upload_failure",
        {
          vendor: "xometry",
          reason: "missing_cad_file",
        },
      );
    }

    if (!this.config.xometryUserDataDir && !this.config.xometryStorageStatePath) {
      throw new VendorAutomationError(
        "Live mode requires XOMETRY_USER_DATA_DIR (recommended) or XOMETRY_STORAGE_STATE_PATH.",
        "login_required",
        {
          vendor: "xometry",
          expectedLoginUrl: XOMETRY_URLS.login,
        },
      );
    }

    const runDir = await createRunDir(this.config, [
      "xometry",
      input.quoteRunId,
      uniqueName(input.part.id),
    ]);

    let browser: Browser | null = null;
    let browserContext: BrowserContext | null = null;
    const artifacts: VendorArtifact[] = [];
    let traceStopped = false;
    let detectedFlow: XometryQuoteRawPayload["detectedFlow"] = "quote_home";
    let uploadSelector: string | null = null;
    let selectedMaterial: string | null = null;
    let selectedFinish: string | null = null;
    let selectedTolerance: string | null = null;
    let toleranceSelector: string | null = null;
    let drawingUploadMode: XometryDrawingUploadMode =
      input.stagedDrawingFile ? "bundled" : "not_provided";
    let priceSource: XometryValueSource = "none";
    let leadTimeSource: XometryValueSource = "none";
    let saveConfigurationSelector: string | null = null;
    let drawingUploadSelector: string | null = null;
    let drawingUploadVerification: string | null = null;

    try {
      const launchArgs: string[] = [];

      if (this.config.playwrightDisableSandbox) {
        launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
      }

      if (this.config.playwrightDisableDevShmUsage) {
        launchArgs.push("--disable-dev-shm-usage");
      }

      if (this.config.xometryBrowserEngine === "camoufox") {
        // Camoufox produces a fresh browser fingerprint per launch. Cloudflare's
        // __cf_bm cookie is tied to fingerprint, so storage-state alone won't
        // keep us authenticated across launches. user_data_dir gives a persistent
        // Firefox profile that survives both fingerprint and cookies cleanly.
        if (this.config.xometryUserDataDir) {
          await fs.mkdir(this.config.xometryUserDataDir, { recursive: true });
          browserContext = (await Camoufox({
            headless: this.config.playwrightHeadless,
            window: [1366, 900],
            humanize: true,
            geoip: true,
            user_data_dir: this.config.xometryUserDataDir,
          })) as unknown as BrowserContext;
        } else {
          const camoufoxOpts = await camoufoxLaunchOptions({
            headless: this.config.playwrightHeadless,
            window: [1366, 900],
            humanize: true,
            geoip: true,
          });
          browser = (await playwrightFirefox.launch(camoufoxOpts)) as unknown as Browser;
          browserContext = (await browser.newContext({
            storageState: this.config.xometryStorageStatePath ?? undefined,
            viewport: { width: 1366, height: 900 },
          })) as unknown as BrowserContext;
        }
      } else if (this.config.xometryUserDataDir) {
        const chromiumEngine =
          this.config.xometryBrowserEngine === "playwright"
            ? playwrightChromium
            : patchrightChromium;
        await fs.mkdir(this.config.xometryUserDataDir, { recursive: true });
        await acquireXometryProfileLock(this.config.xometryUserDataDir, {
          waitMs: this.config.xometryProfileLockWaitMs,
          vendor: "xometry",
        });
        const persistentLaunchOptions: Record<string, unknown> = {
          headless: this.config.playwrightHeadless,
          args: launchArgs,
        };

        if (this.config.xometryBrowserChannel) {
          persistentLaunchOptions.channel = this.config.xometryBrowserChannel;
        }

        browserContext = (await chromiumEngine.launchPersistentContext(
          this.config.xometryUserDataDir,
          persistentLaunchOptions as never,
        )) as unknown as BrowserContext;
      } else {
        const chromiumEngine =
          this.config.xometryBrowserEngine === "playwright"
            ? playwrightChromium
            : patchrightChromium;
        browser = (await chromiumEngine.launch({
          headless: this.config.playwrightHeadless,
          args: launchArgs,
        })) as unknown as Browser;

        browserContext = await browser.newContext({
          storageState: this.config.xometryStorageStatePath ?? undefined,
        });
      }

      browserContext.setDefaultTimeout(this.config.browserTimeoutMs);
      browserContext.setDefaultNavigationTimeout(this.config.browserTimeoutMs);

      if (this.config.playwrightCaptureTrace) {
        await browserContext.tracing.start({
          screenshots: true,
          snapshots: true,
        });
      }

      const page = await browserContext.newPage();
      await page.goto(XOMETRY_URLS.quoteHome, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await detectBlockingState(page, runDir);
      await appendArtifacts(artifacts, page, runDir, "landing");
      const escapedDashboard = await escapeDashboardIfNeeded(page, this.config.browserTimeoutMs);
      if (escapedDashboard) {
        await appendArtifacts(artifacts, page, runDir, "post-dashboard");
      }

      // Empirically, Xometry's redesigned post-upload flow only redirects to a
      // /quoting/quote/Q##-XXXX configuration page when a single CAD file is
      // uploaded. Bundling cad+drawing keeps the page on the dashboard with
      // an open "are these export-controlled" modal that never resolves to a
      // quote URL. Always upload CAD first; rely on attachDrawingFallback
      // later in the flow to attach the drawing if Xometry asks for it.
      const uploadResult = await setFilesOnUpload(page, [input.stagedCadFile.localPath]);
      uploadSelector = uploadResult.selector;
      if (input.stagedDrawingFile) {
        drawingUploadMode = "not_needed";
      }

      // After upload, an export-controlled-parts modal appears for authenticated
      // sessions. Submitting the modal redirects to /quoting/quote/Q##-XXXX,
      // which is the configuration page we need. Some sessions skip the modal
      // and the redirect happens on its own.
      // Mirror the manual probe: a fixed delay lets Xometry render the
      // export-controlled-parts modal before we look for it. The subsequent
      // networkidle wait can be slow (60+ s) while Xometry processes the CAD
      // upload, so this short pause makes the modal visible before any
      // long-running wait blocks our poll.
      await page.waitForTimeout(5_000).catch(() => undefined);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await detectBlockingState(page, runDir);
      await navigateToQuoteConfigurationPage(
        page,
        120_000,
        runDir,
        dispatchAuthorization.nonExportControlled,
      );

      await waitForQuoteSignals(page, this.config.browserTimeoutMs);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await detectBlockingState(page, runDir);
      detectedFlow = "upload_complete";
      await appendArtifacts(artifacts, page, runDir, "uploaded");

      const requestedTolerance = selectToleranceTier(
        input.requirement.tightest_tolerance_inch,
      );
      const uploadedSummaryText = await readQuoteSummaryText(page);
      const uploadedSummaryMismatches = verifySavedRequirements(
        uploadedSummaryText,
        {
          quantity: normalizedQuantity(input),
          materialTerms: materialSummaryTerms,
          finishTerms: finishTerms ?? [],
          toleranceTier: requestedTolerance.tier,
          drawingName: null,
        },
      );
      const uploadedSummaryMatches = uploadedSummaryMismatches.length === 0;

      if (uploadedSummaryMatches) {
        const observedMaterial = readQuoteSummaryField(
          uploadedSummaryText,
          "Material",
        );
        const observedFinish = readQuoteSummaryField(
          uploadedSummaryText,
          "Finish",
        );
        selectedMaterial = observedMaterial
          ? findExactTermMatch(observedMaterial, materialSummaryTerms)
          : null;
        selectedFinish =
          observedFinish && finishTerms
            ? findExactTermMatch(observedFinish, finishTerms)
            : null;
        selectedTolerance = requestedTolerance.tier;
      } else {
        await openPartConfigurationIfNeeded(
          page,
          this.config.browserTimeoutMs,
        );
        await setQuantity(page, normalizedQuantity(input));

        selectedMaterial = await configureRequiredOption(
          page,
          materialTerms,
          XOMETRY_LOCATORS.materialButtons,
          XOMETRY_LOCATORS.materialOptions,
          "material",
        );

        if (finishTerms && finishTerms.length > 0) {
          selectedFinish = await configureRequiredOption(
            page,
            finishTerms,
            XOMETRY_LOCATORS.finishButtons,
            XOMETRY_LOCATORS.finishOptions,
            "finish",
          );
        }

        const toleranceSelection = await setTolerance(
          page,
          input.requirement.tightest_tolerance_inch,
        );
        selectedTolerance = toleranceSelection.tier;
        toleranceSelector = toleranceSelection.selector;
      }

      if (!uploadedSummaryMatches) {
        saveConfigurationSelector = await saveConfiguration(
          page,
          this.config.browserTimeoutMs,
        );
      }

      const postConfigText = await readBodyText(page);
      const drawingAlreadyAttached =
        Boolean(input.stagedDrawingFile) &&
        hasVisibleFilename(
          postConfigText,
          input.stagedDrawingFile?.originalName ?? "",
        );

      if (
        input.stagedDrawingFile &&
        !drawingAlreadyAttached
      ) {
        const drawingFallbackResult = await attachDrawingFallback(
          page,
          input.stagedDrawingFile.localPath,
          input.stagedDrawingFile.originalName,
          this.config.browserTimeoutMs,
        );
        if (!drawingFallbackResult) {
          throw new VendorAutomationError(
            "Xometry drawing could not be attached or verified before pricing.",
            "upload_failure",
            {
              vendor: "xometry",
              reason: "drawing_attachment_missing",
              drawingName: input.stagedDrawingFile.originalName,
              url: page.url(),
              bodyExcerpt: excerptText(postConfigText),
            },
          );
        }
        drawingUploadSelector = drawingFallbackResult.selector;
        drawingUploadVerification = drawingFallbackResult.verification;
        drawingUploadMode = "fallback";
      }

      await page.waitForLoadState("networkidle").catch(() => undefined);
      await detectBlockingState(page, runDir);
      detectedFlow = "configuration_complete";

      // Xometry recomputes prices after quantity changes; the tierAndLeadTime
      // labels render before their $X.XX siblings finish populating. Wait until
      // at least one tier label contains a dollar amount before extracting.
      await page
        .waitForFunction(
          () => {
            const tiers = document.querySelectorAll('[data-testid="tierAndLeadTime"]');
            for (const tier of tiers) {
              const container = tier.closest("label, [data-testid], section, div");
              const text = container?.parentElement?.textContent ?? container?.textContent ?? "";
              if (/\$\d[\d,]*\.\d{2}/.test(text)) return true;
            }
            return /\$\d[\d,]*\.\d{2}/.test(document.body.innerText ?? "");
          },
          undefined,
          { timeout: this.config.browserTimeoutMs },
        )
        .catch(() => undefined);
      await appendArtifacts(artifacts, page, runDir, "configured");

      const bodyText = await readQuoteSummaryText(page);
      const manualReviewResult = await detectManualReview(page, bodyText);
      const requirementMismatches = verifySavedRequirements(bodyText, {
        quantity: normalizedQuantity(input),
        materialTerms: materialSummaryTerms,
        finishTerms: finishTerms ?? [],
        toleranceTier: selectedTolerance,
        drawingName:
          input.stagedDrawingFile &&
          drawingUploadVerification !==
            "upload_acknowledged_and_drawing_confirmed"
            ? input.stagedDrawingFile.originalName
            : null,
      });
      const requirementsVerified = requirementMismatches.length === 0;
      if (!manualReviewResult.manualReview && !requirementsVerified) {
        throw new VendorAutomationError(
          `Xometry saved quote did not confirm: ${requirementMismatches.join(", ")}.`,
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: "saved_requirement_mismatch",
            requirementMismatches,
            requestedQuantity: normalizedQuantity(input),
            requestedMaterialTerms: materialSummaryTerms,
            requestedFinishTerms: finishTerms ?? [],
            requestedToleranceInch: input.requirement.tightest_tolerance_inch,
            drawingName: input.stagedDrawingFile?.originalName ?? null,
            url: page.url(),
            bodyExcerpt: excerptText(bodyText),
          },
          await capturePageArtifacts(page, runDir, "requirement-mismatch"),
        );
      }
      const priceResult = await extractParsedValue(
        page,
        XOMETRY_LOCATORS.priceText,
        parseFirstCurrency,
        bodyText,
      );
      const leadTimeResult = await extractParsedValue(
        page,
        XOMETRY_LOCATORS.leadTimeText,
        parseLeadTime,
        bodyText,
      );
      const priceGate = gateVendorPrice(priceResult);
      const totalPrice = priceGate.trusted ? priceResult.value : null;
      const leadTime = gateLeadTime(leadTimeResult, priceGate);
      // A drifted adapter must never publish a price, so the lane routes to
      // review instead of quoting whatever currency string the page happened
      // to contain. See gateVendorPrice for the reasoning.
      const manualReview = manualReviewResult.manualReview || priceGate.locatorDriftDetected;

      priceSource = priceResult.source;
      leadTimeSource = leadTimeResult.source;

      if (priceGate.locatorDriftDetected) {
        detectedFlow = "locator_drift";
      } else if (manualReview) {
        detectedFlow = "manual_review";
      }

      if (!totalPrice && !manualReview) {
        throw new VendorAutomationError(
          "Xometry quote page did not expose a recognizable price after configuration.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
            uploadSelector,
            drawingUploadMode,
            selectedMaterial,
            selectedFinish,
            selectedTolerance,
            priceSource,
            leadTimeSource,
            manualReviewSelector: manualReviewResult.selector,
            url: page.url(),
            detectedFlow,
            bodyExcerpt: excerptText(bodyText),
          },
          await capturePageArtifacts(page, runDir, "missing-price"),
        );
      }

      if (!manualReview) {
        detectedFlow = "instant_quote";
      }

      if (priceGate.locatorDriftDetected) {
        console.warn(
          JSON.stringify({
            service: "overdrafter-cad-worker",
            level: "warn",
            source: "vendor.locator_drift",
            message:
              "Xometry price locators all missed; withheld an unanchored price and routed the lane to manual review.",
            context: {
              vendor: "xometry",
              partId: input.part.id,
              quoteRunId: input.quoteRunId,
              unanchoredPriceObservedUsd: priceGate.unanchoredPriceUsd,
              url: page.url(),
            },
          }),
        );
      }

      await appendArtifacts(artifacts, page, runDir, "result");

      if (this.config.playwrightCaptureTrace && browserContext) {
        const tracePath = path.join(runDir, "trace.zip");
        await browserContext.tracing.stop({ path: tracePath });
        traceStopped = true;
        artifacts.push({
          kind: "trace",
          label: "playwright-trace",
          localPath: tracePath,
          contentType: "application/zip",
        });
      }

      return {
        vendor: "xometry",
        status: manualReview ? "manual_review_pending" : "instant_quote_received",
        unitPriceUsd:
          totalPrice !== null
            ? Math.round((totalPrice / normalizedQuantity(input)) * 100) / 100
            : null,
        totalPriceUsd: totalPrice,
        leadTimeBusinessDays: leadTime,
        quoteUrl: page.url(),
        dfmIssues: [],
        notes: [
          priceGate.locatorDriftDetected
            ? UNANCHORED_PRICE_NOTE
            : manualReview
              ? "Xometry flagged the part for manual review after upload and configuration."
              : "Live Xometry quote captured via Playwright.",
        ],
        artifacts,
        rawPayload: buildRawPayload({
          detectedFlow,
          uploadSelector,
          drawingUploadMode,
          drawingUploadSelector,
          drawingUploadVerification,
          selectedMaterial,
          selectedFinish,
          selectedTolerance,
          toleranceSelector,
          requirementsVerified,
          saveConfigurationSelector,
          priceSource,
          leadTimeSource,
          ...priceGateEvidence(priceGate),
          bodyExcerpt: excerptText(bodyText),
          requestedQuantity: input.requestedQuantity,
          url: page.url(),
        }),
      };
    } catch (error) {
      if (error instanceof VendorAutomationError) {
        throw new VendorAutomationError(
          error.message,
          error.code,
          error.payload,
          [...artifacts, ...error.artifacts],
        );
      }

      throw new VendorAutomationError(
        error instanceof Error ? error.message : "Unexpected Xometry automation failure.",
        "navigation_failure",
        {
          vendor: "xometry",
          detectedFlow,
          uploadSelector,
          drawingUploadMode,
          selectedMaterial,
          selectedFinish,
        },
        artifacts,
      );
    } finally {
      if (browserContext) {
        const maybeTracePath = path.join(runDir, "trace.zip");

        if (this.config.playwrightCaptureTrace && !traceStopped) {
          await browserContext.tracing.stop({ path: maybeTracePath }).catch(() => undefined);
        }

        await browserContext.close().catch(() => undefined);
      }

      await browser?.close().catch(() => undefined);
    }
  }
}
