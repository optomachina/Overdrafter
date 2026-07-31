// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  assertRequestMatchesConfiguredOrigin,
  loadMobileAuthConfig,
  MobileAuthConfigError,
} from "./config";
import { encodeCanonicalBase64Url } from "./crypto";

function validEnvironment(): Record<string, string> {
  return {
    MOBILE_AUTH_APP_ORIGIN: "https://app.example.com",
    MOBILE_AUTH_CURRENT_KEY_VERSION: "2",
    MOBILE_AUTH_KEYRING: JSON.stringify({
      "1": encodeCanonicalBase64Url(new Uint8Array(32).fill(1)),
      "2": encodeCanonicalBase64Url(new Uint8Array(32).fill(2)),
    }),
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable-test-key",
    VITE_SUPABASE_URL: "https://project.supabase.co",
    VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
  };
}

describe("mobile-auth config", () => {
  it("loads an exact origin and a versioned 32-byte keyring", () => {
    const config = loadMobileAuthConfig(validEnvironment());

    expect(config.appOrigin).toBe("https://app.example.com");
    expect(config.callbackUrl).toBe("https://app.example.com/auth/mobile/callback");
    expect(config.masterKeyring.currentVersion).toBe(2);
    expect(config.masterKeyring.keys.map((key) => key.version)).toEqual([1, 2]);
  });

  it.each([
    "https://app.example.com/",
    "https://app.example.com/path",
    "https://user@app.example.com",
    "http://app.example.com",
  ])("rejects a non-exact production origin: %s", (origin) => {
    expect(() =>
      loadMobileAuthConfig({
        ...validEnvironment(),
        MOBILE_AUTH_APP_ORIGIN: origin,
      }),
    ).toThrow(MobileAuthConfigError);
  });

  it("permits loopback HTTP only through the explicit test option", () => {
    const environment = {
      ...validEnvironment(),
      MOBILE_AUTH_APP_ORIGIN: "http://127.0.0.1:8080",
      SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_URL: "http://localhost:54321",
    };

    expect(() => loadMobileAuthConfig(environment)).toThrow(MobileAuthConfigError);
    expect(
      loadMobileAuthConfig(environment, {
        allowInsecureLocalhostForTests: true,
      }).appOrigin,
    ).toBe("http://127.0.0.1:8080");
  });

  it("rejects short keys and a current version absent from the keyring", () => {
    expect(() =>
      loadMobileAuthConfig({
        ...validEnvironment(),
        MOBILE_AUTH_KEYRING: JSON.stringify({
          "2": encodeCanonicalBase64Url(new Uint8Array(31)),
        }),
      }),
    ).toThrow(MobileAuthConfigError);

    expect(() =>
      loadMobileAuthConfig({
        ...validEnvironment(),
        MOBILE_AUTH_CURRENT_KEY_VERSION: "3",
      }),
    ).toThrow(MobileAuthConfigError);

    expect(() =>
      loadMobileAuthConfig({
        ...validEnvironment(),
        MOBILE_AUTH_KEYRING: JSON.stringify(
          Object.fromEntries(
            Array.from({ length: 9 }, (_value, index) => [
              String(index + 1),
              encodeCanonicalBase64Url(new Uint8Array(32).fill(index + 1)),
            ]),
          ),
        ),
      }),
    ).toThrow(MobileAuthConfigError);
  });

  it("rejects server and browser Supabase project drift", () => {
    expect(() =>
      loadMobileAuthConfig({
        ...validEnvironment(),
        SUPABASE_URL: "https://other-project.supabase.co",
      }),
    ).toThrow("server and browser Supabase configurations");

    expect(() =>
      loadMobileAuthConfig({
        ...validEnvironment(),
        SUPABASE_PUBLISHABLE_KEY: "other-publishable-key",
      }),
    ).toThrow("server and browser Supabase configurations");
  });

  it("matches requests only against the configured origin", () => {
    const config = loadMobileAuthConfig(validEnvironment());

    expect(
      assertRequestMatchesConfiguredOrigin(
        "https://app.example.com/auth/mobile/start",
        config,
      ).pathname,
    ).toBe("/auth/mobile/start");
    expect(() =>
      assertRequestMatchesConfiguredOrigin(
        "https://lookalike.example/auth/mobile/start",
        config,
      ),
    ).toThrow(MobileAuthConfigError);
  });
});
