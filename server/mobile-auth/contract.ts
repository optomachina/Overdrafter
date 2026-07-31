export const MOBILE_AUTH_CONTRACT_VERSION = "1" as const;
export const MOBILE_AUTH_MESSAGE_VERSION = 1 as const;
export const MOBILE_AUTH_PKCE_METHOD = "S256" as const;

export const MOBILE_AUTH_PATHS = Object.freeze({
  start: "/auth/mobile/start",
  providerCallback: "/auth/mobile/provider-callback",
  complete: "/auth/mobile/complete",
  callback: "/auth/mobile/callback",
  bootstrap: "/auth/mobile/bootstrap",
} as const);

export const MOBILE_AUTH_ASSET_PATHS = Object.freeze({
  ceremony: "/assets/mobile-auth.js",
  providerCallback: "/assets/mobile-auth.js",
  bootstrap: "/assets/mobile-bootstrap.js",
} as const);

export const MOBILE_AUTH_LIMITS = Object.freeze({
  randomSecretBytes: 32,
  randomSecretBase64UrlCharacters: 43,
  nonceBytes: 18,
  transactionIdCharacters: 36,
  browserCookieBytes: 32,
  csrfBytes: 32,
  handoffCodeBytes: 32,
  stateBytes: 32,
  codeVerifierBytes: 32,
  codeChallengeBytes: 32,
  startUrlBytes: 2_048,
  providerCallbackUrlBytes: 8_192,
  completeBodyBytes: 32_768,
  bootstrapBodyBytes: 4_096,
  cookieHeaderBytes: 8_192,
  providerAuthorizationCodeBytes: 4_096,
  accessTokenBytes: 16_384,
  refreshTokenBytes: 8_192,
  providerErrorDescriptionBytes: 512,
  returnRouteBytes: 256,
  retainedKeyVersions: 8,
  envelopePlaintextBytes: 32_768,
  envelopeCiphertextBytes: 32_768,
} as const);

export const MOBILE_AUTH_LIFETIMES = Object.freeze({
  browserSeconds: 10 * 60,
  handoffSeconds: 90,
  handoffDatabaseMaximumSeconds: 120,
  terminalRowSeconds: 7 * 24 * 60 * 60,
  auditSeconds: 30 * 24 * 60 * 60,
  countersAfterExpirySeconds: 60 * 60,
} as const);

export const MOBILE_AUTH_RATE_LIMITS = Object.freeze({
  start: Object.freeze({
    attempts: 20,
    windowSeconds: 10 * 60,
  }),
  bootstrap: Object.freeze({
    attempts: 30,
    windowSeconds: 10 * 60,
  }),
} as const);

export const MOBILE_AUTH_COOKIE_NAME = "__Host-ovd-mobile-auth" as const;
export const MOBILE_AUTH_BOOTSTRAP_HEADER = Object.freeze({
  name: "X-OverDrafter-Mobile-Auth",
  value: "bootstrap-v1",
} as const);

export const MOBILE_AUTH_ERROR_CODES = [
  "mobile_auth_cancelled",
  "mobile_auth_invalid_request",
  "mobile_auth_provider_failed",
  "mobile_auth_network_failed",
  "mobile_auth_state_mismatch",
  "mobile_auth_expired",
  "mobile_auth_replayed",
  "mobile_auth_pkce_failed",
  "mobile_auth_session_invalid",
  "mobile_auth_bootstrap_failed",
  "mobile_auth_logout_failed",
  "mobile_auth_rate_limited",
  "mobile_auth_service_unavailable",
] as const;

export type MobileAuthErrorCode = (typeof MOBILE_AUTH_ERROR_CODES)[number];

export const MOBILE_AUTH_RETRY_INSTRUCTIONS = ["none", "network", "restart", "later"] as const;

export type MobileAuthRetryInstruction = (typeof MOBILE_AUTH_RETRY_INSTRUCTIONS)[number];

export interface MobileAuthMasterKey {
  readonly version: number;
  readonly key: Uint8Array;
}

export interface MobileAuthMasterKeyring {
  readonly currentVersion: number;
  readonly keys: readonly MobileAuthMasterKey[];
}

export type MobileAuthHmacPurpose =
  | "state-lookup"
  | "handoff-lookup"
  | "browser-binding"
  | "csrf-binding"
  | "rate-limit";

export type MobileAuthEnvelopePurpose = "state-envelope" | "session-envelope";

export interface MobileAuthEnvelopeContext {
  readonly transactionId: string;
  readonly pkceChallenge: string;
  readonly callbackOrigin: string;
  readonly callbackPath: typeof MOBILE_AUTH_PATHS.callback;
  readonly returnTo: string;
  readonly expiresAtEpochSeconds: number;
  readonly subjectId?: string;
  readonly sourceSessionId?: string;
}

export interface MobileAuthKeyedDigest {
  readonly algorithm: "HMAC-SHA-256";
  readonly keyVersion: number;
  readonly purpose: MobileAuthHmacPurpose;
  readonly digest: string;
}

export interface MobileAuthEncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: "A256GCM";
  readonly keyVersion: number;
  readonly purpose: MobileAuthEnvelopePurpose;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

export {
  MOBILE_AUTH_PROVIDER_ERRORS,
  type MobileAuthProviderError,
} from "../../shared/mobile-auth-provider-errors";

export interface MobileAuthReadyMessage {
  readonly version: typeof MOBILE_AUTH_MESSAGE_VERSION;
  readonly status: "ready";
  readonly state: string;
  readonly returnTo: string;
}

export interface MobileAuthFailureMessage {
  readonly version: typeof MOBILE_AUTH_MESSAGE_VERSION;
  readonly status: "error";
  readonly state: string;
  readonly code: MobileAuthErrorCode;
  readonly retry: MobileAuthRetryInstruction;
}

export function containsAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;

    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
}
