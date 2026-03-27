import { describe, expect, it } from "vitest";
import { DEFAULT_AUTHENTICATED_REDIRECT, sanitizeInternalRedirect } from "./internal-redirect";

describe("sanitizeInternalRedirect", () => {
  it("keeps same-origin app paths", () => {
    expect(sanitizeInternalRedirect("/internal/admin")).toBe("/internal/admin");
  });

  it("falls back for missing values", () => {
    expect(sanitizeInternalRedirect(null)).toBe(DEFAULT_AUTHENTICATED_REDIRECT);
    expect(sanitizeInternalRedirect("")).toBe(DEFAULT_AUTHENTICATED_REDIRECT);
  });

  it("rejects open redirects", () => {
    expect(sanitizeInternalRedirect("https://example.com/pwned")).toBe(DEFAULT_AUTHENTICATED_REDIRECT);
    expect(sanitizeInternalRedirect("//example.com/pwned")).toBe(DEFAULT_AUTHENTICATED_REDIRECT);
    expect(sanitizeInternalRedirect("dashboard")).toBe(DEFAULT_AUTHENTICATED_REDIRECT);
  });
});
