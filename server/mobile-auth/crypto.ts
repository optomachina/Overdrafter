import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  MOBILE_AUTH_CONTRACT_VERSION,
  MOBILE_AUTH_LIMITS,
  MOBILE_AUTH_PATHS,
  containsAsciiControlCharacters,
  type MobileAuthEncryptedEnvelope,
  type MobileAuthEnvelopeContext,
  type MobileAuthEnvelopePurpose,
  type MobileAuthHmacPurpose,
  type MobileAuthKeyedDigest,
  type MobileAuthMasterKey,
  type MobileAuthMasterKeyring,
} from "./contract";
import { parseMobileReturnRoute } from "./return-routes";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const SHA256_BYTES = 32;
const DERIVED_KEY_BYTES = 32;
const HKDF_SALT = Buffer.from("OverDrafter/mobile-auth/HKDF/v1", "utf8");
const MAX_HMAC_INPUT_BYTES = 65_536;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class MobileAuthCryptoError extends Error {
  readonly code = "mobile_auth_invalid_request" as const;

  constructor(message = "Mobile authentication cryptographic material is invalid.") {
    super(message);
    this.name = "MobileAuthCryptoError";
  }
}

/** Encodes bytes as unpadded canonical base64url text. */
export function encodeCanonicalBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/** Decodes canonical base64url text while enforcing optional byte bounds. */
export function decodeCanonicalBase64Url(
  value: string,
  expectedByteLength?: number,
  maximumByteLength = expectedByteLength ?? 65_536,
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !BASE64URL_PATTERN.test(value) ||
    value.includes("=")
  ) {
    throw new MobileAuthCryptoError();
  }

  const maximumEncodedLength = Math.ceil((maximumByteLength * 4) / 3);

  if (value.length > maximumEncodedLength) {
    throw new MobileAuthCryptoError();
  }

  const decoded = Buffer.from(value, "base64url");

  if (
    decoded.length > maximumByteLength ||
    (expectedByteLength !== undefined && decoded.length !== expectedByteLength) ||
    encodeCanonicalBase64Url(decoded) !== value
  ) {
    throw new MobileAuthCryptoError();
  }

  return Uint8Array.from(decoded);
}

/** Creates a cryptographically random canonical base64url secret. */
export function createRandomBase64Url(
  byteLength: number = MOBILE_AUTH_LIMITS.randomSecretBytes,
): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 1_024) {
    throw new MobileAuthCryptoError("The requested random value length is invalid.");
  }

  return randomBytes(byteLength).toString("base64url");
}

/** Creates the native-app state value used to bind one authentication attempt. */
export function createMobileAuthState(): string {
  return createRandomBase64Url(MOBILE_AUTH_LIMITS.stateBytes);
}

/** Creates a PKCE verifier for one mobile authentication attempt. */
export function createMobileAuthCodeVerifier(): string {
  return createRandomBase64Url(MOBILE_AUTH_LIMITS.codeVerifierBytes);
}

/** Creates the one-time code used to redeem an authenticated handoff. */
export function createMobileAuthHandoffCode(): string {
  return createRandomBase64Url(MOBILE_AUTH_LIMITS.handoffCodeBytes);
}

