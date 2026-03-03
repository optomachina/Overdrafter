import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthRedirectUrl } from "./auth-redirect";

describe("auth-redirect", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/");
  });

  it("uses the configured app url and preserves nested base paths", () => {
    vi.stubEnv("VITE_APP_URL", "https://quotes.example.com/app");

    expect(buildAuthRedirectUrl("/signin")).toBe("https://quotes.example.com/app/signin");
    expect(buildAuthRedirectUrl("/")).toBe("https://quotes.example.com/app/");
  });

  it("falls back to the current browser origin when no configured app url is available", () => {
    vi.stubEnv("VITE_APP_URL", "");
    window.history.replaceState({}, "", "/internal/jobs/job-123");

    const redirectUrl = buildAuthRedirectUrl("/signin");

    expect(redirectUrl).toBe(`${window.location.origin}/signin`);
  });

  it("ignores invalid configured app urls and uses the browser origin instead", () => {
    vi.stubEnv("VITE_APP_URL", "not-a-url");

    expect(buildAuthRedirectUrl("/client/packages/pkg-1")).toBe(
      `${window.location.origin}/client/packages/pkg-1`,
    );
  });
});
