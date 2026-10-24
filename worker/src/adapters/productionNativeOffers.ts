import type { LocalEvidenceCurrency, LocalNativeCurrencyOffer } from "./localEvaluationResult.js";
import type { ProviderPortalNormalizedOffer } from "./providerPortalKernel.js";

/**
 * OVD-675 production disposition of a native-money offer batch. There is no
 * reviewed exchange-rate source, so nothing is converted:
 *
 * - a batch the provider itself priced in USD (per-option ISO anchor) becomes
 *   ordinary comparable USD offers, unchanged in value;
 * - any other currency (EUR, GBP) stays native and is explicitly non-comparable. It
 *   is recorded as evidence and never reaches a USD field.
 *
 * Mixed or empty batches return null; the caller treats that as drift.
 */
export const PRODUCTION_NATIVE_OFFER_REVISION = "production-native-offer.v1" as const;

export type ProductionNativeOfferDisposition =
  | { comparable: true; currency: "USD"; offers: ProviderPortalNormalizedOffer[] }
  | {
    comparable: false;
    currency: Exclude<LocalEvidenceCurrency, "USD">;
    reason: "native_currency_not_comparable";
    offers: LocalNativeCurrencyOffer[];
  };

export function productionNativeOfferDisposition(
  offers: readonly LocalNativeCurrencyOffer[],
): ProductionNativeOfferDisposition | null {
  const currencies = new Set(offers.map((offer) => offer.money.currency));
  if (offers.length === 0 || currencies.size !== 1) return null;
  const [currency] = currencies;
  if (currency !== "USD") {
    return {
      comparable: false,
      currency,
      reason: "native_currency_not_comparable",
      offers: structuredClone([...offers]),
    };
  }
  return {
    comparable: true,
    currency,
    offers: offers.map((offer, index) => ({
      providerOptionId: offer.providerOptionId,
      providerLabel: offer.providerLabel,
      quoteRef: null,
      quoteUrl: null,
      quantity: offer.quantity,
      unitPriceUsd: offer.money.unitAmount,
      totalPriceUsd: offer.money.totalAmount,
      leadTimeBusinessDays: offer.leadTimeBusinessDays,
      shipReceiveBy: offer.shipReceiveBy,
      tier: offer.tier,
      sourcing: offer.sourcing,
      geographicOrigin: offer.geographicOrigin,
      sortRank: index,
      provenance: {
        containerSelector: offer.provenance.containerSelector,
        providerOptionIdSource: offer.provenance.providerOptionIdSource,
        priceSource: "selector",
        leadTimeSource: offer.provenance.leadTimeSource,
        geographicOriginSource: offer.provenance.geographicOriginSource,
      },
      validUntil: offer.validUntil,
      validityDurationDays: offer.validityDurationDays,
      validitySource: offer.validitySource,
      validityTerms: offer.validityTerms,
      artifactRefs: [...offer.artifactRefs],
      rawPayload: {
        normalizationRevision: "provider-offer-evidence.v1",
        nativeOfferRevision: PRODUCTION_NATIVE_OFFER_REVISION,
        anchoredFields: ["provider_option_id", "unit_price", "total_price", "currency"],
        anchoredCurrency: "USD",
        currencyConversion: "none",
        leadTimeAnchored: offer.provenance.leadTimeSource === "selector",
        geographicOriginKnown: offer.geographicOrigin !== "unknown",
        validityKnown: offer.validitySource !== null,
      },
    })),
  };
}
