import type { Locator, Page } from "patchright";
import {
  VendorAutomationError,
  type GeographicOrigin,
  type VendorQuoteAdapterOffer,
} from "../types.js";
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
 * Foreign/ambiguous observations stay in error evidence, never USD comparisons.
 */
const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

function currencyEvidence(text: string) {
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
  const amounts = [...text.matchAll(/\$\s*[\d,]+(?:\.\d+)?/g)];
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
    if (!codes.length) { observed.add("unknown"); trusted = false; }
    for (const code of [...codes, ...lineCodes]) { observed.add(code); if (code !== "USD") trusted = false; }
  }
  for (const [symbol, code] of [["€", "EUR"], ["£", "GBP"], ["¥", "JPY_or_CNY"]]) {
    if (text.includes(symbol)) { observed.add(code); trusted = false; }
  }
  return { trusted: trusted && amounts.length > 0, observedCurrencies: [...observed] };
}

function parsePrices(text: string, requestedQuantity: number) {
  const currencyMatches = [...text.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)];
  if (currencyMatches.length === 0) return null;

  const unitMatch = /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:ea\.?|each|\/\s*ea\.?)/i.exec(text);
  if (unitMatch?.index !== undefined) {
    const unitPriceUsd = parseCurrencyValue(unitMatch[1]);
    const unitMatchEnd = unitMatch.index + unitMatch[0].length;
    const extendedMatch = currencyMatches.find((match) => (match.index ?? 0) >= unitMatchEnd);
    const totalPriceUsd = extendedMatch ? parseCurrencyValue(extendedMatch[1]) : null;
    if (unitPriceUsd === null || totalPriceUsd === null) return null;
    return { unitPriceUsd, totalPriceUsd };
  }

  if (currencyMatches.length !== 1) return null;
  const totalPriceUsd = parseCurrencyValue(currencyMatches[0][1]);
  if (totalPriceUsd === null) return null;
  return {
    unitPriceUsd: Math.round((totalPriceUsd / requestedQuantity) * 100) / 100,
    totalPriceUsd,
  };
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

function isExplicitlyUnavailable(snapshot: XometryOfferSnapshot) {
  const disabled = snapshot.attributes.disabled !== undefined
    || snapshot.attributes["aria-disabled"]?.toLowerCase() === "true"
    || snapshot.attributes["data-disabled"]?.toLowerCase() === "true"
    || snapshot.attributes["data-available"]?.toLowerCase() === "false";
  const unavailableText = /\b(?:unavailable|not\s+available|not\s+offered|cannot\s+quote|can't\s+quote)\b/i.test(
    snapshot.text,
  );
  return disabled || unavailableText;
}

function parseProviderLabel(snapshot: XometryOfferSnapshot) {
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
 * partially parsed provider response cannot be presented as complete.
 */
export function parseXometryOfferSnapshots(input: {
  snapshots: XometryOfferSnapshot[];
  requestedQuantity: number;
  quoteUrl: string;
}): VendorQuoteAdapterOffer[] {
  const availableSnapshots = input.snapshots.filter((snapshot) => !isExplicitlyUnavailable(snapshot));
  const offers = availableSnapshots.map((snapshot, index) => {
    const currency = currencyEvidence(snapshot.text);
    if (!currency.trusted && currency.observedCurrencies.length > 0) {
      throw new VendorAutomationError(
        "A Xometry option did not establish exclusively USD prices.",
        "unexpected_ui_state",
        { vendor: "xometry", reason: "xometry_offer_currency_untrusted",
          containerSelector: snapshot.selector, optionIndex: index,
          observedCurrencies: currency.observedCurrencies,
          providerText: snapshot.text.slice(0, 1000) },
      );
    }
    const prices = parsePrices(snapshot.text, input.requestedQuantity);
    if (prices === null) {
      throw new VendorAutomationError(
        "A Xometry option container did not expose an anchored price.",
        "selector_failure",
        {
          vendor: "xometry",
          reason: "xometry_offer_price_missing",
          containerSelector: snapshot.selector,
          optionIndex: index,
        },
      );
    }

    const providerLabel = parseProviderLabel(snapshot)
      ?? (availableSnapshots.length === 1 ? "Xometry option" : null);
    if (providerLabel === null) {
      throw new VendorAutomationError(
        "A Xometry option did not expose a stable manufacturing tier.",
        "selector_failure",
        {
          vendor: "xometry",
          reason: "xometry_offer_tier_missing",
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

/** Collect every distinct supported Xometry tier container in provider order. */
export async function collectXometryOffers(
  page: Page,
  requestedQuantity: number,
  observer?: XometryProviderObserver,
) {
  const snapshots: XometryOfferSnapshot[] = [];
  const observedSnapshots: XometryOfferSnapshot[] | undefined = observer ? [] : undefined;
  const seen = new Set<string>();

  for (const selector of XOMETRY_LOCATORS.offerContainers) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const option = locator.nth(index);
      const text = (await option.innerText().catch(() => "")).trim();
      if (!text) continue;
      const tierText = (await option
        .locator('[data-testid="tierAndLeadTime"]')
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
      const hasDisabledDescendant = await option
        .locator('[disabled], [aria-disabled="true"], [data-disabled="true"]')
        .count()
        .then((value) => value > 0)
        .catch(() => false);
      if (hasDisabledDescendant) {
        attributes["data-disabled"] = "true";
      }
      const fingerprint = `${attributes["data-option-id"] ?? attributes.id ?? ""}\n${text}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      snapshots.push({ selector, text, tierText: tierText || undefined, attributes });
      if (observedSnapshots && observedAttributes) {
        observedSnapshots.push({ selector, text, tierText: tierText || undefined, attributes: observedAttributes });
      }
    }
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
