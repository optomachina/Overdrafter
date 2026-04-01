import type { VendorCapabilityProfile } from "@/features/quotes/types";
import type { VendorName } from "@/integrations/supabase/types";
import { DEFAULT_APPLICABLE_VENDORS } from "@/features/quotes/utils";

/**
 * Vendor capability profile cache (client-side fallback).
 * In production, profiles come from Supabase via RPC or table query.
 * This provides deterministic fallback when the DB table is not yet populated.
 */
const FALLBACK_CAPABILITY_PROFILES: VendorCapabilityProfile[] = [
  {
    id: "fallback-xometry",
    vendor: "xometry",
    displayName: "Xometry",
    supportedProcesses: [
      "cnc_milling", "cnc_turning", "sheet_metal", "injection_molding",
      "3d_printing", "laser_cutting", "waterjet", "edm",
      "urethane_casting", "metal_3d_printing",
    ],
    supportedMaterials: [
      "aluminum_6061", "aluminum_7075", "stainless_steel_304", "stainless_steel_316",
      "steel_1018", "steel_4140", "brass", "copper", "titanium_ti64",
      "abs", "delrin", "peek", "nylon", "polycarbonate",
    ],
    supportedFinishes: [
      "anodize_type_ii", "anodize_type_iii", "powder_coat",
      "bead_blast", "passivation", "plating", "chromate",
    ],
    capabilityTags: [
      "cnc_milling", "cnc_turning", "sheet_metal", "injection_molding",
      "3d_printing", "laser_cutting", "waterjet", "edm",
      "urethane_casting", "metal_3d_printing",
      "finishing_anodize", "finishing_powder_coat", "finishing_bead_blast",
      "finishing_plating", "finishing_passivation",
      "material_aluminum", "material_steel", "material_stainless",
      "material_plastic_abs", "material_plastic_delrin", "material_plastic_peek",
      "material_plastic_nylon", "material_brass", "material_copper", "material_titanium",
      "tight_tolerance", "high_volume", "rapid_prototyping", "production_run",
    ],
    minToleranceInch: 0.0005,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 1,
    typicalLeadMaxDays: 20,
    supportsInstantQuote: true,
    activeForQuotes: true,
    notes: "Full-service marketplace with broadest capability coverage.",
  },
  {
    id: "fallback-fictiv",
    vendor: "fictiv",
    displayName: "Fictiv",
    supportedProcesses: [
      "cnc_milling", "cnc_turning", "sheet_metal", "injection_molding",
      "3d_printing", "urethane_casting",
    ],
    supportedMaterials: [
      "aluminum_6061", "aluminum_7075", "stainless_steel_304", "stainless_steel_316",
      "steel_1018", "brass", "abs", "delrin", "peek", "nylon", "polycarbonate",
    ],
    supportedFinishes: [
      "anodize_type_ii", "anodize_type_iii", "powder_coat",
      "bead_blast", "passivation", "plating",
    ],
    capabilityTags: [
      "cnc_milling", "cnc_turning", "sheet_metal", "injection_molding",
      "3d_printing", "urethane_casting",
      "finishing_anodize", "finishing_powder_coat", "finishing_bead_blast",
      "finishing_plating", "finishing_passivation",
      "material_aluminum", "material_steel", "material_stainless",
      "material_plastic_abs", "material_plastic_delrin", "material_plastic_peek",
      "material_plastic_nylon", "material_brass",
      "tight_tolerance", "rapid_prototyping", "production_run",
    ],
    minToleranceInch: 0.001,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 2,
    typicalLeadMaxDays: 15,
    supportsInstantQuote: true,
    activeForQuotes: true,
    notes: "Digital manufacturing platform focused on CNC and injection molding.",
  },
  {
    id: "fallback-protolabs",
    vendor: "protolabs",
    displayName: "Protolabs",
    supportedProcesses: [
      "cnc_milling", "cnc_turning", "injection_molding", "3d_printing", "sheet_metal",
    ],
    supportedMaterials: [
      "aluminum_6061", "aluminum_7075", "stainless_steel_304", "steel_1018",
      "brass", "abs", "delrin", "peek", "nylon", "polycarbonate", "polypropylene",
    ],
    supportedFinishes: ["anodize_type_ii", "bead_blast", "powder_coat", "passivation"],
    capabilityTags: [
      "cnc_milling", "cnc_turning", "injection_molding", "3d_printing", "sheet_metal",
      "finishing_anodize", "finishing_powder_coat", "finishing_bead_blast", "finishing_passivation",
      "material_aluminum", "material_steel", "material_stainless",
      "material_plastic_abs", "material_plastic_delrin", "material_plastic_peek",
      "material_plastic_nylon", "material_brass",
      "tight_tolerance", "rapid_prototyping", "production_run",
    ],
    minToleranceInch: 0.001,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 1,
    typicalLeadMaxDays: 15,
    supportsInstantQuote: true,
    activeForQuotes: true,
    notes: "Rapid prototyping and low-volume production with automated quoting.",
  },
  {
    id: "fallback-sendcutsend",
    vendor: "sendcutsend",
    displayName: "SendCutSend",
    supportedProcesses: ["laser_cutting", "waterjet", "sheet_metal"],
    supportedMaterials: [
      "aluminum_5052", "aluminum_6061", "stainless_steel_304", "stainless_steel_316",
      "steel_1018", "brass", "copper", "titanium_ti64", "acrylic", "wood",
    ],
    supportedFinishes: [
      "anodize_type_ii", "anodize_type_iii", "powder_coat",
      "bead_blast", "plating", "chromate",
    ],
    capabilityTags: [
      "laser_cutting", "waterjet", "sheet_metal",
      "finishing_anodize", "finishing_powder_coat", "finishing_bead_blast", "finishing_plating",
      "material_aluminum", "material_steel", "material_stainless",
      "material_brass", "material_copper", "material_titanium",
      "rapid_prototyping",
    ],
    minToleranceInch: 0.005,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 2,
    typicalLeadMaxDays: 10,
    supportsInstantQuote: true,
    activeForQuotes: true,
    notes: "Specialized in laser-cut and sheet metal parts.",
  },
  {
    id: "fallback-partsbadger",
    vendor: "partsbadger",
    displayName: "PartsBadger",
    supportedProcesses: ["cnc_milling", "cnc_turning", "sheet_metal"],
    supportedMaterials: [
      "aluminum_6061", "stainless_steel_304", "steel_1018", "delrin",
    ],
    supportedFinishes: ["anodize_type_ii", "bead_blast"],
    capabilityTags: [
      "cnc_milling", "cnc_turning", "sheet_metal",
      "finishing_anodize", "finishing_bead_blast",
      "material_aluminum", "material_steel", "material_stainless",
      "material_plastic_delrin",
    ],
    minToleranceInch: 0.002,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 3,
    typicalLeadMaxDays: 14,
    supportsInstantQuote: false,
    activeForQuotes: true,
    notes: "Manual import vendor. CNC and sheet metal focus.",
  },
  {
    id: "fallback-fastdms",
    vendor: "fastdms",
    displayName: "FastDMS",
    supportedProcesses: ["cnc_milling", "cnc_turning", "injection_molding"],
    supportedMaterials: [
      "aluminum_6061", "stainless_steel_304", "steel_1018", "abs", "delrin",
    ],
    supportedFinishes: ["anodize_type_ii", "bead_blast"],
    capabilityTags: [
      "cnc_milling", "cnc_turning", "injection_molding",
      "finishing_anodize", "finishing_bead_blast",
      "material_aluminum", "material_steel", "material_stainless",
      "material_plastic_abs", "material_plastic_delrin",
    ],
    minToleranceInch: 0.002,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 5,
    typicalLeadMaxDays: 20,
    supportsInstantQuote: false,
    activeForQuotes: true,
    notes: "Manual import vendor. CNC and molding.",
  },
  {
    id: "fallback-devzmanufacturing",
    vendor: "devzmanufacturing",
    displayName: "DEVZ Manufacturing",
    supportedProcesses: ["cnc_milling", "cnc_turning", "sheet_metal"],
    supportedMaterials: [
      "aluminum_6061", "stainless_steel_304", "steel_1018",
    ],
    supportedFinishes: ["anodize_type_ii", "bead_blast"],
    capabilityTags: [
      "cnc_milling", "cnc_turning", "sheet_metal",
      "finishing_anodize", "finishing_bead_blast",
      "material_aluminum", "material_steel", "material_stainless",
    ],
    minToleranceInch: 0.002,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 5,
    typicalLeadMaxDays: 21,
    supportsInstantQuote: false,
    activeForQuotes: true,
    notes: "Manual import vendor. General CNC and fabrication.",
  },
  {
    id: "fallback-infraredlaboratories",
    vendor: "infraredlaboratories",
    displayName: "Infrared Laboratories",
    supportedProcesses: ["cnc_milling", "edm"],
    supportedMaterials: [
      "aluminum_6061", "stainless_steel_304", "titanium_ti64", "peek",
    ],
    supportedFinishes: ["anodize_type_ii", "passivation"],
    capabilityTags: [
      "cnc_milling", "edm",
      "finishing_anodize", "finishing_passivation",
      "material_aluminum", "material_stainless",
      "material_titanium", "material_plastic_peek",
      "tight_tolerance",
    ],
    minToleranceInch: 0.0005,
    minQuantity: 1,
    maxQuantity: null,
    typicalLeadMinDays: 7,
    typicalLeadMaxDays: 30,
    supportsInstantQuote: false,
    activeForQuotes: true,
    notes: "Manual import vendor. Specialized precision and aerospace-grade work.",
  },
];

