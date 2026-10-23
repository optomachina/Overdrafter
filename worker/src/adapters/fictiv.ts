import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { createRunDir, uniqueName } from "../files.js";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import {
  VendorAutomationError,
  type VendorArtifact,
  type LiveEvaluationUploadFile,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type VendorQuoteAdapterOffer,
  type VendorAutomationErrorCode,
} from "../types.js";
import {
  gateLeadTime,
  gateVendorPrice,
  priceGateEvidence,
  UNANCHORED_PRICE_NOTE,
  type PriceGate,
  type ValueSource,
} from "../extractedValue.js";
import { VendorAdapter } from "./base.js";
import { fictivDispatchAuthorizationDenial } from "./fictivDispatchAuthorization.js";
import { redactProviderPortalHtml, scrubProviderEvidenceText } from "./providerEvidenceRedaction.js";
import { markProviderMutationStarted } from "../providerMutationPhase.js";
import { isDispatchDecisionError } from "../dispatchDecisionError.js";
import { ProviderAbortedError } from "../providerAbort.js";
import { ProviderKillSwitchError } from "../providerKillSwitch.js";
import { chromiumSandboxLaunchOptions } from "../chromiumLaunchOptions.js";
import {
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  FICTIV_FORBIDDEN_CLICK_TARGET,
  finishReadbackMatches,
  FICTIV_LOCATORS,
  FICTIV_URLS,
  materialReadbackMatches,
  processReadbackMatches,
} from "./fictivConstraints.js";

export const FICTIV_AUTOMATION_VERSION = "fictiv-worker-v1";

type FictivDetectedFlow =
  | "simulate"
  | "quote_home"
  | "upload_complete"
  | "configuration_complete"
  | "configuration_required"
  | "instant_quote"
  | "manual_review"
  | "manual_vendor_followup";

type FictivResultClassification =
  | "instant_quote"
  | "manual_review"
  | "configuration_required"
  | "capability_limited";

type FictivValueSource = ValueSource;
type FictivEndUseSource = "selector" | "assumed_default";

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

/**
 * OVD-1053 round 4: what the run proved about the quote it may price. It set
 * the designated files on a fresh upload page, which showed CNC Machining as
 * the selected process right before, and the page then moved to the quote
 * page that upload created. A run without all of this configures nothing and
 * publishes no price.
 */
type FictivUploadProvenance = {
  uploadSelector: string;
  /** The selected process the page showed right before the upload. */
  observedProcessBeforeUpload: string | null;
  /** `/pages/quotes/<quote>` of the quote the upload created. */
  createdQuotePath: string;
};

/**
 * What the run did and saw while configuring. The process, material and
 * finish here are the adapter's own choices (what it clicked), never what a
 * price is published on: that is read back from the priced quote page (see
 * FictivConfigurationReadback).
 */
type FictivLiveSelection = {
  uploadSelector: string | null;
  /** The CNC process the adapter clicked or found selected; not a readback. */
  processChosen: string | null;
  uploadProvenance: FictivUploadProvenance;
  selectedEndUse: string | null;
  selectedEndUseSource: FictivEndUseSource;
  quantitySelector: string | null;
  /**
   * The quantity readback (Fictiv's quantity control and displays), the
   * selected price and the lead-time panel once the priced quote held still;
   * null unless the quote was priced.
   */
  quantityPricing: FictivQuantityPricing | null;
  openedConfigurationDrawer: boolean;
  /** The material option the adapter chose; not a readback. */
  materialOptionChosen: string | null;
  /** The finish option the adapter chose; not a readback. */
  finishOptionChosen: string | null;
  terminalOutcome: FictivTerminalOutcome;
};

type FictivPortalState =
  | "in_progress"
  | "quote_ready"
  | "manual_review"
  | "configuration_required"
  | "capability_limited"
  | "unknown";

type FictivTerminalOutcome = {
  state: Exclude<FictivPortalState, "in_progress" | "unknown">;
  bodyText: string;
  matchedSignal: string | null;
};

export type FictivLeadTimeOption = {
  region: "domestic" | "overseas";
  tier: "fastest" | "standard" | "cost_effective";
  days: number | null;
  observedPrice: number | null;
  priceBasis: "total" | "unit" | "unknown";
  totalPriceUsd: number | null;
  currency: "USD" | null;
  /** A label next to the amount, or (G3) the page's currency context for a bare amount in Fictiv's price span. */
  currencySource: "label" | "page_context" | null;
  /** False when the page marks the option unavailable (F19); such an option is never published. */
  selectable: boolean;
  selector: string;
  priceSource: "selector" | "none";
  leadTimeSource: "selector" | "none";
  rawText: string;
};

type FictivParsedQuote = {
  bodyText: string;
  /** Already gated: null unless the price came from a declared locator. */
  totalPrice: number | null;
  /** The text the price was read from when a declared locator anchored it, for the publish-time re-read. */
  priceText: string | null;
  leadTime: number | null;
  manualReview: boolean;
  manualReviewSelector: string | null;
  priceSource: FictivValueSource;
  priceSelector: string | null;
  /** Any amount was read for the selected price, verified or not. */
  priceObserved: boolean;
  priceCurrency: "USD" | null;
  priceCurrencySource: "label" | "page_context" | null;
  priceBasis: "total" | "unit" | "unknown";
  leadTimeSource: FictivValueSource;
  leadTimeSelector: string | null;
  priceGate: PriceGate;
  /** The lead-time panel as read when the price was extracted. */
  leadTimes: FictivLeadTimeReading;
};

type FictivQuoteRawPayload = Record<string, unknown> & {
  automationVersion: string;
  detectedFlow: FictivDetectedFlow;
  uploadSelector?: string | null;
  /**
   * OVD-1053 round 5 (F12): the process, material and finish labels the
   * quote page itself shows after pricing (see configurationReadback), never
   * the adapter's clicks or the pre-upload process card. Null when the page
   * did not show them readably.
   */
  selectedMaterial?: string | null;
  selectedFinish?: string | null;
  selectedProcess?: string | null;
  /** The dropdown options the adapter chose; evidence of its actions only. */
  materialOptionChosen?: string | null;
  finishOptionChosen?: string | null;
  configurationReadback?: ReturnType<typeof configurationReadbackEvidence>;
  selectedEndUse?: string | null;
  selectedEndUseSource?: FictivEndUseSource | null;
  quantitySelector?: string | null;
  openedConfigurationDrawer?: boolean;
  priceSource?: FictivValueSource | null;
  priceCurrency?: "USD" | null;
  priceBasis?: "total" | "unit" | "unknown";
  leadTimeSource?: FictivValueSource | null;
  resultClassification?: FictivResultClassification;
  portalStateSignal?: string | null;
  bodyExcerpt?: string;
  artifactStoragePaths?: string[];
  requestedQuantity?: number;
  retryCount?: number;
  failureCode?: string | null;
  url?: string | null;
  leadTimeOptions?: Array<Omit<FictivLeadTimeOption, "rawText">>;
};

const FIRST_CURRENCY_PATTERN = /\$ ?([\d,]+(?:\.\d{2})?)/;
const LEAD_TIME_PATTERN =
  /\b(\d{1,4})\s+(?:(?:business|production|working|calendar)\s+)?days?\b/i;

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
    selectedProcess: null,
    selectedMaterial: null,
    selectedFinish: null,
    selectedEndUse: null,
    selectedEndUseSource: null,
    quantitySelector: null,
    openedConfigurationDrawer: false,
    priceSource: "none",
    leadTimeSource: "none",
    resultClassification: undefined,
    portalStateSignal: null,
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
 * Returns `null` when no dollar-like token is present or parsing is non-finite.
 * This parser does not prove the currency is USD.
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

function explicitUsdCurrency(text: string): "USD" | null {
  const amount = FIRST_CURRENCY_PATTERN.exec(text);
  if (!amount) return null;
  const before = text.slice(Math.max(0, amount.index - 8), amount.index);
  const after = text.slice(amount.index + amount[0].length, amount.index + amount[0].length + 8);
  const prefix = /\b(USD|US|CAD|EUR|GBP|AUD|NZD|MXN)\s*$/i.exec(before)?.[1]?.toUpperCase() ?? null;
  const suffix = /^\s*(USD|CAD|EUR|GBP|AUD|NZD|MXN)\b/i.exec(after)?.[1]?.toUpperCase() ?? null;
  if (prefix && prefix !== "USD" && prefix !== "US") return null;
  if (suffix && suffix !== "USD") return null;
  return prefix === "USD" || prefix === "US" || suffix === "USD" ? "USD" : null;
}

function priceBasis(text: string): "total" | "unit" | "unknown" {
  if ([...text.matchAll(/\$ ?[\d,]+(?:\.\d{2})?/g)].length !== 1) {
    return "unknown";
  }
  const amount = FIRST_CURRENCY_PATTERN.exec(text);
  if (!amount) return "unknown";
  const before = text.slice(Math.max(0, amount.index - 30), amount.index);
  const after = text.slice(amount.index + amount[0].length, amount.index + amount[0].length + 24);
  const beforeTokens = before.toLowerCase().match(/[a-z]+/g) ?? [];
  const currencyCodes = new Set(["usd", "us", "cad", "eur", "gbp", "aud", "nzd", "mxn"]);
  if (currencyCodes.has(beforeTokens.at(-1) ?? "")) {
    beforeTokens.pop();
  }
  const label = beforeTokens.slice(-2).join(" ");
  const afterField = after.trimStart().toLowerCase();
  const afterTokens = afterField.match(/[a-z]+/g) ?? [];
  const afterUnit = afterTokens[0] === "each"
    || (afterTokens[0] === "per" && ["part", "piece", "unit"].includes(afterTokens[1] ?? ""))
    || (afterField.startsWith("/") && ["part", "piece", "unit"].includes(afterTokens[0] ?? ""));
  const afterPriceField = after.split(/[\n;]/, 1)[0].trim().toLowerCase();
  const totalBoundary = (label: string) => label === afterPriceField
    || [",", ".", "!", ":"].includes(afterPriceField[label.length] ?? "");
  const suffixWords = afterPriceField.match(/[a-z]+|[\d,]+/g) ?? [];
  const afterTotal = (afterPriceField.startsWith("total") && totalBoundary("total"))
    || (afterPriceField.startsWith("total price") && totalBoundary("total price"))
    || (suffixWords.length >= 4
      && suffixWords[0] === "total"
      && suffixWords[1] === "for"
      && /^\d[\d,]*$/.test(suffixWords[2] ?? "")
      && ["part", "parts", "piece", "pieces", "unit", "units"].includes(suffixWords[3] ?? ""));
  if (label === "unit price" || afterUnit) {
    return "unit";
  }
  if (label === "total price" || beforeTokens.at(-1) === "total" || afterTotal) {
    return "total";
  }
  return "unknown";
}

const NON_USD_CURRENCY_CODES = "CAD|EUR|GBP|AUD|NZD|MXN|JPY|CNY|RMB|INR|CHF|SGD|HKD";

/**
 * Another currency named on the page: its sign, a dollar sign with another
 * country's prefix, or its code next to an amount, after "Currency" or in
 * parentheses. A bare code is not enough: "CAD" is also the design files
 * Fictiv asks for.
 */
const NON_USD_CURRENCY_MARKERS: readonly RegExp[] = [
  /[€£¥₹]/,
  /\b(?:C|CA|A|AU|NZ|MX|HK|S|NT|R)\$/,
  new RegExp(String.raw`\b(?:${NON_USD_CURRENCY_CODES})\s*(?:\$\s?)?\d`),
  new RegExp(String.raw`\d\s*(?:${NON_USD_CURRENCY_CODES})\b`),
  new RegExp(String.raw`\bcurrency\s*[:-]?\s*(?:${NON_USD_CURRENCY_CODES})\b`, "i"),
  new RegExp(String.raw`\((?:${NON_USD_CURRENCY_CODES})\)`),
];

/** Page text that names USD as the currency: a currency label, a statement, "(USD)", or an amount written as USD. */
const USD_CONTEXT_TEXT: readonly RegExp[] = [
  /\bcurrency\s*[:-]?\s*(?:USD\b|US\$|U\.?S\.?\s+dollars?\b)/i,
  /\b(?:prices?|amounts?|totals?|costs?)\s+(?:are\s+)?(?:shown\s+|listed\s+|quoted\s+)?in\s+(?:USD\b|U\.?S\.?\s+dollars?\b)/i,
  /\((?:USD|US\$)\)/,
  /\bUSD\s*\$ ?\d/,
  /\bUS\$ ?\d/,
  /\$ ?\d[\d,]*(?:\.\d{2})?\s*USD\b/,
];

/** A currency hook's whole text naming USD, as a currency selector or label shows it. */
const USD_HOOK_TEXT = /^(?:currency\s*:?\s*)?(?:USD|US\$|U\.?S\.?\s+dollars?)(?:\s*\(\$\))?$/i;
const NON_USD_HOOK_TEXT = new RegExp(String.raw`^(?:currency\s*:?\s*)?(?:${NON_USD_CURRENCY_CODES})\b`, "i");

export type FictivCurrencyContext = {
  currency: "USD" | null;
  source: "currency_hook" | "page_text" | null;
  /** Another currency shows on the page, so no bare "$" amount is read as USD. */
  conflict: boolean;
};

/**
 * OVD-1052 (G3): the currency a quote page establishes for the bare "$"
 * amounts in Fictiv's lead-time price spans. USD only when a currency hook
 * reads USD (FICTIV_LOCATORS.currencyContextHooks) or the page text names USD
 * (USD_CONTEXT_TEXT), and nothing on the page names another currency. The
 * 02:46Z captures show neither, so their bare prices stay unverified.
 * Exported for tests.
 */
export function fictivCurrencyContext(bodyText: string, hookTexts: readonly string[]): FictivCurrencyContext {
  const hooks = hookTexts.map((text) => text.replaceAll(/\s+/g, " ").trim()).filter(Boolean);
  if (
    NON_USD_CURRENCY_MARKERS.some((marker) => marker.test(bodyText) || hooks.some((text) => marker.test(text)))
    || hooks.some((text) => NON_USD_HOOK_TEXT.test(text))
  ) {
    return { currency: null, source: null, conflict: true };
  }
  if (hooks.some((text) => USD_HOOK_TEXT.test(text))) return { currency: "USD", source: "currency_hook", conflict: false };
  if (USD_CONTEXT_TEXT.some((pattern) => pattern.test(bodyText))) {
    return { currency: "USD", source: "page_text", conflict: false };
  }
  return { currency: null, source: null, conflict: false };
}

/** The live lead-time panel header's statement of what its prices are. */
const PRODUCTION_PRICE_STATEMENT = /\bprice for (?:the )?part production\b/i;

/**
 * OVD-1052 (G3): what a quote page establishes about the bare "$" prices in
 * its lead-time price spans, read with every lead-time reading.
 */
type FictivPricingContext = FictivCurrencyContext & {
  /** The lead-time panel header says its prices are the part production price. */
  productionPriceStatement: boolean;
  requestedQuantity: number;
};

/** The pricing context as evidence: what established the currency, and whether the panel stated its basis. */
function pricingContextEvidence(context: FictivPricingContext) {
  return {
    currency: context.currency,
    currencySource: context.source,
    currencyConflict: context.conflict,
    productionPriceStatement: context.productionPriceStatement,
  };
}

/** A whole price span text that is one dollar amount and nothing else: "$ 412.30", "$1,234.56". */
const BARE_DOLLAR_AMOUNT = /^\$ ?\d[\d,]*(?:\.\d{2})?$/;

type FictivPriceReading = {
  amount: number | null;
  currency: "USD" | null;
  basis: "total" | "unit" | "unknown";
  /** Where the currency came from: a label next to the amount, or the page (a bare amount in a price span). */
  currencySource: "label" | "page_context" | null;
};

/**
 * A price as read from text. A label next to the amount decides first, as
 * before: USD (or another currency) and Total or a unit wording. OVD-1052
 * (G3): only Fictiv's own lead-time price span (`priceSpan`) may hold a bare
 * "$" amount. It counts as USD only when the page's currency context is USD,
 * and as a total only when the panel says its prices are the part production
 * price and the quantity is 1, where a unit price and a total are the same
 * amount. For any other quantity its basis stays unknown: the captures never
 * showed a priced option for more than one part.
 */
