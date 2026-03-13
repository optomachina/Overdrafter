import type {
  ApprovedPartRequirement,
  ClientPartRequestUpdateInput,
  RfqInspectionLevel,
  RfqLineItemCertificationRequirements,
  RfqLineItemExtendedMetadata,
  RfqLineItemReleaseContext,
  RfqLineItemShippingConstraints,
  RfqLineItemSourcingPreferences,
  RfqReleaseStatus,
  RfqReviewDisposition,
  RfqSourcingRegionPreference,
} from "@/features/quotes/types";
import type { Json } from "@/integrations/supabase/types";

type LabeledValue<T extends string> = {
  value: T;
  label: string;
};

const RFQ_INSPECTION_LEVEL_VALUES = ["standard", "fai", "custom"] as const;
const RFQ_REGION_PREFERENCE_VALUES = [
  "best_value",
  "domestic_preferred",
  "domestic_only",
  "foreign_allowed",
] as const;
const RFQ_RELEASE_STATUS_VALUES = ["unknown", "prototype", "pre_release", "released"] as const;
const RFQ_REVIEW_DISPOSITION_VALUES = ["draft", "needs_review", "approved_for_quote", "hold"] as const;
const RFQ_MATERIAL_PROVISIONING_VALUES = [
  "supplier_to_source",
  "customer_supplied",
  "tbd",
] as const;

export const RFQ_INSPECTION_LEVEL_OPTIONS: Array<LabeledValue<RfqInspectionLevel>> = [
  { value: "standard", label: "Standard" },
  { value: "fai", label: "FAI" },
  { value: "custom", label: "Custom" },
];

export const RFQ_REGION_PREFERENCE_OPTIONS: Array<LabeledValue<RfqSourcingRegionPreference>> = [
  { value: "best_value", label: "Best value" },
  { value: "domestic_preferred", label: "Domestic preferred" },
  { value: "domestic_only", label: "Domestic only" },
  { value: "foreign_allowed", label: "Foreign allowed" },
];

export const RFQ_RELEASE_STATUS_OPTIONS: Array<LabeledValue<RfqReleaseStatus>> = [
  { value: "unknown", label: "Unknown" },
  { value: "prototype", label: "Prototype" },
  { value: "pre_release", label: "Pre-release" },
  { value: "released", label: "Released" },
];

export const RFQ_REVIEW_DISPOSITION_OPTIONS: Array<LabeledValue<RfqReviewDisposition>> = [
  { value: "draft", label: "Draft" },
  { value: "needs_review", label: "Needs review" },
  { value: "approved_for_quote", label: "Approved for quote" },
  { value: "hold", label: "Hold" },
];

export const RFQ_MATERIAL_PROVISIONING_OPTIONS: Array<
  LabeledValue<RfqLineItemSourcingPreferences["materialProvisioning"] & string>
> = [
  { value: "supplier_to_source", label: "Supplier to source" },
  { value: "customer_supplied", label: "Customer supplied" },
  { value: "tbd", label: "TBD" },
];

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map(normalizeString).filter((item): item is string => Boolean(item)))];
}

function normalizeOptionalEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): T | null {
  return typeof value === "string" && allowedValues.includes(value as T) ? (value as T) : null;
}

export function createEmptyRfqLineItemExtendedMetadata(): RfqLineItemExtendedMetadata {
  return {
    shipping: {
      requestedByDateOverride: null,
      packagingNotes: null,
      shippingNotes: null,
    },
    certifications: {
      requiredCertifications: [],
      materialCertificationRequired: null,
      certificateOfConformanceRequired: null,
      inspectionLevel: null,
      notes: null,
    },
    sourcing: {
      regionPreferenceOverride: null,
      preferredSuppliers: [],
      materialProvisioning: null,
      notes: null,
    },
    release: {
      releaseStatus: null,
      reviewDisposition: null,
      quoteBlockedUntilRelease: null,
      notes: null,
    },
  };
}

export function normalizeRfqLineItemExtendedMetadata(
  value: Partial<RfqLineItemExtendedMetadata> | null | undefined,
): RfqLineItemExtendedMetadata {
  const shipping = asObject(value?.shipping);
  const certifications = asObject(value?.certifications);
  const sourcing = asObject(value?.sourcing);
  const release = asObject(value?.release);

  return {
    shipping: {
      requestedByDateOverride: normalizeString(shipping.requestedByDateOverride),
      packagingNotes: normalizeString(shipping.packagingNotes),
      shippingNotes: normalizeString(shipping.shippingNotes),
    },
    certifications: {
      requiredCertifications: normalizeStringArray(certifications.requiredCertifications),
      materialCertificationRequired: normalizeBoolean(certifications.materialCertificationRequired),
      certificateOfConformanceRequired: normalizeBoolean(
        certifications.certificateOfConformanceRequired,
      ),
      inspectionLevel: normalizeOptionalEnum(
        certifications.inspectionLevel,
        RFQ_INSPECTION_LEVEL_VALUES,
      ),
      notes: normalizeString(certifications.notes),
    },
    sourcing: {
      regionPreferenceOverride: normalizeOptionalEnum(
        sourcing.regionPreferenceOverride,
        RFQ_REGION_PREFERENCE_VALUES,
      ),
      preferredSuppliers: normalizeStringArray(sourcing.preferredSuppliers),
      materialProvisioning: normalizeOptionalEnum(
        sourcing.materialProvisioning,
        RFQ_MATERIAL_PROVISIONING_VALUES,
      ),
      notes: normalizeString(sourcing.notes),
    },
    release: {
      releaseStatus: normalizeOptionalEnum(release.releaseStatus, RFQ_RELEASE_STATUS_VALUES),
      reviewDisposition: normalizeOptionalEnum(
        release.reviewDisposition,
        RFQ_REVIEW_DISPOSITION_VALUES,
      ),
      quoteBlockedUntilRelease: normalizeBoolean(release.quoteBlockedUntilRelease),
      notes: normalizeString(release.notes),
    },
  };
}

