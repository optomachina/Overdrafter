import fs from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "playwright";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import { resolveRequirementProcess } from "../partContext.js";
import {
  VendorAutomationError,
  type LiveEvaluationUploadFile,
  type VendorArtifact,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOffer,
  type VendorQuoteAdapterOutput,
} from "../types.js";
import { VendorAdapter } from "./base.js";
import {
  evaluateSendCutSendCncEnvelope,
  inspectSendCutSendStepGeometry,
  SENDCUTSEND_CNC_ENVELOPE,
  type SendCutSendEnvelopeDecision,
} from "./sendcutsendEnvelope.js";

export const SENDCUTSEND_AUTOMATION_VERSION = "sendcutsend-worker-v1";
export const SENDCUTSEND_URLS = {
  public: "https://sendcutsend.com/services/cnc-machining/",
  upload: "https://app.sendcutsend.com/",
} as const;
export const SENDCUTSEND_LOCATORS = {
  uploadInputs: [
    'input[type="file"][accept*=".step" i]',
    'input[type="file"][accept*=".stp" i]',
    'input[type="file"]',
  ],
  quantityInputs: [
    'input[name*="quantity" i]',
    'input[aria-label*="quantity" i]',
    'input[placeholder*="quantity" i]',
    'input[name="qty" i]',
  ],
  optionContainers: [
    '[data-testid*="quote-option" i]',
    '[data-test*="quote-option" i]',
    '[data-testid*="price-option" i]',
    '[data-test*="price-option" i]',
    '[aria-label*="quote option" i]',
  ],
} as const;

const CAPTCHA_PATTERN = /\b(captcha|verify you are human|security challenge)\b/i;
const LOGIN_PATTERN = /\b(log in|login|sign in|signin|create account|password)\b/i;
const MANUAL_REVIEW_PATTERN = /\b(manual review|engineering review|quote request received|reviewing your part)\b/i;
const CONFIGURATION_PATTERN = /\b(select material|configure (?:your )?part|choose (?:a )?finish|add material|configuration required)\b/i;
const PRICE_PATTERN = /(?:\$\s*|\bUSD\s*)([\d,]+(?:\.\d{1,2})?)/gi;
const EXACT_LEAD_TIME_PATTERN = /\b(\d{1,3})\s+(?:business|production|working)\s+days?\b/i;
const LEAD_TIME_RANGE_PATTERN = /\b\d{1,3}\s*[-–]\s*\d{1,3}\s+(?:business|production|working)\s+days?\b/i;

type SendCutSendPortalState =
  | "captcha"
  | "configuration_required"
  | "login_required"
  | "manual_review"
  | "quote_ready"
  | "unknown";

export type SendCutSendQuoteContainer = {
  selector: string;
  providerOptionId: string | null;
  providerLabel: string | null;
  quoteRef: string | null;
  quoteUrl: string | null;
  text: string;
};

type SendCutSendValidityEvidence = {
  quotedAt: string | null;
  validUntil: string | null;
  validityDurationDays: number | null;
  validitySource: "vendor_date" | "vendor_duration" | null;
  validityTerms: string | null;
};

