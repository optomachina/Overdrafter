export const MOBILE_AUTH_PROVIDER_ERRORS = [
  "access_denied",
  "invalid_request",
  "server_error",
  "temporarily_unavailable",
] as const;

export type MobileAuthProviderError = (typeof MOBILE_AUTH_PROVIDER_ERRORS)[number];

const MOBILE_AUTH_PROVIDER_ERROR_SET: ReadonlySet<string> = new Set(
  MOBILE_AUTH_PROVIDER_ERRORS,
);

/**
 * Narrows untrusted callback data to the provider errors allowed by the mobile-auth contract.
 */
export function isMobileAuthProviderError(
  value: unknown,
): value is MobileAuthProviderError {
  return (
    typeof value === "string" &&
    MOBILE_AUTH_PROVIDER_ERROR_SET.has(value)
  );
}
