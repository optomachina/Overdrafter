export const DEFAULT_AUTHENTICATED_REDIRECT = "/";

/**
 * Only allow same-origin app paths so auth flows cannot be used as an open
 * redirect. Empty, malformed, and protocol-relative values fall back to "/".
 */
export function sanitizeInternalRedirect(
  value: string | null | undefined,
  fallback = DEFAULT_AUTHENTICATED_REDIRECT,
): string {
  if (!value) {
    return fallback;
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  return value;
}
