/** Derived capability ceilings include preparation; they never extend a phase deadline. */
export function diagnosticStageLimits(limits) {
  return {
    replaceMs: limits.preparationMs + limits.mutationMs + limits.readMs,
    executeMs: limits.preparationMs + limits.executionMs,
    restoreMs: limits.preparationMs + limits.mutationMs,
  };
}

/** Fixed error shared across adapters so swallowed transport details cannot permit recovery. */
export function unsettledOperation() { return new Error("diagnostic_operation_unsettled"); }

/**
 * Bound a capability by its own timeout AND its parent's absolute deadline.
 * Abort is not settlement: callers must retain ownership on this fixed error.
 * Late continuations receive an aborted signal and cannot start another child.
 */
export async function runWithinBudget(fn, { timeoutMs, deadlineAt = Infinity, signal, now = Date.now, onUnsettled = () => {} }) {
  const remaining = Math.min(timeoutMs, deadlineAt - now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("diagnostic_budget_exhausted");
  if (signal?.aborted) { onUnsettled(); throw unsettledOperation(); }
  const controller = new AbortController();
  let timer, abort;
  const end = Math.min(deadlineAt, now() + remaining);
  try {
    const timeout = new Promise((_, reject) => {
      abort = () => { onUnsettled(); controller.abort(); reject(unsettledOperation()); };
      timer = setTimeout(abort, remaining);
      signal?.addEventListener("abort", abort, { once: true });
    });
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw unsettledOperation();
        return fn(controller.signal, remaining, end);
      }), timeout,
    ]);
    // Synchronous/event-loop stalls must not evade a timer that has not fired yet.
    if (controller.signal.aborted || now() >= end) { abort(); throw unsettledOperation(); }
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
