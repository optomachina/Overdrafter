export type LocatorRepairSuggestion = {
  basis: "nearby_test_id" | "locator_failure" | "unknown";
  diagnosis: string;
  suggestion: string;
  requiresHumanReview: true;
};

/**
 * Produces operator triage guidance from the limited repair-task payload.
 *
 * This function cannot inspect the current vendor page, DOM snapshot, or trace,
 * so its output is deliberately categorical rather than a measured confidence
 * score. Every suggestion requires human review before an adapter is changed.
 */
export function suggestLocatorUpdate(input: {
  failedSelector: string;
  errorMessage: string;
  nearbyAttributes?: string[];
}): LocatorRepairSuggestion {
  if (input.nearbyAttributes?.some((attribute) => attribute.includes("data-testid"))) {
    return {
      basis: "nearby_test_id",
      diagnosis: "A stable test id is present near the failed locator.",
      suggestion: "Prefer a data-testid or role-based locator over the legacy selector.",
      requiresHumanReview: true,
    };
  }

  if (/not found|timed?\s*out|timeout/i.test(input.errorMessage)) {
    return {
      basis: "locator_failure",
      diagnosis: "The selector likely drifted after a vendor UI change.",
      suggestion: "Inspect the current DOM snapshot and replace CSS selectors with role, label, or text locators.",
      requiresHumanReview: true,
    };
  }

  return {
    basis: "unknown",
    diagnosis: "No strong selector diagnosis was inferred from the failure payload.",
    suggestion: "Capture a Playwright trace and compare the current page with the last known-good flow.",
    requiresHumanReview: true,
  };
}
