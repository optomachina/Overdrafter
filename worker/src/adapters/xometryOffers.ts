import type { Locator, Page } from "patchright";
import {
  VendorAutomationError,
  type GeographicOrigin,
  type VendorQuoteAdapterOffer,
} from "../types.js";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { sourceShowsQuantity } from "../quotes/pricedQuantity.js";
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
  /**
   * OVD-1052: whether collectXometryOffers withdrew the card, which it
   * decides from the page as a whole (see there). When set, the parser
   * publishes the card exactly when this is false, whatever marks its
   * attributes carry. Unset, the card's own attributes and text decide.
   */
  withdrawn?: boolean;
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

/**
 * OVD-1052: whether a tier card's text shows what the parser publishes: a
 * currency amount and a lead or arrival time. Such a card is a priced tier,
 * so text or a control inside it, or a notice beside it, never withdraws it
 * on its own (see collectXometryOffers and checkPartCard).
 */
function showsPriceAndTiming(text: string) {
  return new RegExp(PRICE_TOKEN_SOURCE).test(text)
    && (parseLeadTime(text) !== null || parseArrivalText(text) !== null);
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

/** Whether the option is withdrawn: the collector's decision when it made one, else its own marks and text. */
function isWithdrawn(snapshot: XometryOfferSnapshot) {
  return snapshot.withdrawn ?? isExplicitlyUnavailable(snapshot);
}

/** Collapses spaces, including the no-break space after a tier icon. */
function collapseInlineSpace(value: string) {
  return value.replaceAll(/[^\S\r\n]+/g, " ");
}

/**
 * OVD-1052: whether the card is in Xometry's current layout: its
 * [data-testid="tierAndLeadTime"] label holds only the timing ("Arrives by
 * Nov 3", "Lead Time: 7 Days"), and the tier's name sits in a header slot
 * before it. The earlier layout put "<Tier> - Lead Time: ..." inside the
 * label itself.
 */
function isCurrentTierLayout(snapshot: XometryOfferSnapshot) {
  const tierText = collapseInlineSpace(snapshot.tierText ?? "").trim();
  return /^(?:lead\s+time|arrives?\s+by)\b/i.test(tierText) && !tierText.includes(" - ");
}

/**
 * OVD-1052: Xometry's current tier card names its tier in a header slot that
 * precedes the [data-testid="tierAndLeadTime"] label, and that label now holds
 * only the timing (synthetic fixture values: "Least Expensive" | "Arrives by
 * Nov 3", "Standard" | "Arrives by Nov 6", "Fastest" | "Arrives by Oct 30").
 * This is the one rendered line before the timing label, or null when the
 * card is not in that layout or shows more than one line there.
 */
function tierHeaderLine(snapshot: XometryOfferSnapshot) {
  if (!isCurrentTierLayout(snapshot)) return null;
  const tierText = collapseInlineSpace(snapshot.tierText ?? "").trim();
  const text = collapseInlineSpace(snapshot.text);
  const headerEnd = text.indexOf(tierText);
  if (headerEnd <= 0) return null;
  const segments = text.slice(0, headerEnd).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return segments.length === 1 ? segments[0] : null;
}

/**
 * OVD-1052: the tier names the current quote page shows in a card's header
 * slot. A header line names its option only when it is exactly one of them,
 * in any case. An inline badge beside the name ("Standard" followed by a
 * "Popular" <span>) renders on the same line ("StandardPopular", "Fastest
 * Recommended"), and would otherwise be published as the tier's label and id.
 */
const XOMETRY_TIER_NAME = /^(?:least expensive|standard|fastest)$/i;

/** The tier the card's header line names, or null when the line is not exactly a tier name. */
function parseTierHeaderLabel(snapshot: XometryOfferSnapshot) {
  const line = tierHeaderLine(snapshot);
  return line !== null && XOMETRY_TIER_NAME.test(line) ? line : null;
}

/**
 * The option's tier label, or null when the card names none.
 *
 * OVD-1052: a card in the current layout (isCurrentTierLayout) is named only
 * by its header slot: exactly one line before the timing label, exactly one
 * of the tier names, and on no other card. Nothing else in it is read as the
 * tier, so a block badge above the name ("Rush", "Recommended"), a subtitle
 * ("Economy production") or a "<text> - Arrives by <date>" line elsewhere in
 * the card names no tier, and the card is refused. Only a card in the earlier
 * layout falls back to a "<Tier> - Lead time" line or a known tier word.
 */
function parseProviderLabel(snapshot: XometryOfferSnapshot, sharedHeaderLabels: ReadonlySet<string>) {
  if (isCurrentTierLayout(snapshot)) {
    const headerLabel = parseTierHeaderLabel(snapshot);
    // A header name that more than one card carries is a presentation badge,
    // not the identity of either option.
    return headerLabel !== null && !sharedHeaderLabels.has(headerLabel.toLowerCase()) ? headerLabel : null;
  }

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

  for (const line of lines) {
    const knownLabel = /\b(?:(?:domestic|international|overseas)\s+)?(?:economy|standard|expedited|expedite|priority|rush)(?:\s+(?:domestic|international|overseas))?\b/i.exec(line)?.[0];
    if (knownLabel) {
      return knownLabel.trim();
    }
  }

  return null;
}

/** A shown amount on a card's price line: "$101.25", "USD 101.25", "USD $1,012.50". */
const CARD_AMOUNT_SOURCE = String.raw`(?:USD ?\$?|\$) ?\d[\d,]*(?:\.\d{2})?`;
/**
 * OVD-1052: the price lines a current-layout card shows after its timing
 * label: the unit price ("$101.25 ea."), the total ("$101.25"), and the
 * struck-through list total with its savings note ("$146.80 (Save $45.55)").
 */
const CARD_PRICE_LINES = [
  new RegExp(String.raw`^${CARD_AMOUNT_SOURCE}(?: ea\.?| each)?$`, "i"),
  new RegExp(String.raw`^${CARD_AMOUNT_SOURCE} \((?:you )?save ${CARD_AMOUNT_SOURCE}\)$`, "i"),
];

/**
 * OVD-1052: how many rendered lines a current-layout card shows after its
 * timing label that are not price lines (CARD_PRICE_LINES). Every captured
 * card shows exactly its tier name, its arrival date and three price lines,
 * so any other line is something the parser does not read: a badge or
 * subtitle that could carry another tier word ("Expedited shipping
 * included"), a timing line of its own ("Ground shipping - Arrives by Nov 3"),
 * or a status ("Fetching new price...") that leaves the amounts beside it in
 * doubt. tierHeaderLine has already found exactly one line before the label.
 */
function countUnrecognizedCardLines(snapshot: XometryOfferSnapshot, requestedQuantity: number) {
  const tierText = collapseInlineSpace(snapshot.tierText ?? "").trim();
  const text = collapseInlineSpace(snapshot.text);
  return text
    .slice(text.indexOf(tierText) + tierText.length)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !CARD_PRICE_LINES.some((pattern) => pattern.test(line)) && !sourceShowsQuantity(line, requestedQuantity))
    .length;
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
  const availableSnapshots = input.snapshots.filter((snapshot) => !isWithdrawn(snapshot));
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

    // Only a lone option in the earlier layout may go unnamed; a current-layout
    // card always names its tier in its header slot.
    const providerLabel = parseProviderLabel(snapshot, sharedHeaderLabels)
      ?? (availableSnapshots.length === 1 && !isCurrentTierLayout(snapshot) ? "Xometry option" : null);
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
    const unrecognizedCardLines = isCurrentTierLayout(snapshot) ? countUnrecognizedCardLines(snapshot, input.requestedQuantity) : 0;
    if (unrecognizedCardLines > 0) {
      throw new VendorAutomationError(
        "A Xometry tier card showed a line beside its tier, timing and prices that the parser does not read.",
        "selector_failure",
        {
          vendor: "xometry",
          reason: "xometry_offer_line_unrecognized",
          terminalState: "selector_drift",
          containerSelector: snapshot.selector,
          optionIndex: index,
          unrecognizedCardLines,
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
 * Every element that encloses a tier card up to and including its part card,
 * in document order (outermost first, as Playwright's XPath engine returns
 * them). The parts list, <body> and <html> are never among them.
 */
const PART_CARD_ANCESTORS_SELECTOR = 'xpath=ancestor::*[ancestor-or-self::*[parent::*[@id="draggable-parts"]]]';
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
/**
 * OVD-1052: text anywhere in the part card, cards included, that says the
 * page is still loading, saving or re-pricing ("Loading...", "Loading more
 * options...", "Refreshing prices", "Updating", "Recalculating", "Fetching new
 * price...", "Saving...", "Please wait"). The cards on screen may then be
 * stale or partial. No captured part card shows any of these words.
 */
const PART_CARD_LOADING_TEXT = /\b(?:loading|refreshing|updating|(?:re)?calculating|re-?pricing|fetching|saving|please\s+wait)\b/i;
/**
 * A CAD or drawing file name, as the part card's title names the part's file
 * ("loading-dock-bracket.step"). A file name is not a status, so it is cut
 * out of a line before the line is read as loading text; the rest of the line
 * still is ("Fetching new price for bracket.step...").
 */
// Bounded quantifiers keep this linear in the input length (no quadratic
// backtracking on long runs of name characters). Keep in sync with the
// in-page copy in xometry.ts.
export const FILE_NAME_TEXT = /(?<![\w\-+~#().])[\w\-+~#()]{0,255}(?:\.[\w\-+~#()]{1,255}){0,16}\.(?:step|stp|iges|igs|sldprt|x_t|x_b|stl|3mf|obj|ipt|prt|catpart|par|dxf|dwg|pdf)\b/gi;
/**
 * What may follow "<tier> is not available" in a price-panel line that
 * withdraws the tier (statesTierUnavailable): nothing but "for this part",
 * "for this quote", "at this time" or "right now", and a closing period.
 */
const UNCONDITIONAL_UNAVAILABILITY_TAIL = String.raw`(?:\s+(?:for\s+this\s+(?:part|quote)|at\s+this\s+time|right\s+now))?\s*[.!]?$`;
/**
 * OVD-1052: an element that encloses the part card, or the part card itself,
 * marked aria-busy (in any case): the page is still changing what it holds.
 */
const BUSY_AROUND_PART_CARD_SELECTOR = 'xpath=ancestor-or-self::*[translate(@aria-busy, "TRUE", "true") = "true"]';
/**
 * OVD-1052: a busy region or progress indicator inside the part card: an
 * aria-busy region, a progress bar, a spinning icon (Font Awesome's fa-spin,
 * fa-pulse or fa-spinner; the page already uses Font Awesome for its tier
 * icons), Ant Design's active spinner, or a spinner, skeleton or shimmer
 * placeholder. No captured part card holds any of them.
 */
const BUSY_IN_PART_CARD_SELECTOR = [
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
].join(", ");
/** The class every tier card carries (PRICE_TIER_CARD_SELECTOR without its dot). */
const PRICE_TIER_CARD_CLASS = PRICE_TIER_CARD_SELECTOR.replace(/^\./, "");
const IS_TIER_CARD = `contains(concat(" ", normalize-space(@class), " "), " ${PRICE_TIER_CARD_CLASS} ")`;
/**
 * OVD-1052: every element in the price panel outside the tier cards that
 * encloses no card, outermost only: each child of the panel, or of an element
 * in it that encloses a card, that neither is nor holds a card. On every
 * captured quote page the only one is the "Price and Lead Time" heading.
 */
const PANEL_OTHER_ELEMENT_SELECTOR = `xpath=.//*[not(${IS_TIER_CARD})][not(ancestor::*[${IS_TIER_CARD}])]`
  + `[not(.//*[${IS_TIER_CARD}])][parent::*[.//*[${IS_TIER_CARD}]]]`;

type XometryTierCardAmbiguity =
  | "shape_unreadable"
  | "nested_tier_cards"
  | "multiple_visible_tier_labels"
  | "wrapper_uncovered_content"
  | "availability_ambiguous"
  | "part_card_unbounded"
  | "price_panel_unlocated"
  | "price_panel_unrecognized";

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
 * or on any element that encloses it within its part card, the part card
 * included. The live quote page wraps every card in the part card's drag
 * handle (#draggable-parts > div[role=button][tabindex=0]) and several plain
 * <div>s, so a mark anywhere on that path counts (collectXometryOffers decides
 * what it means). A mark above the part card (on the parts list, <body> or
 * <html>, such as a "scroll-disabled" class while a dialog is open) says
 * nothing about one part's tiers and is not read. Null when any of those
 * elements cannot be read, or when none can be listed at all (a card in a
 * part card always has one): the caller then fails closed instead of
 * presenting the card as available.
 */
async function isCardOrAncestorMarkedUnavailable(card: Locator): Promise<boolean | null> {
  const own = await readAvailabilityMarkers(card);
  if (own === null) return null;
  const ancestors = card.locator(PART_CARD_ANCESTORS_SELECTOR);
  const count = await countOrNull(ancestors);
  if (count === null || count === 0) return null;
  const path = await Promise.all(
    Array.from({ length: count }, (_, index) => readAvailabilityMarkers(ancestors.nth(index))),
  );
  const readable = path.filter((markers): markers is Record<string, string> => markers !== null);
  if (readable.length !== count) return null;
  return [own, ...readable].some((markers) => isMarkedUnavailable(markers, ""));
}

/**
 * OVD-1052: whether the page hides an element (a tier card, say):
 * display:none on it or on an element that encloses it, or a hidden
 * visibility on it. Such a card is not on screen; the collector skips it only
 * as a copy of a card the page shows. Its innerText cannot say so: a browser
 * returns a display:none element's full text content as its innerText. A card
 * that merely renders nothing (a skeleton, or a card whose content has not
 * mounted) is not hidden. False when this cannot be read, so the caller reads
 * the element as shown.
 */
async function isHiddenByPage(card: Locator) {
  try {
    const hidden = await card.evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      if (!view) return false;
      if (["hidden", "collapse"].includes(view.getComputedStyle(element).visibility)) return true;
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (view.getComputedStyle(node).display === "none") return true;
      }
      return false;
    });
    return hidden === true;
  } catch {
    return false;
  }
}

/**
 * OVD-1052: a tier card's text content with all whitespace removed, which a
 * browser keeps for a card it hides. Two cards with the same one show the
 * same tier name, price and timing. Null when it cannot be read.
 */
async function readCardContent(card: Locator) {
  try {
    const content = await card.evaluate((element) => element.textContent);
    return typeof content === "string" ? content.replaceAll(/\s+/g, "") : null;
  } catch {
    return null;
  }
}

/**
 * OVD-1052: whether a part card's rendered text says the page is still
 * loading, saving or re-pricing (PART_CARD_LOADING_TEXT) on any line, once
 * each known uploaded file name is cut out of it, including spaces. The
 * token pattern (FILE_NAME_TEXT) remains a fallback for other file names.
 */
function showsLoadingText(text: string, fileNames: string[]) {
  const withoutFileNames = fileNames.filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((remaining, fileName) => remaining.replaceAll(fileName, " "), text);
  return withoutFileNames.split(/\r?\n/).some((line) => PART_CARD_LOADING_TEXT.test(line.replaceAll(FILE_NAME_TEXT, " ")));
}

/**
 * OVD-1052: whether the page marks the part card busy: aria-busy on it or on
 * an element that encloses it, or a busy region, progress indicator, spinner
 * or placeholder skeleton in it (BUSY_IN_PART_CARD_SELECTOR) that the page
 * does not hide (isHiddenByPage). Null when this cannot be read.
 */
async function isPartCardBusy(partCard: Locator): Promise<boolean | null> {
  const around = await countOrNull(partCard.locator(BUSY_AROUND_PART_CARD_SELECTOR));
  const within = partCard.locator(BUSY_IN_PART_CARD_SELECTOR);
  const count = await countOrNull(within);
  if (around === null || count === null) return null;
  if (around > 0) return true;
  for (let index = 0; index < count; index += 1) {
    if (!(await isHiddenByPage(within.nth(index)))) return true;
  }
  return false;
}

/**
 * OVD-1052: how many elements the price panel shows outside the tier cards
 * that render no text and enclose no card (PANEL_OTHER_ELEMENT_SELECTOR): a
 * tier still loading in a placeholder without the card's class, say. Null
 * when they cannot be read.
 */
async function countPanelPlaceholders(panel: Locator) {
  const others = panel.locator(PANEL_OTHER_ELEMENT_SELECTOR);
  const count = await countOrNull(others);
  if (count === null) return null;
  let placeholders = 0;
  for (let index = 0; index < count; index += 1) {
    const element = others.nth(index);
    if (await isHiddenByPage(element)) continue;
    const text = await element.innerText().catch(() => null);
    if (text === null) return null;
    if (text.trim() === "") placeholders += 1;
  }
  return placeholders;
}

const AMBIGUITY_MESSAGES: Partial<Record<XometryTierCardAmbiguity, string>> = {
  availability_ambiguous: "A Xometry tier card's availability could not be established.",
  wrapper_uncovered_content:
    "Xometry shows tier content outside every tier card, so the cards are not known to be the complete option set.",
  part_card_unbounded:
    "Xometry's tier cards do not sit in one part card of the parts list, so the text beside them cannot be checked.",
  price_panel_unlocated:
    "No element around Xometry's tier cards shows the price panel's heading, so the panel cannot be checked for tiers still loading.",
  price_panel_unrecognized:
    "Xometry's price panel shows something beside the tier cards other than its heading or a tier notice, so the cards are not known to be the complete option set.",
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
 * text yet, the settle wait timed out, the page still says it is pricing, with
 * or without cards on screen, or it hides every card), so the cards on screen
 * are not known to be the complete option set. A finite, retryable stop.
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

type PricePanel =
  | { kind: "price_panel"; panel: Locator; panelText: string; panelLines: string[] }
  | { kind: "unlocated" }
  | { kind: "unreadable" };

/**
 * OVD-1052: the price panel, the innermost element that encloses every tier
 * card the page shows and whose rendered lines outside the cards include the
 * "Price and Lead Time" heading. On every captured quote page it is the <div>
 * whose children are that heading and the three cards.
 *
 * The heading is required: the innermost element around the shown cards
 * alone shrinks to one card's own wrapper when only that card has rendered
 * (each card in a grid cell, say), and placeholders for the other tiers in
 * sibling wrappers would then fall outside the panel. A card the page hides
 * (isHiddenByPage) is not counted, as the collector skips it: a hidden copy
 * elsewhere in the part card would otherwise widen the panel to the part card,
 * and a line beside the part's configuration ("Standard is not available for
 * this material.") would read as a panel line that withdraws a tier.
 * xometryPriceTiersSettled locates the panel the same way. The search never
 * leaves the part card. "unlocated" when no element up to the part card shows
 * the heading; "unreadable" when no card is shown, an element cannot be read,
 * or a card's text is not where the element shows it.
 */
async function locatePricePanel(
  cards: Locator,
  cardTexts: readonly string[],
  shownCards: readonly number[],
): Promise<PricePanel> {
  if (shownCards.length === 0) return { kind: "unreadable" };
  const ancestors = cards.nth(shownCards[0]).locator(PART_CARD_ANCESTORS_SELECTOR);
  const count = await countOrNull(ancestors);
  if (count === null) return { kind: "unreadable" };
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = ancestors.nth(index);
    const enclosed = candidate.locator(PRICE_TIER_CARD_SELECTOR);
    const enclosedCount = await countOrNull(enclosed);
    if (enclosedCount === null) return { kind: "unreadable" };
    if (enclosedCount < shownCards.length) continue;
    // When the page hides no card, every card the element encloses is shown.
    let enclosedShown = enclosedCount;
    if (shownCards.length < cardTexts.length) {
      enclosedShown = 0;
      for (let card = 0; card < enclosedCount; card += 1) {
        if (!(await isHiddenByPage(enclosed.nth(card)))) enclosedShown += 1;
      }
    }
    if (enclosedShown !== shownCards.length) continue;
    const panelText = (await candidate.innerText().catch(() => null))?.trim() ?? null;
    const panelLines = panelText === null ? null : linesOutside(panelText, cardTexts);
    if (panelText === null || panelLines === null) return { kind: "unreadable" };
    if (panelLines.some((line) => PRICE_PANEL_HEADING.test(line))) {
      return { kind: "price_panel", panel: candidate, panelText, panelLines };
    }
  }
  return { kind: "unlocated" };
}

/**
 * The rendered lines of a container's text outside the given pieces of it
 * (each tier card's text, or the price panel's): each piece (in page order) is
 * cut out of the container's text. Null when a piece's text is not where the
 * container shows it, so the two reads do not describe one page.
 */
function linesOutside(containerText: string, pieces: readonly string[]) {
  const outside: string[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    if (!piece) continue;
    const at = containerText.indexOf(piece, cursor);
    if (at < 0) return null;
    outside.push(containerText.slice(cursor, at));
    cursor = at + piece.length;
  }
  outside.push(containerText.slice(cursor));
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
 * Whether a line says, with the tier as its subject and without a condition,
 * that the tier is unavailable for this part: "[The] <tier>[ tier | option]
 * is [currently] unavailable | not available | not offered[ for this part |
 * for this quote | at this time | right now][.]", the whole line, in any case.
 * A line that only mentions the tier's name ("Standard finish not available
 * for this material") does not. Nor does a line that adds a condition
 * ("Fastest is not available for quantities over 50."): whether it applies to
 * the requested quantity or configuration is not established, so it never
 * withdraws a card.
 */
function statesTierUnavailable(line: string, label: string) {
  const name = escapeRegExp(collapseInlineSpace(label).trim()).replaceAll(" ", String.raw`\s+`);
  return new RegExp(
    String.raw`^(?:the\s+)?${name}(?:\s+(?:tier|option))?\s+is\s+(?:currently\s+)?(?:unavailable|not\s+available|not\s+offered)`
      + UNCONDITIONAL_UNAVAILABILITY_TAIL,
    "i",
  ).test(line);
}

/**
 * OVD-1052: what the part card shows beside the tier cards. The whole part
 * card is read, not just the price panel around the cards: a tier card that
 * lost both hooks, or a notice about a tier, can sit anywhere in it.
 * (Loading text and busy elements anywhere in the part card are refused
 * before the cards are read; see collectXometryOffers.)
 *
 * - No element around the shown cards shows the "Price and Lead Time"
 *   heading (locatePricePanel): selector drift (price_panel_unlocated).
 * - A rendered line outside every card with a currency amount or tier timing
 *   (an arrival date, a lead time, business days) is content the cards do not
 *   cover, a tier card whose class and label hook were both renamed, say:
 *   selector drift (wrapper_uncovered_content). Only the static lines every
 *   captured part card shows are exempt from the timing check: the "Price and
 *   Lead Time" heading, and the Repeat Part note's sentence "Pricing and lead
 *   time for Repeat Parts may vary.".
 * - The price panel shows only its heading, the cards and tier notices, as on
 *   every captured quote page. An element in it outside the cards that renders
 *   nothing and encloses no card (a tier still loading in a placeholder that
 *   lacks the card's class, say) is selector drift (price_panel_unrecognized),
 *   and so is a panel line that is neither the heading nor an unavailability
 *   line ("Show more options", "Choose a tier").
 * - A line in the price panel, outside the cards, that says something is
 *   unavailable withdraws a card only when it names exactly one card's tier,
 *   as a whole word, says that tier is unavailable as its subject and without
 *   a condition (statesTierUnavailable: "Fastest is not available for this
 *   part."), and that card shows no price and timing (showsPriceAndTiming)
 *   unless a marker already withdrew it. A line with a condition ("Fastest is
 *   not available for quantities over 50.") need not apply to the requested
 *   quantity, so it never withdraws a card, priced or not:
 *   availability_ambiguous. A card that shows its price and timing is a tier
 *   the page still quotes, so a line that would withdraw it is
 *   availability_ambiguous too. Any other unavailability line in the panel
 *   ("Standard finish not available for this material", "Standard and Fastest
 *   are not available") is availability_ambiguous too. So is every
 *   unavailability line elsewhere in the part card: it sits beside the part's
 *   configuration, where a tier's name can also be a requirement's value
 *   ("Finish: Standard"), so "Standard is not available for this material."
 *   there need not mean the Standard tier. A line with timing or an amount
 *   fails the second check even when it also names one tier.
 *
 * Text outside the part card (the order summary's own arrival date, say) is
 * never read here.
 */
async function checkPartCard(
  partCard: Locator,
  cards: Locator,
  cardTexts: readonly string[],
  shownCards: readonly number[],
  snapshots: readonly XometryOfferSnapshot[],
) {
  const located = await locatePricePanel(cards, cardTexts, shownCards);
  if (located.kind === "unlocated") {
    throw ambiguousCardError("price_panel_unlocated", { tierCards: cardTexts.length, pricePanelHeadings: 0 });
  }
  const partCardText = located.kind === "unreadable" ? null : await partCard.innerText().catch(() => null);
  const otherLines = located.kind === "unreadable" || partCardText === null
    ? null
    : linesOutside(partCardText, [located.panelText]);
  if (located.kind === "unreadable" || otherLines === null) {
    throw ambiguousCardError("shape_unreadable", { tierCards: cardTexts.length, partCardLines: null });
  }
  const { panel, panelLines } = located;
  const lines = [...otherLines, ...panelLines];

  const uncovered = lines.filter(showsTierContent);
  if (uncovered.length > 0) {
    throw ambiguousCardError("wrapper_uncovered_content", {
      partCardLines: lines.length,
      uncoveredPartCardLines: uncovered.length,
    });
  }

  const placeholders = await countPanelPlaceholders(panel);
  if (placeholders === null) {
    throw ambiguousCardError("shape_unreadable", { tierCards: cardTexts.length, pricePanelPlaceholders: null });
  }
  const unrecognizedLines = panelLines.filter((line) => !PRICE_PANEL_HEADING.test(line) && !UNAVAILABLE_TEXT.test(line));
  if (placeholders > 0 || unrecognizedLines.length > 0) {
    throw ambiguousCardError("price_panel_unrecognized", {
      pricePanelLines: panelLines.length,
      unrecognizedPricePanelLines: unrecognizedLines.length,
      pricePanelPlaceholders: placeholders,
    });
  }

  const unavailableLines = [
    ...otherLines.map((line) => ({ line, inPanel: false })),
    ...panelLines.map((line) => ({ line, inPanel: true })),
  ].filter(({ line }) => UNAVAILABLE_TEXT.test(line));
  if (unavailableLines.length === 0) return;
  const headerLabels = snapshots
    .map((snapshot) => parseTierHeaderLabel(snapshot)?.toLowerCase())
    .filter((label): label is string => Boolean(label));
  const sharedHeaderLabels = new Set(headerLabels.filter((label, index) => headerLabels.indexOf(label) !== index));
  const tierLabels = snapshots.map((snapshot) => parseProviderLabel(snapshot, sharedHeaderLabels));
  for (const { line, inPanel } of unavailableLines) {
    const named = snapshots.flatMap((snapshot, index) => {
      const label = tierLabels[index];
      return label !== null && namesTier(line, label) ? [{ snapshot, label }] : [];
    });
    const withdrawsPricedCard = named.length === 1
      && showsPriceAndTiming(named[0].snapshot.text)
      && !isWithdrawn(named[0].snapshot);
    if (!inPanel || named.length !== 1 || !statesTierUnavailable(line, named[0].label) || withdrawsPricedCard) {
      throw ambiguousCardError("availability_ambiguous", {
        partCardUnavailableLines: unavailableLines.length,
        unavailableLinesOutsidePricePanel: unavailableLines.filter((unavailable) => !unavailable.inPanel).length,
        namedTierCards: named.length,
        namedPricedTierCards: withdrawsPricedCard ? 1 : 0,
      });
    }
    named[0].snapshot.withdrawn = true;
  }
}

/** What the adapter knows about the quote page's pricing before collection. */
export type XometryPriceReadiness = {
  /** Exact uploaded names, so spaces in a filename cannot look like status text. */
  fileNames?: string[];
  /**
   * False when xometryPriceTiersSettled timed out: some available tier card
   * never showed both a price and timing, or the part card kept showing
   * something the collector refuses (a busy mark, a placeholder), so the cards
   * are not published.
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
 * - Cards that do not all sit in one part card: selector drift
 *   (part_card_unbounded).
 * - A card whose text, label count or nesting cannot be read, that holds
 *   another card, or that renders more than one tier label: selector drift.
 * - A part card the page marks busy (aria-busy on it or around it, or a
 *   shown busy region, progress indicator, spinner or placeholder skeleton in
 *   it), or whose rendered text says it is loading, saving or re-pricing
 *   anywhere, cards included (PART_CARD_LOADING_TEXT): pending.
 * - A card the page hides (isHiddenByPage) is skipped when it is a copy of a
 *   card the page shows (the same text content, ignoring whitespace). When
 *   every card is hidden, no tier is on screen yet: pending. Any other hidden
 *   card may be a tier the page keeps off screen: availability_ambiguous.
 * - A blank card is still being priced: pending, whatever marks it or an
 *   enclosing element carries (a design-system card can render disabled
 *   until it is priced).
 * - A card that shows text but no price and timing is withdrawn only when its
 *   text says it is unavailable, or a price-panel line says its tier is
 *   (checkPartCard). A disabled mark on it, around it or in it says nothing:
 *   such a card is a tier still being priced, which the settle wait waits
 *   for and a timed-out wait refuses as pending.
 * - A card that shows its price and timing is never withdrawn by its text, a
 *   control in it or a panel line (availability_ambiguous). An availability
 *   marker on it or on an enclosing element in its part card (markers that
 *   cannot be read fail closed) withdraws it only when no card is left to
 *   publish, as when the page disables the whole price panel; beside a card
 *   that is still published it is availability_ambiguous, as a marked card
 *   can be the selected tier rendered as a disabled radio.
 * - Every rendered tier label on the page must sit in a card; one outside
 *   them all means the cards may not be every tier: selector drift.
 * - The part card around the cards must show the price panel's heading
 *   around them, no tier timing or amount outside them, the price panel
 *   nothing but its heading, the cards and tier notices, and a tier a notice
 *   there withdraws is excluded only when its card shows no price and timing
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
  const located = await locatePartCard(cards, cardCount);
  if (located.kind === "unbounded") throw ambiguousCardError("part_card_unbounded", { tierCards: cardCount });
  if (located.kind === "unreadable") throw ambiguousCardError("shape_unreadable", { tierCards: cardCount, partCardLines: null });
  // A part card the page marks busy is still changing: its cards may be stale.
  const busy = await isPartCardBusy(located.partCard);
  if (busy === null) throw ambiguousCardError("shape_unreadable", { tierCards: cardCount, partCardBusy: null });
  if (busy) throw pricePendingError("pricing_in_progress");
  // So is a part card that says it is loading, saving or re-pricing anywhere,
  // in the cards or beside them.
  const partCardText = await located.partCard.innerText().catch(() => null);
  if (partCardText === null) throw ambiguousCardError("shape_unreadable", { tierCards: cardCount, partCardLines: null });
  if (showsLoadingText(partCardText, readiness.fileNames ?? [])) throw pricePendingError("pricing_in_progress");

  const snapshots: XometryOfferSnapshot[] = [];
  const observedSnapshots: XometryOfferSnapshot[] | undefined = observer ? [] : undefined;
  /** Every card's rendered text, in page order, blank cards included. */
  const cardTexts: string[] = [];
  /** The index of every card the page shows, in page order. */
  const shownCards: number[] = [];
  /** Each priced card an availability marker withdrew, as its index. */
  const markedPricedCards: number[] = [];
  for (let index = 0; index < cardCount; index += 1) {
    const card = cards.nth(index);
    if (await isHiddenByPage(card)) {
      cardTexts.push("");
      continue;
    }
    shownCards.push(index);
    const renderedText = await card.innerText().catch(() => null);
    if (renderedText === null) {
      throw ambiguousCardError("shape_unreadable", { nestedTierCards: null, visibleTierLabels: null }, index);
    }
    const text = renderedText.trim();
    cardTexts.push(text);
    // A blank card is a skeleton still being priced, not an absent tier,
    // whatever marks it carries: a design-system card can render disabled
    // until it is priced, and so can its controls.
    if (!text) throw pricePendingError("tier_card_blank", index);

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
    // The collector decides availability from the whole page (the snapshot's
    // withdrawn flag). Preserve actual card attributes separately instead of
    // presenting derived flags as DOM. One extra record is a bounded overflow
    // sentinel; the factory refuses the whole observation rather than
    // publishing a truncated document set.
    const observedAttributes = observedSnapshots && observedSnapshots.length <= XOMETRY_OBSERVATION_LIMITS.documents
      ? { ...attributes }
      : undefined;
    const statesUnavailable = UNAVAILABLE_TEXT.test(text);
    // A card that shows no price and timing is withdrawn only by its text: a
    // disabled mark on it, around it or in it can be a tier still loading.
    let withdrawn = statesUnavailable;
    if (showsPriceAndTiming(text)) {
      // A card whose availability the page cannot answer is never presented as available.
      const marked = await isCardOrAncestorMarkedUnavailable(card);
      const disabledDescendants = await countOrNull(card.locator(DISABLED_DESCENDANT_SELECTOR));
      if (marked === null || disabledDescendants === null) {
        throw ambiguousCardError("availability_ambiguous", facts, index);
      }
      // A card that shows its price and timing is a tier the page quotes: a
      // note in it ("Weekend delivery not available.") or a disabled control
      // (the selected tier's button) need not mean the tier is withdrawn.
      if (!marked && (disabledDescendants > 0 || statesUnavailable)) {
        throw ambiguousCardError("availability_ambiguous", {
          ...facts,
          disabledDescendants,
          unavailabilityText: statesUnavailable ? 1 : 0,
        }, index);
      }
      // A mark on it or around it withdraws it only with every other card
      // (checked once every card is read).
      withdrawn = marked;
      if (marked) markedPricedCards.push(index);
    }
    const listPriceText = await readListPriceText(card);
    snapshots.push({
      selector: PRICE_TIER_CARD_SELECTOR,
      text,
      tierText: tierText || undefined,
      ...(listPriceText === undefined ? {} : { listPriceText }),
      attributes,
      withdrawn,
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
  if (shownCards.length === 0) throw pricePendingError("price_tier_cards_absent");
  // A hidden card is skipped only as a copy of a card the page shows. Any
  // other (a tier a tabbed or carousel layout keeps off screen, a fourth tier
  // behind a "Show more" control) may be a tier the customer can still buy.
  if (shownCards.length < cardCount) {
    const shownContents = new Set<string>();
    const hiddenContents: string[] = [];
    for (let index = 0; index < cardCount; index += 1) {
      const content = await readCardContent(cards.nth(index));
      if (content === null) throw ambiguousCardError("shape_unreadable", { tierCards: cardCount, hiddenTierCards: null }, index);
      if (shownCards.includes(index)) shownContents.add(content);
      else hiddenContents.push(content);
    }
    const unmatched = hiddenContents.filter((content) => !shownContents.has(content)).length;
    if (unmatched > 0) {
      throw ambiguousCardError("availability_ambiguous", {
        hiddenTierCards: hiddenContents.length,
        unmatchedHiddenTierCards: unmatched,
      });
    }
  }

  // A tier label the cards do not hold is a tier this collector cannot see.
  const pageTierLabels = await countOrNull(page.locator(VISIBLE_TIER_LABEL_SELECTOR));
  const cardTierLabels = await countOrNull(page.locator(CARD_TIER_LABEL_SELECTOR));
  const coverage = { visibleTierLabels: pageTierLabels, coveredTierLabels: cardTierLabels };
  if (pageTierLabels === null || cardTierLabels === null) throw ambiguousCardError("shape_unreadable", coverage);
  if (pageTierLabels > cardTierLabels) throw ambiguousCardError("wrapper_uncovered_content", coverage);
  await checkPartCard(located.partCard, cards, cardTexts, shownCards, snapshots);

  // Never publish the cards that did render as the complete set. When every
  // card is unavailable the settle wait cannot succeed, and nothing is published.
  const availableCards = snapshots.filter((snapshot) => !isWithdrawn(snapshot)).length;
  if (!readiness.priceTiersSettled && availableCards > 0) {
    throw pricePendingError("price_tiers_unsettled");
  }
  // A priced card a marker withdrew while another card is still published
  // may be the selected tier, not a withdrawn one (a checked radio marked
  // aria-disabled, say), so the rest is not the complete option set.
  if (markedPricedCards.length > 0 && availableCards > 0) {
    throw ambiguousCardError("availability_ambiguous", {
      markedPricedTierCards: markedPricedCards.length,
      availableTierCards: availableCards,
    }, markedPricedCards[0]);
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
