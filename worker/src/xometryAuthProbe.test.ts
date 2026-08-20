import { describe, expect, it } from "vitest";
import { classifyXometryAuthProbe, isReadOnlyProbeRequest } from "./xometryAuthProbe.js";

describe("Xometry authentication probe", () => {
  it("accepts authenticated dashboard text without requiring an interaction", () => {
    expect(
      classifyXometryAuthProbe({
        url: "https://www.xometry.com/quoting/home/",
        bodyText: "Welcome back. Recent quotes",
        dashboardUploadButtonVisible: false,
      }),
    ).toEqual({ authenticated: true, reason: "authenticated_dashboard" });
  });

  it("accepts the authenticated dashboard upload button as a positive signal", () => {
    expect(
      classifyXometryAuthProbe({
        url: "https://www.xometry.com/quoting/home/",
        bodyText: "Instant quoting",
        dashboardUploadButtonVisible: true,
      }),
    ).toEqual({ authenticated: true, reason: "authenticated_dashboard" });
  });

  it.each([
    ["Sign in to continue", "https://www.xometry.com/login/", "login_required"],
    [
      "Upload a 3D model to see instant pricing, lead time, and DFM feedback. Already have an account?",
      "https://www.xometry.com/quoting/home/",
      "anonymous_quote_home",
    ],
    ["Verify you are human", "https://www.xometry.com/quoting/home/", "captcha"],
    ["Access denied", "https://www.xometry.com/quoting/home/", "provider_error"],
  ])("fails closed for %s", (bodyText, url, reason) => {
    expect(
      classifyXometryAuthProbe({
        url,
        bodyText,
        dashboardUploadButtonVisible: true,
      }),
    ).toEqual({ authenticated: false, reason });
  });

  it("does not accept a positive signal away from the quote dashboard", () => {
    expect(
      classifyXometryAuthProbe({
        url: "https://www.xometry.com/",
        bodyText: "Welcome back",
        dashboardUploadButtonVisible: true,
      }),
    ).toEqual({
      authenticated: false,
      reason: "authenticated_dashboard_not_confirmed",
    });
  });

  it("allows reads and Xometry query-only GraphQL requests", () => {
    const request = (method: string, url = "https://example.com", postData: string | null = null) =>
      isReadOnlyProbeRequest({ method, url, postData });

    expect(request("GET")).toBe(true);
    expect(request("head")).toBe(true);
    expect(request("OPTIONS")).toBe(true);
    expect(
      request(
        "POST",
        "https://www.xometry.com/api/graphql/",
        JSON.stringify({ query: "query Viewer { viewer { id } }" }),
      ),
    ).toBe(true);
    expect(
      request(
        "POST",
        "https://www.xometry.com/graphql/federation/buyer",
        JSON.stringify([{ query: "{ viewer { id } }" }]),
      ),
    ).toBe(true);
  });

  it("blocks mutations and non-allowlisted POST requests", () => {
    const request = (url: string, postData: string | null) =>
      isReadOnlyProbeRequest({ method: "POST", url, postData });

    expect(
      request(
        "https://www.xometry.com/api/graphql/",
        JSON.stringify({ query: "mutation Upload { uploadPart }" }),
      ),
    ).toBe(false);
    expect(
      request(
        "https://www.xometry.com/api/graphql/",
        JSON.stringify({
          query: "query Viewer { viewer { id } } mutation Upload { uploadPart }",
          operationName: "Upload",
        }),
      ),
    ).toBe(false);
    expect(
      request(
        "https://www.xometry.com/api/graphql/",
        JSON.stringify({ query: "subscription Updates { quoteUpdated { id } }" }),
      ),
    ).toBe(false);
    expect(
      request(
        "https://example.com/api/graphql/",
        JSON.stringify({ query: "query Viewer { viewer { id } }" }),
      ),
    ).toBe(false);
    expect(request("https://www.xometry.com/api/graphql/", null)).toBe(false);
    expect(request("https://www.xometry.com/api/graphql/", "not-json")).toBe(false);
    expect(isReadOnlyProbeRequest({ method: "PUT", url: "https://www.xometry.com", postData: null })).toBe(false);
  });
});
