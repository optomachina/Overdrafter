// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  createMobileAuthCspNonce,
  createMobileAuthDocumentHeaders,
} from "./headers";

describe("mobile-auth response headers", () => {
  it("builds a nonce-bound no-store bootstrap policy", () => {
    const nonce = createMobileAuthCspNonce();
    const headers = createMobileAuthDocumentHeaders({
      kind: "bootstrap",
      nonce,
      supabaseOrigin: "https://project.supabase.co",
    });

    expect(headers["Cache-Control"]).toBe("no-store, max-age=0");
    expect(headers.Pragma).toBe("no-cache");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Security-Policy"]).toContain(
      `script-src 'self' 'nonce-${nonce}'`,
    );
    expect(headers["Content-Security-Policy"]).toContain("style-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain(
      "connect-src 'self' https://project.supabase.co",
    );
    expect(headers["Content-Security-Policy"]).toContain("form-action 'none'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("makes the recovery document script-free and disconnected", () => {
    const headers = createMobileAuthDocumentHeaders({ kind: "recovery" });

    expect(headers["Content-Security-Policy"]).toContain("script-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("form-action 'none'");
  });

  it("rejects CSP source injection", () => {
    expect(() =>
      createMobileAuthDocumentHeaders({
        kind: "ceremony",
        nonce: createMobileAuthCspNonce(),
        supabaseOrigin: "https://project.supabase.co; script-src *",
      }),
    ).toThrow();
  });

  it("permits only nonce-bound ceremony styles", () => {
    const nonce = createMobileAuthCspNonce();
    const headers = createMobileAuthDocumentHeaders({
      kind: "ceremony",
      nonce,
      supabaseOrigin: "https://project.supabase.co",
    });

    expect(headers["Content-Security-Policy"]).toContain(
      `style-src 'nonce-${nonce}'`,
    );
  });
});
