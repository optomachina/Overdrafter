import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "patchright";
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

      if (this.config.xometryUserDataDir) {
        await fs.mkdir(this.config.xometryUserDataDir, { recursive: true });
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

      // Quantity / material / finish are best-effort on the configuration page.
      // Xometry instant-quote pages already display tier prices for the default
      // quantity + auto-detected material, which satisfies the gate. If the
      // edit controls are present we apply requested overrides; if absent we
      // proceed with displayed defaults rather than failing the run.
      try {
        await setQuantity(page, normalizedQuantity(input));
      } catch (error) {
        if (error instanceof VendorAutomationError && error.code !== "selector_failure") {
          throw error;
        }
      }

      try {
        await findButtonAndOpen(page, XOMETRY_LOCATORS.materialButtons, "material");
        selectedMaterial = await chooseOptionByTerms(
          page,
          materialTerms,
          XOMETRY_LOCATORS.materialOptions,
          "material",
        );
      } catch (error) {
        if (error instanceof VendorAutomationError && error.code !== "selector_failure") {
          throw error;
        }
      }

      if (finishTerms && finishTerms.length > 0) {
        try {
          await findButtonAndOpen(page, XOMETRY_LOCATORS.finishButtons, "finish");
          selectedFinish = await chooseOptionByTerms(
            page,
            finishTerms,
            XOMETRY_LOCATORS.finishOptions,
            "finish",
          );
        } catch (error) {
          if (error instanceof VendorAutomationError && error.code !== "selector_failure") {
            throw error;
          }
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
