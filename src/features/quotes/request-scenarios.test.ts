import { describe, expect, it } from "vitest";
import type { ApprovedPartRequirement, JobPartSummary } from "@/features/quotes/types";
import {
  collectRequestedQuantities,
  getSharedRequestMetadata,
  groupByRequestedQuantity,
  normalizeApprovedRequirementDraft,
  resolveRequestedQuantitySelection,
} from "@/features/quotes/request-scenarios";

function makeRequirement(
  overrides: Partial<ApprovedPartRequirement> = {},
): ApprovedPartRequirement {
  return {
    partId: "part-1",
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    serviceNotes: null,
    description: null,
    partNumber: "PN-100",
    revision: "A",
    material: "6061",
    finish: null,
    tightestToleranceInch: null,
    quantity: 10,
    quoteQuantities: [1, 10, 100],
    requestedByDate: null,
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
    applicableVendors: ["xometry", "fictiv"],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<JobPartSummary> = {}): JobPartSummary {
  return {
    jobId: "job-1",
    partNumber: "PN-100",
    revision: "A",
    description: null,
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    serviceNotes: null,
    quantity: 10,
    requestedQuoteQuantities: [10, 100],
    requestedByDate: "2026-04-15",
    importedBatch: null,
    selectedSupplier: null,
    selectedPriceUsd: null,
    selectedLeadTimeBusinessDays: null,
    ...overrides,
  };
}

describe("request-scenarios", () => {
  it("collects requested quantities across multiple sources", () => {
    expect(
      collectRequestedQuantities(
        [[1, 10], [10, 100], 250, null],
        5,
      ),
    ).toEqual([1, 10, 100, 250]);
  });

  it("normalizes approved requirement drafts with primary quantity first", () => {
    expect(
      normalizeApprovedRequirementDraft(
        makeRequirement({
          quantity: 25,
          quoteQuantities: [10, 25, 25, 100],
          certifications: {
            requiredCertifications: [" AS9100 ", "AS9100", "ITAR"],
            materialCertificationRequired: true,
            certificateOfConformanceRequired: null,
            inspectionLevel: "fai",
            notes: "  Certs required  ",
          },
        }),
      ),
    ).toMatchObject({
      quoteQuantities: [25, 10, 100],
      certifications: {
        requiredCertifications: ["AS9100", "ITAR"],
        materialCertificationRequired: true,
        inspectionLevel: "fai",
        notes: "Certs required",
      },
    });
  });

  it("resolves requested quantity selection from preferred quantity and preserves all", () => {
    expect(
      resolveRequestedQuantitySelection({
        availableQuantities: [1, 10, 100],
        preferredQuantity: 10,
      }),
    ).toBe(10);

    expect(
      resolveRequestedQuantitySelection({
        availableQuantities: [1, 10, 100],
        currentSelection: "all",
        preferredQuantity: 10,
        allowAll: true,
      }),
    ).toBe("all");
  });

  it("groups rows by requested quantity in first-seen order", () => {
    expect(
      groupByRequestedQuantity([
        { id: "a", requestedQuantity: 10 },
        { id: "b", requestedQuantity: 1 },
        { id: "c", requestedQuantity: 10 },
      ]),
    ).toEqual([
      { requestedQuantity: 10, items: [{ id: "a", requestedQuantity: 10 }, { id: "c", requestedQuantity: 10 }] },
      { requestedQuantity: 1, items: [{ id: "b", requestedQuantity: 1 }] },
    ]);
  });

  it("returns shared request metadata only when every part matches", () => {
    expect(
      getSharedRequestMetadata([
        makeSummary(),
        makeSummary({ jobId: "job-2" }),
      ]),
    ).toEqual({
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: null,
      requestedQuoteQuantities: [10, 100],
      requestedByDate: "2026-04-15",
    });

    expect(
      getSharedRequestMetadata([
        makeSummary(),
        makeSummary({ jobId: "job-2", requestedByDate: null }),
      ]),
    ).toBeNull();
  });
});
