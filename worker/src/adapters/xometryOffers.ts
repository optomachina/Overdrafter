import type { Locator, Page } from "patchright";
import {
  VendorAutomationError,
  type GeographicOrigin,
  type VendorQuoteAdapterOffer,
} from "../types.js";
import { XOMETRY_LOCATORS } from "./xometryConstraints.js";

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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function parseCurrencyValue(value: string) {
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
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
  const match = /\b(\d{1,4})\s+(?:business|working)\s+days?\b/i.exec(text)
    ?? /\blead\s*time\s*:?\s*(\d{1,4})\s+days?\b/i.exec(text);
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
  const domestic = /\b(?:made\s+in\s+(?:the\s+)?u\.?s\.?a?|united\s+states|domestic|us[- ]only)\b/i.exec(text);
  if (domestic) {
    return { origin: "domestic", sourcing: domestic[0], source: "provider_text" };
  }

  const foreign = /\b(?:made\s+internationally(?:\s+except\s+china)?|international(?:ly)?|overseas|foreign)\b/i.exec(text);
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
    const tierLabel = /^(.+?)\s*-\s*(?:lead\s*time|arrives?\s+by)\b/i.exec(line)?.[1]?.trim();
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
export async function collectXometryOffers(page: Page, requestedQuantity: number) {
  const snapshots: XometryOfferSnapshot[] = [];
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
    }
  }

  return parseXometryOfferSnapshots({
    snapshots,
    requestedQuantity,
    quoteUrl: page.url(),
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
