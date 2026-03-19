// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  assignFilesToGroups,
  buildGroupStemAliases,
  excelSerialToIso,
  findCleanupCandidates,
  groupWorkbookRows,
  normalizeToken,
  parseTolerance,
} from "./importDmriflesQuotes";

type Row = Record<string, string | null>;

function makeQuoteRow(input: {
  batch: string;
  partNumber: string;
  revision?: string | null;
  supplier?: string | null;
}): Row {
  return {
    "Quote Batch": input.batch,
    "Part Number": input.partNumber,
    Description: input.partNumber,
    Qty: "1",
    Revision: input.revision ?? null,
    Supplier: input.supplier ?? "Xometry",
    "Quote Ref": "Q-1",
    "Quote Date": "46084",
    Sourcing: "USA",
    Tier: "Economy",
    Status: "Quoted",
    "Unit Price": "10",
    "Total Price": "10",
    "Lead Time": "5 business days",
    "Ship/Receive By": "Mar 23",
    "Due Date": "Mar 18",
    Process: "CNC Machining",
    Material: "6061-T6",
    Finish: "Black Anodize",
    "Tightest Tolerance": "±.005\"",
    "Tolerance Source": "Title block",
    "Thread Callouts": null,
    "Thread Match Notes": null,
    Notes: null,
  };
}

describe("importDmriflesQuotes", () => {
  it("groups a workbook-shaped 59-row import into 44 unique part groups", () => {
    const rows: Row[] = [];

    for (let index = 1; index <= 43; index += 1) {
      rows.push(
        makeQuoteRow({
          batch: `QB${String(Math.min(index, 5)).padStart(5, "0")}`,
          partNumber: `PN-${String(index).padStart(3, "0")}`,
          revision: index % 2 === 0 ? "01" : null,
        }),
      );
    }

    for (let index = 0; index < 16; index += 1) {
      rows.push(
        makeQuoteRow({
          batch: "QB00002",
          partNumber: "1093-05589",
          revision: "02",
          supplier: index % 2 === 0 ? "Xometry" : "Fictiv",
        }),
      );
    }

    const groups = groupWorkbookRows(rows);

    expect(rows).toHaveLength(59);
    expect(groups).toHaveLength(44);
    expect(
      groups.find((group) => group.batch === "QB00002" && group.partNumber === "1093-05589")?.rows.length,
    ).toBe(16);
  });

  it("includes the explicit QB00004 alias and pairs the mismatched cad/drawing stems", () => {
    const groups = [
      {
        batch: "QB00004",
        partNumber: "1093-07054-01",
        revision: "B",
        rows: [makeQuoteRow({ batch: "QB00004", partNumber: "1093-07054-01", revision: "B" })],
      },
    ];
    const files = [
      {
        absolutePath: "/tmp/QB00004/1093-07054-01.PDF",
        relativePath: "QB00004/1093-07054-01.PDF",
        originalName: "1093-07054-01.PDF",
        originalStem: "1093-07054-01",
        extension: ".pdf",
        fileKind: "drawing" as const,
        normalizedStem: normalizeToken("1093-07054-01"),
      },
      {
        absolutePath: "/tmp/QB00004/1093-07054.STEP",
        relativePath: "QB00004/1093-07054.STEP",
        originalName: "1093-07054.STEP",
        originalStem: "1093-07054",
        extension: ".step",
        fileKind: "cad" as const,
        normalizedStem: normalizeToken("1093-07054"),
      },
    ];

    expect(buildGroupStemAliases(groups[0])).toContain(normalizeToken("1093-07054"));

    const assignments = assignFilesToGroups(groups, files);

    expect(assignments).toEqual([
      {
        group: groups[0],
        files,
      },
    ]);
  });

  it("targets only dmrifles legacy duplicates and prior import records for cleanup", () => {
    const candidates = findCleanupCandidates({
      jobs: [
        {
          id: "legacy-draft",
          title: "1093-05589-02",
          source: "client_home",
          project_id: null,
          tags: null,
        },
        {
          id: "prior-import",
          title: "1093-05589 rev 2",
          source: "spreadsheet_import:qb00002:1093-05589:2",
          project_id: null,
          tags: null,
        },
        {
          id: "new-import",
          title: "1093-07053-01 rev C",
          source: "shared_project",
          project_id: "project-import",
          tags: ["dmrifles-import", "quote-batch:qb00004"],
        },
        {
          id: "keep-me",
          title: "Customer draft",
          source: "client_home",
          project_id: null,
          tags: null,
        },
      ],
      jobFiles: [
        {
          id: "cad",
          job_id: "legacy-draft",
          blob_id: "blob-1",
          storage_bucket: "job-files",
          storage_path: "org/file.step",
          normalized_name: "1093-05589-02",
          original_name: "1093-05589-02.STEP",
        },
        {
          id: "drawing",
          job_id: "legacy-draft",
          blob_id: "blob-2",
          storage_bucket: "job-files",
          storage_path: "org/file.pdf",
          normalized_name: "1093-05589-02",
          original_name: "1093-05589-02.pdf",
        },
      ],
      projects: [
        {
          id: "project-import",
          name: "PC6000 / PC6100",
          description: "Imported batch QB00004 from Quotes Spreadsheet - Improved.xlsx.",
        },
        {
          id: "project-keep",
          name: "Manual project",
          description: "User-created project",
        },
      ],
    });

    expect(candidates).toEqual({
      jobIds: ["legacy-draft", "prior-import", "new-import"],
      projectIds: ["project-import"],
    });
  });

  it("keeps helper normalization behavior stable", () => {
    expect(excelSerialToIso("46084")).toBe("2026-03-03");
    expect(parseTolerance("±.005\"")).toBe(0.005);
    expect(normalizeToken("1093-04730 REV A")).toBe("1093-04730-rev-a");
  });
});
