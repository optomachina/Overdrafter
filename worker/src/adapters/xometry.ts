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

export function parseLeadTime(text: string): number | null {
  const match = text.match(/(\d+)\s+(?:business\s+)?days?/i);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSignalPresent(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

export function isManualReviewText(text: string) {
  return isSignalPresent(text, XOMETRY_LOCATORS.manualReviewSignals);
}

export function detectBlockingStateSignal(input: { text: string; url: string }) {
  if (isSignalPresent(input.text, XOMETRY_LOCATORS.captchaSignals)) {
    return "captcha";
  }

  if (input.url.includes("/login") || isSignalPresent(input.text, XOMETRY_LOCATORS.loginSignals)) {
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
        /start\s+[aA]\s+[Nn]ew\s+Instant\s+Quote/i.test(b.textContent ?? ""),
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
    },
    {
      timeout: timeoutMs,
    },
  );
}

async function waitAndDismissItarPopup(page: Page, isItar: boolean, timeoutMs: number) {
  // Xometry's authenticated "Start a New Quote" flow shows an ITAR/export-control
  // popup BEFORE opening the file picker. The "No" radio is pre-selected, so for
  // non-ITAR parts we just need to click "Continue". For ITAR parts we click the
  // "Yes" radio first.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bodyText = await readBodyText(page);
    if (XOMETRY_LOCATORS.itarPopupSignals.some((p) => p.test(bodyText))) {
      if (isItar) {
        for (const selector of XOMETRY_LOCATORS.itarYesRadios) {
          const radio = page.locator(selector).first();
          if ((await radio.count().catch(() => 0)) === 0) continue;
          await radio.click({ timeout: 3000 }).catch(() => undefined);
          break;
        }
      }
      for (const selector of XOMETRY_LOCATORS.itarConfirmContinueButtons) {
        const btn = page.locator(selector).first();
        if ((await btn.count().catch(() => 0)) === 0) continue;
        if (!(await btn.isVisible().catch(() => false))) continue;
        await btn.click({ timeout: 3000 }).catch(() => undefined);
        return true;
      }
    }
    try {
      await page.waitForTimeout(250);
    } catch {
      // ignore
    }
  }
  return false;
}

async function setFilesViaChooser(page: Page, files: string[], isItar: boolean) {
  // Xometry's authenticated flow:
  //   1. Click "Start a New Instant Quote" -> ITAR popup appears
  //   2. Click "Continue" -> native OS file picker opens (Playwright intercepts)
  //   3. setFiles on the file chooser
  // We set up the filechooser listener BEFORE the click sequence so it catches
  // the chooser whenever it fires, regardless of whether the ITAR popup appears.
  for (const selector of XOMETRY_LOCATORS.startNewQuoteButtons) {
    const trigger = page.locator(selector).first();
    if ((await trigger.count().catch(() => 0)) === 0) continue;
    if (!(await trigger.isVisible().catch(() => false))) continue;

    const fileChooserPromise = page
      .waitForEvent("filechooser", { timeout: 20_000 })
      .catch(() => null);

    try {
      await trigger.click({ timeout: 5000 });
    } catch {
      continue;
    }

    // ITAR popup may appear; dismiss it so the click chain reaches the file picker.
    await waitAndDismissItarPopup(page, isItar, 5_000);

    const fileChooser = await fileChooserPromise;
    if (fileChooser) {
      await fileChooser.setFiles(files);
      return selector;
    }
    // No file chooser appeared even after dismissing ITAR — try the next variant.
  }
  return null;
}

