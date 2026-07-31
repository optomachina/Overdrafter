// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  isAllowlistedMobileReturnRoute,
  parseMobileReturnRoute,
} from "./return-routes";

describe("mobile return routes", () => {
  it.each([
    "/parts",
    "/parts/part-123",
    "/quotes",
    "/quotes/Q_123",
    "/search",
    "/projects/123e4567-e89b-42d3-a456-426614174000",
  ])("accepts an allowlisted mobile route: %s", (route) => {
    expect(isAllowlistedMobileReturnRoute(route)).toBe(true);
    expect(parseMobileReturnRoute(route)).toBe(route);
  });

  it.each([
    "https://evil.example/quotes",
    "//evil.example/quotes",
    "/admin",
    "/quotes/",
    "/quotes/..",
    "/quotes/%2e%2e",
    "/quotes/code?next=/admin",
    "/quotes/code#fragment",
    "/quotes/code/extra",
    "/quotes\\code",
  ])("rejects an ambiguous or non-client route: %s", (route) => {
    expect(isAllowlistedMobileReturnRoute(route)).toBe(false);
    expect(() => parseMobileReturnRoute(route)).toThrow();
  });

  it("defaults an omitted route to quotes", () => {
    expect(parseMobileReturnRoute(undefined)).toBe("/quotes");
  });
});