export function readRfqLineItemExtendedMetadata(
  specSnapshot: Json | null | undefined,
): RfqLineItemExtendedMetadata {
  const snapshot = asObject(specSnapshot);
  const shipping = asObject(snapshot.shipping);
  const certifications = asObject(snapshot.certifications);
  const sourcing = asObject(snapshot.sourcing);
  const release = asObject(snapshot.release);

  return normalizeRfqLineItemExtendedMetadata({
    shipping: {
      requestedByDateOverride: shipping.requestedByDateOverride ?? snapshot.requestedByDateOverride,
      packagingNotes: shipping.packagingNotes ?? snapshot.packagingNotes,
      shippingNotes: shipping.shippingNotes ?? snapshot.shippingNotes,
    },
    certifications: {
      requiredCertifications: certifications.requiredCertifications ?? snapshot.requiredCertifications,
      materialCertificationRequired:
        certifications.materialCertificationRequired ?? snapshot.materialCertificationRequired,
      certificateOfConformanceRequired:
        certifications.certificateOfConformanceRequired ?? snapshot.certificateOfConformanceRequired,
      inspectionLevel: certifications.inspectionLevel ?? snapshot.inspectionLevel,
      notes: certifications.notes ?? snapshot.certificationNotes,
    },
    sourcing: {
      regionPreferenceOverride: sourcing.regionPreferenceOverride ?? snapshot.regionPreferenceOverride,
      preferredSuppliers: sourcing.preferredSuppliers ?? snapshot.preferredSuppliers,
      materialProvisioning: sourcing.materialProvisioning ?? snapshot.materialProvisioning,
      notes: sourcing.notes ?? snapshot.sourcingNotes,
    },
    release: {
      releaseStatus: release.releaseStatus ?? snapshot.releaseStatus,
      reviewDisposition: release.reviewDisposition ?? snapshot.reviewDisposition,
      quoteBlockedUntilRelease:
        release.quoteBlockedUntilRelease ?? snapshot.quoteBlockedUntilRelease,
      notes: release.notes ?? snapshot.releaseNotes,
    },
  } as Partial<RfqLineItemExtendedMetadata>);
}

export function sanitizeClientVisibleRfqLineItemExtendedMetadata(
  value: Partial<RfqLineItemExtendedMetadata> | null | undefined,
): RfqLineItemExtendedMetadata {
  const metadata = normalizeRfqLineItemExtendedMetadata(value);

  return {
    ...metadata,
    release: {
      ...metadata.release,
      reviewDisposition: null,
      quoteBlockedUntilRelease: null,
    },
  };
}

export function sanitizeClientVisibleSpecSnapshot(
  specSnapshot: Json | null | undefined,
): Json {
  const snapshot = asObject(specSnapshot);
  const metadata = sanitizeClientVisibleRfqLineItemExtendedMetadata(
    readRfqLineItemExtendedMetadata(specSnapshot),
  );

  return {
    ...snapshot,
    shipping: metadata.shipping,
    certifications: metadata.certifications,
    sourcing: metadata.sourcing,
    release: metadata.release,
  };
}

export function buildClientPartRequestUpdateInput(
  jobId: string,
  requirement: ApprovedPartRequirement,
): ClientPartRequestUpdateInput {
  return {
    jobId,
    requestedServiceKinds: requirement.requestedServiceKinds,
    primaryServiceKind: requirement.primaryServiceKind,
    serviceNotes: requirement.serviceNotes,
    description: requirement.description ?? null,
    partNumber: requirement.partNumber ?? null,
    revision: requirement.revision ?? null,
    material: requirement.material,
    finish: requirement.finish ?? null,
    tightestToleranceInch: requirement.tightestToleranceInch ?? null,
    process: requirement.process ?? null,
    notes: requirement.notes ?? null,
    quantity: requirement.quantity,
    requestedQuoteQuantities: requirement.quoteQuantities,
    requestedByDate: requirement.requestedByDate ?? null,
    shipping: requirement.shipping,
    certifications: requirement.certifications,
    sourcing: requirement.sourcing,
    release: requirement.release,
  };
}

export function formatDelimitedStringList(values: string[]): string {
  return values.join(", ");
}

export function parseDelimitedStringList(value: string): string[] {
  return normalizeStringArray(value.split(/[\n,]/));
}
