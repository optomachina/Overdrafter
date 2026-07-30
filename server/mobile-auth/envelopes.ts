import {
  MOBILE_AUTH_LIMITS,
  type MobileAuthEncryptedEnvelope,
  type MobileAuthEnvelopeContext,
  type MobileAuthMasterKeyring,
} from "./contract";
import {
  decodeCanonicalBase64Url,
  decryptMobileAuthEnvelope,
  encryptMobileAuthEnvelope,
  encryptMobileAuthEnvelopeWithKeyVersion,
} from "./crypto";
import type { TransferSessionMaterial } from "./supabase-transfer";

interface StoredMobileAuthEnvelope {
  readonly version: 1;
  readonly expiresAtEpochSeconds: number;
  readonly envelope: MobileAuthEncryptedEnvelope;
}

type StateEnvelopeContext = Omit<MobileAuthEnvelopeContext, "expiresAtEpochSeconds">;
type SessionEnvelopeContext = Omit<
  MobileAuthEnvelopeContext,
  "expiresAtEpochSeconds" | "subjectId" | "sourceSessionId"
> & {
  readonly subjectId: string;
  readonly sourceSessionId: string;
};

export class MobileAuthEnvelopeFormatError extends Error {
  readonly code = "mobile_auth_invalid_request" as const;

  constructor() {
    super("The mobile authentication envelope is invalid.");
    this.name = "MobileAuthEnvelopeFormatError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEncryptedEnvelope(value: unknown): value is MobileAuthEncryptedEnvelope {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    value.algorithm === "A256GCM" &&
    Number.isSafeInteger(value.keyVersion) &&
    (value.purpose === "state-envelope" || value.purpose === "session-envelope") &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.authenticationTag === "string"
  );
}

function serializeStoredEnvelope(value: StoredMobileAuthEnvelope): string {
  const serialized = [
    String(value.version),
    String(value.expiresAtEpochSeconds),
    String(value.envelope.keyVersion),
    value.envelope.purpose,
    value.envelope.iv,
    value.envelope.ciphertext,
    value.envelope.authenticationTag,
  ].join(".");
  if (Buffer.byteLength(serialized, "utf8") > MOBILE_AUTH_LIMITS.envelopeCiphertextBytes) {
    throw new MobileAuthEnvelopeFormatError();
  }

  return serialized;
}

function parseStoredEnvelope(serialized: string): StoredMobileAuthEnvelope {
  if (
    serialized.length === 0 ||
    Buffer.byteLength(serialized, "utf8") > MOBILE_AUTH_LIMITS.envelopeCiphertextBytes
  ) {
    throw new MobileAuthEnvelopeFormatError();
  }

  if (!/^[A-Za-z0-9._~-]+$/.test(serialized)) {
    throw new MobileAuthEnvelopeFormatError();
  }

  const parts = serialized.split(".");
  if (parts.length !== 7) {
    throw new MobileAuthEnvelopeFormatError();
  }

  const [versionText, expiryText, keyVersionText, purpose, iv, ciphertext, authenticationTag] =
    parts;
  if (
    versionText !== "1" ||
    !/^[1-9]\d*$/.test(expiryText) ||
    !/^[1-9]\d*$/.test(keyVersionText)
  ) {
    throw new MobileAuthEnvelopeFormatError();
  }

  const expiresAtEpochSeconds = Number(expiryText);
  const keyVersion = Number(keyVersionText);
  const envelope = {
    version: 1,
    algorithm: "A256GCM",
    keyVersion,
    purpose,
    iv,
    ciphertext,
    authenticationTag,
  };

  if (
    !Number.isSafeInteger(expiresAtEpochSeconds) ||
    expiresAtEpochSeconds <= 0 ||
    !Number.isSafeInteger(keyVersion) ||
    !isEncryptedEnvelope(envelope)
  ) {
    throw new MobileAuthEnvelopeFormatError();
  }

  return {
    version: 1,
    expiresAtEpochSeconds,
    envelope,
  };
}

function decodePlaintext(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new MobileAuthEnvelopeFormatError();
  } finally {
    bytes.fill(0);
  }
}

