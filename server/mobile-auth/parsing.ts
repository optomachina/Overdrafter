import {
  MOBILE_AUTH_CONTRACT_VERSION,
  MOBILE_AUTH_LIMITS,
  MOBILE_AUTH_PATHS,
  MOBILE_AUTH_PKCE_METHOD,
  containsAsciiControlCharacters,
  type MobileAuthProviderError,
} from "./contract.js";
import { decodeCanonicalBase64Url } from "./crypto.js";
import { parseMobileReturnRoute } from "./return-routes.js";
import { isMobileAuthProviderError } from "../../shared/mobile-auth-provider-errors.js";

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const FIELD_NAME_PATTERN = /^[a-z_]+$/;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const PROVIDER_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const REQUEST_BODY_READ_TIMEOUT_MILLISECONDS = 10_000;
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MALFORMED_PERCENT_ENCODING_PATTERN = /%(?![0-9A-Fa-f]{2})/;

export class MobileAuthInputError extends Error {
  readonly code = "mobile_auth_invalid_request" as const;

  constructor() {
    super("The mobile authentication request is invalid.");
    this.name = "MobileAuthInputError";
  }
}

export interface ParsedStartRequest {
  readonly version: typeof MOBILE_AUTH_CONTRACT_VERSION;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: typeof MOBILE_AUTH_PKCE_METHOD;
  readonly returnTo: string;
}

export type ParsedProviderCallbackRequest = {
  readonly callbackBinding: string;
} & (
  | {
      readonly kind: "code";
      readonly authorizationCode: string;
    }
  | {
      readonly kind: "error";
      readonly providerError: MobileAuthProviderError;
    }
);

export interface ParsedCompleteRequest {
  readonly version: typeof MOBILE_AUTH_CONTRACT_VERSION;
  readonly csrf: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface ParsedBootstrapRequest {
  readonly version: typeof MOBILE_AUTH_CONTRACT_VERSION;
  readonly code: string;
  readonly state: string;
  readonly codeVerifier: string;
}

interface StrictFormSchema {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function decodeFormComponent(value: string): string {
  if (MALFORMED_PERCENT_ENCODING_PATTERN.test(value)) {
    throw new MobileAuthInputError();
  }

