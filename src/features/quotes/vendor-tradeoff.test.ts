import { describe, it, expect } from "vitest";
import type { VendorName } from "@/integrations/supabase/types";
import type { ScoredVendorOption } from "@/features/quotes/vendor-scoring";
import {
  buildVendorTradeoffSummary,
  formatTradeoffTable,
} from "@/features/quotes/vendor-tradeoff";

function makeScoredVendor(overrides: Partial<ScoredVendorOption> = {}): ScoredVendorOption {
  return {
    vendor: "xometry" as VendorName,
    profile: {
      id: "1",
      vendor: "xometry" as VendorName,
      displayName: "Xometry",
      supportedProcesses: ["cnc_milling", "sheet_metal"],
      supportedMaterials: ["aluminum_6061"],
      supportedFinishes: ["anodize_type_ii"],
      capabilityTags: ["cnc_milling"],
      minToleranceInch: 0.001,
      minQuantity: 1,
      maxQuantity: null,
      typicalLeadMinDays: 1,
      typicalLeadMaxDays: 10,
      supportsInstantQuote: true,
      activeForQuotes: true,
      notes: null,
    },
    unitPriceUsd: 100,
    leadTimeBusinessDays: 5,
    breakdown: {
      capabilityFit: 0.20,
      price: 0.25,
      leadTime: 0.15,
      instantQuote: 0.10,
      toleranceFit: 0.08,
    },
    totalScore: 0.78,
    rank: 1,
    ...overrides,
  };
}

