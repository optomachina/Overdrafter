import { describe, expect, it } from "vitest";
import mobileAuth from "./mobile-auth";

describe("Vercel mobile authentication function", () => {
  it("exports the Web-standard fetch adapter expected by the Node runtime", () => {
    expect(mobileAuth).toEqual({
      fetch: expect.any(Function),
    });
  });

  it("returns a redacted, script-free 503 when runtime configuration is unavailable", async () => {
    const previousKeyring = process.env.MOBILE_AUTH_KEYRING;
    delete process.env.MOBILE_AUTH_KEYRING;
    let response: Response;
    try {
      response = await mobileAuth.fetch(
        new Request("https://app.example.com/auth/mobile/start"),
      );
    } finally {
      if (previousKeyring === undefined) {
        delete process.env.MOBILE_AUTH_KEYRING;
      } else {
        process.env.MOBILE_AUTH_KEYRING = previousKeyring;
      }
    }

    const body = await response.text();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(body).toContain("Sign in is temporarily unavailable");
    expect(body).not.toContain("MOBILE_AUTH_KEYRING");
    expect(body).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