function readFictivPrice(text: string, priceSpan: boolean, context: FictivPricingContext | null): FictivPriceReading {
  const amount = parseFirstCurrency(text);
  if (amount === null) return { amount: null, currency: null, basis: "unknown", currencySource: null };
  const labeledCurrency = explicitUsdCurrency(text);
  const labeledBasis = priceBasis(text);
  const bareContext = priceSpan && context !== null && BARE_DOLLAR_AMOUNT.test(text.trim()) ? context : null;
  let currency: "USD" | null = labeledCurrency;
  let currencySource: FictivPriceReading["currencySource"] = labeledCurrency ? "label" : null;
  if (!currency && bareContext?.currency === "USD") {
    currency = "USD";
    currencySource = "page_context";
  }
  const bareTotal = bareContext !== null && bareContext.productionPriceStatement && bareContext.requestedQuantity === 1;
  return {
    amount,
    currency,
    basis: labeledBasis === "unknown" && bareTotal ? "total" : labeledBasis,
    currencySource,
  };
}

function isVerifiedUsdTotal(reading: FictivPriceReading) {
  return reading.amount !== null && reading.currency === "USD" && reading.basis === "total";
}

function finiteFictivFailureState(code: VendorAutomationErrorCode) {
  switch (code) {
    case "captcha": return "captcha";
    case "login_required": return "login_required";
    case "profile_in_use": return "missing_session";
    case "selector_failure":
    case "unexpected_ui_state": return "selector_drift";
    case "not_implemented": return "unsupported";
    default: return "unavailable";
  }
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

function firstSignalMatch(text: string, patterns: readonly RegExp[]) {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return pattern.source;
    }
  }

  return null;
}

/**
 * OVD-1052 (G1): the page text a portal state is read from, without Fictiv's
 * standing notices (FICTIV_LOCATORS.standingNoticeText). The export-control
 * notice under the live upload dropzone begins "Uploading parts"; read as an
 * upload in progress, it kept the real fresh upload page from ever counting
 * as fresh.
 */
function portalStateText(bodyText: string) {
  return FICTIV_LOCATORS.standingNoticeText.reduce((text, notice) => text.replaceAll(notice, " "), bodyText);
}

function classifyPortalState(rawBodyText: string): FictivPortalState {
  const bodyText = portalStateText(rawBodyText);
  if (isSignalPresent(bodyText, FICTIV_LOCATORS.capabilityLimitSignals)) {
    return "capability_limited";
  }

  if (isManualReviewText(bodyText)) {
    return "manual_review";
  }

  // Fictiv shows its "configure all parts" summary while upload analysis is
  // still running, so analysis in progress outranks configuration required.
  if (isSignalPresent(bodyText, FICTIV_LOCATORS.inProgressSignals)) {
    return "in_progress";
  }

  if (isSignalPresent(bodyText, FICTIV_LOCATORS.configurationRequiredSignals)) {
    return "configuration_required";
  }

  if (isSignalPresent(bodyText, FICTIV_LOCATORS.quoteReadySignals)) {
    return "quote_ready";
  }

  return "unknown";
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

  // Logged-in DOM carries session and account data; never persist it raw.
  await fs.writeFile(htmlPath, redactProviderPortalHtml(await page.content()), {
    encoding: "utf8",
    mode: 0o600,
  });

  return [
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

/**
 * OVD-1052 round 8 (H2): an action refused because its target names a
 * checkout, order, payment, credit, purchase or quote request control
 * (FICTIV_FORBIDDEN_CLICK_TARGET). Nothing was done on the target. No click
 * fallback swallows it (see isRunStop): the run ends as selector drift.
 */
class FictivUnsafeClickError extends VendorAutomationError {}

/** Errors that end the run wherever they surface: a kill switch refusal, an abort, or an unsafe click refusal. */
function isRunStop(error: unknown) {
  return error instanceof ProviderKillSwitchError
    || error instanceof ProviderAbortedError
    || error instanceof FictivUnsafeClickError;
}

/** Ignores a failed optional action (a modal dismissal, say), but never a run stop. */
function ignoreUnlessRunStop(error: unknown) {
  if (isRunStop(error)) throw error;
  return undefined;
}

type FictivActionKind = "click" | "press" | "fill";

/** Each guard read waits at most this long; the target was found just before. */
const ACTION_GUARD_READ_TIMEOUT_MS = 2_000;

/** A guard field as it is matched: camel case and separators read as spaces ("placeOrder", "RequestAQuote", "request-quote"). */
function actionGuardText(value: string) {
  return value
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replaceAll(/[\s_\-./:]+/g, " ")
    .trim();
}

/**
 * The single guard every click, key press and fill in this adapter goes
 * through (clickFictivControl, pressFictivControl, fillFictivControl), right
 * before the action. It reads the target's text, aria-label, title, value,
 * href and data-test-target and refuses the action when any of them names a
 * forbidden control, whatever selector resolved to it. A target whose text
 * cannot be read is not acted on either; that fails like the action itself
 * would, so an optional click's fallback still applies.
 */
async function assertSafeActionTarget(locator: Locator, action: string, kind: FictivActionKind) {
  const timeout = ACTION_GUARD_READ_TIMEOUT_MS;
  const attribute = (name: string) => locator.getAttribute(name, { timeout }).catch(() => null);
  const text = await locator.innerText({ timeout }).catch(() => null);
  if (text === null) {
    throw new Error(`Fictiv ${kind} target (${action}) could not be read, so nothing was done on it.`);
  }
  const fields: Array<[string, string | null]> = [
    ["text", text],
    ["aria-label", await attribute("aria-label")],
    ["title", await attribute("title")],
    ["value", (await locator.inputValue({ timeout }).catch(() => null)) || (await attribute("value"))],
    ["href", await attribute("href")],
    ["data-test-target", await attribute("data-test-target")],
  ];
  for (const [field, raw] of fields) {
    const match = raw ? FICTIV_FORBIDDEN_CLICK_TARGET.exec(actionGuardText(raw)) : null;
    if (!match) continue;
    throw new FictivUnsafeClickError(
      "Fictiv's action target names an order, payment or quote request control, so nothing was done on it and no price is published.",
      "unexpected_ui_state",
      {
        vendor: "fictiv",
        terminalState: "selector_drift",
        reason: "unsafe_click",
        action,
        actionKind: kind,
        matchedField: field,
        matchedTerm: match[0].toLowerCase(),
      },
    );
  }
}

/**
 * Clicks `locator` through the action guard. During configuration the price
 * state is snapshotted first, as the last action's baseline (H1, see
 * anchorConfigurationAction). Exported so tests can drive the guard directly.
 */
export async function clickFictivControl(
  page: Page,
  locator: Locator,
  action: string,
  options: { timeout?: number } = {},
) {
  await anchorConfigurationAction(page, action);
  await assertSafeActionTarget(locator, action, "click");
  await locator.click(options);
}

/** Types into `locator` through the action guard; a configuration action like any click. */
async function fillFictivControl(page: Page, locator: Locator, value: string, action: string) {
  await anchorConfigurationAction(page, action);
  await assertSafeActionTarget(locator, action, "fill");
  await locator.fill(value);
}

/** Presses `key` in `locator` through the action guard; part of the fill it follows, so not an action of its own. */
async function pressFictivControl(locator: Locator, key: string, action: string) {
  await assertSafeActionTarget(locator, action, "press");
  await locator.press(key);
}

/** An upload input (the dropzone) or a process control: the upload surface is rendered. */
const UPLOAD_SURFACE_READY_SELECTORS = [
  ...FICTIV_LOCATORS.uploadInputs,
  ...FICTIV_LOCATORS.processButtons,
];

async function firstMatchingSelector(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    if ((await page.locator(selector).first().count().catch(() => 0)) > 0) {
      return selector;
    }
  }
  return null;
}

/**
 * The process-first create-a-quote page renders its process radio cards before
 * any upload input. Radio cards alone do not identify it: a quote page's
 * Prototype / Commercial classification radios are Ant Design radio cards too,
 * and counting them as the upload surface skipped the upload and returned that
 * quote page's price (OVD-1053 round 3). The page counts only when a process
 * card carries Fictiv's own process hook and both step titles ("Select a
 * process", "Upload your files") are shown. A process-first page without that
 * hook fails closed here, as it did before round 2, with nothing clicked.
 */
async function isProcessFirstUploadPage(page: Page, bodyText: string) {
  if (!FICTIV_LOCATORS.processFirstStepSignals.every((signal) => signal.test(bodyText))) {
    return false;
  }
  return (await firstMatchingSelector(page, FICTIV_LOCATORS.processCardHooks)) !== null;
}

/** The first selector with a visible match (up to ten matches each), else null. A failed read counts as visible. */
async function firstVisibleSelector(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count().catch(() => 0), 10);
    for (let index = 0; index < count; index += 1) {
      if (await matches.nth(index).isVisible().catch(() => true)) return selector;
    }
  }
  return null;
}

type FictivUploadSurfaceCheck = {
  fresh: boolean;
  onUploadPage: boolean;
  portalState: FictivPortalState;
  existingQuoteMarker: string | null;
  progressIndicator: string | null;
};

/**
 * OVD-1053 round 4: a fresh upload page is the create-a-quote upload URL
 * showing no quote of its own: no price, review, configuration or progress
 * state, and none of an existing quote's hooks. An existing quote page offers
 * an "Add parts" file input and can read CNC Machining, so neither an upload
 * input nor a process readback tells the two apart. Read-only.
 *
 * OVD-1052 (G1): the state is read without Fictiv's standing notices (see
 * portalStateText), so the export-control notice in the live dropzone no
 * longer reads as an upload in progress; a visible progress bar
 * (FICTIV_LOCATORS.uploadProgressIndicators) still does, text or no text.
 */
async function checkUploadSurfaceFresh(page: Page, bodyText: string): Promise<FictivUploadSurfaceCheck> {
  const onUploadPage = isUploadPageUrl(page.url());
  const portalState = classifyPortalState(bodyText);
  const existingQuoteMarker = await firstMatchingSelector(page, FICTIV_LOCATORS.existingQuoteMarkers);
  const progressIndicator = await firstVisibleSelector(page, FICTIV_LOCATORS.uploadProgressIndicators);
  return {
    fresh: onUploadPage && portalState === "unknown" && existingQuoteMarker === null && progressIndicator === null,
    onUploadPage,
    portalState,
    existingQuoteMarker,
    progressIndicator,
  };
}

async function uploadSurfaceNotFreshError(
  page: Page,
  runDir: string,
  stage: "before_process_selection" | "before_upload",
) {
  const bodyText = await readBodyText(page);
  const check = await checkUploadSurfaceFresh(page, bodyText);
  return new VendorAutomationError(
    "Fictiv did not show a fresh upload page, so nothing was uploaded and no price is published.",
    "unexpected_ui_state",
    {
      vendor: "fictiv",
      terminalState: "selector_drift",
      reason: "upload_surface_not_fresh",
      detectedFlow: "quote_home",
      stage,
      onUploadPage: check.onUploadPage,
      portalState: check.portalState,
      portalStateSignal: check.portalState === "unknown" ? null : portalStateSignalFor(check.portalState, bodyText),
      existingQuoteMarker: check.existingQuoteMarker,
      progressIndicator: check.progressIndicator,
      url: page.url(),
    },
    await capturePageArtifacts(page, runDir, "upload-surface-not-fresh").catch(() => []),
  );
}

/**
 * Read-only, right before each upload attempt: the page is still a fresh
 * upload page and shows CNC Machining as the selected process.
 */
async function confirmFreshCncUploadSurface(page: Page, runDir: string) {
  if (!(await checkUploadSurfaceFresh(page, await readBodyText(page))).fresh) {
    throw await uploadSurfaceNotFreshError(page, runDir, "before_upload");
  }
  return { observedProcessBeforeUpload: await confirmCncProcessBeforeUpload(page, runDir) };
}

/**
 * OVD-1053 round 4: the upload must be seen to create a quote. Once the
 * post-upload wait ends the page has moved from the upload page to a quote
 * page; one still on the upload URL, or anywhere else, shows no quote this
 * run created, so nothing is configured on it.
 */
async function confirmQuoteCreatedFromUpload(page: Page, runDir: string) {
  const createdQuotePath = quotePagePath(page.url());
  if (createdQuotePath) {
    return createdQuotePath;
  }

  throw new VendorAutomationError(
    "Fictiv did not move from the upload to the quote it created.",
    "unexpected_ui_state",
    {
      vendor: "fictiv",
      terminalState: "selector_drift",
      reason: "created_quote_unobserved",
      detectedFlow: "upload_complete",
      onUploadPage: isUploadPageUrl(page.url()),
      url: page.url(),
    },
    await capturePageArtifacts(page, runDir, "created-quote-unobserved").catch(() => []),
  );
}

async function waitForUploadSurfaceReady(page: Page, timeoutMs: number, runDir: string) {
  const attemptedSelectors: string[] = [];
  const deadline = Date.now() + timeoutMs;
  let sawUploadSurfaceSignal = false;
  let lastBodyText = "";

  while (Date.now() < deadline) {
    await detectBlockingState(page, runDir);

    for (const selector of UPLOAD_SURFACE_READY_SELECTORS) {
      if (!attemptedSelectors.includes(selector)) {
        attemptedSelectors.push(selector);
      }

      const count = await page
        .locator(selector)
        .first()
        .count()
        .catch(() => 0);

      if (count > 0) {
        return;
      }
    }

    const bodyText = await detectBlockingState(page, runDir);
    lastBodyText = bodyText;
    for (const selector of FICTIV_LOCATORS.processCardHooks) {
      if (!attemptedSelectors.includes(selector)) {
        attemptedSelectors.push(selector);
      }
    }
    if (await isProcessFirstUploadPage(page, bodyText)) {
      return;
    }
    if (isSignalPresent(bodyText, FICTIV_LOCATORS.uploadSurfaceSignals)) {
      sawUploadSurfaceSignal = true;
    }

    await page.waitForTimeout(500);
  }

  throw new VendorAutomationError(
    "Fictiv upload surface did not finish rendering.",
    "selector_failure",
    {
      vendor: "fictiv",
      failedSelector: FICTIV_LOCATORS.uploadInputs[0],
      attemptedSelectors,
      nearbyAttributes: [...UPLOAD_SURFACE_READY_SELECTORS, ...FICTIV_LOCATORS.processCardHooks],
      sawUploadSurfaceSignal,
      bodyExcerpt: excerptText(lastBodyText),
      url: page.url(),
    },
  );
}

function portalStateSignalFor(state: Exclude<FictivPortalState, "unknown">, rawBodyText: string) {
  const bodyText = portalStateText(rawBodyText);
  switch (state) {
    case "in_progress":
      return firstSignalMatch(bodyText, FICTIV_LOCATORS.inProgressSignals);
    case "manual_review":
      return firstSignalMatch(bodyText, FICTIV_LOCATORS.manualReviewSignals);
    case "configuration_required":
      return firstSignalMatch(bodyText, FICTIV_LOCATORS.configurationRequiredSignals);
    case "capability_limited":
      return firstSignalMatch(bodyText, FICTIV_LOCATORS.capabilityLimitSignals);
    case "quote_ready":
      return firstSignalMatch(bodyText, FICTIV_LOCATORS.quoteReadySignals);
    default:
      return null;
  }
}

/**
 * The "configure all parts" summary lingers after the prototype classification
 * click while Fictiv reprices (live: still shown after networkidle, replaced by
 * the final summary later), and right after upload it can show while Fictiv's
 * drawing-based auto configuration is still pending. In both waits it only
 * counts as terminal once it holds for this many consecutive polls (about
 * 25 s live), so the adapter never starts configuring, or reports
 * configuration required, while Fictiv is still changing the quote.
 */
const CONFIGURATION_REQUIRED_SETTLE_POLLS = 40;

/**
 * OVD-1053: upload, quote creation, navigation to the quote, geometry analysis
 * and the 40-poll settle above all happen inside the post-upload wait. On the
 * single-action browser timeout (30 s) that sum overran the budget, so the run
 * failed as selector drift before configuring anything (2026-10-23 live run,
 * 36 s). The post-upload wait gets a budget of its own instead.
 */
