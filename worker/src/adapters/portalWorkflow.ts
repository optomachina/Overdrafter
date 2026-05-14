import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { VendorAdapter } from "./base.js";
import {
  VendorAutomationError,
  type LiveAutomationVendorName,
  type VendorArtifact,
  type VendorName,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type WorkerConfig,
} from "../types.js";

export type PortalQuoteWorkflow = {
  vendor: LiveAutomationVendorName;
  displayName: string;
  source: string;
  publicUrl: string;
  loginUrl: string;
  uploadUrl: string;
  processFamily: "sheet_metal" | "multi_process";
  supportedFileExtensions: string[];
  officialNotes: string[];
};

type ExtractedQuoteSignal = {
  totalPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
};

const PRICE_PATTERN = /(?:\$|usd\s*)\s*(\d[\d,]*(?:\.\d{2})?)/i;
const LEAD_TIME_PATTERN = /(\d{1,3})\s*(?:business\s*)?(?:day|days)\b/i;
const MANUAL_REVIEW_PATTERN = /\b(manual review|engineering review|reviewing|requires review|quote request received)\b/i;
const CONFIGURATION_REQUIRED_PATTERN =
  /\b(set (?:size and )?material|enter your zip code|specify your parts configuration|select a technology|select material|select thickness|configure (?:your )?part|checkout)\b/i;
const LOGIN_ROUTE_PATTERN = /\b(login|signin|sign-in|registration|register)\b/i;
const UPLOAD_SURFACE_TRIGGERS = [
  "get a quote",
  "get started",
  "start quote",
  "new quote",
  "add parts",
  "upload part",
] as const;
const FILE_CHOOSER_TRIGGERS = [
  "browse files",
  "select files",
  "select files to get instant quote",
  "upload part",
  "upload file",
  "add parts",
] as const;

export class PortalQuoteWorkflowAdapter extends VendorAdapter {
  constructor(
    vendor: VendorName,
    config: WorkerConfig,
    private readonly workflow: PortalQuoteWorkflow,
  ) {
    super(vendor, config);
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.manualFollowUpOutput(input, "simulate_hidden_vendor");
    }

    if (!input.stagedCadFile) {
      throw new VendorAutomationError(
        `${this.workflow.displayName} live automation requires a staged CAD file.`,
        "upload_failure",
        this.failurePayload(input, "missing_staged_cad_file"),
      );
    }

