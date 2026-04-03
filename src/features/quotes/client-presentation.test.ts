import { describe, expect, it } from "vitest";
import { getClientItemPresentation } from "./client-presentation";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: null,
    selected_vendor_quote_offer_id: null,
    created_by: "user-1",
    title: "1093-05589 rev 2",
    description: null,
    status: "uploaded",
    source: "client_home",
    active_pricing_policy_id: null,
    tags: [],
    requested_service_kinds: [],
    primary_service_kind: null,
    service_notes: null,
    requested_quote_quantities: [],
    requested_by_date: null,
    archived_at: null,
    created_at: "2026-03-05T12:00:00.000Z",
    updated_at: "2026-03-05T12:30:00.000Z",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<JobPartSummary> = {}): JobPartSummary {
  return {
    jobId: "job-1",
    partNumber: "1093-05589",
    revision: "B",
    description: "Part description",
    requestedServiceKinds: [],
    primaryServiceKind: null,
    serviceNotes: null,
    quantity: 1,
    requestedQuoteQuantities: [],
    requestedByDate: null,
    importedBatch: null,
    selectedSupplier: null,
    selectedPriceUsd: null,
    selectedLeadTimeBusinessDays: null,
    ...overrides,
  };
}

describe("getClientItemPresentation", () => {
  it("strips title-derived revisions from the normalized display title", () => {
    expect(getClientItemPresentation(makeJob())).toMatchObject({
      title: "1093-05589",
      originalTitle: "1093-05589 rev 2",
      partNumber: "1093-05589",
    });
  });

  it("keeps explicit summary revisions in the display title", () => {
    expect(getClientItemPresentation(makeJob(), makeSummary())).toMatchObject({
      title: "1093-05589 rev B",
      originalTitle: "1093-05589 rev 2",
      partNumber: "1093-05589",
    });
  });
});