/** Validates a verifier and derives its RFC 7636 S256 challenge. */
export function calculateS256CodeChallenge(codeVerifier: string): string {
  decodeCanonicalBase64Url(codeVerifier, MOBILE_AUTH_LIMITS.codeVerifierBytes);

  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** Compares secret values without leaking their shared-prefix length. */
export function constantTimeEqual(left: string | Uint8Array, right: string | Uint8Array): boolean {
  const leftBytes =
    typeof left === "string" ? Buffer.from(left, "utf8") : Buffer.from(left);
  const rightBytes =
    typeof right === "string" ? Buffer.from(right, "utf8") : Buffer.from(right);
  const leftDigest = createHash("sha256").update(leftBytes).digest();
  const rightDigest = createHash("sha256").update(rightBytes).digest();

  return timingSafeEqual(leftDigest, rightDigest) && leftBytes.length === rightBytes.length;
}

function validateMasterKey(candidate: MobileAuthMasterKey): void {
  if (
    !Number.isSafeInteger(candidate.version) ||
    candidate.version < 1 ||
    candidate.key.byteLength !== DERIVED_KEY_BYTES
  ) {
    throw new MobileAuthCryptoError("The mobile authentication keyring is invalid.");
  }
}

function validateKeyring(keyring: MobileAuthMasterKeyring): void {
  const versions = new Set<number>();

  for (const candidate of keyring.keys) {
    validateMasterKey(candidate);

    if (versions.has(candidate.version)) {
      throw new MobileAuthCryptoError("The mobile authentication keyring has duplicate versions.");
    }

    versions.add(candidate.version);
  }

  if (keyring.keys.length === 0 || !versions.has(keyring.currentVersion)) {
    throw new MobileAuthCryptoError("The current mobile authentication key is unavailable.");
  }
}

function findMasterKey(
  keyring: MobileAuthMasterKeyring,
  keyVersion: number,
): MobileAuthMasterKey {
  validateKeyring(keyring);
  const key = keyring.keys.find((candidate) => candidate.version === keyVersion);

  if (!key) {
    throw new MobileAuthCryptoError("The requested mobile authentication key is unavailable.");
  }

  return key;
}

function derivePurposeKey(
  masterKey: MobileAuthMasterKey,
  purpose: MobileAuthHmacPurpose | MobileAuthEnvelopePurpose,
): Buffer {
  const info = Buffer.from(
    `OverDrafter/mobile-auth/${MOBILE_AUTH_CONTRACT_VERSION}/${purpose}/key-v${masterKey.version}`,
    "utf8",
  );

  return Buffer.from(
    hkdfSync("sha256", Buffer.from(masterKey.key), HKDF_SALT, info, DERIVED_KEY_BYTES),
  );
}

function encodeLengthPrefixedParts(parts: readonly string[]): Buffer {
  const encodedParts = parts.map((part) => Buffer.from(part, "utf8"));
  let totalLength = 0;

  for (const part of encodedParts) {
    totalLength += 4 + part.length;
  }

  const output = Buffer.allocUnsafe(totalLength);
  let offset = 0;

  for (const part of encodedParts) {
    output.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(output, offset);
    offset += part.length;
  }

  return output;
}

function normalizeHmacInput(input: string | Uint8Array): Buffer {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);

  if (bytes.length === 0 || bytes.length > MAX_HMAC_INPUT_BYTES) {
    throw new MobileAuthCryptoError("The keyed lookup input is invalid.");
  }

  return bytes;
}

function computeHmacDigest(
  key: MobileAuthMasterKey,
  purpose: MobileAuthHmacPurpose,
  input: string | Uint8Array,
): string {
  const purposeKey = derivePurposeKey(key, purpose);
  const normalizedInput = normalizeHmacInput(input);
  const framedInput = Buffer.concat([
    encodeLengthPrefixedParts([
      "OverDrafter",
      "mobile-auth",
      MOBILE_AUTH_CONTRACT_VERSION,
      purpose,
    ]),
    normalizedInput,
  ]);

  try {
    return createHmac("sha256", purposeKey).update(framedInput).digest("base64url");
  } finally {
    purposeKey.fill(0);
  }
}

/** Creates a purpose-bound digest with the keyring's current key version. */
export function createCurrentHmacDigest(
  keyring: MobileAuthMasterKeyring,
  purpose: MobileAuthHmacPurpose,
  input: string | Uint8Array,
): MobileAuthKeyedDigest {
  const key = findMasterKey(keyring, keyring.currentVersion);

  return Object.freeze({
    algorithm: "HMAC-SHA-256",
    keyVersion: key.version,
    purpose,
    digest: computeHmacDigest(key, purpose, input),
  });
}

