export const MAX_WORKER_ERROR_MESSAGE_LENGTH = 1_000;
export const UNKNOWN_WORKER_ERROR_MESSAGE = "Unexpected worker error.";

function boundMessage(value: string) {
  if (value.trim().length === 0) {
    return UNKNOWN_WORKER_ERROR_MESSAGE;
  }

  return value.slice(0, MAX_WORKER_ERROR_MESSAGE_LENGTH);
}

/**
 * Produces the bounded message persisted for a worker failure without
 * serializing arbitrary thrown objects. Supabase and PostgREST can reject with
 * plain objects whose own `message` field is still the useful diagnostic.
 */
export function summarizeWorkerError(error: unknown): string {
  if (typeof error === "string") {
    return boundMessage(error);
  }

  if (error && typeof error === "object" && !Array.isArray(error)) {
    try {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") {
        return boundMessage(message);
      }
    } catch {
      return UNKNOWN_WORKER_ERROR_MESSAGE;
    }
  }

  return UNKNOWN_WORKER_ERROR_MESSAGE;
}

/** Returns a bounded error name without trusting object accessors. */
export function summarizeWorkerErrorName(error: unknown): string {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    try {
      const name = (error as { name?: unknown }).name;
      if (typeof name === "string" && name.trim().length > 0) {
        return name.slice(0, 100);
      }
    } catch {
      return "Error";
    }
  }

  return "Error";
}

/**
 * Builds the one failure message shared by queue `last_error` and the durable
 * task payload, preventing the two operator evidence surfaces from drifting.
 */
export function buildWorkerTaskFailureEvidence(
  error: unknown,
  failureCode: string,
  retryCount: number,
) {
  const failureMessage = summarizeWorkerError(error);

  return {
    failureMessage,
    runtimeError: {
      name: summarizeWorkerErrorName(error),
      message: failureMessage,
    },
    payload: {
      failureMessage,
      failureCode,
      retryCount,
    },
  };
}