const POST_UPLOAD_ANALYSIS_TIMEOUT_MS = 90_000;

type FictivTerminalWaitPhase = "post_upload" | "post_configuration";

async function waitForTerminalQuoteOutcome(
  page: Page,
  timeoutMs: number,
  runDir: string,
  phase: FictivTerminalWaitPhase,
  /** After configuration (H1): every poll here can record an updating signal for the last action. */
  tracker: FictivActionTracker | null = null,
) {
  const deadline = Date.now() + timeoutMs;
  let lastBodyText = "";
  let lastState: FictivPortalState = "unknown";
  let configurationRequiredPolls = 0;
  let lastRepriceIndicator: string | null = null;

  while (Date.now() < deadline) {
    const bodyText = await detectBlockingState(page, runDir);
    lastBodyText = bodyText;

    const state = classifyPortalState(bodyText);
    lastState = state;
    // OVD-1052 (G2): a priced or configure-all-parts page under a visible
    // reprice indicator is still changing (live 02:46Z: spinners over the
    // classification and summary cards right after the Prototype click).
    // Review and capability stops publish no price and stay terminal.
    // Round 8 (H1): after configuration every poll here also records what
    // the price showed since the last configuration action; none counts.
    const anyIndicator = tracker ? (await recordUnreadySettlePoll(page, tracker)).any : null;
    lastRepriceIndicator = state === "quote_ready" || state === "configuration_required"
      ? (tracker ? anyIndicator : await visibleRepriceIndicator(page))
      : null;
    configurationRequiredPolls = state === "configuration_required" && lastRepriceIndicator === null
      ? configurationRequiredPolls + 1
      : 0;
    if (
      state === "in_progress" ||
      state === "unknown" ||
      lastRepriceIndicator !== null ||
      (state === "configuration_required" && configurationRequiredPolls < CONFIGURATION_REQUIRED_SETTLE_POLLS)
    ) {
      await page.waitForTimeout(500);
      continue;
    }

    return {
      state,
      bodyText,
      matchedSignal: portalStateSignalFor(state, bodyText),
    } satisfies FictivTerminalOutcome;
  }

  // A prompt that had not held for the full settle when the budget ran out may
  // still be a reprice or auto configuration in flight, so it is not reported
  // as configuration required. Keep the page that timed out: without it the
  // failure cannot be told apart from analysis that is still running or a
  // state no signal recognizes.
  const artifacts = await capturePageArtifacts(page, runDir, `${phase}-timeout`).catch(() => []);
  throw new VendorAutomationError(
    "Fictiv quote did not reach a terminal state after upload.",
    "unexpected_ui_state",
    {
      vendor: "fictiv",
      detectedFlow: phase === "post_upload" ? "upload_complete" : "configuration_complete",
      reason: `${phase}_wait_ended_${lastState}`,
      lastRepriceIndicator,
      url: page.url(),
      bodyExcerpt: excerptText(lastBodyText),
      inProgressSignals: FICTIV_LOCATORS.inProgressSignals.map((signal) => signal.source),
    },
    artifacts,
  );
}

type FictivUploadConfirmation = { observedProcessBeforeUpload: string | null };

export type FictivUploadTarget = {
  page: Page;
  /**
   * Read-only checks before each attempt, ahead of beforeMutation; throw to
   * stop with nothing set. The result of the attempt that set the files is
   * returned as `confirmation`.
   */
  confirmBeforeAttempt?: () => Promise<FictivUploadConfirmation>;
};

export async function setFilesOnUpload(
  target: FictivUploadTarget,
  files: string[] | LiveEvaluationUploadFile[],
  beforeMutation: () => Promise<void> = async () => undefined,
) {
  const { page, confirmBeforeAttempt } = target;
  const attemptedSelectors: string[] = [];
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    for (const selector of FICTIV_LOCATORS.uploadInputs) {
      if (!attemptedSelectors.includes(selector)) {
        attemptedSelectors.push(selector);
      }

      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);

      if (count < 1) continue;

      const confirmation = await confirmBeforeAttempt?.();
      // OVD-722 and OVD-723: this loop can poll for 30 s; re-read the kill
      // switch and ask the export-control gate right before each upload
      // attempt, outside the try so a refusal is never swallowed.
      await beforeMutation();
      try {
        markProviderMutationStarted();
        await locator.setInputFiles(files);
        return { selector, attemptedSelectors, confirmation };
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

/** Where the quantity is typed: Fictiv's own quantity control first, then the other quantity-specific inputs. */
const QUANTITY_FILL_SELECTORS = [...FICTIV_LOCATORS.quantityControls, ...FICTIV_LOCATORS.quantityInputs];

/**
 * Returns null when no quantity-specific input renders. That is not a failure
 * here, since a manual review or configuration stop publishes no price, but no
 * price is published for a quantity this run did not set (see
 * waitForRequestedQuantityPriced).
 */
async function setQuantity(
  page: Page,
  quantity: number,
  beforeSubmit: () => Promise<void> = async () => undefined,
) {
  const match = await firstWorkingLocator(page, QUANTITY_FILL_SELECTORS);
  if (!match) {
    return null;
  }

  await fillFictivControl(page, match.locator, String(quantity), "quantity_fill");
  // OVD-722: Enter can submit the form; read the switch again between the
  // fill and the key press, outside the catch below.
  await beforeSubmit();
  await pressFictivControl(match.locator, "Enter", "quantity_fill").catch(ignoreUnlessRunStop);
  return match.selector;
}

/**
 * The whole display text is a quantity, optionally labeled and with a unit;
 * nothing else around it. "Qty." takes its period only before a space or a
 * colon, so "Qty.5" (which could read as 0.5) is not a quantity.
 */
const QUANTITY_DISPLAY_PATTERN =
  /^(?:(?:qty(?:\.(?=[\s:]))?|quantity)\s*:?\s*)?(\d+|\d{1,3}(?:,\d{3})+)(?:\s*(?:pcs?|pieces?|parts?|units?))?$/i;

/**
 * The quantity one of Fictiv's quantity displays reads, or null when its whole
 * text is not a quantity (see QUANTITY_DISPLAY_PATTERN). Exported so tests pin
 * the accepted label, number and unit shapes.
 */
export function parseQuantityDisplay(text: string) {
  const match = QUANTITY_DISPLAY_PATTERN.exec(text);
  return match ? Number.parseInt(match[1].replaceAll(",", ""), 10) : null;
}

/**
 * Every visible match of the first quantity display selector that has one, so
 * a second part row or a stale summary cannot hide behind the first match. An
 * element holding an input wraps the typed control and is not Fictiv's
 * display, so it is never read. Unparseable text is kept as null.
 */
async function readQuantityDisplays(page: Page) {
  for (const selector of FICTIV_LOCATORS.quantityDisplays) {
    const matches = page.locator(selector).filter({ hasNot: page.locator("input") });
    const count = Math.min(await matches.count().catch(() => 0), 10);
    const values: Array<number | null> = [];
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      if (!(await match.isVisible().catch(() => false))) continue;
      const raw = (await match.innerText().catch(() => "")).replaceAll(/\s+/g, " ").trim();
      if (!raw) continue;
      values.push(parseQuantityDisplay(raw));
    }
    if (values.length > 0) return { selector, values };
  }
  return { selector: null, values: [] as Array<number | null> };
}

/** A whole-number quantity as an input or its aria-valuenow holds it: digits only, nothing else. */
function parseQuantityControlValue(raw: string | null) {
  const text = raw?.trim() ?? "";
  return /^\d{1,7}$/.test(text) ? Number.parseInt(text, 10) : null;
}

/**
 * What one of Fictiv's own quantity controls reads: the text in the box and
 * its aria-valuenow, the quantity the control holds. A typed value Fictiv did
 * not take stays in the box while aria-valuenow keeps Fictiv's quantity, so
 * both are read and both must be the requested quantity.
 */
type FictivQuantityControlReading = { value: number | null; valueNow: number | null };

/** Every visible match of the first quantity control selector that has one (one per part row). */
async function readQuantityControls(page: Page) {
  for (const selector of FICTIV_LOCATORS.quantityControls) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count().catch(() => 0), 10);
    const readings: FictivQuantityControlReading[] = [];
    for (let index = 0; index < count; index += 1) {
      const control = matches.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      readings.push({
        value: parseQuantityControlValue(await control.inputValue().catch(() => null)),
        valueNow: parseQuantityControlValue(await control.getAttribute("aria-valuenow").catch(() => null)),
      });
    }
    if (readings.length > 0) return { selector, readings };
  }
  return { selector: null, readings: [] as FictivQuantityControlReading[] };
}

type FictivQuantityReadback = {
  confirmed: boolean;
  reason:
    | "quantity_confirmed"
    | "quantity_mismatch"
    | "quantity_unconfirmed"
    | "quantity_input_missing"
    | "quantity_reprice_unsettled";
  source: "display" | "quantity_control" | "quantity_control_and_display" | null;
  /** Fictiv's quantity display read, and what each visible match reads. */
  selector: string | null;
  values: Array<number | null>;
  /** Fictiv's own quantity control read, and what each visible match reads. */
  controlSelector: string | null;
  controlReadings: FictivQuantityControlReading[];
};

const UNREAD_QUANTITY: FictivQuantityReadback = {
  confirmed: false,
  reason: "quantity_unconfirmed",
  source: null,
  selector: null,
  values: [],
  controlSelector: null,
  controlReadings: [],
};

/**
 * OVD-1053 round 4: the quantity a price is published for is the one the
 * page holds, never the value the adapter typed. Round 3 read the typed input
 * back, which holds the typed value even while Fictiv still prices its default
 * quantity, so only Fictiv's own displays counted.
 *
 * Round 6 (F16): the 2026-10-23 live quote page has no quantity display, only
 * Fictiv's own quantity control (select-quantity), so every live run stopped
 * as quantity_input_missing. That control is now a readback source too: its
 * value and its aria-valuenow, read only on a settled, priced quote after the
 * fill (see waitForRequestedQuantityPriced) and again at publish time. Every
 * visible control and display must read the requested quantity; when both
 * render they must agree. Nothing to read, or anything that does not parse,
 * confirms nothing. Any other input, a generic number input above all, is
 * never read back.
 */
async function readBackQuantity(page: Page, requestedQuantity: number): Promise<FictivQuantityReadback> {
  const control = await readQuantityControls(page);
  const display = await readQuantityDisplays(page);
  const hasControl = control.readings.length > 0;
  const hasDisplay = display.values.length > 0;
  let source: FictivQuantityReadback["source"] = null;
  if (hasControl && hasDisplay) source = "quantity_control_and_display";
  else if (hasControl) source = "quantity_control";
  else if (hasDisplay) source = "display";
  const evidence = {
    source,
    selector: display.selector,
    values: display.values,
    controlSelector: control.selector,
    controlReadings: control.readings,
  };
  const quantities = [...control.readings.flatMap((reading) => [reading.value, reading.valueNow]), ...display.values];
  if (quantities.length === 0) {
    return { ...evidence, confirmed: false, reason: "quantity_unconfirmed" };
  }
  if (quantities.some((quantity) => quantity !== null && quantity !== requestedQuantity)) {
    return { ...evidence, confirmed: false, reason: "quantity_mismatch" };
  }
  const confirmed = !quantities.includes(null);
  return { ...evidence, confirmed, reason: confirmed ? "quantity_confirmed" : "quantity_unconfirmed" };
}

/** Consecutive polls a priced quote must hold its quantity and price for before the price counts. */
const QUANTITY_PRICED_SETTLE_POLLS = 4;
const QUANTITY_PRICED_MAX_POLLS = 60;

/** The selected price as the page shows it: the first selected-price hook with text, and that text. */
type FictivPriceSnapshot = { selector: string; text: string };

async function readSelectedPriceSnapshot(page: Page): Promise<FictivPriceSnapshot | null> {
  return firstWorkingText(page, FICTIV_LOCATORS.selectedPriceText);
}

/** A price text holding a real amount; "$ --" and no text at all are unpriced. */
function isPricedText(text: string | null) {
  return text !== null && parseFirstCurrency(text) !== null;
}

/**
 * OVD-1052 (G2): the first visible reprice indicator anywhere on the page
 * (FICTIV_LOCATORS.repriceIndicators), else null. While one shows no settle
 * poll counts, but only one in the price or summary panel shows the price
 * itself updating (see visiblePricePanelRepriceIndicator).
 */
async function visibleRepriceIndicator(page: Page) {
  return firstVisibleSelector(page, FICTIV_LOCATORS.repriceIndicators);
}

type FictivPricePanelHooks = typeof FICTIV_LOCATORS.pricePanelHooks;

/**
 * Runs in the page on one visible reprice indicator (OVD-1052 round 8, H1):
 * whether it belongs to the price or summary panel. It does when it sits
 * inside a lead-time hook; otherwise the region it covers decides. That is
 * the indicator itself when it wraps a price or summary hook, else its
 * nearest ancestor (up to four levels) holding anything besides it: the Ant
 * Design nested-loading wrapper of a nested spin, or, live, the container of
 * the summary card's standalone spinner. The region must hold a lead-time or
 * summary-card hook and none of the other regions' hooks, so a page-wide
 * spinner, or the classification card's, never counts. Plain DOM code with
 * no named inner function: tsx and esbuild would wrap one in a __name helper
 * the page does not have.
 */
function indicatorCoversPricePanel(indicator: Element, hooks: FictivPricePanelHooks) {
  if (indicator.closest(hooks.price)) return true;
  let region: Element = indicator;
  if (!indicator.querySelector(`${hooks.price}, ${hooks.summary}`)) {
    for (let depth = 0; depth < 4 && region.parentElement; depth += 1) {
      region = region.parentElement;
      if (Array.from(region.children).some((child) => !child.contains(indicator))) break;
    }
  }
  return Boolean(region.querySelector(hooks.price) ?? region.querySelector(hooks.summary))
    && region.querySelector(hooks.otherRegions) === null;
}

/**
 * The first visible reprice indicator that belongs to the price or summary
 * panel (see indicatorCoversPricePanel), else null. One that cannot be read
 * does not count: this is the signal that lets an unchanged price be
 * re-confirmed, so it is only taken when it is certain.
 */
async function visiblePricePanelRepriceIndicator(page: Page) {
  for (const selector of FICTIV_LOCATORS.repriceIndicators) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count().catch(() => 0), 10);
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      if (!(await match.isVisible().catch(() => false))) continue;
      if (await match.evaluate(indicatorCoversPricePanel, FICTIV_LOCATORS.pricePanelHooks).catch(() => false)) {
        return selector;
      }
    }
  }
  return null;
}

/** Both reads of the reprice indicators: any (holds polls back) and the price panel's (shows the price updating). */
async function readRepriceIndicators(page: Page) {
  const pricePanel = await visiblePricePanelRepriceIndicator(page);
  return { pricePanel, any: pricePanel ?? (await visibleRepriceIndicator(page)) };
}

/**
 * OVD-1052 round 8 (H1): what the price showed after the last configuration
 * action that tells it was updated for that action. A blank or unpriced
 * selection ("$ --"), a reprice indicator in the price or summary panel, or a
 * total other than the one shown right before the action.
 */
export type FictivRepriceUpdatingSignal = "unpriced" | "price_panel_reprice_indicator" | "price_changed";

/** One poll of the quote after the last configuration action. */
export type FictivSettlePoll = {
  /** A visible reprice indicator anywhere on the page, the price panel's included; while one shows no poll counts. */
  repriceIndicator: string | null;
  /** A visible reprice indicator in the price or summary panel. */
  pricePanelRepriceIndicator: string | null;
  /** The selected price text; null when no selected-price hook shows text. */
  priceText: string | null;
  /** The quote is priced and every quantity control and display reads the requested quantity. */
  ready: boolean;
  /** Everything else that must hold still with the price: the quantity readback and the lead-time panel. */
  stateKey: string;
};

/** Where the settle stands since the last configuration action. */
export type FictivSettleState = {
  /** The selected price text right before the last configuration action. */
  anchorPriceText: string | null;
  /** The first updating signal seen since the last configuration action; null while none showed. */
  updatingSignal: FictivRepriceUpdatingSignal | null;
  /** Consecutive counted polls on the same reading. */
  heldPolls: number;
  heldKey: string | null;
};

