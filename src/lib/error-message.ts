type ErrorDetails = {
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
  statusText?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeJsonStringify(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized : null;
  } catch {
    return null;
  }
}

export function getUserFacingErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }

    if (typeof error.error_description === "string" && error.error_description.trim()) {
      return error.error_description;
    }

    const serialized = safeJsonStringify(error);
    if (serialized) {
      return serialized;
    }
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }

  return fallback;
}

export function toUserFacingError(
  error: unknown,
  fallback = "Something went wrong.",
): Error & ErrorDetails {
  const wrapped = new Error(getUserFacingErrorMessage(error, fallback)) as Error & ErrorDetails & {
    cause?: unknown;
  };
  wrapped.cause = error;

  if (isRecord(error)) {
    if (typeof error.name === "string" && error.name.trim()) {
      wrapped.name = error.name;
    }

    if ("code" in error) {
      wrapped.code = error.code;
    }
    if ("details" in error) {
      wrapped.details = error.details;
    }
    if ("hint" in error) {
      wrapped.hint = error.hint;
    }
    if ("status" in error) {
      wrapped.status = error.status;
    }
    if ("statusText" in error) {
      wrapped.statusText = error.statusText;
    }
  }

  return wrapped;
}