function encodePlaintext(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Seals state and CSRF material into an expiring transaction-bound envelope. */
export function sealStateEnvelope(
  keyring: MobileAuthMasterKeyring,
  state: string,
  csrf: string,
  expiresAtEpochSeconds: number,
  context: StateEnvelopeContext,
): string {
  decodeCanonicalBase64Url(state, MOBILE_AUTH_LIMITS.stateBytes);
  decodeCanonicalBase64Url(csrf, MOBILE_AUTH_LIMITS.csrfBytes);
  const plaintext = encodePlaintext({ state, csrf });

  try {
    return serializeStoredEnvelope({
      version: 1,
      expiresAtEpochSeconds,
      envelope: encryptMobileAuthEnvelope(keyring, "state-envelope", plaintext, {
        ...context,
        expiresAtEpochSeconds,
      }),
    });
  } finally {
    plaintext.fill(0);
  }
}

/** Opens and validates an expiring state envelope for its transaction context. */
export function openStateEnvelope(
  keyring: MobileAuthMasterKeyring,
  serialized: string,
  context: StateEnvelopeContext,
): { state: string; csrf: string } {
  const stored = parseStoredEnvelope(serialized);
  const plaintext = decryptMobileAuthEnvelope(
    keyring,
    stored.envelope,
    "state-envelope",
    {
      ...context,
      expiresAtEpochSeconds: stored.expiresAtEpochSeconds,
    },
  );
  const decoded = decodePlaintext(plaintext);

  if (
    !isRecord(decoded) ||
    typeof decoded.state !== "string" ||
    typeof decoded.csrf !== "string"
  ) {
    throw new MobileAuthEnvelopeFormatError();
  }

  try {
    decodeCanonicalBase64Url(decoded.state, MOBILE_AUTH_LIMITS.stateBytes);
    decodeCanonicalBase64Url(decoded.csrf, MOBILE_AUTH_LIMITS.csrfBytes);
  } catch {
    throw new MobileAuthEnvelopeFormatError();
  }

  return {
    state: decoded.state,
    csrf: decoded.csrf,
  };
}

/** Seals transfer credentials with the transaction's original key version. */
export function sealSessionEnvelope(
  keyring: MobileAuthMasterKeyring,
  keyVersion: number,
  material: TransferSessionMaterial,
  expiresAtEpochSeconds: number,
  context: SessionEnvelopeContext,
): string {
  if (
    material.accessToken.length === 0 ||
    material.accessToken.length > MOBILE_AUTH_LIMITS.accessTokenBytes ||
    material.refreshToken.length === 0 ||
    material.refreshToken.length > MOBILE_AUTH_LIMITS.refreshTokenBytes
  ) {
    throw new MobileAuthEnvelopeFormatError();
  }

  const plaintext = encodePlaintext({
    accessToken: material.accessToken,
    refreshToken: material.refreshToken,
  });

  try {
    return serializeStoredEnvelope({
      version: 1,
      expiresAtEpochSeconds,
      envelope: encryptMobileAuthEnvelopeWithKeyVersion(
        keyring,
        keyVersion,
        "session-envelope",
        plaintext,
        {
          ...context,
          expiresAtEpochSeconds,
        },
      ),
    });
  } finally {
    plaintext.fill(0);
  }
}

/** Opens transfer credentials only when context and expiry match exactly. */
export function openSessionEnvelope(
  keyring: MobileAuthMasterKeyring,
  serialized: string,
  expectedExpiresAtEpochSeconds: number,
  context: SessionEnvelopeContext,
): TransferSessionMaterial {
  const stored = parseStoredEnvelope(serialized);
  if (stored.expiresAtEpochSeconds !== expectedExpiresAtEpochSeconds) {
    throw new MobileAuthEnvelopeFormatError();
  }

  const plaintext = decryptMobileAuthEnvelope(
    keyring,
    stored.envelope,
    "session-envelope",
    {
      ...context,
      expiresAtEpochSeconds: stored.expiresAtEpochSeconds,
    },
  );
  const decoded = decodePlaintext(plaintext);

  if (
    !isRecord(decoded) ||
    typeof decoded.accessToken !== "string" ||
    decoded.accessToken.length === 0 ||
    decoded.accessToken.length > MOBILE_AUTH_LIMITS.accessTokenBytes ||
    typeof decoded.refreshToken !== "string" ||
    decoded.refreshToken.length === 0 ||
    decoded.refreshToken.length > MOBILE_AUTH_LIMITS.refreshTokenBytes
  ) {
    throw new MobileAuthEnvelopeFormatError();
  }

  return {
    accessToken: decoded.accessToken,
    refreshToken: decoded.refreshToken,
  };
}

export const mobileAuthEnvelopeInternals = {
  parseStoredEnvelope,
};
