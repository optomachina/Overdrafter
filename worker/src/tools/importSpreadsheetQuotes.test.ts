// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildOfferId,
  collectUnsupportedGroups,
  deleteQuoteDataForJob,
  groupWorkbookRows,
  normalizeRevisionForComparison,
  parseLeadTimeDays,
  resolveExistingSharedProjectAssignments,
  selectGroups,
} from "./importSpreadsheetQuotes";

type Row = Record<string, string | null>;

function makeQuoteRow(input: {
  batch: string;
  partNumber: string;
  revision?: string | null;
  supplier?: string | null;
  totalPrice?: string | null;
  unitPrice?: string | null;
  leadTime?: string | null;
}): Row {
  return {
    "Quote Batch": input.batch,
    "Part Number": input.partNumber,
    Description: input.partNumber,
    Qty: "1",
    Revision: input.revision ?? null,
    Supplier: input.supplier === undefined ? "Xometry" : input.supplier,
    "Quote Ref": "Q-1",
    "Quote Date": "46086",
    Sourcing: "USA",
    Tier: "Standard",
    Status: "Quoted",
    "Unit Price": input.unitPrice ?? "10",
    "Total Price": input.totalPrice ?? "10",
    "Lead Time": input.leadTime ?? "5 business days",
    "Ship/Receive By": "Mar 27",
    "Due Date": "Mar 13",
    Process: "CNC Machining",
    Material: "6061 Alloy",
    Finish: "Black Anodize",
    "Tightest Tolerance": '±.005"',
    "Tolerance Source": "Title block",
    "Thread Callouts": null,
    "Thread Match Notes": null,
    Notes: null,
  };
}

function makeArgs(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    workbookPath: "fixture.xlsx",
    batch: null,
    batches: null,
    partNumber: null,
    jobId: null,
    organizationId: "org-1",
    jobTags: [],
    internalUserEmail: "blaineswilson@gmail.com",
    addInternalMembership: true,
    replaceExistingJobData: false,
    replaceImportedJobs: true,
    skipExistingParts: true,
    existingSharedProjectJobs: false,
    ...overrides,
  };
}