describe("buildVendorTradeoffSummary", () => {
  it("builds summary for multiple vendors", () => {
    const vendors = [
      makeScoredVendor({
        vendor: "xometry" as VendorName,
        unitPriceUsd: 80,
        leadTimeBusinessDays: 5,
        rank: 1,
        totalScore: 0.85,
        breakdown: {
          capabilityFit: 0.25,
          price: 0.30,
          leadTime: 0.15,
          instantQuote: 0.10,
          toleranceFit: 0.05,
        },
      }),
      makeScoredVendor({
        vendor: "fictiv" as VendorName,
        profile: {
          id: "2",
          vendor: "fictiv" as VendorName,
          displayName: "Fictiv",
          supportedProcesses: ["cnc_milling"],
          supportedMaterials: ["aluminum_6061"],
          supportedFinishes: ["anodize_type_ii"],
          capabilityTags: ["cnc_milling"],
          minToleranceInch: 0.002,
          minQuantity: 1,
          maxQuantity: null,
          typicalLeadMinDays: 2,
          typicalLeadMaxDays: 15,
          supportsInstantQuote: true,
          activeForQuotes: true,
          notes: null,
        },
        unitPriceUsd: 120,
        leadTimeBusinessDays: 7,
        rank: 2,
        totalScore: 0.60,
        breakdown: {
          capabilityFit: 0.15,
          price: 0.10,
          leadTime: 0.08,
          instantQuote: 0.10,
          toleranceFit: 0.05,
        },
      }),
    ];

    const summary = buildVendorTradeoffSummary(vendors);

    expect(summary.tradeoffs).toHaveLength(2);
    expect(summary.topPick).not.toBeNull();
    expect(summary.topPick?.vendor).toBe("xometry");
    expect(summary.summaryNarrative).toContain("Xometry");
  });

  it("identifies strengths for top vendor", () => {
    const vendors = [
      makeScoredVendor({
        vendor: "xometry" as VendorName,
        unitPriceUsd: 80,
        rank: 1,
        totalScore: 0.85,
        breakdown: {
          capabilityFit: 0.25,
          price: 0.30,
          leadTime: 0.15,
          instantQuote: 0.10,
          toleranceFit: 0.05,
        },
      }),
      makeScoredVendor({
        vendor: "fictiv" as VendorName,
        unitPriceUsd: 120,
        rank: 2,
        totalScore: 0.60,
        breakdown: {
          capabilityFit: 0.15,
          price: 0.10,
          leadTime: 0.08,
          instantQuote: 0.10,
          toleranceFit: 0.05,
        },
      }),
    ];

    const summary = buildVendorTradeoffSummary(vendors);
    const topEntry = summary.tradeoffs[0];

    expect(topEntry.strengths.length).toBeGreaterThan(0);
    expect(topEntry.strengths.some((s) => s.toLowerCase().includes("price"))).toBe(true);
  });

  it("identifies weaknesses for lower-ranked vendor", () => {
    const vendors = [
      makeScoredVendor({
        vendor: "xometry" as VendorName,
        unitPriceUsd: 80,
        rank: 1,
        totalScore: 0.85,
        breakdown: {
          capabilityFit: 0.25,
          price: 0.30,
          leadTime: 0.15,
          instantQuote: 0.10,
          toleranceFit: 0.05,
        },
      }),
      makeScoredVendor({
        vendor: "fictiv" as VendorName,
        unitPriceUsd: 120,
        rank: 2,
        totalScore: 0.60,
        breakdown: {
          capabilityFit: 0.15,
          price: 0.10,
          leadTime: 0.08,
          instantQuote: 0.10,
          toleranceFit: 0.05,
        },
      }),
    ];

    const summary = buildVendorTradeoffSummary(vendors);
    const lowerEntry = summary.tradeoffs[1];

    expect(lowerEntry.weaknesses.length).toBeGreaterThan(0);
  });

  it("returns null topPick for empty vendor list", () => {
    const summary = buildVendorTradeoffSummary([]);
    expect(summary.topPick).toBeNull();
    expect(summary.summaryNarrative).toContain("No vendors");
  });

  it("includes dimension table for each vendor", () => {
    const vendors = [
      makeScoredVendor({
        vendor: "xometry" as VendorName,
        unitPriceUsd: 100,
        leadTimeBusinessDays: 5,
        rank: 1,
        totalScore: 0.78,
      }),
    ];

    const summary = buildVendorTradeoffSummary(vendors);
    const entry = summary.tradeoffs[0];

    expect(entry.dimensions.length).toBeGreaterThan(0);
    expect(entry.dimensions.some((d) => d.key === "price")).toBe(true);
    expect(entry.dimensions.some((d) => d.key === "leadTime")).toBe(true);
  });

  it("marks best-in-set dimensions correctly", () => {
    const vendors = [
      makeScoredVendor({
        vendor: "xometry" as VendorName,
        unitPriceUsd: 80,
        rank: 1,
        totalScore: 0.85,
        breakdown: {
          capabilityFit: 0.25,
          price: 0.30,
          leadTime: 0.15,
          instantQuote: 0.10,
          toleranceFit: 0.05,
        },
      }),
      makeScoredVendor({
        vendor: "fictiv" as VendorName,
        unitPriceUsd: 120,
        rank: 2,
        totalScore: 0.60,
        breakdown: {
          capabilityFit: 0.15,
          price: 0.10,
          leadTime: 0.08,
          instantQuote: 0.10,
          toleranceFit: 0.05,
        },
      }),
    ];

    const summary = buildVendorTradeoffSummary(vendors);
    const topEntry = summary.tradeoffs[0];
    const priceDim = topEntry.dimensions.find((d) => d.key === "price");

    expect(priceDim?.isBestInSet).toBe(true);
  });
});

describe("formatTradeoffTable", () => {
  it("returns markdown table for scored vendors", () => {
    const vendors = [
      makeScoredVendor({
        vendor: "xometry" as VendorName,
        unitPriceUsd: 100,
        leadTimeBusinessDays: 5,
        rank: 1,
        totalScore: 0.78,
      }),
    ];

    const summary = buildVendorTradeoffSummary(vendors);
    const table = formatTradeoffTable(summary);

    expect(table).toContain("| Rank |");
    expect(table).toContain("#1");
    expect(table).toContain("Xometry");
    expect(table).toContain("$100.00");
    expect(table).toContain("5 business days");
  });

  it("returns message for empty summary", () => {
    const summary = buildVendorTradeoffSummary([]);
    const table = formatTradeoffTable(summary);
    expect(table).toBe("No vendors to display.");
  });
});
