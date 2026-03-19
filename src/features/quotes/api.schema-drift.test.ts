import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  type QueryState = {
    table: string;
    selected: string | null;
    filters: Array<{ type: string; column: string; value: unknown; operator?: string }>;
    orders: Array<{ column: string; options?: unknown }>;
    limit: number | null;
  };

  const resolvers = new Map<string, (state: QueryState) => unknown>();

  const buildQuery = (table: string) => {
    const state: QueryState = {
      table,
      selected: null,
      filters: [],
      orders: [],
      limit: null,
    };

    const resolve = () => {
      const resolver = resolvers.get(table);

      if (!resolver) {
        throw new Error(`Unexpected table: ${table}`);
      }

      return Promise.resolve(resolver(state));
    };

    const query = {
      select: vi.fn((columns: string) => {
        state.selected = columns;
        return query;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        state.filters.push({ type: "eq", column, value });
        return query;
      }),
      in: vi.fn((column: string, value: unknown) => {
        state.filters.push({ type: "in", column, value });
        return query;
      }),
      is: vi.fn((column: string, value: unknown) => {
        state.filters.push({ type: "is", column, value });
        return query;
      }),
      not: vi.fn((column: string, operator: string, value: unknown) => {
        state.filters.push({ type: "not", column, operator, value });
        return query;
      }),
      order: vi.fn((column: string, options?: unknown) => {
        state.orders.push({ column, options });
        return query;
      }),
      limit: vi.fn((value: number) => {
        state.limit = value;
        return query;
      }),
      single: vi.fn(() => resolve()),
      maybeSingle: vi.fn(() => resolve()),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        resolve().then(onFulfilled, onRejected),
      catch: (onRejected: (reason: unknown) => unknown) => resolve().catch(onRejected),
      finally: (onFinally: () => void) => resolve().finally(onFinally),
    };

    return query;
  };

  return {
    authGetUser: vi.fn(),
    from: vi.fn((table: string) => buildQuery(table)),
    rpc: vi.fn(),
    storageFrom: vi.fn(() => ({ upload: vi.fn() })),
    functionsInvoke: vi.fn(),
    setResolver(table: string, resolver: (state: QueryState) => unknown) {
      resolvers.set(table, resolver);
    },
    reset() {
      resolvers.clear();
      this.from.mockClear();
      this.rpc.mockReset();
      this.authGetUser.mockReset();
      this.storageFrom.mockClear();
      this.functionsInvoke.mockReset();
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: supabaseMock.authGetUser,
    },
    from: supabaseMock.from,
    rpc: supabaseMock.rpc,
    storage: {
      from: supabaseMock.storageFrom,
    },
    functions: {
      invoke: supabaseMock.functionsInvoke,
    },
  },
}));

