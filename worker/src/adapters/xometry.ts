import { captureFreshOperationalRecovery, observeBoundOperationalFailure, type OperationalJevBinding } from "../jev/operationalSession.js";
import { assertCamoufoxAssetsPresent } from "../camoufoxAssets.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  chromium as patchrightChromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "patchright";
import { launchOptions as camoufoxLaunchOptions } from "camoufox-js";
import {
  chromium as playwrightChromium,
  firefox as playwrightFirefox,
} from "playwright";
import { createRunDir, uniqueName } from "../files.js";
import {
  authorizeLiveEvaluationInput,
  getAuthorizedLiveEvaluationFiles,
} from "../liveEvaluationFiles.js";
import {
  VendorAutomationError,
  type HarnessPriceCaptureHook,
  type VendorArtifact,
  type VendorQuoteAdapterOffer,
  type LiveEvaluationUploadFile,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type XometryDrawingUploadMode,
  type XometryQuoteRawPayload,
  type WorkerConfig,
  type VendorName,
} from "../types.js";
import {
  notifyXometryObserver,
  type XometryCatalogObservation,
  type XometryUnavailableObservation,
  type XometryProviderObserver,
  XOMETRY_OBSERVATION_LIMITS,
  unavailableXometryObservation,
} from "../jev/providerObservations.js";
import {
  gateLeadTime,
  gateVendorPrice,
  priceGateEvidence,
  type ValueSource,
  UNANCHORED_PRICE_NOTE,
} from "../extractedValue.js";
import { VendorAdapter } from "./base.js";
import { redactProviderPortalHtml } from "./providerEvidenceRedaction.js";
import { markProviderMutationStarted } from "../providerMutationPhase.js";
import { isDispatchDecisionError } from "../dispatchDecisionError.js";
import type {
  ProviderUploadCapabilityDecision,
  ProviderUploadCapabilityObserved,
} from "../providerUploadCapabilityTypes.js";
import { uploadCapabilityAllowsStagedExtensions } from "../providerUploadCapability.js";
import { ProviderAbortedError } from "../providerAbort.js";
import { ProviderKillSwitchError } from "../providerKillSwitch.js";
import { chromiumSandboxLaunchOptions } from "../chromiumLaunchOptions.js";
import {
  acquireXometryProfileLock,
  withXometryProfileInterprocessLock,
} from "./persistentProfileLock.js";
import {
  persistXometryProfileSnapshot,
  restoreXometryProfileSnapshot,
  withXometryProfileSnapshotLock,
  XometryProfileSnapshotError,
} from "../xometryProfileSnapshot.js";
import { loadCamoufoxLaunchIdentity } from "../camoufoxProfileIdentity.js";
import { launchPersistentCamoufox } from "../camoufoxPersistentContext.js";
import {
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  buildMaterialSummaryTerms,
  XOMETRY_AS_MACHINED_FINISH_TERMS,
  XOMETRY_CNC_PROCESS_TERMS,
  XOMETRY_LOCATORS,
  XOMETRY_URLS,
} from "./xometryConstraints.js";
import {
  collectXometryOffers,
  selectCompatibilityOffer,
} from "./xometryOffers.js";

export const XOMETRY_AUTOMATION_VERSION = "xometry-worker-v1";

const XOMETRY_MODAL_MISSING_ACCEPT_ALLOWED_EXTENSIONS = new Set([
  ".step",
  ".stp",
]);

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

function reportedExecutionContext(input: VendorQuoteAdapterInput) {
  return getAuthorizedLiveEvaluationFiles(input)
    ? ("live_evaluation" as const)
    : undefined;
}

function evaluationContextPayload(
  input: VendorQuoteAdapterInput,
): Pick<XometryQuoteRawPayload, "executionContext"> | Record<string, never> {
  const context = reportedExecutionContext(input);
  return context ? { executionContext: context } : {};
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
const XOMETRY_MODAL_SUBMIT_TIMEOUT_MS = 60_000;
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

/** Preserves the legacy lead-time summary when an offer exposes only an arrival date. */
export function resolveXometryCompatibilityLeadTime(
  offer: VendorQuoteAdapterOffer,
  now = new Date(),
) {
  if (offer.leadTimeBusinessDays !== null) {
    return offer.leadTimeBusinessDays;
  }

  const providerText = offer.rawPayload.providerText;
  return typeof providerText === "string" ? parseLeadTime(providerText, now) : null;
}

function isSignalPresent(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

export function isManualReviewText(text: string) {
  return isSignalPresent(text, XOMETRY_LOCATORS.manualReviewSignals);
}

/**
 * OVD-1052: whether a configured page without a recognizable price is still
 * being priced. Only Xometry's in-progress pricing text on the quote page
 * itself counts; uploader or geometry-analysis loading text does not.
 */
export function isXometryPricingInProgress(input: { url: string; bodyText: string }) {
  return XOMETRY_LOCATORS.quotePagePathPattern.test(input.url)
    && isSignalPresent(input.bodyText, XOMETRY_LOCATORS.quotePricingInProgressSignals);
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

  const dashboardVisible =
    isSignalPresent(input.text, XOMETRY_LOCATORS.dashboardSignals) ||
    XOMETRY_LOCATORS.accountQuoteListSignals.every((pattern) => pattern.test(input.text));
  if (
    input.url.startsWith(XOMETRY_URLS.quoteHome) && !dashboardVisible &&
    isSignalPresent(input.text, XOMETRY_LOCATORS.anonymousUploadPromptSignals)
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
      ...evaluationContextPayload(input),
      detectedFlow: "manual_vendor_followup",
      drawingUploadMode: input.stagedDrawingFile ? "not_needed" : "not_provided",
      bodyExcerpt: reason,
      requestedQuantity: input.requestedQuantity,
      url: XOMETRY_URLS.quoteHome,
      ...details,
    }),
  };
}

/**
 * Keeps the original quote failure while recording the teardown snapshot
 * failure. The snapshot failure was fail-closed (providerMutationPossible), so
 * the combined error stays non-retryable exactly as the snapshot error was.
 */
function withSnapshotTeardownDiagnostic(
  pendingError: VendorAutomationError,
  snapshotError: VendorAutomationError,
): VendorAutomationError {
  const combined = new VendorAutomationError(
    pendingError.message,
    pendingError.code,
    {
      ...pendingError.payload,
      providerMutationPossible: true,
      snapshotTeardownFailure: {
        code: snapshotError.code,
        reason: snapshotError.payload.reason ?? null,
        message: snapshotError.message,
      },
    },
    pendingError.artifacts,
  );
  combined.cause = snapshotError;
  return combined;
}

/**
 * OVD-611: Only the redacted HTML snapshot is captured. Screenshots are not
 * taken because deterministic image masking does not exist (see the provider
 * portal kernel's metadata-only evidence policy).
 */
async function capturePageArtifacts(
  page: Page,
  runDir: string,
  label: string,
): Promise<VendorArtifact[]> {
  const baseName = sanitizeSegment(label);
  const htmlPath = path.join(runDir, `${baseName}.html`);
  const artifacts: VendorArtifact[] = [];
  const failures: Array<{ kind: VendorArtifact["kind"]; message: string }> = [];

  try {
    // Logged-in DOM carries session and account data; never persist it raw.
    const html = redactProviderPortalHtml(await page.content());
    await fs.writeFile(htmlPath, html, { encoding: "utf8", mode: 0o600 });
    artifacts.push({
      kind: "html_snapshot",
      label: `${label}-dom`,
      localPath: htmlPath,
      contentType: "text/html",
    });
  } catch (error) {
    failures.push({
      kind: "html_snapshot",
      message: error instanceof Error ? error.message : "unknown DOM capture failure",
    });
  }

  if (failures.length > 0) {
    console.warn(
      JSON.stringify({
        service: "overdrafter-cad-worker",
        level: "warn",
        source: "vendor.artifact_capture_degraded",
        message: "Xometry diagnostic artifact capture was incomplete.",
        context: {
          vendor: "xometry",
          label,
          missingArtifactKinds: failures.map((failure) => failure.kind),
          failures,
        },
      }),
    );
  }

  return artifacts;
}

async function appendArtifacts(
  artifacts: VendorArtifact[],
  page: Page,
  runDir: string,
  label: string,
) {
  artifacts.push(...(await capturePageArtifacts(page, runDir, label)));
}

/**
 * OVD-779: the price-capture DOM goes through the same redactor as every other
 * snapshot. The adapter never screenshots (OVD-611); only a hook injected by
 * the live-evaluation harness may, and a hook failure never fails the quote.
 */
export async function capturePriceArtifacts(
  page: Page,
  runDir: string,
  harnessHook: HarnessPriceCaptureHook | null,
): Promise<VendorArtifact[]> {
  const artifacts = await capturePageArtifacts(page, runDir, "price-capture");
  if (!harnessHook) return artifacts;
  try {
    artifacts.push(...(await harnessHook({ page, label: "price-capture" })));
  } catch (error) {
    console.warn(
      JSON.stringify({
        service: "overdrafter-cad-worker",
        level: "warn",
        source: "vendor.harness_capture_failed",
        message: "Live-evaluation harness capture hook failed.",
        context: {
          vendor: "xometry",
          error: error instanceof Error ? error.name : "unknown",
        },
      }),
    );
  }
  return artifacts;
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

/**
 * Waits best-effort for authenticated dashboard copy to hydrate.
 * The wait is capped at 10 seconds and suppresses timeout failures so the
 * caller can continue through the normal fail-closed state classification.
 */
async function waitForAuthenticatedDashboardHydration(
  page: Page,
  timeoutMs: number,
) {
  await page.waitForFunction(
    (patterns) => {
      const text = document.body?.innerText ?? "";
      return patterns.accountPatterns.every((pattern) =>
        new RegExp(pattern, "i").test(text)
      ) || patterns.dashboardPatterns.some((pattern) =>
        new RegExp(pattern, "i").test(text)
      );
    },
    {
      accountPatterns: XOMETRY_LOCATORS.accountQuoteListSignals.map(
        (pattern) => pattern.source,
      ),
      dashboardPatterns: XOMETRY_LOCATORS.dashboardSignals.map(
        (pattern) => pattern.source,
      ),
    },
    { timeout: Math.min(timeoutMs, 10_000) },
  ).catch(() => undefined);
}

type ApprovedUploadTarget = {
  allowMissingAccept: boolean;
  locator: Locator;
  panel: Locator | null;
  postUploadButtonSelectors: readonly string[] | null;
  route: "quote_creation" | "quote_home";
  selector: string;
  selectorSet: readonly string[];
  stateId: string;
};

type XometryEntryEvidence = {
  accountQuoteList: boolean;
  dashboardCopy: boolean;
  dashboardInputCount: number;
  dashboardUploadButtonCount: number;
  legacyStartButtonCount: number;
  standaloneInputCount: number;
  route: "quote_creation" | "quote_home" | "quote_configuration" | "other";
};

type XometryEntryStateDefinition = {
  id: string;
  matches: (evidence: XometryEntryEvidence) => boolean;
  resolve: (
    page: Page,
    deadline: number,
    runDir: string,
  ) => Promise<ApprovedUploadTarget | null>;
};

function isExactXometryRoute(value: string, approvedValue: string) {
  try {
    const candidate = new URL(value);
    const approved = new URL(approvedValue);
    return candidate.origin === approved.origin &&
      trimTrailingSlashes(candidate.pathname) ===
        trimTrailingSlashes(approved.pathname);
  } catch {
    return false;
  }
}

function isApprovedAccountQuoteCreationUrl(value: string) {
  return isExactXometryRoute(value, XOMETRY_URLS.quoteCreation);
}

function isApprovedQuoteHomeUrl(value: string) {
  return isExactXometryRoute(value, XOMETRY_URLS.quoteHome);
}

function classifyXometryRoute(value: string): XometryEntryEvidence["route"] {
  if (isApprovedQuoteHomeUrl(value)) return "quote_home";
  if (isApprovedAccountQuoteCreationUrl(value)) return "quote_creation";
  if (XOMETRY_LOCATORS.quotePagePathPattern.test(value)) {
    return "quote_configuration";
  }
  return "other";
}

async function countSelectors(
  page: Page,
  selectors: readonly string[],
  visible = false,
) {
  let count = 0;
  for (const selector of selectors) {
    const scopedSelector = visible ? `${selector}:visible` : selector;
    count += await page.locator(scopedSelector).count().catch(() => 0);
  }
  return count;
}

async function findUniqueSelector(
  page: Page,
  selectors: readonly string[],
  visible = false,
) {
  const scopedSelectors = selectors.map((selector) =>
    visible ? `${selector}:visible` : selector
  );
  const combined = page.locator(scopedSelectors.join(", "));
  if ((await combined.count().catch(() => 0)) !== 1) return null;

  for (const selector of selectors) {
    const scopedSelector = visible ? `${selector}:visible` : selector;
    const locator = page.locator(scopedSelector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return { locator: locator.first(), selector };
    }
  }
  return null;
}

async function waitForUniqueSelector(
  page: Page,
  selectors: readonly string[],
  deadline: number,
) {
  const timeoutMs = Math.max(0, deadline - Date.now());
  if (timeoutMs === 0) return null;
  const attached = await page
    .locator(selectors.join(", "))
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!attached) return null;
  return findUniqueSelector(page, selectors);
}