  try {
    const decoded = decodeURIComponent(value.replaceAll("+", " "));

    if (containsAsciiControlCharacters(decoded)) {
      throw new MobileAuthInputError();
    }

    return decoded;
  } catch {
    throw new MobileAuthInputError();
  }
}

function parseStrictUrlEncoded(
  raw: string,
  maximumBytes: number,
  schema: StrictFormSchema,
): ReadonlyMap<string, string> {
  if (
    raw.length === 0 ||
    byteLength(raw) > maximumBytes ||
    containsAsciiControlCharacters(raw)
  ) {
    throw new MobileAuthInputError();
  }

  const required = new Set(schema.required);
  const allowed = new Set([...schema.required, ...(schema.optional ?? [])]);
  const parsed = new Map<string, string>();

  for (const pair of raw.split("&")) {
    if (pair.length === 0) {
      throw new MobileAuthInputError();
    }

    const separatorIndex = pair.indexOf("=");

    if (separatorIndex < 1) {
      throw new MobileAuthInputError();
    }

    const rawName = pair.slice(0, separatorIndex);
    const rawValue = pair.slice(separatorIndex + 1);

    if (!FIELD_NAME_PATTERN.test(rawName)) {
      throw new MobileAuthInputError();
    }

    const name = decodeFormComponent(rawName);
    const value = decodeFormComponent(rawValue);

    if (!allowed.has(name) || parsed.has(name)) {
      throw new MobileAuthInputError();
    }

    parsed.set(name, value);
  }

  for (const name of required) {
    if (!parsed.has(name)) {
      throw new MobileAuthInputError();
    }
  }

  return parsed;
}

function parseRequestUrl(
  requestUrl: string | URL,
  expectedPath: string,
  maximumBytes: number,
): URL {
  const serialized = requestUrl.toString();

  if (byteLength(serialized) > maximumBytes) {
    throw new MobileAuthInputError();
  }

  let parsed: URL;

  try {
    parsed = new URL(serialized);
  } catch {
    throw new MobileAuthInputError();
  }

  if (
    parsed.pathname !== expectedPath ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new MobileAuthInputError();
  }

  return parsed;
}

function assertVersion(value: string | undefined): asserts value is "1" {
  if (value !== MOBILE_AUTH_CONTRACT_VERSION) {
    throw new MobileAuthInputError();
  }
}

function assertPrintableToken(value: string | undefined, maximumBytes: number): string {
  if (
    value === undefined ||
    byteLength(value) > maximumBytes ||
    !PRINTABLE_ASCII_PATTERN.test(value)
  ) {
    throw new MobileAuthInputError();
  }

  return value;
}

function assertCanonicalSecret(value: string | undefined, byteCount: number): string {
  if (value === undefined) {
    throw new MobileAuthInputError();
  }

  try {
    decodeCanonicalBase64Url(value, byteCount);
  } catch {
    throw new MobileAuthInputError();
  }

  return value;
}

export function parseStartRequest(requestUrl: string | URL): ParsedStartRequest {
  const url = parseRequestUrl(
    requestUrl,
    MOBILE_AUTH_PATHS.start,
    MOBILE_AUTH_LIMITS.startUrlBytes,
  );
  const fields = parseStrictUrlEncoded(
    url.search.slice(1),
    MOBILE_AUTH_LIMITS.startUrlBytes,
    {
      required: ["v", "state", "code_challenge", "code_challenge_method"],
      optional: ["return_to"],
    },
  );
  const version = fields.get("v");
  assertVersion(version);

  if (fields.get("code_challenge_method") !== MOBILE_AUTH_PKCE_METHOD) {
    throw new MobileAuthInputError();
  }

  try {
    return Object.freeze({
      version,
      state: assertCanonicalSecret(fields.get("state"), MOBILE_AUTH_LIMITS.stateBytes),
      codeChallenge: assertCanonicalSecret(
        fields.get("code_challenge"),
        MOBILE_AUTH_LIMITS.codeChallengeBytes,
      ),
      codeChallengeMethod: MOBILE_AUTH_PKCE_METHOD,
      returnTo: parseMobileReturnRoute(fields.get("return_to")),
    });
  } catch (error) {
    if (error instanceof MobileAuthInputError) {
      throw error;
    }

    throw new MobileAuthInputError();
  }
}

/**
 * Parses a provider callback with exactly one outcome.
 *
 * A valid callback contains the transaction binding plus either an
 * authorization code or an allowlisted provider error. Code callbacks reject
 * every provider-error field; error callbacks reject authorization codes.
 */
export function parseProviderCallbackRequest(
  requestUrl: string | URL,
): ParsedProviderCallbackRequest {
  const url = parseRequestUrl(
    requestUrl,
    MOBILE_AUTH_PATHS.providerCallback,
    MOBILE_AUTH_LIMITS.providerCallbackUrlBytes,
  );
  const fields = parseStrictUrlEncoded(
    url.search.slice(1),
    MOBILE_AUTH_LIMITS.providerCallbackUrlBytes,
    {
      required: ["cb"],
      optional: ["code", "error", "error_code", "error_description"],
    },
  );
  const callbackBinding = fields.get("cb");
  const code = fields.get("code");
  const error = fields.get("error");

  if (
    callbackBinding === undefined ||
    !TRANSACTION_ID_PATTERN.test(callbackBinding) ||
    (code === undefined) === (error === undefined)
  ) {
    throw new MobileAuthInputError();
  }

  if (code !== undefined) {
    if (fields.size !== 2) {
      throw new MobileAuthInputError();
    }

    return Object.freeze({
      callbackBinding,
      kind: "code",
      authorizationCode: assertPrintableToken(
        code,
        MOBILE_AUTH_LIMITS.providerAuthorizationCodeBytes,
      ),
    });
  }

  if (
    error === undefined ||
    !isMobileAuthProviderError(error) ||
    (fields.get("error_code") !== undefined &&
      !PROVIDER_ERROR_PATTERN.test(fields.get("error_code") ?? "")) ||
    (fields.get("error_description") !== undefined &&
      byteLength(fields.get("error_description") ?? "") >
        MOBILE_AUTH_LIMITS.providerErrorDescriptionBytes)
  ) {
    throw new MobileAuthInputError();
  }

  return Object.freeze({
    callbackBinding,
    kind: "error",
    providerError: error,
  });
}

function validateFormContentType(request: Request): void {
  const contentType = request.headers.get("content-type");

  if (!contentType) {
    throw new MobileAuthInputError();
  }

  const parts = contentType.split(";").map((part) => part.trim().toLowerCase());

  if (
    parts[0] !== FORM_CONTENT_TYPE ||
    parts.length > 2 ||
    (parts.length === 2 && parts[1] !== "charset=utf-8")
  ) {
    throw new MobileAuthInputError();
  }
}

function readExpectedBodyLength(request: Request, maximumBytes: number): number | undefined {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) {
    return undefined;
  }

