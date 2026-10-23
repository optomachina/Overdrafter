import type { Locator, Page } from "patchright";
import {
  VendorAutomationError,
  type GeographicOrigin,
  type VendorQuoteAdapterOffer,
} from "../types.js";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { XOMETRY_LOCATORS } from "./xometryConstraints.js";
import {
  createXometryQuoteObservation,
  notifyXometryObserver,
  unavailableXometryObservation,
  XOMETRY_OBSERVATION_LIMITS,
  type XometryProviderObserver,
  type XometryPresentationObservation,
  type XometryQuoteDocument,
} from "../jev/providerObservations.js";

const observedPresentation = new WeakSet<object>();
const observedQuoteDocuments = new WeakSet<object>();
const presentationParents = new WeakMap<object, XometryQuoteDocument>();

/** Only the actual collector can create this local origin; caller-assigned
 * labels/categories and deserialized lookalikes do not establish it. */
export function isObservedXometryPresentation(value: unknown): value is XometryPresentationObservation {
  return typeof value === "object" && value !== null && observedPresentation.has(value);
}

/** Pure factories and copied/deserialized documents cannot establish actual
 * collector provenance, even if their text, IDs and attributes are identical. */
export function isObservedXometryQuoteDocument(value: unknown): value is XometryQuoteDocument {
  return typeof value === "object" && value !== null && observedQuoteDocuments.has(value);
}

/** An ordinal parent ID is scoped to one observation. Bind optional evidence to
 * its exact complete source document, never another matching ID or substring. */
export function doesObservedXometryPresentationBelongToDocument(badge: unknown, document: unknown): boolean {
  return isObservedXometryPresentation(badge)
    && isObservedXometryQuoteDocument(document)
    && presentationParents.get(badge) === document;
}

export type XometryOfferSnapshot = {
  selector: string;
  text: string;
  tierText?: string;
  /**
   * OVD-1052: text of the struck-through list amount the card renders in
   * [data-testid="part-discount"] (its <span>, before the "(Save $X)" note).
   * Absent when the card has no such slot.
   */
  listPriceText?: string;
  attributes: Record<string, string>;
};

const SNAPSHOT_ATTRIBUTES = [
  "data-option-id",
  "data-tier-id",
  "data-testid",
  "value",
  "id",
  "aria-label",
  "disabled",
  "aria-disabled",
  "data-disabled",
  "data-available",
] as const;

const PROVIDER_ID_ATTRIBUTES = ["data-option-id", "data-tier-id", "value", "id"] as const;

function normalizedSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "")
    .slice(0, 120);
}

function parseCurrencyValue(value: string) {
  const parsed = Number.parseFloat(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** USD-only offer fields require currency evidence on every anchored amount.
 * A bare `$` amount is USD only when the provider manifest's reviewed quote
 * currency is USD; any explicit or conflicting marker still decides first.
 * Foreign/ambiguous observations stay in error evidence, never USD comparisons.
 */
const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));
const DOLLAR_AMOUNT_SOURCE = String.raw`\$\s*([\d,]+(?:\.\d{2})?)`;
const USD_CODE_AMOUNT_SOURCE = String.raw`\bUSD[^\S\r\n]*([\d,]+(?:\.\d{2})?)`;
/** Savings/discount amounts are not offer prices; drop them before anchoring. */
const SAVINGS_AMOUNT = /\b(?:you\s+)?sav(?:e|es|ing|ings)\b[^\S\r\n]*(?:of\s*)?(?:\$|USD)[^\S\r\n]*[\d,]+(?:\.\d{2})?|(?:\$|USD)[^\S\r\n]*[\d,]+(?:\.\d{2})?[^\S\r\n]*off\b/gi;
function withoutSavings(text: string) {
  return text.replace(SAVINGS_AMOUNT, "");
}
/** One shown amount: `$146.80`, `USD $146.80` or `USD 146.80`. */
const PRICE_TOKEN_SOURCE = String.raw`(?:\bUSD[^\S\r\n]*\$?|\$)[^\S\r\n]*([\d,]+(?:\.\d{2})?)`;
/**
 * A savings figure ("Save $45.55", "You save USD $45.55", "Savings: $45.55",
 * "$45.55 off"). It is never an offer price; a "(" before it marks the note
 * Xometry renders after a struck-through list total.
 */
const SAVINGS_FIGURE_SOURCE = String.raw`\b(?:you[^\S\r\n]+)?sav(?:e|es|ing|ings)\b[^\S\r\n]*(?:of[^\S\r\n]*|:[^\S\r\n]*)?${PRICE_TOKEN_SOURCE}|${PRICE_TOKEN_SOURCE}[^\S\r\n]*off\b`;

/** Exact cents for a matched `1,234.56` amount; float parsing never decides equality. */
function amountCents(value: string | undefined) {
  const [whole = "", fraction = "00"] = (value ?? "").replaceAll(",", "").split(".");
  if (!/^\d+$/.test(whole)) return null;
  const cents = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) ? cents : null;
}

function shownAmountCents(text: string) {
  return [...text.matchAll(new RegExp(PRICE_TOKEN_SOURCE, "g"))].map((match) => amountCents(match[1]));
}

export type XometryDiscountFailure =
  | "savings_ambiguous"
  | "list_price_ambiguous"
  | "list_price_unreconciled"
  | "current_total_mismatch";

type DiscountReconciliation =
  | { ok: true; text: string; currentTotalCents: number | null }
  | { ok: false; failure: XometryDiscountFailure };

/**
 * OVD-1052: a discounted Xometry tier shows its current total beside a
 * struck-through list total and a savings note. On the captured quote page
 * the list total is the <span> in [data-testid="part-discount"], followed by
 * its note ("$146.80 (Save $45.55)" beside the current "$101.25"), but text
 * order alone cannot say which amount the note belongs to. The list total is
 * the DOM's part-discount amount when the collector read one, otherwise the
 * one shown amount that sits exactly the savings above another shown amount.
 * It is removed, and the caller requires the parsed total to equal list minus
 * savings to the cent. Every other combination fails closed instead of risking
 * the list total as the price. A standalone savings figure that matches no
 * list amount is only dropped, as before.
 */