async function resolveStandaloneUploadTarget(
  page: Page,
  deadline: number,
  stateId: string,
): Promise<ApprovedUploadTarget | null> {
  if (!isApprovedAccountQuoteCreationUrl(page.url())) return null;
  const match = await waitForUniqueSelector(
    page,
    XOMETRY_LOCATORS.standaloneUploadInputs,
    deadline,
  );
  if (!match) return null;
  return {
    ...match,
    allowMissingAccept: false,
    panel: null,
    postUploadButtonSelectors: null,
    route: "quote_creation",
    selectorSet: XOMETRY_LOCATORS.standaloneUploadInputs,
    stateId,
  };
}

async function resolveDashboardUploadTarget(
  page: Page,
  deadline: number,
  stateId: string,
  allowButton: boolean,
): Promise<ApprovedUploadTarget | null> {
  if (!isApprovedQuoteHomeUrl(page.url())) return null;
  let match = await findUniqueSelector(page, XOMETRY_LOCATORS.uploadInputs);
  if (!match && allowButton) {
    const button = await findUniqueSelector(
      page,
      XOMETRY_LOCATORS.dashboardUploadButtons,
      true,
    );
    if (!button) return null;
    const clickTimeoutMs = Math.min(5_000, Math.max(0, deadline - Date.now()));
    if (clickTimeoutMs === 0) return null;
    const clicked = await button.locator
      .click({ timeout: clickTimeoutMs })
      .then(() => true)
      .catch(() => false);
    if (!clicked) return null;
    match = await waitForUniqueSelector(
      page,
      XOMETRY_LOCATORS.uploadInputs,
      deadline,
    );
  }
  if (!match || !isApprovedQuoteHomeUrl(page.url())) return null;
  const panelIndex = XOMETRY_LOCATORS.uploadInputs.findIndex(
    (selector) => selector === match.selector,
  );
  const panelSelector = XOMETRY_LOCATORS.dashboardUploadPanels[panelIndex];
  if (!panelSelector) return null;
  return {
    ...match,
    allowMissingAccept: false,
    panel: page.locator(panelSelector).first(),
    postUploadButtonSelectors: null,
    route: "quote_home",
    selectorSet: XOMETRY_LOCATORS.uploadInputs,
    stateId,
  };
}

async function resolveAccountQuoteModalTarget(
  page: Page,
  deadline: number,
): Promise<ApprovedUploadTarget | null> {
  if (!isApprovedQuoteHomeUrl(page.url())) return null;
  const match = await waitForUniqueSelector(
    page,
    XOMETRY_LOCATORS.accountQuoteModalInputs,
    deadline,
  );
  if (!match || !isApprovedQuoteHomeUrl(page.url())) return null;
  const modalInputSelectors: readonly string[] =
    XOMETRY_LOCATORS.accountQuoteModalInputs;
  const panelIndex = modalInputSelectors.indexOf(match.selector);
  const panelSelector = XOMETRY_LOCATORS.accountQuoteModalPanels[panelIndex];
  if (!panelSelector) return null;
  return {
    ...match,
    allowMissingAccept: true,
    panel: page.locator(panelSelector).first(),
    postUploadButtonSelectors: XOMETRY_LOCATORS.accountQuoteModalSubmitButtons,
    route: "quote_home",
    selectorSet: XOMETRY_LOCATORS.accountQuoteModalInputs,
    stateId: "authenticated_account_dashboard",
  };
}

