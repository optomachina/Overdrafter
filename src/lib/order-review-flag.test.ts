import { afterEach, describe, expect, it, vi } from "vitest";
import { isOrderReviewEnabled } from "./order-review-flag";

describe("isOrderReviewEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off unless explicitly set to 1", () => {
    expect(isOrderReviewEnabled(undefined)).toBe(false);
    expect(isOrderReviewEnabled("")).toBe(false);
    expect(isOrderReviewEnabled("0")).toBe(false);
    expect(isOrderReviewEnabled("true")).toBe(false);
    expect(isOrderReviewEnabled("1")).toBe(true);
  });

  it("reads VITE_ENABLE_ORDER_REVIEW by default", () => {
    vi.stubEnv("VITE_ENABLE_ORDER_REVIEW", "");
    expect(isOrderReviewEnabled()).toBe(false);
    vi.stubEnv("VITE_ENABLE_ORDER_REVIEW", "1");
    expect(isOrderReviewEnabled()).toBe(true);
  });
});