function excerpt(text: string, maxLength = 500) {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parsePrice(text: string, quantity: number) {
  const matches = [...text.matchAll(PRICE_PATTERN)];
  const captured = matches.length === 1 ? matches[0]?.[1] : null;
  const price = captured ? Number.parseFloat(captured.replaceAll(",", "")) : Number.NaN;
  if (!Number.isFinite(price) || price <= 0) return null;

  const matchIndex = matches[0]?.index ?? 0;
  const context = text.slice(matchIndex, matchIndex + (matches[0]?.[0].length ?? 0) + 32);
  const isUnit = /\b(?:per\s+(?:part|unit)|each)\b/i.test(context);
  const safeQuantity = Math.max(1, quantity);
  return isUnit
    ? { unitPriceUsd: price, totalPriceUsd: Math.round(price * safeQuantity * 100) / 100 }
    : { unitPriceUsd: Math.round((price / safeQuantity) * 100) / 100, totalPriceUsd: price };
}

function parseLeadTime(text: string) {
  if (LEAD_TIME_RANGE_PATTERN.test(text)) return null;
  const captured = EXACT_LEAD_TIME_PATTERN.exec(text)?.[1];
  const days = captured ? Number.parseInt(captured, 10) : Number.NaN;
  return Number.isInteger(days) && days > 0 ? days : null;
}

/** Normalizes every provider-anchored, single-price option and drops ambiguous containers. */
export function normalizeSendCutSendOffers(
  containers: SendCutSendQuoteContainer[],
  requestedQuantity: number,
): VendorQuoteAdapterOffer[] {
  const seen = new Set<string>();
  const offers: VendorQuoteAdapterOffer[] = [];
  for (const container of containers) {
    const providerLabel = container.providerLabel?.replace(/\s+/g, " ").trim() || null;
    const providerOptionId = container.providerOptionId?.trim() || providerLabel;
    const price = parsePrice(container.text, requestedQuantity);
    if (!providerLabel || !providerOptionId || !price || seen.has(providerOptionId)) continue;

    seen.add(providerOptionId);
    const leadTimeBusinessDays = parseLeadTime(container.text);
    offers.push({
      providerOptionId,
      providerLabel,
      quoteRef: container.quoteRef?.trim() || null,
      quoteUrl: container.quoteUrl,
      ...price,
      leadTimeBusinessDays,
      shipReceiveBy: null,
      tier: providerLabel,
      sourcing: "automated",
      geographicOrigin: "unknown",
      sortRank: offers.length,
      provenance: {
        containerSelector: container.selector,
        providerOptionIdSource: container.providerOptionId ? "attribute" : "provider_label",
        priceSource: "selector",
        leadTimeSource: leadTimeBusinessDays === null ? "none" : "selector",
        geographicOriginSource: "none",
      },
      rawPayload: { providerText: excerpt(container.text), requestedQuantity },
    });
  }
  return offers;
}

/** Retains explicit ISO quote/expiration dates or provider-stated whole-day validity only. */
export function parseSendCutSendValidityEvidence(text: string): SendCutSendValidityEvidence {
  const quotedDate = /\bquoted\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text)?.[1] ?? null;
  const validUntilMatch = /\bvalid\s+(?:until|through)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text);
  const durationMatch = /\bvalid\s+for\s+(\d{1,3})\s+days?\b/i.exec(text);
  const quotedAt = quotedDate && Number.isFinite(Date.parse(quotedDate)) ? quotedDate : null;
  const validUntilDate = validUntilMatch?.[1] ?? null;
  const validUntil = validUntilDate && Number.isFinite(Date.parse(validUntilDate))
    ? validUntilDate
    : null;
  const duration = durationMatch?.[1] ? Number.parseInt(durationMatch[1], 10) : null;
  if (validUntil) {
    return {
      quotedAt,
      validUntil,
      validityDurationDays: null,
      validitySource: "vendor_date",
      validityTerms: validUntilMatch?.[0] ?? null,
    };
  }
  if (duration && duration > 0) {
    return {
      quotedAt,
      validUntil: null,
      validityDurationDays: duration,
      validitySource: "vendor_duration",
      validityTerms: durationMatch?.[0] ?? null,
    };
  }
  return {
    quotedAt,
    validUntil: null,
    validityDurationDays: null,
    validitySource: null,
    validityTerms: null,
  };
}

export function classifySendCutSendPortalState(input: {
  bodyText: string;
  url: string;
  passwordInputCount: number;
  offerCount: number;
}): SendCutSendPortalState {
  if (CAPTCHA_PATTERN.test(input.bodyText)) return "captcha";
  if (/\b(?:login|sign-?in)\b/i.test(input.url) || (input.passwordInputCount > 0 && LOGIN_PATTERN.test(input.bodyText))) {
    return "login_required";
  }
  if (input.offerCount > 0) return "quote_ready";
  if (MANUAL_REVIEW_PATTERN.test(input.bodyText)) return "manual_review";
  if (CONFIGURATION_PATTERN.test(input.bodyText)) return "configuration_required";
  return "unknown";
}