/**
 * Check if a vendor supports a given process.
 */
export function vendorSupportsProcess(
  profile: VendorCapabilityProfile,
  process: string,
): boolean {
  const normalized = process.toLowerCase().trim();
  return (
    profile.supportedProcesses.some((p) => p.toLowerCase() === normalized) ||
    profile.capabilityTags.some((t) => t.toLowerCase() === normalized)
  );
}

/**
 * Check if a vendor supports a given material (fuzzy match).
 */
export function vendorSupportsMaterial(
  profile: VendorCapabilityProfile,
  material: string,
): boolean {
  if (!material || material.trim().length === 0) return true;
  const normalized = material.toLowerCase().trim();
  return profile.supportedMaterials.some((m) =>
    m.toLowerCase().includes(normalized),
  );
}

/**
 * Check if a vendor can hold a given tolerance.
 */
export function vendorSupportsTolerance(
  profile: VendorCapabilityProfile,
  toleranceInch: number | null | undefined,
): boolean {
  if (toleranceInch == null) return true;
  if (profile.minToleranceInch == null) return true;
  return toleranceInch >= profile.minToleranceInch;
}

/**
 * Resolve applicable vendors using capability profiles.
 *
 * This replaces the hardcoded DEFAULT_APPLICABLE_VENDORS fallback in utils.ts.
 * When capability profiles are available from the DB, they are used for filtering.
 * Otherwise, falls back to the default vendor list.
 *
 * @param profiles - Vendor capability profiles (from DB or fallback)
 * @param explicitVendors - Part-level applicable_vendors (may be empty)
 * @param requiredProcess - Optional process filter (e.g., "cnc_milling")
 * @param requiredMaterial - Optional material filter (e.g., "aluminum")
 * @param toleranceInch - Optional tolerance constraint
 */
