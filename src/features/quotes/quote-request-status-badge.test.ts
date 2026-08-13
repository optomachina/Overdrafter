import { describe, expect, it } from "vitest";
import { getQuoteRequestStatusBadgeClassName } from "@/features/quotes/quote-request-status-badge";

describe("getQuoteRequestStatusBadgeClassName", () => {
  it.each([
    ["not_requested", "border border-border bg-accent text-foreground/80"],
    ["queued", "border border-amber-300 bg-amber-300 text-amber-950 hover:bg-amber-300"],
    ["requesting", "border border-amber-300 bg-amber-300 text-amber-950 hover:bg-amber-300"],
    ["received", "border border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-700"],
    ["failed", "border border-rose-700 bg-rose-700 text-white hover:bg-rose-700"],
    ["canceled", "border border-rose-700 bg-rose-700 text-white hover:bg-rose-700"],
  ] as const)("returns the canonical badge classes for %s", (status, className) => {
    expect(getQuoteRequestStatusBadgeClassName(status)).toContain(className);
  });
});