async function waitForApprovedQuoteCreationRoute(
  page: Page,
  startingUrl: string,
  deadline: number,
) {
  if (
    page.url() !== startingUrl &&
    isApprovedAccountQuoteCreationUrl(page.url())
  ) {
    return true;
  }
  const timeoutMs = Math.max(0, deadline - Date.now());
  if (timeoutMs === 0) return false;
  return page
    .waitForURL(
      (url) =>
        url.toString() !== startingUrl &&
        isApprovedAccountQuoteCreationUrl(url.toString()),
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
}

/** Activates one unambiguous global CTA without touching per-library-file actions. */
async function clickVisibleAccountQuoteListStartButton(
  page: Page,
  deadline: number,
  useDomFallback = false,
) {
  const button = await findUniqueSelector(
    page,
    XOMETRY_LOCATORS.accountQuoteListStartButtons,
    true,
  );
  if (!button) return false;

  const clickTimeoutMs = Math.min(
    5_000,
    Math.max(0, deadline - Date.now()),
  );
  if (clickTimeoutMs === 0) return false;

  if (useDomFallback) {
    return button.locator
      .evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          throw new TypeError("approved quote action is not an HTML element");
        }
        element.click();
      })
      .then(() => true)
      .catch(() => false);
  }
  return button.locator.click({ timeout: clickTimeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function resolveAccountDashboardTarget(
  page: Page,
  deadline: number,
  runDir: string,
): Promise<ApprovedUploadTarget | null> {
  const startingUrl = page.url();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clicked = await clickVisibleAccountQuoteListStartButton(
      page,
      deadline,
      attempt === 1,
    );
    if (clicked) {
      await detectBlockingState(page, runDir);
      if (isApprovedAccountQuoteCreationUrl(page.url())) {
        return resolveStandaloneUploadTarget(
          page,
          deadline,
          "authenticated_account_dashboard",
        );
      }

      const modalDeadline = Math.min(deadline, Date.now() + 5_000);
      const modalTarget = await resolveAccountQuoteModalTarget(
        page,
        modalDeadline,
      );
      if (modalTarget) return modalTarget;
    }
    if (attempt === 0 && Date.now() < deadline) {
      await page.waitForTimeout(500).catch(() => undefined);
    }
  }

  const navigated = await waitForApprovedQuoteCreationRoute(
    page,
    startingUrl,
    deadline,
  );
  await detectBlockingState(page, runDir);
  return navigated
    ? resolveStandaloneUploadTarget(
      page,
      deadline,
      "authenticated_account_dashboard",
    )
    : null;
}

async function resolveLegacyDashboardTarget(
  page: Page,
  deadline: number,
  runDir: string,
): Promise<ApprovedUploadTarget | null> {
  const startingUrl = page.url();
  const button = await findUniqueSelector(
    page,
    XOMETRY_LOCATORS.startNewQuoteButtons,
    true,
  );
  if (!button) return null;
  const clickTimeoutMs = Math.min(5_000, Math.max(0, deadline - Date.now()));
  if (clickTimeoutMs === 0) return null;
  const clicked = await button.locator
    .click({ timeout: clickTimeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!clicked) return null;
  if (await waitForApprovedQuoteCreationRoute(page, startingUrl, deadline)) {
    await detectBlockingState(page, runDir);
    return resolveStandaloneUploadTarget(
      page,
      deadline,
      "legacy_dashboard_start",
    );
  }
  await detectBlockingState(page, runDir);
  return resolveDashboardUploadTarget(
    page,
    deadline,
    "legacy_dashboard_start",
    false,
  );
}

async function collectXometryEntryEvidence(page: Page) {
  const bodyText = await readBodyText(page);
  return {
    accountQuoteList: XOMETRY_LOCATORS.accountQuoteListSignals.every(
      (pattern) => pattern.test(bodyText),
    ),
    dashboardCopy: XOMETRY_LOCATORS.dashboardSignals.some(
      (pattern) => pattern.test(bodyText),
    ),
    dashboardInputCount: await countSelectors(
      page,
      XOMETRY_LOCATORS.uploadInputs,
    ),
    dashboardUploadButtonCount: await countSelectors(
      page,
      XOMETRY_LOCATORS.dashboardUploadButtons,
      true,
    ),
    legacyStartButtonCount: await countSelectors(
      page,
      XOMETRY_LOCATORS.startNewQuoteButtons,
      true,
    ),
    standaloneInputCount: await countSelectors(
      page,
      XOMETRY_LOCATORS.standaloneUploadInputs,
    ),
    route: classifyXometryRoute(page.url()),
  } satisfies XometryEntryEvidence;
}

function buildXometryEntryStateRegistry(): XometryEntryStateDefinition[] {
  return [
    {
      id: "authenticated_account_dashboard",
      matches: (evidence) =>
        evidence.route === "quote_home" && evidence.accountQuoteList,
      resolve: resolveAccountDashboardTarget,
    },
    {
      id: "direct_quote_creation_uploader",
      matches: (evidence) =>
        evidence.route === "quote_creation" &&
        evidence.standaloneInputCount > 0,
      resolve: (page, deadline) =>
        resolveStandaloneUploadTarget(
          page,
          deadline,
          "direct_quote_creation_uploader",
        ),
    },
    {
      id: "direct_quote_home_uploader",
      matches: (evidence) =>
        evidence.route === "quote_home" &&
        !evidence.accountQuoteList &&
        (evidence.dashboardInputCount > 0 ||
          evidence.dashboardUploadButtonCount > 0),
      resolve: (page, deadline) =>
        resolveDashboardUploadTarget(
          page,
          deadline,
          "direct_quote_home_uploader",
          true,
        ),
    },
    {
      id: "legacy_dashboard_start",
      matches: (evidence) =>
        evidence.route === "quote_home" &&
        !evidence.accountQuoteList &&
        evidence.dashboardInputCount === 0 &&
        evidence.dashboardUploadButtonCount === 0 &&
        (evidence.dashboardCopy || evidence.legacyStartButtonCount > 0),
      resolve: resolveLegacyDashboardTarget,
    },
  ];
}

async function resolveXometryEntryState(
  page: Page,
  timeoutMs: number,
  runDir: string,
) {
  const deadline = Date.now() + timeoutMs;
  const evidence = await collectXometryEntryEvidence(page);
  const matches = buildXometryEntryStateRegistry().filter((state) =>
    state.matches(evidence),
  );
  if (matches.length !== 1) {
    throw new VendorAutomationError(
      "Xometry's current page did not match exactly one reviewed entry state.",
      "selector_failure",
      {
        vendor: "xometry",
        reason: matches.length === 0
          ? "entry_state_unknown"
          : "entry_state_ambiguous",
        matchedStates: matches.map((state) => state.id),
        evidence,
      },
    );
  }
  const state = matches[0];
  const target = await state.resolve(page, deadline, runDir);
  if (!target) {
    const transitionArtifacts = await capturePageArtifacts(
      page,
      runDir,
      "entry-transition-failed",
    ).catch(() => []);
    throw new VendorAutomationError(
      "Xometry's reviewed entry state did not produce one approved upload target.",
      "selector_failure",
      {
        vendor: "xometry",
        reason: "entry_state_transition_failed",
        matchedStates: [state.id],
        evidence,
      },
      transitionArtifacts,
    );
  }
  return target;
}

async function waitForQuoteSignals(page: Page, timeoutMs: number) {
  await page.waitForFunction(
    (patterns) => {
      const body = document.body;
      if (!body) return false;
      const text = body.innerText ?? "";
      if (patterns.loadingPatterns.some((pattern) =>
        new RegExp(pattern, "i").test(text)
      )) {
        return false;
      }
      if (new RegExp(patterns.urlPattern).test(window.location.href)) {
        return true;
      }
      return [...patterns.readyPatterns, ...patterns.reviewPatterns].some((pattern) =>
        new RegExp(pattern, "i").test(text),
      );
    },
    {
      readyPatterns: XOMETRY_LOCATORS.quoteReadySignals.map((pattern) => pattern.source),
      reviewPatterns: XOMETRY_LOCATORS.manualReviewSignals.map((pattern) => pattern.source),
      loadingPatterns: XOMETRY_LOCATORS.quoteLoadingSignals.map((pattern) => pattern.source),
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
  beforeSubmit: () => Promise<void> = async () => undefined,
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
    const reviewedContinueSelector = XOMETRY_LOCATORS.exportControlContinue[0];
    const reviewedContinueControls = page.locator(reviewedContinueSelector);
    const reviewedContinue = reviewedContinueControls.first();
    const reviewedContinueCount = await reviewedContinueControls
      .count()
      .catch(() => 0);
    const reviewedContinueVisible = await reviewedContinue
      .isVisible()
      .catch(() => false);
    if (reviewedContinueVisible) {
      const reviewedNoSelector = XOMETRY_LOCATORS.exportControlNo[0];
      const reviewedNo = page.locator(reviewedNoSelector).first();
      const reviewedNoCount = await reviewedNo.count().catch(() => 0);
      const reviewedNoType = await reviewedNo.getAttribute("type").catch(() => null);
      const reviewedNoValue = await reviewedNo.getAttribute("value").catch(() => null);
      const reviewedContinueTestId = await reviewedContinueControls
        .evaluateAll((elements) => {
          if (elements.length !== 1) return null;
          const element = elements[0];
          if (!(element instanceof HTMLElement)) return null;
          return element.dataset.testid ?? null;
        })
        .catch(() => null);
      const reviewedShapeValid =
        reviewedContinueCount === 1 &&
        reviewedNoCount === 1 &&
        reviewedNoType === "radio" &&
        reviewedNoValue === "confirmed-not-itar" &&
        reviewedContinueTestId === "ItarView-itar-continue";
      if (reviewedShapeValid) {
        // OVD-722: outside the try below so a refusal is never relabelled.
        await beforeSubmit();
      }
      if (!reviewedShapeValid) {
        const ambiguityArtifacts = await capturePageArtifacts(
          page,
          runDir,
          "export-control-ambiguous",
        ).catch(() => []);
        throw new VendorAutomationError(
          "Xometry's reviewed export-control controls changed shape.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: "export_control_state_ambiguous",
            reviewedContinueCount,
            reviewedNoCount,
            reviewedNoType,
            reviewedNoValue,
            reviewedContinueTestId,
            url: page.url(),
          },
          ambiguityArtifacts,
        );
      }
      const exportControlAnswerUnverified = async () => {
        const ambiguityArtifacts = await capturePageArtifacts(
          page,
          runDir,
          "export-control-ambiguous",
        ).catch(() => []);
        return new VendorAutomationError(
          "Xometry's reviewed export-control answer could not be verified.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: "export_control_state_ambiguous",
            url: page.url(),
          },
          ambiguityArtifacts,
        );
      };
      try {
        await reviewedNo.evaluate((element) => {
          if (!(element instanceof HTMLInputElement)) {
            throw new TypeError("reviewed non-export-controlled action is not an input");
          }
          element.click();
        });
        const reviewedNoChecked = await reviewedNo.isChecked().catch(() => false);
        if (!reviewedNoChecked) {
          throw new Error("reviewed non-export-controlled action was not selected");
        }
      } catch {
        throw await exportControlAnswerUnverified();
      }
      // OVD-722: Continue submits the answer, so the switch is read again
      // right before it, outside the catches that relabel errors.
      await beforeSubmit();
      try {
        await reviewedContinue.evaluate((element) => {
          if (!(element instanceof HTMLButtonElement)) {
            throw new TypeError("reviewed export-control submit is not a button");
          }
          element.click();
        });
        modalSelector = reviewedContinueSelector;
      } catch {
        throw await exportControlAnswerUnverified();
      }
      break;
    }

    for (const selector of XOMETRY_LOCATORS.exportControlContinue.slice(1, 3)) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await beforeSubmit();
      let nonExportControlledSelector: string | null = null;
      for (const noSelector of XOMETRY_LOCATORS.exportControlNo.slice(1)) {
        const noControl = page.locator(noSelector).first();
        const noAvailable = await noControl.isVisible().catch(() => false);
        if (!noAvailable) continue;
        try {
          await noControl.click();
          nonExportControlledSelector = noSelector;
          break;
        } catch {
          // Try the next dialog-scoped negative control.
        }
      }
      if (!nonExportControlledSelector) {
        const ambiguityArtifacts = await capturePageArtifacts(
          page,
          runDir,
          "export-control-ambiguous",
        ).catch(() => []);
        throw new VendorAutomationError(
          "Xometry requested an export-control answer but no explicit non-export-controlled option was available.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: "export_control_state_ambiguous",
            url: page.url(),
          },
          ambiguityArtifacts,
        );
      }
      // OVD-722: Continue submits the negative answer; read the switch again
      // right before it, outside the catch below.
      await beforeSubmit();
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
  allowMissingAccept: boolean,
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
    if (allowMissingAccept && !observedAccept?.trim() && !loadingErrorVisible) {
      const extensions = files.map((filePath) =>
        path.extname(filePath).toLocaleLowerCase()
      );
      const localAllowlistMatches = extensions.every((extension) =>
        XOMETRY_MODAL_MISSING_ACCEPT_ALLOWED_EXTENSIONS.has(extension)
      );
      if (!localAllowlistMatches) {
        throw new VendorAutomationError(
          "Xometry's reviewed quote modal does not advertise file types, and the staged CAD file is outside the local STEP/STP allowlist.",
          "upload_failure",
          {
            vendor: "xometry",
            reason: "unsupported_file_type",
            accept: null,
            requestedExtensions: extensions,
            localAllowedExtensions: [
              ...XOMETRY_MODAL_MISSING_ACCEPT_ALLOWED_EXTENSIONS,
            ],
            url: page.url(),
          },
        );
      }
      return null;
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
  runDir: string,
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

    await detectBlockingState(page, runDir);

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

    for (const selector of XOMETRY_LOCATORS.exportControlContinue.slice(0, 3)) {
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

  throw new VendorAutomationError(
    "Xometry did not confirm that the reviewed upload completed.",
    "upload_failure",
    {
      vendor: "xometry",
      reason: "upload_progress_not_confirmed",
      filenames,
      url: page.url(),
    },
  );
}

async function hasVisibleReviewedExportControl(page: Page) {
  const matches = await Promise.all(
    XOMETRY_LOCATORS.exportControlContinue.slice(0, 3).map((selector) =>
      page.locator(selector).first().isVisible().catch(() => false)
    ),
  );
  return matches.some(Boolean);
}

/**
 * Submits one reviewed quote modal after upload processing.
 * Existing quote routes bypass submission. Otherwise the helper uses one
 * bounded deadline to discover exactly one submit action and wait for it to
 * become enabled. A reviewed export-control transition is also accepted;
 * missing, duplicate, or disabled actions fail with VendorAutomationError.
 */
async function submitApprovedQuoteModal(
  page: Page,
  target: ApprovedUploadTarget,
  beforeSubmit: () => Promise<void> = async () => undefined,
) {
  if (
    !target.postUploadButtonSelectors ||
    XOMETRY_LOCATORS.quotePagePathPattern.test(page.url())
  ) {
    return;
  }

  const deadline = Date.now() + XOMETRY_MODAL_SUBMIT_TIMEOUT_MS;
  const maxPolls = Math.ceil(
    XOMETRY_MODAL_SUBMIT_TIMEOUT_MS / XOMETRY_UPLOAD_READINESS_POLL_MS,
  );
  let pollCount = 0;
  let button = await findUniqueSelector(
    page,
    target.postUploadButtonSelectors,
    true,
  );
  while (!button && pollCount < maxPolls && Date.now() < deadline) {
    if (await hasVisibleReviewedExportControl(page)) return;
    pollCount += 1;
    await page
      .waitForTimeout(XOMETRY_UPLOAD_READINESS_POLL_MS)
      .catch(() => undefined);
    button = await findUniqueSelector(
      page,
      target.postUploadButtonSelectors,
      true,
    );
  }

  if (!button) {
    if (await hasVisibleReviewedExportControl(page)) return;
    throw new VendorAutomationError(
      "Xometry's reviewed quote modal did not expose one submit action.",
      "selector_failure",
      {
        vendor: "xometry",
        reason: "quote_modal_submit_action_missing",
        route: classifyXometryRoute(page.url()),
        stateId: target.stateId,
      },
    );
  }

  let enabled = await button.locator.isEnabled().catch(() => false);
  while (
    !enabled &&
    pollCount < maxPolls &&
    Date.now() < deadline
  ) {
    pollCount += 1;
    await page
      .waitForTimeout(XOMETRY_UPLOAD_READINESS_POLL_MS)
      .catch(() => undefined);
    enabled = await button.locator.isEnabled().catch(() => false);
  }
  if (!enabled) {
    throw new VendorAutomationError(
      "Xometry's reviewed quote-modal submit action did not become enabled.",
      "unexpected_ui_state",
      {
        vendor: "xometry",
        reason: "quote_modal_submit_action_disabled",
        route: classifyXometryRoute(page.url()),
        stateId: target.stateId,
      },
    );
  }
  // OVD-722: the polling above can take up to a minute; re-read the switch
  // right before the submit click.
  await beforeSubmit();
  await button.locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new TypeError("approved quote submit action is not an HTML element");
    }
    element.click();
  });
}

/** null means not enforced: only the explicit operator live evaluation path. */
type UploadCapabilityGate = {
  checkpoint:
    | ((observation: ProviderUploadCapabilityObserved) => Promise<ProviderUploadCapabilityDecision>)
    | undefined;
};

function buildUploadCapabilityObservation(
  target: ApprovedUploadTarget,
  observedAccept: string | null,
): ProviderUploadCapabilityObserved {
  const entries = (observedAccept ?? "")
    .split(",")
    .map((entry) => entry.trim().toLocaleLowerCase())
    .filter(Boolean);
  const acceptAttributePresent = entries.length > 0;
  return {
    state: "fresh",
    provider: "xometry",
    route: target.route,
    surface: target.allowMissingAccept
      ? "account_quote_modal"
      : target.route === "quote_home"
        ? "dashboard_upload"
        : "standalone_upload",
    revision: target.allowMissingAccept
      ? "xometry-account-quote-modal.v1"
      : "xometry-upload-surface.v1",
    acceptAttributePresent,
    ...(acceptAttributePresent
      ? {
          extensions: entries
            .filter((entry) => entry.startsWith("."))
            .map((entry) => entry.slice(1)),
          mimeTypes: entries.filter((entry) => entry.includes("/")),
        }
      : {}),
  };
}