  if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
    throw new MobileAuthInputError();
  }

  const expectedLength = Number(contentLength);
  if (!Number.isSafeInteger(expectedLength) || expectedLength > maximumBytes) {
    throw new MobileAuthInputError();
  }

  return expectedLength;
}

/**
 * Reads a request body within both a byte ceiling and a hard ten-second deadline.
 *
 * The reader is cancelled after a timeout or size violation, its lock is always
 * released, and transport failures are normalized to `MobileAuthInputError`.
 * Successful reads return the original chunks plus their verified total size.
 */
async function readBodyChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maximumBytes: number,
): Promise<{ chunks: Uint8Array[]; totalBytes: number }> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new MobileAuthInputError());
    }, REQUEST_BODY_READ_TIMEOUT_MILLISECONDS);
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timedOut]);

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new MobileAuthInputError();
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MobileAuthInputError) {
      throw error;
    }

    throw new MobileAuthInputError();
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    reader.releaseLock();
  }

  return { chunks, totalBytes };
}

async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<string> {
  validateFormContentType(request);
  const expectedLength = readExpectedBodyLength(request, maximumBytes);
  if (request.body === null) {
    throw new MobileAuthInputError();
  }

  const { chunks, totalBytes } = await readBodyChunks(
    request.body.getReader(),
    maximumBytes,
  );
  if (expectedLength !== undefined && expectedLength !== totalBytes) {
    throw new MobileAuthInputError();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new MobileAuthInputError();
  }
}

export async function parseCompleteRequest(request: Request): Promise<ParsedCompleteRequest> {
  if (request.method !== "POST") {
    throw new MobileAuthInputError();
  }

  const rawBody = await readBoundedRequestBody(request, MOBILE_AUTH_LIMITS.completeBodyBytes);
  const fields = parseStrictUrlEncoded(rawBody, MOBILE_AUTH_LIMITS.completeBodyBytes, {
    required: ["v", "csrf", "access_token", "refresh_token"],
  });
  const version = fields.get("v");
  assertVersion(version);

  return Object.freeze({
    version,
    csrf: assertCanonicalSecret(fields.get("csrf"), MOBILE_AUTH_LIMITS.csrfBytes),
    accessToken: assertPrintableToken(
      fields.get("access_token"),
      MOBILE_AUTH_LIMITS.accessTokenBytes,
    ),
    refreshToken: assertPrintableToken(
      fields.get("refresh_token"),
      MOBILE_AUTH_LIMITS.refreshTokenBytes,
    ),
  });
}

export async function parseBootstrapRequest(request: Request): Promise<ParsedBootstrapRequest> {
  if (request.method !== "POST") {
    throw new MobileAuthInputError();
  }

  const rawBody = await readBoundedRequestBody(request, MOBILE_AUTH_LIMITS.bootstrapBodyBytes);
  const fields = parseStrictUrlEncoded(rawBody, MOBILE_AUTH_LIMITS.bootstrapBodyBytes, {
    required: ["v", "code", "state", "code_verifier"],
  });
  const version = fields.get("v");
  assertVersion(version);

  return Object.freeze({
    version,
    code: assertCanonicalSecret(fields.get("code"), MOBILE_AUTH_LIMITS.handoffCodeBytes),
    state: assertCanonicalSecret(fields.get("state"), MOBILE_AUTH_LIMITS.stateBytes),
    codeVerifier: assertCanonicalSecret(
      fields.get("code_verifier"),
      MOBILE_AUTH_LIMITS.codeVerifierBytes,
    ),
  });
}
