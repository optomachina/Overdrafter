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
  fetchPartDetail,
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
    const summaryRow = {
      job_id: "job-1",
      quantity: 5,
      approved_part_requirements: {
        part_number: "1093-05589",
        revision: "A",
        description: "Bracket",
        quote_quantities: [5],
        requested_by_date: null,
        spec_snapshot: null,
      },
    };

    supabaseMock.setResolver("jobs", (state) => {
      if (state.selected === "*" && findFilter(state, "id", "eq")) {
        return response(job);
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

      if (state.selected?.includes("approved_part_requirements")) {
        return response([summaryRow]);
      }

      throw new Error(`Unhandled parts query: ${JSON.stringify(state)}`);
    });

    supabaseMock.setResolver("project_jobs", () => response([]));
    supabaseMock.setResolver("quote_runs", () => response([]));
    supabaseMock.setResolver("published_quote_packages", () => response([]));
    supabaseMock.setResolver("work_queue", () => response([]));
    supabaseMock.setResolver("drawing_extractions", () => response([]));
    supabaseMock.setResolver("approved_part_requirements", () => response([]));
    supabaseMock.setResolver("pricing_policies", () => response(null));
    supabaseMock.setResolver("drawing_preview_assets", () =>
      response(null, {
        code: "42703",
        message: 'column drawing_preview_assets.page_number does not exist',
        details: null,
        hint: null,
      }),
    );

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
        pageCount: 0,
        thumbnail: null,
        pages: [],
      },
    });
  });
});
