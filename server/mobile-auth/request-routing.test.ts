import { describe, expect, it } from "vitest";
import {
  readTrustedClientIp,
  resolveMobileAuthRoute,
} from "./request-routing";

describe("mobile authentication request routing", () => {
  it("normalizes a Vercel rewrite into the public contract URL", () => {
    const resolved = resolveMobileAuthRoute(
      "https://app.example.com/api/mobile-auth?action=start&v=1&state=abc",
    );

    expect(resolved.action).toBe("start");
    expect(resolved.publicUrl.toString()).toBe(
      "https://app.example.com/auth/mobile/start?v=1&state=abc",
    );
  });

  it("accepts the original public route only when an optional action agrees", () => {
    expect(
      resolveMobileAuthRoute("https://app.example.com/auth/mobile/bootstrap").action,
    ).toBe("bootstrap");
    expect(() =>
      resolveMobileAuthRoute(
        "https://app.example.com/auth/mobile/bootstrap?action=complete",
      ),
    ).toThrow();
  });

  it("rejects duplicated, unknown, and public cleanup routes", () => {
    expect(() =>
      resolveMobileAuthRoute(
        "https://app.example.com/api/mobile-auth?action=start&action=start",
      ),
    ).toThrow();
    expect(() =>
      resolveMobileAuthRoute("https://app.example.com/api/mobile-auth?action=unknown"),
    ).toThrow();
    expect(() =>
      resolveMobileAuthRoute("https://app.example.com/auth/mobile/cleanup?action=cleanup"),
    ).toThrow();
  });
});

describe("trusted client IP parsing", () => {
  it("uses the first valid Vercel-provided address", () => {
    expect(
      readTrustedClientIp(
        new Headers({
          "x-vercel-forwarded-for": "203.0.113.7, 10.0.0.2",
          "x-forwarded-for": "198.51.100.9",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("does not trust generic or malformed forwarding values", () => {
    expect(readTrustedClientIp(new Headers({ "x-forwarded-for": "198.51.100.9" }))).toBe(
      "unknown",
    );
    expect(
      readTrustedClientIp(new Headers({ "x-vercel-forwarded-for": "not-an-address" })),
    ).toBe("unknown");
  });
});
