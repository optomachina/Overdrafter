import { afterEach, describe, expect, it, vi } from "vitest";
import { isControlledBetaSingleQuantityEnabled } from "./single-quantity-flag";

describe("isControlledBetaSingleQuantityEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off unless explicitly set to 1", () => {
    expect(isControlledBetaSingleQuantityEnabled(undefined)).toBe(false);
    expect(isControlledBetaSingleQuantityEnabled("")).toBe(false);
    expect(isControlledBetaSingleQuantityEnabled("0")).toBe(false);
    expect(isControlledBetaSingleQuantityEnabled("true")).toBe(false);
    expect(isControlledBetaSingleQuantityEnabled("1")).toBe(true);
  });

  it("reads VITE_CONTROLLED_BETA_SINGLE_QUANTITY by default", () => {
    vi.stubEnv("VITE_CONTROLLED_BETA_SINGLE_QUANTITY", "");
    expect(isControlledBetaSingleQuantityEnabled()).toBe(false);
    vi.stubEnv("VITE_CONTROLLED_BETA_SINGLE_QUANTITY", "1");
    expect(isControlledBetaSingleQuantityEnabled()).toBe(true);
  });
});