export function resolveApplicableVendors(
  profiles: VendorCapabilityProfile[],
  explicitVendors: VendorName[] | null | undefined,
  options?: {
    requiredProcess?: string | null;
    requiredMaterial?: string | null;
    toleranceInch?: number | null;
  },
): VendorName[] {
  const activeProfiles = profiles.filter((p) => p.activeForQuotes);

  if (activeProfiles.length === 0) {
    return explicitVendors?.length ? explicitVendors : DEFAULT_APPLICABLE_VENDORS;
  }

  let candidates = activeProfiles;

  if (explicitVendors && explicitVendors.length > 0) {
    candidates = candidates.filter((p) => explicitVendors.includes(p.vendor));
  }

  if (options?.requiredProcess) {
    const filtered = candidates.filter((p) =>
      vendorSupportsProcess(p, options.requiredProcess!),
    );
    if (filtered.length > 0) {
      candidates = filtered;
    }
  }

  if (options?.requiredMaterial) {
    const filtered = candidates.filter((p) =>
      vendorSupportsMaterial(p, options.requiredMaterial!),
    );
    if (filtered.length > 0) {
      candidates = filtered;
    }
  }

  if (options?.toleranceInch != null) {
    const filtered = candidates.filter((p) =>
      vendorSupportsTolerance(p, options.toleranceInch),
    );
    if (filtered.length > 0) {
      candidates = filtered;
    }
  }

  if (candidates.length === 0) {
    return explicitVendors?.length ? explicitVendors : DEFAULT_APPLICABLE_VENDORS;
  }

  return candidates.map((p) => p.vendor);
}

/**
 * Get fallback capability profiles for client-side use.
 * In production, prefer fetching from Supabase.
 */
export function getFallbackCapabilityProfiles(): VendorCapabilityProfile[] {
  return FALLBACK_CAPABILITY_PROFILES;
}

/**
 * Get a single vendor's capability profile.
 */
export function getVendorCapabilityProfile(
  profiles: VendorCapabilityProfile[],
  vendor: VendorName,
): VendorCapabilityProfile | null {
  return profiles.find((p) => p.vendor === vendor) ?? null;
}
