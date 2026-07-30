// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  MobileAuthEnvelopeContext,
  MobileAuthMasterKeyring,
} from "./contract";
import {
  calculateS256CodeChallenge,
  constantTimeEqual,
  createCurrentHmacDigest,
  createHmacLookupCandidates,
  createMobileAuthCodeVerifier,
  decodeCanonicalBase64Url,
  decryptMobileAuthEnvelope,
  encodeCanonicalBase64Url,
  encryptMobileAuthEnvelope,
  encryptMobileAuthEnvelopeWithKeyVersion,
  verifyHmacDigest,
} from "./crypto";

function keyring(): MobileAuthMasterKeyring {
  return {
    currentVersion: 2,
    keys: [
      { version: 1, key: new Uint8Array(32).fill(1) },
      { version: 2, key: new Uint8Array(32).fill(2) },
    ],
  };
}

function sessionContext(): MobileAuthEnvelopeContext {
  return {
    transactionId: "123e4567-e89b-42d3-a456-426614174000",
    pkceChallenge: encodeCanonicalBase64Url(new Uint8Array(32).fill(4)),
    callbackOrigin: "https://app.example.com",
    callbackPath: "/auth/mobile/callback",
    returnTo: "/quotes/Q-123",
    expiresAtEpochSeconds: 2_000_000_000,
    subjectId: "123e4567-e89b-42d3-a456-426614174001",
    sourceSessionId: "123e4567-e89b-42d3-a456-426614174002",
  };
}

describe("mobile-auth crypto", () => {
  it("strictly accepts only canonical base64url with the expected decoded size", () => {
    const encoded = encodeCanonicalBase64Url(new Uint8Array(32).fill(7));

    expect(decodeCanonicalBase64Url(encoded, 32)).toHaveLength(32);
    expect(() => decodeCanonicalBase64Url(`${encoded}=`, 32)).toThrow();
    expect(() => decodeCanonicalBase64Url(encoded.slice(0, -1), 32)).toThrow();
    expect(() => decodeCanonicalBase64Url("not+base64url", 32)).toThrow();
  });

  it("creates an exact 32-byte verifier and its S256 challenge", () => {
    const verifier = createMobileAuthCodeVerifier();
    const challenge = calculateS256CodeChallenge(verifier);

    expect(decodeCanonicalBase64Url(verifier, 32)).toHaveLength(32);
    expect(decodeCanonicalBase64Url(challenge, 32)).toHaveLength(32);
  });

  it("writes with the current HMAC key and offers rotation lookup candidates", () => {
    const current = createCurrentHmacDigest(keyring(), "handoff-lookup", "opaque-code");
    const candidates = createHmacLookupCandidates(
      keyring(),
      "handoff-lookup",
      "opaque-code",
    );

    expect(current.keyVersion).toBe(2);
    expect(candidates.map((candidate) => candidate.keyVersion)).toEqual([2, 1]);
    expect(verifyHmacDigest(keyring(), current, "opaque-code")).toBe(true);
    expect(verifyHmacDigest(keyring(), current, "other-code")).toBe(false);
    expect(
      createCurrentHmacDigest(keyring(), "state-lookup", "opaque-code").digest,
    ).not.toBe(current.digest);
  });

  it("uses constant-time digest comparison semantics", () => {
    expect(constantTimeEqual("same-value", "same-value")).toBe(true);
    expect(constantTimeEqual("same-value", "other-value")).toBe(false);
    expect(constantTimeEqual("a", "a\u0000")).toBe(false);
  });

  it("round-trips AES-256-GCM data and rejects ciphertext or AAD changes", () => {
    const plaintext = Buffer.from(
      JSON.stringify({ accessToken: "access", refreshToken: "refresh" }),
      "utf8",
    );
    const envelope = encryptMobileAuthEnvelope(
      keyring(),
      "session-envelope",
      plaintext,
      sessionContext(),
    );

    expect(
      Buffer.from(
        decryptMobileAuthEnvelope(
          keyring(),
          envelope,
          "session-envelope",
          sessionContext(),
        ),
      ).toString("utf8"),
    ).toBe(plaintext.toString("utf8"));

    expect(() =>
      decryptMobileAuthEnvelope(
        keyring(),
        {
          ...envelope,
          ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`,
        },
        "session-envelope",
        sessionContext(),
      ),
    ).toThrow();

    expect(() =>
      decryptMobileAuthEnvelope(
        keyring(),
        envelope,
        "session-envelope",
        { ...sessionContext(), returnTo: "/parts" },
      ),
    ).toThrow();
  });

  it("can retain a transaction's start key across current-key rotation", () => {
    const plaintext = Buffer.from("retained-transaction-key", "utf8");
    const envelope = encryptMobileAuthEnvelopeWithKeyVersion(
      keyring(),
      1,
      "session-envelope",
      plaintext,
      sessionContext(),
    );

    expect(envelope.keyVersion).toBe(1);
    expect(
      Buffer.from(
        decryptMobileAuthEnvelope(
          keyring(),
          envelope,
          "session-envelope",
          sessionContext(),
        ),
      ).toString("utf8"),
    ).toBe("retained-transaction-key");
  });
});
