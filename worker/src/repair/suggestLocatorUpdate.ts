export type LocatorRepairSuggestion = {
  confidence: number;
  diagnosis: string;
  suggestion: string;
};

export function suggestLocatorUpdate(input: {
  failedSelector: string;
  errorMessage: string;
  nearbyAttributes?: string[];
}): LocatorRepairSuggestion {
  if (input.nearbyAttributes?.some((attribute) => attribute.includes("data-testid"))) {
    return {
      confidence: 0.8,
      diagnosis: "A stable test id is present near the failed locator.",
      suggestion: "Prefer a data-testid or role-based locator over the legacy selector.",
    };
  }

  if (/not found|timeout/i.test(input.errorMessage)) {
    return {
      confidence: 0.55,
      diagnosis: "The selector likely drifted after a vendor UI change.",
      suggestion: "Inspect the current DOM snapshot and replace CSS selectors with role, label, or text locators.",
    };
  }

  return {
    confidence: 0.35,
    diagnosis: "No strong selector diagnosis was inferred from the failure payload.",
    suggestion: "Capture a Playwright trace and compare the current page with the last known-good flow.",
  };
}
