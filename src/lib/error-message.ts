type ErrorDetails = {
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
  statusText?: unknown;
};

export const GENERIC_ERROR_MESSAGE = "Something went wrong.";

/**
 * Customer-visible error text must never carry credentials, saved browser sessions or stack
 * frames. A final message matching any pattern is replaced by the caller's fallback.
 * Email addresses (approved support copy) and ordinary PostgREST summaries are deliberately
 * not matched. Every pattern stays linear-time on long server-provided text: token starts are
 * anchored to a non-token character and repetitions are bounded.
 */
export const DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  // JWT-shaped tokens such as access tokens or legacy API keys: a base64url JSON header and another segment.
  /(?:^|[^\w-])eyJ[\w-]{5,}\.[\w-]{5,}/,
  // The service-role database identity or JWT claim. Case-sensitive, so configuration names in
  // existing operator copy (SUPABASE_SERVICE_ROLE_KEY) are not treated as credentials.
  /service_role/,
  // Supabase secret API keys.
  /sb_secret_/,
  // Saved browser auth: Playwright storageState, session token fields, auth storage keys and cookie headers.
  /storageState/,
  /\b(?:access|refresh|provider_refresh|provider)_token\b/,
  /(?:^|[^\w-])sb-[a-z\d-]{1,63}-auth-token\b/i,
  /\b(?:set-)?cookie\s*:\s*[^\s=;]+=/i,
  // V8 stack frames with a path or URL: "at fn (https://x.invalid/a.js:1:2)" or "at /srv/app.ts:12:3".
  /\bat (?:[^\s()]+ ){0,4}\(?(?:[^\s()/\\]*[/\\])+[^\s()/\\:]*:\d+:\d+/,
]);

export function containsSensitiveErrorDetail(text: string): boolean {
  return DENY_PATTERNS.some((pattern) => pattern.test(text));
}

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

  if (isOpaqueSerializedRecord(trimmed)) {
    return null;
  }

  return trimmed;
}

function isOpaqueSerializedRecord(value: string): boolean {
  if (!value.startsWith("{") || !value.endsWith("}")) {
    return false;
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) && hasOnlyOpaqueStorageMarkers(parsed);
  } catch {
    return false;
  }
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

/**
 * `hasOnlyOpaqueStorageMarkers` detects records that contain only opaque storage error markers.
 * The input is expected to be a record that may include optional metadata, but it is considered
 * opaque/suppressed only when its keys are limited to `"name"` and `"__isStorageError"`.
 * Returns `true` when the record should be treated as an opaque/suppressed storage error.
 */
function hasOnlyOpaqueStorageMarkers(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);

  if (keys.length === 0) {
    return false;
  }

  return keys.every((key) => key === "name" || key === "__isStorageError");
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

  if (hasOnlyOpaqueStorageMarkers(compacted)) {
    return null;
  }

  return safeJsonStringify(compacted);
}

function getMessageCandidate(error: unknown): string | null {
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

  return null;
}

export function getUserFacingErrorMessage(error: unknown, fallback = GENERIC_ERROR_MESSAGE): string {
  const message = getMessageCandidate(error);
  return message === null || containsSensitiveErrorDetail(message) ? fallback : message;
}

export function toUserFacingError(
  error: unknown,
  fallback = GENERIC_ERROR_MESSAGE,
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