async function dismissXometryPostUploadPopups(page: Page, isItar: boolean) {
  // After upload, Xometry shows two popups in sequence:
  //   1. ITAR classification ("Is this an ITAR part?") with Yes/No buttons.
  //      Default No for non-ITAR test parts; flip via XOMETRY_PART_IS_ITAR=1 or
  //      requirement.is_itar once that field exists.
  //   2. One-time "rename parts" onboarding modal with an "Okay" button.
  //
  // Bounded to ~10s total (40 × 250ms) with an early exit if neither signal has
  // been observed after the first few polls — keeps unit tests well under the
  // default vitest 5s timeout when popups are absent from the mocked body text.
  const MAX_POLLS = 40;
  const POLL_MS = 250;
  const EARLY_EXIT_POLLS_WITHOUT_SIGNAL = 4;

  let itarDismissed = false;
  let renameDismissed = false;
  let pollsWithoutAnySignal = 0;

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    if (itarDismissed && renameDismissed) break;

    const bodyText = await readBodyText(page);
    const sawItar = XOMETRY_LOCATORS.itarPopupSignals.some((p) => p.test(bodyText));
    const sawRename = XOMETRY_LOCATORS.renamePartsPopupSignals.some((p) => p.test(bodyText));

    if (!sawItar && !sawRename && !itarDismissed && !renameDismissed) {
      pollsWithoutAnySignal += 1;
      if (pollsWithoutAnySignal >= EARLY_EXIT_POLLS_WITHOUT_SIGNAL) {
        break;
      }
    } else {
      pollsWithoutAnySignal = 0;
    }

    if (!itarDismissed && sawItar) {
      if (isItar) {
        for (const selector of XOMETRY_LOCATORS.itarYesRadios) {
          const radio = page.locator(selector).first();
          if ((await radio.count().catch(() => 0)) === 0) continue;
          await radio.click({ timeout: 3000 }).catch(() => undefined);
          break;
        }
      }
      for (const selector of XOMETRY_LOCATORS.itarConfirmContinueButtons) {
        const btn = page.locator(selector).first();
        if ((await btn.count().catch(() => 0)) === 0) continue;
        if (!(await btn.isVisible().catch(() => false))) continue;
        await btn.click({ timeout: 3000 }).catch(() => undefined);
        itarDismissed = true;
        break;
      }
    }

    if (!renameDismissed && sawRename) {
      for (const selector of XOMETRY_LOCATORS.renamePartsAcknowledgeButtons) {
        const btn = page.locator(selector).first();
        if ((await btn.count().catch(() => 0)) === 0) continue;
        if (!(await btn.isVisible().catch(() => false))) continue;
        await btn.click({ timeout: 3000 }).catch(() => undefined);
        renameDismissed = true;
        break;
      }
    }

    if (itarDismissed && renameDismissed) break;
    // Tolerate test mocks that don't implement waitForTimeout — the function may
    // not exist on the locator at all, so we can't rely on .catch().
    try {
      await page.waitForTimeout(POLL_MS);
    } catch {
      // ignore; continue polling without sleep
    }
  }

  return { itarDismissed, renameDismissed };
}