vi.mock("@/features/quotes/client-workspace-fixtures", () => ({
  getActiveClientWorkspaceGateway: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import {
  fetchArchivedJobs,
  fetchClientActivityEventsByJobIds,
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobPartSummariesByJobIds,
  fetchPartDetail,
  resetClientActivityFeedAvailabilityForTests,
  resetClientIntakeSchemaAvailabilityForTests,
  resetJobArchivingSchemaAvailabilityForTests,
  fetchProjectJobMembershipsByJobIds,
  resetProjectCollaborationSchemaAvailabilityForTests,
} from "./api";

function response<T>(data: T, error: unknown = null) {
  return {
    data,
    error,
    count: null,
    status: error ? 400 : 200,
    statusText: error ? "ERR" : "OK",
  };
}

function findFilter(
  state: Parameters<(typeof supabaseMock)["setResolver"]>[1] extends (arg: infer T) => unknown ? T : never,
  column: string,
  type?: string,
) {
  return state.filters.find((filter) => filter.column === column && (type ? filter.type === type : true));
}

describe("quotes api schema drift handling", () => {
  beforeEach(() => {
    supabaseMock.reset();
    resetClientActivityFeedAvailabilityForTests();
    resetClientIntakeSchemaAvailabilityForTests();
    resetJobArchivingSchemaAvailabilityForTests();
    resetProjectCollaborationSchemaAvailabilityForTests();
  });

  it("degrades project-job memberships to an empty list when project_jobs columns are missing", async () => {
    supabaseMock.setResolver("project_jobs", () =>
      response(null, {
        code: "42703",
        message: 'column project_jobs.job_id does not exist',
        details: null,
        hint: null,
      }),
    );

    await expect(fetchProjectJobMembershipsByJobIds(["job-1"])).resolves.toEqual([]);
  });

  it("keeps part detail loading when drawing preview asset schema is missing", async () => {
    const job = {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      created_by: "user-1",
      title: "1093-05589",
      description: "Bracket",
      status: "needs_spec_review",
      source: "client_home",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [5],
      requested_by_date: null,
      requested_service_kinds: [],
      primary_service_kind: null,
      service_notes: null,
      selected_vendor_quote_offer_id: null,
      archived_at: null,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };
    const part = {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Bracket",
      normalized_key: "1093-05589",
      cad_file_id: null,
      drawing_file_id: null,
      quantity: 5,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };
    const metadataRow = {
      partId: "part-1",
      jobId: "job-1",
      organizationId: "org-1",
      hasCadFile: false,
      hasDrawingFile: true,
      description: "Bracket",
      partNumber: "1093-05589",
      revision: "A",
      material: "6061-T6 aluminum",
      finish: "As machined",
      tightestToleranceInch: 0.005,
      process: null,
      notes: null,
      quantity: 5,
      quoteQuantities: [5],
      requestedByDate: null,
      pageCount: 2,
      warningCount: 0,
      warnings: [],
      missingFields: [],
      lastFailureCode: null,
      lastFailureMessage: null,
      extractedAt: "2026-03-01T00:05:00Z",
      failedAt: null,
      updatedAt: "2026-03-01T00:05:00Z",
      lifecycle: "succeeded",
    };

    supabaseMock.setResolver("jobs", (state) => {
      if (state.selected === "*" && findFilter(state, "id", "eq")) {
        return response(job);
      }

      if (state.selected === "*" && findFilter(state, "organization_id", "eq")) {
        return response([job]);
      }

      if (state.selected?.includes("selected_vendor_quote_offer_id")) {
        return response([
          {
            id: job.id,
            selected_vendor_quote_offer_id: null,
            requested_service_kinds: [],
            primary_service_kind: null,
            service_notes: null,
            requested_quote_quantities: [5],
            requested_by_date: null,
          },
        ]);
      }

      if (state.selected === "*" && findFilter(state, "archived_at", "is")) {
        return response([job]);
      }

      throw new Error(`Unhandled jobs query: ${JSON.stringify(state)}`);
    });

    supabaseMock.setResolver("job_files", (state) => {
      if (state.selected === "*" || state.selected?.includes("normalized_name")) {
        return response([]);
      }

      throw new Error(`Unhandled job_files query: ${JSON.stringify(state)}`);
    });

    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "*" && findFilter(state, "job_id")) {
        return response([part]);
      }

      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 5,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });

    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.setResolver("quote_runs", () => response([]));
    supabaseMock.setResolver("published_quote_packages", () => response([]));
    supabaseMock.setResolver("work_queue", () => response([]));
    supabaseMock.setResolver("pricing_policies", () => response(null));
    supabaseMock.setResolver("drawing_preview_assets", () =>
      response(null, {
        code: "42703",
        message: 'column drawing_preview_assets.page_number does not exist',
        details: null,
        hint: null,
      }),
    );
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve(response([metadataRow]));
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve(response([
          {
            jobId: "job-1",
            latestQuoteRun: null,
            selectedOffer: null,
            vendorQuotes: [],
          },
        ]));
      }

      if (fn === "api_list_client_activity_events") {
        return Promise.resolve(response([]));
      }

      throw new Error(`Unhandled rpc: ${fn}`);
    });

    await expect(fetchPartDetail("job-1")).resolves.toMatchObject({
      job: {
        id: "job-1",
      },
      projectIds: [],
      summary: {
        jobId: "job-1",
        partNumber: "1093-05589",
        revision: "A",
      },
      drawingPreview: {
        pageCount: 2,
        thumbnail: null,
        pages: [],
      },
      part: {
        clientExtraction: {
          lifecycle: "succeeded",
        },
        clientRequirement: {
          material: "6061-T6 aluminum",
          finish: "As machined",
        },
      },
    });
  });

  it("keeps part summaries loading when request service-intent columns are missing", async () => {
    supabaseMock.setResolver("jobs", (state) => {
      if (state.selected?.includes("requested_service_kinds")) {
        return response(null, {
          code: "42703",
          message: 'column jobs.requested_service_kinds does not exist',
          details: null,
          hint: null,
        });
      }

      return response([
        {
          id: "job-1",
          selected_vendor_quote_offer_id: null,
          requested_quote_quantities: [5],
          requested_by_date: "2026-04-01",
        },
      ]);
    });

    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 5,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });

    supabaseMock.setResolver("job_files", () => response([]));
    supabaseMock.rpc.mockResolvedValue(
      response([
        {
          partId: "part-1",
          jobId: "job-1",
          organizationId: "org-1",
          hasCadFile: true,
          hasDrawingFile: true,
          description: "Bracket",
          partNumber: "1093-05589",
          revision: "A",
          material: "6061-T6 aluminum",
          finish: "As machined",
          tightestToleranceInch: 0.005,
          process: null,
          notes: null,
          quantity: 5,
          quoteQuantities: [5],
          requestedByDate: "2026-04-01",
          pageCount: 1,
          warningCount: 0,
          warnings: [],
          missingFields: [],
          lastFailureCode: null,
          lastFailureMessage: null,
          extractedAt: "2026-03-01T00:05:00Z",
          failedAt: null,
          updatedAt: "2026-03-01T00:05:00Z",
          lifecycle: "succeeded",
        },
      ]),
    );

    await expect(fetchJobPartSummariesByJobIds(["job-1"])).resolves.toEqual([
      expect.objectContaining({
        jobId: "job-1",
        partNumber: "1093-05589",
        revision: "A",
        requestedServiceKinds: ["manufacturing_quote"],
      }),
    ]);
  });

  it("hydrates client quote comparison data through the workspace projection rpc", async () => {
    const job = {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      created_by: "user-1",
      title: "1093-05589",
      description: "Bracket",
      status: "published",
      source: "shared_project",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [10],
      requested_by_date: "2026-04-01",
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      selected_vendor_quote_offer_id: "offer-1",
      archived_at: null,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };

    supabaseMock.setResolver("jobs", (state) => {
      if (state.selected === "*" && findFilter(state, "id", "in")) {
        return response([job]);
      }

      if (state.selected?.includes("selected_vendor_quote_offer_id")) {
        return response([
          {
            id: job.id,
            selected_vendor_quote_offer_id: "offer-1",
            requested_service_kinds: ["manufacturing_quote"],
            primary_service_kind: "manufacturing_quote",
            service_notes: null,
            requested_quote_quantities: [10],
            requested_by_date: "2026-04-01",
          },
        ]);
      }

      throw new Error(`Unhandled jobs query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("job_files", (state) => {
      if (state.selected === "*" || state.selected?.includes("normalized_name")) {
        return response([]);
      }

      throw new Error(`Unhandled job_files query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "*" && findFilter(state, "job_id", "in")) {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            organization_id: "org-1",
            name: "Bracket",
            normalized_key: "1093-05589-a",
            cad_file_id: null,
            drawing_file_id: null,
            quantity: 10,
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ]);
      }

      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 10,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.setResolver("drawing_preview_assets", () => response([]));
    supabaseMock.setResolver("quote_requests", () => response([]));
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve(
          response([
            {
              partId: "part-1",
              jobId: "job-1",
              organizationId: "org-1",
              hasCadFile: false,
              hasDrawingFile: false,
              description: "Bracket",
              partNumber: "1093-05589",
              revision: "A",
              material: "6061-T6 aluminum",
              finish: "Black anodize",
              tightestToleranceInch: 0.005,
              process: "CNC Machining",
              notes: null,
              quantity: 10,
              quoteQuantities: [10],
              requestedByDate: "2026-04-01",
              pageCount: 0,
              warningCount: 0,
              warnings: [],
              missingFields: [],
              lastFailureCode: null,
              lastFailureMessage: null,
              extractedAt: "2026-03-01T00:05:00Z",
              failedAt: null,
              updatedAt: "2026-03-01T00:05:00Z",
              lifecycle: "succeeded",
            },
          ]),
        );
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve(
          response([
            {
              jobId: "job-1",
              latestQuoteRun: {
                id: "run-1",
                job_id: "job-1",
                organization_id: "org-1",
                initiated_by: "user-2",
                status: "published",
                requested_auto_publish: false,
                created_at: "2026-03-01T00:10:00Z",
                updated_at: "2026-03-01T00:10:00Z",
                quote_request_id: null,
              },
              selectedOffer: {
                id: "offer-1",
                vendor_quote_result_id: "quote-1",
                organization_id: "org-1",
                offer_key: "xometry-standard",
                supplier: "Xometry",
                lane_label: "USA / Standard",
                sourcing: "USA",
                tier: "Standard",
                quote_ref: "Q-1",
                quote_date: "2026-03-01",
                unit_price_usd: 25,
                total_price_usd: 250,
                lead_time_business_days: 7,
                ship_receive_by: "2026-03-10",
                due_date: "2026-04-01",
                process: "CNC Machining",
                material: "6061-T6 aluminum",
                finish: "Black anodize",
                tightest_tolerance: "±.005\"",
                tolerance_source: "Drawing",
                thread_callouts: null,
                thread_match_notes: null,
                notes: null,
                sort_rank: 0,
                raw_payload: {},
                created_at: "2026-03-01T00:10:00Z",
                updated_at: "2026-03-01T00:10:00Z",
              },
              vendorQuotes: [
                {
                  id: "quote-1",
                  quote_run_id: "run-1",
                  part_id: "part-1",
                  organization_id: "org-1",
                  vendor: "xometry",
                  requested_quantity: 10,
                  status: "official_quote_received",
                  unit_price_usd: 25,
                  total_price_usd: 250,
                  lead_time_business_days: 7,
                  quote_url: null,
                  dfm_issues: [],
                  notes: [],
                  raw_payload: {},
                  created_at: "2026-03-01T00:10:00Z",
                  updated_at: "2026-03-01T00:10:00Z",
                  offers: [
                    {
                      id: "offer-1",
                      vendor_quote_result_id: "quote-1",
                      organization_id: "org-1",
                      offer_key: "xometry-standard",
                      supplier: "Xometry",
                      lane_label: "USA / Standard",
                      sourcing: "USA",
                      tier: "Standard",
                      quote_ref: "Q-1",
                      quote_date: "2026-03-01",
                      unit_price_usd: 25,
                      total_price_usd: 250,
                      lead_time_business_days: 7,
                      ship_receive_by: "2026-03-10",
                      due_date: "2026-04-01",
                      process: "CNC Machining",
                      material: "6061-T6 aluminum",
                      finish: "Black anodize",
                      tightest_tolerance: "±.005\"",
                      tolerance_source: "Drawing",
                      thread_callouts: null,
                      thread_match_notes: null,
                      notes: null,
                      sort_rank: 0,
                      raw_payload: {},
                      created_at: "2026-03-01T00:10:00Z",
                      updated_at: "2026-03-01T00:10:00Z",
                    },
                  ],
                  artifacts: [
                    {
                      id: "artifact-1",
                      vendor_quote_result_id: "quote-1",
                      organization_id: "org-1",
                      artifact_type: "quote_pdf",
                      storage_bucket: "quote-artifacts",
                      storage_path: "quotes/quote-1.pdf",
                      metadata: { source: "import" },
                      created_at: "2026-03-01T00:10:00Z",
                    },
                  ],
                },
              ],
            },
          ]),
        );
      }

      throw new Error(`Unhandled rpc: ${fn}`);
    });

    await expect(fetchClientQuoteWorkspaceByJobIds(["job-1"])).resolves.toEqual([
      expect.objectContaining({
        latestQuoteRun: expect.objectContaining({
          id: "run-1",
          status: "published",
        }),
        part: expect.objectContaining({
          vendorQuotes: [
            expect.objectContaining({
              id: "quote-1",
              vendor: "xometry",
              offers: [
                expect.objectContaining({
                  id: "offer-1",
                  supplier: "Xometry",
                  lane_label: "USA / Standard",
                }),
              ],
              artifacts: [
                expect.objectContaining({
                  id: "artifact-1",
                  artifact_type: "quote_pdf",
                }),
              ],
            }),
          ],
        }),
      }),
    ]);
  });

  it("degrades client quote workspace projection queries when the workspace rpc is unavailable", async () => {
    const job = {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      created_by: "user-1",
      title: "1093-05589",
      description: "Bracket",
      status: "published",
      source: "shared_project",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [10],
      requested_by_date: "2026-04-01",
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      selected_vendor_quote_offer_id: "offer-1",
      archived_at: null,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };

    supabaseMock.setResolver("jobs", (state) => {
      if (state.selected === "*" && findFilter(state, "id", "in")) {
        return response([job]);
      }

      if (state.selected?.includes("selected_vendor_quote_offer_id")) {
        return response([
          {
            id: job.id,
            selected_vendor_quote_offer_id: "offer-1",
            requested_service_kinds: ["manufacturing_quote"],
            primary_service_kind: "manufacturing_quote",
            service_notes: null,
            requested_quote_quantities: [10],
            requested_by_date: "2026-04-01",
          },
        ]);
      }

      throw new Error(`Unhandled jobs query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("job_files", (state) => {
      if (state.selected === "*" || state.selected?.includes("normalized_name")) {
        return response([]);
      }

      throw new Error(`Unhandled job_files query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "*" && findFilter(state, "job_id", "in")) {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            organization_id: "org-1",
            name: "Bracket",
            normalized_key: "1093-05589-a",
            cad_file_id: null,
            drawing_file_id: null,
            quantity: 10,
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ]);
      }

      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 10,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.setResolver("drawing_preview_assets", () => response([]));
    supabaseMock.setResolver("quote_requests", () => response([]));
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve(
          response([
            {
              partId: "part-1",
              jobId: "job-1",
              organizationId: "org-1",
              hasCadFile: false,
              hasDrawingFile: false,
              description: "Bracket",
              partNumber: "1093-05589",
              revision: "A",
              material: "6061-T6 aluminum",
              finish: "Black anodize",
              tightestToleranceInch: 0.005,
              process: "CNC Machining",
              notes: null,
              quantity: 10,
              quoteQuantities: [10],
              requestedByDate: "2026-04-01",
              pageCount: 0,
              warningCount: 0,
              warnings: [],
              missingFields: [],
              lastFailureCode: null,
              lastFailureMessage: null,
              extractedAt: "2026-03-01T00:05:00Z",
              failedAt: null,
              updatedAt: "2026-03-01T00:05:00Z",
              lifecycle: "succeeded",
            },
          ]),
        );
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve({
          data: null,
          error: {
            code: "PGRST202",
            message:
              "Could not find the function public.api_list_client_quote_workspace(p_job_ids) in the schema cache",
            details: null,
            hint: null,
          },
        });
      }

      throw new Error(`Unhandled rpc: ${fn}`);
    });

    await expect(fetchClientQuoteWorkspaceByJobIds(["job-1"])).resolves.toEqual([
      expect.objectContaining({
        latestQuoteRun: null,
        part: expect.objectContaining({
          vendorQuotes: [],
        }),
        summary: expect.objectContaining({
          selectedSupplier: null,
        }),
      }),
    ]);
  });

  it("drops malformed vendor quote aggregates returned by the workspace rpc", async () => {
    const job = {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      created_by: "user-1",
      title: "1093-05589",
      description: "Bracket",
      status: "published",
      source: "shared_project",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [10],
      requested_by_date: "2026-04-01",
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      selected_vendor_quote_offer_id: null,
      archived_at: null,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };

    supabaseMock.setResolver("jobs", (state) => {
      if (state.selected === "*" && findFilter(state, "id", "in")) {
        return response([job]);
      }

      if (state.selected?.includes("selected_vendor_quote_offer_id")) {
        return response([
          {
            id: job.id,
            selected_vendor_quote_offer_id: null,
            requested_service_kinds: ["manufacturing_quote"],
            primary_service_kind: "manufacturing_quote",
            service_notes: null,
            requested_quote_quantities: [10],
            requested_by_date: "2026-04-01",
          },
        ]);
      }

      throw new Error(`Unhandled jobs query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("job_files", (state) => {
      if (state.selected === "*" || state.selected?.includes("normalized_name")) {
        return response([]);
      }

      throw new Error(`Unhandled job_files query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "*" && findFilter(state, "job_id", "in")) {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            organization_id: "org-1",
            name: "Bracket",
            normalized_key: "1093-05589-a",
            cad_file_id: null,
            drawing_file_id: null,
            quantity: 10,
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ]);
      }

      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 10,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.setResolver("drawing_preview_assets", () => response([]));
    supabaseMock.setResolver("quote_requests", () => response([]));
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve(
          response([
            {
              partId: "part-1",
              jobId: "job-1",
              organizationId: "org-1",
              hasCadFile: false,
              hasDrawingFile: false,
              description: "Bracket",
              partNumber: "1093-05589",
              revision: "A",
              material: "6061-T6 aluminum",
              finish: "Black anodize",
              tightestToleranceInch: 0.005,
              process: "CNC Machining",
              notes: null,
              quantity: 10,
              quoteQuantities: [10],
              requestedByDate: "2026-04-01",
              pageCount: 0,
              warningCount: 0,
              warnings: [],
              missingFields: [],
              lastFailureCode: null,
              lastFailureMessage: null,
              extractedAt: "2026-03-01T00:05:00Z",
              failedAt: null,
              updatedAt: "2026-03-01T00:05:00Z",
              lifecycle: "succeeded",
            },
          ]),
        );
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve(
          response([
            {
              jobId: "job-1",
              latestQuoteRun: null,
              selectedOffer: null,
              vendorQuotes: [
                {
                  id: "quote-1",
                  quote_run_id: "run-1",
                  organization_id: "org-1",
                  vendor: "xometry",
                  requested_quantity: 10,
                  status: "official_quote_received",
                  unit_price_usd: 25,
                  total_price_usd: 250,
                  lead_time_business_days: 7,
                  quote_url: null,
                  dfm_issues: [],
                  notes: [],
                  raw_payload: {},
                  created_at: "2026-03-01T00:10:00Z",
                  updated_at: "2026-03-01T00:10:00Z",
                  offers: [],
                  artifacts: [],
                },
              ],
            },
          ]),
        );
      }

      throw new Error(`Unhandled rpc: ${fn}`);
    });

    await expect(fetchClientQuoteWorkspaceByJobIds(["job-1"])).resolves.toEqual([
      expect.objectContaining({
        part: expect.objectContaining({
          vendorQuotes: [],
        }),
      }),
    ]);
  });

  it("drops malformed workspace rows and filters malformed nested quote children", async () => {
    const job = {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      created_by: "user-1",
      title: "1093-05589",
      description: "Bracket",
      status: "published",
      source: "shared_project",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [10],
      requested_by_date: "2026-04-01",
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      selected_vendor_quote_offer_id: "offer-1",
      archived_at: null,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };

    supabaseMock.setResolver("jobs", (state) => {
      if (state.selected === "*" && findFilter(state, "id", "in")) {
        return response([job]);
      }

      if (state.selected?.includes("selected_vendor_quote_offer_id")) {
        return response([
          {
            id: job.id,
            selected_vendor_quote_offer_id: "offer-1",
            requested_service_kinds: ["manufacturing_quote"],
            primary_service_kind: "manufacturing_quote",
            service_notes: null,
            requested_quote_quantities: [10],
            requested_by_date: "2026-04-01",
          },
        ]);
      }

      throw new Error(`Unhandled jobs query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("job_files", (state) => {
      if (state.selected === "*" || state.selected?.includes("normalized_name")) {
        return response([]);
      }

      throw new Error(`Unhandled job_files query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "*" && findFilter(state, "job_id", "in")) {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            organization_id: "org-1",
            name: "Bracket",
            normalized_key: "1093-05589-a",
            cad_file_id: null,
            drawing_file_id: null,
            quantity: 10,
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ]);
      }

      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 10,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.setResolver("drawing_preview_assets", () => response([]));
    supabaseMock.setResolver("quote_requests", () => response([]));
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve(
          response([
            {
              partId: "part-1",
              jobId: "job-1",
              organizationId: "org-1",
              hasCadFile: false,
              hasDrawingFile: false,
              description: "Bracket",
              partNumber: "1093-05589",
              revision: "A",
              material: "6061-T6 aluminum",
              finish: "Black anodize",
              tightestToleranceInch: 0.005,
              process: "CNC Machining",
              notes: null,
              quantity: 10,
              quoteQuantities: [10],
              requestedByDate: "2026-04-01",
              pageCount: 0,
              warningCount: 0,
              warnings: [],
              missingFields: [],
              lastFailureCode: null,
              lastFailureMessage: null,
              extractedAt: "2026-03-01T00:05:00Z",
              failedAt: null,
              updatedAt: "2026-03-01T00:05:00Z",
              lifecycle: "succeeded",
            },
          ]),
        );
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve(
          response([
            {
              latestQuoteRun: {
                id: "run-ignore",
              },
              selectedOffer: {
                id: "offer-ignore",
              },
              vendorQuotes: [],
            },
            {
              jobId: "job-1",
              latestQuoteRun: {
                id: "run-1",
                job_id: "job-1",
                organization_id: "org-1",
                initiated_by: "user-2",
                status: "published",
                requested_auto_publish: false,
                created_at: "2026-03-01T00:10:00Z",
                updated_at: "2026-03-01T00:10:00Z",
                quote_request_id: null,
              },
              selectedOffer: {
                id: "offer-1",
                vendor_quote_result_id: "quote-1",
                organization_id: "org-1",
                offer_key: "xometry-standard",
                supplier: "Xometry",
                lane_label: "USA / Standard",
                sourcing: "USA",
                tier: "Standard",
                quote_ref: "Q-1",
                quote_date: "2026-03-01",
                unit_price_usd: 25,
                total_price_usd: 250,
                lead_time_business_days: 7,
                ship_receive_by: "2026-03-10",
                due_date: "2026-04-01",
                process: "CNC Machining",
                material: "6061-T6 aluminum",
                finish: "Black anodize",
                tightest_tolerance: "±.005\\\"",
                tolerance_source: "Drawing",
                thread_callouts: null,
                thread_match_notes: null,
                notes: null,
                sort_rank: 0,
                raw_payload: {},
                created_at: "2026-03-01T00:10:00Z",
                updated_at: "2026-03-01T00:10:00Z",
              },
              vendorQuotes: [
                {
                  id: "quote-invalid",
                  offers: [],
                  artifacts: [],
                },
                {
                  id: "quote-1",
                  quote_run_id: "run-1",
                  part_id: "part-1",
                  organization_id: "org-1",
                  vendor: "xometry",
                  requested_quantity: 10,
                  status: "official_quote_received",
                  unit_price_usd: 25,
                  total_price_usd: 250,
                  lead_time_business_days: 7,
                  quote_url: null,
                  dfm_issues: [],
                  notes: [],
                  raw_payload: {},
                  created_at: "2026-03-01T00:10:00Z",
                  updated_at: "2026-03-01T00:10:00Z",
                  offers: [
                    {
                      missing: "id",
                    },
                    {
                      id: "offer-1",
                      vendor_quote_result_id: "quote-1",
                      organization_id: "org-1",
                      offer_key: "xometry-standard",
                      supplier: "Xometry",
                      lane_label: "USA / Standard",
                      sourcing: "USA",
                      tier: "Standard",
                      quote_ref: "Q-1",
                      quote_date: "2026-03-01",
                      unit_price_usd: 25,
                      total_price_usd: 250,
                      lead_time_business_days: 7,
                      ship_receive_by: "2026-03-10",
                      due_date: "2026-04-01",
                      process: "CNC Machining",
                      material: "6061-T6 aluminum",
                      finish: "Black anodize",
                      tightest_tolerance: "±.005\\\"",
                      tolerance_source: "Drawing",
                      thread_callouts: null,
                      thread_match_notes: null,
                      notes: null,
                      sort_rank: 0,
                      raw_payload: {},
                      created_at: "2026-03-01T00:10:00Z",
                      updated_at: "2026-03-01T00:10:00Z",
                    },
                  ],
                  artifacts: [
                    {
                      id: "artifact-invalid",
                      vendor_quote_result_id: "quote-1",
                    },
                    {
                      id: "artifact-1",
                      vendor_quote_result_id: "quote-1",
                      organization_id: "org-1",
                      artifact_type: "quote_pdf",
                      storage_bucket: "quote-artifacts",
                      storage_path: "quotes/quote-1.pdf",
                      metadata: { source: "import" },
                      created_at: "2026-03-01T00:10:00Z",
                    },
                  ],
                },
              ],
            },
          ]),
        );
      }

      throw new Error(`Unhandled rpc: ${fn}`);
    });

    await expect(fetchClientQuoteWorkspaceByJobIds(["job-1"])).resolves.toEqual([
      expect.objectContaining({
        latestQuoteRun: expect.objectContaining({
          id: "run-1",
        }),
        part: expect.objectContaining({
          vendorQuotes: [
            expect.objectContaining({
              id: "quote-1",
              offers: [expect.objectContaining({ id: "offer-1" })],
              artifacts: [expect.objectContaining({ id: "artifact-1" })],
            }),
          ],
        }),
      }),
    ]);
  });

  it("maps failed client-safe extraction diagnostics into part detail", async () => {
    const job = {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      created_by: "user-1",
      title: "1093-05589",
      description: "Bracket",
      status: "extracting",
      source: "client_home",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [5],
      requested_by_date: null,
      requested_service_kinds: [],
      primary_service_kind: null,
      service_notes: null,
      selected_vendor_quote_offer_id: null,
      archived_at: null,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };

    supabaseMock.setResolver("jobs", (state) => {
      if (state.selected === "*" && findFilter(state, "id", "eq")) {
        return response(job);
      }

      if (state.selected === "*" && findFilter(state, "organization_id", "eq")) {
        return response([job]);
      }

      if (state.selected === "*" && findFilter(state, "archived_at", "is")) {
        return response([job]);
      }

      if (state.selected?.includes("selected_vendor_quote_offer_id")) {
        return response([
          {
            id: job.id,
            selected_vendor_quote_offer_id: null,
            requested_service_kinds: [],
            primary_service_kind: null,
            service_notes: null,
            requested_quote_quantities: [5],
            requested_by_date: null,
          },
        ]);
      }

      throw new Error(`Unhandled jobs query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("job_files", (state) => {
      if (state.selected === "*" || state.selected?.includes("normalized_name")) {
        return response([]);
      }

      throw new Error(`Unhandled job_files query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "*" && findFilter(state, "job_id")) {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            organization_id: "org-1",
            name: "Bracket",
            normalized_key: "1093-05589",
            cad_file_id: null,
            drawing_file_id: "drawing-1",
            quantity: 5,
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ]);
      }

      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 5,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.setResolver("quote_runs", () => response([]));
    supabaseMock.setResolver("drawing_preview_assets", () => response([]));
    supabaseMock.setResolver("vendor_quote_results", () => response([]));
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve(
          response([
            {
              partId: "part-1",
              jobId: "job-1",
              organizationId: "org-1",
              hasCadFile: false,
              hasDrawingFile: true,
              description: "Bracket",
              partNumber: "1093-05589",
              revision: "A",
              material: "Unknown material",
              finish: null,
              tightestToleranceInch: null,
              process: null,
              notes: null,
              quantity: 5,
              quoteQuantities: [5],
              requestedByDate: null,
              pageCount: 0,
              warningCount: 0,
              warnings: [],
              missingFields: ["material", "finish"],
              lastFailureCode: "pdf_parse_failed",
              lastFailureMessage: "Could not read text from the uploaded drawing PDF.",
              extractedAt: null,
              failedAt: "2026-03-01T00:06:00Z",
              updatedAt: "2026-03-01T00:06:00Z",
              lifecycle: "failed",
            },
          ]),
        );
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve(response([
          {
            jobId: "job-1",
            latestQuoteRun: null,
            selectedOffer: null,
            vendorQuotes: [],
          },
        ]));
      }

      throw new Error(`Unhandled rpc: ${fn}`);
    });

    await expect(fetchPartDetail("job-1")).resolves.toMatchObject({
      part: {
        clientExtraction: {
          lifecycle: "failed",
          lastFailureCode: "pdf_parse_failed",
          lastFailureMessage: "Could not read text from the uploaded drawing PDF.",
          missingFields: ["material", "finish"],
        },
      },
    });
  });

  it("resolves part-id routes and synthesizes client part detail from metadata when parts rows are unavailable", async () => {
    const job = {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      created_by: "user-1",
      title: "1093-05589",
      description: "Bracket",
      status: "extracting",
      source: "client_home",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [5],
      requested_by_date: "2026-04-02",
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      selected_vendor_quote_offer_id: null,
      archived_at: null,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };

    supabaseMock.setResolver("jobs", (state) => {
      const idFilter = findFilter(state, "id", "in");

      if (state.selected === "*" && idFilter) {
        const ids = Array.isArray(idFilter.value) ? idFilter.value : [];
        return response(ids.includes("job-1") ? [job] : []);
      }

      if (state.selected === "*" && findFilter(state, "archived_at", "is")) {
        return response([job]);
      }

      if (state.selected === "*" && findFilter(state, "organization_id", "eq")) {
        return response([job]);
      }

      if (state.selected?.includes("selected_vendor_quote_offer_id")) {
        return response([
          {
            id: job.id,
            selected_vendor_quote_offer_id: null,
            requested_service_kinds: ["manufacturing_quote"],
            primary_service_kind: "manufacturing_quote",
            service_notes: null,
            requested_quote_quantities: [5],
            requested_by_date: "2026-04-02",
          },
        ]);
      }

      throw new Error(`Unhandled jobs query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("job_files", (state) => {
      if (state.selected === "*") {
        return response([
          {
            id: "drawing-1",
            job_id: "job-1",
            organization_id: "org-1",
            storage_bucket: "job-files",
            storage_path: "org-1/1093-05589.pdf",
            original_name: "1093-05589.pdf",
            normalized_name: "1093-05589",
            file_kind: "drawing",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ]);
      }

      if (state.selected?.includes("normalized_name")) {
        return response([
          {
            job_id: "job-1",
            normalized_name: "1093-05589.pdf",
            original_name: "1093-05589.pdf",
            file_kind: "drawing",
          },
        ]);
      }

      throw new Error(`Unhandled job_files query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "job_id" && findFilter(state, "id", "eq")) {
        return response({
          job_id: "job-1",
        });
      }

      if (state.selected === "*" && findFilter(state, "job_id")) {
        return response([]);
      }

      if (state.selected === "id, job_id, quantity") {
        return response([]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });
    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.setResolver("quote_runs", () => response([]));
    supabaseMock.setResolver("drawing_preview_assets", () => response([]));
    supabaseMock.setResolver("vendor_quote_results", () => response([]));
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve(
          response([
            {
              partId: "part-1",
              jobId: "job-1",
              organizationId: "org-1",
              hasCadFile: false,
              hasDrawingFile: true,
              description: "Bracket",
              partNumber: "1093-05589",
              revision: "B",
              material: "7075-T6 aluminum",
              finish: "Black anodize",
              tightestToleranceInch: 0.002,
              process: "3-axis CNC milling",
              notes: "Deburr all edges.",
              quantity: 5,
              quoteQuantities: [5, 10],
              requestedByDate: "2026-04-02",
              pageCount: 1,
              warningCount: 0,
              warnings: [],
              missingFields: [],
              lastFailureCode: null,
              lastFailureMessage: null,
              extractedAt: "2026-03-01T00:05:00Z",
              failedAt: null,
              updatedAt: "2026-03-01T00:05:00Z",
              lifecycle: "succeeded",
            },
          ]),
        );
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve(response([
          {
            jobId: "job-1",
            latestQuoteRun: null,
            selectedOffer: null,
            vendorQuotes: [],
          },
        ]));
      }

      throw new Error(`Unhandled rpc: ${fn}`);
    });

    await expect(fetchPartDetail("part-1")).resolves.toMatchObject({
      job: {
        id: "job-1",
      },
      summary: {
        jobId: "job-1",
        partNumber: "1093-05589",
        revision: "B",
      },
      part: {
        id: "part-1",
        job_id: "job-1",
        drawing_file_id: "drawing-1",
        clientRequirement: {
          material: "7075-T6 aluminum",
          finish: "Black anodize",
          process: "3-axis CNC milling",
        },
        clientExtraction: {
          lifecycle: "succeeded",
        },
      },
    });
  });

  it("caches the legacy jobs-column fallback after the first schema-drift hit", async () => {
    const selectedColumns: string[] = [];

    supabaseMock.setResolver("jobs", (state) => {
      selectedColumns.push(state.selected ?? "");

      if (state.selected?.includes("requested_service_kinds")) {
        return response(null, {
          code: "42703",
          message: 'column jobs.requested_service_kinds does not exist',
          details: null,
          hint: null,
        });
      }

      return response([
        {
          id: "job-1",
          selected_vendor_quote_offer_id: null,
          requested_quote_quantities: [5],
          requested_by_date: "2026-04-01",
        },
      ]);
    });

    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 5,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });

    supabaseMock.setResolver("job_files", () => response([]));
    supabaseMock.rpc.mockResolvedValue(
      response([
        {
          partId: "part-1",
          jobId: "job-1",
          organizationId: "org-1",
          hasCadFile: true,
          hasDrawingFile: true,
          description: "Bracket",
          partNumber: "1093-05589",
          revision: "A",
          material: "6061-T6 aluminum",
          finish: "As machined",
          tightestToleranceInch: 0.005,
          process: null,
          notes: null,
          quantity: 5,
          quoteQuantities: [5],
          requestedByDate: "2026-04-01",
          pageCount: 1,
          warningCount: 0,
          warnings: [],
          missingFields: [],
          lastFailureCode: null,
          lastFailureMessage: null,
          extractedAt: "2026-03-01T00:05:00Z",
          failedAt: null,
          updatedAt: "2026-03-01T00:05:00Z",
          lifecycle: "succeeded",
        },
      ]),
    );

    await fetchJobPartSummariesByJobIds(["job-1"]);
    await fetchJobPartSummariesByJobIds(["job-1"]);

    expect(selectedColumns.filter((columns) => columns.includes("requested_service_kinds"))).toHaveLength(1);
  });

  it("keeps archived jobs loading when request service-intent columns are missing", async () => {
    supabaseMock.setResolver("jobs", (state) => {
      const archivedFilter = findFilter(state, "archived_at", "not");

      if (archivedFilter) {
        return response([
          {
            id: "job-1",
            organization_id: "org-1",
            project_id: null,
            created_by: "user-1",
            title: "1093-05589",
            description: "Bracket",
            status: "uploaded",
            source: "client_home",
            active_pricing_policy_id: null,
            tags: [],
            requested_quote_quantities: [5],
            requested_by_date: "2026-04-01",
            archived_at: "2026-03-01T00:00:00Z",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ]);
      }

      if (state.selected?.includes("requested_service_kinds")) {
        return response(null, {
          code: "42703",
          message: 'column jobs.requested_service_kinds does not exist',
          details: null,
          hint: null,
        });
      }

      if (findFilter(state, "id", "in")) {
        return response([
          {
            id: "job-1",
            selected_vendor_quote_offer_id: null,
            requested_quote_quantities: [5],
            requested_by_date: "2026-04-01",
          },
        ]);
      }

      throw new Error(`Unhandled jobs query: ${JSON.stringify(state)}`);
    });

    supabaseMock.setResolver("parts", (state) => {
      if (state.selected === "id, job_id, quantity") {
        return response([
          {
            id: "part-1",
            job_id: "job-1",
            quantity: 5,
          },
        ]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });

    supabaseMock.setResolver("job_files", () => response([]));
    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve(
          response([
            {
              partId: "part-1",
              jobId: "job-1",
              organizationId: "org-1",
              hasCadFile: true,
              hasDrawingFile: true,
              description: "Bracket",
              partNumber: "1093-05589",
              revision: "A",
              material: "6061-T6 aluminum",
              finish: "As machined",
              tightestToleranceInch: 0.005,
              process: null,
              notes: null,
              quantity: 5,
              quoteQuantities: [5],
              requestedByDate: "2026-04-01",
              pageCount: 1,
              warningCount: 0,
              warnings: [],
              missingFields: [],
              lastFailureCode: null,
              lastFailureMessage: null,
              extractedAt: "2026-03-01T00:05:00Z",
              failedAt: null,
              updatedAt: "2026-03-01T00:05:00Z",
              lifecycle: "succeeded",
            },
          ]),
        );
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve(response([
          {
            jobId: "job-1",
            latestQuoteRun: null,
            selectedOffer: null,
            vendorQuotes: [],
          },
        ]));
      }

      throw new Error(`Unhandled rpc: ${fn}`);
    });

    await expect(fetchArchivedJobs()).resolves.toEqual([
      expect.objectContaining({
        job: expect.objectContaining({
          id: "job-1",
        }),
        summary: expect.objectContaining({
          jobId: "job-1",
          partNumber: "1093-05589",
        }),
        projectNames: [],
      }),
    ]);
  });

  it("degrades client activity queries to an empty list when the activity RPC is unavailable", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.api_list_client_activity_events(p_job_ids, p_limit_per_job) in the schema cache",
        details: null,
        hint: null,
      },
    });

    await expect(fetchClientActivityEventsByJobIds(["job-1"])).resolves.toEqual([]);
    await expect(fetchClientActivityEventsByJobIds(["job-1"])).resolves.toEqual([]);
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1);
  });
});
