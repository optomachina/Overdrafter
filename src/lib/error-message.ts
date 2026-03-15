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

function normalizeMessageCandidate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();

  if (lowered === "{}" || lowered === "[object object]" || lowered === "null" || lowered === "undefined") {
    return null;
  }

  return trimmed;
}

function compactRecord(value: Record<string, unknown>, seen: Set<unknown>): Record<string, unknown> {
  if (seen.has(value)) {
    return {};
  }

  seen.add(value);

  const compacted = Object.entries(value).reduce<Record<string, unknown>>((result, [key, entry]) => {
    if (key === "stack") {
      return result;
    }

    const normalizedString = normalizeMessageCandidate(entry);
    if (normalizedString) {
      result[key] = normalizedString;
      return result;
    }

    if (typeof entry === "number" || typeof entry === "boolean") {
      result[key] = entry;
      return result;
    }

    if (Array.isArray(entry) && entry.length > 0) {
      result[key] = entry;
      return result;
    }

    if (isRecord(entry)) {
      const nested = compactRecord(entry, seen);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    }

    return result;
  }, {});

  seen.delete(value);
  return compacted;
}

function safeJsonStringify(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized : null;
  } catch {
    return null;
  }
}

function getRecordErrorMessage(
  error: Record<string, unknown>,
  seen: Set<unknown>,
  options: { allowMetadataMessage?: boolean } = {},
): string | null {
  if (seen.has(error)) {
    return null;
  }

  seen.add(error);

  const directMessage =
    normalizeMessageCandidate(error.message) ??
    normalizeMessageCandidate(error.error_description) ??
    (options.allowMetadataMessage
      ? normalizeMessageCandidate(error.details) ??
        normalizeMessageCandidate(error.hint) ??
        normalizeMessageCandidate(error.statusText)
      : null);

  if (directMessage) {
    seen.delete(error);
    return directMessage;
  }

  const nestedMessage =
    (isRecord(error.cause) ? getRecordErrorMessage(error.cause, seen, options) : null) ??
    (isRecord(error.originalError) ? getRecordErrorMessage(error.originalError, seen, options) : null) ??
    (isRecord(error.error) ? getRecordErrorMessage(error.error, seen, options) : null);

  if (nestedMessage) {
    seen.delete(error);
    return nestedMessage;
  }

  seen.delete(error);
  const compacted = compactRecord(error, new Set(seen));
  const compactedKeys = Object.keys(compacted);

  if (compactedKeys.length === 0) {
    return null;
  }

  if (compactedKeys.length === 1 && compactedKeys[0] === "name") {
    return null;
  }

  return safeJsonStringify(compacted);
}

export function getUserFacingErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  const seen = new Set<unknown>();

  if (error instanceof Error) {
    const errorMessage = normalizeMessageCandidate(error.message);
    if (errorMessage) {
      return errorMessage;
    }

    if (isRecord(error)) {
      const recordMessage = getRecordErrorMessage(error, seen, { allowMetadataMessage: true });
      if (recordMessage) {
        return recordMessage;
      }
    }
  }

  if (isRecord(error)) {
    const recordMessage = getRecordErrorMessage(error, seen);
    if (recordMessage) {
      return recordMessage;
    }
  }

  const stringValue = normalizeMessageCandidate(error);
  if (stringValue) {
    return stringValue;
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