async function setFilesOnUpload(page: Page, files: string[], isItar = false) {
  const attemptedSelectors: string[] = [];
  const deadline = Date.now() + 15_000;

  // Xometry's "Start a New Instant Quote" button programmatically clicks a hidden
  // file input. fileChooser interception is the only mechanism that actually drives
  // Xometry's React state machine — direct setInputFiles on the hidden input is
  // ignored. The Finder window briefly flashes on macOS but Playwright intercepts.
  const chooserSelector = await setFilesViaChooser(page, files, isItar);
  if (chooserSelector) {
    return { selector: `filechooser:${chooserSelector}`, attemptedSelectors: [chooserSelector] };
  }

  while (Date.now() < deadline) {
    for (const selector of XOMETRY_LOCATORS.uploadInputs) {
      if (!attemptedSelectors.includes(selector)) {
        attemptedSelectors.push(selector);
      }

      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);

      if (count < 1) continue;

      try {
        await locator.setInputFiles(files);
        return { selector, attemptedSelectors };
      } catch {
        // Try the next known upload locator.
      }
    }

    await page.waitForTimeout(500);
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

async function attachDrawingFallback(page: Page, drawingPath: string) {
  for (const selector of XOMETRY_LOCATORS.drawingInputs) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);

    if (count < 1) continue;

    try {
      await locator.setInputFiles(drawingPath);
      return selector;
    } catch {
      // Try the next drawing-specific input.
    }
  }

  return null;
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

    if (!this.config.xometryStorageStatePath) {
      throw new VendorAutomationError(
        "XOMETRY_STORAGE_STATE_PATH is not configured for live automation.",
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
          storageState: this.config.xometryStorageStatePath,
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

      const uploadFiles = [
        input.stagedCadFile.localPath,
        input.stagedDrawingFile?.localPath,
      ].filter((value): value is string => Boolean(value));

      const isItar = process.env.XOMETRY_PART_IS_ITAR === "1";

      try {
        const uploadResult = await setFilesOnUpload(page, uploadFiles, isItar);
        uploadSelector = uploadResult.selector;
      } catch (error) {
        if (!input.stagedDrawingFile) {
          throw error;
        }

        const uploadResult = await setFilesOnUpload(page, [input.stagedCadFile.localPath], isItar);
        uploadSelector = uploadResult.selector;
        drawingUploadMode = "not_needed";
      }

      // Xometry's post-upload flow on /quoting/home/:
      //   1) ITAR popup is handled inside setFilesOnUpload (it appears BEFORE the
      //      file picker in fresh sessions).
      //   2) one-time rename-parts onboarding popup -> click Okay
      //   3) page navigates to /quoting/quote/<QID> (the configurator)
      await dismissXometryPostUploadPopups(page, isItar);
      await page
        .waitForURL(/\/quoting\/quote\//, { timeout: this.config.browserTimeoutMs })
        .catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: this.config.browserTimeoutMs })
        .catch(() => undefined);
      await detectBlockingState(page, runDir);
      detectedFlow = "upload_complete";
      await appendArtifacts(artifacts, page, runDir, "uploaded");

      await setQuantity(page, normalizedQuantity(input));

      // Xometry auto-detects geometry and pre-selects material/finish that match
      // the part. If the requirement material/finish already appear on the page,
      // skip the dropdown manipulation — opening the dropdown without a matching
      // option throws and aborts an otherwise valid quote.
      const preConfigText = await readBodyText(page);
      const materialAlreadyMatches = materialTerms.some((term) =>
        new RegExp(escapeRegex(term), "i").test(preConfigText),
      );
      if (!materialAlreadyMatches) {
        try {
          await findButtonAndOpen(page, XOMETRY_LOCATORS.materialButtons, "material");
          selectedMaterial = await chooseOptionByTerms(
            page,
            materialTerms,
            XOMETRY_LOCATORS.materialOptions,
            "material",
          );
        } catch (error) {
          // Material may be locked or auto-detected; surface as best-effort.
          if (!(error instanceof VendorAutomationError)) throw error;
        }
      } else {
        selectedMaterial = materialTerms[0];
      }

      if (finishTerms && finishTerms.length > 0) {
        const finishAlreadyMatches = finishTerms.some((term) =>
          new RegExp(escapeRegex(term), "i").test(preConfigText),
        );
        if (!finishAlreadyMatches) {
          try {
            await findButtonAndOpen(page, XOMETRY_LOCATORS.finishButtons, "finish");
            selectedFinish = await chooseOptionByTerms(
              page,
              finishTerms,
              XOMETRY_LOCATORS.finishOptions,
              "finish",
            );
          } catch (error) {
            if (!(error instanceof VendorAutomationError)) throw error;
          }
        } else {
          selectedFinish = finishTerms[0];
        }
      }

      const postConfigText = await readBodyText(page);

      if (
        input.stagedDrawingFile &&
        (drawingUploadMode === "not_needed" || /drawing required|upload drawing|add drawing/i.test(postConfigText))
      ) {
        const drawingFallbackSelector = await attachDrawingFallback(
          page,
          input.stagedDrawingFile.localPath,
        );
        if (drawingFallbackSelector) {
          drawingUploadMode = "fallback";
        }
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
          { timeout: this.config.browserTimeoutMs },
        )
        .catch(() => undefined);
      await appendArtifacts(artifacts, page, runDir, "configured");

      const bodyText = await readBodyText(page);
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
      const totalPrice = priceResult.value;
      const leadTime = leadTimeResult.value;
      const manualReview = manualReviewResult.manualReview;

      priceSource = priceResult.source;
      leadTimeSource = leadTimeResult.source;

      if (manualReview) {
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
            priceSource,
            leadTimeSource,
            manualReviewSelector: manualReviewResult.selector,
            url: page.url(),
            detectedFlow,
          },
          await capturePageArtifacts(page, runDir, "missing-price"),
        );
      }

      if (!manualReview) {
        detectedFlow = "instant_quote";
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
          manualReview
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
          priceSource,
          leadTimeSource,
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
