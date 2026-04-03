import { describe, expect, it } from "vitest";
import { getQuoteRequestStatusBadgeClassName } from "@/features/quotes/quote-request-status-badge";

describe("getQuoteRequestStatusBadgeClassName", () => {
  it.each([
    ["not_requested", "border-white/10 bg-white/6 text-white/70"],
    ["queued", "border-amber-400/20 bg-amber-500/10 text-amber-100"],
    ["requesting", "border-amber-400/20 bg-amber-500/10 text-amber-100"],
    ["received", "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"],
    ["failed", "border-rose-400/20 bg-rose-500/10 text-rose-100"],
    ["canceled", "border-rose-400/20 bg-rose-500/10 text-rose-100"],
  ] as const)("returns the canonical badge classes for %s", (status, className) => {
    expect(getQuoteRequestStatusBadgeClassName(status)).toContain(className);
  });
});
