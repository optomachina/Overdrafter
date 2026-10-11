import { FICTIV_DISPATCH_ENVELOPE } from "../providerDispatchEnvelope.js";
import type { VendorQuoteAdapterInput } from "../types.js";
import {
  providerDispatchAuthorizationDenial,
  type ProviderDispatchAuthorizationDenial,
} from "./providerDispatchAuthorization.js";

/**
 * OVD-673 adapter-side binding for production Fictiv launches: the shared
 * provider check (`providerDispatchAuthorization.ts`) bound to the reviewed
 * Fictiv envelope.
 */
export type FictivDispatchAuthorizationDenial = ProviderDispatchAuthorizationDenial;

export function fictivDispatchAuthorizationDenial(
  input: VendorQuoteAdapterInput,
  nowMs: number = Date.now(),
): FictivDispatchAuthorizationDenial | null {
  return providerDispatchAuthorizationDenial(
    input,
    { provider: "fictiv", ...FICTIV_DISPATCH_ENVELOPE },
    nowMs,
  );
}
