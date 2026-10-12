import type {
  ProviderDeliveryObservation,
  ProviderLeadTime,
} from "../../../shared/delivered-cost-arrival";
import {
  resolveOfferFixedDeliveryDate,
  type ClientQuoteSelectionOption,
} from "@/features/quotes/selection";

/**
 * Maps a client quote option to the OVD-569 provider observation. Only
 * provider-stated values are carried over; the current offer model has no
 * tax, fee, shipping or cutoff fields, so those stay unknown.
 */
export function toProviderDeliveryObservation(
  option: ClientQuoteSelectionOption,
  input: { referenceDate: Date },
): ProviderDeliveryObservation {
  return {
    offerId: option.persistedOfferId ?? option.offerId,
    provider: option.vendorKey,
    partsSubtotalUsd: option.totalPriceUsd,
    feesUsd: null,
    taxUsd: null,
    shippingOptions: [],
    leadTime: resolveLeadTime(option, input.referenceDate),
    orderCutoffLocalTime: null,
    validUntil: option.validUntil ?? null,
    invalidatedAt: option.invalidatedAt ?? null,
  };
}

function resolveLeadTime(option: ClientQuoteSelectionOption, referenceDate: Date): ProviderLeadTime {
  const fixedDate = resolveOfferFixedDeliveryDate({
    shipReceiveBy: option.shipReceiveBy,
    dueDate: option.dueDate,
    now: referenceDate,
  });
  if (fixedDate) {
    return { kind: "fixed_delivery_date", date: fixedDate };
  }
  return option.leadTimeBusinessDays === null
    ? { kind: "unknown" }
    : { kind: "business_days", businessDays: option.leadTimeBusinessDays };
}