/**
 * OVD-414: re-resolves the shared capability decision right before file
 * selection. Anything but a passing classification that covers every staged
 * extension, including a missing or throwing checkpoint, selects no files.
 * OVD-863: format drift passes when every staged extension is in admission ∩
 * live accept list, and is logged. Only the classification is carried in the
 * denial, never provider evidence.
 */
async function assertUploadCapabilityAllowsSelection(
  page: Page,
  target: ApprovedUploadTarget,
  observedAccept: string | null,
  filePaths: string[],
  checkpoint:
    | ((observation: ProviderUploadCapabilityObserved) => Promise<ProviderUploadCapabilityDecision>)
    | undefined,
) {
  const deny = (classification: string): never => {
    throw new VendorAutomationError(
      "Xometry's upload capability decision does not permit file selection.",
      "upload_failure",
      {
        vendor: "xometry",
        reason: "upload_capability_denied",
        classification,
        route: classifyXometryRoute(page.url()),
        stateId: target.stateId,
      },
    );
  };
  if (!checkpoint) return deny("decision_missing");
  let decision: ProviderUploadCapabilityDecision;
  try {
    decision = await checkpoint(buildUploadCapabilityObservation(target, observedAccept));
  } catch {
    return deny("decision_unavailable");
  }
  const verdict = uploadCapabilityAllowsStagedExtensions(
    decision,
    filePaths.map((filePath) => path.extname(filePath)),
  );
  if (!verdict.allowed) return deny(verdict.reason.slice(0, 64));
  if (verdict.drift) {
    console.warn(
      JSON.stringify({
        service: "overdrafter-cad-worker",
        level: "warn",
        source: "vendor.upload_capability_format_drift",
        message: "Xometry's live accept list drifted from admission; staged files remain within the admitted intersection.",
        context: {
          vendor: "xometry",
          classification: decision.classification,
          allowedExtensions: decision.allowedExtensions,
          reportedAddedExtensions: decision.reportedAddedExtensions,
          reportedRemovedExtensions: decision.reportedRemovedExtensions,
          route: classifyXometryRoute(page.url()),
          stateId: target.stateId,
        },
      }),
    );
  }
}

async function setFilesOnApprovedUploadTarget(
  page: Page,
  files: string[] | LiveEvaluationUploadFile[],
  filePaths: string[],
  target: ApprovedUploadTarget,
  runDir: string,
  beforeMutation: () => Promise<void> = async () => undefined,
  beforeProviderDisclosure?: () => Promise<void>,
  uploadCapabilityGate: UploadCapabilityGate | null = null,
) {
  const approvedTargets = page.locator(target.selectorSet.join(", "));
  const targetStillApproved = async () => {
    const routeApproved = target.route === "quote_home"
      ? isApprovedQuoteHomeUrl(page.url())
      : isApprovedAccountQuoteCreationUrl(page.url());
    if (!routeApproved) return false;
    if ((await approvedTargets.count().catch(() => 0)) !== 1) return false;
    return (await target.locator.count().catch(() => 0)) === 1;
  };
  if (!(await targetStillApproved())) {
    throw new VendorAutomationError(
      "Xometry's approved upload target became invalid before file selection.",
      "selector_failure",
      {
        vendor: "xometry",
        reason: "approved_upload_target_invalid",
        route: classifyXometryRoute(page.url()),
        stateId: target.stateId,
      },
    );
  }
  const observedAccept = await waitForDashboardUploadReadiness(
    page,
    target.locator,
    filePaths,
    target.allowMissingAccept,
  );
  // OVD-723: the export-control gate is asked again right before the upload.
  await beforeProviderDisclosure?.();
  if (!(await targetStillApproved())) {
    throw new VendorAutomationError(
      "Xometry's approved upload target changed before file selection.",
      "navigation_failure",
      {
        vendor: "xometry",
        reason: "approved_upload_target_changed",
        route: classifyXometryRoute(page.url()),
        stateId: target.stateId,
      },
    );
  }
  if (uploadCapabilityGate) {
    const currentAccept = await target.locator
      .getAttribute("accept", { timeout: XOMETRY_UPLOAD_READINESS_POLL_MS })
      .catch(() => null);
    if ((currentAccept ?? "").trim() !== (observedAccept ?? "").trim()) {
      throw new VendorAutomationError(
        "Xometry's upload accept list changed before file selection.",
        "upload_failure",
        {
          vendor: "xometry",
          reason: "upload_capability_denied",
          classification: "accept_changed",
          route: classifyXometryRoute(page.url()),
          stateId: target.stateId,
        },
      );
    }
    await assertUploadCapabilityAllowsSelection(
      page,
      target,
      currentAccept,
      filePaths,
      uploadCapabilityGate.checkpoint,
    );
  }
  // OVD-722: readiness polling can take many seconds; re-read the switch
  // immediately before the upload.
  await beforeMutation();
  markProviderMutationStarted();
  await target.locator.setInputFiles(files);
  if (target.panel) {
    await waitForDashboardUploadProgress(
      page,
      target.panel,
      filePaths,
      runDir,
    );
  }
  await submitApprovedQuoteModal(page, target, beforeMutation);
  return { selector: target.selector };
}

type XometryOptionField = "process" | "material" | "finish";

async function findButtonAndOpen(
  page: Page,
  selectors: readonly string[],
  field: XometryOptionField,
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
        terminalState: "selector_drift",
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
  // Xometry's searchable comboboxes render "No options" until a search term
  // is typed, so the caller fills each term into the returned search input.
  const searchable = match.isPreferred && controlRole === "combobox";
  if (searchable) {
    await match.locator.press("ArrowDown");
  } else if (!alreadyExpanded) {
    await match.locator.click();
  }
  return { selector: match.selector, searchInput: searchable ? match.locator : null };
}

