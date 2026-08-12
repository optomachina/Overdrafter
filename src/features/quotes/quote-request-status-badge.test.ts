import { describe, expect, it } from "vitest";
import { getQuoteRequestStatusBadgeClassName } from "@/features/quotes/quote-request-status-badge";

describe("getQuoteRequestStatusBadgeClassName", () => {
  it.each([
    "not_requested",
    "queued",
    "requesting",
    "received",
    "failed",
    "canceled",
  ] as const)("returns the neutral, high-contrast badge treatment for %s", (status) => {
    const className = getQuoteRequestStatusBadgeClassName(status);

    expect(className).toContain("border-paper-hairline");
    expect(className).toContain("bg-paper-surface");
    expect(className).toContain("text-paper-ink");
    expect(className).not.toMatch(/(?:amber|emerald|rose)-/);
  });
});