export function startFictivSettle(anchorPriceText: string | null): FictivSettleState {
  return { anchorPriceText, updatingSignal: null, heldPolls: 0, heldKey: null };
}

/**
 * OVD-1052 round 8 (H1, H4): one poll of the settle that decides which price
 * is published. Live, the quote is unpriced when the quantity is typed and
 * is priced only after later configuration actions (the Prototype
 * classification click), so a check anchored on the quantity fill was always
 * satisfied, and an old total shown for seconds after the last action was
 * published. The settle is anchored on the last configuration action
 * instead, whatever it is: no poll counts until the price showed an updating
 * signal after that action (see FictivRepriceUpdatingSignal). An unchanged
 * total with no updating signal never counts, and a total that holds after
 * one is re-confirmed by the full settle. A poll counts only on a real
 * amount, never "$ --", with no reprice indicator anywhere and the quote
 * ready; QUANTITY_PRICED_SETTLE_POLLS consecutive polls on the same reading
 * settle it. Exported so tests pin the timelines.
 */
export function advanceFictivSettle(state: FictivSettleState, poll: FictivSettlePoll): FictivSettleState {
  const priced = isPricedText(poll.priceText);
  let updatingSignal = state.updatingSignal;
  if (updatingSignal === null) {
    if (poll.pricePanelRepriceIndicator !== null) updatingSignal = "price_panel_reprice_indicator";
    else if (!priced) updatingSignal = "unpriced";
    else if (poll.priceText !== state.anchorPriceText) updatingSignal = "price_changed";
  }
  if (updatingSignal === null || poll.repriceIndicator !== null || poll.pricePanelRepriceIndicator !== null || !priced || !poll.ready) {
    return { ...state, updatingSignal, heldPolls: 0, heldKey: null };
  }
  const key = JSON.stringify([poll.priceText, poll.stateKey]);
  return { ...state, updatingSignal, heldPolls: key === state.heldKey ? state.heldPolls + 1 : 1, heldKey: key };
}

/** True once the settle has held for QUANTITY_PRICED_SETTLE_POLLS counted polls. */
export function isFictivSettled(state: FictivSettleState) {
  return state.heldPolls >= QUANTITY_PRICED_SETTLE_POLLS;
}

/**
 * The price state right before a configuration action (H1): the selected
 * price, the quantity readings and the lead-time option list, as evidence.
 */
type FictivPriceStateEvidence = {
  priceText: string | null;
  quantityControls: FictivQuantityControlReading[];
  quantityDisplays: Array<number | null>;
  leadTimeOptions: Array<Pick<FictivLeadTimeOption, "region" | "tier" | "observedPrice" | "selectable">>;
};

/**
 * What the run saw of Fictiv's reprice after its last configuration action
 * (H1), filled in by the post-configuration wait and the quantity settle and
 * kept as evidence.
 */
type FictivRepriceSettleEvidence = {
  /** Configuration actions the run made: clicks and the quantity fill. */
  actionCount: number;
  /** The last of them, by the adapter's own name for it. */
  lastAction: string | null;
  /** The price state right before the last action. */
  beforeLastAction: FictivPriceStateEvidence | null;
  /** The first updating signal seen after the last action; null when none showed. */
  updatingSignal: FictivRepriceUpdatingSignal | null;
  /** The first reprice indicator in the price or summary panel seen after the last action. */
  pricePanelRepriceIndicator: string | null;
  /** The last reprice indicator seen anywhere after the last action; on its own it never re-confirms a price. */
  lastRepriceIndicator: string | null;
};

/** The configuration actions of one run, keyed by page: each one re-anchors the settle (H1). */
type FictivActionTracker = {
  requestedQuantity: number;
  evidence: FictivRepriceSettleEvidence;
  settle: FictivSettleState;
};

const configurationActionTrackers = new WeakMap<Page, FictivActionTracker>();

/** From here on every action on `page` is a configuration action, and the settle is anchored on the last one. */
function startConfigurationActionTracker(page: Page, requestedQuantity: number) {
  const tracker: FictivActionTracker = {
    requestedQuantity,
    evidence: {
      actionCount: 0,
      lastAction: null,
      beforeLastAction: null,
      updatingSignal: null,
      pricePanelRepriceIndicator: null,
      lastRepriceIndicator: null,
    },
    settle: startFictivSettle(null),
  };
  configurationActionTrackers.set(page, tracker);
  return tracker;
}

/**
 * Read-only, right before a configuration action: the price state it is
 * compared with, and the start of a new settle. Every click and the quantity
 * fill pass through here (via clickFictivControl and fillFictivControl), the
 * auto configuration Continue during a wait included, so the settle always
 * hangs on the last action, whichever it was.
 */
async function anchorConfigurationAction(page: Page, action: string) {
  const tracker = configurationActionTrackers.get(page);
  if (!tracker) return;
  const price = await readSelectedPriceSnapshot(page);
  const controls = await readQuantityControls(page);
  const displays = await readQuantityDisplays(page);
  const leadTimes = await extractLeadTimeOptions(page, tracker.requestedQuantity);
  tracker.evidence = {
    actionCount: tracker.evidence.actionCount + 1,
    lastAction: action,
    beforeLastAction: {
      priceText: price ? scrubProviderEvidenceText(price.text, 80) : null,
      quantityControls: controls.readings,
      quantityDisplays: displays.values,
      leadTimeOptions: leadTimes.options.map(({ region, tier, observedPrice, selectable }) =>
        ({ region, tier, observedPrice, selectable })),
    },
    updatingSignal: null,
    pricePanelRepriceIndicator: null,
    lastRepriceIndicator: null,
  };
  tracker.settle = startFictivSettle(price?.text ?? null);
}

/** Advances the settle by one poll and keeps what it saw as evidence. */
function recordSettlePoll(tracker: FictivActionTracker, poll: FictivSettlePoll) {
  tracker.settle = advanceFictivSettle(tracker.settle, poll);
  tracker.evidence.updatingSignal = tracker.settle.updatingSignal;
  tracker.evidence.pricePanelRepriceIndicator ??= poll.pricePanelRepriceIndicator;
  if (poll.repriceIndicator !== null) tracker.evidence.lastRepriceIndicator = poll.repriceIndicator;
}

/** A poll that can only record an updating signal, never count: the post-configuration wait's. */
async function recordUnreadySettlePoll(page: Page, tracker: FictivActionTracker) {
  const indicators = await readRepriceIndicators(page);
  recordSettlePoll(tracker, {
    repriceIndicator: indicators.any,
    pricePanelRepriceIndicator: indicators.pricePanel,
    priceText: (await readSelectedPriceSnapshot(page))?.text ?? null,
    ready: false,
    stateKey: "",
  });
  return indicators;
}

type FictivQuantityPricing = {
  readback: FictivQuantityReadback;
  /** The selected price the quote held still on with the requested quantity; null unless it settled. */
  settledPrice: FictivPriceSnapshot | null;
  /** The lead-time options as they held still with it (F19); null unless it settled. */
  settledLeadTimes: FictivLeadTimeReading | null;
  settle: FictivRepriceSettleEvidence | null;
  /** The configuration actions made when it settled; any later action voids the settle. */
  settledAtAction: number | null;
};

/** A lead-time reading as one comparable string: options, selected option, its availability and own amounts, and the pricing context. */
function leadTimeReadingKey(reading: FictivLeadTimeReading) {
  return JSON.stringify([
    reading.options.map(leadTimeOptionReadingKey),
    reading.selectedIdentity,
    reading.selectedOptionUnavailable,
    reading.selectedOffer,
    reading.context,
  ]);
}

/**
 * OVD-1053 round 4: a price counts for the requested quantity only once the
 * page reads that quantity on a priced quote and the quote then holds still
 * (same quantity readback, same selected price) for
 * QUANTITY_PRICED_SETTLE_POLLS polls, every one of them after this run set
 * the quantity. Without a quantity-specific input the quantity was never
 * set, so there is nothing to wait for.
 *
 * Round 6: the hold covers Fictiv's quantity control (F16) and every
 * lead-time option, its price and its availability (F19), so no option is
 * published from a reading taken before the reprice settled.
 *
 * OVD-1052 (G2): while a reprice indicator is visible no price is read and
 * the count restarts. Round 8 (H1): the count waits for an updating signal
 * after the last configuration action (see advanceFictivSettle); an action
 * made during the wait (the auto configuration Continue) restarts it from a
 * new anchor. A total that never refreshed after the last action stops the
 * run as quantity_reprice_unsettled.
 */
async function waitForRequestedQuantityPriced(
  page: Page,
  requestedQuantity: number,
  quantitySelector: string | null,
  tracker: FictivActionTracker,
  timeoutMs: number,
  runDir: string,
): Promise<FictivQuantityPricing> {
  if (!quantitySelector) {
    return {
      readback: {
        ...(await readBackQuantity(page, requestedQuantity)),
        confirmed: false,
        reason: "quantity_input_missing",
      },
      settledPrice: null,
      settledLeadTimes: null,
      settle: null,
      settledAtAction: null,
    };
  }

  const deadline = Date.now() + timeoutMs;
  let readback = UNREAD_QUANTITY;
  for (let poll = 0; poll < QUANTITY_PRICED_MAX_POLLS && Date.now() < deadline; poll += 1) {
    const bodyText = await detectBlockingState(page, runDir);
    const indicators = await readRepriceIndicators(page);
    if (indicators.any !== null) {
      recordSettlePoll(tracker, {
        repriceIndicator: indicators.any,
        pricePanelRepriceIndicator: indicators.pricePanel,
        priceText: (await readSelectedPriceSnapshot(page))?.text ?? null,
        ready: false,
        stateKey: "",
      });
      await page.waitForTimeout(500);
      continue;
    }
    readback = await readBackQuantity(page, requestedQuantity);
    const price = await readSelectedPriceSnapshot(page);
    const ready = readback.confirmed && isPricedText(price?.text ?? null) && classifyPortalState(bodyText) === "quote_ready";
    const leadTimes = ready ? await extractLeadTimeOptions(page, requestedQuantity) : null;
    recordSettlePoll(tracker, {
      repriceIndicator: null,
      pricePanelRepriceIndicator: null,
      priceText: price?.text ?? null,
      ready,
      stateKey: leadTimes === null ? "" : JSON.stringify([
        readback.source,
        readback.selector,
        readback.values,
        readback.controlSelector,
        readback.controlReadings,
        price?.selector ?? null,
        leadTimeReadingKey(leadTimes),
      ]),
    });
    if (price && leadTimes && isFictivSettled(tracker.settle)) {
      return {
        readback,
        settledPrice: price,
        settledLeadTimes: leadTimes,
        settle: { ...tracker.evidence },
        settledAtAction: tracker.evidence.actionCount,
      };
    }
    await page.waitForTimeout(500);
  }

  return {
    readback: readback.confirmed ? { ...readback, confirmed: false, reason: "quantity_reprice_unsettled" } : readback,
    settledPrice: null,
    settledLeadTimes: null,
    settle: { ...tracker.evidence },
    settledAtAction: null,
  };
}

function isApprovedFictivUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === "https://app.fictiv.com";
  } catch {
    return false;
  }
}

const UPLOAD_PAGE_PATH = new URL(FICTIV_URLS.upload).pathname;

function approvedFictivPath(rawUrl: string) {
  return isApprovedFictivUrl(rawUrl) ? new URL(rawUrl).pathname : null;
}

/** The create-a-quote upload page, the only page a run uploads on. */
function isUploadPageUrl(rawUrl: string) {
  return approvedFictivPath(rawUrl)?.replace(/\/+$/, "") === UPLOAD_PAGE_PATH;
}

/** `/pages/quotes/<quote>` of a quote page (never the upload page), else null. */
function quotePagePath(rawUrl: string) {
  const [, pages, quotes, quote] = approvedFictivPath(rawUrl)?.split("/") ?? [];
  return pages === "pages" && quotes === "quotes" && quote && quote !== "upload"
    ? `/pages/quotes/${quote}`
    : null;
}

