// @vitest-environment node

import { describe, expect, it } from "vitest";
import { MOBILE_AUTH_LIMITS } from "./contract";
import { encodeCanonicalBase64Url } from "./crypto";
import {
  MobileAuthInputError,
  parseBootstrapRequest,
  parseCompleteRequest,
  parseProviderCallbackRequest,
  parseStartRequest,
} from "./parsing";

const state = encodeCanonicalBase64Url(new Uint8Array(32).fill(1));
const challenge = encodeCanonicalBase64Url(new Uint8Array(32).fill(2));
const verifier = encodeCanonicalBase64Url(new Uint8Array(32).fill(3));
const handoff = encodeCanonicalBase64Url(new Uint8Array(32).fill(4));
const csrf = encodeCanonicalBase64Url(new Uint8Array(32).fill(5));
const callbackBinding = "018f4d67-89ab-7cde-8abc-0123456789ab";

function formRequest(path: string, body: string): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body,
  });
}

describe("mobile-auth request parsing", () => {
  it("parses only the explicit v1/S256 start contract", () => {
    const result = parseStartRequest(
      `https://app.example.com/auth/mobile/start?v=1&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&return_to=%2Fparts%2Fpart-1`,
    );

    expect(result).toEqual({
      version: "1",
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      returnTo: "/parts/part-1",
    });
  });

  it.each([
    `v=1&v=1&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`,
    `v=1&state=${state}&code_challenge=${challenge}&code_challenge_method=plain`,
    `v=1&state=${state}=&code_challenge=${challenge}&code_challenge_method=S256`,
    `v=1&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&callback=https%3A%2F%2Fevil.example`,
    `v=1&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&return_to=%2Fquotes%2F%252e%252e`,
  ])("rejects an ambiguous start query", (query) => {
    expect(() =>
      parseStartRequest(`https://app.example.com/auth/mobile/start?${query}`),
    ).toThrow(MobileAuthInputError);
  });

  it("accepts exactly one provider code or an allowlisted provider error", () => {
    expect(
      parseProviderCallbackRequest(
        `https://app.example.com/auth/mobile/provider-callback?cb=${callbackBinding}&code=pkce-code`,
      ),
    ).toEqual({
      callbackBinding,
      kind: "code",
      authorizationCode: "pkce-code",
    });
    expect(
      parseProviderCallbackRequest(
        `https://app.example.com/auth/mobile/provider-callback?cb=${callbackBinding}&error=access_denied&error_description=Cancelled`,
      ),
    ).toEqual({
      callbackBinding,
      kind: "error",
      providerError: "access_denied",
    });

    expect(() =>
      parseProviderCallbackRequest(
        `https://app.example.com/auth/mobile/provider-callback?cb=${callbackBinding}&code=one&code=two`,
      ),
    ).toThrow(MobileAuthInputError);
    expect(() =>
      parseProviderCallbackRequest(
        `https://app.example.com/auth/mobile/provider-callback?cb=${callbackBinding}&error=internal_debug_value`,
      ),
    ).toThrow(MobileAuthInputError);
    expect(() =>
      parseProviderCallbackRequest(
        "https://app.example.com/auth/mobile/provider-callback?code=pkce-code",
      ),
    ).toThrow(MobileAuthInputError);
    expect(() =>
      parseProviderCallbackRequest(
        "https://app.example.com/auth/mobile/provider-callback?cb=not-a-transaction&code=pkce-code",
      ),
    ).toThrow(MobileAuthInputError);
  });

  it("parses bounded completion and bootstrap form bodies", async () => {
    await expect(
      parseCompleteRequest(
        formRequest(
          "/auth/mobile/complete",
          `v=1&csrf=${csrf}&access_token=header.payload.signature&refresh_token=refresh-token`,
        ),
      ),
    ).resolves.toEqual({
      version: "1",
      csrf,
      accessToken: "header.payload.signature",
      refreshToken: "refresh-token",
    });

    await expect(
      parseBootstrapRequest(
        formRequest(
          "/auth/mobile/bootstrap",
          `v=1&code=${handoff}&state=${state}&code_verifier=${verifier}`,
        ),
      ),
    ).resolves.toEqual({
      version: "1",
      code: handoff,
      state,
      codeVerifier: verifier,
    });
  });

  it("rejects wrong content types, duplicates, noncanonical secrets, and oversized bodies", async () => {
    await expect(
      parseBootstrapRequest(
        new Request("https://app.example.com/auth/mobile/bootstrap", {
          method: "PUT",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `v=1&code=${handoff}&state=${state}&code_verifier=${verifier}`,
        }),
      ),
    ).rejects.toThrow(MobileAuthInputError);

    await expect(
      parseBootstrapRequest(
        new Request("https://app.example.com/auth/mobile/bootstrap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ),
    ).rejects.toThrow(MobileAuthInputError);

    await expect(
      parseBootstrapRequest(
        formRequest(
          "/auth/mobile/bootstrap",
          `v=1&code=${handoff}&code=${handoff}&state=${state}&code_verifier=${verifier}`,
        ),
      ),
    ).rejects.toThrow(MobileAuthInputError);

    await expect(
      parseBootstrapRequest(
        formRequest(
          "/auth/mobile/bootstrap",
          `v=1&code=${handoff}%3D&state=${state}&code_verifier=${verifier}`,
        ),
      ),
    ).rejects.toThrow(MobileAuthInputError);

    await expect(
      parseCompleteRequest(
        formRequest(
          "/auth/mobile/complete",
          `v=1&csrf=${csrf}&access_token=${"a".repeat(MOBILE_AUTH_LIMITS.completeBodyBytes)}&refresh_token=r`,
        ),
      ),
    ).rejects.toThrow(MobileAuthInputError);
  });
});
