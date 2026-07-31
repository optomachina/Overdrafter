import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "patchright";
import { Camoufox, launchOptions as camoufoxLaunchOptions } from "camoufox-js";
import { firefox as playwrightFirefox } from "playwright";
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
  return arrival ? countUsFederalBusinessDays(today, arrival) : null;
}

function isSignalPresent(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

export function isManualReviewText(text: string) {
  return isSignalPresent(text, XOMETRY_LOCATORS.manualReviewSignals);
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

async function escapeDashboardIfNeeded(page: Page, timeoutMs: number) {
  const bodyText = await readBodyText(page);
  const isDashboard = XOMETRY_LOCATORS.dashboardSignals.some((pattern) => pattern.test(bodyText));
  if (!isDashboard) {
    return false;
  }

  const startingUrl = page.url();

  // First try: Playwright synthetic click
  for (const selector of XOMETRY_LOCATORS.startNewQuoteButtons) {
    const button = page.locator(selector).first();
    if ((await button.count().catch(() => 0)) === 0) continue;
    if (!(await button.isVisible().catch(() => false))) continue;

    await button.click({ timeout: 5000 }).catch(() => undefined);
    const navigated = await page
      .waitForURL((url) => url.toString() !== startingUrl, { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (navigated) {
      await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
      return true;
    }
  }

  // Fallback: in-page JS click. React onClick handlers sometimes don't fire from Playwright's
  // synthetic click on custom button components but reliably fire from a native HTMLElement.click().
  const jsClicked = await page
    .evaluate(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        /start\s+a\s+new\s+Instant\s+Quote/i.test(b.textContent ?? ""),
      );
      if (button) {
        button.click();
        return true;
      }
      return false;
    })
    .catch(() => false);

  if (jsClicked) {
    const navigated = await page
      .waitForURL((url) => url.toString() !== startingUrl, { timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    if (navigated) {
      await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
    }
    return navigated;
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
) {
  // Three observed paths after upload:
  //   1. Modal "Continue" appears → click → page redirects to /quoting/quote/Q##-XXXX.
  //      Empirically the redirect can take 60-90s on Xometry's side as it
  //      processes the CAD upload before navigating.
  //   2. No modal — Xometry redirects directly to the quote URL.
  //   3. Modal already dismissed by a prior session — the new quote appears as
  //      the topmost tile on the dashboard, which we click.
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
  await capturePageArtifacts(page, runDir, "post-modal-poll").catch(() => undefined);

  // Wait for navigation to the configuration URL using Playwright's native
  // event-based wait. Budget is the full timeoutMs since modal-click → redirect
  // can be slow.
  try {
    await page.waitForURL(XOMETRY_LOCATORS.quotePagePathPattern, { timeout: timeoutMs });
    return { url: page.url(), via: modalSelector ? "modal_redirect" : "auto_redirect", modalSelector };
  } catch {
    await capturePageArtifacts(page, runDir, "wait-for-url-timeout").catch(() => undefined);
    // Fall back to clicking the newest tile if it appeared on the dashboard.
    const tile = page
      .locator('a[href*="/quoting/quote/"], a[href*="get.xometry.com/quote/"]')
      .first();
    if (await tile.isVisible().catch(() => false)) {
      const href = await tile.getAttribute("href").catch(() => null);
      if (href) {
        const target = new URL(href, page.url()).toString();
        await page.goto(target, { waitUntil: "load" });
        await page.waitForLoadState("networkidle").catch(() => undefined);
        return { url: page.url(), via: "tile_click", modalSelector };
      }
    }
    return {
      url: page.url(),
      via: modalSelector ? "modal_no_redirect" : "no_modal_no_tile",
      modalSelector,
    };
  }
}

async function setFilesOnUpload(page: Page, files: string[]) {
  const attemptedSelectors: string[] = [];
  const setInputErrors: Error[] = [];

  for (const selector of XOMETRY_LOCATORS.uploadInputs) {
    attemptedSelectors.push(selector);
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count < 1) continue;
    try {
      await locator.setInputFiles(files);
      return { selector, attemptedSelectors };
    } catch (error) {
      if (error instanceof Error) {
        setInputErrors.push(error);
      }
    }
  }

  throw new VendorAutomationError(
    "Xometry upload input was not found.",
    "selector_failure",
    {
      vendor: "xometry",
      failedSelector: XOMETRY_LOCATORS.uploadInputs[0],
      attemptedSelectors,
      nearbyAttributes: [...XOMETRY_LOCATORS.uploadInputs],
      url: page.url(),
      setInputErrorCount: setInputErrors.length,
    },
  );
}

async function findButtonAndOpen(
  page: Page,
  selectors: readonly string[],
  field: "material" | "finish",
) {
  const match = await firstWorkingLocator(page, selectors);

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

  await match.locator.click();
  return match.selector;
}

async function chooseOptionByTerms(
  page: Page,
  terms: string[],
  optionSelectors: readonly string[],
  field: "material" | "finish",
) {
  for (const term of terms) {
    const roleOption = page
      .getByRole("option", { name: new RegExp(escapeRegex(term), "i") })
      .first();

    if ((await roleOption.count().catch(() => 0)) > 0) {
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
  await findButtonAndOpen(page, controlSelectors, field);
  return chooseOptionByTerms(page, terms, optionSelectors, field);
}

async function saveConfiguration(page: Page, timeoutMs: number) {
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
        timeout: Math.max(timeoutMs, 120_000),
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

    await page
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
        { timeout: Math.max(timeoutMs, 120_000) },
      );
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
      await locator.setInputFiles(drawingPath);
      if (await waitForVisibleFilename(page, drawingName, timeoutMs)) {
        return selector;
      }
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

function includesAnyTerm(text: string, terms: string[]) {
  const normalized = text.toLocaleLowerCase();
  return terms.some((term) => normalized.includes(term.toLocaleLowerCase()));
}

export function hasVisibleFilename(text: string, filename: string) {
  return text.toLocaleLowerCase().includes(filename.toLocaleLowerCase());
}

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
  const quantityPattern = new RegExp(
    String.raw`\bQuantity\s*:?\s*${expected.quantity}\b`,
    "i",
  );

  if (!quantityPattern.test(bodyText)) {
    mismatches.push("quantity");
  }
  if (!includesAnyTerm(bodyText, expected.materialTerms)) {
    mismatches.push("material");
  }
  const finishMatches =
    expected.finishTerms.length > 0
      ? includesAnyTerm(bodyText, expected.finishTerms)
      : /Finish:\s*(?:Standard|As Machined|None)\b/i.test(bodyText);
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
    throw new VendorAutomationError(
      "Xometry authentication is required. Refresh the stored Playwright session.",
      "login_required",
      {
        vendor: "xometry",
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

    const materialTerms = buildMaterialSearchTerms(input.requirement.material);
    if (!materialTerms) {
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

        browserContext = await chromium.launchPersistentContext(
          this.config.xometryUserDataDir,
          persistentLaunchOptions,
        );
      } else {
        browser = await chromium.launch({
          headless: this.config.playwrightHeadless,
          args: launchArgs,
        });

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
      await navigateToQuoteConfigurationPage(page, 120_000, runDir);

      await waitForQuoteSignals(page, this.config.browserTimeoutMs);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await detectBlockingState(page, runDir);
      detectedFlow = "upload_complete";
      await appendArtifacts(artifacts, page, runDir, "uploaded");

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
        const drawingFallbackSelector = await attachDrawingFallback(
          page,
          input.stagedDrawingFile.localPath,
          input.stagedDrawingFile.originalName,
          this.config.browserTimeoutMs,
        );
        if (!drawingFallbackSelector) {
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
        drawingUploadMode = "fallback";
      }

      await page.waitForLoadState("networkidle").catch(() => undefined);
      await detectBlockingState(page, runDir);
      detectedFlow = "configuration_complete";
      const saveConfigurationSelector = await saveConfiguration(
        page,
        this.config.browserTimeoutMs,
      );

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

      const bodyText = await readBodyText(page);
      const requirementMismatches = verifySavedRequirements(bodyText, {
        quantity: normalizedQuantity(input),
        materialTerms,
        finishTerms: finishTerms ?? [],
        toleranceTier: selectedTolerance,
        drawingName: input.stagedDrawingFile?.originalName ?? null,
      });
      if (requirementMismatches.length > 0) {
        throw new VendorAutomationError(
          `Xometry saved quote did not confirm: ${requirementMismatches.join(", ")}.`,
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: "saved_requirement_mismatch",
            requirementMismatches,
            requestedQuantity: normalizedQuantity(input),
            requestedMaterialTerms: materialTerms,
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
      const manualReviewResult = await detectManualReview(page, bodyText);
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
          selectedMaterial,
          selectedFinish,
          selectedTolerance,
          toleranceSelector,
          requirementsVerified: true,
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
        throw error;
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
