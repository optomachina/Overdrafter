// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MobileAuthMasterKeyring } from "./contract";
import { calculateS256CodeChallenge, createMobileAuthCodeVerifier } from "./crypto";
import {
  openSessionEnvelope,
  openStateEnvelope,
  sealSessionEnvelope,
  sealStateEnvelope,
} from "./envelopes";

const keyring: MobileAuthMasterKeyring = {
  currentVersion: 2,
  keys: [
    { version: 1, key: randomBytes(32) },
    { version: 2, key: randomBytes(32) },
  ],
};

function baseContext() {
  return {
    transactionId: randomUUID(),
    pkceChallenge: calculateS256CodeChallenge(createMobileAuthCodeVerifier()),
    callbackOrigin: "https://app.example.com",
    callbackPath: "/auth/mobile/callback" as const,
    returnTo: "/quotes",
  };
}

describe("mobile authentication envelope serialization", () => {
  it("round-trips a state echo without storing plaintext", () => {
    const state = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const context = baseContext();
    const serialized = sealStateEnvelope(
      keyring,
      state,
      csrf,
      1_800_000_600,
      context,
    );

    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain(csrf);
    expect(openStateEnvelope(keyring, serialized, context)).toEqual({ state, csrf });
  });

  it("round-trips transfer credentials and binds every session context field", () => {
    const context = {
      ...baseContext(),
      subjectId: randomUUID(),
      sourceSessionId: randomUUID(),
    };
    const material = {
      accessToken: "header.payload.signature",
      refreshToken: "refresh-token-sentinel",
    };
    const serialized = sealSessionEnvelope(keyring, 1, material, 1_800_000_090, context);

    expect(serialized).not.toContain(material.accessToken);
    expect(serialized).not.toContain(material.refreshToken);
    expect(
      openSessionEnvelope(keyring, serialized, 1_800_000_090, context),
    ).toEqual(material);
    expect(serialized.split(".")[2]).toBe("1");

    expect(() =>
      openSessionEnvelope(keyring, serialized, 1_800_000_090, {
        ...context,
        returnTo: "/search",
      }),
    ).toThrow();
    expect(() =>
      openSessionEnvelope(keyring, serialized, 1_800_000_091, context),
    ).toThrow();
  });

  it("fails closed for tampered serialized ciphertext", () => {
    const state = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const context = baseContext();
    const serialized = sealStateEnvelope(
      keyring,
      state,
      csrf,
      1_800_000_600,
      context,
    );
    const parts = serialized.split(".");
    const finalCiphertextCharacter = parts[5].slice(-1);
    const replacementCharacter = finalCiphertextCharacter === "A" ? "B" : "A";
    parts[5] = `${parts[5].slice(0, -1)}${replacementCharacter}`;

    expect(() => openStateEnvelope(keyring, parts.join("."), context)).toThrow();
  });
});
