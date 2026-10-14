import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight.js";
import { XometryDispatchAuthorizationError } from "./xometryDispatchPreflight.js";
import { ExportControlLookupError } from "./exportControl.js";
import { ProviderAbortedError } from "./providerAbort.js";

/**
 * OVD-723: a dispatch authorization or export-control decision raised inside
 * an adapter (by `beforeProviderDisclosure`, right before an upload) is not a
 * portal failure. Adapters rethrow it unchanged so the quote task holds the
 * lane instead of retrying it as navigation or queuing manual follow-up.
 * OVD-748: an abort from the dispatch or lease layer is rethrown the same way.
 */
export function isDispatchDecisionError(error: unknown): error is Error {
  return error instanceof ProviderDispatchAuthorizationError
    || error instanceof XometryDispatchAuthorizationError
    || error instanceof ExportControlLookupError
    || error instanceof ProviderAbortedError;
}
