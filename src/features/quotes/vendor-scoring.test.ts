import { describe, it, expect } from "vitest";
import type { VendorCapabilityProfile } from "@/features/quotes/types";
import type { VendorName } from "@/integrations/supabase/types";
import {
  scoreVendor,
  computeTotalScore,
  rankVendors,
  formatScoreSummary,
  DEFAULT_SCORE_WEIGHTS,
} from "@/features/quotes/vendor-scoring";

function makeProfile(overrides: Partial<VendorCapabilityProfile> = {}): VendorCapabilityProfile {
  return {
    id: "test-1",
    vendor: "xometry" as VendorName,
    displayName: "Xometry",
    supportedProcesses: ["cnc_milling", "sheet_metal", "laser_cutting"],
    supportedMaterials: ["aluminum_6061", "stainless_steel_304", "delrin"],
    supportedFinishes: ["anodize_type_ii", "bead_blast"],
    capabilityTags: ["cnc_milling", "sheet_metal", "material_aluminum"],
    minToleranceInch: 0.001,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 1,
    typicalLeadMaxDays: 10,
    supportsInstantQuote: true,
    activeForQuotes: true,
    notes: null,
    ...overrides,
  };
}

describe("scoreVendor", () => {
  it("returns weighted breakdown for a vendor with all inputs", () => {
    const profile = makeProfile();
    const breakdown = scoreVendor({
      profile,
      unitPriceUsd: 100,
      leadTimeBusinessDays: 5,
      requiredProcess: "cnc_milling",
      requiredMaterial: "aluminum",
      toleranceInch: 0.005,
      allUnitPrices: [100, 120, 80],
      allLeadTimes: [5, 7, 3],
    });

    expect(breakdown.capabilityFit).toBeGreaterThan(0);
    expect(breakdown.price).toBeGreaterThan(0);
    expect(breakdown.leadTime).toBeGreaterThan(0);
    expect(breakdown.instantQuote).toBeGreaterThan(0);
    expect(breakdown.toleranceFit).toBeGreaterThan(0);
  });

  it("gives higher price score to lowest price", () => {
    const profile = makeProfile();
    const lowPrice = scoreVendor({
      profile,
      unitPriceUsd: 80,
      leadTimeBusinessDays: 5,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: null,
      allUnitPrices: [80, 100, 120],
      allLeadTimes: [5, 5, 5],
    });

    const highPrice = scoreVendor({
      profile,
      unitPriceUsd: 120,
      leadTimeBusinessDays: 5,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: null,
      allUnitPrices: [80, 100, 120],
      allLeadTimes: [5, 5, 5],
    });

    expect(lowPrice.price).toBeGreaterThan(highPrice.price);
  });

  it("gives higher lead time score to fastest vendor", () => {
    const profile = makeProfile();
    const fast = scoreVendor({
      profile,
      unitPriceUsd: 100,
      leadTimeBusinessDays: 3,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: null,
      allUnitPrices: [100, 100, 100],
      allLeadTimes: [3, 5, 7],
    });

    const slow = scoreVendor({
      profile,
      unitPriceUsd: 100,
      leadTimeBusinessDays: 7,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: null,
      allUnitPrices: [100, 100, 100],
      allLeadTimes: [3, 5, 7],
    });

    expect(fast.leadTime).toBeGreaterThan(slow.leadTime);
  });

  it("gives instant quote bonus to instant-quote vendors", () => {
    const instantProfile = makeProfile({ supportsInstantQuote: true });
    const manualProfile = makeProfile({ vendor: "partsbadger" as VendorName, supportsInstantQuote: false });

    const instant = scoreVendor({
      profile: instantProfile,
      unitPriceUsd: 100,
      leadTimeBusinessDays: 5,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: null,
      allUnitPrices: [100],
      allLeadTimes: [5],
    });

    const manual = scoreVendor({
      profile: manualProfile,
      unitPriceUsd: 100,
      leadTimeBusinessDays: 5,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: null,
      allUnitPrices: [100],
      allLeadTimes: [5],
    });

    expect(instant.instantQuote).toBeGreaterThan(0);
    expect(manual.instantQuote).toBe(0);
  });

  it("returns 0 tolerance fit when vendor cannot meet tolerance", () => {
    const profile = makeProfile({ minToleranceInch: 0.005 });
    const breakdown = scoreVendor({
      profile,
      unitPriceUsd: 100,
      leadTimeBusinessDays: 5,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: 0.001,
      allUnitPrices: [100],
      allLeadTimes: [5],
    });

    expect(breakdown.toleranceFit).toBe(0);
  });

  it("returns full tolerance fit when no tolerance specified", () => {
    const profile = makeProfile();
    const breakdown = scoreVendor({
      profile,
      unitPriceUsd: 100,
      leadTimeBusinessDays: 5,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: null,
      allUnitPrices: [100],
      allLeadTimes: [5],
    });

    expect(breakdown.toleranceFit).toBe(DEFAULT_SCORE_WEIGHTS.toleranceFit);
  });

  it("handles null profile gracefully", () => {
    const breakdown = scoreVendor({
      profile: null,
      unitPriceUsd: 100,
      leadTimeBusinessDays: 5,
      requiredProcess: "cnc_milling",
      requiredMaterial: "aluminum",
      toleranceInch: 0.005,
      allUnitPrices: [100],
      allLeadTimes: [5],
    });

    expect(breakdown.capabilityFit).toBeGreaterThan(0);
    expect(breakdown.price).toBeGreaterThan(0);
  });

  it("handles null prices and lead times gracefully", () => {
    const profile = makeProfile();
    const breakdown = scoreVendor({
      profile,
      unitPriceUsd: null,
      leadTimeBusinessDays: null,
      requiredProcess: null,
      requiredMaterial: null,
      toleranceInch: null,
      allUnitPrices: [null, null],
      allLeadTimes: [null, null],
    });

    expect(breakdown.price).toBeGreaterThan(0);
    expect(breakdown.leadTime).toBeGreaterThan(0);
  });
});

