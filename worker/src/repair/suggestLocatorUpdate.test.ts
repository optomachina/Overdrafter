// @vitest-environment node

import { describe, expect, it } from "vitest";
import { suggestLocatorUpdate } from "./suggestLocatorUpdate";

describe("suggestLocatorUpdate", () => {
  it("prefers nearby data test ids over generic timeout advice", () => {
    expect(
      suggestLocatorUpdate({
        failedSelector: ".legacy-button",
        errorMessage: "Timed out waiting for selector",
        nearbyAttributes: ['data-testid="submit-quote"'],
      }),
    ).toEqual({
      basis: "nearby_test_id",
      diagnosis: "A stable test id is present near the failed locator.",
      suggestion: "Prefer a data-testid or role-based locator over the legacy selector.",
      requiresHumanReview: true,
    });
  });

  it("suggests selector modernization when the failure looks like locator drift", () => {
    expect(
      suggestLocatorUpdate({
        failedSelector: ".quote-cta",
        errorMessage: "Locator not found after page update",
      }),
    ).toMatchObject({
      basis: "locator_failure",
      diagnosis: "The selector likely drifted after a vendor UI change.",
      requiresHumanReview: true,
    });
  });

  it("falls back to trace capture advice for ambiguous failures", () => {
    expect(
      suggestLocatorUpdate({
        failedSelector: ".quote-cta",
        errorMessage: "Unexpected browser disconnect",
      }),
    ).toMatchObject({
      basis: "unknown",
      suggestion: "Capture a Playwright trace and compare the current page with the last known-good flow.",
      requiresHumanReview: true,
    });
  });

  it("never publishes a numeric confidence beside measured extraction confidence", () => {
    const suggestion = suggestLocatorUpdate({
      failedSelector: ".quote-cta",
      errorMessage: "Timed out waiting for selector",
    });

    expect(suggestion).toMatchObject({
      basis: "locator_failure",
      requiresHumanReview: true,
    });
    expect(suggestion).not.toHaveProperty("confidence");
  });
});
