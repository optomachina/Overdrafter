// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApprovedRequirementRecord } from "./types.js";
import { supplierQuoteRequirement } from "./quoteAsMachined.js";
import { buildFinishSearchTerms } from "./adapters/xometryConstraints.js";

function requirement(finish: string | null, specSnapshot: unknown): ApprovedRequirementRecord {
  return {
    id: "requirement-1",
    part_id: "part-1",
    description: null,
    part_number: "1093-05589",
    revision: "02",
    material: "6061 Alloy",
    finish,
    tightest_tolerance_inch: 0.005,
    quantity: 1,
    quote_quantities: [1],
    requested_by_date: null,
    applicable_vendors: ["xometry"],
    spec_snapshot: specSnapshot,
  };
}

const drawingFinish = "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2";

// OVD-1163: the customer's "Quote as machined" choice applies to the supplier request only.
describe("supplierQuoteRequirement", () => {
  it("sends as machined when the choice names the current drawing finish", () => {
    const original = requirement(drawingFinish, { quoteAsMachined: { finish: drawingFinish } });
    const quoted = supplierQuoteRequirement(original);
    expect(quoted.finish).toBe("As machined");
    expect(buildFinishSearchTerms(quoted.finish)).toEqual([]);
    // The approved requirement itself is not changed.
    expect(original.finish).toBe(drawingFinish);
    expect(quoted.material).toBe(original.material);
  });

  it("matches the drawing finish the way the server does: case, spaces and punctuation ignored", () => {
    const quoted = supplierQuoteRequirement(
      requirement(drawingFinish, { quoteAsMachined: { finish: "anodize black mil-a-8625f type ii class 2" } }),
    );
    expect(quoted.finish).toBe("As machined");
  });

  it("keeps the drawing finish when the choice was made for a different finish", () => {
    const original = requirement(drawingFinish, { quoteAsMachined: { finish: "Bead blast" } });
    expect(supplierQuoteRequirement(original)).toBe(original);
  });

  it.each([
    ["no choice", {}],
    ["no snapshot", null],
    ["a malformed choice", { quoteAsMachined: true }],
    ["a non-text finish", { quoteAsMachined: { finish: 7 } }],
  ])("keeps the drawing finish with %s", (_label, snapshot) => {
    const original = requirement(drawingFinish, snapshot);
    expect(supplierQuoteRequirement(original)).toBe(original);
  });
});

describe("worker wiring", () => {
  // No harness drives the run_vendor_quote task end to end, so the wiring is pinned in source.
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

  it("fingerprints the approved requirement but quotes the supplier requirement", () => {
    const scope = source.slice(source.indexOf("buildQuoteLaneScopeSnapshot({"), source.indexOf("api_register_quote_request_lane"));
    expect(scope).toContain("requirement: context.requirement,");
    expect(source).toContain("const supplierRequirement = supplierQuoteRequirement(context.requirement);");
    const quotePath = source.slice(source.indexOf("api_register_quote_request_lane"));
    // Both adapter inputs, the generic sanity and offer requirement, the Xometry sanity context and offers.
    expect(quotePath.match(/requirement: supplierRequirement,/g)).toHaveLength(4);
    expect(quotePath).toContain("const approvedRequirement = supplierRequirement;");
    expect(quotePath).not.toMatch(/requirement: context\.requirement,/);
  });
});
