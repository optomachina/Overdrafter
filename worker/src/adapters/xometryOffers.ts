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

const UNAVAILABLE_TEXT = /\b(?:unavailable|not\s+available|not\s+offered|cannot\s+quote|can't\s+quote)\b/i;
/** A class token that styles an element disabled or unavailable ("disabled", "is-unavailable", "tier--disabled"). */
const UNAVAILABLE_CLASS_TOKEN = /^(?:is-)?(?:disabled|unavailable)$|[-_](?:disabled|unavailable)$/i;

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
    || UNAVAILABLE_TEXT.test(text);
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

/** OVD-1052: the only offer container; each tier Xometry quotes is one card. */
const PRICE_TIER_CARD_SELECTOR = XOMETRY_LOCATORS.priceTierCard;
/** Only a rendered tier label counts; a hidden duplicate in a card is not a second tier. */
const VISIBLE_TIER_LABEL_SELECTOR = '[data-testid="tierAndLeadTime"]:visible';
/** A rendered tier label inside some tier card, counted once however the cards nest. */
const CARD_TIER_LABEL_SELECTOR = `${PRICE_TIER_CARD_SELECTOR} ${VISIBLE_TIER_LABEL_SELECTOR}`;
const LIST_PRICE_SELECTOR = '[data-testid="part-discount"] > span';
const DISABLED_DESCENDANT_SELECTOR = '[disabled], [aria-disabled="true"], [data-disabled="true"]';
/** Every element that encloses a card, <body> and <html> included. */
const ANCESTOR_SELECTOR = "xpath=ancestor::*";
/** The attributes an element carries itself that can mark it unavailable. */
const AVAILABILITY_ATTRIBUTES = ["disabled", "aria-disabled", "data-disabled", "data-available", "class"] as const;
/**
 * OVD-1052: the part card around a tier card: the enclosing element that is a
 * direct child of the parts list (#draggable-parts). On every captured quote
 * page it is the drag handle, #draggable-parts > div[role=button], which holds
 * the whole part card and all three tier cards.
 */
const PART_CARD_SELECTOR = 'xpath=ancestor::*[parent::*[@id="draggable-parts"]]';
/**
 * OVD-1052: the price panel's heading ("Price and Lead Time" on every captured
 * quote page). It names no tier and no date, so a line that is exactly this
 * heading is exempt from the timing check below.
 */
const PRICE_PANEL_HEADING = /^price\s+and\s+lead\s+time:?$/i;
/**
 * OVD-1052: the last sentence of the Repeat Part note every captured part card
 * shows outside the tier cards ("Mark as a Repeat Part if ... Pricing and lead
 * time for Repeat Parts may vary."). It names no tier and no date, so this
 * sentence is removed before the timing check; the rest of its line is still
 * checked.
 */
const REPEAT_PART_NOTE = /\bpricing\s+and\s+lead\s+time\s+for\s+repeat\s+parts\s+may\s+vary\./gi;
/**
 * Timing only a tier option carries: what parseLeadTime and parseArrivalText
 * read in a card ("Arrives by", "Delivery on", "Lead time", "5 business days").
 */
const PANEL_TIMING_TEXT = /\b(?:arrives?|receive[ds]?|delivery|delivered)\s+(?:by|on)\b|\blead\s*times?\b|\b(?:business|working)\s+days?\b/i;
/** A shown currency amount: a currency symbol or USD beside digits. */
const PANEL_AMOUNT_TEXT = /(?:[$€£¥]|\bUSD\b)[^\S\r\n]*\d|\d[^\S\r\n]*USD\b/i;

type XometryTierCardAmbiguity =
  | "shape_unreadable"
  | "nested_tier_cards"
  | "multiple_visible_tier_labels"
  | "wrapper_uncovered_content"
  | "availability_ambiguous"
  | "part_card_unbounded";

async function countOrNull(locator: Locator) {
  try {
    return await locator.count();
  } catch {
    return null;
  }
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

/**
 * OVD-1052: whether the page marks a tier card unavailable on the card itself
 * or on any element that encloses it, up to and including <body> and <html>.
 * The live quote page wraps every card in the part card's drag handle
 * (#draggable-parts > div[role=button][tabindex=0]) and several plain
 * <div>s, so a mark anywhere on that path withdraws the card. Null when any
 * of those elements cannot be read, or when no enclosing element can be
 * listed at all (an attached card always has some): the caller then fails
 * closed instead of presenting the card as available.
 */
async function isCardOrAncestorMarkedUnavailable(card: Locator): Promise<boolean | null> {
  const own = await readAvailabilityMarkers(card);
  if (own === null) return null;
  const ancestors = card.locator(ANCESTOR_SELECTOR);
  const count = await countOrNull(ancestors);
  if (count === null || count === 0) return null;
  const path = await Promise.all(
    Array.from({ length: count }, (_, index) => readAvailabilityMarkers(ancestors.nth(index))),
  );
  const readable = path.filter((markers): markers is Record<string, string> => markers !== null);
  if (readable.length !== count) return null;
  return [own, ...readable].some((markers) => isMarkedUnavailable(markers, ""));
}

const AMBIGUITY_MESSAGES: Partial<Record<XometryTierCardAmbiguity, string>> = {
  availability_ambiguous: "A Xometry tier card's availability could not be established.",
  wrapper_uncovered_content:
    "Xometry shows tier content outside every tier card, so the cards are not known to be the complete option set.",
  part_card_unbounded:
    "Xometry's tier cards do not sit in one part card of the parts list, so the text beside them cannot be checked.",
};

function ambiguousCardError(
  ambiguity: XometryTierCardAmbiguity,
  facts: Record<string, number | null>,
  index?: number,
) {
  return new VendorAutomationError(
    AMBIGUITY_MESSAGES[ambiguity] ?? "A Xometry tier card could not be read as exactly one option.",
    "unexpected_ui_state",
    {
      vendor: "xometry",
      reason: "xometry_offer_container_ambiguous",
      terminalState: "selector_drift",
      ambiguity,
      containerSelector: PRICE_TIER_CARD_SELECTOR,
      ...(index === undefined ? {} : { containerIndex: index }),
      ...facts,
    },
  );
}

/**
 * OVD-1052: Xometry has not finished pricing every tier (a card renders no
 * text yet, the settle wait timed out, or the page still says it is pricing,
 * with or without cards on screen), so the cards on screen are not known to
 * be the complete option set. A finite, retryable stop.
 */
function pricePendingError(
  pendingCause: "tier_card_blank" | "price_tiers_unsettled" | "price_tier_cards_absent" | "pricing_in_progress",
  index?: number,
) {
  return new VendorAutomationError(
    "Xometry had not finished pricing every tier, so no complete option set could be read.",
    "unexpected_ui_state",
    {
      vendor: "xometry",
      reason: "xometry_price_pending",
      terminalState: "unavailable",
      pendingCause,
      containerSelector: PRICE_TIER_CARD_SELECTOR,
      ...(index === undefined ? {} : { containerIndex: index }),
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

type PartCard =
  | { kind: "part_card"; partCard: Locator }
  | { kind: "unbounded" }
  | { kind: "unreadable" };

/**
 * OVD-1052: the part card that holds every tier card (PART_CARD_SELECTOR).
 * "unbounded" when the first card sits in no part card, or its part card does
 * not hold every card on the page: the cards are then not one part's options,
 * and the check never widens to the parts list or the page. "unreadable" when
 * the part card or the cards in it cannot be counted, or the counts disagree
 * with the page's.
 */
async function locatePartCard(cards: Locator, cardCount: number): Promise<PartCard> {
  const partCards = cards.nth(0).locator(PART_CARD_SELECTOR);
  const count = await countOrNull(partCards);
  if (count === null || count > 1) return { kind: "unreadable" };
  if (count === 0) return { kind: "unbounded" };
  const partCard = partCards.nth(0);
  const enclosedCards = await countOrNull(partCard.locator(PRICE_TIER_CARD_SELECTOR));
  if (enclosedCards === null || enclosedCards > cardCount) return { kind: "unreadable" };
  return enclosedCards === cardCount ? { kind: "part_card", partCard } : { kind: "unbounded" };
}

/**
 * The part card's rendered lines outside every tier card: each card's text
 * (in page order) is cut out of the part card's text. Null when a card's text
 * is not where the part card shows it, so the two reads do not describe one
 * page.
 */
function linesOutsideCards(partCardText: string, cardTexts: readonly string[]) {
  const outside: string[] = [];
  let cursor = 0;
  for (const cardText of cardTexts) {
    if (!cardText) continue;
    const at = partCardText.indexOf(cardText, cursor);
    if (at < 0) return null;
    outside.push(partCardText.slice(cursor, at));
    cursor = at + cardText.length;
  }
  outside.push(partCardText.slice(cursor));
  return outside
    .join("\n")
    .split(/\r?\n/)
    .map((line) => collapseInlineSpace(line).trim())
    .filter(Boolean);
}

/**
 * Whether a line outside the cards shows what only a tier option carries: a
 * currency amount, or tier timing other than the part card's static lines
 * (the price panel heading, the Repeat Part note).
 */
function showsTierContent(line: string) {
  if (PANEL_AMOUNT_TEXT.test(line)) return true;
  if (PRICE_PANEL_HEADING.test(line)) return false;
  return PANEL_TIMING_TEXT.test(line.replaceAll(REPEAT_PART_NOTE, " "));
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Whether a line names the tier label as a whole word or phrase, in any case. */
function namesTier(line: string, label: string) {
  return new RegExp(String.raw`(?:^|[^a-z0-9])${escapeRegExp(label)}(?![a-z0-9])`, "i").test(line);
}

/**
 * Whether a line says, with the tier as its subject, that the tier is
 * unavailable: "[The] <tier>[ tier | option] is [currently] unavailable | not
 * available | not offered ...", in any case. A line that only mentions the
 * tier's name ("Standard finish not available for this material") does not.
 */
function statesTierUnavailable(line: string, label: string) {
  const name = escapeRegExp(collapseInlineSpace(label).trim()).replaceAll(" ", String.raw`\s+`);
  return new RegExp(
    String.raw`^(?:the\s+)?${name}(?:\s+(?:tier|option))?\s+is\s+(?:currently\s+)?(?:unavailable|not\s+available|not\s+offered)\b`,
    "i",
  ).test(line);
}

/**
 * OVD-1052: what the part card shows beside the tier cards. The whole part
 * card is read, not just the price panel around the cards: a tier card that
 * lost both hooks, or a notice about a tier, can sit anywhere in it.
 *
 * - A rendered line outside every card with a currency amount or tier timing
 *   (an arrival date, a lead time, business days) is content the cards do not
 *   cover, a tier card whose class and label hook were both renamed, say:
 *   selector drift (wrapper_uncovered_content). Only the static lines every
 *   captured part card shows are exempt from the timing check: the "Price and
 *   Lead Time" heading, and the Repeat Part note's sentence "Pricing and lead
 *   time for Repeat Parts may vary.".
 * - A line outside the cards that says something is unavailable withdraws a
 *   card only when it names exactly one card's tier, as a whole word, and
 *   says that tier is unavailable as its subject ("Fastest is not available
 *   for this part."). Any other unavailability line ("Standard finish not
 *   available for this material", "Standard and Fastest are not available")
 *   is availability_ambiguous. A line with timing or an amount fails the first
 *   check even when it also names one tier.
 *
 * Text outside the part card (the order summary's own arrival date, say) is
 * never read here.
 */
async function checkPartCard(
  cards: Locator,
  cardTexts: readonly string[],
  snapshots: readonly XometryOfferSnapshot[],
) {
  const located = await locatePartCard(cards, cardTexts.length);
  if (located.kind === "unbounded") throw ambiguousCardError("part_card_unbounded", { tierCards: cardTexts.length });
  const partCardText = located.kind === "part_card"
    ? await located.partCard.innerText().catch(() => null)
    : null;
  const lines = partCardText === null ? null : linesOutsideCards(partCardText, cardTexts);
  if (lines === null) throw ambiguousCardError("shape_unreadable", { tierCards: cardTexts.length, partCardLines: null });

  const uncovered = lines.filter(showsTierContent);
  if (uncovered.length > 0) {
    throw ambiguousCardError("wrapper_uncovered_content", {
      partCardLines: lines.length,
      uncoveredPartCardLines: uncovered.length,
    });
  }

  const unavailableLines = lines.filter((line) => UNAVAILABLE_TEXT.test(line));
  if (unavailableLines.length === 0) return;
  const headerLabels = snapshots
    .map((snapshot) => parseTierHeaderLabel(snapshot)?.toLowerCase())
    .filter((label): label is string => Boolean(label));
  const sharedHeaderLabels = new Set(headerLabels.filter((label, index) => headerLabels.indexOf(label) !== index));
  const tierLabels = snapshots.map((snapshot) => parseProviderLabel(snapshot, sharedHeaderLabels));
  for (const line of unavailableLines) {
    const named = snapshots.flatMap((snapshot, index) => {
      const label = tierLabels[index];
      return label !== null && namesTier(line, label) ? [{ snapshot, label }] : [];
    });
    if (named.length !== 1 || !statesTierUnavailable(line, named[0].label)) {
      throw ambiguousCardError("availability_ambiguous", {
        partCardUnavailableLines: unavailableLines.length,
        namedTierCards: named.length,
      });
    }
    named[0].snapshot.attributes["data-disabled"] = "true";
  }
}

/** What the adapter knows about the quote page's pricing before collection. */
export type XometryPriceReadiness = {
  /**
   * False when xometryPriceTiersSettled timed out: some available tier card
   * never showed both a price and timing, so the cards are not published.
   */
  priceTiersSettled: boolean;
  /**
   * The quote page still shows in-progress pricing text
   * (isXometryPricingInProgress): nothing is published, cards or not.
   */
  pricingInProgress: boolean;
};

/**
 * OVD-1052: collects Xometry's tier cards as the complete option set, in page
 * order. The offer set is exactly the page's .price-tier cards; no other
 * element is read as an option, and anything nested in a card (a button, say)
 * is part of that card.
 *
 * - In-progress pricing text anywhere on the quote page
 *   (`readiness.pricingInProgress`): pending, whether or not cards render.
 * - No card: selector drift (xometry_price_tier_cards_missing).
 * - A card whose text, label count or nesting cannot be read, that holds
 *   another card, or that renders more than one tier label: selector drift.
 * - A blank card is still being priced: pending, unless the card or an
 *   enclosing element marks it unavailable.
 * - A card is unavailable when it, any enclosing element or any descendant
 *   carries an availability marker, or its text says so; it is excluded, and
 *   markers that cannot be read fail closed. When every card is unavailable
 *   nothing is published.
 * - Every rendered tier label on the page must sit in a card; one outside
 *   them all means the cards may not be every tier: selector drift.
 * - The part card around the cards must show no tier timing or amount
 *   outside them, and a tier a line there says is unavailable is excluded
 *   (checkPartCard).
 * - A timed-out settle wait (`readiness.priceTiersSettled` false) is pending
 *   whenever any card is available.
 *
 * Each card's stated quantity is checked against its own text only (see
 * parseXometryOfferSnapshots); the part card's quantity input is checked
 * separately before collection.
 */
export async function collectXometryOffers(
  page: Page,
  requestedQuantity: number,
  observer?: XometryProviderObserver,
  readiness: XometryPriceReadiness = { priceTiersSettled: true, pricingInProgress: false },
) {
  const cards = page.locator(PRICE_TIER_CARD_SELECTOR);
  const cardCount = await countOrNull(cards);
  if (cardCount === null) throw ambiguousCardError("shape_unreadable", { tierCards: null });
  // Cards on screen while the page still says it is pricing may be stale or
  // partial, so none is published as the complete set.
  if (readiness.pricingInProgress) {
    throw pricePendingError(cardCount === 0 ? "price_tier_cards_absent" : "pricing_in_progress");
  }
  if (cardCount === 0) {
    throw new VendorAutomationError(
      "Xometry's quote page showed no tier card, so its option set could not be read.",
      "unexpected_ui_state",
      {
        vendor: "xometry",
        reason: "xometry_price_tier_cards_missing",
        terminalState: "selector_drift",
        containerSelector: PRICE_TIER_CARD_SELECTOR,
      },
    );
  }

  const snapshots: XometryOfferSnapshot[] = [];
  const observedSnapshots: XometryOfferSnapshot[] | undefined = observer ? [] : undefined;
  /** Every card's rendered text, in page order, blank cards included. */
  const cardTexts: string[] = [];
  for (let index = 0; index < cardCount; index += 1) {
    const card = cards.nth(index);
    const renderedText = await card.innerText().catch(() => null);
    if (renderedText === null) {
      throw ambiguousCardError("shape_unreadable", { nestedTierCards: null, visibleTierLabels: null }, index);
    }
    const text = renderedText.trim();
    cardTexts.push(text);
    if (!text) {
      // A blank card is a skeleton still being priced, not an absent tier.
      // Only the card or an enclosing element can say the page withdrew it:
      // a skeleton can render disabled controls.
      const unavailable = await isCardOrAncestorMarkedUnavailable(card);
      if (unavailable === null) {
        throw ambiguousCardError("availability_ambiguous", { nestedTierCards: null, visibleTierLabels: null }, index);
      }
      if (unavailable) continue;
      throw pricePendingError("tier_card_blank", index);
    }

    const nestedTierCards = await countOrNull(card.locator(PRICE_TIER_CARD_SELECTOR));
    const visibleTierLabels = await countOrNull(card.locator(VISIBLE_TIER_LABEL_SELECTOR));
    const facts = { nestedTierCards, visibleTierLabels };
    if (nestedTierCards === null || visibleTierLabels === null) throw ambiguousCardError("shape_unreadable", facts, index);
    if (nestedTierCards > 0) throw ambiguousCardError("nested_tier_cards", facts, index);
    if (visibleTierLabels > 1) throw ambiguousCardError("multiple_visible_tier_labels", facts, index);

    const tierText = visibleTierLabels === 0
      ? ""
      : (await card
        .locator(VISIBLE_TIER_LABEL_SELECTOR)
        .first()
        .innerText()
        .catch(() => ""))
        .trim();
    const attributes = await readAttributes(card);
    // Normalization derives availability from enclosing elements and
    // descendants. Preserve actual card attributes separately instead of
    // presenting derived flags as DOM. One extra record is a bounded overflow
    // sentinel; the factory refuses the whole observation rather than
    // publishing a truncated document set.
    const observedAttributes = observedSnapshots && observedSnapshots.length <= XOMETRY_OBSERVATION_LIMITS.documents
      ? { ...attributes }
      : undefined;
    // A card whose availability the page cannot answer is never presented as available.
    const unavailable = await isCardOrAncestorMarkedUnavailable(card);
    const disabledDescendants = await countOrNull(card.locator(DISABLED_DESCENDANT_SELECTOR));
    if (unavailable === null || disabledDescendants === null) {
      throw ambiguousCardError("availability_ambiguous", facts, index);
    }
    if (unavailable || disabledDescendants > 0) {
      attributes["data-disabled"] = "true";
    }
    const listPriceText = await readListPriceText(card);
    snapshots.push({
      selector: PRICE_TIER_CARD_SELECTOR,
      text,
      tierText: tierText || undefined,
      ...(listPriceText === undefined ? {} : { listPriceText }),
      attributes,
    });
    if (observedSnapshots && observedAttributes) {
      observedSnapshots.push({
        selector: PRICE_TIER_CARD_SELECTOR,
        text,
        tierText: tierText || undefined,
        attributes: observedAttributes,
      });
    }
  }

  // A tier label the cards do not hold is a tier this collector cannot see.
  const pageTierLabels = await countOrNull(page.locator(VISIBLE_TIER_LABEL_SELECTOR));
  const cardTierLabels = await countOrNull(page.locator(CARD_TIER_LABEL_SELECTOR));
  const coverage = { visibleTierLabels: pageTierLabels, coveredTierLabels: cardTierLabels };
  if (pageTierLabels === null || cardTierLabels === null) throw ambiguousCardError("shape_unreadable", coverage);
  if (pageTierLabels > cardTierLabels) throw ambiguousCardError("wrapper_uncovered_content", coverage);
  await checkPartCard(cards, cardTexts, snapshots);

  // Never publish the cards that did render as the complete set. When every
  // card is unavailable the settle wait cannot succeed, and nothing is published.
  if (!readiness.priceTiersSettled && snapshots.some((snapshot) => !isExplicitlyUnavailable(snapshot))) {
    throw pricePendingError("price_tiers_unsettled");
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
