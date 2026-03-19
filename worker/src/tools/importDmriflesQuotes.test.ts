// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assignFilesToGroups,
  buildGroupStemAliases,
  cleanupExistingRecords,
  excelSerialToIso,
  findCleanupCandidates,
  getActivePricingPolicy,
  groupWorkbookRows,
  normalizeToken,
  parseTolerance,
  publishSupportedQuotes,
  readWorkbookRows,
  resolveUserIdByEmail,
} from "./importDmriflesQuotes";

type Row = Record<string, string | null>;
const SPARSE_WORKBOOK_BASE64 =
  "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";
const tempDirs = new Set<string>();

function makeQuoteRow(input: {
  batch: string;
  partNumber: string;
  revision?: string | null;
  supplier?: string | null;
  qty?: string | null;
  unitPrice?: string | null;
  totalPrice?: string | null;
  leadTime?: string | null;
  shipReceiveBy?: string | null;
}): Row {
  return {
    "Quote Batch": input.batch,
    "Part Number": input.partNumber,
    Description: input.partNumber,
    Qty: input.qty ?? "1",
    Revision: input.revision ?? null,
    Supplier: input.supplier ?? "Xometry",
    "Quote Ref": "Q-1",
    "Quote Date": "46084",
    Sourcing: "USA",
    Tier: "Economy",
    Status: "Quoted",
    "Unit Price": input.unitPrice ?? "10",
    "Total Price": input.totalPrice ?? "10",
    "Lead Time": input.leadTime ?? "5 business days",
    "Ship/Receive By": input.shipReceiveBy ?? "Mar 23",
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

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function writeWorkbookFixture(base64Zip: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-dmrifles-"));
  const workbookPath = path.join(dir, "fixture.xlsx");
  tempDirs.add(dir);
  await fs.writeFile(workbookPath, Buffer.from(base64Zip, "base64"));
  return workbookPath;
}

describe("importDmriflesQuotes", () => {
  it("preserves sparse worksheet column alignment when blank cells are omitted from the xlsx row", async () => {
    const workbookPath = await writeWorkbookFixture(SPARSE_WORKBOOK_BASE64);

    await expect(readWorkbookRows(workbookPath, "All Quotes")).resolves.toEqual([
      {
        "Quote Batch": "QB00002",
        "Part Number": "1093-05589",
        Description: "Bracket",
        Qty: "10",
        Revision: null,
        Supplier: "Xometry",
        "Unit Price": "25",
      },
    ]);
  });

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

  it("prefers the organization pricing policy before falling back to the global one", async () => {
    const orgPolicy = {
      id: "policy-org",
      version: "v2",
      markup_percent: 25,
      currency_minor_unit: 0.01,
    };
    const globalPolicy = {
      id: "policy-global",
      version: "v1",
      markup_percent: 20,
      currency_minor_unit: 0.01,
    };
    const calls: Array<{ eq: Array<[string, unknown]>; is: Array<[string, unknown]> }> = [];
    const supabase = {
      from(table: string) {
        expect(table).toBe("pricing_policies");
        const state = {
          eq: [] as Array<[string, unknown]>,
          is: [] as Array<[string, unknown]>,
        };
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            state.eq.push([column, value]);
            return query;
          },
          is: (column: string, value: unknown) => {
            state.is.push([column, value]);
            return query;
          },
          order: () => query,
          limit: () => query,
          maybeSingle: () => {
            calls.push({
              eq: [...state.eq],
              is: [...state.is],
            });
            const organizationMatch = state.eq.some(([column, value]) => column === "organization_id" && value === "org-1");
            const globalMatch = state.is.some(([column, value]) => column === "organization_id" && value === null);
            return Promise.resolve({
              data: organizationMatch ? orgPolicy : globalMatch ? globalPolicy : null,
              error: null,
            });
          },
        };
        return query;
      },
    } as unknown as SupabaseClient;

    await expect(getActivePricingPolicy(supabase, "org-1")).resolves.toEqual(orgPolicy);
    expect(calls).toHaveLength(1);
    expect(calls[0].eq).toContainEqual(["organization_id", "org-1"]);
  });

  it("falls back to the global pricing policy when no organization-specific policy exists", async () => {
    const globalPolicy = {
      id: "policy-global",
      version: "v1",
      markup_percent: 20,
      currency_minor_unit: 0.01,
    };
    const supabase = {
      from(table: string) {
        expect(table).toBe("pricing_policies");
        const state = {
          eq: [] as Array<[string, unknown]>,
          is: [] as Array<[string, unknown]>,
        };
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            state.eq.push([column, value]);
            return query;
          },
          is: (column: string, value: unknown) => {
            state.is.push([column, value]);
            return query;
          },
          order: () => query,
          limit: () => query,
          maybeSingle: () =>
            Promise.resolve({
              data: state.is.some(([column, value]) => column === "organization_id" && value === null) ? globalPolicy : null,
              error: null,
            }),
        };
        return query;
      },
    } as unknown as SupabaseClient;

    await expect(getActivePricingPolicy(supabase, "org-1")).resolves.toEqual(globalPolicy);
  });

  it("pages through auth users until it finds the requested email", async () => {
    const listUsers = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          users: [{ id: "user-1", email: "someone@example.com" }],
          aud: "authenticated",
          nextPage: 2,
          lastPage: 2,
          total: 2,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          users: [{ id: "user-2", email: "dmrifles@gmail.com" }],
          aud: "authenticated",
          nextPage: null,
          lastPage: 2,
          total: 2,
        },
        error: null,
      });
    const supabase = {
      auth: {
        admin: {
          listUsers,
        },
      },
    } as unknown as SupabaseClient;

    await expect(resolveUserIdByEmail(supabase, "DMRifles@gmail.com")).resolves.toBe("user-2");
    expect(listUsers).toHaveBeenNthCalledWith(1, { page: 1, perPage: 200 });
    expect(listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 200 });
  });

  it("removes orphaned blobs after deleting the replacement job set", async () => {
    const remove = vi.fn().mockResolvedValue({ error: null });
    const deletedJobIds: string[][] = [];
    const deletedBlobIds: string[] = [];
    const supabase = {
      from(table: string) {
        if (table === "job_files") {
          return {
            select: (_columns: string, options?: { count?: string; head?: boolean }) => {
              if (options?.head) {
                return {
                  eq: (_column: string, _value: unknown) =>
                    Promise.resolve({
                      count: 0,
                      error: null,
                    }),
                };
              }

              return {
                eq: (_column: string, _value: unknown) => ({
                  in: (_inColumn: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        {
                          id: "file-1",
                          job_id: "job-1",
                          blob_id: "blob-1",
                          storage_bucket: "job-files",
                          storage_path: "org/file.step",
                        },
                      ],
                      error: null,
                    }),
                }),
              };
            },
          };
        }

        if (table === "jobs") {
          return {
            delete: () => ({
              in: (_column: string, ids: string[]) => {
                deletedJobIds.push(ids);
                return Promise.resolve({ error: null });
              },
            }),
          };
        }

        if (table === "organization_file_blobs") {
          return {
            delete: () => ({
              eq: (_column: string, id: string) => {
                deletedBlobIds.push(id);
                return Promise.resolve({ error: null });
              },
            }),
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          remove,
        }),
      },
    } as unknown as SupabaseClient;

    await expect(
      cleanupExistingRecords(supabase, "org-1", {
        jobIds: ["job-1"],
        projectIds: [],
      }),
    ).resolves.toEqual({
      deletedJobs: 1,
      deletedProjects: 0,
    });

    expect(deletedJobIds).toEqual([["job-1"]]);
    expect(remove).toHaveBeenCalledWith(["org/file.step"]);
    expect(deletedBlobIds).toEqual(["blob-1"]);
  });

  it("publishes supported quote rows into results, offers, and client options", async () => {
    const insertedResults: Array<Record<string, unknown>> = [];
    const insertedOffers: Array<Record<string, unknown>> = [];
    const insertedOptions: Array<Record<string, unknown>> = [];
    const insertedPackages: Array<Record<string, unknown>> = [];
    const insertedAuditEvents: Array<Record<string, unknown>> = [];
    let resultCounter = 0;
    let offerCounter = 0;

    const supabase = {
      from(table: string) {
        if (table === "quote_runs") {
          return {
            insert: (payload: Record<string, unknown>) => ({
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      id: "run-1",
                      ...payload,
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }

        if (table === "vendor_quote_results") {
          return {
            insert: (payload: Record<string, unknown>) => ({
              select: () => ({
                single: () => {
                  const id = `result-${resultCounter += 1}`;
                  insertedResults.push({
                    id,
                    ...payload,
                  });
                  return Promise.resolve({
                    data: { id },
                    error: null,
                  });
                },
              }),
            }),
          };
        }

        if (table === "vendor_quote_offers") {
          return {
            insert: (payload: Array<Record<string, unknown>>) => ({
              select: () => {
                const data = payload.map((offer) => {
                  const id = `offer-${offerCounter += 1}`;
                  insertedOffers.push({
                    id,
                    ...offer,
                  });
                  return {
                    id,
                    total_price_usd: offer.total_price_usd,
                    lead_time_business_days: offer.lead_time_business_days,
                  };
                });
                return Promise.resolve({
                  data,
                  error: null,
                });
              },
            }),
          };
        }

        if (table === "published_quote_packages") {
          return {
            insert: (payload: Record<string, unknown>) => ({
              select: () => ({
                single: () => {
                  insertedPackages.push(payload);
                  return Promise.resolve({
                    data: { id: "package-1" },
                    error: null,
                  });
                },
              }),
            }),
          };
        }

        if (table === "published_quote_options") {
          return {
            insert: (payload: Record<string, unknown>) => {
              insertedOptions.push(payload);
              return Promise.resolve({ error: null });
            },
          };
        }

        if (table === "audit_events") {
          return {
            insert: (payload: Record<string, unknown>) => {
              insertedAuditEvents.push(payload);
              return Promise.resolve({ error: null });
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient;

    const group = {
      batch: "QB00002",
      partNumber: "1093-05589",
      revision: "02",
      rows: [
        makeQuoteRow({
          batch: "QB00002",
          partNumber: "1093-05589",
          revision: "02",
          supplier: "Xometry",
          qty: "10",
          unitPrice: "10",
          totalPrice: "100",
          leadTime: "10 business days",
          shipReceiveBy: "Mar 31",
        }),
        makeQuoteRow({
          batch: "QB00002",
          partNumber: "1093-05589",
          revision: "02",
          supplier: "Fictiv",
          qty: "10",
          unitPrice: "12",
          totalPrice: "120",
          leadTime: "5 business days",
          shipReceiveBy: "Mar 24",
        }),
        makeQuoteRow({
          batch: "QB00002",
          partNumber: "1093-05589",
          revision: "02",
          supplier: "Protolabs",
          qty: "10",
          unitPrice: "11",
          totalPrice: "110",
          leadTime: "6 business days",
          shipReceiveBy: "Mar 25",
        }),
      ],
    };

    await expect(
      publishSupportedQuotes(supabase, {
        workbookPath: "/tmp/Quotes Spreadsheet - Improved.xlsx",
        organizationId: "org-1",
        jobId: "job-1",
        partId: "part-1",
        group,
        initiatedBy: "internal-user",
        publishedBy: "internal-user",
        pricingPolicy: {
          id: "policy-1",
          version: "v1_markup_20",
          markup_percent: 20,
          currency_minor_unit: 0.01,
        },
      }),
    ).resolves.toBe("package-1");

    expect(insertedResults).toHaveLength(3);
    expect(insertedOffers).toHaveLength(3);
    expect(insertedPackages).toHaveLength(1);
    expect(insertedOptions.map((option) => option.option_kind)).toEqual([
      "lowest_cost",
      "fastest_delivery",
      "balanced",
    ]);
    expect(insertedAuditEvents).toHaveLength(1);
  });
});
