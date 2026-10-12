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
  // Internal hostnames: cluster and private DNS suffixes (not followed by another label, so a
  // user filename such as housing.local.step is left alone), loopback or RFC 1918 addresses, and the
  // direct Supabase database host. Public marketing domains and support addresses are not matched.
  /(?:^|[^\w-])[a-z\d](?:[a-z\d.-]{0,60})\.(?:internal|local|localdomain|cluster\.local|svc|corp|lan)(?!\.?[\w-])/i,
  /\bdb\.[a-z\d]{8,40}\.supabase\.co\b/i,
  /(?:^|[^\d.])(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.]*\d)/,
  /\blocalhost:\d{2,5}\b/i,
  // SQL error internals: row values from Postgres DETAIL lines, missing or duplicate schema objects
  // (quoted or bare, including function signatures), and syntax errors.
  /\bKey \([^)]{1,80}\)=\([^)]{0,200}\)/,
  /\b(?:relation|column|function|schema|table|constraint) "?[\w.]{1,80}"?(?:\([^)]{0,200}\))? (?:of relation "?[\w.]{1,80}"? )?(?:does not exist|already exists)/i,
  /\bsyntax error at or near\b/i,
  /\bSQLSTATE\b/,
  // SQL statement text, matched by shape (column list plus a qualified or filtered relation) so
  // ordinary copy such as "Select a part from the list" or "Delete from this project" is kept.
  /\bselect\s+(?:\*|[\w."()]{1,80}(?:\s*,\s*[\w."()]{1,80}){0,10})\s+from\s+(?:"[^"]{1,80}"|\w{1,60}\.\w{1,60}|\w{1,60}\s+(?:where|limit|order|join|group)\b)/i,
  /\binsert\s+into\s+(?:"[^"]{1,80}"|\w{1,60}\.\w{1,60}|\w{1,60}\s*\()/i,
  /\bupdate\s+(?:"[^"]{1,80}"|[\w.]{1,80})\s+set\s+\w{1,60}\s*=/i,
  /\bdelete\s+from\s+(?:"[^"]{1,80}"|\w{1,60}\.\w{1,60}|\w{1,60}\s+where\b)/i,
  // Stripe style secret keys and webhook signing secrets.
  /(?:^|[^\w])(?:sk|rk)_(?:live|test)_/,
  /(?:^|[^\w])whsec_/,
  // Firefox and Safari stack frames: "fn@https://x.invalid/a.js:1:2".
  /(?:^|[^\w$])[\w$.<>/-]{0,80}@(?:https?:\/\/|file:\/\/|\/)[^\s@]{1,200}:\d+:\d+/,
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

  // A record without a string message is never serialized into customer copy: nested payloads such
  // as Stripe payment intents carry client secrets, so the caller's fixed fallback applies.
  seen.delete(error);
  return null;
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