async function detectBlockingState(page: Page, runDir: string) {
  if (!isApprovedFictivUrl(page.url())) {
    throw new VendorAutomationError(
      "Fictiv navigation left the approved portal origin.",
      "navigation_failure",
      { vendor: "fictiv", terminalState: "unexpected_origin" },
    );
  }

  await dismissAutoConfigLoadingModal(page).catch(ignoreUnlessRunStop);

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
  parser: (text: string, selector: string) => number | null,
  bodyText: string,
  evidenceParser: ((text: string, selector: string) => number | null) = parser,
) {
  let unverifiedSelector: { value: number; selector: string; text: string } | null = null;
  for (const selector of selectors) {
    const match = await firstWorkingText(page, [selector]);
    if (!match) {
      continue;
    }

    const value = parser(match.text, match.selector);
    if (value !== null) {
      return {
        value,
        source: "selector" as FictivValueSource,
        selector: match.selector,
        text: match.text,
      };
    }
    const unverifiedValue = evidenceParser(match.text, match.selector);
    if (unverifiedSelector === null && unverifiedValue !== null) {
      unverifiedSelector = { value: unverifiedValue, selector: match.selector, text: match.text };
    }
  }

  if (unverifiedSelector) {
    return { ...unverifiedSelector, source: "selector" as FictivValueSource };
  }

  const fallbackValue = evidenceParser(bodyText, "body");
  const source: FictivValueSource = fallbackValue === null ? "none" : "body_text";

  return {
    value: fallbackValue,
    source,
    selector: null,
    text: bodyText,
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
  action: string,
) {
  const match = await firstWorkingLocator(page, selectors);
  if (!match) {
    return null;
  }

  await clickFictivControl(page, match.locator, action);
  return match.selector;
}

async function chooseOptionByTerms(
  page: Page,
  terms: string[],
  optionSelectors: readonly string[],
  action: string,
) {
  for (const term of terms) {
    const roleOption = page
      .getByRole("option", { name: new RegExp(escapeRegex(term), "i") })
      .first();

    if ((await roleOption.count().catch(() => 0)) > 0) {
      await clickFictivControl(page, roleOption, action);
      return term;
    }

    for (const selector of optionSelectors) {
      const option = page
        .locator(selector)
        .filter({ hasText: new RegExp(escapeRegex(term), "i") })
        .first();

      if ((await option.count().catch(() => 0)) > 0) {
        await clickFictivControl(page, option, action);
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
  beforeStep: () => Promise<void> = async () => undefined,
) {
  let selectedMaterial: string | null = null;
  let selectedFinish: string | null = null;

  const materialButtonSelector = await findButtonAndOpen(page, FICTIV_LOCATORS.materialButtons, "material_dropdown");
  if (materialButtonSelector) {
    // OVD-722: the dropdown open above is a click; recheck before choosing.
    await beforeStep();
    selectedMaterial = await chooseOptionByTerms(page, materialTerms, FICTIV_LOCATORS.materialOptions, "material_option");
  }

  if (finishTerms.length > 0) {
    // OVD-722: fresh read between material and finish.
    await beforeStep();
    const finishButtonSelector = await findButtonAndOpen(page, FICTIV_LOCATORS.finishButtons, "finish_dropdown");
    if (finishButtonSelector) {
      await beforeStep();
      selectedFinish = await chooseOptionByTerms(page, finishTerms, FICTIV_LOCATORS.finishOptions, "finish_option");
    }
  }

  return {
    selectedMaterial,
    selectedFinish,
  };
}

async function detectSelectedCncRadioCard(page: Page) {
  const selectedCount = await page
    .locator(FICTIV_LOCATORS.selectedProcessRadios[0])
    .count()
    .catch(() => 0);

  if (selectedCount === 0) {
    return null;
  }

  const selectedText = await page
    .locator(FICTIV_LOCATORS.selectedProcessRadios[0])
    .first()
    .innerText()
    .catch(() => "");

  return /cnc|machining/i.test(selectedText) ? "CNC Machining" : null;
}

/** A process card's or control's text on one line, short enough for evidence. */
function processEvidenceLabel(text: string) {
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 80);
}

type FictivProcessReadback = {
  confirmed: boolean;
  source: "process_card" | "process_control" | null;
  observedProcesses: string[];
};

/**
 * The process the page shows as chosen. On the process-first page that is the
 * checked process card, and exactly one card must be checked; a page with
 * process cards but none checked shows no process. Only a page without any
 * radio card falls back to the process control's text.
 */
async function readSelectedProcess(page: Page): Promise<FictivProcessReadback> {
  const checkedCards = page.locator(FICTIV_LOCATORS.selectedProcessRadios[0]);
  const checkedCount = Math.min(await checkedCards.count().catch(() => 0), 10);
  if (checkedCount > 0) {
    const texts: string[] = [];
    for (let index = 0; index < checkedCount; index += 1) {
      texts.push(await checkedCards.nth(index).innerText().catch(() => ""));
    }
    return {
      confirmed: texts.length === 1 && /CNC\s*Machining/i.test(texts[0]),
      source: "process_card",
      observedProcesses: texts.map(processEvidenceLabel),
    };
  }

  if ((await page.locator(FICTIV_LOCATORS.processRadioCards[0]).count().catch(() => 0)) > 0) {
    return { confirmed: false, source: "process_card", observedProcesses: [] };
  }

  const control = await firstWorkingText(page, FICTIV_LOCATORS.processButtons);
  return {
    confirmed: Boolean(control && /\bCNC\b|machining/i.test(control.text)),
    source: control ? "process_control" : null,
    observedProcesses: control ? [processEvidenceLabel(control.text)] : [],
  };
}

/** Re-reads of an unconfirmed process before failing; React may re-render just after the click. */
const PROCESS_READBACK_ATTEMPTS = 4;

/**
 * OVD-1053 round 3: a CNC card click that resolves is not proof the card took.
 * Right before the files are set, the page must show CNC Machining as the
 * selected process; otherwise the upload never happens and the run stops as
 * selector drift with the process the page showed instead. Read-only: it never
 * clicks again.
 */
async function confirmCncProcessBeforeUpload(page: Page, runDir: string) {
  let readback = await readSelectedProcess(page);
  for (let attempt = 1; attempt < PROCESS_READBACK_ATTEMPTS && !readback.confirmed; attempt += 1) {
    await page.waitForTimeout(250);
    readback = await readSelectedProcess(page);
  }
  if (readback.confirmed) {
    return readback.observedProcesses[0] ?? null;
  }

  throw new VendorAutomationError(
    "Fictiv did not show CNC Machining as the selected process before upload.",
    "unexpected_ui_state",
    {
      vendor: "fictiv",
      terminalState: "selector_drift",
      reason: "process_selection_unconfirmed",
      detectedFlow: "quote_home",
      expectedProcess: "CNC Machining",
      observedProcess: readback.observedProcesses[0] ?? null,
      observedProcesses: readback.observedProcesses,
      processReadbackSource: readback.source,
      url: page.url(),
    },
    await capturePageArtifacts(page, runDir, "process-unconfirmed").catch(() => []),
  );
}

async function clickCncRadioCard(page: Page) {
  for (const selector of FICTIV_LOCATORS.processRadioCards) {
    const cncCard = page
      .locator(selector)
      .filter({ hasText: /CNC\s*Machining/i })
      .first();

    if ((await cncCard.count().catch(() => 0)) === 0) {
      continue;
    }

    try {
      await clickFictivControl(page, cncCard, "cnc_process_card");
      return "CNC Machining";
    } catch (error) {
      // Try the next selector pattern, unless the run must stop.
      ignoreUnlessRunStop(error);
    }
  }

  return null;
}

async function dismissOverlayModals(page: Page) {
  for (const selector of FICTIV_LOCATORS.modalCloseButtons) {
    const closeButtons = page.locator(selector);
    const count = await closeButtons.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const button = closeButtons.nth(index);
      if (!(await button.isVisible().catch(() => false))) {
        continue;
      }

      await clickFictivControl(page, button, "modal_close", { timeout: 2000 }).catch(ignoreUnlessRunStop);
      await page.waitForTimeout(200).catch(() => undefined);
    }
  }
}

/**
 * OVD-722: the kill switch checkpoint for the auto configuration Continue
 * click, keyed by page. The modal is dismissed from every blocking state poll,
 * so the checkpoint is registered once per page rather than threaded through
 * each poll helper.
 */
const autoConfigContinueCheckpoints = new WeakMap<Page, () => Promise<void>>();

async function dismissAutoConfigLoadingModal(page: Page) {
  const continueButton = page.locator(FICTIV_LOCATORS.autoConfigModalContinue[0]).first();
  if (!(await continueButton.isVisible().catch(() => false))) {
    return false;
  }

  // Continue applies Fictiv's auto configuration to the provider side quote.
  // The read sits outside every catch below so a refusal propagates.
  const checkpoint = autoConfigContinueCheckpoints.get(page);
  await checkpoint?.();
  const hideCheckbox = page.locator(FICTIV_LOCATORS.autoConfigModalHideCheckbox[0]).first();
  if (await hideCheckbox.isVisible().catch(() => false)) {
    await clickFictivControl(page, hideCheckbox, "auto_config_hide", { timeout: 2000 }).catch(ignoreUnlessRunStop);
    await page.waitForTimeout(200).catch(() => undefined);
  }

  await checkpoint?.();
  await clickFictivControl(page, continueButton, "auto_config_continue", { timeout: 2000 }).catch(ignoreUnlessRunStop);
  await page.waitForTimeout(200).catch(() => undefined);
  return true;
}

async function trySelectCncProcess(
  page: Page,
  beforeClick: () => Promise<void> = async () => undefined,
) {
  const processTerms = ["CNC", "CNC Machining", "Machining"];

  const alreadySelected = await detectSelectedCncRadioCard(page);
  if (alreadySelected) {
    return alreadySelected;
  }

  // OVD-722: the clicks below change the provider page; check first.
  await beforeClick();

  const clickedCnc = await clickCncRadioCard(page);
  if (clickedCnc) {
    return clickedCnc;
  }

  const existingSelection = await firstWorkingText(page, FICTIV_LOCATORS.processButtons);
  if (existingSelection && processTerms.some((term) => new RegExp(escapeRegex(term), "i").test(existingSelection.text))) {
    return "CNC";
  }

  // OVD-722: the radio click wait above may have outlasted an engagement.
  await beforeClick();
  const processButtonSelector = await findButtonAndOpen(page, FICTIV_LOCATORS.processButtons, "process_dropdown");
  if (!processButtonSelector) {
    return null;
  }

  await beforeClick();
  const selectedProcess = await chooseOptionByTerms(page, processTerms, FICTIV_LOCATORS.processOptions, "process_option");
  return selectedProcess ?? null;
}

async function trySetEndUsePrototype(
  page: Page,
  beforeStep: () => Promise<void> = async () => undefined,
) {
  const assumedDefaultSelection = {
    selectedEndUse: "Prototype",
    selectedEndUseSource: "assumed_default" as FictivEndUseSource,
  };

  const existingSelection = await firstWorkingText(page, FICTIV_LOCATORS.endUseButtons);
  if (existingSelection && /prototype/i.test(existingSelection.text)) {
    return {
      selectedEndUse: "Prototype",
      selectedEndUseSource: "selector" as FictivEndUseSource,
    };
  }

  let endUseButtonSelector: string | null = null;
  try {
    endUseButtonSelector = await findButtonAndOpen(page, FICTIV_LOCATORS.endUseButtons, "end_use");
  } catch (error) {
    ignoreUnlessRunStop(error);
    return assumedDefaultSelection;
  }

  if (!endUseButtonSelector) {
    return assumedDefaultSelection;
  }

  // OVD-722: outside the try/catch so a kill switch error is not swallowed.
  await beforeStep();

  let selectedEndUse: string | null = null;
  try {
    selectedEndUse = await chooseOptionByTerms(
      page,
      ["Prototype"],
      FICTIV_LOCATORS.endUseOptions,
      "end_use_option",
    );
  } catch (error) {
    ignoreUnlessRunStop(error);
    return assumedDefaultSelection;
  }

  if (selectedEndUse) {
    return {
      selectedEndUse,
      selectedEndUseSource: "selector" as FictivEndUseSource,
    };
  }

  return assumedDefaultSelection;
}

async function openConfigurationDrawerIfPresent(page: Page) {
  let selector: string | null = null;
  try {
    selector = await findButtonAndOpen(page, FICTIV_LOCATORS.configurationDrawerButtons, "configuration_drawer");
  } catch (error) {
    ignoreUnlessRunStop(error);
    return false;
  }

  if (!selector) {
    return false;
  }

  await page.waitForTimeout(200).catch(() => undefined);
  return true;
}

async function waitForCncSelectionBeforeUpload(
  page: Page,
  timeoutMs: number,
  runDir: string,
  beforeClick: () => Promise<void> = async () => undefined,
) {
  const deadline = Date.now() + timeoutMs;
  let lastBodyText = "";

  while (Date.now() < deadline) {
    lastBodyText = await detectBlockingState(page, runDir);
    // OVD-1053 round 4: nothing is clicked on a page that is not a fresh
    // upload page (an existing quote, typically); the caller stops the run.
    if (!(await checkUploadSurfaceFresh(page, lastBodyText)).fresh) {
      return null;
    }

    const selectedProcess = await trySelectCncProcess(page, beforeClick);
    if (selectedProcess) {
      return selectedProcess;
    }

    await detectBlockingState(page, runDir);
    await page.waitForTimeout(500);
  }

  throw new VendorAutomationError(
    "Fictiv process selection did not complete before upload.",
    "unexpected_ui_state",
    {
      vendor: "fictiv",
      url: page.url(),
      expectedProcess: "CNC",
      bodyExcerpt: excerptText(lastBodyText),
    },
  );
}

/** Fictiv's own Edit configuration link, the last line of a configuration cell; not a configuration value. */
const EDIT_CONFIGURATION_LINE = /^edit\s+configuration$/i;

type FictivConfigurationField = "process" | "material" | "finish";

/**
 * OVD-1053 round 5: the configuration the priced quote page itself shows, read
 * from its one part row's configuration cell (process, material and finish,
 * one per line, then Fictiv's Edit configuration link). Labels are kept only
 * when exactly one visible cell shows exactly those three lines; anything else
 * is unreadable and keeps no text.
 */
type FictivConfigurationReadback = {
  selector: string | null;
  /** Visible configuration cells: one per part row. */
  summaryCount: number;
  /** Lines in the one cell, the Edit configuration link excluded; null without exactly one cell. */
  lineCount: number | null;
  labels: Record<FictivConfigurationField, string> | null;
};

async function readPartConfiguration(page: Page): Promise<FictivConfigurationReadback> {
  for (const selector of FICTIV_LOCATORS.partConfigurationSummaries) {
    const cells = page.locator(selector);
    const count = Math.min(await cells.count().catch(() => 0), 10);
    const texts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const cell = cells.nth(index);
      if (!(await cell.isVisible().catch(() => false))) continue;
      texts.push(await cell.innerText().catch(() => ""));
    }
    if (texts.length === 0) continue;
    if (texts.length !== 1) {
      return { selector, summaryCount: texts.length, lineCount: null, labels: null };
    }
    const lines = texts[0]
      .split("\n")
      .map((line) => line.replaceAll(/\s+/g, " ").trim())
      .filter((line) => line && !EDIT_CONFIGURATION_LINE.test(line));
    if (lines.length !== 3) {
      return { selector, summaryCount: 1, lineCount: lines.length, labels: null };
    }
    const [process, material, finish] = lines;
    return { selector, summaryCount: 1, lineCount: 3, labels: { process, material, finish } };
  }
  return { selector: null, summaryCount: 0, lineCount: null, labels: null };
}

/** A configuration label as evidence: one line, scrubbed of account identifiers, at most 80 characters. */
function configurationEvidenceLabel(label: string | null | undefined) {
  return label ? scrubProviderEvidenceText(label, 80) : null;
}

/** The fields whose read-back label is not the requested (or, for the process, CNC) configuration. */
function configurationMismatches(
  labels: Record<FictivConfigurationField, string>,
  input: VendorQuoteAdapterInput,
): FictivConfigurationField[] {
  const mismatched: FictivConfigurationField[] = [];
  if (!processReadbackMatches(labels.process)) mismatched.push("process");
  if (!materialReadbackMatches(input.requirement.material, labels.material)) mismatched.push("material");
  if (!finishReadbackMatches(input.requirement.finish, labels.finish)) mismatched.push("finish");
  return mismatched;
}

/** Read-back evidence for rawPayload and failure payloads: labels and counts only. */
function configurationReadbackEvidence(
  configuration: FictivConfigurationReadback,
  quantity: FictivQuantityReadback | null,
) {
  return {
    source: "priced_quote_page" as const,
    selector: configuration.selector,
    summaryCount: configuration.summaryCount,
    lineCount: configuration.lineCount,
    process: configurationEvidenceLabel(configuration.labels?.process),
    material: configurationEvidenceLabel(configuration.labels?.material),
    finish: configurationEvidenceLabel(configuration.labels?.finish),
    quantities: quantity?.values ?? [],
    quantitySelector: quantity?.selector ?? null,
    quantityControls: quantity?.controlReadings ?? [],
    quantityControlSelector: quantity?.controlSelector ?? null,
  };
}

const FICTIV_ORIGIN = new URL(FICTIV_URLS.upload).origin;

/** The URL of the quote this run's upload created: the only quote URL a run publishes. */
function createdQuoteUrl(provenance: FictivUploadProvenance) {
  return new URL(provenance.createdQuotePath, FICTIV_ORIGIN).toString();
}

function inferRegionFromText(text: string): "domestic" | "overseas" | null {
  if (/usa|mexico|domestic|north america/i.test(text)) return "domestic";
  if (/overseas|international|asia/i.test(text)) return "overseas";
  return null;
}

function inferTierFromText(text: string): "fastest" | "standard" | "cost_effective" | null {
  if (/fastest/i.test(text)) return "fastest";
  if (/cost.?effective|economy/i.test(text)) return "cost_effective";
  if (/standard/i.test(text)) return "standard";
  return null;
}

const SELECTED_LEAD_TIME_OPTION = '[data-test-target="quote-level-lead-time-selected-option"]';
/** Fictiv's price span inside the selected option (G3, live), FICTIV_LOCATORS.selectedPriceText[1]. */
const SELECTED_OPTION_PRICE_SPAN = `${SELECTED_LEAD_TIME_OPTION} ${FICTIV_LOCATORS.leadTimeOptionPrice}`;

/** Wording that marks a lead-time option the page shows but does not offer. */
const LEAD_TIME_OPTION_UNAVAILABLE_TEXT = /\b(?:unavailable|not available|sold out)\b/i;

/**
 * OVD-1053 round 6 (F19): whether the page marks the option at `selector`
 * unavailable: unavailable wording, or one of
 * FICTIV_LOCATORS.leadTimeOptionUnavailableMarkers on the option or inside
 * it, or a disabled input inside it. A check that cannot be read counts as
 * unavailable.
 */
async function leadTimeOptionMarkedUnavailable(page: Page, selector: string, rawText: string) {
  if (LEAD_TIME_OPTION_UNAVAILABLE_TEXT.test(rawText)) return true;
  const markers = [
    ...FICTIV_LOCATORS.leadTimeOptionUnavailableMarkers.flatMap((marker) => [`${selector}${marker}`, `${selector} ${marker}`]),
    `${selector} input[disabled]`,
  ];
  const count = await page.locator(markers.join(", ")).count().catch(() => -1);
  return count !== 0;
}

/** What a lead-time option's data-name names, when it is one of Fictiv's per-option hooks. */
function leadTimeTargetByDataName(dataName: string | null) {
  return FICTIV_LOCATORS.leadTimeOptionTargets.find((entry) => entry.dataName === dataName) ?? null;
}

/**
 * The selected option's region and tier. The selected option's
 * data-test-target is swapped to `quote-level-lead-time-selected-option`, but
 * live (02:46Z) its data-name keeps the per-option hook, which names both;
 * the live overseas options' own text never says "overseas". Without a
 * data-name both come from the text. A data-name that names no option, or
 * text that contradicts it, leaves the option unread.
 */
function selectedLeadTimeIdentity(dataName: string | null, rawText: string): FictivLeadTimeIdentity | null {
  const textRegion = inferRegionFromText(rawText);
  const textTier = inferTierFromText(rawText);
  if (dataName === null) return textRegion && textTier ? { region: textRegion, tier: textTier } : null;
  const named = leadTimeTargetByDataName(dataName);
  if (!named) return null;
  if ((textRegion && textRegion !== named.region) || (textTier && textTier !== named.tier)) return null;
  return { region: named.region, tier: named.tier };
}

/** The whole text of the first match of `selector`, trimmed; null when nothing matches. */
async function textOf(page: Page, selector: string) {
  const locator = page.locator(selector).first();
  if ((await locator.count().catch(() => 0)) === 0) return null;
  return (await locator.innerText().catch(() => "")).trim();
}

async function readSelectedLeadTimeOption(
  page: Page,
  context: FictivPricingContext,
): Promise<FictivLeadTimeOption | null> {
  const selectedLocator = page.locator(SELECTED_LEAD_TIME_OPTION).first();
  if ((await selectedLocator.count().catch(() => 0)) === 0) return null;

  const rawText = (await selectedLocator.innerText().catch(() => "")).trim();
  if (!rawText) return null;

  const identity = selectedLeadTimeIdentity(await selectedLocator.getAttribute("data-name").catch(() => null), rawText);
  if (!identity) return null;

  return {
    ...identity,
    ...parseFictivOptionValues(rawText, await textOf(page, SELECTED_OPTION_PRICE_SPAN), context),
    selectable: !(await leadTimeOptionMarkedUnavailable(page, SELECTED_LEAD_TIME_OPTION, rawText)),
    selector: SELECTED_LEAD_TIME_OPTION,
    rawText,
  };
}

/**
 * An option's days come from its whole text. Its price comes from Fictiv's
 * own price span inside it (FICTIV_LOCATORS.leadTimeOptionPrice, live) when
 * it has one and its text shows no other amount, else from its whole text as
 * before. See readFictivPrice for when a bare "$" amount counts.
 */
function parseFictivOptionValues(rawText: string, priceSpanText: string | null, context: FictivPricingContext) {
  const days = parseLeadTime(rawText);
  const amountsInOption = [...rawText.matchAll(/\$ ?\d[\d,]*(?:\.\d{2})?/g)].length;
  const price = priceSpanText !== null && amountsInOption <= 1
    ? readFictivPrice(priceSpanText, true, context)
    : readFictivPrice(rawText, false, null);
  const totalPriceUsd = isVerifiedUsdTotal(price) ? price.amount : null;
  return {
    days,
    observedPrice: price.amount,
    priceBasis: price.basis,
    totalPriceUsd,
    currency: price.currency,
    currencySource: price.currencySource,
    priceSource: price.amount === null ? "none" as const : "selector" as const,
    leadTimeSource: days === null ? "none" as const : "selector" as const,
  };
}

type FictivLeadTimeIdentity = Pick<FictivLeadTimeOption, "region" | "tier">;

/** One read of the lead-time panel: every option it shows, which one is selected, and whether that one is offered. */
type FictivLeadTimeReading = {
  options: FictivLeadTimeOption[];
  selectedIdentity: FictivLeadTimeIdentity | null;
  /** The selected option element is marked unavailable, whether or not its region and tier could be read. */
  selectedOptionUnavailable: boolean;
  /** What the selected option element shows of its own price (round 8, H3). */
  selectedOffer: FictivSelectedOfferAmounts;
  /** What the page established about its bare "$" prices when this reading was taken (G3). */
  context: FictivPricingContext;
};

/**
 * OVD-1052 round 8 (H3): the published headline is the selected option's own
 * single price. These are the counts that say whether it has one.
 */
type FictivSelectedOfferAmounts = {
  /** Elements carrying the selected-option hook. */
  optionCount: number;
  /** Fictiv price spans inside the selected option. */
  priceSpanCount: number;
  /** Every dollar amount the selected option's text shows ("$ --" is none). */
  amounts: number[];
};

const DOLLAR_AMOUNTS = /\$ ?\d[\d,]*(?:\.\d{2})?/g;

/** More than one selected option, price span or amount: the selected offer has no single price. */
function isSelectedOfferAmbiguous(offer: FictivSelectedOfferAmounts) {
  return offer.optionCount > 1 || offer.priceSpanCount > 1 || offer.amounts.length > 1;
}

async function readSelectedOfferAmounts(page: Page): Promise<FictivSelectedOfferAmounts> {
  const optionCount = await page.locator(SELECTED_LEAD_TIME_OPTION).count().catch(() => 0);
  if (optionCount === 0) return { optionCount, priceSpanCount: 0, amounts: [] };
  const text = (await page.locator(SELECTED_LEAD_TIME_OPTION).first().innerText().catch(() => "")).trim();
  return {
    optionCount,
    priceSpanCount: await page.locator(SELECTED_OPTION_PRICE_SPAN).count().catch(() => 0),
    amounts: [...text.matchAll(DOLLAR_AMOUNTS)]
      .map((match) => parseFirstCurrency(match[0]))
      .filter((amount): amount is number => amount !== null),
  };
}

/**
 * OVD-1052 (G3): the page's currency context (fictivCurrencyContext over the
 * page text and every visible currency hook) and the lead-time panel
 * header's statement, read fresh with each lead-time reading.
 */
async function readPricingContext(page: Page, requestedQuantity: number): Promise<FictivPricingContext> {
  const hookTexts: string[] = [];
  for (const selector of FICTIV_LOCATORS.currencyContextHooks) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count().catch(() => 0), 10);
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      if (!(await match.isVisible().catch(() => false))) continue;
      hookTexts.push(await match.innerText().catch(() => ""));
    }
  }
  const header = await textOf(page, FICTIV_LOCATORS.leadTimePanelHeader);
  return {
    ...fictivCurrencyContext(await readBodyText(page), hookTexts),
    productionPriceStatement: header !== null && PRODUCTION_PRICE_STATEMENT.test(header),
    requestedQuantity,
  };
}