/** Creates lookup digests for every retained key version during rotation. */
export function createHmacLookupCandidates(
  keyring: MobileAuthMasterKeyring,
  purpose: MobileAuthHmacPurpose,
  input: string | Uint8Array,
): readonly MobileAuthKeyedDigest[] {
  validateKeyring(keyring);
  const current = findMasterKey(keyring, keyring.currentVersion);
  const orderedKeys = [
    current,
    ...keyring.keys.filter((candidate) => candidate.version !== current.version),
  ];

  return Object.freeze(
    orderedKeys.map((key) =>
      Object.freeze({
        algorithm: "HMAC-SHA-256" as const,
        keyVersion: key.version,
        purpose,
        digest: computeHmacDigest(key, purpose, input),
      }),
    ),
  );
}

/** Verifies a purpose-bound digest against its declared key version. */
export function verifyHmacDigest(
  keyring: MobileAuthMasterKeyring,
  expected: MobileAuthKeyedDigest,
  input: string | Uint8Array,
): boolean {
  if (expected.algorithm !== "HMAC-SHA-256") {
    return false;
  }

  let key: MobileAuthMasterKey;

  try {
    key = findMasterKey(keyring, expected.keyVersion);
    decodeCanonicalBase64Url(expected.digest, SHA256_BYTES);
  } catch {
    return false;
  }

  const actual = computeHmacDigest(key, expected.purpose, input);

  return constantTimeEqual(actual, expected.digest);
}

function assertBoundedIdentifier(value: string, name: string): void {
  if (
    value.length === 0 ||
    value.length > 256 ||
    containsAsciiControlCharacters(value)
  ) {
    throw new MobileAuthCryptoError(`${name} is invalid.`);
  }
}

function validateEnvelopeContext(
  purpose: MobileAuthEnvelopePurpose,
  context: MobileAuthEnvelopeContext,
): void {
  if (!CANONICAL_UUID_PATTERN.test(context.transactionId)) {
    throw new MobileAuthCryptoError("The transaction identifier is invalid.");
  }
  decodeCanonicalBase64Url(context.pkceChallenge, MOBILE_AUTH_LIMITS.codeChallengeBytes);
  parseMobileReturnRoute(context.returnTo);
  assertBoundedIdentifier(context.callbackOrigin, "The callback origin");

  let callbackOrigin: URL;

  try {
    callbackOrigin = new URL(context.callbackOrigin);
  } catch {
    throw new MobileAuthCryptoError("The callback origin is invalid.");
  }

  const permitsLocalTestOrigin =
    callbackOrigin.protocol === "http:" && LOOPBACK_HOSTS.has(callbackOrigin.hostname);

  if (
    callbackOrigin.origin !== context.callbackOrigin ||
    (callbackOrigin.protocol !== "https:" && !permitsLocalTestOrigin) ||
    context.callbackPath !== MOBILE_AUTH_PATHS.callback ||
    !Number.isSafeInteger(context.expiresAtEpochSeconds) ||
    context.expiresAtEpochSeconds <= 0
  ) {
    throw new MobileAuthCryptoError("The envelope binding is invalid.");
  }

  if (purpose === "session-envelope") {
    if (
      !CANONICAL_UUID_PATTERN.test(context.subjectId ?? "") ||
      !CANONICAL_UUID_PATTERN.test(context.sourceSessionId ?? "")
    ) {
      throw new MobileAuthCryptoError("The verified session identity is invalid.");
    }
    return;
  }

  if (context.subjectId !== undefined || context.sourceSessionId !== undefined) {
    throw new MobileAuthCryptoError("A state envelope cannot include session identity.");
  }
}

