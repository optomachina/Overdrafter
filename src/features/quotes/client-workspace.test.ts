import { describe, expect, it } from "vitest";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import {
  buildDmriflesProjects,
  isDmriflesSystemProject,
  matchesDefaultDmriflesSeed,
  resolveImportedBatch,
  resolveImportedBatchFromSource,
} from "./client-workspace";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    created_by: null,
    title: "Sample job",
    description: null,
    status: "uploaded",
    source: "client",
    tags: [],
    active_pricing_policy_id: null,
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
    importedBatch: "QB00001",
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

  it("builds DMRifles system projects from imported batch truth", () => {
    const jobs = [
      ...Array.from({ length: 10 }, (_, index) =>
        makeJob({
          id: `qb1-${index}`,
          title: `QB1-${index}`,
          created_at: `2026-03-03T00:00:${String(index).padStart(2, "0")}Z`,
        }),
      ),
      makeJob({
        id: "qb2-1",
        title: "QB2",
        created_at: "2026-03-03T00:01:00Z",
      }),
      makeJob({
        id: "qb3-1",
        title: "QB3-1",
        created_at: "2026-03-03T00:02:00Z",
      }),
      makeJob({
        id: "qb3-2",
        title: "QB3-2",
        created_at: "2026-03-03T00:02:01Z",
      }),
      makeJob({
        id: "stray",
        title: "Stray",
        created_at: "2026-03-03T00:03:00Z",
        source: "client",
      }),
    ];

    const summaries = new Map<string, JobPartSummary>(
      jobs.map((job, index) => [
        job.id,
        makeSummary({
          jobId: job.id,
          importedBatch:
            index < 10 ? "QB00001" : index === 10 ? "QB00002" : index < 13 ? "QB00003" : null,
        }),
      ]),
    );

    const projects = buildDmriflesProjects(jobs, summaries);

    expect(projects.map((project) => [project.name, project.jobIds.length])).toEqual([
      ["QB00001", 10],
      ["QB00002", 1],
      ["QB00003", 2],
    ]);
    expect(matchesDefaultDmriflesSeed(projects)).toBe(true);
    expect(projects.every((project) => isDmriflesSystemProject(project))).toBe(true);
    expect(projects.flatMap((project) => project.jobIds)).not.toContain("stray");
  });
});
