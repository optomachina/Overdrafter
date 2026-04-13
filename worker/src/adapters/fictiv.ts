import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createRunDir, uniqueName } from "../files.js";
import {
  VendorAutomationError,
  type VendorArtifact,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
} from "../types.js";
import { VendorAdapter } from "./base.js";
import {
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  FICTIV_LOCATORS,
  FICTIV_URLS,
} from "./fictivConstraints.js";

export const FICTIV_AUTOMATION_VERSION = "fictiv-worker-v1";

type FictivDetectedFlow =
  | "simulate"
  | "quote_home"
  | "upload_complete"
  | "configuration_complete"
  | "instant_quote"
  | "manual_review"
  | "manual_vendor_followup";

type FictivValueSource = "selector" | "body_text" | "none";

type FictivResolvedTerms = {
  materialTerms: string[];
  finishTerms: string[];
};

type FictivTermResolution =
  | {
      kind: "resolved";
      terms: FictivResolvedTerms;
    }
  | {
      kind: "manual_followup";
      output: VendorQuoteAdapterOutput;
    };

type FictivLivePrerequisites = {
  stagedCadFile: NonNullable<VendorQuoteAdapterInput["stagedCadFile"]>;
  storageStatePath: string;
};

type FictivLiveSession = {
  browser: Browser;
  browserContext: BrowserContext;
  page: Page;
};

type FictivLiveSelection = {
  uploadSelector: string | null;
  selectedMaterial: string | null;
  selectedFinish: string | null;
};

type FictivParsedQuote = {
  bodyText: string;
  totalPrice: number | null;
  leadTime: number | null;
  manualReview: boolean;
  manualReviewSelector: string | null;
  priceSource: FictivValueSource;
  leadTimeSource: FictivValueSource;
};

type FictivQuoteRawPayload = Record<string, unknown> & {
  automationVersion: string;
  detectedFlow: FictivDetectedFlow;
  uploadSelector?: string | null;
  selectedMaterial?: string | null;
  selectedFinish?: string | null;
  priceSource?: FictivValueSource | null;
  leadTimeSource?: FictivValueSource | null;
  bodyExcerpt?: string;
  artifactStoragePaths?: string[];
  requestedQuantity?: number;
  retryCount?: number;
  failureCode?: string | null;
  url?: string | null;
};

const FIRST_CURRENCY_PATTERN = /\$ ?([\d,]+(?:\.\d{2})?)/;
const LEAD_TIME_PATTERN = /\b(\d{1,4})\s+(?:business\s+)?days?\b/i;

function sanitizeSegment(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
}