async function extractLeadTimeOptions(page: Page, requestedQuantity: number): Promise<FictivLeadTimeReading> {
  const context = await readPricingContext(page, requestedQuantity);
  const results: FictivLeadTimeOption[] = [];
  const seen = new Set<string>();

  for (const entry of FICTIV_LOCATORS.leadTimeOptionTargets) {
    const locator = page.locator(entry.selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;

    const rawText = (await locator.innerText().catch(() => "")).trim();
    if (!rawText) continue;

    results.push({
      region: entry.region,
      tier: entry.tier,
      ...parseFictivOptionValues(rawText, await textOf(page, `${entry.selector} ${FICTIV_LOCATORS.leadTimeOptionPrice}`), context),
      selectable: !(await leadTimeOptionMarkedUnavailable(page, entry.selector, rawText)),
      selector: entry.selector,
      rawText,
    });
    seen.add(`${entry.region}:${entry.tier}`);
  }

  const selected = await readSelectedLeadTimeOption(page, context);
  if (selected && !seen.has(`${selected.region}:${selected.tier}`)) results.push(selected);
  const selectedPresent = (await page.locator(SELECTED_LEAD_TIME_OPTION).count().catch(() => 0)) > 0;
  const selectedText = selectedPresent
    ? (await page.locator(SELECTED_LEAD_TIME_OPTION).first().innerText().catch(() => "")).trim()
    : "";

  return {
    options: results,
    selectedIdentity: selected ? { region: selected.region, tier: selected.tier } : null,
    selectedOptionUnavailable: selectedPresent
      && (await leadTimeOptionMarkedUnavailable(page, SELECTED_LEAD_TIME_OPTION, selectedText)),
    selectedOffer: await readSelectedOfferAmounts(page),
    context,
  };
}

function leadTimeIdentityKey(identity: FictivLeadTimeIdentity | null) {
  return identity ? `${identity.region}:${identity.tier}` : null;
}

/**
 * What one option reads as: its selector, text, availability and how its
 * price was read (G3: a bare price read as USD under one currency context is
 * not the same reading as under none). Equal readings are the same option,
 * unchanged.
 */
function leadTimeOptionReadingKey(option: FictivLeadTimeOption) {
  return JSON.stringify([
    option.region,
    option.tier,
    option.selector,
    option.rawText,
    option.selectable,
    option.currency,
    option.priceBasis,
    option.totalPriceUsd,
  ]);
}

/** A verified USD total above zero, read from the option's own element. */
function isAnchoredLeadTimeOption(option: FictivLeadTimeOption) {
  return option.priceSource === "selector"
    && option.currency === "USD"
    && option.totalPriceUsd !== null
    && option.totalPriceUsd > 0;
}

type FictivWithheldLeadTimeOption = FictivLeadTimeIdentity & {
  reason: "unavailable" | "changed_after_settle";
};

type FictivSelectedOfferRefusal =
  | "selected_option_changed"
  | "selected_option_unavailable"
  | "selected_option_changed_after_settle"
  | "selected_offer_ambiguous"
  | "selected_offer_mismatch";

type FictivOfferPlan =
  | { publish: true; offers: VendorQuoteAdapterOffer[]; withheld: FictivWithheldLeadTimeOption[] }
  | {
      publish: false;
      reason: FictivSelectedOfferRefusal;
      terminalState: "configuration_required" | "selector_drift";
      selectedIdentity: FictivLeadTimeIdentity | null;
      withheld: FictivWithheldLeadTimeOption[];
    };

type FictivSelectedPrice = {
  totalPrice: number | null;
  leadTime: number | null;
  priceSelector: string | null;
  leadTimeSource: FictivValueSource;
};

/**
 * OVD-1053 round 6 (F19, F21): which lead-time options are published. The
 * panel is read three times: as the priced quote held still (the settle),
 * when the price was extracted, and at publish time, after every other
 * readback. An option is published only when all three read it the same way
 * and none marks it unavailable; any other option is withheld. The selected
 * option carries the headline price, so instead of being withheld it stops
 * the run: when it moved, is marked unavailable, changed after the settle, or
 * shows its own verified total that differs from the selected price.
 *
 * Round 8 (H3): the headline must equal the selected option's own single
 * price. A reading with more than one selected option, price span or amount
 * in it stops the run as selected_offer_ambiguous, and one amount other than
 * the headline (verified or not) as selected_offer_mismatch.
 */
function planFictivOffers(input: {
  settled: FictivLeadTimeReading | null;
  extracted: FictivLeadTimeReading;
  atPublish: FictivLeadTimeReading;
  quantity: number;
  quoteUrl: string;
  selected: FictivSelectedPrice;
}): FictivOfferPlan {
  const { settled, extracted, atPublish } = input;
  const selectedIdentity = extracted.selectedIdentity;
  const selectedKey = leadTimeIdentityKey(selectedIdentity);
  const readings = [settled, extracted, atPublish];

  const withheld: FictivWithheldLeadTimeOption[] = [];
  const confirmed: FictivLeadTimeOption[] = [];
  for (const option of extracted.options) {
    const key = leadTimeOptionReadingKey(option);
    const sameEverywhere = readings.every((reading) =>
      reading?.options.some((other) => leadTimeOptionReadingKey(other) === key) ?? false);
    const unavailable = readings.some((reading) => reading?.options.some((other) =>
      other.region === option.region && other.tier === option.tier && !other.selectable) ?? false);
    if (unavailable || !option.selectable) {
      withheld.push({ region: option.region, tier: option.tier, reason: "unavailable" });
    } else if (!sameEverywhere) {
      withheld.push({ region: option.region, tier: option.tier, reason: "changed_after_settle" });
    } else {
      confirmed.push(option);
    }
  }

  const refuse = (
    reason: FictivSelectedOfferRefusal,
    terminalState: "configuration_required" | "selector_drift",
  ): FictivOfferPlan => ({ publish: false, reason, terminalState, selectedIdentity, withheld });

  if (readings.some((reading) => reading !== null && isSelectedOfferAmbiguous(reading.selectedOffer))) {
    return refuse("selected_offer_ambiguous", "selector_drift");
  }
  if (readings.some((reading) => leadTimeIdentityKey(reading?.selectedIdentity ?? null) !== selectedKey)) {
    return refuse("selected_option_changed", "configuration_required");
  }
  if (readings.some((reading) => reading?.selectedOptionUnavailable ?? false)) {
    return refuse("selected_option_unavailable", "configuration_required");
  }
  const selectedWithheld = withheld.find((option) => leadTimeIdentityKey(option) === selectedKey);
  if (selectedWithheld) {
    return refuse(
      selectedWithheld.reason === "unavailable" ? "selected_option_unavailable" : "selected_option_changed_after_settle",
      "configuration_required",
    );
  }
  const selectedOption = confirmed.find((option) => leadTimeIdentityKey(option) === selectedKey);
  const ownAmounts = extracted.selectedOffer.amounts;
  if (
    (ownAmounts.length === 1 && ownAmounts[0] !== input.selected.totalPrice)
    || (selectedOption
      && isAnchoredLeadTimeOption(selectedOption)
      && (selectedOption.totalPriceUsd !== input.selected.totalPrice || selectedOption.days !== input.selected.leadTime))
  ) {
    return refuse("selected_offer_mismatch", "selector_drift");
  }

  return {
    publish: true,
    offers: buildFictivOffers(confirmed, input.quantity, input.quoteUrl, { ...input.selected, identity: selectedIdentity }),
    withheld,
  };
}

/**
 * The offers for confirmed options (see planFictivOffers): every one with a
 * verified USD total above zero, the selected price first. The selected price
 * stands as its own offer when no confirmed option carries it. Every offer is
 * on the created quote's URL.
 */
function buildFictivOffers(
  options: readonly FictivLeadTimeOption[],
  quantity: number,
  quoteUrl: string,
  selected: FictivSelectedPrice & { identity: FictivLeadTimeIdentity | null },
): VendorQuoteAdapterOffer[] {
  const anchored = options.filter(isAnchoredLeadTimeOption);
  const pricedOptions: Array<FictivLeadTimeOption | {
    selectedFallback: true;
    region: null;
    tier: null;
    totalPriceUsd: number;
    days: number | null;
    selector: string;
    leadTimeSource: "selector" | "none";
  }> = [...anchored];
  const selectedIndex = pricedOptions.findIndex((option) => {
    if (option.totalPriceUsd !== selected.totalPrice || option.days !== selected.leadTime) return false;
    if (!selected.identity) return true;
    return option.region === selected.identity.region && option.tier === selected.identity.tier;
  });
  const selectedRepresented = selectedIndex >= 0;
  if (selectedIndex > 0) {
    const [selectedOption] = pricedOptions.splice(selectedIndex, 1);
    pricedOptions.unshift(selectedOption);
  }
  if (!selectedRepresented
    && selected.totalPrice !== null
    && selected.totalPrice > 0
    && selected.priceSelector) {
    pricedOptions.unshift({
      selectedFallback: true,
      region: null,
      tier: null,
      totalPriceUsd: selected.totalPrice,
      days: selected.leadTime,
      selector: selected.priceSelector,
      leadTimeSource: selected.leadTimeSource === "selector" ? "selector" : "none",
    });
  }

  return pricedOptions.map((option, index) => {
    const isFallback = "selectedFallback" in option;
    const providerLabel = isFallback ? "Selected Fictiv option" : `${option.region} ${option.tier}`;
    const providerOptionId = isFallback ? "selected-option" : `${option.region}:${option.tier}`;
    const totalPriceUsd = option.totalPriceUsd!;
    return {
      providerOptionId,
      providerLabel,
      quoteRef: null,
      quoteUrl,
      quantity,
      unitPriceUsd: Math.round((totalPriceUsd / quantity) * 100) / 100,
      totalPriceUsd,
      leadTimeBusinessDays: option.days,
      shipReceiveBy: null,
      tier: isFallback ? null : option.tier,
      sourcing: isFallback ? null : option.region,
      geographicOrigin: "unknown",
      sortRank: index,
      provenance: {
        containerSelector: option.selector,
        providerOptionIdSource: "provider_label",
        priceSource: "selector",
        leadTimeSource: option.leadTimeSource,
        geographicOriginSource: "none",
      },
      rawPayload: { currency: "USD", priceBasis: "total", optionSelector: option.selector },
    };
  });
}

async function navigateToQuoteSurface(
  page: Page,
  beforeNavigation: () => Promise<void> = async () => undefined,
) {
  for (const url of [FICTIV_URLS.upload, FICTIV_URLS.quotes, FICTIV_URLS.home]) {
    // OVD-722: before every navigation attempt, outside the try so the
    // fallback loop never swallows a refusal.
    await beforeNavigation();
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

  private async startLiveSession(prerequisites: FictivLivePrerequisites): Promise<FictivLiveSession> {
    const browser = await chromium.launch({
      headless: this.config.playwrightHeadless,
      ...chromiumSandboxLaunchOptions(this.config),
    });
    let browserContext: BrowserContext | null = null;
    try {
      browserContext = await browser.newContext({
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
    } catch (error) {
      await browserContext?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw error;
    }
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
    await navigateToQuoteSurface(page, async () => input.providerKillSwitchCheckpoint?.("before_navigation"));
    await detectBlockingState(page, runDir);
    await appendArtifacts(artifacts, page, runDir, "landing");
    await waitForUploadSurfaceReady(page, this.config.browserTimeoutMs, runDir);

    const selectedProcessBeforeUpload = await waitForCncSelectionBeforeUpload(
      page,
      this.config.browserTimeoutMs,
      runDir,
      async () => input.providerKillSwitchCheckpoint?.("before_configure"),
    );
    await detectBlockingState(page, runDir);

    const liveEvaluationUploadFiles = getAuthorizedLiveEvaluationFiles(input);
    if (
      liveEvaluationUploadFiles &&
      input.stagedDrawingFile &&
      !liveEvaluationUploadFiles.drawing
    ) {
      throw new VendorAutomationError(
        "Live Fictiv evaluation is missing its authorized drawing payload.",
        "upload_failure",
        {
          vendor: "fictiv",
          reason: "evaluation_authorized_drawing_missing",
        },
      );
    }
    const uploadFiles = liveEvaluationUploadFiles
      ? [
          liveEvaluationUploadFiles.cad,
          liveEvaluationUploadFiles.drawing,
        ].filter((value): value is LiveEvaluationUploadFile => Boolean(value))
      : [
          prerequisites.stagedCadFile.localPath,
          input.stagedDrawingFile?.localPath,
        ].filter((value): value is string => Boolean(value));

    let uploadSelector: string | null = null;
    let uploadProvenance: FictivUploadProvenance | null = null;
    if (selectedProcessBeforeUpload) {
      await input.providerKillSwitchCheckpoint?.("before_upload");
      const uploadResult = await setFilesOnUpload(
        {
          page,
          // Read-only, so it runs ahead of the kill switch and the export
          // gate, which stay the last reads before the files are set.
          confirmBeforeAttempt: () => confirmFreshCncUploadSurface(page, runDir),
        },
        uploadFiles,
        async () => {
          await input.providerKillSwitchCheckpoint?.("before_upload");
          await input.beforeProviderDisclosure?.();
        },
      );
      uploadSelector = uploadResult.selector;
      await appendArtifacts(artifacts, page, runDir, "uploaded");
      await detectBlockingState(page, runDir);

      await waitForTerminalQuoteOutcome(
        page,
        Math.max(this.config.browserTimeoutMs, POST_UPLOAD_ANALYSIS_TIMEOUT_MS),
        runDir,
        "post_upload",
      );
      uploadProvenance = {
        uploadSelector: uploadResult.selector,
        observedProcessBeforeUpload: uploadResult.confirmation?.observedProcessBeforeUpload ?? null,
        createdQuotePath: await confirmQuoteCreatedFromUpload(page, runDir),
      };
      await appendArtifacts(artifacts, page, runDir, "analysis-complete");
      // OVD-722: overlay close clicks follow a long poll; read the switch first.
      await input.providerKillSwitchCheckpoint?.("before_configure");
      await dismissOverlayModals(page);
    }

    // OVD-1053 round 4: a run that uploaded nothing never configures or prices
    // the page it landed on. Before this, a landing page that already showed a
    // quote skipped the upload and published that quote's price.
    if (!uploadProvenance) {
      throw await uploadSurfaceNotFreshError(page, runDir, "before_process_selection");
    }

    // Configuration edits the provider-side quote this run's upload created.
    await input.providerKillSwitchCheckpoint?.("before_configure");
    markProviderMutationStarted();
    // Round 8 (H1): from here every click and the quantity fill is a
    // configuration action; the price published must have updated after the
    // last one (see advanceFictivSettle).
    const actionTracker = startConfigurationActionTracker(page, normalizedQuantity(input));
    const openedConfigurationDrawer = await openConfigurationDrawerIfPresent(page);
    const processChosen = (await trySelectCncProcess(page, async () =>
      input.providerKillSwitchCheckpoint?.("before_configure"),
    )) ?? selectedProcessBeforeUpload;
    // OVD-722: fresh read before each configuration step, not only the first.
    await input.providerKillSwitchCheckpoint?.("before_configure");
    const quantitySelector = await setQuantity(page, normalizedQuantity(input), async () =>
      input.providerKillSwitchCheckpoint?.("before_configure"),
    );
    await input.providerKillSwitchCheckpoint?.("before_configure");
    const selectionResult = await trySetMaterialAndFinish(
      page,
      materialTerms,
      finishTerms,
      async () => input.providerKillSwitchCheckpoint?.("before_configure"),
    );
    await input.providerKillSwitchCheckpoint?.("before_configure");
    const endUseSelection = await trySetEndUsePrototype(page, async () =>
      input.providerKillSwitchCheckpoint?.("before_configure"),
    );

    await page.waitForLoadState("networkidle").catch(() => undefined);
    await detectBlockingState(page, runDir);
    await appendArtifacts(artifacts, page, runDir, "configured");
    const terminalOutcome = await waitForTerminalQuoteOutcome(
      page,
      this.config.browserTimeoutMs,
      runDir,
      "post_configuration",
      actionTracker,
    );
    const quantityPricing = terminalOutcome.state === "quote_ready"
      ? await waitForRequestedQuantityPriced(
          page,
          normalizedQuantity(input),
          quantitySelector,
          actionTracker,
          this.config.browserTimeoutMs,
          runDir,
        )
      : null;

    return {
      uploadSelector,
      processChosen,
      uploadProvenance,
      selectedEndUse: endUseSelection.selectedEndUse,
      selectedEndUseSource: endUseSelection.selectedEndUseSource,
      quantitySelector,
      quantityPricing,
      openedConfigurationDrawer,
      materialOptionChosen: selectionResult.selectedMaterial,
      finishOptionChosen: selectionResult.selectedFinish,
      terminalOutcome,
    };
  }

  private async extractQuoteData(page: Page, requestedQuantity: number): Promise<FictivParsedQuote> {
    await page
      .locator(
        [
          '[data-test-target="quote-level-lead-time-price-selected"]',
          '[data-test-target="quote-level-lead-time-selected-option"]',
        ].join(", "),
      )
      .first()
      .waitFor({ state: "attached", timeout: this.config.browserTimeoutMs })
      .catch(() => undefined);
    await dismissAutoConfigLoadingModal(page).catch(ignoreUnlessRunStop);

    const bodyText = await readBodyText(page);
    // G3: the lead-time reading carries the page's pricing context, which the
    // selected price is read under too.
    const leadTimes = await extractLeadTimeOptions(page, requestedQuantity);
    const readPrice = (text: string, selector: string | null) =>
      selector === null || selector === "body"
        ? readFictivPrice(text, false, null)
        : readFictivPrice(text, selector === SELECTED_OPTION_PRICE_SPAN, leadTimes.context);
    const priceResult = await extractParsedValue(
      page,
      FICTIV_LOCATORS.selectedPriceText,
      (text, selector) => {
        const reading = readPrice(text, selector);
        return isVerifiedUsdTotal(reading) ? reading.amount : null;
      },
      bodyText,
      parseFirstCurrency,
    );
    const leadTimeResult = await extractParsedValue(
      page,
      FICTIV_LOCATORS.leadTimeText.slice(0, 2),
      parseLeadTime,
      bodyText,
    );
    const manualReviewResult = await detectManualReview(page, bodyText);
    // Withhold any price that no declared locator anchored; see gateVendorPrice.
    const priceGate = gateVendorPrice(priceResult);
    const priceReading = readPrice(priceResult.text, priceResult.selector);

    return {
      bodyText,
      totalPrice: priceGate.trusted && isVerifiedUsdTotal(priceReading) ? priceResult.value : null,
      priceText: priceResult.source === "selector" ? priceResult.text : null,
      leadTime: gateLeadTime(leadTimeResult, priceGate),
      manualReview: manualReviewResult.manualReview || priceGate.locatorDriftDetected,
      manualReviewSelector: manualReviewResult.selector,
      priceSource: priceResult.source,
      priceSelector: priceResult.selector,
      priceObserved: priceResult.value !== null,
      priceCurrency: priceReading.currency,
      priceCurrencySource: priceReading.currencySource,
      priceBasis: priceReading.basis,
      leadTimeSource: leadTimeResult.source,
      leadTimeSelector: leadTimeResult.selector,
      priceGate,
      leadTimes,
    };
  }

  private resolveResultClassification(
    outcome: FictivTerminalOutcome,
    parsed: FictivParsedQuote,
  ): FictivResultClassification {
    if (outcome.state === "capability_limited") {
      return "capability_limited";
    }

    if (outcome.state === "configuration_required") {
      return "configuration_required";
    }

    if (outcome.state === "manual_review" || parsed.manualReview) {
      return "manual_review";
    }

    return "instant_quote";
  }

  /**
   * OVD-1052 round 8 (H3): before any price check, the selected option must
   * show at most one price of its own. With two selected options, two price
   * spans or two amounts in it, the first one read is not known to be the
   * selected price, so the run stops as selected_offer_ambiguous instead of
   * publishing it. (planFictivOffers checks every later reading again.)
   */
  private async ensureSelectedOfferUnambiguous(page: Page, runDir: string, parsed: FictivParsedQuote) {
    const offer = parsed.leadTimes.selectedOffer;
    if (!isSelectedOfferAmbiguous(offer)) {
      return;
    }

    throw new VendorAutomationError(
      "Fictiv's selected lead-time option shows more than one price, so no price is published.",
      "unexpected_ui_state",
      {
        vendor: "fictiv",
        terminalState: "selector_drift",
        reason: "selected_offer_ambiguous",
        detectedFlow: "instant_quote",
        selectedOptionCount: offer.optionCount,
        selectedOptionPriceSpanCount: offer.priceSpanCount,
        selectedOptionAmountCount: offer.amounts.length,
        url: page.url(),
      },
      await capturePageArtifacts(page, runDir, "selected-offer-ambiguous").catch(() => []),
    );
  }

  /**
   * OVD-1053 round 5 (F14): the selected price must be an anchored, verified
   * USD total above zero. A $0.00 total is not a quote; it fails closed.
   */
  private async ensureInstantQuoteHasPrice(
    totalPrice: number | null,
    page: Page,
    runDir: string,
    selection: FictivLiveSelection,
    parsed: FictivParsedQuote,
  ) {
    if (totalPrice !== null && Number.isFinite(totalPrice) && totalPrice > 0) {
      return;
    }

    let reason = "selected_price_missing";
    if (totalPrice !== null) {
      reason = "selected_price_not_positive";
    } else if (!parsed.priceObserved) {
      // "$ --", or no selected price at all: nothing to verify.
      reason = "selected_price_missing";
    } else if (parsed.priceCurrency === null) {
      reason = "price_currency_unverified";
    } else if (parsed.priceBasis !== "total") {
      reason = "price_basis_unverified";
    }

    throw new VendorAutomationError(
      totalPrice === null
        ? "Fictiv quote page did not expose an anchored price with verified USD currency after configuration."
        : "Fictiv quote page showed a selected total that is not above zero, so no price is published.",
      "unexpected_ui_state",
      {
        vendor: "fictiv",
        terminalState: "selector_drift",
        reason,
        uploadSelector: selection.uploadSelector,
        materialOptionChosen: selection.materialOptionChosen,
        finishOptionChosen: selection.finishOptionChosen,
        selectedEndUse: selection.selectedEndUse,
        quantitySelector: selection.quantitySelector,
        priceSource: parsed.priceSource,
        priceSelector: parsed.priceSelector,
        priceCurrency: parsed.priceCurrency,
        priceBasis: parsed.priceBasis,
        pricingContext: pricingContextEvidence(parsed.leadTimes.context),
        leadTimeSource: parsed.leadTimeSource,
        manualReviewSelector: parsed.manualReviewSelector,
        url: page.url(),
        detectedFlow: "instant_quote",
      },
      await capturePageArtifacts(page, runDir, totalPrice === null ? "missing-price" : "non-positive-price"),
    );
  }

  /**
   * OVD-1053 round 4, and round 5 (F13): the result is read from the quote
   * this run's upload created (see FictivUploadProvenance), still open after
   * configuration, and that quote's URL is the only one published. A page
   * showing any other quote fails closed, whether or not it is priced.
   */
  private async ensureOnCreatedQuote(
    page: Page,
    runDir: string,
    selection: FictivLiveSelection,
    classification: FictivResultClassification,
  ) {
    const provenance = selection.uploadProvenance;
    if (quotePagePath(page.url()) === provenance.createdQuotePath) {
      return createdQuoteUrl(provenance);
    }

    const priced = classification === "instant_quote";
    throw new VendorAutomationError(
      priced
        ? "Fictiv price is not on the quote this run's upload created."
        : "Fictiv result is not on the quote this run's upload created.",
      "unexpected_ui_state",
      {
        vendor: "fictiv",
        terminalState: "selector_drift",
        reason: priced ? "price_page_not_created_quote" : "result_page_not_created_quote",
        detectedFlow: priced ? "instant_quote" : "configuration_complete",
        resultClassification: classification,
        uploadSelector: provenance.uploadSelector,
        observedProcessBeforeUpload: provenance.observedProcessBeforeUpload,
        url: page.url(),
      },
      await capturePageArtifacts(page, runDir, priced ? "price-provenance-unconfirmed" : "result-provenance-unconfirmed")
        .catch(() => []),
    );
  }

  /**
   * OVD-1053 round 5 (F11): before any price is published, the priced quote
   * page itself must show CNC Machining, the requested material and the
   * requested finish (see readPartConfiguration). A page that does not show
   * them readably stops as selector drift; one that shows another
   * configuration stops as configuration required. Neither publishes a price.
   */
  private async ensureConfigurationReadBack(
    page: Page,
    runDir: string,
    input: VendorQuoteAdapterInput,
    configuration: FictivConfigurationReadback,
  ) {
    if (!configuration.labels) {
      throw new VendorAutomationError(
        "Fictiv's priced quote did not show its process, material and finish readably, so no price is published.",
        "unexpected_ui_state",
        {
          vendor: "fictiv",
          terminalState: "selector_drift",
          reason: "configuration_readback_unreadable",
          detectedFlow: "instant_quote",
          configurationReadback: configurationReadbackEvidence(configuration, null),
          url: page.url(),
        },
        await capturePageArtifacts(page, runDir, "configuration-readback-unreadable").catch(() => []),
      );
    }

    const mismatchedFields = configurationMismatches(configuration.labels, input);
    if (mismatchedFields.length === 0) {
      return;
    }

    throw new VendorAutomationError(
      "Fictiv's priced quote shows a configuration other than the one requested, so no price is published.",
      "unexpected_ui_state",
      {
        vendor: "fictiv",
        terminalState: "configuration_required",
        reason: "configuration_readback_mismatch",
        detectedFlow: "configuration_required",
        mismatchedFields,
        configurationReadback: configurationReadbackEvidence(configuration, null),
        url: page.url(),
      },
      await capturePageArtifacts(page, runDir, "configuration-readback-mismatch").catch(() => []),
    );
  }

  /**
   * OVD-1053 round 5: the price published is the one the quote settled on with
   * the requested quantity (see waitForRequestedQuantityPriced), still shown
   * after every other readback. A selected price that changed since it
   * settled, or that differs from the price extracted, is a reprice still in
   * flight: nothing is published.
   */
  private async ensureSettledPriceStillShown(
    page: Page,
    runDir: string,
    selection: FictivLiveSelection,
    parsed: FictivParsedQuote,
  ) {
    const settled = selection.quantityPricing?.settledPrice ?? null;
    // G2: a reprice indicator at publish time means the price is changing again.
    const repriceIndicator = await visibleRepriceIndicator(page);
    const shown = await readSelectedPriceSnapshot(page);
    const extractedNow = parsed.priceSelector ? await firstWorkingText(page, [parsed.priceSelector]) : null;
    // Round 8 (H1): an action after the settle (the auto configuration
    // Continue while the price was extracted) voids it.
    const actionsNow = configurationActionTrackers.get(page)?.evidence.actionCount ?? null;
    const actionAfterSettle = actionsNow !== (selection.quantityPricing?.settledAtAction ?? null);
    const unchanged = settled !== null
      && !actionAfterSettle
      && repriceIndicator === null
      && shown !== null
      && shown.selector === settled.selector
      && shown.text === settled.text
      && parseFirstCurrency(settled.text) === parsed.totalPrice
      && parsed.priceText !== null
      && extractedNow?.text === parsed.priceText;
    if (unchanged) {
      return;
    }

    throw new VendorAutomationError(
      "Fictiv's selected price changed after the quote settled, so no price is published.",
      "unexpected_ui_state",
      {
        vendor: "fictiv",
        terminalState: "configuration_required",
        reason: actionAfterSettle
          ? "configuration_action_after_settle"
          : repriceIndicator === null ? "price_changed_after_settle" : "reprice_indicator_at_publish",
        detectedFlow: "configuration_required",
        repriceIndicator,
        settledPriceSelector: settled?.selector ?? null,
        shownPriceSelector: shown?.selector ?? null,
        priceSelector: parsed.priceSelector,
        url: page.url(),
      },
      await capturePageArtifacts(page, runDir, "price-unsettled").catch(() => []),
    );
  }

  /**
   * OVD-1053 round 6 (F19, F21): re-reads the lead-time panel at publish
   * time and publishes only what planFictivOffers confirms. Every refusal it
   * returns stops the run here; nothing is published. (Round 5's checks for
   * an empty offer list, a selected offer out of first place, or an offer off
   * the created quote could not fail: buildFictivOffers always puts the
   * selected price first on the created quote's URL. They are gone.)
   */
  private async ensurePublishableOffers(
    page: Page,
    runDir: string,
    input: VendorQuoteAdapterInput,
    selection: FictivLiveSelection,
    parsed: FictivParsedQuote,
    quoteUrl: string,
  ) {
    const plan = planFictivOffers({
      settled: selection.quantityPricing?.settledLeadTimes ?? null,
      extracted: parsed.leadTimes,
      atPublish: await extractLeadTimeOptions(page, normalizedQuantity(input)),
      quantity: normalizedQuantity(input),
      quoteUrl,
      selected: {
        totalPrice: parsed.totalPrice,
        leadTime: parsed.leadTime,
        priceSelector: parsed.priceSelector,
        leadTimeSource: parsed.leadTimeSource,
      },
    });
    if (plan.publish) {
      return plan;
    }

    throw new VendorAutomationError(
      "Fictiv's selected lead-time option could not be confirmed as offered at the selected price, so no price is published.",
      "unexpected_ui_state",
      {
        vendor: "fictiv",
        terminalState: plan.terminalState,
        reason: plan.reason,
        detectedFlow: plan.terminalState === "configuration_required" ? "configuration_required" : "instant_quote",
        selectedOption: plan.selectedIdentity,
        withheldLeadTimeOptions: plan.withheld,
        url: page.url(),
      },
      await capturePageArtifacts(page, runDir, "offers-unpublishable").catch(() => []),
    );
  }

  /**
   * Fails closed before any price or offer is published unless Fictiv's own
   * quantity control and quantity displays read the requested quantity on the
   * settled, priced quote (see waitForRequestedQuantityPriced and
   * readBackQuantity) and still read it now, after the price was extracted. The stop is a configuration_required terminal state:
   * Fictiv's quote is not configured for the requested quantity, as far as
   * the page shows.
   */
  private async ensureRequestedQuantityConfirmed(
    page: Page,
    runDir: string,
    input: VendorQuoteAdapterInput,
    selection: FictivLiveSelection,
  ) {
    const requestedQuantity = normalizedQuantity(input);
    const settled = selection.quantityPricing?.readback ?? UNREAD_QUANTITY;
    const readback = settled.confirmed ? await readBackQuantity(page, requestedQuantity) : settled;
    if (readback.confirmed) {
      return readback;
    }

    throw new VendorAutomationError(
      readback.reason === "quantity_mismatch"
        ? "Fictiv quote quantity does not match the requested quantity."
        : "Fictiv quote quantity could not be confirmed before price capture.",
      "unexpected_ui_state",
      {
        vendor: "fictiv",
        terminalState: "configuration_required",
        reason: readback.reason,
        detectedFlow: "configuration_required",
        requestedQuantity,
        observedQuantities: readback.values,
        observedQuantityControls: readback.controlReadings,
        quantityReadbackSource: readback.source,
        quantityReadbackSelector: readback.selector,
        quantityControlSelector: readback.controlSelector,
        quantitySelector: selection.quantitySelector,
        repriceSettle: selection.quantityPricing?.settle ?? null,
        url: page.url(),
      },
      // A failed capture must not turn this stop into a generic navigation failure.
      await capturePageArtifacts(page, runDir, "quantity-unconfirmed").catch(() => []),
    );
  }

  /**
   * OVD-611: Traces hold unredacted DOM snapshots and request headers, so the
   * recording is stopped without a path: discarded, never written or uploaded.
   */
  private async stopTraceDiscarding(browserContext: BrowserContext) {
    if (!this.config.playwrightCaptureTrace) {
      return false;
    }

    await browserContext.tracing.stop();
    return true;
  }

  private async cleanupLiveSession(
    browserContext: BrowserContext | null,
    browser: Browser | null,
    traceStopped: boolean,
  ) {
    if (browserContext) {
      if (this.config.playwrightCaptureTrace && !traceStopped) {
        await browserContext.tracing.stop().catch(() => undefined);
      }

      await browserContext.close().catch(() => undefined);
    }

    await browser?.close().catch(() => undefined);
  }

  private rethrowLiveError(
    error: unknown,
    detectedFlow: FictivDetectedFlow,
    uploadSelector: string | null,
    selectedProcess: string | null,
    selectedMaterial: string | null,
    selectedFinish: string | null,
    selectedEndUse: string | null,
    selectedEndUseSource: FictivEndUseSource | null,
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
        selectedProcess,
        selectedMaterial,
        selectedFinish,
        selectedEndUse,
        selectedEndUseSource,
      },
      artifacts,
    );
  }

  private mergeVendorErrorArtifacts(
    error: VendorAutomationError,
    artifacts: VendorArtifact[],
  ): VendorAutomationError {
    return new VendorAutomationError(
      error.message,
      error.code,
      error.payload,
      [...artifacts, ...error.artifacts],
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
    let selectedProcess: string | null = null;
    let selectedMaterial: string | null = null;
    let selectedFinish: string | null = null;
    let selectedEndUse: string | null = null;
    let selectedEndUseSource: FictivEndUseSource | null = null;

    try {
      const session = await this.startLiveSession(prerequisites);
      browser = session.browser;
      browserContext = session.browserContext;
      const page = session.page;
      if (input.providerKillSwitchCheckpoint) {
        const checkpoint = input.providerKillSwitchCheckpoint;
        autoConfigContinueCheckpoints.set(page, () => checkpoint("before_configure"));
      }
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
      selectedEndUse = selection.selectedEndUse;
      selectedEndUseSource = selection.selectedEndUseSource;
      detectedFlow = "configuration_complete";

      const parsed = await this.extractQuoteData(page, normalizedQuantity(input));
      const totalPrice = parsed.totalPrice;
      const leadTime = parsed.leadTime;
      const priceSource = parsed.priceSource;
      const leadTimeSource = parsed.leadTimeSource;
      const bodyText = parsed.bodyText;
      const portalStateSignal = selection.terminalOutcome.matchedSignal;
      const resultClassification = this.resolveResultClassification(selection.terminalOutcome, parsed);
      const isInstantQuote = resultClassification === "instant_quote";

      // OVD-1053 round 5 (F11, F12): what the quote page itself shows, read
      // after the price; the published process, material and finish come from
      // here, never from what the adapter clicked or the pre-upload card.
      const configurationReadback = await readPartConfiguration(page);
      selectedProcess = configurationEvidenceLabel(configurationReadback.labels?.process);
      selectedMaterial = configurationEvidenceLabel(configurationReadback.labels?.material);
      selectedFinish = configurationEvidenceLabel(configurationReadback.labels?.finish);
      // F13: the only quote URL published is the created quote's.
      const quoteUrl = await this.ensureOnCreatedQuote(page, runDir, selection, resultClassification);

      let quantityReadback: FictivQuantityReadback | null = null;
      let offers: VendorQuoteAdapterOffer[] = [];
      let withheldLeadTimeOptions: FictivWithheldLeadTimeOption[] = [];
      if (isInstantQuote) {
        detectedFlow = "instant_quote";
        await this.ensureSelectedOfferUnambiguous(page, runDir, parsed);
        await this.ensureInstantQuoteHasPrice(totalPrice, page, runDir, selection, parsed);
        await this.ensureConfigurationReadBack(page, runDir, input, configurationReadback);
        quantityReadback = await this.ensureRequestedQuantityConfirmed(page, runDir, input, selection);
        await this.ensureSettledPriceStillShown(page, runDir, selection, parsed);
        // Last read before anything is published (F19).
        ({ offers, withheld: withheldLeadTimeOptions } = await this.ensurePublishableOffers(
          page,
          runDir,
          input,
          selection,
          parsed,
          quoteUrl,
        ));
      } else if (resultClassification === "configuration_required") {
        detectedFlow = "configuration_required";
      } else {
        detectedFlow = "manual_review";
      }

      await appendArtifacts(artifacts, page, runDir, "result");
      traceStopped = await this.stopTraceDiscarding(browserContext);
      const unitPriceUsd =
        !isInstantQuote || totalPrice === null
          ? null
          : Math.round((totalPrice / normalizedQuantity(input)) * 100) / 100;
      const status = isInstantQuote ? "instant_quote_received" : "manual_review_pending";
      let notes: string[];
      if (parsed.priceGate.locatorDriftDetected) {
        notes = [UNANCHORED_PRICE_NOTE];
        console.warn(
          JSON.stringify({
            service: "overdrafter-cad-worker",
            level: "warn",
            source: "vendor.locator_drift",
            message:
              "Fictiv price locators all missed; withheld an unanchored price and routed the lane to manual review.",
            context: {
              vendor: "fictiv",
              partId: input.part.id,
              quoteRunId: input.quoteRunId,
              unanchoredPriceObservedUsd: parsed.priceGate.unanchoredPriceUsd,
              url: quoteUrl,
            },
          }),
        );
      } else if (resultClassification === "manual_review") {
        notes = ["Fictiv flagged the part for manual review after upload and configuration."];
      } else if (resultClassification === "configuration_required") {
        notes = ["Fictiv requires additional configuration before an instant quote can be generated."];
      } else if (resultClassification === "capability_limited") {
        notes = [
          "Fictiv account capability limitations prevented an instant CNC quote; manual review is required.",
        ];
      } else {
        notes = ["Live Fictiv quote captured via Playwright."];
      }

      if (portalStateSignal && !isInstantQuote) {
        notes.push(`Portal signal: ${portalStateSignal}`);
      }

      let priceGateReason: string = parsed.priceGate.reason;
      if (parsed.priceGate.trusted && parsed.priceBasis !== "total") {
        priceGateReason = "price_basis_unknown";
      } else if (parsed.priceGate.trusted && parsed.priceCurrency === null) {
        priceGateReason = "currency_unknown";
      }

      return {
        vendor: "fictiv",
        status,
        unitPriceUsd,
        totalPriceUsd: isInstantQuote ? totalPrice : null,
        leadTimeBusinessDays: isInstantQuote ? leadTime : null,
        quoteUrl,
        dfmIssues: [],
        notes,
        artifacts,
        offers,
        rawPayload: buildRawPayload({
          detectedFlow,
          uploadSelector,
          selectedProcess,
          selectedMaterial,
          selectedFinish,
          selectedEndUse,
          selectedEndUseSource,
          materialOptionChosen: selection.materialOptionChosen,
          finishOptionChosen: selection.finishOptionChosen,
          configurationReadback: configurationReadbackEvidence(configurationReadback, quantityReadback),
          quantitySelector: selection.quantitySelector,
          quantityReadbackSource: quantityReadback?.source ?? null,
          quantityReadbackSelector: quantityReadback?.selector ?? null,
          quantityControlSelector: quantityReadback?.controlSelector ?? null,
          quantityControlReadings: quantityReadback?.controlReadings ?? [],
          observedProcessBeforeUpload: selection.uploadProvenance.observedProcessBeforeUpload,
          openedConfigurationDrawer: selection.openedConfigurationDrawer,
          priceSource,
          priceCurrency: parsed.priceCurrency,
          priceCurrencySource: parsed.priceCurrencySource,
          priceBasis: parsed.priceBasis,
          pricingContext: pricingContextEvidence(parsed.leadTimes.context),
          repriceSettle: selection.quantityPricing?.settle ?? null,
          leadTimeSource,
          ...priceGateEvidence(parsed.priceGate),
          priceTrusted: parsed.priceGate.trusted
            && parsed.priceCurrency === "USD"
            && parsed.priceBasis === "total",
          priceGateReason,
          resultClassification,
          portalStateSignal,
          bodyExcerpt: excerptText(bodyText),
          requestedQuantity: input.requestedQuantity,
          url: quoteUrl,
          source: "fictiv-live-adapter",
          leadTimeOptions: parsed.leadTimes.options.map(({ rawText: _rawText, ...option }) => option),
          withheldLeadTimeOptions,
        }),
      };
    } catch (error) {
      if (browserContext && this.config.playwrightCaptureTrace && !traceStopped) {
        traceStopped = await this.stopTraceDiscarding(browserContext).catch(() => false);
      }

      if (isDispatchDecisionError(error)) {
        throw error;
      }

      // OVD-722: a kill-switch refusal is surfaced as-is, never as a provider failure.
      if (error instanceof ProviderKillSwitchError) throw error;
      if (error instanceof VendorAutomationError) {
        throw this.mergeVendorErrorArtifacts(error, artifacts);
      }

      this.rethrowLiveError(
        error,
        detectedFlow,
        uploadSelector,
        selectedProcess,
        selectedMaterial,
        selectedFinish,
        selectedEndUse,
        selectedEndUseSource,
        artifacts,
      );
    } finally {
      await this.cleanupLiveSession(browserContext, browser, traceStopped);
    }
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.simulateQuote(input);
    }

    try {
      if (input.executionContext === "live_evaluation" && !getAuthorizedLiveEvaluationFiles(input)) {
        throw new VendorAutomationError(
          "Live Fictiv evaluation requires the exact authorized CAD and drawing bytes.",
          "unexpected_ui_state",
          {
            vendor: "fictiv",
            reason: "evaluation_export_control_authorization_missing",
            terminalState: "unsupported",
          },
        );
      }

      if (input.executionContext !== "live_evaluation") {
        const denial = fictivDispatchAuthorizationDenial(input);
        if (denial) {
          throw new VendorAutomationError(
            "Live Fictiv automation requires a current exact-scope provider dispatch authorization.",
            "unexpected_ui_state",
            {
              vendor: "fictiv",
              reason: denial,
              terminalState: "unsupported",
              providerInteractionAttempted: false,
            },
          );
        }
      }

      const termResolution = this.resolveLiveTerms(input);
      if (termResolution.kind === "manual_followup") {
        return termResolution.output;
      }

      const prerequisites = this.ensureLivePrerequisites(input);
      return await this.quoteLive(input, termResolution.terms, prerequisites);
    } catch (error) {
      if (!(error instanceof VendorAutomationError)) {
        throw error;
      }
      throw new VendorAutomationError(
        error.message,
        error.code,
        {
          ...error.payload,
          terminalState: error.payload.terminalState ?? finiteFictivFailureState(error.code),
        },
        error.artifacts,
      );
    }
  }
}
