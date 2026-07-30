// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  gateLeadTime,
  gateVendorPrice,
  priceGateEvidence,
  type ExtractedValue,
} from "./extractedValue.js";

function price(value: number | null, source: ExtractedValue<number>["source"]): ExtractedValue<number> {
  return { value, source, selector: source === "selector" ? "[data-testid='price']" : null };
}

describe("gateVendorPrice", () => {
  it("trusts a price anchored to a declared locator", () => {
    const gate = gateVendorPrice(price(1249.5, "selector"));

    expect(gate.trusted).toBe(true);
    expect(gate.reason).toBe("anchored");
    expect(gate.locatorDriftDetected).toBe(false);
    expect(gate.unanchoredPriceUsd).toBeNull();
  });

  it("refuses a price recovered from whole-page text and flags locator drift", () => {
    const gate = gateVendorPrice(price(19.99, "body_text"));

    expect(gate.trusted).toBe(false);
    expect(gate.reason).toBe("unanchored_price");
    expect(gate.locatorDriftDetected).toBe(true);
    // The observation is retained as evidence so ops can re-anchor the adapter.
    expect(gate.unanchoredPriceUsd).toBe(19.99);
  });

  it("reports no price without claiming drift when nothing was found", () => {
    const gate = gateVendorPrice(price(null, "none"));

    expect(gate.trusted).toBe(false);
    expect(gate.reason).toBe("no_price");
    expect(gate.locatorDriftDetected).toBe(false);
    expect(gate.unanchoredPriceUsd).toBeNull();
  });
});

describe("gateLeadTime", () => {
  it("publishes an anchored lead time alongside a trusted price", () => {
    const gate = gateVendorPrice(price(1000, "selector"));

    expect(gateLeadTime(price(10, "selector"), gate)).toBe(10);
  });

  it("withholds an unanchored lead time even when the price is trusted", () => {
    const gate = gateVendorPrice(price(1000, "selector"));

    expect(gateLeadTime(price(10, "body_text"), gate)).toBeNull();
  });

  it("withholds an anchored lead time when the price was withheld", () => {
    const gate = gateVendorPrice(price(1000, "body_text"));

    expect(gateLeadTime(price(10, "selector"), gate)).toBeNull();
  });

  it("returns null when no lead time was found", () => {
    const gate = gateVendorPrice(price(1000, "selector"));

    expect(gateLeadTime(price(null, "none"), gate)).toBeNull();
  });
});

describe("priceGateEvidence", () => {
  it("exposes drift provenance without exposing a quotable number", () => {
    const evidence = priceGateEvidence(gateVendorPrice(price(19.99, "body_text")));

    expect(evidence).toEqual({
      priceTrusted: false,
      priceGateReason: "unanchored_price",
      locatorDriftDetected: true,
      unanchoredPriceObservedUsd: 19.99,
    });
    // The evidence key is deliberately not one any quote-facing reader consumes.
    expect(evidence).not.toHaveProperty("totalPriceUsd");
  });
});
