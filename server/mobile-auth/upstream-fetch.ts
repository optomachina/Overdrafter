export const MOBILE_AUTH_UPSTREAM_TIMEOUT_MS = 8_000;

type FetchImplementation = typeof globalThis.fetch;

/**
 * Bounds every Supabase HTTP operation below the Vercel function duration.
 * Caller cancellation is preserved and the timer is always released.
 */
export function createMobileAuthUpstreamFetch(
  timeoutMilliseconds = MOBILE_AUTH_UPSTREAM_TIMEOUT_MS,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): FetchImplementation {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 60_000
  ) {
    throw new Error("The mobile authentication upstream timeout is invalid.");
  }

  return async (input, init) => {
    const controller = new AbortController();
    const callerSignal = init?.signal;
    const abortFromCaller = () => {
      controller.abort(callerSignal?.reason);
    };

    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    const timeout = setTimeout(() => {
      controller.abort(new Error("Mobile authentication upstream deadline exceeded."));
    }, timeoutMilliseconds);

    try {
      return await fetchImplementation(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}
