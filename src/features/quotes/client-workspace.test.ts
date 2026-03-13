import { describe, expect, it } from "vitest";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import {
  buildSidebarProjectIdsByJobId,
  buildSidebarProjects,
  resolveImportedBatch,
  resolveImportedBatchFromSource,
  resolveWorkspaceProjectIdsForJob,
} from "./client-workspace";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: null,
    selected_vendor_quote_offer_id: null,
    created_by: "user-1",
    title: "Sample job",
    description: null,
    status: "uploaded",
    source: "client",
    tags: [],
    active_pricing_policy_id: null,
    requested_quote_quantities: [1],
    requested_by_date: null,
    archived_at: null,
    created_at: "2026-03-03T00:00:00Z",
    updated_at: "2026-03-03T00:00:00Z",
    ...overrides,
  } as JobRecord;
}

function makeSummary(overrides: Partial<JobPartSummary> = {}): JobPartSummary {
  return {
    jobId: "job-1",
    partNumber: "1093-03242",
    revision: "3",
    description: "Imported part",
    quantity: 1,
    requestedQuoteQuantities: [1],
    requestedByDate: null,
    importedBatch: "QB00001",
    selectedSupplier: null,
    selectedPriceUsd: null,
    selectedLeadTimeBusinessDays: null,
    ...overrides,
  };
}

describe("client workspace helpers", () => {
  it("resolves imported batch from part summary before job source", () => {
    expect(
      resolveImportedBatch(
        makeJob({ source: "spreadsheet_import:qb00002:1093-05589:2" }),
        makeSummary({ importedBatch: "QB00003" }),
      ),
    ).toBe("QB00003");
  });

  it("falls back to parsing imported batch from job source", () => {
    expect(resolveImportedBatchFromSource("spreadsheet_import:qb00002:1093-05589:2")).toBe("QB00002");
    expect(resolveImportedBatch(makeJob({ source: "spreadsheet_import:qb00001:1093-03242:3" }), null)).toBe("QB00001");
  });

  it("returns null when no imported batch can be resolved", () => {
    expect(resolveImportedBatchFromSource("client")).toBeNull();
    expect(resolveImportedBatch(makeJob({ source: "client" }), makeSummary({ importedBatch: null }))).toBeNull();
  });

  it("maps only real accessible projects into the sidebar", () => {
    const result = buildSidebarProjects({
      accessibleProjects: [
        {
          project: {
            id: "project-1",
            name: "Bracket Project",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-02T00:00:00Z",
          },
          partCount: 2,
          inviteCount: 1,
          currentUserRole: "owner",
        },
      ],
    });

    expect(result.sidebarProjects).toEqual([
      expect.objectContaining({
        id: "project-1",
        name: "Bracket Project",
        partCount: 2,
      }),
    ]);
  });

  it("resolves project ids for a job from actual memberships and project_id only", () => {
    const memberships = buildSidebarProjectIdsByJobId([
      { job_id: "job-1", project_id: "project-1" },
      { job_id: "job-1", project_id: "project-2" },
    ]);

    expect(
      resolveWorkspaceProjectIdsForJob({
        job: makeJob({ id: "job-1", project_id: "project-1" }),
        sidebarProjectIdsByJobId: memberships,
      }),
    ).toEqual(["project-1", "project-2"]);
  });
});
