import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadMobileAuthRuntimeConfig } from "./runtime-config";

function environment(overrides: Record<string, string> = {}) {
  return {
    MOBILE_AUTH_APP_ORIGIN: "https://app.example.com",
    MOBILE_AUTH_ENVIRONMENT: "production",
    MOBILE_AUTH_KEYRING: JSON.stringify({
      1: randomBytes(32).toString("base64url"),
    }),
    MOBILE_AUTH_CURRENT_KEY_VERSION: "1",
    MOBILE_AUTH_ALLOW_INSECURE_LOCALHOST: "0",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    VITE_SUPABASE_URL: "https://project.supabase.co",
    VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    CRON_SECRET: randomBytes(32).toString("base64url"),
    ...overrides,
  };
}

describe("mobile authentication runtime configuration", () => {
  it("loads the server-only environment and cleanup secret", () => {
    const config = loadMobileAuthRuntimeConfig(environment());

    expect(config.environment).toBe("production");
    expect(config.appOrigin).toBe("https://app.example.com");
    expect(config.cronSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("permits insecure loopback only for an explicit local fixture", () => {
    expect(() =>
      loadMobileAuthRuntimeConfig(
        environment({
          MOBILE_AUTH_APP_ORIGIN: "http://localhost:3000",
          MOBILE_AUTH_ENVIRONMENT: "local",
          MOBILE_AUTH_ALLOW_INSECURE_LOCALHOST: "1",
        }),
      ),
    ).not.toThrow();

    expect(() =>
      loadMobileAuthRuntimeConfig(
        environment({
          MOBILE_AUTH_APP_ORIGIN: "http://localhost:3000",
          MOBILE_AUTH_ENVIRONMENT: "production",
          MOBILE_AUTH_ALLOW_INSECURE_LOCALHOST: "1",
        }),
      ),
    ).toThrow();
  });
});