export class SendCutSendAdapter extends VendorAdapter {
  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.emptyResult(input, null, "manual_vendor_followup", "live_evaluation_not_enabled");
    }

    const files = getAuthorizedLiveEvaluationFiles(input);
    if (input.executionContext !== "live_evaluation" || !files) {
      throw this.failure(
        input,
        "unexpected_ui_state",
        "provider_neutral_authorization_unavailable",
        "SendCutSend production dispatch requires the unmerged provider-neutral permit and immediate preflight contract.",
      );
    }

    const decision = evaluateSendCutSendCncEnvelope({
      fileName: files.cad.name,
      process: resolveRequirementProcess(input.requirement.spec_snapshot),
      material: input.requirement.material,
      finish: input.requirement.finish,
      tightestToleranceInch: input.requirement.tightest_tolerance_inch,
      quantity: input.requestedQuantity,
      drawingIncluded: files.drawing !== null,
      accountMode: SENDCUTSEND_CNC_ENVELOPE.accountMode,
      geometry: inspectSendCutSendStepGeometry({ fileName: files.cad.name, buffer: files.cad.buffer }),
    });
    if (!decision.eligible) {
      return this.emptyResult(input, decision, "manual_vendor_followup", "outside_certified_cnc_envelope");
    }

    const storageState = await this.resolveStorageState();
    if (!storageState) {
      throw this.failure(
        input,
        "login_required",
        "missing_isolated_storage_state",
        "SendCutSend live evaluation requires an isolated company-controlled browser session.",
        decision,
      );
    }
    return this.runIsolatedQuote(input, files.cad, storageState, decision);
  }

  private async runIsolatedQuote(
    input: VendorQuoteAdapterInput,
    cadFile: LiveEvaluationUploadFile,
    storageState: Exclude<BrowserContextOptions["storageState"], undefined>,
    decision: SendCutSendEnvelopeDecision,
  ): Promise<VendorQuoteAdapterOutput> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      browser = await chromium.launch({
        headless: this.config.playwrightHeadless,
        timeout: this.config.browserTimeoutMs,
        args: [
          ...(this.config.playwrightDisableSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
          ...(this.config.playwrightDisableDevShmUsage ? ["--disable-dev-shm-usage"] : []),
        ],
      });
      context = await browser.newContext({ storageState });
      context.setDefaultTimeout(this.config.browserTimeoutMs);
      context.setDefaultNavigationTimeout(this.config.browserTimeoutMs);
      const page = await context.newPage();
      await page.goto(SENDCUTSEND_URLS.upload, { waitUntil: "domcontentloaded" });
      this.assertProviderOrigin(page, input, decision);
      await this.throwIfBlocked(page, input, decision);
      await this.upload(page, cadFile, input, decision);
      await this.fillFirst(page, SENDCUTSEND_LOCATORS.quantityInputs, String(input.requestedQuantity));
      await page.waitForLoadState("networkidle", { timeout: this.config.browserTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout(2500);
      this.assertProviderOrigin(page, input, decision);

      const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const offers = normalizeSendCutSendOffers(await this.collectContainers(page), input.requestedQuantity);
      const artifacts = await this.capture(page, input, "terminal");
      const state = classifySendCutSendPortalState({
        bodyText,
        url: page.url(),
        passwordInputCount: await page.locator('input[type="password"]').count().catch(() => 0),
        offerCount: offers.length,
      });
      if (state === "quote_ready") return this.quoteResult(input, decision, page.url(), bodyText, offers, artifacts);
      if (state === "manual_review") {
        return this.emptyResult(input, decision, "manual_review_pending", state, page.url(), artifacts);
      }
      if (state === "configuration_required") {
        return this.emptyResult(input, decision, "manual_vendor_followup", state, page.url(), artifacts);
      }
      if (state === "captcha" || state === "login_required") {
        throw this.blockingFailure(input, decision, state, artifacts, page.url(), bodyText);
      }
      throw this.failure(
        input,
        "selector_failure",
        "quote_terminal_state_not_found",
        "SendCutSend upload reached no anchored quote or explained terminal state.",
        decision,
        artifacts,
        { url: page.url(), bodyExcerpt: excerpt(bodyText, 2000) },
      );
    } catch (error) {
      if (error instanceof VendorAutomationError) throw error;
      throw this.failure(
        input,
        "unexpected_ui_state",
        "unexpected_ui_state",
        `SendCutSend live evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        decision,
      );
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  private quoteResult(
    input: VendorQuoteAdapterInput,
    decision: SendCutSendEnvelopeDecision,
    quoteUrl: string,
    bodyText: string,
    offers: VendorQuoteAdapterOffer[],
    artifacts: VendorArtifact[],
  ): VendorQuoteAdapterOutput {
    const summary = [...offers].sort((left, right) => left.totalPriceUsd - right.totalPriceUsd)[0];
    const validity = parseSendCutSendValidityEvidence(bodyText);
    return {
      vendor: "sendcutsend",
      status: "instant_quote_received",
      unitPriceUsd: summary?.unitPriceUsd ?? null,
      totalPriceUsd: summary?.totalPriceUsd ?? null,
      leadTimeBusinessDays: summary?.leadTimeBusinessDays ?? null,
      quoteUrl,
      ...validity,
      offers,
      dfmIssues: [],
      notes: ["Provider-anchored CNC options collected; ordering was not attempted."],
      artifacts,
      rawPayload: this.payload(input, decision, "instant_quote", {
        quoteUrl,
        offerCount: offers.length,
        validity,
      }),
    };
  }

  private emptyResult(
    input: VendorQuoteAdapterInput,
    decision: SendCutSendEnvelopeDecision | null,
    status: "manual_review_pending" | "manual_vendor_followup",
    reason: string,
    quoteUrl: string | null = null,
    artifacts: VendorArtifact[] = [],
  ): VendorQuoteAdapterOutput {
    return {
      vendor: "sendcutsend",
      status,
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl,
      dfmIssues: [],
      notes: [reason === "outside_certified_cnc_envelope"
        ? "The package is outside the certified SendCutSend CNC envelope and was not disclosed."
        : "SendCutSend requires authorized evaluation or finite manual follow-up."],
      artifacts,
      rawPayload: this.payload(input, decision, reason, {
        requiresManualVendorFollowUp: status === "manual_vendor_followup",
        manualFollowUpReason: reason,
      }),
    };
  }

  private async resolveStorageState() {
    const json = this.config.vendorStorageStateJson.sendcutsend;
    if (json) {
      try {
        return JSON.parse(json) as Exclude<BrowserContextOptions["storageState"], string | undefined>;
      } catch {
        throw new VendorAutomationError("SendCutSend storage-state JSON is invalid.", "login_required", {
          vendor: "sendcutsend",
          reason: "invalid_isolated_storage_state_json",
        });
      }
    }
    const storagePath = this.config.vendorStorageStatePaths.sendcutsend
      ?? (this.config.vendorStorageStateDir
        ? path.join(this.config.vendorStorageStateDir, "sendcutsend-storage-state.json")
        : null);
    if (!storagePath) return null;
    return fs.access(storagePath).then(() => storagePath).catch(() => null);
  }

  private assertProviderOrigin(page: Page, input: VendorQuoteAdapterInput, decision: SendCutSendEnvelopeDecision) {
    const hostname = new URL(page.url()).hostname.toLowerCase();
    if (hostname === "app.sendcutsend.com" || hostname.endsWith(".sendcutsend.com")) return;
    throw this.failure(
      input,
      "navigation_failure",
      "unexpected_provider_origin",
      "SendCutSend navigation left the approved provider domain.",
      decision,
      [],
      { url: page.url() },
    );
  }

  private async throwIfBlocked(page: Page, input: VendorQuoteAdapterInput, decision: SendCutSendEnvelopeDecision) {
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const state = classifySendCutSendPortalState({
      bodyText,
      url: page.url(),
      passwordInputCount: await page.locator('input[type="password"]').count().catch(() => 0),
      offerCount: 0,
    });
    if (state !== "captcha" && state !== "login_required") return;
    throw this.blockingFailure(input, decision, state, await this.capture(page, input, state), page.url(), bodyText);
  }

  private blockingFailure(
    input: VendorQuoteAdapterInput,
    decision: SendCutSendEnvelopeDecision,
    state: "captcha" | "login_required",
    artifacts: VendorArtifact[],
    url: string,
    bodyText: string,
  ) {
    return this.failure(
      input,
      state,
      state,
      state === "captcha"
        ? "SendCutSend presented a security challenge; no bypass was attempted."
        : "The isolated SendCutSend session requires authentication refresh.",
      decision,
      artifacts,
      { url, bodyExcerpt: excerpt(bodyText, 2000) },
    );
  }

  private async upload(
    page: Page,
    cadFile: LiveEvaluationUploadFile,
    input: VendorQuoteAdapterInput,
    decision: SendCutSendEnvelopeDecision,
  ) {
    for (const selector of SENDCUTSEND_LOCATORS.uploadInputs) {
      const locator = page.locator(selector).first();
      if ((await locator.count().catch(() => 0)) < 1) continue;
      try {
        await locator.setInputFiles(cadFile);
        return;
      } catch {
        // Try the next provider-local locator.
      }
    }
    throw this.failure(
      input,
      "selector_failure",
      "upload_input_missing",
      "SendCutSend CNC upload input was not found.",
      decision,
      await this.capture(page, input, "upload-input-missing"),
      { url: page.url() },
    );
  }

  private async fillFirst(page: Page, selectors: readonly string[], value: string) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count().catch(() => 0)) < 1) continue;
      await locator.fill(value);
      await locator.press("Enter").catch(() => undefined);
      return;
    }
  }

  private async collectContainers(page: Page) {
    const containers: SendCutSendQuoteContainer[] = [];
    for (const selector of SENDCUTSEND_LOCATORS.optionContainers) {
      const matches = page.locator(selector);
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const locator = matches.nth(index);
        containers.push({
          selector,
          providerOptionId: await this.firstAttribute(locator, ["data-quote-option-id", "data-option-id", "data-testid", "data-test"]),
          providerLabel: await this.firstAttribute(locator, ["aria-label", "data-label", "title"]),
          quoteRef: await this.firstAttribute(locator, ["data-quote-id", "data-quote-ref"]),
          quoteUrl: page.url(),
          text: await locator.innerText().catch(() => ""),
        });
      }
    }
    return containers;
  }

  private async firstAttribute(locator: Locator, names: string[]) {
    for (const name of names) {
      const value = await locator.getAttribute(name).catch(() => null);
      if (value?.trim()) return value.trim();
    }
    return null;
  }

  private async capture(page: Page, input: VendorQuoteAdapterInput, label: string) {
    const directory = path.join(this.config.workerTempDir, "sendcutsend", input.quoteRunId, input.part.id, `${Date.now()}-${label}`);
    await fs.mkdir(directory, { recursive: true });
    const htmlPath = path.join(directory, `sendcutsend-${label}.html`);
    const screenshotPath = path.join(directory, `sendcutsend-${label}.png`);
    await fs.writeFile(htmlPath, await page.content(), "utf8");
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    return [
      { kind: "html_snapshot", label: `SendCutSend ${label} HTML`, localPath: htmlPath, contentType: "text/html" },
      { kind: "screenshot", label: `SendCutSend ${label} screenshot`, localPath: screenshotPath, contentType: "image/png" },
    ] satisfies VendorArtifact[];
  }

  private payload(
    input: VendorQuoteAdapterInput,
    decision: SendCutSendEnvelopeDecision | null,
    detectedFlow: string,
    extra: Record<string, unknown>,
  ) {
    return {
      vendor: "sendcutsend",
      source: this.config.workerMode === "live" ? "sendcutsend-live-adapter" : "sendcutsend-adapter",
      automationVersion: SENDCUTSEND_AUTOMATION_VERSION,
      executionContext: input.executionContext ?? "production_dispatch",
      envelopeRevision: SENDCUTSEND_CNC_ENVELOPE.revision,
      envelopeDecision: decision,
      accountMode: SENDCUTSEND_CNC_ENVELOPE.accountMode,
      sessionIsolation: "fresh_context_per_quote",
      requestedQuantity: input.requestedQuantity,
      detectedFlow,
      orderAttempted: false,
      ...extra,
    };
  }

  private failure(
    input: VendorQuoteAdapterInput,
    code: ConstructorParameters<typeof VendorAutomationError>[1],
    reason: string,
    message: string,
    decision: SendCutSendEnvelopeDecision | null = null,
    artifacts: VendorArtifact[] = [],
    extra: Record<string, unknown> = {},
  ) {
    return new VendorAutomationError(
      message,
      code,
      this.payload(input, decision, reason, { reason, ...extra }),
      artifacts,
    );
  }
}