describe("importSpreadsheetQuotes", () => {
  it("normalizes numeric revisions for shared-project job matching", () => {
    expect(normalizeRevisionForComparison("03")).toBe("3");
    expect(normalizeRevisionForComparison("003")).toBe("3");
    expect(normalizeRevisionForComparison("A")).toBe("A");
    expect(normalizeRevisionForComparison("rev 02")).toBe("2");
    expect(normalizeRevisionForComparison(null)).toBeNull();
  });

  it("resolves workbook groups onto existing shared-project jobs by batch, part number, and normalized revision", () => {
    const groups = groupWorkbookRows([
      makeQuoteRow({
        batch: "QB00001",
        partNumber: "1093-03242",
        revision: "03",
        supplier: "DEVZ Manufacturing",
      }),
      makeQuoteRow({
        batch: "QB00003",
        partNumber: "1093-10453",
        revision: "A",
        supplier: "Infrared Laboratories",
      }),
    ]);

    const result = resolveExistingSharedProjectAssignments({
      groups,
      projects: [
        { id: "project-1", organization_id: "org-1", name: "QB00001" },
        { id: "project-3", organization_id: "org-1", name: "QB00003" },
      ],
      jobs: [
        {
          id: "job-1",
          organization_id: "org-1",
          project_id: "project-1",
          source: "shared_project",
          title: "1093-03242 rev 3",
          tags: null,
        },
        {
          id: "job-3",
          organization_id: "org-1",
          project_id: "project-3",
          source: "shared_project",
          title: "1093-10453 rev A",
          tags: null,
        },
      ],
    });

    expect(result.duplicateJobKeys).toEqual([]);
    expect(result.missingGroupKeys).toEqual([]);
    expect([...result.creationTargets.entries()]).toEqual([]);
    expect([...result.assignments.values()]).toEqual(["job-1", "job-3"]);
  });

  it("marks unmatched workbook groups inside an existing batch as creation targets instead of hard failures", () => {
    const groups = groupWorkbookRows([
      makeQuoteRow({
        batch: "QB00003",
        partNumber: "1093-05907",
        revision: "01",
      }),
      makeQuoteRow({
        batch: "QB00003",
        partNumber: "1093-10435",
        revision: "A",
        supplier: "Infrared Laboratories",
      }),
    ]);

    const result = resolveExistingSharedProjectAssignments({
      groups,
      projects: [{ id: "project-3", organization_id: "org-1", name: "QB00003" }],
      jobs: [
        {
          id: "job-3a",
          organization_id: "org-1",
          project_id: "project-3",
          source: "shared_project",
          title: "1093-05907 rev 1",
          tags: null,
        },
      ],
    });

    expect(result.duplicateJobKeys).toEqual([]);
    expect(result.missingGroupKeys).toEqual([]);
    expect([...result.assignments.entries()]).toEqual([["QB00003::1093-05907::1", "job-3a"]]);
    expect([...result.creationTargets.entries()]).toEqual([["QB00003::1093-10435::A", "project-3"]]);
  });

  it("treats DEVZ Manufacturing and Infrared Laboratories rows as supported spreadsheet quotes", () => {
    const groups = groupWorkbookRows([
      makeQuoteRow({
        batch: "QB00001",
        partNumber: "1093-10570",
        revision: "A",
        supplier: "DEVZ Manufacturing",
        unitPrice: "58",
        totalPrice: "58",
      }),
      makeQuoteRow({
        batch: "QB00001",
        partNumber: "1093-10570",
        revision: "A",
        supplier: "Infrared Laboratories",
        unitPrice: "448",
        totalPrice: "448",
        leadTime: "2-4 weeks",
      }),
    ]);

    const selected = selectGroups(groups, makeArgs({ batch: "QB00001" }) as never);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.partNumber).toBe("1093-10570");
  });

  it("reports QB00004-style groups with no supported quote rows as skipped", () => {
    const groups = groupWorkbookRows([
      makeQuoteRow({
        batch: "QB00004",
        partNumber: "1093-07053-01",
        revision: "C",
        supplier: null,
        totalPrice: null,
        unitPrice: null,
      }),
    ]);

    const skipped = collectUnsupportedGroups(groups, makeArgs({ batch: "QB00004" }) as never);

    expect(() => selectGroups(groups, makeArgs({ batch: "QB00004" }) as never)).toThrow(
      "No spreadsheet groups with supported quotes matched the requested filters.",
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.batch).toBe("QB00004");
  });

  it("parses ranged lead-time text conservatively for imported rows", () => {
    expect(
      parseLeadTimeDays(
        makeQuoteRow({
          batch: "QB00001",
          partNumber: "1093-10570",
          revision: "A",
          supplier: "Infrared Laboratories",
          leadTime: "2-4 weeks",
        }),
      ),
    ).toBe(20);
  });

  it("builds distinct offer ids for repeated vendor lanes with different quote refs", () => {
    const first = buildOfferId(
      "fastdms",
      makeQuoteRow({
        batch: "QB00003",
        partNumber: "1093-05907",
        revision: "01",
        supplier: "FastDMS",
      }),
    );
    const second = buildOfferId(
      "fastdms",
      {
        ...makeQuoteRow({
          batch: "QB00003",
          partNumber: "1093-05907",
          revision: "01",
          supplier: "FastDMS",
        }),
        "Quote Ref": "A00F41",
      },
    );

    expect(first).not.toBe(second);
  });

  it("deletes prior package and quote-run data before reimporting overlapping jobs", async () => {
    const operations: string[] = [];
    const supabase = {
      from(table: string) {
        return {
          delete() {
            operations.push(`delete:${table}`);
            return {
              async eq(column: string, value: string) {
                operations.push(`eq:${table}:${column}:${value}`);
                return { error: null };
              },
            };
          },
        };
      },
    };

    await deleteQuoteDataForJob(supabase as never, "job-overlap");

    expect(operations).toEqual([
      "delete:published_quote_packages",
      "eq:published_quote_packages:job_id:job-overlap",
      "delete:quote_runs",
      "eq:quote_runs:job_id:job-overlap",
    ]);
  });
});