describe("computeTotalScore", () => {
  it("sums all weighted breakdown components", () => {
    const breakdown = {
      capabilityFit: 0.15,
      price: 0.20,
      leadTime: 0.10,
      instantQuote: 0.05,
      toleranceFit: 0.08,
    };

    const total = computeTotalScore(breakdown);
    expect(total).toBe(0.58);
  });
});

describe("rankVendors", () => {
  it("ranks vendors by total score descending", () => {
    const profile = makeProfile();
    const inputs = new Map([
      ["xometry" as VendorName, {
        profile,
        unitPriceUsd: 80,
        leadTimeBusinessDays: 5,
        requiredProcess: null,
        requiredMaterial: null,
        toleranceInch: null,
      }],
      ["fictiv" as VendorName, {
        profile: makeProfile({ vendor: "fictiv" as VendorName }),
        unitPriceUsd: 100,
        leadTimeBusinessDays: 7,
        requiredProcess: null,
        requiredMaterial: null,
        toleranceInch: null,
      }],
    ]);

    const ranked = rankVendors(inputs);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].vendor).toBe("xometry");
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].vendor).toBe("fictiv");
    expect(ranked[1].rank).toBe(2);
  });

  it("assigns sequential ranks", () => {
    const profile = makeProfile();
    const inputs = new Map([
      ["xometry" as VendorName, {
        profile,
        unitPriceUsd: 100,
        leadTimeBusinessDays: 5,
        requiredProcess: null,
        requiredMaterial: null,
        toleranceInch: null,
      }],
      ["fictiv" as VendorName, {
        profile: makeProfile({ vendor: "fictiv" as VendorName }),
        unitPriceUsd: 100,
        leadTimeBusinessDays: 5,
        requiredProcess: null,
        requiredMaterial: null,
        toleranceInch: null,
      }],
      ["protolabs" as VendorName, {
        profile: makeProfile({ vendor: "protolabs" as VendorName }),
        unitPriceUsd: 100,
        leadTimeBusinessDays: 5,
        requiredProcess: null,
        requiredMaterial: null,
        toleranceInch: null,
      }],
    ]);

    const ranked = rankVendors(inputs);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("ranks capability match higher when process is required", () => {
    const laserProfile = makeProfile({
      vendor: "sendcutsend" as VendorName,
      supportedProcesses: ["laser_cutting"],
      capabilityTags: ["laser_cutting"],
    });
    const cncProfile = makeProfile({
      vendor: "xometry" as VendorName,
      supportedProcesses: ["cnc_milling"],
      capabilityTags: ["cnc_milling"],
    });

    const inputs = new Map([
      ["sendcutsend" as VendorName, {
        profile: laserProfile,
        unitPriceUsd: 100,
        leadTimeBusinessDays: 5,
        requiredProcess: "laser_cutting",
        requiredMaterial: null,
        toleranceInch: null,
      }],
      ["xometry" as VendorName, {
        profile: cncProfile,
        unitPriceUsd: 100,
        leadTimeBusinessDays: 5,
        requiredProcess: "laser_cutting",
        requiredMaterial: null,
        toleranceInch: null,
      }],
    ]);

    const ranked = rankVendors(inputs);
    expect(ranked[0].vendor).toBe("sendcutsend");
  });
});

describe("formatScoreSummary", () => {
  it("returns summary string for scored vendors", () => {
    const profile = makeProfile();
    const inputs = new Map([
      ["xometry" as VendorName, {
        profile,
        unitPriceUsd: 100,
        leadTimeBusinessDays: 5,
        requiredProcess: null,
        requiredMaterial: null,
        toleranceInch: null,
      }],
    ]);

    const ranked = rankVendors(inputs);
    const summary = formatScoreSummary(ranked);

    expect(summary).toContain("#1");
    expect(summary).toContain("xometry");
    expect(summary).toContain("$100.00");
    expect(summary).toContain("5d");
  });

  it("returns message for empty vendor list", () => {
    const summary = formatScoreSummary([]);
    expect(summary).toBe("No vendors scored.");
  });
});
