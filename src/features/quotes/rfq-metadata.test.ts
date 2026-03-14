import { describe, expect, it } from "vitest";
import {
  buildClientPartRequestUpdateInput,
  parseDelimitedStringList,
  readRfqLineItemExtendedMetadata,
  sanitizeClientVisibleSpecSnapshot,
} from "@/features/quotes/rfq-metadata";
import type { ApprovedPartRequirement } from "@/features/quotes/types";

function makeRequirement(): ApprovedPartRequirement {
  return {
    partId: "part-1",
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    serviceNotes: null,
    description: "Bracket",
    partNumber: "BRKT-001",
    revision: "A",
    material: "6061",
    finish: "Anodize",
    tightestToleranceInch: 0.002,
    process: "3-axis mill",
    notes: "Deburr all edges",
    quantity: 10,
    quoteQuantities: [10, 50],
    requestedByDate: "2026-04-15",
    shipping: {
      requestedByDateOverride: null,
      packagingNotes: "Bag and label",
      shippingNotes: "Dock delivery",
    },
    certifications: {
      requiredCertifications: ["AS9100"],
      materialCertificationRequired: true,
      certificateOfConformanceRequired: true,
      inspectionLevel: "fai",
      notes: "Traceability required",
    },
    sourcing: {
      regionPreferenceOverride: "domestic_preferred",
      preferredSuppliers: ["Vendor A"],
      materialProvisioning: "supplier_to_source",
      notes: "Domestic only if price delta is small",
    },
    release: {
      releaseStatus: "pre_release",
      reviewDisposition: "needs_review",
      quoteBlockedUntilRelease: true,
      notes: "Awaiting final ECO",
    },
    applicableVendors: ["xometry"],
  };
}

describe("rfq-metadata", () => {
  it("reads nested line-item metadata from spec snapshots", () => {
    expect(
      readRfqLineItemExtendedMetadata({
        shipping: {
          requestedByDateOverride: "2026-04-22",
          packagingNotes: "Tray pack",
        },
        certifications: {
          requiredCertifications: [" AS9100 ", "ITAR"],
          inspectionLevel: "fai",
        },
        sourcing: {
          preferredSuppliers: ["Vendor A", "Vendor B"],
          materialProvisioning: "customer_supplied",
        },
        release: {
          releaseStatus: "prototype",
          reviewDisposition: "approved_for_quote",
          quoteBlockedUntilRelease: true,
        },
      }),
    ).toMatchObject({
      shipping: {
        requestedByDateOverride: "2026-04-22",
        packagingNotes: "Tray pack",
      },
      certifications: {
        requiredCertifications: ["AS9100", "ITAR"],
        inspectionLevel: "fai",
      },
      sourcing: {
        preferredSuppliers: ["Vendor A", "Vendor B"],
        materialProvisioning: "customer_supplied",
      },
      release: {
        releaseStatus: "prototype",
        reviewDisposition: "approved_for_quote",
        quoteBlockedUntilRelease: true,
      },
    });
  });

  it("strips internal-only release review fields from client-visible snapshots", () => {
    const sanitized = sanitizeClientVisibleSpecSnapshot({
      requestedByDateOverride: "2026-04-25",
      reviewDisposition: "needs_review",
      quoteBlockedUntilRelease: true,
      release: {
        releaseStatus: "pre_release",
        reviewDisposition: "needs_review",
        quoteBlockedUntilRelease: true,
        notes: "Awaiting sign-off",
      },
    });

    expect(sanitized).toMatchObject({
      release: {
        releaseStatus: "pre_release",
        reviewDisposition: null,
        quoteBlockedUntilRelease: null,
        notes: "Awaiting sign-off",
      },
    });
    expect(sanitized).not.toHaveProperty("requestedByDateOverride");
    expect(sanitized).not.toHaveProperty("reviewDisposition");
    expect(sanitized).not.toHaveProperty("quoteBlockedUntilRelease");
  });

  it("builds client request drafts from the richer requirement shape", () => {
    expect(buildClientPartRequestUpdateInput("job-1", makeRequirement())).toMatchObject({
      jobId: "job-1",
      requestedQuoteQuantities: [10, 50],
      shipping: {
        packagingNotes: "Bag and label",
      },
      certifications: {
        requiredCertifications: ["AS9100"],
      },
      sourcing: {
        preferredSuppliers: ["Vendor A"],
      },
      release: {
        releaseStatus: "pre_release",
        reviewDisposition: "needs_review",
      },
    });
  });

  it("parses comma- and newline-delimited metadata lists", () => {
    expect(parseDelimitedStringList("AS9100, ITAR\nMaterial cert")).toEqual([
      "AS9100",
      "ITAR",
      "Material cert",
    ]);
  });
});