export async function chooseOptionByTerms(
  page: Page,
  terms: string[],
  optionSelectors: readonly string[],
  field: XometryOptionField,
  controlSelector: string,
  observer?: XometryProviderObserver,
  searchInput: Locator | null = null,
) {
  // The engineering catalog observes material and finish options only.
  const catalogField = field === "process" ? null : field;
  for (const term of terms) {
    if (searchInput) await searchInput.fill(term);
    const roleOption = page
      .getByRole("option", { name: new RegExp(escapeRegex(term), "i") })
      .first();

    const roleOptionVisible = await roleOption
      .waitFor({ state: "visible", timeout: XOMETRY_OPTION_RENDER_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    if (roleOptionVisible) {
      const observation = observer && catalogField
        ? await captureCatalogOption(roleOption, catalogField, controlSelector, "role=option", term)
          .catch(() => unavailableXometryObservation("catalog", "observation_capture_failed"))
        : null;
      try { await roleOption.click(); } finally {
        if (observation) notifyXometryObserver(observer, observation);
      }
      return term;
    }

    for (const selector of optionSelectors) {
      const option = page
        .locator(selector)
        .filter({ hasText: new RegExp(escapeRegex(term), "i") })
        .first();

      if ((await option.count().catch(() => 0)) > 0) {
        const observation = observer && catalogField
          ? await captureCatalogOption(option, catalogField, controlSelector, selector, term)
            .catch(() => unavailableXometryObservation("catalog", "observation_capture_failed"))
          : null;
        try { await option.click(); } finally {
          if (observation) notifyXometryObserver(observer, observation);
        }
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
      terminalState: "selector_drift",
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

async function captureCatalogOption(
  option: Locator,
  field: "material" | "finish",
  controlSelector: string,
  optionSelector: string,
  deterministicTerm: string,
): Promise<XometryCatalogObservation | XometryUnavailableObservation> {
  // These are observations of a chosen custom-widget option, not proof of a
  // stable engineering catalog or approval of equivalent material/process.
  const label = await option.innerText().catch(() => null);
  if ((label?.length ?? 0) > XOMETRY_OBSERVATION_LIMITS.textCodeUnits) return unavailableXometryObservation("catalog");
  const attributes: Record<string, string> = {};
  let attributeCodeUnits = 0;
  for (const name of ["data-option-id", "value", "id", "role"] as const) {
    const value = await option.getAttribute(name).catch(() => null);
    if (value !== null) {
      attributeCodeUnits += name.length + value.length;
      if (attributeCodeUnits > XOMETRY_OBSERVATION_LIMITS.attributeCodeUnits) return unavailableXometryObservation("catalog");
      attributes[name] = value;
    }
  }
  return Object.freeze({
    kind: "catalog", provider: "xometry", field, controlSelector,
    optionSelector, label, attributes: Object.freeze(attributes), deterministicTerm,
    catalogStatus: "unavailable", reason: "custom_widget_engineering_catalog_unavailable",
  });
}

async function configureRequiredOption(
  page: Page,
  terms: string[],
  controlSelectors: readonly string[],
  optionSelectors: readonly string[],
  field: XometryOptionField,
  observer?: XometryProviderObserver,
) {
  const control = await findButtonAndOpen(page, controlSelectors, field);
  return chooseOptionByTerms(
    page, terms, optionSelectors, field, control.selector, observer, control.searchInput,
  );
}

// OVD-777: Xometry auto-selects process, material and finish from the CAD
// geometry or an attached drawing. Process goes first because changing it
// reloads the material and finish catalogs.
const AUTO_SELECTED_FIELDS = ["process", "material", "finish"] as const;
type AutoSelectedField = (typeof AUTO_SELECTED_FIELDS)[number];

const AUTO_SELECTED_FIELD_CONTROLS = {
  process: {
    label: "Process",
    buttons: XOMETRY_LOCATORS.processButtons,
    options: XOMETRY_LOCATORS.processOptions,
  },
  material: {
    label: "Material",
    buttons: XOMETRY_LOCATORS.materialButtons,
    options: XOMETRY_LOCATORS.materialOptions,
  },
  finish: {
    label: "Finish",
    buttons: XOMETRY_LOCATORS.finishButtons,
    options: XOMETRY_LOCATORS.finishOptions,
  },
} as const;

/**
 * Overwrites the listed auto-selected fields with the saved requirement. A
 * control or option Xometry does not offer is left in place so the saved
 * summary read-back reports it as saved_requirement_mismatch.
 */
async function overwriteAutoSelectedRequirements(
  page: Page,
  fields: readonly AutoSelectedField[],
  terms: Record<AutoSelectedField, string[]>,
  beforeConfigure: () => Promise<void>,
  observer?: XometryProviderObserver,
) {
  const selections: Partial<Record<AutoSelectedField, string | null>> = {};
  for (const field of AUTO_SELECTED_FIELDS) {
    if (!fields.includes(field)) continue;
    await beforeConfigure();
    const controls = AUTO_SELECTED_FIELD_CONTROLS[field];
    selections[field] = await configureRequiredOption(
      page, terms[field], controls.buttons, controls.options, field, observer,
    ).catch((error: unknown) => {
      if (error instanceof VendorAutomationError && error.code === "selector_failure") {
        return null;
      }
      throw error;
    });
  }
  return selections;
}

async function saveConfiguration(
  page: Page,
  timeoutMs: number,
  beforeSave: () => Promise<void> = async () => undefined,
) {
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
    await beforeSave();
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

export async function setQuantity(
  page: Page,
  quantity: number,
  binding?: OperationalJevBinding,
  beforeSubmit: () => Promise<void> = async () => undefined,
) {
  const readback = await readVisibleLineItemQuantityInputs(page);

  if (readback.entries.length === 0) {
    const failure = new VendorAutomationError(
      "Xometry quantity input was not found.",
      "selector_failure",
      {
        vendor: "xometry",
        failedSelector: XOMETRY_LOCATORS.lineItemQuantityInputs[0],
        attemptedSelectors: [...XOMETRY_LOCATORS.lineItemQuantityInputs],
        nearbyAttributes: [...XOMETRY_LOCATORS.lineItemQuantityInputs],
        url: page.url(),
      },
    );
    const observe = binding && captureFreshOperationalRecovery(binding, binding.scope);
    if (observe) {
      const observedUrl = page.url();
      await observe({ page: page as unknown as import("playwright").Page, field: "quantity", operation: "fill", value: String(quantity),
        assertBoundary: () => {
          const url = new URL(page.url());
          if (page.url() !== observedUrl || url.origin !== new URL(XOMETRY_URLS.quoteHome).origin
            || classifyXometryRoute(page.url()) !== "quote_configuration") throw new Error("recovery_boundary_changed");
        },
        assertReady: async () => {
          const text = await readBodyText(page);
          if (detectBlockingStateSignal({ text, url: page.url() }) || isManualReviewText(text)) throw new Error("recovery_portal_not_ready");
        },
        beforeMutation: () => { throw new Error("shadow_mutation_prohibited"); },
      });
    }
    throw failure;
  }

  if (readback.entries.length > 1) {
    throw new VendorAutomationError(
      "Xometry shows more than one line-item quantity input.",
      "selector_failure",
      {
        vendor: "xometry",
        reason: "quantity_input_ambiguous",
        failedSelector: readback.selector,
        attemptedSelectors: [...XOMETRY_LOCATORS.lineItemQuantityInputs],
        requestedQuantity: quantity,
        observedLineItemQuantities: readback.entries.map((entry) => entry.value),
        url: page.url(),
      },
    );
  }

  const [{ locator, value }] = readback.entries;
  if (value === quantity) {
    return { selector: readback.selector, filled: false };
  }

  await locator.fill(String(quantity));
  // OVD-722: Enter can submit the form; read the switch again between the
  // fill and the key press.
  await beforeSubmit();
  await locator.press("Enter");

  const observed = await readSettledQuantity(page, locator, quantity);
  if (observed !== quantity) {
    throw new VendorAutomationError(
      "Xometry line-item quantity did not read back the requested quantity after it was filled.",
      "unexpected_ui_state",
      {
        vendor: "xometry",
        reason: "quantity_fill_unverified",
        terminalState: "configuration_required",
        requestedQuantity: quantity,
        observedLineItemQuantities: [observed],
        lineItemQuantitySelector: readback.selector,
        url: page.url(),
      },
    );
  }
  return { selector: readback.selector, filled: true };
}

const XOMETRY_QUANTITY_SETTLE_POLLS = 5;
const XOMETRY_QUANTITY_SETTLE_POLL_MS = 200;

/**
 * Reads the stepper back after Enter. Xometry may re-render or debounce the
 * row, so a correct fill can briefly read stale; poll a bounded number of times
 * for the requested value and return the last value read, so a value that never
 * settles still fails closed.
 */
async function readSettledQuantity(page: Page, locator: Locator, quantity: number) {
  let observed = parseQuantityValue(await locator.inputValue().catch(() => ""));
  for (let poll = 0; poll < XOMETRY_QUANTITY_SETTLE_POLLS && observed !== quantity; poll += 1) {
    await page.waitForTimeout(XOMETRY_QUANTITY_SETTLE_POLL_MS).catch(() => undefined);
    observed = parseQuantityValue(await locator.inputValue().catch(() => ""));
  }
  return observed;
}

function parseQuantityValue(raw: string) {
  const value = raw.trim();
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : null;
}

/**
 * OVD-776: the visible line-item quantity inputs of the first row-scoped
 * selector with a visible match, with their values. Every visible match is
 * returned, so a second row or a stray widget with another value cannot hide
 * behind the first one. Unparseable values are returned as null.
 */
async function readVisibleLineItemQuantityInputs(page: Page) {
  for (const selector of XOMETRY_LOCATORS.lineItemQuantityInputs) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 10);
    const entries: Array<{ locator: Locator; value: number | null }> = [];
    for (let index = 0; index < count; index += 1) {
      const input = locator.nth(index);
      if (!(await input.isVisible().catch(() => false))) continue;
      entries.push({
        locator: input,
        value: parseQuantityValue(await input.inputValue().catch(() => "")),
      });
    }
    if (entries.length > 0) return { selector, entries };
  }
  return { selector: null, entries: [] as Array<{ locator: Locator; value: number | null }> };
}

async function readLineItemQuantities(page: Page) {
  const readback = await readVisibleLineItemQuantityInputs(page);
  return { selector: readback.selector, values: readback.entries.map((entry) => entry.value) };
}

/**
 * Fails closed unless every visible line-item quantity input reads back the
 * requested quantity. The summary `Quantity` row is never trusted for this:
 * the T1 page rendered it as a bare label with no number.
 */
async function lineItemQuantityFailure(page: Page, requestedQuantity: number) {
  const readback = await readLineItemQuantities(page);
  if (readback.values.length === 0 || readback.values.includes(null)) {
    return { reason: "quantity_unverified" as const, ...readback };
  }
  if (readback.values.some((value) => value !== requestedQuantity)) {
    return { reason: "quantity_mismatch" as const, ...readback };
  }
  return null;
}

/**
 * Reads Xometry's quote summary and, only when it exposes no explicit quantity,
 * appends one synthetic `Quantity:` line from the line-item quantity input.
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

  const readback = await readLineItemQuantities(page);
  const [value] = readback.values;
  if (value !== undefined && value !== null && readback.values.every((candidate) => candidate === value)) {
    return `${bodyText}\nQuantity: ${value}`;
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
  drawingFile: string | LiveEvaluationUploadFile,
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

  markProviderMutationStarted();
  await locator.setInputFiles(drawingFile, {
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
  drawingFile: string | LiveEvaluationUploadFile,
  drawingName: string,
  timeoutMs: number,
  beforeAttempt: () => Promise<void> = async () => undefined,
) {
  for (const selector of XOMETRY_LOCATORS.drawingInputs) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);

    if (count < 1) continue;

    // OVD-722: a fresh check before every attempt, outside the try so the
    // catch below can never swallow a refusal.
    await beforeAttempt();
    try {
      const attempt = await attemptDrawingAttachment(
        page,
        locator,
        selector,
        drawingFile,
        drawingName,
        timeoutMs,
      );
      if (attempt.outcome === "verified") return attempt.result;
      if (attempt.outcome === "terminal_failure") return null;
    } catch (error) {
      if (error instanceof ProviderKillSwitchError || error instanceof ProviderAbortedError) throw error;
      // Try the next drawing-specific input.
    }
  }

  return null;
}

type SavedRequirementCheck = {
  quantity: number;
  processTerms: string[];
  materialTerms: string[];
  finishTerms: string[];
  toleranceTier: string | null;
  drawingName: string | null;
};

const QUOTE_SUMMARY_FIELD_LABELS = [
  "Quantity",
  "Process",
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
  // OVD-777: an explicit Process field must name the requested process.
  const processSummary = readQuoteSummaryField(bodyText, "Process");
  if (
    processSummary !== null &&
    !findExactTermMatch(processSummary, expected.processTerms)
  ) {
    mismatches.push("process");
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

/**
 * OVD-777: the process, material and finish mismatches where the summary
 * visibly shows a value Xometry selected on its own, so the adapter can
 * overwrite it. A missing field is left to saved-requirement verification.
 */
function autoSelectedRequirementMismatches(
  bodyText: string,
  expected: SavedRequirementCheck,
): AutoSelectedField[] {
  const mismatches = verifySavedRequirements(bodyText, expected);
  return AUTO_SELECTED_FIELDS.filter(
    (field) =>
      mismatches.includes(field) &&
      readQuoteSummaryField(bodyText, AUTO_SELECTED_FIELD_CONTROLS[field].label) !== null,
  );
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
        terminalState: "captcha",
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
        terminalState: "login_required",
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
        terminalState: "unavailable",
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
        source: "selector" as ValueSource,
        selector: match.selector,
      };
    }
  }

  const fallbackValue = parser(bodyText);

  return {
    value: fallbackValue,
    source: fallbackValue !== null ? ("body_text" as ValueSource) : ("none" as ValueSource),
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

/**
 * Page-side readiness predicate for page.waitForFunction: Xometry recomputes
 * prices after quantity changes and tier cards can finish at different times,
 * so it holds until every available .price-tier card shows both a price and
 * timing evidence. Playwright serializes it into the page, so it must stay
 * self-contained: no module references and no named inner functions.
 *
 * OVD-1052: each card is read as collectXometryOffers reads it, by its
 * rendered text (innerText), which breaks lines between block elements.
 * textContent ran adjacent elements together when the markup had no
 * whitespace between them ("least expensivearrives by nov 3"), which defeated
 * every word boundary below and left each quote waiting out the full timeout;
 * it also read hidden text, so a hidden "Not available" note in every card
 * held a priced page to its timeout.
 *
 * OVD-1052: a card counts as withdrawn exactly when collectXometryOffers can
 * withdraw it. A blank card never is: it is a skeleton still being priced,
 * whatever marks it carries, so the page keeps waiting. A card that shows text
 * but no price and timing is withdrawn only by its own unavailability text, or
 * by a line in the price panel, outside every card, that says with a tier as
 * its subject and without a condition that the tier is unavailable ("Fastest
 * is not available for this part.") when one of the card's rendered lines is
 * exactly that tier name, as its header slot shows it. A statement with a
 * condition ("Fastest is not available for quantities over 50.") withdraws
 * nothing, as it need not apply to the requested quantity. A disabled mark on such a card, around it
 * or in it withdraws nothing: it can be a tier still loading, so the page
 * keeps waiting for it. A card that shows its price and timing counts as
 * priced, unless a mark (disabled, aria-disabled/data-disabled "true",
 * data-available "false", or a disabled/unavailable class token, values
 * compared case-insensitively) sits on it or on an element that encloses it,
 * up to and including its part card (the child of #draggable-parts). The
 * collector withdraws such a card only when no card is left to publish, and
 * refuses it otherwise, so the page settles only once some card counts as
 * priced. A mark above the part card (a "scroll-disabled" class on <body>,
 * say) is not read. A card the page hides (display:none on it or an
 * enclosing element, or a hidden visibility on it) is skipped as the
 * collector skips it, when it is a copy of a shown card: the same text
 * content, ignoring whitespace (its innerText cannot say so, as a browser
 * returns a display:none element's text content). Any other hidden card keeps
 * the page waiting, as it may be a tier the page has not shown yet.
 *
 * OVD-1052: the price panel is located as the collector's locatePricePanel
 * locates it: the innermost element that encloses every card the page shows
 * (a hidden copy elsewhere in the part card does not widen it) and whose
 * rendered lines outside the cards include the "Price and Lead Time" heading.
 * Those lines are read as the collector's checkPartCard reads them: the
 * element's rendered text with each card's rendered text cut out. So a
 * statement split across elements or text nodes ("<strong>Fastest</strong> is
 * not available") counts, and a hidden one does not. When a card's text is
 * not where the element shows it, or no element up to the part card shows
 * the heading, the collector refuses the page and this predicate keeps
 * waiting. A line elsewhere in the part card withdraws nothing: the collector
 * refuses it as ambiguous, as a tier's name there can be a requirement's
 * value ("Finish: Standard"). A card that only mentions the name ("Slower
 * than Fastest") is not withdrawn either. A card with another tier's name as
 * a line of its own would still be withdrawn here and not by the collector,
 * which then refuses that card if it is unpriced.
 *
 * OVD-1052: the page keeps waiting while the collector would refuse what the
 * part card shows, as it may still be changing: loading, saving or
 * re-pricing text anywhere in the part card, cards included ("Loading...",
 * "Refreshing prices", "Fetching new price...", "Saving...", "Please wait"),
 * read once each CAD or drawing file name (the part's file name) is cut out of
 * its line, so "Fetching new price for bracket.step..." still counts;
 * aria-busy on the part card or an element around it; a busy region, progress
 * indicator, spinning icon, active spinner, or spinner, skeleton or shimmer
 * placeholder the page shows in the part card; an element in the panel
 * outside the cards that renders nothing and encloses no card (a tier's
 * placeholder without the card's class); or a panel line that is neither the
 * heading nor an unavailability statement.
 *
 * OVD-1052: the price and timing a card must show are what the collector's
 * parser reads: a "$" or "USD" amount (parsePrices), and "N business days",
 * "Lead time: N days" (parseLeadTime) or an arrival date ("Arrives by Nov 3",
 * "Receive by", "Delivery on"; parseArrivalText). A timed-out wait is refused
 * as pending, so a card the parser prices but this predicate did not
 * ("USD 101.25", "Lead Time: 7 Days") held a priced page pending.
 */
export function xometryPriceTiersSettled(fileNames: string[] = []): boolean {
  const cards = [...document.querySelectorAll(".price-tier")];
  if (cards.length > 0) {
    const view = document.defaultView;
    const shownCards = cards.filter((card) => {
      if (["hidden", "collapse"].includes(view?.getComputedStyle(card).visibility ?? "")) return false;
      for (let element: Element | null = card; element; element = element.parentElement) {
        if (view?.getComputedStyle(element).display === "none") return false;
      }
      return true;
    });
    // A hidden card is skipped only as a copy of a shown card (the same text
    // content, ignoring whitespace), as the collector skips it; it refuses any
    // other, which may be a tier the page has not shown yet.
    const shownContents = shownCards.map((card) => (card.textContent ?? "").replaceAll(/\s+/g, ""));
    if (cards.some((card) => !shownCards.includes(card)
      && !shownContents.includes((card.textContent ?? "").replaceAll(/\s+/g, "")))) {
      return false;
    }
    // Rendered text, as the collector reads it (Playwright's innerText).
    const renderedCards = shownCards.map((card) => ((card as HTMLElement).innerText ?? "").trim());
    // The part card (the child of #draggable-parts around the cards), and
    // what marks it busy: aria-busy on it or around it, or a busy region,
    // progress indicator, spinner or placeholder skeleton in it.
    let partCard: Element | null = shownCards[0] ?? null;
    while (partCard && partCard.parentElement?.id !== "draggable-parts") partCard = partCard.parentElement;
    for (let element = partCard; element; element = element.parentElement) {
      if (element.getAttribute("aria-busy")?.toLowerCase() === "true") return false;
    }
    // Loading, saving or re-pricing text anywhere in the part card, once each
    // known uploaded file name is cut out exactly, including spaces. Keep
    // surrounding status text and the token fallback, as the collector does.
    const withoutFileNames = fileNames.filter(Boolean).sort((a, b) => b.length - a.length)
      .reduce((remaining, fileName) => remaining.replaceAll(fileName, " "), (partCard as HTMLElement | null)?.innerText ?? "");
    for (const line of withoutFileNames.split(/\r?\n/)) {
      const status = line.replaceAll(
        /(?<![\w\-+~#().])[\w\-+~#()]{0,255}(?:\.[\w\-+~#()]{1,255}){0,16}\.(?:step|stp|iges|igs|sldprt|x_t|x_b|stl|3mf|obj|ipt|prt|catpart|par|dxf|dwg|pdf)\b/gi,
        " ",
      );
      if (/\b(?:loading|refreshing|updating|(?:re)?calculating|re-?pricing|fetching|saving|please\s+wait)\b/i.test(status)) {
        return false;
      }
    }
    // The price panel: the innermost element around every card the page
    // shows whose rendered lines outside the cards include the "Price and
    // Lead Time" heading, as the collector's locatePricePanel finds it. A
    // hidden copy is not counted, so it cannot widen the panel to the part
    // card. The search never leaves the part card.
    let panel: Element | null = null;
    let panelLines: string[] = [];
    for (let candidate = shownCards[0]?.parentElement ?? null; candidate && !panel; candidate = candidate.parentElement) {
      if ([...candidate.querySelectorAll(".price-tier")].filter((card) => shownCards.includes(card)).length === shownCards.length) {
        const candidateText = ((candidate as HTMLElement).innerText ?? "").trim();
        // The element's rendered lines outside every card, cut out as the
        // collector's linesOutside does.
        const outside: string[] = [];
        let cursor = 0;
        for (const cardText of renderedCards) {
          if (!cardText) continue;
          const at = candidateText.indexOf(cardText, cursor);
          // A card's text that is not where the element shows it: the
          // collector refuses the page.
          if (at < 0) return false;
          outside.push(candidateText.slice(cursor, at));
          cursor = at + cardText.length;
        }
        outside.push(candidateText.slice(cursor));
        const lines = outside.join("\n").split(/\r?\n/).map((line) => line.replaceAll(/\s+/g, " ").trim()).filter(Boolean);
        if (lines.some((line) => /^price\s+and\s+lead\s+time:?$/i.test(line))) {
          panel = candidate;
          panelLines = lines;
        }
      }
      if (candidate.parentElement?.id === "draggable-parts") break;
    }
    // No element up to the part card shows the heading: the collector refuses the page.
    if (!panel) return false;
    const busyElements = partCard
      ? [...partCard.querySelectorAll([
        '[aria-busy="true" i]',
        '[role="progressbar"]',
        "progress",
        ".fa-spin",
        ".fa-pulse",
        ".fa-spin-pulse",
        ".ant-spin-spinning",
        '[class*="spinner" i]',
        '[class*="skeleton" i]',
        '[class*="shimmer" i]',
      ].join(", "))]
      : [];
    // Every element in the panel outside the cards that encloses no card,
    // outermost only, as the collector's PANEL_OTHER_ELEMENT_SELECTOR reads them.
    const panelElements: Element[] = [];
    const enclosing: Element[] = [panel];
    for (let next = enclosing.shift(); next; next = enclosing.shift()) {
      for (const child of next.children) {
        if (child.matches(".price-tier")) continue;
        if (child.querySelector(".price-tier")) enclosing.push(child);
        else panelElements.push(child);
      }
    }
    // A busy element, or a panel element that renders nothing (a placeholder
    // without the card's class), the page shows keeps the wait going.
    const shownSignals = [...busyElements, ...panelElements].filter((element) => {
      if (["hidden", "collapse"].includes(view?.getComputedStyle(element).visibility ?? "")) return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (view?.getComputedStyle(node).display === "none") return false;
      }
      return busyElements.includes(element) || ((element as HTMLElement).innerText ?? "").trim() === "";
    });
    if (shownSignals.length > 0) return false;
    const statedUnavailable: string[] = [];
    for (const line of panelLines) {
      if (/^price\s+and\s+lead\s+time:?$/i.test(line)) continue;
      const statement = /^(?:the )?(.+?)(?: (?:tier|option))? is (?:currently )?(?:unavailable|not available|not offered)\b/i
        .exec(line);
      // Any other panel line (a "Show more options" control, say) is one the
      // collector refuses, so the page is not taken as settled.
      if (!statement) return false;
      // A statement with a condition ("Fastest is not available for
      // quantities over 50.") withdraws nothing, as the collector never
      // withdraws a card on it: only "for this part", "for this quote", "at
      // this time" or "right now" may follow.
      const unconditional = /^(?:the )?(.+?)(?: (?:tier|option))? is (?:currently )?(?:unavailable|not available|not offered)(?: (?:for this (?:part|quote)|at this time|right now))? ?[.!]?$/i
        .exec(line);
      if (unconditional) statedUnavailable.push(unconditional[1].toLowerCase());
    }
    let availableCardCount = 0;
    for (const [index, card] of shownCards.entries()) {
      const text = renderedCards[index];
      // A blank card is a skeleton still being priced, whatever marks it carries.
      if (text === "") return false;
      // What parsePrices, parseLeadTime and parseArrivalText read.
      const normalizedText = text.replaceAll(/\s+/g, " ").toLowerCase();
      const hasPrice = /\$\s*\d|\bUSD[^\S\r\n]*\d/.test(text);
      const leadTimeText = normalizedText.replaceAll(":", "");
      const hasLeadTime = /\b\d{1,4} (?:business|working) days?\b|\blead time \d{1,4} days?\b/.test(leadTimeText);
      const hasArrival = /\b(?:arrives?|received?|delivery) (?:by|on) [a-z]+ \d{1,2}/.test(normalizedText);
      if (hasPrice && (hasLeadTime || hasArrival)) {
        // A priced card counts unless a mark on it or around it withdraws it.
        let withdrawn = false;
        for (
          let element: Element | null = card;
          element && !withdrawn;
          element = element.parentElement?.id === "draggable-parts" ? null : element.parentElement
        ) {
          let classMarked = false;
          for (const token of (element.getAttribute("class") ?? "").split(/\s+/)) {
            if (/^(?:is-)?(?:disabled|unavailable)$|[-_](?:disabled|unavailable)$/i.test(token)) classMarked = true;
          }
          withdrawn = element.hasAttribute("disabled")
            || element.getAttribute("aria-disabled")?.toLowerCase() === "true"
            || element.getAttribute("data-disabled")?.toLowerCase() === "true"
            || element.getAttribute("data-available")?.toLowerCase() === "false"
            || classMarked;
        }
        if (!withdrawn) availableCardCount += 1;
        continue;
      }
      // An unpriced card is withdrawn only by its own unavailability text or
      // a panel line that names its tier; anything else keeps the wait going.
      const lines = text.split(/\r?\n/).map((line) => line.replaceAll(/\s+/g, " ").trim().toLowerCase());
      if (
        /\b(?:unavailable|not\s+available|not\s+offered|cannot\s+quote|can't\s+quote)\b/i.test(text)
        || statedUnavailable.some((name) => lines.includes(name))
      ) {
        continue;
      }
      return false;
    }
    return availableCardCount > 0;
  }

  return /\$\d[\d,]*\.\d{2}/.test(document.body.innerText ?? "");
}

export class XometryAdapter extends VendorAdapter {
  constructor(
    vendor: VendorName,
    config: WorkerConfig,
    private readonly providerObserver?: XometryProviderObserver,
  ) {
    super(vendor, config);
  }

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
        ...evaluationContextPayload(input),
        detectedFlow: "simulate",
        requestedQuantity: input.requestedQuantity,
        url: quoteUrl,
      }),
    };
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    return this.quoteWithExecutionContext(input, false);
  }

  /** Runs the standalone OVD-407 evaluation path without production authorization. */
  protected async quoteForLiveEvaluation(
    input: VendorQuoteAdapterInput,
  ): Promise<VendorQuoteAdapterOutput> {
    const authorizedInput = await authorizeLiveEvaluationInput(input);
    if (!authorizedInput) {
      throw new VendorAutomationError(
        "Live Xometry evaluation requires a non-export-controlled confirmation bound to the selected files.",
        "unexpected_ui_state",
        {
          vendor: "xometry",
          reason: "evaluation_export_control_authorization_missing",
        },
      );
    }

    return this.quoteWithExecutionContext(
      authorizedInput,
      true,
    );
  }

  private async quoteWithExecutionContext(
    input: VendorQuoteAdapterInput,
    allowLiveEvaluation: boolean,
  ): Promise<VendorQuoteAdapterOutput> {
    const userDataDir = this.config.xometryUserDataDir;
    if (!userDataDir) {
      if (this.config.xometryProfileSnapshotBucket) {
        throw new VendorAutomationError(
          "Xometry snapshot mode requires a local profile directory.",
          "login_required",
          { vendor: "xometry", terminalState: "login_required", reason: "profile_snapshot_unavailable" },
        );
      }
      return this.quoteWithoutSnapshotLock(input, allowLiveEvaluation);
    }

    return withXometryProfileInterprocessLock(
      userDataDir,
      {
        waitMs: this.config.xometryProfileLockWaitMs,
        vendor: "xometry",
      },
      async () => {
        if (!this.config.xometryProfileSnapshotBucket) {
          return this.quoteWithoutSnapshotLock(input, allowLiveEvaluation);
        }
        if (!this.config.xometryProfileSnapshotGeneration) {
          throw new VendorAutomationError(
            "Xometry profile snapshot ownership is unavailable; browser launch is blocked.",
            "login_required",
            { vendor: "xometry", terminalState: "login_required", reason: "profile_snapshot_unavailable" },
          );
        }
        return withXometryProfileSnapshotLock(async () => {
          const restoredConfig = await restoreXometryProfileSnapshot(
            this.config,
          );
          this.config.xometryProfileSnapshotGeneration =
            restoredConfig.xometryProfileSnapshotGeneration;
          return this.quoteWithoutSnapshotLock(input, allowLiveEvaluation);
        });
      },
    );
  }

  private async quoteWithoutSnapshotLock(
    input: VendorQuoteAdapterInput,
    allowLiveEvaluation: boolean,
  ): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.simulateQuote(input);
    }

    const dispatchAuthorization = input.xometryDispatchAuthorization;
    const liveEvaluationUploadFiles = getAuthorizedLiveEvaluationFiles(input);
    const isLiveEvaluation = allowLiveEvaluation && Boolean(liveEvaluationUploadFiles);
    const hasInvalidDispatchAuthorization =
      dispatchAuthorization?.provider !== "xometry" ||
      dispatchAuthorization.envelopeRevision !== "xometry-controlled-beta-envelope.v1" ||
      dispatchAuthorization.nonExportControlled !== true ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        dispatchAuthorization.permitId,
      ) ||
      !/^[a-f0-9]{64}$/.test(dispatchAuthorization.scopeFingerprint);
    if (!isLiveEvaluation && hasInvalidDispatchAuthorization) {
      throw new VendorAutomationError(
        "Live Xometry automation requires a current exact-scope dispatch authorization.",
        "unexpected_ui_state",
        {
          vendor: "xometry",
          reason: "dispatch_authorization_missing",
        },
      );
    }
    const nonExportControlled = isLiveEvaluation
      ? input.liveEvaluationAuthorization?.nonExportControlled === true
      : dispatchAuthorization?.nonExportControlled === true;

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
          terminalState: "login_required",
          expectedLoginUrl: XOMETRY_URLS.login,
        },
      );
    }

    if (
      this.config.xometryProfileSnapshotBucket &&
      !this.config.xometryProfileSnapshotGeneration
    ) {
      throw new VendorAutomationError(
        "Xometry profile snapshot ownership is unavailable; browser launch is blocked.",
        "login_required",
        {
          vendor: "xometry",
          terminalState: "login_required",
          reason: "profile_snapshot_unavailable",
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
    let priceSource: ValueSource;
    let leadTimeSource: ValueSource;
    let saveConfigurationSelector: string | null = null;
    let drawingUploadSelector: string | null = null;
    let drawingUploadVerification: string | null = null;
    let quoteResult: VendorQuoteAdapterOutput | null = null;
    let pendingError: VendorAutomationError | null = null;
    // OVD-723: a gate denial raised before an upload, rethrown unchanged after teardown.
    let dispatchDecisionError: Error | null = null;
    // OVD-722: a kill-switch refusal is surfaced as-is, never as a provider failure.
    let killSwitchError: ProviderKillSwitchError | null = null;
    let snapshotError: VendorAutomationError | null = null;

    try {
      const chromiumLaunch = chromiumSandboxLaunchOptions(this.config);

      if (this.config.xometryBrowserEngine === "camoufox") {
        // Camoufox produces a fresh browser fingerprint per launch. Cloudflare's
        // __cf_bm cookie is tied to fingerprint, so storage-state alone won't
        // keep us authenticated across launches. The persistent Firefox profile
        // preserves storage, while the private launch identity preserves the
        // fingerprint configuration that user_data_dir does not retain.
        if (this.config.xometryUserDataDir) {
          await fs.mkdir(this.config.xometryUserDataDir, { recursive: true });
          const identity = await loadCamoufoxLaunchIdentity(this.config.xometryUserDataDir, {
            required: true,
          });
          const launched = await launchPersistentCamoufox({
            userDataDir: this.config.xometryUserDataDir,
            headless: this.config.playwrightHeadless,
            identityConfig: identity.config,
          });
          browserContext = launched.context as unknown as BrowserContext;
        } else {
          assertCamoufoxAssetsPresent();
          const camoufoxOpts = await camoufoxLaunchOptions({
            headless: this.config.playwrightHeadless,
            window: [1366, 900],
            humanize: true,
            geoip: false,
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
          ...chromiumLaunch,
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
          ...chromiumLaunch,
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
      await input.providerKillSwitchCheckpoint?.("before_navigation");
      await page.goto(XOMETRY_URLS.quoteHome, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await waitForAuthenticatedDashboardHydration(
        page,
        this.config.browserTimeoutMs,
      );
      await detectBlockingState(page, runDir);
      await appendArtifacts(artifacts, page, runDir, "landing");
      const uploadTarget = await resolveXometryEntryState(
        page,
        this.config.browserTimeoutMs,
        runDir,
      );
      if (uploadTarget.stateId !== "direct_quote_home_uploader") {
        await appendArtifacts(artifacts, page, runDir, "post-dashboard");
      }
      await detectBlockingState(page, runDir);

      // Empirically, Xometry's redesigned post-upload flow only redirects to a
      // /quoting/quote/Q##-XXXX configuration page when a single CAD file is
      // uploaded. Bundling cad+drawing keeps the page on the dashboard with
      // an open "are these export-controlled" modal that never resolves to a
      // quote URL. Always upload CAD first; rely on attachDrawingFallback
      // later in the flow to attach the drawing if Xometry asks for it.
      const uploadFiles = liveEvaluationUploadFiles
        ? [liveEvaluationUploadFiles.cad]
        : [input.stagedCadFile.localPath];
      const uploadedFileNames = liveEvaluationUploadFiles
        ? [liveEvaluationUploadFiles.cad.name]
        : [input.stagedCadFile.localPath];
      await input.providerKillSwitchCheckpoint?.("before_upload");
      const uploadResult = await setFilesOnApprovedUploadTarget(
        page,
        uploadFiles,
        uploadedFileNames,
        uploadTarget,
        runDir,
        async () => input.providerKillSwitchCheckpoint?.("before_upload"),
        input.beforeProviderDisclosure,
        isLiveEvaluation ? null : { checkpoint: input.uploadCapabilityCheckpoint },
      );
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
        nonExportControlled,
        async () => input.providerKillSwitchCheckpoint?.("before_configure"),
      );

      await waitForQuoteSignals(page, this.config.browserTimeoutMs);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await detectBlockingState(page, runDir);
      detectedFlow = "upload_complete";
      await appendArtifacts(artifacts, page, runDir, "uploaded");

      const requestedTolerance = selectToleranceTier(
        input.requirement.tightest_tolerance_inch,
      );
      const configuredRequirementCheck: SavedRequirementCheck = {
        quantity: normalizedQuantity(input),
        processTerms: XOMETRY_CNC_PROCESS_TERMS,
        materialTerms: materialSummaryTerms,
        finishTerms: finishTerms ?? [],
        toleranceTier: requestedTolerance.tier,
        drawingName: null,
      };
      // OVD-777: an empty finish request is as-machined, so an auto-applied
      // finish is cleared by selecting As Machined.
      const overwriteTerms: Record<AutoSelectedField, string[]> = {
        process: XOMETRY_CNC_PROCESS_TERMS,
        material: materialTerms,
        finish: finishTerms && finishTerms.length > 0
          ? finishTerms
          : XOMETRY_AS_MACHINED_FINISH_TERMS,
      };
      const configureCheckpoint = async () =>
        input.providerKillSwitchCheckpoint?.("before_configure");
      const uploadedSummaryText = await readQuoteSummaryText(page);
      const uploadedSummaryMismatches = verifySavedRequirements(
        uploadedSummaryText,
        configuredRequirementCheck,
      );
      const uploadedSummaryMatches = uploadedSummaryMismatches.length === 0;
      const uploadedAutoSelections = autoSelectedRequirementMismatches(
        uploadedSummaryText,
        configuredRequirementCheck,
      );

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
        await input.providerKillSwitchCheckpoint?.("before_configure");
        // The quantity lives on the quote page's part row. The configure view
        // that Edit Configuration opens exposed no quantity input the adapter
        // could find on 2026-10-24 (production job 8c17931b), so the quantity
        // is set on the row before the view opens.
        await setQuantity(page, normalizedQuantity(input), this.operationalJev ? { ...this.operationalJev,
          scope: { ...this.operationalJev.scope, provider: "xometry", organizationId: input.organizationId, quoteRunId: input.quoteRunId } } : undefined,
        async () => input.providerKillSwitchCheckpoint?.("before_configure"));
        await openPartConfigurationIfNeeded(
          page,
          this.config.browserTimeoutMs,
        );

        // OVD-777: plate-like geometry can auto-select Sheet Cutting, whose
        // catalog has no CNC material options.
        await overwriteAutoSelectedRequirements(
          page,
          uploadedAutoSelections.filter((field) => field === "process"),
          overwriteTerms,
          configureCheckpoint,
        );

        await input.providerKillSwitchCheckpoint?.("before_configure");
        selectedMaterial = await configureRequiredOption(
          page,
          materialTerms,
          XOMETRY_LOCATORS.materialButtons,
          XOMETRY_LOCATORS.materialOptions,
          "material",
          this.providerObserver ?? this.operationalProviderObserver,
        );

        if (finishTerms && finishTerms.length > 0) {
          await input.providerKillSwitchCheckpoint?.("before_configure");
          selectedFinish = await configureRequiredOption(
            page,
            finishTerms,
            XOMETRY_LOCATORS.finishButtons,
            XOMETRY_LOCATORS.finishOptions,
            "finish",
            this.providerObserver ?? this.operationalProviderObserver,
          );
        } else if (uploadedAutoSelections.includes("finish")) {
          const overwritten = await overwriteAutoSelectedRequirements(
            page,
            ["finish"],
            overwriteTerms,
            configureCheckpoint,
            this.providerObserver ?? this.operationalProviderObserver,
          );
          selectedFinish = overwritten.finish ?? null;
        }

        await input.providerKillSwitchCheckpoint?.("before_configure");
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
          async () => input.providerKillSwitchCheckpoint?.("before_save"),
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
        if (isLiveEvaluation && !liveEvaluationUploadFiles?.drawing) {
          throw new VendorAutomationError(
            "Live Xometry evaluation is missing its authorized drawing payload.",
            "upload_failure",
            {
              vendor: "xometry",
              reason: "evaluation_authorized_drawing_missing",
            },
          );
        }
        await input.providerKillSwitchCheckpoint?.("before_upload");
        await input.beforeProviderDisclosure?.();
        const drawingFallbackResult = await attachDrawingFallback(
          page,
          liveEvaluationUploadFiles?.drawing ?? input.stagedDrawingFile.localPath,
          input.stagedDrawingFile.originalName,
          this.config.browserTimeoutMs,
          async () => input.providerKillSwitchCheckpoint?.("before_upload"),
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

        // OVD-777: Xometry re-derives process, material and finish from the
        // attached drawing ("Matches your drawing"). Overwrite them once and
        // save; the read-back below still fails closed on any remainder.
        await page.waitForLoadState("networkidle").catch(() => undefined);
        const drawingAutoSelections = autoSelectedRequirementMismatches(
          await readQuoteSummaryText(page),
          configuredRequirementCheck,
        );
        if (drawingAutoSelections.length > 0) {
          await configureCheckpoint();
          await openPartConfigurationIfNeeded(
            page,
            this.config.browserTimeoutMs,
          );
          const overwritten = await overwriteAutoSelectedRequirements(
            page,
            drawingAutoSelections,
            overwriteTerms,
            configureCheckpoint,
            this.providerObserver ?? this.operationalProviderObserver,
          );
          if (overwritten.material !== undefined) selectedMaterial = overwritten.material;
          if (overwritten.finish !== undefined) selectedFinish = overwritten.finish;
          saveConfigurationSelector = await saveConfiguration(
            page,
            this.config.browserTimeoutMs,
            async () => input.providerKillSwitchCheckpoint?.("before_save"),
          );
        }
      }

      await page.waitForLoadState("networkidle").catch(() => undefined);
      await detectBlockingState(page, runDir);
      detectedFlow = "configuration_complete";

      // Xometry recomputes prices after quantity changes. Tier cards can finish
      // at different times, so wait until every available card exposes both
      // commercial and timing evidence before parsing the complete option set.
      // OVD-1052: a timed-out wait is kept, not swallowed: the cards that did
      // render are then never published as the complete option set.
      const fileNames = uploadedFileNames.map((filePath) => path.basename(filePath));
      if (input.stagedDrawingFile) {
        fileNames.push(liveEvaluationUploadFiles?.drawing?.name ?? path.basename(input.stagedDrawingFile.localPath));
      }
      const priceTiersSettled = await page
        .waitForFunction(xometryPriceTiersSettled, fileNames, { timeout: this.config.browserTimeoutMs })
        .then(() => true, () => false);
      await appendArtifacts(artifacts, page, runDir, "configured");

      const bodyText = await readQuoteSummaryText(page);
      const manualReviewResult = await detectManualReview(page, bodyText);
      const requirementMismatches = verifySavedRequirements(bodyText, {
        ...configuredRequirementCheck,
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
            requestedProcessTerms: XOMETRY_CNC_PROCESS_TERMS,
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
      // OVD-776: no price is captured until the part row itself reads back
      // the requested quantity. A manual-review page withholds its price instead.
      const quantityFailure = await lineItemQuantityFailure(page, normalizedQuantity(input));
      if (quantityFailure && !manualReviewResult.manualReview) {
        throw new VendorAutomationError(
          quantityFailure.reason === "quantity_mismatch"
            ? "Xometry line-item quantity does not match the requested quantity."
            : "Xometry line-item quantity could not be read back before price capture.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: quantityFailure.reason,
            // OVD-1052: a price-capture refusal on the quote page is a finite stop.
            terminalState: quantityFailure.reason === "quantity_mismatch"
              ? "configuration_required"
              : "selector_drift",
            requestedQuantity: normalizedQuantity(input),
            observedLineItemQuantities: quantityFailure.values,
            lineItemQuantitySelector: quantityFailure.selector,
            attemptedSelectors: [...XOMETRY_LOCATORS.lineItemQuantityInputs],
            url: page.url(),
            bodyExcerpt: excerptText(bodyText),
          },
          await capturePageArtifacts(page, runDir, "quantity-unverified"),
        );
      }
      const offers = manualReviewResult.manualReview
        ? []
        : await collectXometryOffers(
          page,
          normalizedQuantity(input),
          this.providerObserver ?? this.operationalProviderObserver,
          {
            fileNames,
            priceTiersSettled,
            pricingInProgress: isXometryPricingInProgress({ url: page.url(), bodyText }),
          },
        );
      const compatibilityOffer = selectCompatibilityOffer(offers);
      const priceResult = compatibilityOffer
        ? {
            value: compatibilityOffer.totalPriceUsd,
            source: "selector" as ValueSource,
            selector: compatibilityOffer.provenance.containerSelector,
          }
        : await extractParsedValue(
            page,
            XOMETRY_LOCATORS.priceText,
            parseFirstCurrency,
            bodyText,
          );
      const compatibilityLeadTime = compatibilityOffer
        ? resolveXometryCompatibilityLeadTime(compatibilityOffer)
        : null;
      const leadTimeResult = compatibilityOffer
        ? {
            value: compatibilityLeadTime,
            source: compatibilityLeadTime === null
              ? compatibilityOffer.provenance.leadTimeSource
              : "selector" as ValueSource,
            selector: compatibilityOffer.provenance.containerSelector,
          }
        : await extractParsedValue(
            page,
            XOMETRY_LOCATORS.leadTimeText,
            parseLeadTime,
            bodyText,
          );
      const priceGate = gateVendorPrice(priceResult);
      // OVD-1052: a page that asks for review publishes no price. The
      // fallback locators read whatever amount the review page still shows,
      // which can be a struck-through list total, and a manual_review result
      // must stay price-free.
      const totalPrice = priceGate.trusted && !quantityFailure && !manualReviewResult.manualReview
        ? priceResult.value
        : null;
      // OVD-1052: the lead time is quoted beside the price, so it is withheld
      // whenever the price is (a review page, say), never published alone.
      const leadTime = totalPrice === null ? null : gateLeadTime(leadTimeResult, priceGate);
      // A drifted adapter must never publish a price, so the lane routes to
      // review instead of quoting whatever currency string the page happened
      // to contain. See gateVendorPrice for the reasoning.
      const manualReview = manualReviewResult.manualReview || priceGate.locatorDriftDetected;
      artifacts.push(...(await capturePriceArtifacts(
        page,
        runDir,
        isLiveEvaluation ? input.harnessPriceCaptureHook ?? null : null,
      )));

      if (offers.length === 0 && priceGate.trusted && !manualReviewResult.manualReview) {
        throw new VendorAutomationError(
          "Xometry exposed a price but no complete purchasable option containers.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: "xometry_offer_containers_missing",
            // OVD-1052: the collector fails closed on a page without tier
            // cards, so this is a page whose every card is unavailable while
            // a fallback locator still reads an amount: a finite stop that
            // publishes no price.
            terminalState: "selector_drift",
            url: page.url(),
            detectedFlow,
            bodyExcerpt: excerptText(bodyText),
          },
          await capturePageArtifacts(page, runDir, "missing-offer-containers"),
        );
      }

      priceSource = priceResult.source;
      leadTimeSource = leadTimeResult.source;

      if (priceGate.locatorDriftDetected) {
        detectedFlow = "locator_drift";
      } else if (manualReview) {
        detectedFlow = "manual_review";
      }

      if (!totalPrice && !manualReview) {
        // OVD-1052: a finite stop. A quote page that still shows in-progress
        // pricing text (quotePricingInProgressSignals) has not priced the
        // part yet, so the quote is `unavailable` for now and selector repair
        // would chase nothing. Any other configured page without a
        // recognizable price, uploader loading text included, means the
        // adapter's price anchors no longer match it: `selector_drift`.
        const pricingInProgress = isXometryPricingInProgress({ url: page.url(), bodyText });
        throw new VendorAutomationError(
          "Xometry quote page did not expose a recognizable price after configuration.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
            reason: pricingInProgress ? "xometry_price_pending" : "xometry_price_missing",
            terminalState: pricingInProgress ? "unavailable" : "selector_drift",
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

      // OVD-611: Traces hold unredacted DOM snapshots and request headers, so
      // stop without a path: the recording is discarded, never written or uploaded.
      if (this.config.playwrightCaptureTrace && browserContext) {
        await browserContext.tracing.stop();
        traceStopped = true;      }

      // OVD-722: when Xometry redirected on its own and the uploaded summary
      // already matched, no configure or save checkpoint ran after the
      // upload. Check once more before the result is returned.
      if (uploadedSummaryMatches) {
        await input.providerKillSwitchCheckpoint?.("before_save");
      }

      quoteResult = {
        vendor: "xometry",
        status: manualReview ? "manual_review_pending" : "instant_quote_received",
        unitPriceUsd:
          totalPrice !== null
            ? Math.round((totalPrice / normalizedQuantity(input)) * 100) / 100
            : null,
        totalPriceUsd: totalPrice,
        leadTimeBusinessDays: leadTime,
        quoteUrl: page.url(),
        offers,
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
          ...evaluationContextPayload(input),
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
          offers,
          ...priceGateEvidence(priceGate),
          bodyExcerpt: excerptText(bodyText),
          requestedQuantity: input.requestedQuantity,
          url: page.url(),
        }),
      };
    } catch (error) {
      // An export-control or dispatch decision is a hold, not an operational
      // failure, so it is not reported to Jev (as in the portal kernel).
      if (this.operationalJev && !isDispatchDecisionError(error)) await observeBoundOperationalFailure(this.operationalJev, { ...this.operationalJev.scope,
        provider: "xometry", organizationId: input.organizationId, quoteRunId: input.quoteRunId }, error);
      if (isDispatchDecisionError(error)) {
        dispatchDecisionError = error;
      } else if (error instanceof ProviderKillSwitchError) {
        killSwitchError = error;
      } else if (error instanceof VendorAutomationError) {
        pendingError = new VendorAutomationError(
          error.message,
          error.code,
          error.payload,
          [...artifacts, ...error.artifacts],
        );
      } else {
        pendingError = new VendorAutomationError(
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
      }
    } finally {
      let browserClosed = true;
      if (browserContext) {
        if (this.config.playwrightCaptureTrace && !traceStopped) {
          await browserContext.tracing.stop().catch(() => undefined);
        }

        await browserContext.close().catch(() => {
          browserClosed = false;
        });
      }

      await browser?.close().catch(() => {
        browserClosed = false;
      });

      const sessionInvalidated =
        pendingError?.code === "login_required" ||
        pendingError?.code === "captcha" ||
        pendingError?.code === "anti_detection_block";
      if (this.config.xometryProfileSnapshotBucket && sessionInvalidated) {
        this.config.xometryProfileSnapshotGeneration = null;
      }
      if (
        this.config.xometryProfileSnapshotBucket &&
        browserContext &&
        !sessionInvalidated
      ) {
        if (!browserClosed) {
          this.config.xometryProfileSnapshotGeneration = null;
          snapshotError = new VendorAutomationError(
            "Xometry browser did not close cleanly; the profile snapshot was not replaced.",
            "persistence_failure",
            {
              vendor: "xometry",
              reason: "browser_close_failed",
              providerMutationPossible: true,
            },
          );
        } else {
          try {
            const persistedConfig = await persistXometryProfileSnapshot(this.config);
            this.config.xometryProfileSnapshotGeneration =
              persistedConfig.xometryProfileSnapshotGeneration;
          } catch (error) {
            this.config.xometryProfileSnapshotGeneration = null;
            snapshotError = new VendorAutomationError(
              "Xometry profile snapshot could not be persisted after browser closure.",
              "persistence_failure",
              {
                vendor: "xometry",
                reason:
                  error instanceof XometryProfileSnapshotError
                    ? error.reason
                    : "snapshot_write_failed",
                providerMutationPossible: true,
              },
            );
          }
        }
      }
    }

    if (dispatchDecisionError) throw dispatchDecisionError;
    if (killSwitchError) throw killSwitchError;
    if (pendingError) {
      // The quote failure is the primary cause; a teardown snapshot failure is
      // secondary diagnostic evidence and must not mask it.
      if (snapshotError) throw withSnapshotTeardownDiagnostic(pendingError, snapshotError);
      throw pendingError;
    }
    if (snapshotError) throw snapshotError;
    if (!quoteResult) {
      throw new VendorAutomationError(
        "Xometry automation ended without a result.",
        "unexpected_ui_state",
        { vendor: "xometry" },
      );
    }
    return quoteResult;
  }
}
