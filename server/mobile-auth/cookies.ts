import { randomUUID } from "node:crypto";
import {
  MOBILE_AUTH_CONTRACT_VERSION,
  MOBILE_AUTH_COOKIE_NAME,
  MOBILE_AUTH_LIFETIMES,
  MOBILE_AUTH_LIMITS,
  containsAsciiControlCharacters,
  type MobileAuthKeyedDigest,
  type MobileAuthMasterKeyring,
} from "./contract";
import {
  constantTimeEqual,
  createCurrentHmacDigest,
  createHmacLookupCandidates,
  createRandomBase64Url,
  decodeCanonicalBase64Url,
  verifyHmacDigest,
} from "./crypto";

const COOKIE_VALUE_PREFIX = `v${MOBILE_AUTH_CONTRACT_VERSION}`;
const SAFE_RATE_LIMIT_INPUT_PATTERN = /^[\x20-\x7e]{1,512}$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface MobileAuthBrowserBinding {
  readonly transactionId: string;
  readonly browserSecret: string;
  readonly csrf: string;
}

export interface ParsedMobileAuthCookie {
  readonly transactionId: string;
  readonly browserSecret: string;
}

export interface MobileAuthBindingDigests {
  readonly browser: MobileAuthKeyedDigest;
  readonly csrf: MobileAuthKeyedDigest;
}

export class MobileAuthCookieError extends Error {
  readonly code = "mobile_auth_invalid_request" as const;

  constructor() {
    super("The mobile authentication browser binding is invalid.");
    this.name = "MobileAuthCookieError";
  }
}

function encodeBoundValues(values: readonly string[]): Uint8Array {
  const encoded = values.map((value) => Buffer.from(value, "utf8"));
  const output = Buffer.alloc(
    encoded.reduce((total, value) => total + 4 + value.byteLength, 0),
  );
  let offset = 0;

  for (const value of encoded) {
    output.writeUInt32BE(value.byteLength, offset);
    offset += 4;
    value.copy(output, offset);
    offset += value.byteLength;
  }

  return output;
}

function assertCookieSecret(value: string, byteLength: number): void {
  try {
    decodeCanonicalBase64Url(value, byteLength);
  } catch {
    throw new MobileAuthCookieError();
  }
}

export function createMobileAuthBrowserBinding(): MobileAuthBrowserBinding {
  return Object.freeze({
    transactionId: randomUUID(),
    browserSecret: createRandomBase64Url(MOBILE_AUTH_LIMITS.browserCookieBytes),
    csrf: createRandomBase64Url(MOBILE_AUTH_LIMITS.csrfBytes),
  });
}

export function serializeMobileAuthCookie(
  binding: Pick<MobileAuthBrowserBinding, "transactionId" | "browserSecret">,
): string {
  if (!CANONICAL_UUID_PATTERN.test(binding.transactionId)) {
    throw new MobileAuthCookieError();
  }
  assertCookieSecret(binding.browserSecret, MOBILE_AUTH_LIMITS.browserCookieBytes);
  const value = `${COOKIE_VALUE_PREFIX}.${binding.transactionId}.${binding.browserSecret}`;

  return `${MOBILE_AUTH_COOKIE_NAME}=${value}; Path=/; Max-Age=${MOBILE_AUTH_LIFETIMES.browserSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function serializeExpiredMobileAuthCookie(): string {
  return `${MOBILE_AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
}

function parseMobileAuthCookieValue(value: string): ParsedMobileAuthCookie {
  const parts = value.split(".");

  if (parts.length !== 3 || parts[0] !== COOKIE_VALUE_PREFIX) {
    throw new MobileAuthCookieError();
  }

  if (!CANONICAL_UUID_PATTERN.test(parts[1])) {
    throw new MobileAuthCookieError();
  }
  assertCookieSecret(parts[2], MOBILE_AUTH_LIMITS.browserCookieBytes);

  return Object.freeze({
    transactionId: parts[1],
    browserSecret: parts[2],
  });
}

export function readMobileAuthCookie(
  cookieHeader: string | null | undefined,
): ParsedMobileAuthCookie {
  if (
    !cookieHeader ||
    Buffer.byteLength(cookieHeader, "utf8") > MOBILE_AUTH_LIMITS.cookieHeaderBytes ||
    containsAsciiControlCharacters(cookieHeader)
  ) {
    throw new MobileAuthCookieError();
  }

  let targetValue: string | undefined;

  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.trim();
    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex < 1) {
      throw new MobileAuthCookieError();
    }

    const name = trimmed.slice(0, separatorIndex);

    if (name !== MOBILE_AUTH_COOKIE_NAME) {
      continue;
    }

    if (targetValue !== undefined) {
      throw new MobileAuthCookieError();
    }

    targetValue = trimmed.slice(separatorIndex + 1);
  }

  if (targetValue === undefined) {
    throw new MobileAuthCookieError();
  }

  return parseMobileAuthCookieValue(targetValue);
}

