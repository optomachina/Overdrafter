import type { VendorQuoteAdapterInput } from "./types.js";

export const PROVIDER_ABORTED = "provider_aborted" as const;

/**
 * OVD-748: the worker's dispatch or lease layer withdrew the run (permit
 * expiry, lost session lease). Thrown at an adapter safe point, before the
 * next provider facing step. It is a stop decision, not a provider failure:
 * adapters rethrow it unchanged, it never feeds a block or day switch, and it
 * is never retried.
 */
export class ProviderAbortedError extends Error {
  readonly code = PROVIDER_ABORTED;
  constructor(public readonly checkpoint: string) {
    super(`The provider run was aborted before ${checkpoint}.`);
    this.name = "ProviderAbortedError";
  }
}

export function throwIfProviderAborted(signal: AbortSignal | undefined, checkpoint: string): void {
  if (signal?.aborted) throw new ProviderAbortedError(checkpoint);
}

type Checkpoint = NonNullable<VendorQuoteAdapterInput["providerKillSwitchCheckpoint"]>;

/** Checks the signal before and after the wrapped checkpoint, which may take a network round trip. */
export function abortAwareCheckpoint(checkpoint: Checkpoint | undefined, signal: AbortSignal | undefined): Checkpoint | undefined {
  if (!signal) return checkpoint;
  return async (name) => {
    throwIfProviderAborted(signal, name);
    await checkpoint?.(name);
    throwIfProviderAborted(signal, name);
  };
}

/**
 * Binds the signal to the adapter input. Adapters already call the checkpoint
 * before each navigation, upload, configure and save step, so they stop at
 * those same points without per adapter plumbing. Returns the input unchanged
 * when there is no signal.
 */
export function withProviderAbortSignal(
  input: VendorQuoteAdapterInput,
  signal: AbortSignal | undefined,
): VendorQuoteAdapterInput {
  if (!signal) return input;
  const combined = input.signal ? AbortSignal.any([input.signal, signal]) : signal;
  return {
    ...input,
    signal: combined,
    providerKillSwitchCheckpoint: abortAwareCheckpoint(input.providerKillSwitchCheckpoint, combined),
  };
}
