/**
 * Compile time contract (OVD-463): the worker validator's delivery observation
 * must stay assignable to the OVD-569 `ProviderDeliveryObservation`. This file
 * lives under `shared/` because the worker build emits from `worker/src` and
 * must not pull `shared/` into its output root. `npm run typecheck` covers it.
 */
import type { DeliveryObservationInput } from "../worker/src/providerResultValidation";
import type { ProviderDeliveryObservation } from "./delivered-cost-arrival";

type Assert<T extends true> = T;
type AssignableToProjectionInput = DeliveryObservationInput extends ProviderDeliveryObservation ? true : false;
type SameKeys = keyof DeliveryObservationInput extends keyof ProviderDeliveryObservation
  ? keyof ProviderDeliveryObservation extends keyof DeliveryObservationInput
    ? true
    : false
  : false;

export type ProviderResultFeedsProjection = Assert<AssignableToProjectionInput>;
export type ProviderResultFeedKeysMatch = Assert<SameKeys>;