function reconcileDiscount(rawText: string, listPriceText: string | undefined): DiscountReconciliation {
  const savings = [...rawText.matchAll(new RegExp(SAVINGS_FIGURE_SOURCE, "gi"))];
  const text = rawText.replace(new RegExp(SAVINGS_FIGURE_SOURCE, "gi"), "");
  if (savings.length === 0 && listPriceText === undefined) {
    return { ok: true, text, currentTotalCents: null };
  }
  const savingsCents = new Set(savings.map((match) => amountCents(match[1] ?? match[2])));
  if (savingsCents.size > 1) return { ok: false, failure: "savings_ambiguous" };
  const [saved = null] = savingsCents;
  if (saved === null || saved <= 0) return { ok: false, failure: "list_price_unreconciled" };
  const notedListPrice = savings.some((match) => /\([^\S\r\n]*$/.test(rawText.slice(0, match.index)));

  const shown = new Set(shownAmountCents(text).filter((cents): cents is number => cents !== null));
  let listCents: number;
  if (listPriceText === undefined) {
    const candidates = [...shown].filter((cents) => shown.has(cents - saved));
    if (candidates.length > 1) return { ok: false, failure: "list_price_ambiguous" };
    if (candidates.length === 0) {
      return notedListPrice
        ? { ok: false, failure: "list_price_unreconciled" }
        : { ok: true, text, currentTotalCents: null };
    }
    listCents = candidates[0];
  } else {
    const domAmounts = shownAmountCents(listPriceText);
    if (domAmounts.length !== 1 || domAmounts[0] === null || !shown.has(domAmounts[0])) {
      return { ok: false, failure: "list_price_unreconciled" };
    }
    listCents = domAmounts[0];
  }
  const currentTotalCents = listCents - saved;
  if (!shown.has(currentTotalCents)) return { ok: false, failure: "list_price_unreconciled" };
  const withoutList = text.replace(
    new RegExp(PRICE_TOKEN_SOURCE, "g"),
    (token, value: string) => amountCents(value) === listCents ? "" : token,
  );
  return { ok: true, text: withoutList, currentTotalCents };
}

/** `$` amounts; symbol-less `USD 41.41` amounts count only when no `$` amount exists. */
function amountSource(text: string) {
  return new RegExp(DOLLAR_AMOUNT_SOURCE).test(text) ? DOLLAR_AMOUNT_SOURCE : USD_CODE_AMOUNT_SOURCE;
}

function currencyEvidence(rawText: string, registryCurrency: string | null) {
  const text = withoutSavings(rawText);
  const observed = new Set<string>();
  const aliases: Record<string, string> = { US: "USD", CA: "CAD", C: "CAD", AU: "AUD", A: "AUD", NZ: "NZD", HK: "HKD", SG: "SGD", S: "SGD" };
  let trusted = true;
  // Explicit declarations belong to the entire option, including a separate line.
  for (const declaration of text.matchAll(/\bcurrency\s*[:=]\s*([^\r\n]+)/gi)) {
    const value = declaration[1].trim();
    const codes = [...value.matchAll(/\b[A-Z]{3}\b/gi)].map((match) => match[0].toUpperCase());
    for (const code of codes) observed.add(code);
    if (value.toUpperCase() !== "USD") {
      trusted = false;
      if (!codes.length) observed.add("unknown");
    }
  }
  const amounts = [...text.matchAll(new RegExp(amountSource(text), "g"))];
  let bareAmountUnverified = false;
  for (const amount of amounts) {
    const start = amount.index ?? 0;
    const prefix = /(?:\b([A-Z]{3})[^\S\r\n]*|\b(US|CA|AU|NZ|HK|SG|C|A|S))$/i.exec(text.slice(0, start));
    const suffix = /^[^\S\r\n]*([A-Z]{3})\b/i.exec(text.slice(start + amount[0].length));
    // Inspect the entire price line for conflicting markers, including USD/CAD
    // and CAD US$ annotations. Three-letter prose is not currency evidence.
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const lineEnd = text.indexOf("\n", start);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    // Case cannot establish currency trust. Scan every recognized code on the
    // price line; only these complete lowercase prose phrases are excluded.
    // This deliberately withholds other ambiguous prose rather than missing CAD.
    const annotationText = line.replace(/\ball (?:taxes|fees) included\b/g, "");
    const lineCodes = [...annotationText.matchAll(/\b[A-Z]{3}\b/gi)]
      .map((match) => match[0].toUpperCase()).filter((code) => CURRENCY_CODES.has(code));
    const tail = text.slice(start + amount[0].length);
    // Lowercase "all taxes/fees included" is prose, not an ALL annotation.
    // An explicit ALL marker (or currency: ALL) still fails closed.
    const proseSuffix = /^\s*all\s+(?:taxes|fees)\s+included\b/.test(tail);
    const suffixCode = !proseSuffix && suffix?.[1] && CURRENCY_CODES.has(suffix[1].toUpperCase()) ? suffix[1] : undefined;
    const prefixCode = prefix?.[1] && CURRENCY_CODES.has(prefix[1].toUpperCase()) ? prefix[1] : undefined;
    const codes = [prefixCode, prefix?.[2], suffixCode].filter((code): code is string => Boolean(code))
      .map((code) => aliases[code.toUpperCase()] ?? code.toUpperCase());
    if (amount[0].startsWith("USD")) codes.push("USD");
    if (!codes.length) {
      if (registryCurrency === "USD") codes.push("USD");
      else { observed.add("unknown"); trusted = false; bareAmountUnverified = true; }
    }
    for (const code of [...codes, ...lineCodes]) { observed.add(code); if (code !== "USD") trusted = false; }
  }
  for (const [symbol, code] of [["€", "EUR"], ["£", "GBP"], ["¥", "JPY_or_CNY"]]) {
    if (text.includes(symbol)) { observed.add(code); trusted = false; }
  }
  // Bare amounts mixed only with USD markers are unverified; foreign markers stay untrusted.
  const unverified = bareAmountUnverified && [...observed].every((code) => code === "USD" || code === "unknown");
  return { trusted: trusted && amounts.length > 0, unverified, observedCurrencies: [...observed] };
}

function parsePrices(rawText: string, requestedQuantity: number) {
  const text = withoutSavings(rawText);
  const source = amountSource(text);
  const currencyMatches = [...text.matchAll(new RegExp(source, "g"))];
  if (currencyMatches.length === 0) return null;

  // Case-insensitive unit suffix without making the USD anchor case-insensitive.
  const unitMatch = new RegExp(String.raw`${source}\s*(?:\/\s*)?[Ee][Aa](?:[Cc][Hh])?\b\.?`).exec(text);
  if (unitMatch?.index !== undefined) {
    const unitPriceUsd = parseCurrencyValue(unitMatch[1]);
    const unitMatchEnd = unitMatch.index + unitMatch[0].length;
    const extendedMatch = currencyMatches.find((match) => (match.index ?? 0) >= unitMatchEnd);
    const totalPriceUsd = extendedMatch ? parseCurrencyValue(extendedMatch[1]) : null;
    if (unitPriceUsd === null || totalPriceUsd === null) return null;
    return { unitPriceUsd, totalPriceUsd, unitPriceExplicit: true };
  }

  if (currencyMatches.length !== 1) return null;
  const totalPriceUsd = parseCurrencyValue(currencyMatches[0][1]);
  if (totalPriceUsd === null) return null;
  return {
    unitPriceUsd: Math.round((totalPriceUsd / requestedQuantity) * 100) / 100,
    totalPriceUsd,
    unitPriceExplicit: false,
  };
}

/**
 * OVD-776: a tier price is only trusted for the requested quantity. Any
 * quantity the option states must match, and total ÷ each must equal the
 * requested quantity within per-piece cent rounding. A lone price without a
 * stated quantity cannot show which quantity it covers unless one piece was
 * requested.
 */
export function xometryOfferQuantityFailure(
  text: string,
  prices: { unitPriceUsd: number; totalPriceUsd: number; unitPriceExplicit: boolean },
  requestedQuantity: number,
): { reason: "quantity_mismatch" | "quantity_unverified"; observedQuantity: number | null } | null {
  const statedQuantities = [
    ...text.matchAll(/\b(?:qty|quantity)\b\s*[:x]?\s*(\d+)\b/gi),
    ...text.matchAll(/\b(\d+)\s*(?:pcs|pieces|parts|units)\b/gi),
  ].map((match) => Number.parseInt(match[1], 10));
  const stated = statedQuantities.find((quantity) => quantity !== requestedQuantity);
  if (stated !== undefined) return { reason: "quantity_mismatch", observedQuantity: stated };

  if (!prices.unitPriceExplicit) {
    return requestedQuantity === 1 || statedQuantities.length > 0
      ? null
      : { reason: "quantity_unverified", observedQuantity: null };
  }
  if (prices.unitPriceUsd <= 0) return { reason: "quantity_unverified", observedQuantity: null };
  const impliedQuantity = prices.totalPriceUsd / prices.unitPriceUsd;
  const roundingToleranceUsd = 0.005 * requestedQuantity + 0.005;
  if (Math.abs(prices.unitPriceUsd * requestedQuantity - prices.totalPriceUsd) > roundingToleranceUsd) {
    return { reason: "quantity_mismatch", observedQuantity: Math.round(impliedQuantity) };
  }
  return null;
}

function parseLeadTime(text: string) {
  const normalizedText = text.trim().replaceAll(/\s+/g, " ").replaceAll(":", "").toLowerCase();
  const match = /\b(\d{1,4}) (?:business|working) days?\b/.exec(normalizedText)
    ?? /\blead time (\d{1,4}) days?\b/.exec(normalizedText);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseArrivalText(text: string) {
  return /\b(?:arrives?|receive(?:d)?|delivery)\s+(?:by|on)\s+([a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i.exec(text)?.[1]
    ?? null;
}

function parseGeographicOrigin(text: string): {
  origin: GeographicOrigin;
  sourcing: string | null;
  source: "provider_text" | "none";
} {
  const domesticPatterns = [
    /\bmade in (?:the )?u\.?s\.?a?\b/i,
    /\bunited states\b/i,
    /\bdomestic\b/i,
    /\bus[- ]only\b/i,
  ];
  const domestic = domesticPatterns.map((pattern) => pattern.exec(text)).find(Boolean) ?? null;
  if (domestic) {
    return { origin: "domestic", sourcing: domestic[0], source: "provider_text" };
  }

  const foreignPatterns = [
    /\bmade internationally(?: except china)?\b/i,
    /\binternational(?:ly)?\b/i,
    /\boverseas\b/i,
    /\bforeign\b/i,
  ];
  const foreign = foreignPatterns.map((pattern) => pattern.exec(text)).find(Boolean) ?? null;
  if (foreign) {
    return { origin: "foreign", sourcing: foreign[0], source: "provider_text" };
  }

  return { origin: "unknown", sourcing: null, source: "none" };
}

const UNAVAILABLE_TEXT_SOURCE = String.raw`\b(?:unavailable|not\s+available|not\s+offered|cannot\s+quote|can't\s+quote)\b`;
/** A class token that styles an element disabled or unavailable ("disabled", "is-unavailable", "tier--disabled"). */
const UNAVAILABLE_CLASS_TOKEN = /^(?:is-)?(?:disabled|unavailable)$|[-_](?:disabled|unavailable)$/i;

function unavailableTextCount(text: string) {
  return [...text.matchAll(new RegExp(UNAVAILABLE_TEXT_SOURCE, "gi"))].length;
}

/**
 * Whether an element is marked unavailable by its own attributes (disabled,
 * aria-disabled, data-disabled, data-available=false), by a class that styles
 * it disabled or unavailable, or by unavailability text.
 */
function isMarkedUnavailable(attributes: Readonly<Record<string, string>>, text: string) {
  return attributes.disabled !== undefined
    || attributes["aria-disabled"]?.toLowerCase() === "true"
    || attributes["data-disabled"]?.toLowerCase() === "true"
    || attributes["data-available"]?.toLowerCase() === "false"
    || (attributes.class ?? "").split(/\s+/).some((token) => UNAVAILABLE_CLASS_TOKEN.test(token))
    || unavailableTextCount(text) > 0;
}

function isExplicitlyUnavailable(snapshot: XometryOfferSnapshot) {
  return isMarkedUnavailable(snapshot.attributes, snapshot.text);
}

/** Collapses spaces, including the no-break space after a tier icon. */
function collapseInlineSpace(value: string) {
  return value.replaceAll(/[^\S\r\n]+/g, " ");
}

/**
 * OVD-1052: Xometry's current tier card names its tier in a header slot that
 * precedes the [data-testid="tierAndLeadTime"] label, and that label now holds
 * only the timing (synthetic fixture values: "Least Expensive" | "Arrives by
 * Nov 3", "Standard" | "Arrives by Nov 6", "Fastest" | "Arrives by Oct 30").
 * The earlier layout put "<Tier> - Lead Time: ..." inside the label itself.
 * The header names the option only when it is one short word label, not a
 * price, timing or sourcing statement; the caller also refuses a header name
 * shared by two cards.
 */
function parseTierHeaderLabel(snapshot: XometryOfferSnapshot) {
  const tierText = collapseInlineSpace(snapshot.tierText ?? "").trim();
  if (!/^(?:lead\s+time|arrives?\s+by)\b/i.test(tierText) || tierText.includes(" - ")) {
    return null;
  }
  const text = collapseInlineSpace(snapshot.text);
  const headerEnd = text.indexOf(tierText);
  if (headerEnd <= 0) return null;
  const segments = text.slice(0, headerEnd).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (segments.length !== 1) return null;
  const [label] = segments;
  if (!/^[A-Za-z][A-Za-z '&/-]{0,39}$/.test(label)) return null;
  return parseGeographicOrigin(label).source === "none" ? label : null;
}

function parseProviderLabel(snapshot: XometryOfferSnapshot, sharedHeaderLabels: ReadonlySet<string>) {
  const lines = [snapshot.tierText ?? "", snapshot.text]
    .flatMap((value) => value.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.lastIndexOf(" - ");
    const timingLabel = separatorIndex >= 0 ? line.slice(separatorIndex + 3).trim() : "";
    const tierLabel = /^(?:lead time|arrives? by)\b/i.test(timingLabel)
      ? line.slice(0, separatorIndex).trim()
      : null;
    const isPresentationBadge = /^(?:least\s+expensive|fastest|best\s+value)$/i.test(
      tierLabel ?? "",
    );
    if (tierLabel && !isPresentationBadge) {
      return tierLabel;
    }
  }

  // A header name that more than one card carries is a presentation badge,
  // not the identity of either option.
  const headerLabel = parseTierHeaderLabel(snapshot);
  if (headerLabel && !sharedHeaderLabels.has(headerLabel.toLowerCase())) {
    return headerLabel;
  }

  for (const line of lines) {
    const knownLabel = /\b(?:(?:domestic|international|overseas)\s+)?(?:economy|standard|expedited|expedite|priority|rush)(?:\s+(?:domestic|international|overseas))?\b/i.exec(line)?.[0];
    if (knownLabel) {
      return knownLabel.trim();
    }
  }

  return null;
}

function quoteReference(quoteUrl: string) {
  return /\bQ\d{2}-[A-Z0-9-]+\b/i.exec(quoteUrl)?.[0] ?? null;
}

function getProviderId(
  snapshot: XometryOfferSnapshot,
  providerLabel: string,
  geographicOrigin: GeographicOrigin,
) {
  for (const attribute of PROVIDER_ID_ATTRIBUTES) {
    const value = snapshot.attributes[attribute];
    if (value) {
      return {
        id: normalizedSlug(value),
        source: "attribute" as const,
      };
    }
  }

  const normalizedLabel = normalizedSlug(providerLabel);
  const labelAlreadyCarriesOrigin = /^(?:domestic|international|overseas|foreign)-/.test(
    normalizedLabel,
  );
  const originPrefix = geographicOrigin === "unknown" || labelAlreadyCarriesOrigin
    ? ""
    : `${geographicOrigin}-`;
  return {
    id: `${originPrefix}${normalizedLabel}`,
    source: "provider_label" as const,
  };
}

/**
 * Normalizes Xometry tier containers without combining fields across options.
 * A discovered container with no anchored price fails the entire result so a
 * partially parsed provider response cannot be presented as complete. Every
 * refusal declares a finite terminal state (OVD-1052), so a drifted quote page
 * stops as selector drift instead of an unclassified adapter failure.
 */
export function parseXometryOfferSnapshots(input: {
  snapshots: XometryOfferSnapshot[];
  requestedQuantity: number;
  quoteUrl: string;
  /** Manifest quote currency; bare `$` amounts fail closed unless it is USD. */
  registryCurrency?: string | null;
}): VendorQuoteAdapterOffer[] {
  const registryCurrency = input.registryCurrency === undefined
    ? PROVIDER_CATALOG.xometry.quoteCurrency
    : input.registryCurrency;
  const availableSnapshots = input.snapshots.filter((snapshot) => !isExplicitlyUnavailable(snapshot));
  const headerLabels = availableSnapshots
    .map((snapshot) => parseTierHeaderLabel(snapshot)?.toLowerCase())
    .filter((label): label is string => Boolean(label));
  const sharedHeaderLabels = new Set(
    headerLabels.filter((label, index) => headerLabels.indexOf(label) !== index),
  );
  const offers = availableSnapshots.map((snapshot, index) => {
    const currency = currencyEvidence(snapshot.text, registryCurrency);
    if (currency.unverified) {
      throw new VendorAutomationError(
        "A Xometry option used bare dollar prices without a USD registry currency.",
        "unexpected_ui_state",
        { vendor: "xometry", reason: "price_currency_unverified", terminalState: "unsupported",
          containerSelector: snapshot.selector, optionIndex: index, registryCurrency,
          observedCurrencies: currency.observedCurrencies,
          providerText: snapshot.text.slice(0, 1000) },
      );
    }
    if (!currency.trusted && currency.observedCurrencies.length > 0) {
      throw new VendorAutomationError(
        "A Xometry option did not establish exclusively USD prices.",
        "unexpected_ui_state",
        { vendor: "xometry", reason: "xometry_offer_currency_untrusted", terminalState: "unsupported",
          containerSelector: snapshot.selector, optionIndex: index,
          observedCurrencies: currency.observedCurrencies,
          providerText: snapshot.text.slice(0, 1000) },
      );
    }
    const discountFailure = (failure: XometryDiscountFailure) => new VendorAutomationError(
      "A Xometry option's list price and savings note did not reconcile to one current total.",
      "selector_failure",
      {
        vendor: "xometry",
        reason: "xometry_offer_discount_unreconciled",
        terminalState: "selector_drift",
        discountFailure: failure,
        containerSelector: snapshot.selector,
        optionIndex: index,
      },
    );
    const discount = reconcileDiscount(snapshot.text, snapshot.listPriceText);
    if (!discount.ok) throw discountFailure(discount.failure);
    const prices = parsePrices(discount.text, input.requestedQuantity);
    if (prices === null) {
      throw new VendorAutomationError(
        "A Xometry option container did not expose an anchored price.",
        "selector_failure",
        {
          vendor: "xometry",
          reason: "xometry_offer_price_missing",
          terminalState: "selector_drift",
          containerSelector: snapshot.selector,
          optionIndex: index,
        },
      );
    }
    const quantityFailure = xometryOfferQuantityFailure(snapshot.text, prices, input.requestedQuantity);
    if (quantityFailure) {
      throw new VendorAutomationError(
        quantityFailure.reason === "quantity_mismatch"
          ? "A Xometry option price is for a different quantity than requested."
          : "A Xometry option price did not establish the requested quantity.",
        "unexpected_ui_state",
        {
          vendor: "xometry",
          reason: quantityFailure.reason,
          terminalState: quantityFailure.reason === "quantity_mismatch" ? "configuration_required" : "selector_drift",
          requestedQuantity: input.requestedQuantity,
          observedQuantity: quantityFailure.observedQuantity,
          observedUnitPriceUsd: prices.unitPriceExplicit ? prices.unitPriceUsd : null,
          observedTotalPriceUsd: prices.totalPriceUsd,
          containerSelector: snapshot.selector,
          optionIndex: index,
        },
      );
    }
    if (
      discount.currentTotalCents !== null
      && Math.round(prices.totalPriceUsd * 100) !== discount.currentTotalCents
    ) {
      throw discountFailure("current_total_mismatch");
    }

    const providerLabel = parseProviderLabel(snapshot, sharedHeaderLabels)
      ?? (availableSnapshots.length === 1 ? "Xometry option" : null);
    if (providerLabel === null) {
      throw new VendorAutomationError(
        "A Xometry option did not expose a stable manufacturing tier.",
        "selector_failure",
        {
          vendor: "xometry",
          reason: "xometry_offer_tier_missing",
          terminalState: "selector_drift",
          containerSelector: snapshot.selector,
          optionIndex: index,
        },
      );
    }
    const geographic = parseGeographicOrigin(snapshot.text);
    const providerId = getProviderId(snapshot, providerLabel, geographic.origin);
    if (!providerId.id) {
      throw new VendorAutomationError(
        "A Xometry option did not expose a stable provider identifier.",
        "selector_failure",
        {
          vendor: "xometry",
          reason: "xometry_offer_identifier_missing",
          terminalState: "selector_drift",
          containerSelector: snapshot.selector,
          optionIndex: index,
        },
      );
    }

    const leadTimeBusinessDays = parseLeadTime(snapshot.text);
    const shipReceiveBy = parseArrivalText(snapshot.text);
    if (leadTimeBusinessDays === null && shipReceiveBy === null) {
      throw new VendorAutomationError(
        "A Xometry option container did not expose an anchored lead or arrival time.",
        "selector_failure",
        {
          vendor: "xometry",
          reason: "xometry_offer_timing_missing",
          terminalState: "selector_drift",
          containerSelector: snapshot.selector,
          optionIndex: index,
        },
      );
    }

    return {
      providerOptionId: providerId.id,
      providerLabel,
      quoteRef: quoteReference(input.quoteUrl),
      quoteUrl: input.quoteUrl,
      unitPriceUsd: prices.unitPriceUsd,
      totalPriceUsd: prices.totalPriceUsd,
      leadTimeBusinessDays,
      shipReceiveBy,
      tier: providerLabel,
      sourcing: geographic.sourcing,
      geographicOrigin: geographic.origin,
      sortRank: index,
      provenance: {
        containerSelector: snapshot.selector,
        providerOptionIdSource: providerId.source,
        priceSource: "selector",
        leadTimeSource: leadTimeBusinessDays === null ? "none" : "selector",
        geographicOriginSource: geographic.source,
      },
      rawPayload: {
        providerText: snapshot.text.slice(0, 1000),
        providerAttributes: snapshot.attributes,
      },
    } satisfies VendorQuoteAdapterOffer;
  });

  const identifiers = new Set<string>();
  for (const offer of offers) {
    if (identifiers.has(offer.providerOptionId)) {
      throw new VendorAutomationError(
        "Xometry returned duplicate provider option identifiers.",
        "unexpected_ui_state",
        {
          vendor: "xometry",
          reason: "duplicate_xometry_offer_identifier",
          terminalState: "selector_drift",
          providerOptionId: offer.providerOptionId,
        },
      );
    }
    identifiers.add(offer.providerOptionId);
  }

  return offers;
}

async function readAttributes(locator: Locator) {
  const entries = await Promise.all(
    SNAPSHOT_ATTRIBUTES.map(async (attribute) => [
      attribute,
      await locator.getAttribute(attribute).catch(() => null),
    ] as const),
  );
  return entries.reduce<Record<string, string>>((attributes, [name, value]) => {
    if (value !== null) {
      attributes[name] = value;
    }
    return attributes;
  }, {});
}

/** Only a rendered tier label counts; a hidden duplicate in a card is not a second tier. */
const VISIBLE_TIER_LABEL_SELECTOR = '[data-testid="tierAndLeadTime"]:visible';
const OFFER_CONTAINER_LIST_SELECTOR = XOMETRY_LOCATORS.offerContainers.join(", ");
const LIST_PRICE_SELECTOR = '[data-testid="part-discount"] > span';
const DISABLED_DESCENDANT_SELECTOR = '[disabled], [aria-disabled="true"], [data-disabled="true"]';
/** The attributes an element carries itself that can mark it unavailable. */
const AVAILABILITY_ATTRIBUTES = ["disabled", "aria-disabled", "data-disabled", "data-available", "class"] as const;

type XometryOfferCandidateAmbiguity =
  | "shape_unreadable"
  | "overlapping_priced_candidates"
  | "multiple_visible_tier_labels"
  | "wrapper_uncovered_content"
  | "wrapper_overlapping_candidates"
  | "availability_ambiguous";

/** What the collector read about a candidate; null where the page could not answer. */
type CandidateFacts = {
  nestedContainers: number | null;
  pricedNestedContainers: number | null;
  visibleTierLabels: number | null;
};

/** One option-container match inside a candidate, as the page renders it. */
type NestedMatch = {
  locator: Locator;
  /** Rendered text, untrimmed. */
  text: string;
  /** Every amount it shows, savings figures included (see shownAmounts). */
  amounts: string[];
  /** Shows a price once savings figures are dropped (see showsPriceAmount). */
  priced: boolean;
  visibleTierLabels: number;
};

type OfferCandidateShape = { facts: CandidateFacts } & (
  /** Holds two or more priced, labelled matches; `collected` are the ones collected on their own. */
  | { kind: "wrapper"; collected: NestedMatch[] }
  /** Shows nothing beyond its one priced, labelled match `option`, which is collected on its own. */
  | { kind: "frame"; option: NestedMatch }
  | { kind: "option"; visibleTierLabels: number }
  | { kind: "ambiguous"; ambiguity: XometryOfferCandidateAmbiguity }
);

async function countOrNull(locator: Locator) {
  try {
    return await locator.count();
  } catch {
    return null;
  }
}

/** One shown currency amount, in a marker the parser accepts or refuses alike. */
const SHOWN_AMOUNT_SOURCE = String.raw`(?:\bUSD[^\S\r\n]*\$?|[$€£¥])[^\S\r\n]*\d[\d,]*(?:\.\d+)?`;

/** Every amount a candidate shows, savings figures included, in a comparable order. */
function shownAmounts(text: string) {
  return [...text.matchAll(new RegExp(SHOWN_AMOUNT_SOURCE, "gi"))]
    .map((match) => match[0].replaceAll(/\s+/g, "").toUpperCase())
    .sort((a, b) => a.localeCompare(b));
}

function sameAmounts(left: readonly string[], right: readonly string[]) {
  const sortedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const sortedRight = [...right].sort((a, b) => a.localeCompare(b));
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((amount, index) => amount === sortedRight[index]);
}

/**
 * Whether a candidate shows a price: any currency amount left once savings
 * figures ("Save $X", "$X off") are dropped. A struck-through list total still
 * counts, so a nested match holding only one is never taken for decoration.
 */
function showsPriceAmount(text: string) {
  return shownAmounts(text.replace(new RegExp(SAVINGS_FIGURE_SOURCE, "gi"), "")).length > 0;
}

/** Every option-container match inside `candidate`; `matches` is null when any cannot be read. */
async function readNestedMatches(candidate: Locator): Promise<{ count: number | null; matches: NestedMatch[] | null }> {
  const nested = candidate.locator(OFFER_CONTAINER_LIST_SELECTOR);
  const count = await countOrNull(nested);
  if (count === null) return { count, matches: null };
  const matches: NestedMatch[] = [];
  for (let index = 0; index < count; index += 1) {
    const locator = nested.nth(index);
    const text = await locator.innerText().catch(() => null);
    const visibleTierLabels = await countOrNull(locator.locator(VISIBLE_TIER_LABEL_SELECTOR));
    if (text === null || visibleTierLabels === null) return { count, matches: null };
    matches.push({ locator, text, amounts: shownAmounts(text), priced: showsPriceAmount(text), visibleTierLabels });
  }
  return { count, matches };
}

/**
 * OVD-1052: an option container scopes exactly one tier. The part card's drag
 * handle (#draggable-parts > div[role=button][tabindex=0]) matches the
 * role=button container selector but wraps every tier card, and the
 * page-level selectors collect each of those cards on their own.
 *
 * A candidate is a wrapper only when it holds at least two nested
 * option-container matches that each render a visible tier label and show a
 * price. A nested match without a visible label or without a price (an empty
 * or hidden tierAndLeadTime inside a button, say) never makes its parent a
 * wrapper: the parent stays a candidate, so the real card is not dropped.
 *
 * A wrapper is skipped only when its own content is exactly the content of
 * the matches collected on their own: those that render text and hold no
 * priced match themselves (one that does is a frame or wrapper of its own).
 * Every visible tier label and every shown amount in the wrapper must sit in
 * exactly one of them. A label or amount outside all of them (a third tier
 * card the selectors no longer match, say) is `wrapper_uncovered_content`,
 * and a collected match holding another one is
 * `wrapper_overlapping_candidates`; skipping either would publish a partial
 * option set.
 *
 * A candidate that holds exactly one priced nested match is a second priced
 * candidate over the same part of the page. It is only a frame (the drag
 * handle around a single tier card) when that match renders a visible tier
 * label and the candidate shows no amount and no visible tier label beyond
 * it: it then carries no price of its own and is skipped, so the match alone
 * is the option. Any other overlap is ambiguous, as is a candidate whose
 * shape cannot be read or that renders more than one visible tier label: the
 * caller fails closed instead of publishing a doubtful or partial option set.
 */
async function offerCandidateShape(option: Locator, text: string): Promise<OfferCandidateShape> {
  const nested = await readNestedMatches(option);
  const visibleTierLabels = await countOrNull(option.locator(VISIBLE_TIER_LABEL_SELECTOR));
  const priced = nested.matches?.filter((match) => match.priced) ?? null;
  const facts: CandidateFacts = {
    nestedContainers: nested.count,
    pricedNestedContainers: priced?.length ?? null,
    visibleTierLabels,
  };
  const ambiguous = (ambiguity: XometryOfferCandidateAmbiguity): OfferCandidateShape => ({
    kind: "ambiguous",
    ambiguity,
    facts,
  });
  if (nested.matches === null || priced === null || visibleTierLabels === null) return ambiguous("shape_unreadable");
  const pricedAndLabelled = priced.filter((match) => match.visibleTierLabels > 0);
  const ownAmounts = shownAmounts(text);

  if (pricedAndLabelled.length >= 2) {
    const collected: NestedMatch[] = [];
    for (const match of nested.matches) {
      if (!match.text.trim()) continue;
      const inner = await readNestedMatches(match.locator);
      if (inner.matches === null) return ambiguous("shape_unreadable");
      if (inner.matches.some((innerMatch) => innerMatch.priced)) continue;
      if (inner.matches.some((innerMatch) => innerMatch.text.trim())) return ambiguous("wrapper_overlapping_candidates");
      collected.push(match);
    }
    const coveredTierLabels = collected.reduce((total, match) => total + match.visibleTierLabels, 0);
    const covered = coveredTierLabels === visibleTierLabels
      && sameAmounts(ownAmounts, collected.flatMap((match) => match.amounts));
    return covered ? { kind: "wrapper", collected, facts } : ambiguous("wrapper_uncovered_content");
  }
  if (priced.length > 0) {
    const only = priced.length === 1 ? pricedAndLabelled[0] ?? null : null;
    const showsNothingBeyondIt = only !== null
      && visibleTierLabels === only.visibleTierLabels
      && sameAmounts(ownAmounts, only.amounts);
    return showsNothingBeyondIt ? { kind: "frame", option: only, facts } : ambiguous("overlapping_priced_candidates");
  }
  if (visibleTierLabels > 1) return ambiguous("multiple_visible_tier_labels");
  return { kind: "option", visibleTierLabels, facts };
}

/** The availability attributes an element carries itself; null when any cannot be read. */
async function readAvailabilityMarkers(locator: Locator) {
  try {
    const markers: Record<string, string> = {};
    for (const name of AVAILABILITY_ATTRIBUTES) {
      const value = await locator.getAttribute(name);
      if (value !== null) markers[name] = value;
    }
    return markers;
  } catch {
    return null;
  }
}

/** The collector's identity for an option; a repeat match is the same option. */
function optionFingerprint(attributes: Readonly<Record<string, string>>, text: string) {
  return `${attributes["data-option-id"] ?? attributes.id ?? ""}\n${text}`;
}

function ambiguousCandidateError(
  selector: string,
  index: number,
  ambiguity: XometryOfferCandidateAmbiguity,
  facts: CandidateFacts,
) {
  return new VendorAutomationError(
    ambiguity === "availability_ambiguous"
      ? "A Xometry option container's availability could not be established."
      : "A Xometry option container could not be told apart from a wrapper or another priced option.",
    "unexpected_ui_state",
    {
      vendor: "xometry",
      reason: "xometry_offer_container_ambiguous",
      terminalState: "selector_drift",
      ambiguity,
      containerSelector: selector,
      containerIndex: index,
      ...facts,
    },
  );
}

/** Every struck-through list amount the card shows, or undefined when it has none. */
async function readListPriceText(option: Locator) {
  try {
    const listPrices = option.locator(LIST_PRICE_SELECTOR);
    const count = await listPrices.count();
    if (count === 0) return undefined;
    const texts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      texts.push((await listPrices.nth(index).innerText()).trim());
    }
    return texts.join("\n");
  } catch {
    return undefined;
  }
}

/** Collect every distinct supported Xometry tier container in provider order. */
export async function collectXometryOffers(
  page: Page,
  requestedQuantity: number,
  observer?: XometryProviderObserver,
) {
  const snapshots: XometryOfferSnapshot[] = [];
  const observedSnapshots: XometryOfferSnapshot[] | undefined = observer ? [] : undefined;
  const snapshotByFingerprint = new Map<string, XometryOfferSnapshot>();
  /** Options whose frame the page marks unavailable, keyed by fingerprint, with that frame. */
  const unavailableFrames = new Map<string, { selector: string; index: number; facts: CandidateFacts }>();

  for (const selector of XOMETRY_LOCATORS.offerContainers) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const option = locator.nth(index);
      const renderedText = await option.innerText().catch(() => null);
      const text = renderedText?.trim() ?? "";
      // A candidate that renders no text is not an option; one whose text
      // cannot be read is not known to be empty, so it is never dropped.
      if (renderedText !== null && !text) continue;
      const shape: OfferCandidateShape = renderedText === null
        ? {
          kind: "ambiguous",
          ambiguity: "shape_unreadable",
          facts: { nestedContainers: null, pricedNestedContainers: null, visibleTierLabels: null },
        }
        : await offerCandidateShape(option, text);
      if (shape.kind === "ambiguous") {
        throw ambiguousCandidateError(selector, index, shape.ambiguity, shape.facts);
      }
      if (shape.kind === "wrapper" || shape.kind === "frame") {
        // X14: a skipped candidate's own availability still governs the
        // options it holds. Only its own attributes, class and text count:
        // its other descendants are page furniture (the part card's quantity
        // stepper is disabled at quantity 1), and each held option's own
        // descendants are judged when that option is collected.
        const markers = await readAvailabilityMarkers(option);
        if (markers === null) {
          throw ambiguousCandidateError(selector, index, "availability_ambiguous", shape.facts);
        }
        if (shape.kind === "wrapper") {
          // A wrapper marked unavailable, or showing unavailability text
          // outside every option it holds, cannot say which option it means.
          const textOutsideOptions = unavailableTextCount(text)
            > shape.collected.reduce((total, match) => total + unavailableTextCount(match.text), 0);
          if (isMarkedUnavailable(markers, "") || textOutsideOptions) {
            throw ambiguousCandidateError(selector, index, "availability_ambiguous", shape.facts);
          }
        } else if (isMarkedUnavailable(markers, text)) {
          // A frame around one tier card that the page marks unavailable:
          // that card never yields an offer, whichever order they are read in.
          const framedAttributes = await readAttributes(shape.option.locator);
          unavailableFrames.set(
            optionFingerprint(framedAttributes, shape.option.text.trim()),
            { selector, index, facts: shape.facts },
          );
        }
        continue;
      }
      const tierText = shape.visibleTierLabels === 0
        ? ""
        : (await option
          .locator(VISIBLE_TIER_LABEL_SELECTOR)
          .first()
          .innerText()
          .catch(() => ""))
          .trim();
      const attributes = await readAttributes(option);
      // Normalization derives availability from descendants. Preserve actual
      // parent attributes separately instead of presenting derived flags as DOM.
      // One extra record is a bounded overflow sentinel; the factory refuses
      // the whole observation rather than publishing a truncated document set.
      const observedAttributes = observedSnapshots && observedSnapshots.length <= XOMETRY_OBSERVATION_LIMITS.documents
        ? { ...attributes }
        : undefined;
      // An option whose availability the page cannot answer is never
      // presented as available.
      const markers = await readAvailabilityMarkers(option);
      const disabledDescendants = await countOrNull(option.locator(DISABLED_DESCENDANT_SELECTOR));
      if (markers === null || disabledDescendants === null) {
        throw ambiguousCandidateError(selector, index, "availability_ambiguous", shape.facts);
      }
      if (disabledDescendants > 0 || isMarkedUnavailable(markers, "")) {
        attributes["data-disabled"] = "true";
      }
      const fingerprint = optionFingerprint(attributes, text);
      if (snapshotByFingerprint.has(fingerprint)) continue;
      const listPriceText = await readListPriceText(option);
      const snapshot: XometryOfferSnapshot = {
        selector,
        text,
        tierText: tierText || undefined,
        ...(listPriceText === undefined ? {} : { listPriceText }),
        attributes,
      };
      snapshotByFingerprint.set(fingerprint, snapshot);
      snapshots.push(snapshot);
      if (observedSnapshots && observedAttributes) {
        observedSnapshots.push({ selector, text, tierText: tierText || undefined, attributes: observedAttributes });
      }
    }
  }

  for (const [fingerprint, frame] of unavailableFrames) {
    const framed = snapshotByFingerprint.get(fingerprint);
    // The framed card is an option-container match itself, so it was
    // collected; if it was not, the frame cannot be tied to an option.
    if (!framed) {
      throw ambiguousCandidateError(frame.selector, frame.index, "availability_ambiguous", frame.facts);
    }
    framed.attributes["data-disabled"] = "true";
  }

  const quoteUrl = page.url();
  if (observer && observedSnapshots) {
    try {
      const quoteObservation = createXometryQuoteObservation(observedSnapshots, requestedQuantity);
      if (quoteObservation.kind === "quote") {
        for (const document of quoteObservation.documents) observedQuoteDocuments.add(document);
      }
      notifyXometryObserver(observer, quoteObservation);
      // These exact labels already have presentation-only meaning in
      // parseProviderLabel. Never make the containing quote/timing optional.
      for (const [index, snapshot] of (quoteObservation.kind === "quote" ? snapshots : []).entries()) {
        const tierText = snapshot.tierText ?? "";
        const match = /^(Least Expensive|Fastest|Best Value) - (?:Lead Time|Arrives by)\b/m.exec(tierText);
        if (!match) continue;
        const label = match[1] as XometryPresentationObservation["text"];
        const observation: XometryPresentationObservation = Object.freeze({
          kind: "presentation", provider: "xometry",
          evidenceId: `xometry-quote-option-${index}-presentation-badge`,
          parentEvidenceId: `xometry-quote-option-${index}`,
          origin: "xometry_tier_presentation_badge", optionalCategory: "marketing",
          selector: '[data-testid="tierAndLeadTime"]', field: "tierText",
          text: label, start: match.index, end: match.index + label.length,
        });
        observedPresentation.add(observation);
        if (quoteObservation.kind === "quote") {
          presentationParents.set(observation, quoteObservation.documents[index]);
        }
        notifyXometryObserver(observer, observation);
      }
    } catch {
      notifyXometryObserver(observer, unavailableXometryObservation("quote", "observation_capture_failed"));
    }
  }
  return parseXometryOfferSnapshots({
    snapshots,
    requestedQuantity,
    quoteUrl,
  });
}

/** Deterministic legacy summary: lowest total, then shortest lead, then provider ID. */
export function selectCompatibilityOffer(offers: readonly VendorQuoteAdapterOffer[]) {
  return [...offers].sort((left, right) => {
    if (left.totalPriceUsd !== right.totalPriceUsd) {
      return left.totalPriceUsd - right.totalPriceUsd;
    }
    const leftLead = left.leadTimeBusinessDays ?? Number.MAX_SAFE_INTEGER;
    const rightLead = right.leadTimeBusinessDays ?? Number.MAX_SAFE_INTEGER;
    if (leftLead !== rightLead) return leftLead - rightLead;
    return left.providerOptionId.localeCompare(right.providerOptionId);
  })[0] ?? null;
}
