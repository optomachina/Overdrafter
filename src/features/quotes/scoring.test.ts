import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  normalizeLeadTimeScore,
  normalizePriceScore,
  rankVendors,
  scoreCapabilityMatch,
  scoreVendor,
} from "@/features/quotes/scoring";
import type {
  QuoteContext,
  ScoringWeights,
  VendorCapabilityProfile,
} from "@/features/quotes/scoring";

// ─── Shared test fixtures ────────────────────────────────────────────

const matchingProfile: VendorCapabilityProfile = {
  vendorName: "vendor-a",
  processTypes: ["cnc_milling", "cnc_turning"],
  materials: ["aluminum_6061", "stainless_304", "titanium_ti64"],
  toleranceMinMm: 0.01,
  toleranceMaxMm: 0.1,
  maxPartSizeMm: 500,
  minQuantity: 1,
  maxQuantity: 10000,
  geographicRegion: "US-CA",
  certifications: ["ISO_9001", "AS9100"],
  qualityScore: 85,
  leadTimeReliability: 90,
  costCompetitiveness: 70,
  domesticUs: true,
};

const partialProfile: VendorCapabilityProfile = {
  vendorName: "vendor-b",
  processTypes: ["cnc_milling", "injection_molding"],
  materials: ["aluminum_6061", "abs"],
  toleranceMinMm: 0.05,
  toleranceMaxMm: 0.2,
  maxPartSizeMm: 300,
  minQuantity: 10,
  maxQuantity: 5000,
  geographicRegion: "CN-GD",
  certifications: ["ISO_9001"],
  qualityScore: 60,
  leadTimeReliability: 70,
  costCompetitiveness: 90,
  domesticUs: false,
};

const incompatibleProfile: VendorCapabilityProfile = {
  vendorName: "vendor-c",
  processTypes: ["injection_molding", "die_casting"],
  materials: ["abs", "polycarbonate"],
  toleranceMinMm: 0.1,
  toleranceMaxMm: 0.5,
  maxPartSizeMm: 200,
  minQuantity: 100,
  maxQuantity: 50000,
  geographicRegion: "CN-SH",
  certifications: [],
  qualityScore: 40,
  leadTimeReliability: 50,
  costCompetitiveness: 95,
  domesticUs: false,
};

const cncContext: QuoteContext = {
  processType: "cnc_milling",
  materials: ["aluminum_6061", "stainless_304"],
  quantity: 50,
  toleranceRequiredMm: 0.05,
  partSizeMm: 150,
  requireDomestic: false,
  requiredCertifications: ["ISO_9001"],
};

const prices: Record<string, number> = {
  "vendor-a": 1200,
  "vendor-b": 800,
  "vendor-c": 500,
};

const leadTimes: Record<string, number> = {
  "vendor-a": 10,
  "vendor-b": 15,
  "vendor-c": 25,
};

// ─── scoreCapabilityMatch ────────────────────────────────────────────

