import { describe, expect, it } from "vitest";
import { createDefaultProcurementHandoffState, summarizeProcurementHandoff } from "./procurement-handoff";

describe("procurement handoff billing email", () => {
  it.each([
    ["not-an-email", false, ["a valid billing contact email"]],
    [" buyer@example.com ", true, []],
    ["", false, ["billing contact email"]],
    ["buyer..name@example.com", false, ["a valid billing contact email"]],
    [".buyer@example.com", false, ["a valid billing contact email"]],
    ["buyer.@example.com", false, ["a valid billing contact email"]],
    ["a@b", false, ["a valid billing contact email"]],
  ] as const)("validates %j before declaring readiness", (billingContactEmail, ready, missingFields) => {
    const summary = summarizeProcurementHandoff({
      ...createDefaultProcurementHandoffState(),
      shipToContact: "Buyer", shipToLocation: "Austin", billingContactName: "Buyer", billingContactEmail,
    });
    expect(summary.ready).toBe(ready);
    expect(summary.missingFields).toEqual(missingFields);
  });
});
