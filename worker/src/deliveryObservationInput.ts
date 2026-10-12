/**
 * Structural match for `ProviderDeliveryObservation` in
 * `shared/delivered-cost-arrival.ts` (OVD-569), kept local so the worker build
 * does not import across the repository root.
 */
export type DeliveryObservationInput = {
  offerId: string;
  provider: string;
  partsSubtotalUsd: number | null;
  feesUsd: number | null;
  taxUsd: number | null;
  shippingOptions: readonly never[];
  leadTime: { kind: "business_days"; businessDays: number } | { kind: "unknown" };
  orderCutoffLocalTime: string | null;
  validUntil: string | null;
  invalidatedAt: string | null;
};
