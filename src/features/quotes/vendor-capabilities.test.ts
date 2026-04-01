import { describe, it, expect } from "vitest";
import type { VendorCapabilityProfile } from "@/features/quotes/types";
import type { VendorName } from "@/integrations/supabase/types";
import {
  resolveApplicableVendors,
  vendorSupportsProcess,
  vendorSupportsMaterial,
  vendorSupportsTolerance,
  getFallbackCapabilityProfiles,
  getVendorCapabilityProfile,
} from "@/features/quotes/vendor-capabilities";

function makeProfile(overrides: Partial<VendorCapabilityProfile> = {}): VendorCapabilityProfile {
  return {
    id: "test-1",
    vendor: "xometry" as VendorName,
    displayName: "Xometry",
    supportedProcesses: ["cnc_milling", "sheet_metal"],
    supportedMaterials: ["aluminum_6061", "stainless_steel_304"],
    supportedFinishes: ["anodize_type_ii", "bead_blast"],
    capabilityTags: ["cnc_milling", "sheet_metal", "material_aluminum", "material_stainless"],
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

describe("vendorSupportsProcess", () => {
  it("returns true when process is in supportedProcesses", () => {
    const profile = makeProfile();
    expect(vendorSupportsProcess(profile, "cnc_milling")).toBe(true);
  });

  it("returns true when process matches a capability tag", () => {
    const profile = makeProfile();
    expect(vendorSupportsProcess(profile, "material_aluminum")).toBe(true);
  });

  it("is case-insensitive", () => {
    const profile = makeProfile();
    expect(vendorSupportsProcess(profile, "CNC_MILLING")).toBe(true);
  });

  it("returns false for unsupported process", () => {
    const profile = makeProfile();
    expect(vendorSupportsProcess(profile, "injection_molding")).toBe(false);
  });
});

describe("vendorSupportsMaterial", () => {
  it("returns true when material is in supportedMaterials", () => {
    const profile = makeProfile();
    expect(vendorSupportsMaterial(profile, "aluminum_6061")).toBe(true);
  });

  it("fuzzy matches partial material names", () => {
    const profile = makeProfile();
    expect(vendorSupportsMaterial(profile, "aluminum")).toBe(true);
    expect(vendorSupportsMaterial(profile, "stainless")).toBe(true);
  });

  it("returns true for empty material", () => {
    const profile = makeProfile();
    expect(vendorSupportsMaterial(profile, "")).toBe(true);
  });

  it("returns false for unmatched material", () => {
    const profile = makeProfile();
    expect(vendorSupportsMaterial(profile, "titanium")).toBe(false);
  });
});

describe("vendorSupportsTolerance", () => {
  it("returns true when tolerance meets minimum", () => {
    const profile = makeProfile({ minToleranceInch: 0.001 });
    expect(vendorSupportsTolerance(profile, 0.005)).toBe(true);
  });

  it("returns false when tolerance is too tight", () => {
    const profile = makeProfile({ minToleranceInch: 0.001 });
    expect(vendorSupportsTolerance(profile, 0.0005)).toBe(false);
  });

  it("returns true when no tolerance specified", () => {
    const profile = makeProfile({ minToleranceInch: 0.001 });
    expect(vendorSupportsTolerance(profile, null)).toBe(true);
  });

  it("returns true when vendor has no min tolerance", () => {
    const profile = makeProfile({ minToleranceInch: null });
    expect(vendorSupportsTolerance(profile, 0.0001)).toBe(true);
  });
});

describe("resolveApplicableVendors", () => {
  const profiles: VendorCapabilityProfile[] = [
    makeProfile({ vendor: "xometry" as VendorName, id: "1" }),
    makeProfile({
      vendor: "sendcutsend" as VendorName,
      id: "2",
      supportedProcesses: ["laser_cutting"],
      capabilityTags: ["laser_cutting"],
      minToleranceInch: 0.005,
    }),
    makeProfile({
      vendor: "fictiv" as VendorName,
      id: "3",
      activeForQuotes: false,
    }),
  ];

  it("returns all active vendors when no filters", () => {
    const result = resolveApplicableVendors(profiles, null);
    expect(result).toContain("xometry");
    expect(result).toContain("sendcutsend");
    expect(result).not.toContain("fictiv");
  });

  it("filters by explicit vendor list", () => {
    const result = resolveApplicableVendors(profiles, ["xometry"]);
    expect(result).toEqual(["xometry"]);
  });

  it("filters by required process", () => {
    const result = resolveApplicableVendors(profiles, null, {
      requiredProcess: "laser_cutting",
    });
    expect(result).toEqual(["sendcutsend"]);
  });

  it("filters by tolerance", () => {
    const result = resolveApplicableVendors(profiles, null, {
      toleranceInch: 0.002,
    });
    expect(result).toContain("xometry");
    expect(result).not.toContain("sendcutsend");
  });

  it("falls back to defaults when no profiles provided", () => {
    const result = resolveApplicableVendors([], null);
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back when all vendors are filtered out", () => {
    const result = resolveApplicableVendors(profiles, null, {
      requiredProcess: "injection_molding",
    });
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("getFallbackCapabilityProfiles", () => {
  it("returns profiles for all default vendors", () => {
    const profiles = getFallbackCapabilityProfiles();
    const vendors = profiles.map((p) => p.vendor);
    expect(vendors).toContain("xometry");
    expect(vendors).toContain("fictiv");
    expect(vendors).toContain("protolabs");
    expect(vendors).toContain("sendcutsend");
  });

  it("returns profiles for all manual import vendors", () => {
    const profiles = getFallbackCapabilityProfiles();
    const vendors = profiles.map((p) => p.vendor);
    expect(vendors).toContain("partsbadger");
    expect(vendors).toContain("fastdms");
    expect(vendors).toContain("devzmanufacturing");
    expect(vendors).toContain("infraredlaboratories");
  });

  it("returns exactly 8 vendor profiles", () => {
    const profiles = getFallbackCapabilityProfiles();
    expect(profiles).toHaveLength(8);
  });

  it("all profiles are active", () => {
    const profiles = getFallbackCapabilityProfiles();
    expect(profiles.every((p) => p.activeForQuotes)).toBe(true);
  });

  it("instant quote vendors have supportsInstantQuote=true", () => {
    const profiles = getFallbackCapabilityProfiles();
    const instantVendors = profiles.filter((p) => p.supportsInstantQuote);
    expect(instantVendors.map((p) => p.vendor).sort()).toEqual([
      "fictiv",
      "protolabs",
      "sendcutsend",
      "xometry",
    ]);
  });

  it("manual import vendors have supportsInstantQuote=false", () => {
    const profiles = getFallbackCapabilityProfiles();
    const manualVendors = profiles.filter((p) => !p.supportsInstantQuote);
    expect(manualVendors.map((p) => p.vendor).sort()).toEqual([
      "devzmanufacturing",
      "fastdms",
      "infraredlaboratories",
      "partsbadger",
    ]);
  });

  it("sendcutsend has higher min tolerance", () => {
    const profiles = getFallbackCapabilityProfiles();
    const scs = profiles.find((p) => p.vendor === "sendcutsend");
    expect(scs?.minToleranceInch).toBe(0.005);
  });

  it("infraredlaboratories has tightest tolerance", () => {
    const profiles = getFallbackCapabilityProfiles();
    const ir = profiles.find((p) => p.vendor === "infraredlaboratories");
    expect(ir?.minToleranceInch).toBe(0.0005);
  });

  it("xometry has broadest process coverage", () => {
    const profiles = getFallbackCapabilityProfiles();
    const xometry = profiles.find((p) => p.vendor === "xometry");
    expect(xometry?.supportedProcesses).toHaveLength(10);
  });
});

describe("getVendorCapabilityProfile", () => {
  it("returns profile for known vendor", () => {
    const profiles = getFallbackCapabilityProfiles();
    const profile = getVendorCapabilityProfile(profiles, "xometry");
    expect(profile).not.toBeNull();
    expect(profile?.vendor).toBe("xometry");
  });

  it("returns profile for unknown manual import vendor", () => {
    const profiles = getFallbackCapabilityProfiles();
    const profile = getVendorCapabilityProfile(profiles, "partsbadger");
    expect(profile).not.toBeNull();
    expect(profile?.vendor).toBe("partsbadger");
    expect(profile?.supportsInstantQuote).toBe(false);
  });
});