    const storageState = await this.resolveStorageState();
    if (!storageState) {
      throw new VendorAutomationError(
        `${this.workflow.displayName} live automation requires an authenticated browser session.`,
        "login_required",
        this.failurePayload(input, "missing_storage_state"),
      );
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await chromium.launch({
        headless: this.config.playwrightHeadless,
        timeout: this.config.browserTimeoutMs,
        args: this.buildLaunchArgs(),
      });
      context = await browser.newContext({ storageState });
      context.setDefaultTimeout(this.config.browserTimeoutMs);
      context.setDefaultNavigationTimeout(this.config.browserTimeoutMs);
      const page = await context.newPage();

      await page.goto(this.workflow.uploadUrl, { waitUntil: "domcontentloaded" });
      await this.assertAuthenticated(page, input);
      await this.uploadCadFile(page, input.stagedCadFile.localPath, input);
      await this.tryFillQuantity(page, input.requestedQuantity);
      await page.waitForLoadState("networkidle", { timeout: this.config.browserTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout(2500);

      const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const signal = extractQuoteSignal(bodyText);
      const artifacts = await this.captureEvidence(page, input, "post-upload");

      if (signal.totalPriceUsd !== null) {
        return {
          vendor: this.vendor,
          status: "instant_quote_received",
          unitPriceUsd: Math.round((signal.totalPriceUsd / Math.max(1, input.requestedQuantity)) * 100) / 100,
          totalPriceUsd: signal.totalPriceUsd,
          leadTimeBusinessDays: signal.leadTimeBusinessDays,
          quoteUrl: page.url(),
          dfmIssues: [],
          notes: [`${this.workflow.displayName} returned quote-like pricing from the live portal.`],
          artifacts,
          rawPayload: this.successPayload(input, {
            url: page.url(),
            detectedFlow: "instant_quote",
            leadTimeBusinessDays: signal.leadTimeBusinessDays,
          }),
        };
      }

      if (MANUAL_REVIEW_PATTERN.test(bodyText)) {
        return {
          vendor: this.vendor,
          status: "manual_review_pending",
          unitPriceUsd: null,
          totalPriceUsd: null,
          leadTimeBusinessDays: signal.leadTimeBusinessDays,
          quoteUrl: page.url(),
          dfmIssues: [],
          notes: [`${this.workflow.displayName} accepted the upload but routed the quote to review.`],
          artifacts,
          rawPayload: this.successPayload(input, {
            url: page.url(),
            detectedFlow: "manual_review",
            leadTimeBusinessDays: signal.leadTimeBusinessDays,
          }),
        };
      }

      if (isConfigurationRequiredPageSignal(bodyText)) {
        return {
          vendor: this.vendor,
          status: "manual_vendor_followup",
          unitPriceUsd: null,
          totalPriceUsd: null,
          leadTimeBusinessDays: signal.leadTimeBusinessDays,
          quoteUrl: page.url(),
          dfmIssues: [],
          notes: [
            `${this.workflow.displayName} accepted the upload but still requires portal configuration before pricing.`,
          ],
          artifacts,
          rawPayload: this.successPayload(input, {
            url: page.url(),
            detectedFlow: "configuration_required",
            bodyExcerpt: excerptText(bodyText),
            leadTimeBusinessDays: signal.leadTimeBusinessDays,
          }),
        };
      }

      throw new VendorAutomationError(
        `${this.workflow.displayName} upload completed but no quote price or review state was detected.`,
        "selector_failure",
        this.failurePayload(input, "quote_signal_not_found", {
          url: page.url(),
          bodyExcerpt: excerptText(bodyText),
        }),
        artifacts,
      );
    } catch (error) {
      if (error instanceof VendorAutomationError) {
        throw error;
      }

      throw new VendorAutomationError(
        `${this.workflow.displayName} live automation failed: ${error instanceof Error ? error.message : String(error)}`,
        "unexpected_ui_state",
        this.failurePayload(input, "unexpected_ui_state"),
      );
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  private manualFollowUpOutput(
    input: VendorQuoteAdapterInput,
    reason: string,
  ): VendorQuoteAdapterOutput {
    return {
      vendor: this.vendor,
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      dfmIssues: [],
      notes: [
        `${this.workflow.displayName} is hidden from client fan-out and requires live opt-in before automated quoting.`,
      ],
      artifacts: [],
      rawPayload: {
        ...this.workflowPayload(input),
        mode: this.config.workerMode,
        detectedFlow: "manual_vendor_followup",
        requiresManualVendorFollowUp: true,
        manualFollowUpReason: reason,
      },
    };
  }

  private async resolveStorageState(): Promise<BrowserContextOptions["storageState"] | null> {
    const vendor = this.workflow.vendor;
    const jsonState = this.config.vendorStorageStateJson?.[vendor];
    if (jsonState) {
      try {
        return JSON.parse(jsonState) as Exclude<BrowserContextOptions["storageState"], string | undefined>;
      } catch {
        throw new VendorAutomationError(
          `${this.workflow.displayName} storage-state JSON is not valid JSON.`,
          "login_required",
          {
            vendor,
            reason: "invalid_storage_state_json",
          },
        );
      }
    }

    const explicitPath = this.config.vendorStorageStatePaths?.[vendor];
    const defaultPath = this.config.vendorStorageStateDir
      ? path.join(this.config.vendorStorageStateDir, `${vendor}-storage-state.json`)
      : null;
    const storagePath = explicitPath ?? defaultPath;

    if (!storagePath) {
      return null;
    }

    try {
      await fs.access(storagePath);
      return storagePath;
    } catch {
      return null;
    }
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

  private async assertAuthenticated(page: Page, input: VendorQuoteAdapterInput) {
    const url = page.url().toLowerCase();
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const passwordInputCount = await page.locator("input[type='password']").count().catch(() => 0);

    if (isLoginRequiredPageSignal({ url, bodyText, passwordInputCount })) {
      const artifacts = await this.captureEvidence(page, input, "login-required");
      throw new VendorAutomationError(
        `${this.workflow.displayName} session is not authenticated.`,
        "login_required",
        this.failurePayload(input, "login_required", {
          url: page.url(),
          bodyExcerpt: excerptText(bodyText),
        }),
        artifacts,
      );
    }
  }

  private async uploadCadFile(page: Page, filePath: string, input: VendorQuoteAdapterInput) {
    await this.openUploadSurfaceIfNeeded(page);

    const fileInput = page.locator("input[type='file']").first();
    const inputCount = await fileInput.count();

    if (inputCount > 0) {
      await fileInput.setInputFiles(filePath);
      return;
    }

    if (await this.tryFileChooserUpload(page, filePath)) {
      return;
    }

    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const artifacts = await this.captureEvidence(page, input, "upload-input-missing");
    throw new VendorAutomationError(
      `${this.workflow.displayName} upload input was not found.`,
      "selector_failure",
      this.failurePayload(input, "upload_input_missing", {
        url: page.url(),
        bodyExcerpt: excerptText(bodyText),
      }),
      artifacts,
    );
  }

  private async openUploadSurfaceIfNeeded(page: Page) {
    if ((await page.locator("input[type='file']").first().count().catch(() => 0)) > 0) {
      return;
    }

    for (const label of UPLOAD_SURFACE_TRIGGERS) {
      const trigger = await this.findTrigger(page, label);
      if (!trigger) {
        continue;
      }

      await trigger.click().catch(() => undefined);
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1000);

      if ((await page.locator("input[type='file']").first().count().catch(() => 0)) > 0) {
        return;
      }
    }
  }

  private async tryFileChooserUpload(page: Page, filePath: string) {
    for (const label of FILE_CHOOSER_TRIGGERS) {
      const trigger = await this.findTrigger(page, label);
      if (!trigger) {
        continue;
      }

      const fileChooser = page.waitForEvent("filechooser", { timeout: 5000 });
      await trigger.click().catch(() => undefined);
      const chooser = await fileChooser.catch(() => null);

      if (chooser) {
        await chooser.setFiles(filePath);
        return true;
      }
    }

    return false;
  }

  private async findTrigger(page: Page, label: string) {
    const pattern = new RegExp(label, "i");
    const button = page.getByRole("button", { name: pattern }).first();
    if ((await button.count().catch(() => 0)) > 0) {
      return button;
    }

    const link = page.getByRole("link", { name: pattern }).first();
    if ((await link.count().catch(() => 0)) > 0) {
      return link;
    }

    return null;
  }

  private async tryFillQuantity(page: Page, quantity: number) {
    const quantityInput = page
      .locator(
        "input[name*='quantity' i], input[aria-label*='quantity' i], input[placeholder*='quantity' i], input[name='qty' i]",
      )
      .first();

    if ((await quantityInput.count()) < 1) {
      return;
    }

    await quantityInput.fill(String(Math.max(1, quantity))).catch(() => undefined);
  }

  private async captureEvidence(
    page: Page,
    input: VendorQuoteAdapterInput,
    label: string,
  ): Promise<VendorArtifact[]> {
    const safeVendor = this.workflow.vendor;
    const dir = path.join(
      this.config.workerTempDir,
      "vendor-workflows",
      safeVendor,
      input.quoteRunId,
      input.part.id,
      `${Date.now()}-${label}`,
    );
    await fs.mkdir(dir, { recursive: true });

    const htmlPath = path.join(dir, `${safeVendor}-${label}.html`);
    const screenshotPath = path.join(dir, `${safeVendor}-${label}.png`);

    await fs.writeFile(htmlPath, await page.content(), "utf8");
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

    return [
      {
        kind: "html_snapshot",
        label: `${this.workflow.displayName} ${label} HTML`,
        localPath: htmlPath,
        contentType: "text/html",
      },
      {
        kind: "screenshot",
        label: `${this.workflow.displayName} ${label} screenshot`,
        localPath: screenshotPath,
        contentType: "image/png",
      },
    ];
  }

  private workflowPayload(input: VendorQuoteAdapterInput): Record<string, unknown> {
    return {
      vendor: this.workflow.vendor,
      source: this.workflow.source,
      publicUrl: this.workflow.publicUrl,
      uploadUrl: this.workflow.uploadUrl,
      processFamily: this.workflow.processFamily,
      supportedFileExtensions: this.workflow.supportedFileExtensions,
      officialNotes: this.workflow.officialNotes,
      requestedQuantity: input.requestedQuantity,
      partId: input.part.id,
    };
  }

  private successPayload(
    input: VendorQuoteAdapterInput,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...this.workflowPayload(input),
      mode: this.config.workerMode,
      automationVersion: "portal-workflow-v1",
      ...extra,
    };
  }

  private failurePayload(
    input: VendorQuoteAdapterInput,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ...this.workflowPayload(input),
      mode: this.config.workerMode,
      automationVersion: "portal-workflow-v1",
      reason,
      ...extra,
    };
  }
}

export function extractQuoteSignal(text: string): ExtractedQuoteSignal {
  const priceMatch = PRICE_PATTERN.exec(text);
  const leadTimeMatch = LEAD_TIME_PATTERN.exec(text);
  const parsedTotalPriceUsd = priceMatch?.[1]
    ? Number.parseFloat(priceMatch[1].replaceAll(",", ""))
    : null;
  const leadTimeBusinessDays = leadTimeMatch?.[1]
    ? Number.parseInt(leadTimeMatch[1], 10)
    : null;

  return {
    totalPriceUsd:
      parsedTotalPriceUsd !== null && Number.isFinite(parsedTotalPriceUsd) && parsedTotalPriceUsd > 0
        ? parsedTotalPriceUsd
        : null,
    leadTimeBusinessDays: Number.isFinite(leadTimeBusinessDays)
      ? leadTimeBusinessDays
      : null,
  };
}

export function isLoginRequiredPageSignal(input: {
  url: string;
  bodyText: string;
  passwordInputCount: number;
}) {
  if (LOGIN_ROUTE_PATTERN.test(input.url.toLowerCase())) {
    return true;
  }

  if (input.passwordInputCount < 1) {
    return false;
  }

  return /\b(log in|login|sign in|signin|create account|password)\b/i.test(input.bodyText);
}

export function isConfigurationRequiredPageSignal(text: string) {
  return CONFIGURATION_REQUIRED_PATTERN.test(text);
}

export function excerptText(text: string, maxLength = 2000) {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