function browserBindingInput(
  transactionId: string,
  browserSecret: string,
): Uint8Array {
  if (!CANONICAL_UUID_PATTERN.test(transactionId)) {
    throw new MobileAuthCookieError();
  }
  assertCookieSecret(browserSecret, MOBILE_AUTH_LIMITS.browserCookieBytes);

  return encodeBoundValues([
    "OverDrafter",
    "mobile-auth",
    MOBILE_AUTH_CONTRACT_VERSION,
    transactionId,
    browserSecret,
  ]);
}

function csrfBindingInput(transactionId: string, csrf: string): Uint8Array {
  if (!CANONICAL_UUID_PATTERN.test(transactionId)) {
    throw new MobileAuthCookieError();
  }
  assertCookieSecret(csrf, MOBILE_AUTH_LIMITS.csrfBytes);

  return encodeBoundValues([
    "OverDrafter",
    "mobile-auth",
    MOBILE_AUTH_CONTRACT_VERSION,
    transactionId,
    csrf,
  ]);
}

export function createMobileAuthBindingDigests(
  keyring: MobileAuthMasterKeyring,
  binding: MobileAuthBrowserBinding,
): MobileAuthBindingDigests {
  return Object.freeze({
    browser: createCurrentHmacDigest(
      keyring,
      "browser-binding",
      browserBindingInput(binding.transactionId, binding.browserSecret),
    ),
    csrf: createCurrentHmacDigest(
      keyring,
      "csrf-binding",
      csrfBindingInput(binding.transactionId, binding.csrf),
    ),
  });
}

export function createBrowserBindingLookupCandidates(
  keyring: MobileAuthMasterKeyring,
  cookie: ParsedMobileAuthCookie,
): readonly MobileAuthKeyedDigest[] {
  return createHmacLookupCandidates(
    keyring,
    "browser-binding",
    browserBindingInput(cookie.transactionId, cookie.browserSecret),
  );
}

export function verifyMobileAuthBrowserBinding(
  keyring: MobileAuthMasterKeyring,
  expected: MobileAuthKeyedDigest,
  cookie: ParsedMobileAuthCookie,
): boolean {
  if (expected.purpose !== "browser-binding") {
    return false;
  }

  return verifyHmacDigest(
    keyring,
    expected,
    browserBindingInput(cookie.transactionId, cookie.browserSecret),
  );
}

export function verifyMobileAuthCsrf(
  keyring: MobileAuthMasterKeyring,
  expected: MobileAuthKeyedDigest,
  transactionId: string,
  providedCsrf: string,
): boolean {
  if (expected.purpose !== "csrf-binding") {
    return false;
  }

  try {
    return verifyHmacDigest(
      keyring,
      expected,
      csrfBindingInput(transactionId, providedCsrf),
    );
  } catch {
    return false;
  }
}

export function constantTimeCsrfMatch(expected: string, provided: string): boolean {
  try {
    assertCookieSecret(expected, MOBILE_AUTH_LIMITS.csrfBytes);
    assertCookieSecret(provided, MOBILE_AUTH_LIMITS.csrfBytes);
  } catch {
    return false;
  }

  return constantTimeEqual(expected, provided);
}

export function createRateLimitDigest(
  keyring: MobileAuthMasterKeyring,
  rateLimitInput: string,
): MobileAuthKeyedDigest {
  if (!SAFE_RATE_LIMIT_INPUT_PATTERN.test(rateLimitInput)) {
    throw new MobileAuthCookieError();
  }

  return createCurrentHmacDigest(keyring, "rate-limit", rateLimitInput);
}