function createEnvelopeAdditionalData(
  purpose: MobileAuthEnvelopePurpose,
  keyVersion: number,
  context: MobileAuthEnvelopeContext,
): Buffer {
  validateEnvelopeContext(purpose, context);

  return encodeLengthPrefixedParts([
    "OverDrafter",
    "mobile-auth-envelope",
    MOBILE_AUTH_CONTRACT_VERSION,
    "A256GCM",
    String(keyVersion),
    purpose,
    context.transactionId,
    context.pkceChallenge,
    context.callbackOrigin,
    context.callbackPath,
    context.returnTo,
    String(context.expiresAtEpochSeconds),
    context.subjectId ?? "",
    context.sourceSessionId ?? "",
  ]);
}

/** Encrypts a purpose- and context-bound envelope with the current key. */
export function encryptMobileAuthEnvelope(
  keyring: MobileAuthMasterKeyring,
  purpose: MobileAuthEnvelopePurpose,
  plaintext: Uint8Array,
  context: MobileAuthEnvelopeContext,
): MobileAuthEncryptedEnvelope {
  return encryptMobileAuthEnvelopeWithKeyVersion(
    keyring,
    keyring.currentVersion,
    purpose,
    plaintext,
    context,
  );
}

/** Encrypts a purpose-bound envelope using a specific retained key version. */
export function encryptMobileAuthEnvelopeWithKeyVersion(
  keyring: MobileAuthMasterKeyring,
  keyVersion: number,
  purpose: MobileAuthEnvelopePurpose,
  plaintext: Uint8Array,
  context: MobileAuthEnvelopeContext,
): MobileAuthEncryptedEnvelope {
  if (
    plaintext.byteLength === 0 ||
    plaintext.byteLength > MOBILE_AUTH_LIMITS.envelopePlaintextBytes
  ) {
    throw new MobileAuthCryptoError("The envelope plaintext is outside its allowed bounds.");
  }

  const masterKey = findMasterKey(keyring, keyVersion);
  const encryptionKey = derivePurposeKey(masterKey, purpose);
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const additionalData = createEnvelopeAdditionalData(purpose, masterKey.version, context);

  try {
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    cipher.setAAD(additionalData, { plaintextLength: plaintext.byteLength });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();

    return Object.freeze({
      version: 1,
      algorithm: "A256GCM",
      keyVersion: masterKey.version,
      purpose,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authenticationTag: authenticationTag.toString("base64url"),
    });
  } finally {
    encryptionKey.fill(0);
  }
}

/** Authenticates and decrypts a mobile-auth envelope for its expected context. */
export function decryptMobileAuthEnvelope(
  keyring: MobileAuthMasterKeyring,
  envelope: MobileAuthEncryptedEnvelope,
  expectedPurpose: MobileAuthEnvelopePurpose,
  context: MobileAuthEnvelopeContext,
): Uint8Array {
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "A256GCM" ||
    envelope.purpose !== expectedPurpose
  ) {
    throw new MobileAuthCryptoError();
  }

  const masterKey = findMasterKey(keyring, envelope.keyVersion);
  const encryptionKey = derivePurposeKey(masterKey, expectedPurpose);

  try {
    const iv = decodeCanonicalBase64Url(envelope.iv, AES_GCM_IV_BYTES);
    const authenticationTag = decodeCanonicalBase64Url(
      envelope.authenticationTag,
      AES_GCM_TAG_BYTES,
    );
    const ciphertext = decodeCanonicalBase64Url(
      envelope.ciphertext,
      undefined,
      MOBILE_AUTH_LIMITS.envelopeCiphertextBytes,
    );

    if (ciphertext.byteLength === 0) {
      throw new MobileAuthCryptoError();
    }

    const additionalData = createEnvelopeAdditionalData(
      expectedPurpose,
      envelope.keyVersion,
      context,
    );
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    decipher.setAAD(additionalData, { plaintextLength: ciphertext.byteLength });
    decipher.setAuthTag(authenticationTag);

    return Uint8Array.from(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]),
    );
  } catch (error) {
    if (error instanceof MobileAuthCryptoError) {
      throw error;
    }

    throw new MobileAuthCryptoError();
  } finally {
    encryptionKey.fill(0);
  }
}
