import { describe, expect, it } from "vitest";
import {
  buildClientPartRequestUpdateInput,
  parseDelimitedStringList,
  readRfqLineItemExtendedMetadata,
  sanitizeClientVisibleSpecSnapshot,
} from "@/features/quotes/rfq-metadata";
import type {
  ApprovedPartRequirement,
  DrawingExtractionRecord,
  PartAggregate,
} from "@/features/quotes/types";
import { buildRequirementDraft } from "@/features/quotes/utils";

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

  it("writes only a string finish, never a raw extraction object", () => {
    const extractionObject = {
      raw: null,
      reasons: [],
      confidence: 0,
      normalized: null,
      reviewNeeded: false,
    };

    expect(
      buildClientPartRequestUpdateInput("job-1", {
        ...makeRequirement(),
        finish: extractionObject as unknown as string,
      }).finish,
    ).toBeNull();
    expect(
      buildClientPartRequestUpdateInput("job-1", { ...makeRequirement(), finish: "Black anodize" }).finish,
    ).toBe("Black anodize");
  });

  it("parses comma- and newline-delimited metadata lists", () => {
    expect(parseDelimitedStringList("AS9100, ITAR\nMaterial cert")).toEqual([
      "AS9100",
      "ITAR",
      "Material cert",
    ]);
  });

  describe("part editor save with an unresolved drawing tolerance (OVD-984)", () => {
    function partWithTolerances(tolerances: Record<string, unknown>): PartAggregate {
      return {
        id: "part-1",
        job_id: "job-1",
        organization_id: "org-1",
        name: "widget-plate",
        quantity: 3,
        cadFile: null,
        drawingFile: null,
        approvedRequirement: null,
        vendorQuotes: [],
        extraction: {
          id: "extract-1",
          part_id: "part-1",
          organization_id: "org-1",
          status: "approved",
          warnings: [],
          confidence: 0.5,
          created_at: "2026-03-03T00:00:00Z",
          updated_at: "2026-03-03T00:00:00Z",
          extraction: {
            description: "Optic bracket",
            material: { raw: "6061", normalized: "6061 aluminum" },
            tolerances,
          },
        } as unknown as DrawingExtractionRecord,
      } as unknown as PartAggregate;
    }

    it.each([
      ["a mixed mm and inch drawing", "±0.1 mm, ±.3"],
      ["a fraction", "±1/64"],
      ["a bare decimal", "±.3"],
    ])("opens and saves another field without sending a tolerance for %s", (_label, raw) => {
      const draft = buildClientPartRequestUpdateInput(
        "job-1",
        buildRequirementDraft(partWithTolerances({ tightest: raw, valueInch: null, unit: "unknown" })),
      );
      const saved = { ...draft, notes: "Deburr all edges" };

      expect(saved.notes).toBe("Deburr all edges");
      expect(saved.tightestToleranceInch).toBeNull();
    });

    it("sends the tolerance the user entered", () => {
      const draft = buildClientPartRequestUpdateInput(
        "job-1",
        buildRequirementDraft(
          partWithTolerances({ tightest: "±1/64", valueInch: null, unit: "unknown" }),
        ),
      );
      const saved = { ...draft, tightestToleranceInch: 0.01 };

      expect(saved.tightestToleranceInch).toBe(0.01);
    });

    it("still sends a stored tolerance that carries unit in", () => {
      const draft = buildClientPartRequestUpdateInput(
        "job-1",
        buildRequirementDraft(
          partWithTolerances({ tightest: "±0.002 in", valueInch: 0.002, unit: "in" }),
        ),
      );

      expect(draft.tightestToleranceInch).toBe(0.002);
    });
  });
});