function escapeRegex(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function excerptText(text: string) {
  return text.slice(0, 2000);
}

function normalizedQuantity(input: VendorQuoteAdapterInput) {
  return Math.max(1, input.requestedQuantity || input.requirement.quantity || input.part.quantity || 1);
}

function buildRawPayload(overrides: Partial<FictivQuoteRawPayload>): FictivQuoteRawPayload {
  return {
    automationVersion: FICTIV_AUTOMATION_VERSION,
    detectedFlow: "quote_home",
    uploadSelector: null,
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

/**
 * Parse the first dollar-denominated amount from free-form text.
 * Commas are stripped from the captured numeric group before parsing.
 * Returns `null` when no currency-like token is present or parsing is non-finite.
 *
 * @param text Source text to scan.
 * @returns Parsed USD amount or `null`.
 */
export function parseFirstCurrency(text: string): number | null {
  const match = FIRST_CURRENCY_PATTERN.exec(text);
  if (!match) return null;

  const parsed = Number.parseFloat(match[1].replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse the first lead-time value expressed in days from free-form text.
 * Returns `null` when no matching phrase is present or parsing is non-finite.
 *
 * @param text Source text to scan.
 * @returns Parsed lead-time days or `null`.
 */
export function parseLeadTime(text: string): number | null {
  const match = LEAD_TIME_PATTERN.exec(text);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSignalPresent(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Determine whether text indicates Fictiv routed the part to manual review.
 * Matches against controlled manual-review regex patterns in `FICTIV_LOCATORS`.
 *
 * @param text Source text from the page.
 * @returns `true` when manual-review language is detected.
 */
export function isManualReviewText(text: string) {
  return isSignalPresent(text, FICTIV_LOCATORS.manualReviewSignals);
}

/**
 * Detect blocking states that prevent automated quoting.
 * Returns `captcha`, `login_required`, or `null` based on body text and current URL.
 *
 * @param input Object containing body `text` and current `url`.
 * @returns Blocking state signal or `null` when no blocker is detected.
 */
export function detectBlockingStateSignal(input: { text: string; url: string }) {
  if (isSignalPresent(input.text, FICTIV_LOCATORS.captchaSignals)) {
    return "captcha";
  }

  if (input.url.includes("/login") || isSignalPresent(input.text, FICTIV_LOCATORS.loginSignals)) {
    return "login_required";
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
    vendor: "fictiv",
    status: "manual_vendor_followup",
    unitPriceUsd: null,
    totalPriceUsd: null,
    leadTimeBusinessDays: null,
    quoteUrl:
      workerMode === "live"
        ? FICTIV_URLS.quotes
        : `simulated://fictiv/manual/${input.part.id}`,
    dfmIssues: [],
    notes: [reason],
    artifacts: [],
    rawPayload: buildRawPayload({
      detectedFlow: "manual_vendor_followup",
      bodyExcerpt: reason,
      requestedQuantity: input.requestedQuantity,
      url: FICTIV_URLS.quotes,
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

async function waitForQuoteSignals(page: Page, timeoutMs: number) {
  await page.waitForFunction(
    (patterns) =>
      [...patterns.readyPatterns, ...patterns.reviewPatterns].some((pattern) =>
        new RegExp(pattern, "i").test(document.body.innerText),
      ),
    {
      readyPatterns: FICTIV_LOCATORS.quoteReadySignals.map((pattern) => pattern.source),
      reviewPatterns: FICTIV_LOCATORS.manualReviewSignals.map((pattern) => pattern.source),
    },
    {
      timeout: timeoutMs,
    },
  );
}

async function setFilesOnUpload(page: Page, files: string[]) {
  const attemptedSelectors: string[] = [];
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    for (const selector of FICTIV_LOCATORS.uploadInputs) {
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
    "Fictiv upload input was not found.",
    "selector_failure",
    {
      vendor: "fictiv",
      failedSelector: FICTIV_LOCATORS.uploadInputs[0],
      attemptedSelectors,
      nearbyAttributes: [...FICTIV_LOCATORS.uploadInputs],
      url: page.url(),
    },
  );
}

async function setQuantity(page: Page, quantity: number) {
  const match = await firstWorkingLocator(page, FICTIV_LOCATORS.quantityInputs);
  if (!match) {
    return null;
  }

  await match.locator.fill(String(quantity));
  await match.locator.press("Enter").catch(() => undefined);
  return match.selector;
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
      "Fictiv presented a captcha challenge.",
      "captcha",
      {
        vendor: "fictiv",
        url: page.url(),
      },
      artifacts,
    );
  }

  if (signal === "login_required") {
    const artifacts = await capturePageArtifacts(page, runDir, "login-required");
    throw new VendorAutomationError(
      "Fictiv authentication is required. Refresh the stored Playwright session.",
      "login_required",
      {
        vendor: "fictiv",
        url: page.url(),
        expectedLoginUrl: FICTIV_URLS.login,
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
        source: "selector" as FictivValueSource,
        selector: match.selector,
      };
    }
  }

  const fallbackValue = parser(bodyText);
  const source: FictivValueSource = fallbackValue === null ? "none" : "body_text";

  return {
    value: fallbackValue,
    source,
    selector: null,
  };
}

async function detectManualReview(page: Page, bodyText: string) {
  const match = await firstWorkingText(page, FICTIV_LOCATORS.manualReviewText);

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

async function findButtonAndOpen(
  page: Page,
  selectors: readonly string[],
) {
  const match = await firstWorkingLocator(page, selectors);
  if (!match) {
    return null;
  }

  await match.locator.click();
  return match.selector;
}

async function chooseOptionByTerms(
  page: Page,
  terms: string[],
  optionSelectors: readonly string[],
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

  return null;
}

async function trySetMaterialAndFinish(
  page: Page,
  materialTerms: string[],
  finishTerms: string[],
) {
  let selectedMaterial: string | null = null;
  let selectedFinish: string | null = null;

  const materialButtonSelector = await findButtonAndOpen(page, FICTIV_LOCATORS.materialButtons);
  if (materialButtonSelector) {
    selectedMaterial = await chooseOptionByTerms(page, materialTerms, FICTIV_LOCATORS.materialOptions);
  }

  if (finishTerms.length > 0) {
    const finishButtonSelector = await findButtonAndOpen(page, FICTIV_LOCATORS.finishButtons);
    if (finishButtonSelector) {
      selectedFinish = await chooseOptionByTerms(page, finishTerms, FICTIV_LOCATORS.finishOptions);
    }
  }

  return {
    selectedMaterial,
    selectedFinish,
  };
}

async function detectQuoteUrl(page: Page) {
  for (const selector of FICTIV_LOCATORS.quoteLinkAnchors) {
    const link = page.locator(selector).first();
    const count = await link.count().catch(() => 0);
    if (count < 1) {
      continue;
    }

    const href = await link.getAttribute("href").catch(() => null);
    if (typeof href === "string" && href.trim()) {
      return new URL(href, page.url()).toString();
    }
  }

  return page.url();
}

async function navigateToQuoteSurface(page: Page) {
  for (const url of [FICTIV_URLS.upload, FICTIV_URLS.quotes, FICTIV_URLS.home]) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    } catch {
      // Fall through to the next known route.
    }
  }

  throw new VendorAutomationError(
    "Fictiv quote surface could not be reached.",
    "navigation_failure",
    {
      vendor: "fictiv",
      attemptedUrls: [FICTIV_URLS.upload, FICTIV_URLS.quotes, FICTIV_URLS.home],
    },
  );
}

export class FictivAdapter extends VendorAdapter {
  private simulateQuote(input: VendorQuoteAdapterInput): VendorQuoteAdapterOutput {
    const requiresManualReview =
      Boolean(input.drawingFile) &&
      (input.requirement.tightest_tolerance_inch ?? 0.01) <= 0.002;

    if (requiresManualReview) {
      return {
        vendor: "fictiv",
        status: "manual_review_pending",
        unitPriceUsd: null,
        totalPriceUsd: null,
        leadTimeBusinessDays: null,
        quoteUrl: `simulated://fictiv/manual/${input.part.id}`,
        dfmIssues: [],
        notes: [
          "Attached drawing and tight tolerance triggered the Fictiv manual-review lane.",
        ],
        artifacts: [],
        rawPayload: buildRawPayload({
          detectedFlow: "manual_review",
          url: `simulated://fictiv/manual/${input.part.id}`,
          requestedQuantity: input.requestedQuantity,
          source: "fictiv-simulated-adapter",
          mode: this.config.workerMode,
          manualReview: true,
        }),
      };
    }

    const total = Math.round(this.simulatedBaseAmount(input) * 1.08 * 100) / 100;
    const quoteUrl = `simulated://fictiv/${input.part.id}`;

    return {
      vendor: "fictiv",
      status: "instant_quote_received",
      unitPriceUsd: Math.round((total / normalizedQuantity(input)) * 100) / 100,
      totalPriceUsd: total,
      leadTimeBusinessDays: 7,
      quoteUrl,
      dfmIssues: [],
      notes: ["Simulated Fictiv quote generated from the deterministic worker model."],
      artifacts: [],
      rawPayload: buildRawPayload({
        detectedFlow: "simulate",
        requestedQuantity: input.requestedQuantity,
        source: "fictiv-simulated-adapter",
        mode: this.config.workerMode,
        url: quoteUrl,
      }),
    };
  }

  private resolveLiveTerms(input: VendorQuoteAdapterInput): FictivTermResolution {
    const materialTerms = buildMaterialSearchTerms(input.requirement.material);
    if (!materialTerms) {
      return {
        kind: "manual_followup",
        output: buildManualVendorFollowupOutput(
          input,
          this.config.workerMode,
          `Material "${input.requirement.material}" is not mapped to a supported Fictiv option.`,
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
        kind: "manual_followup",
        output: buildManualVendorFollowupOutput(
          input,
          this.config.workerMode,
          `Finish "${input.requirement.finish}" is not mapped to a supported Fictiv option.`,
          {
            selectedFinish: null,
            unmappedField: "finish",
            unmappedValue: input.requirement.finish,
          },
        ),
      };
    }

    return {
      kind: "resolved",
      terms: {
        materialTerms,
        finishTerms: finishTerms ?? [],
      },
    };
  }

  private ensureLivePrerequisites(input: VendorQuoteAdapterInput): FictivLivePrerequisites {
    if (!input.stagedCadFile) {
      throw new VendorAutomationError(
        "Fictiv requires a staged CAD file before quoting can start.",
        "upload_failure",
        {
          vendor: "fictiv",
          reason: "missing_cad_file",
        },
      );
    }

    if (!this.config.fictivStorageStatePath) {
      throw new VendorAutomationError(
        "FICTIV_STORAGE_STATE_PATH or FICTIV_STORAGE_STATE_JSON is not configured for live automation.",
        "login_required",
        {
          vendor: "fictiv",
          expectedLoginUrl: FICTIV_URLS.login,
        },
      );
    }

    return {
      stagedCadFile: input.stagedCadFile,
      storageStatePath: this.config.fictivStorageStatePath,
    };
  }

  private buildLaunchArgs() {
    const launchArgs: string[] = [];

    if (this.config.playwrightDisableSandbox) {
      launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
    }

    if (this.config.playwrightDisableDevShmUsage) {
      launchArgs.push("--disable-dev-shm-usage");
    }

    return launchArgs;
  }

  private async startLiveSession(prerequisites: FictivLivePrerequisites): Promise<FictivLiveSession> {
    const browser = await chromium.launch({
      headless: this.config.playwrightHeadless,
      args: this.buildLaunchArgs(),
    });

    const browserContext = await browser.newContext({
      storageState: prerequisites.storageStatePath,
    });

    browserContext.setDefaultTimeout(this.config.browserTimeoutMs);
    browserContext.setDefaultNavigationTimeout(this.config.browserTimeoutMs);

    if (this.config.playwrightCaptureTrace) {
      await browserContext.tracing.start({
        screenshots: true,
        snapshots: true,
      });
    }

    const page = await browserContext.newPage();
    return { browser, browserContext, page };
  }

  private async uploadAndConfigureQuote(
    page: Page,
    input: VendorQuoteAdapterInput,
    runDir: string,
    artifacts: VendorArtifact[],
    materialTerms: string[],
    finishTerms: string[],
    prerequisites: FictivLivePrerequisites,
  ): Promise<FictivLiveSelection> {
    await navigateToQuoteSurface(page);
    await detectBlockingState(page, runDir);
    await appendArtifacts(artifacts, page, runDir, "landing");

    const uploadFiles = [
      prerequisites.stagedCadFile.localPath,
      input.stagedDrawingFile?.localPath,
    ].filter((value): value is string => Boolean(value));

    const uploadResult = await setFilesOnUpload(page, uploadFiles);

    await waitForQuoteSignals(page, this.config.browserTimeoutMs);
    await detectBlockingState(page, runDir);
    await appendArtifacts(artifacts, page, runDir, "uploaded");

    await setQuantity(page, normalizedQuantity(input));
    const selectionResult = await trySetMaterialAndFinish(page, materialTerms, finishTerms);

    await page.waitForLoadState("networkidle").catch(() => undefined);
    await detectBlockingState(page, runDir);
    await appendArtifacts(artifacts, page, runDir, "configured");

    return {
      uploadSelector: uploadResult.selector,
      selectedMaterial: selectionResult.selectedMaterial,
      selectedFinish: selectionResult.selectedFinish,
    };
  }

  private async extractQuoteData(page: Page): Promise<FictivParsedQuote> {
    const bodyText = await readBodyText(page);
    const priceResult = await extractParsedValue(
      page,
      FICTIV_LOCATORS.priceText,
      parseFirstCurrency,
      bodyText,
    );
    const leadTimeResult = await extractParsedValue(
      page,
      FICTIV_LOCATORS.leadTimeText,
      parseLeadTime,
      bodyText,
    );
    const manualReviewResult = await detectManualReview(page, bodyText);

    return {
      bodyText,
      totalPrice: priceResult.value,
      leadTime: leadTimeResult.value,
      manualReview: manualReviewResult.manualReview,
      manualReviewSelector: manualReviewResult.selector,
      priceSource: priceResult.source,
      leadTimeSource: leadTimeResult.source,
    };
  }

  private async ensurePriceIsPresent(
    totalPrice: number | null,
    manualReview: boolean,
    page: Page,
    runDir: string,
    detectedFlow: FictivDetectedFlow,
    selection: FictivLiveSelection,
    parsed: FictivParsedQuote,
  ) {
    if (totalPrice === null && !manualReview) {
      throw new VendorAutomationError(
        "Fictiv quote page did not expose a recognizable price after configuration.",
        "unexpected_ui_state",
        {
          vendor: "fictiv",
          uploadSelector: selection.uploadSelector,
          selectedMaterial: selection.selectedMaterial,
          selectedFinish: selection.selectedFinish,
          priceSource: parsed.priceSource,
          leadTimeSource: parsed.leadTimeSource,
          manualReviewSelector: parsed.manualReviewSelector,
          url: page.url(),
          detectedFlow,
        },
        await capturePageArtifacts(page, runDir, "missing-price"),
      );
    }
  }

  private async stopTraceAndAttachArtifact(
    browserContext: BrowserContext,
    runDir: string,
    artifacts: VendorArtifact[],
  ) {
    if (!this.config.playwrightCaptureTrace) {
      return false;
    }

    const tracePath = path.join(runDir, "trace.zip");
    await browserContext.tracing.stop({ path: tracePath });
    artifacts.push({
      kind: "trace",
      label: "playwright-trace",
      localPath: tracePath,
      contentType: "application/zip",
    });
    return true;
  }

  private async cleanupLiveSession(
    browserContext: BrowserContext | null,
    browser: Browser | null,
    runDir: string,
    traceStopped: boolean,
  ) {
    if (browserContext) {
      const maybeTracePath = path.join(runDir, "trace.zip");

      if (this.config.playwrightCaptureTrace && !traceStopped) {
        await browserContext.tracing.stop({ path: maybeTracePath }).catch(() => undefined);
      }

      await browserContext.close().catch(() => undefined);
    }

    await browser?.close().catch(() => undefined);
  }

  private rethrowLiveError(
    error: unknown,
    detectedFlow: FictivDetectedFlow,
    uploadSelector: string | null,
    selectedMaterial: string | null,
    selectedFinish: string | null,
    artifacts: VendorArtifact[],
  ): never {
    if (error instanceof VendorAutomationError) {
      throw error;
    }

    throw new VendorAutomationError(
      error instanceof Error ? error.message : "Unexpected Fictiv automation failure.",
      "navigation_failure",
      {
        vendor: "fictiv",
        detectedFlow,
        uploadSelector,
        selectedMaterial,
        selectedFinish,
      },
      artifacts,
    );
  }

  private async quoteLive(
    input: VendorQuoteAdapterInput,
    terms: FictivResolvedTerms,
    prerequisites: FictivLivePrerequisites,
  ): Promise<VendorQuoteAdapterOutput> {
    const { materialTerms, finishTerms } = terms;

    const runDir = await createRunDir(this.config, [
      "fictiv",
      input.quoteRunId,
      uniqueName(input.part.id),
    ]);

    let browser: Browser | null = null;
    let browserContext: BrowserContext | null = null;
    const artifacts: VendorArtifact[] = [];
    let traceStopped = false;
    let detectedFlow: FictivDetectedFlow = "quote_home";
    let uploadSelector: string | null = null;
    let selectedMaterial: string | null = null;
    let selectedFinish: string | null = null;

    try {
      const session = await this.startLiveSession(prerequisites);
      browser = session.browser;
      browserContext = session.browserContext;
      const page = session.page;
      const selection = await this.uploadAndConfigureQuote(
        page,
        input,
        runDir,
        artifacts,
        materialTerms,
        finishTerms,
        prerequisites,
      );
      uploadSelector = selection.uploadSelector;
      selectedMaterial = selection.selectedMaterial;
      selectedFinish = selection.selectedFinish;
      detectedFlow = "configuration_complete";

      const parsed = await this.extractQuoteData(page);
      const totalPrice = parsed.totalPrice;
      const leadTime = parsed.leadTime;
      const manualReview = parsed.manualReview;
      const priceSource = parsed.priceSource;
      const leadTimeSource = parsed.leadTimeSource;
      const bodyText = parsed.bodyText;

      detectedFlow = manualReview ? "manual_review" : "instant_quote";
      await this.ensurePriceIsPresent(totalPrice, manualReview, page, runDir, detectedFlow, selection, parsed);

      await appendArtifacts(artifacts, page, runDir, "result");
      traceStopped = await this.stopTraceAndAttachArtifact(browserContext, runDir, artifacts);

      const quoteUrl = await detectQuoteUrl(page);
      const unitPriceUsd =
        totalPrice === null
          ? null
          : Math.round((totalPrice / normalizedQuantity(input)) * 100) / 100;

      return {
        vendor: "fictiv",
        status: manualReview ? "manual_review_pending" : "instant_quote_received",
        unitPriceUsd,
        totalPriceUsd: totalPrice,
        leadTimeBusinessDays: leadTime,
        quoteUrl,
        dfmIssues: [],
        notes: [
          manualReview
            ? "Fictiv flagged the part for manual review after upload and configuration."
            : "Live Fictiv quote captured via Playwright.",
        ],
        artifacts,
        rawPayload: buildRawPayload({
          detectedFlow,
          uploadSelector,
          selectedMaterial,
          selectedFinish,
          priceSource,
          leadTimeSource,
          bodyExcerpt: excerptText(bodyText),
          requestedQuantity: input.requestedQuantity,
          url: quoteUrl,
          source: "fictiv-live-adapter",
        }),
      };
    } catch (error) {
      this.rethrowLiveError(
        error,
        detectedFlow,
        uploadSelector,
        selectedMaterial,
        selectedFinish,
        artifacts,
      );
    } finally {
      await this.cleanupLiveSession(browserContext, browser, runDir, traceStopped);
    }
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.simulateQuote(input);
    }

    const termResolution = this.resolveLiveTerms(input);
    if (termResolution.kind === "manual_followup") {
      return termResolution.output;
    }

    const prerequisites = this.ensureLivePrerequisites(input);
    return this.quoteLive(input, termResolution.terms, prerequisites);
  }
}