describe("scoreCapabilityMatch", () => {
  it("returns 100 for a perfect match", () => {
    const score = scoreCapabilityMatch(matchingProfile, cncContext);
    expect(score).toBeGreaterThan(80);
  });

  it("returns 0 when process type does not match", () => {
    const score = scoreCapabilityMatch(incompatibleProfile, cncContext);
    expect(score).toBe(0);
  });

  it("penalizes partial material matches", () => {
    const context: QuoteContext = {
      ...cncContext,
      materials: ["aluminum_6061", "titanium_ti64"],
    };
    const score = scoreCapabilityMatch(partialProfile, context);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it("heavily penalizes when vendor has no matching materials", () => {
    const context: QuoteContext = {
      ...cncContext,
      materials: ["titanium_ti64", "inconel_718"],
    };
    const score = scoreCapabilityMatch(partialProfile, context);
    expect(score).toBe(75);
  });

  it("returns 100 when no materials are required", () => {
    const context: QuoteContext = {
      ...cncContext,
      materials: [],
    };
    const score = scoreCapabilityMatch(incompatibleProfile, context);
    expect(score).toBe(0);
  });

  it("returns 100 for tolerance when not specified", () => {
    const context: QuoteContext = {
      processType: "cnc_milling",
      materials: ["aluminum_6061"],
      quantity: 50,
    };
    const score = scoreCapabilityMatch(partialProfile, context);
    expect(score).toBeGreaterThan(0);
  });

  it("penalizes when tolerance is outside vendor range", () => {
    const context: QuoteContext = {
      processType: "cnc_milling",
      materials: ["aluminum_6061"],
      quantity: 50,
      toleranceRequiredMm: 0.001,
    };
    const score = scoreCapabilityMatch(partialProfile, context);
    expect(score).toBeLessThan(100);
  });

  it("returns 0 when quantity is below vendor minimum", () => {
    const profile: VendorCapabilityProfile = {
      ...partialProfile,
      processTypes: ["cnc_milling"],
      materials: ["aluminum_6061"],
      toleranceMinMm: null,
      toleranceMaxMm: null,
      certifications: [],
    };
    const context: QuoteContext = {
      processType: "cnc_milling",
      materials: ["aluminum_6061"],
      quantity: 5,
    };
    const score = scoreCapabilityMatch(profile, context);
    expect(score).toBe(0);
  });

  it("returns 0 when quantity exceeds vendor maximum", () => {
    const profile: VendorCapabilityProfile = {
      ...partialProfile,
      processTypes: ["cnc_milling"],
      materials: ["aluminum_6061"],
      toleranceMinMm: null,
      toleranceMaxMm: null,
      certifications: [],
    };
    const context: QuoteContext = {
      processType: "cnc_milling",
      materials: ["aluminum_6061"],
      quantity: 6000,
    };
    const score = scoreCapabilityMatch(profile, context);
    expect(score).toBe(0);
  });

  it("penalizes missing required certifications", () => {
    const context: QuoteContext = {
      ...cncContext,
      requiredCertifications: ["ISO_9001", "AS9100", "ISO_13485"],
    };
    const score = scoreCapabilityMatch(partialProfile, context);
    expect(score).toBeLessThan(85);
  });

  it("returns full certification score when none required", () => {
    const context: QuoteContext = {
      ...cncContext,
      requiredCertifications: undefined,
    };
    const score = scoreCapabilityMatch(incompatibleProfile, context);
    expect(score).toBe(0);
  });

  it("returns 0 when vendor has empty process types", () => {
    const profile: VendorCapabilityProfile = {
      ...matchingProfile,
      processTypes: [],
    };
    const score = scoreCapabilityMatch(profile, cncContext);
    expect(score).toBe(0);
  });
});

// ─── normalizePriceScore ─────────────────────────────────────────────

describe("normalizePriceScore", () => {
  it("gives 100 to the cheapest vendor", () => {
    const score = normalizePriceScore(prices, "vendor-c");
    expect(score).toBe(100);
  });

  it("gives proportional scores to more expensive vendors", () => {
    const scoreA = normalizePriceScore(prices, "vendor-a");
    const scoreB = normalizePriceScore(prices, "vendor-b");
    expect(scoreA).toBeCloseTo((500 / 1200) * 100, 1);
    expect(scoreB).toBeCloseTo((500 / 800) * 100, 1);
  });

  it("returns 100 for a single vendor", () => {
    const score = normalizePriceScore({ "only-vendor": 100 }, "only-vendor");
    expect(score).toBe(100);
  });

  it("returns 0 for a vendor with no price", () => {
    const score = normalizePriceScore(prices, "unknown-vendor");
    expect(score).toBe(0);
  });

  it("returns 0 for empty prices", () => {
    const score = normalizePriceScore({}, "vendor-a");
    expect(score).toBe(0);
  });

  it("handles all equal prices", () => {
    const equalPrices = { a: 100, b: 100, c: 100 };
    expect(normalizePriceScore(equalPrices, "a")).toBe(100);
    expect(normalizePriceScore(equalPrices, "b")).toBe(100);
    expect(normalizePriceScore(equalPrices, "c")).toBe(100);
  });

  it("returns 0 for zero price", () => {
    const zeroPrices = { a: 0, b: 100 };
    expect(normalizePriceScore(zeroPrices, "a")).toBe(0);
  });
});

// ─── normalizeLeadTimeScore ──────────────────────────────────────────

describe("normalizeLeadTimeScore", () => {
  it("gives 100 to the fastest vendor", () => {
    const score = normalizeLeadTimeScore(leadTimes, "vendor-a");
    expect(score).toBe(100);
  });

  it("gives proportional scores to slower vendors", () => {
    const scoreB = normalizeLeadTimeScore(leadTimes, "vendor-b");
    const scoreC = normalizeLeadTimeScore(leadTimes, "vendor-c");
    expect(scoreB).toBeCloseTo((10 / 15) * 100, 1);
    expect(scoreC).toBeCloseTo((10 / 25) * 100, 1);
  });

  it("returns 100 for a single vendor", () => {
    const score = normalizeLeadTimeScore({ "only-vendor": 10 }, "only-vendor");
    expect(score).toBe(100);
  });

  it("returns 0 for a vendor with no lead time", () => {
    const score = normalizeLeadTimeScore(leadTimes, "unknown-vendor");
    expect(score).toBe(0);
  });

  it("returns 0 for empty lead times", () => {
    const score = normalizeLeadTimeScore({}, "vendor-a");
    expect(score).toBe(0);
  });

  it("handles all equal lead times", () => {
    const equalLeadTimes = { a: 10, b: 10, c: 10 };
    expect(normalizeLeadTimeScore(equalLeadTimes, "a")).toBe(100);
    expect(normalizeLeadTimeScore(equalLeadTimes, "b")).toBe(100);
    expect(normalizeLeadTimeScore(equalLeadTimes, "c")).toBe(100);
  });

  it("handles zero lead time for fastest vendor", () => {
    const leadTimesWithZero = { a: 0, b: 10 };
    expect(normalizeLeadTimeScore(leadTimesWithZero, "a")).toBe(100);
    expect(normalizeLeadTimeScore(leadTimesWithZero, "b")).toBe(0);
  });
});

// ─── scoreVendor ─────────────────────────────────────────────────────

describe("scoreVendor", () => {
  it("returns a complete score with all dimensions", () => {
    const result = scoreVendor(matchingProfile, cncContext, prices, leadTimes);
    expect(result.vendorName).toBe("vendor-a");
    expect(result.overallScore).toBeGreaterThan(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    expect(result.priceScore).toBeGreaterThan(0);
    expect(result.leadTimeScore).toBeGreaterThan(0);
    expect(result.qualityScore).toBe(85);
    expect(result.capabilityMatchScore).toBeGreaterThan(0);
    expect(result.domesticScore).toBe(100);
  });

  it("includes detailed breakdown", () => {
    const result = scoreVendor(matchingProfile, cncContext, prices, leadTimes);
    expect(result.breakdown.process).toBeDefined();
    expect(result.breakdown.materials).toBeDefined();
    expect(result.breakdown.tolerance).toBeDefined();
    expect(result.breakdown.quantity).toBeDefined();
    expect(result.breakdown.certifications).toBeDefined();
  });

  it("uses null quality score as 0", () => {
    const profile: VendorCapabilityProfile = {
      ...matchingProfile,
      qualityScore: null,
    };
    const result = scoreVendor(profile, cncContext, prices, leadTimes);
    expect(result.qualityScore).toBe(0);
  });

  it("respects custom weights", () => {
    const priceHeavyWeights: ScoringWeights = {
      price: 0.70,
      leadTime: 0.10,
      quality: 0.05,
      capabilityMatch: 0.10,
      domestic: 0.05,
    };

    const defaultResult = scoreVendor(
      partialProfile,
      cncContext,
      prices,
      leadTimes,
    );
    const customResult = scoreVendor(
      partialProfile,
      cncContext,
      prices,
      leadTimes,
      priceHeavyWeights,
    );

    expect(customResult.overallScore).not.toBe(defaultResult.overallScore);
  });

  it("filters incompatible vendors from rankVendors", () => {
    const ranked = rankVendors(
      [matchingProfile, partialProfile, incompatibleProfile],
      cncContext,
      prices,
      leadTimes,
    );

    const vendorNames = ranked.map((r) => r.vendorName);
    expect(vendorNames).not.toContain("vendor-c");
    expect(vendorNames).toContain("vendor-a");
    expect(vendorNames).toContain("vendor-b");
  });

  it("ranks vendors by overallScore descending", () => {
    const ranked = rankVendors(
      [matchingProfile, partialProfile],
      cncContext,
      prices,
      leadTimes,
    );

    expect(ranked[0].overallScore).toBeGreaterThanOrEqual(ranked[1].overallScore);
  });

  it("returns empty array when all vendors are ineligible", () => {
    const ranked = rankVendors(
      [incompatibleProfile],
      cncContext,
      prices,
      leadTimes,
    );

    expect(ranked).toEqual([]);
  });

  it("returns empty array for empty profiles", () => {
    const ranked = rankVendors([], cncContext, prices, leadTimes);
    expect(ranked).toEqual([]);
  });

  it("custom weights can change rankings", () => {
    const domesticContext: QuoteContext = {
      ...cncContext,
      requireDomestic: true,
    };

    const domesticHeavyWeights: ScoringWeights = {
      price: 0.10,
      leadTime: 0.10,
      quality: 0.10,
      capabilityMatch: 0.20,
      domestic: 0.50,
    };

    const defaultRanked = rankVendors(
      [matchingProfile, partialProfile],
      domesticContext,
      prices,
      leadTimes,
    );
    const customRanked = rankVendors(
      [matchingProfile, partialProfile],
      domesticContext,
      prices,
      leadTimes,
      domesticHeavyWeights,
    );

    expect(defaultRanked[0].vendorName).toBe(matchingProfile.vendorName);
    expect(customRanked[0].vendorName).toBe(matchingProfile.vendorName);
    expect(customRanked.length).toBe(2);
    expect(customRanked[0].domesticScore).toBe(100);
    expect(customRanked[1].domesticScore).toBe(0);
  });

  it("domestic score is 0 for foreign vendor when domestic required", () => {
    const domesticContext: QuoteContext = {
      ...cncContext,
      requireDomestic: true,
    };
    const result = scoreVendor(partialProfile, domesticContext, prices, leadTimes);
    expect(result.domesticScore).toBe(0);
  });

  it("domestic score is 50 for foreign vendor when domestic not required", () => {
    const result = scoreVendor(partialProfile, cncContext, prices, leadTimes);
    expect(result.domesticScore).toBe(50);
  });

  it("domestic score is 100 for domestic vendor", () => {
    const result = scoreVendor(matchingProfile, cncContext, prices, leadTimes);
    expect(result.domesticScore).toBe(100);
  });
});

// ─── DEFAULT_WEIGHTS ─────────────────────────────────────────────────

describe("DEFAULT_WEIGHTS", () => {
  it("sums to 1.0", () => {
    const sum =
      DEFAULT_WEIGHTS.price +
      DEFAULT_WEIGHTS.leadTime +
      DEFAULT_WEIGHTS.quality +
      DEFAULT_WEIGHTS.capabilityMatch +
      DEFAULT_WEIGHTS.domestic;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("has price as the highest weight", () => {
    expect(DEFAULT_WEIGHTS.price).toBeGreaterThan(DEFAULT_WEIGHTS.leadTime);
    expect(DEFAULT_WEIGHTS.price).toBeGreaterThan(DEFAULT_WEIGHTS.quality);
    expect(DEFAULT_WEIGHTS.price).toBeGreaterThan(DEFAULT_WEIGHTS.capabilityMatch);
    expect(DEFAULT_WEIGHTS.price).toBeGreaterThan(DEFAULT_WEIGHTS.domestic);
  });
});
