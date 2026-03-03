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
  XOMETRY_LOCATORS,
  XOMETRY_URLS,
} from "./xometryConstraints.js";

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
}

function parseFirstCurrency(text: string): number | null {
  const match = text.match(/\$ ?([\d,]+(?:\.\d{2})?)/);
  if (!match) return null;

  const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLeadTime(text: string): number | null {
  const match = text.match(/(\d+)\s+(?:business\s+)?days?/i);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isBlockingSignal(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
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

async function waitForQuoteSignals(page: Page, timeoutMs: number) {
  await page.waitForFunction(
    (patterns) => patterns.some((pattern) => new RegExp(pattern, "i").test(document.body.innerText)),
    XOMETRY_LOCATORS.quoteReadySignals.map((pattern) => pattern.source),
    {
      timeout: timeoutMs,
    },
  );
}

async function setFilesOnUpload(
  page: Page,
  files: string[],
): Promise<string> {
  for (const selector of XOMETRY_LOCATORS.uploadInputs) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);

    if (count < 1) continue;

    try {
      await locator.setInputFiles(files);
      return selector;
    } catch {
      // Try the next known upload locator.
    }
  }

  throw new VendorAutomationError(
    "Xometry upload input was not found.",
    "selector_failure",
    {
      vendor: "xometry",
      failedSelector: XOMETRY_LOCATORS.uploadInputs[0],
      nearbyAttributes: [...XOMETRY_LOCATORS.uploadInputs],
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
        failedSelector: selectors[0],
        nearbyAttributes: [...selectors],
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
    const roleOption = page.getByRole("option", { name: new RegExp(term, "i") }).first();
    if ((await roleOption.count().catch(() => 0)) > 0) {
      await roleOption.click();
      return term;
    }

    for (const selector of optionSelectors) {
      const option = page.locator(selector).filter({ hasText: new RegExp(term, "i") }).first();
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
      nearbyAttributes: [...optionSelectors],
      requestedTerms: terms,
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
        nearbyAttributes: [...XOMETRY_LOCATORS.quantityInputs],
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
  const bodyText = await page.locator("body").innerText().catch(() => "");

  if (isBlockingSignal(bodyText, XOMETRY_LOCATORS.captchaSignals)) {
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

  if (page.url().includes("/login") || isBlockingSignal(bodyText, XOMETRY_LOCATORS.loginSignals)) {
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
}

export class XometryAdapter extends VendorAdapter {
  private async simulateQuote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    const total = this.simulatedBaseAmount(input);

    return {
      vendor: "xometry",
      status: "instant_quote_received",
      unitPriceUsd: Math.round((total / input.requirement.quantity) * 100) / 100,
      totalPriceUsd: total,
      leadTimeBusinessDays: 6,
      quoteUrl: `simulated://xometry/${input.part.id}`,
      dfmIssues: [],
      notes: ["Simulated instant quote generated from the deterministic worker model."],
      artifacts: [],
      rawPayload: {
        mode: this.config.workerMode,
        source: "xometry-adapter",
      },
    };
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.simulateQuote(input);
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

    try {
      await fs.access(this.config.xometryStorageStatePath);
    } catch {
      throw new VendorAutomationError(
        `Xometry storage state file was not found at ${this.config.xometryStorageStatePath}.`,
        "login_required",
        {
          vendor: "xometry",
          expectedLoginUrl: XOMETRY_URLS.login,
          storageStatePath: this.config.xometryStorageStatePath,
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

    try {
      const launchArgs: string[] = [];

      if (this.config.playwrightDisableSandbox) {
        launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
      }

      if (this.config.playwrightDisableDevShmUsage) {
        launchArgs.push("--disable-dev-shm-usage");
      }

      browser = await chromium.launch({
        headless: this.config.playwrightHeadless,
        args: launchArgs,
      });

      browserContext = await browser.newContext({
        storageState: this.config.xometryStorageStatePath,
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
      await page.goto(XOMETRY_URLS.quoteHome, { waitUntil: "domcontentloaded" });
      await detectBlockingState(page, runDir);

      artifacts.push(...(await capturePageArtifacts(page, runDir, "landing")));

      const uploadFiles = [
        input.stagedCadFile.localPath,
        input.stagedDrawingFile?.localPath,
      ].filter((value): value is string => Boolean(value));

      let uploadSelector: string;
      let drawingUploadedInInitialStep = Boolean(input.stagedDrawingFile);

      try {
        uploadSelector = await setFilesOnUpload(page, uploadFiles);
      } catch (error) {
        if (!input.stagedDrawingFile) {
          throw error;
        }

        uploadSelector = await setFilesOnUpload(page, [input.stagedCadFile.localPath]);
        drawingUploadedInInitialStep = false;
      }

      await waitForQuoteSignals(page, this.config.browserTimeoutMs);
      artifacts.push(...(await capturePageArtifacts(page, runDir, "uploaded")));

      await setQuantity(page, input.requirement.quantity);

      const materialTriggerSelector = await findButtonAndOpen(
        page,
        XOMETRY_LOCATORS.materialButtons,
        "material",
      );
      const selectedMaterial = await chooseOptionByTerms(
        page,
        buildMaterialSearchTerms(input.requirement.material),
        XOMETRY_LOCATORS.materialOptions,
        "material",
      );

      let selectedFinish: string | null = null;
      if (input.requirement.finish && !/as.?machined/i.test(input.requirement.finish)) {
        await findButtonAndOpen(page, XOMETRY_LOCATORS.finishButtons, "finish");
        selectedFinish = await chooseOptionByTerms(
          page,
          buildFinishSearchTerms(input.requirement.finish),
          XOMETRY_LOCATORS.finishOptions,
          "finish",
        );
      }

      const postConfigText = await page.locator("body").innerText().catch(() => "");

      let drawingFallbackSelector: string | null = null;
      if (
        input.stagedDrawingFile &&
        (!drawingUploadedInInitialStep ||
          /drawing required|upload drawing|add drawing/i.test(postConfigText))
      ) {
        drawingFallbackSelector = await attachDrawingFallback(page, input.stagedDrawingFile.localPath);
      }

      await page.waitForLoadState("networkidle").catch(() => undefined);
      artifacts.push(...(await capturePageArtifacts(page, runDir, "configured")));

      const bodyText = await page.locator("body").innerText();
      const totalPrice = parseFirstCurrency(bodyText);
      const leadTime = parseLeadTime(bodyText);
      const manualReview = /manual review|required for review|drawing required/i.test(bodyText);

      if (!totalPrice && !manualReview) {
        throw new VendorAutomationError(
          "Xometry quote page did not expose a recognizable price after configuration.",
          "unexpected_ui_state",
          {
            vendor: "xometry",
          uploadSelector,
          drawingUploadedInInitialStep,
          materialTriggerSelector,
          selectedMaterial,
          selectedFinish,
            drawingFallbackSelector,
            url: page.url(),
          },
          await capturePageArtifacts(page, runDir, "missing-price"),
        );
      }

      artifacts.push(...(await capturePageArtifacts(page, runDir, "result")));

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
        unitPriceUsd: totalPrice ? Math.round((totalPrice / input.requirement.quantity) * 100) / 100 : null,
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
        rawPayload: {
          mode: "live",
          uploadSelector,
          drawingUploadedInInitialStep,
          selectedMaterial,
          selectedFinish,
          drawingFallbackSelector,
          bodyExcerpt: bodyText.slice(0, 2000),
        },
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
