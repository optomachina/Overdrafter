import { describe, expect, it } from "vitest";
import {
  getAuthProvider,
  hasVerifiedAuth,
  isEmailConfirmationRequired,
} from "./auth-status";

describe("auth-status", () => {
  it("extracts the provider when app metadata includes one", () => {
    expect(
      getAuthProvider({
        app_metadata: { provider: "google" },
        confirmed_at: null,
        email_confirmed_at: null,
      }),
    ).toBe("google");
  });

  it("treats trusted social providers as verified even without email timestamps", () => {
    expect(
      hasVerifiedAuth({
        app_metadata: { provider: "apple" },
        confirmed_at: null,
        email_confirmed_at: null,
      }),
    ).toBe(true);
  });

  it("treats email confirmation timestamps as verified auth", () => {
    expect(
      hasVerifiedAuth({
        app_metadata: { provider: "email" },
        confirmed_at: null,
        email_confirmed_at: "2026-03-03T00:00:00Z",
      }),
    ).toBe(true);
  });

  it("requires confirmation for unverified email users", () => {
    const user = {
      app_metadata: { provider: "email" },
      confirmed_at: null,
      email_confirmed_at: null,
    };

    expect(hasVerifiedAuth(user)).toBe(false);
    expect(isEmailConfirmationRequired(user)).toBe(true);
  });
});
