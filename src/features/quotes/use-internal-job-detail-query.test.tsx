import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { type PropsWithChildren } from "react";
import type { User } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInternalJobDetailQuery } from "@/features/quotes/use-internal-job-detail-query";
import type {
  AppMembership,
  JobAggregate,
  PartAggregate,
  PublishedPackageAggregate,
  QuoteRunAggregate,
  QuoteRunReadiness,
  VendorQuoteAggregate,
} from "@/features/quotes/types";

const { fetchJobAggregateMock, getQuoteRunReadinessMock } = vi.hoisted(() => ({
  fetchJobAggregateMock: vi.fn(),
  getQuoteRunReadinessMock: vi.fn(),
}));

vi.mock("@/features/quotes/api", () => ({
  fetchJobAggregate: (...args: unknown[]) => fetchJobAggregateMock(...args),
  getQuoteRunReadiness: (...args: unknown[]) => getQuoteRunReadinessMock(...args),
}));

function QueryProvider({ children }: PropsWithChildren) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    app_metadata: { provider: "google" },
    user_metadata: {},
    aud: "authenticated",
    confirmation_sent_at: null,
    recovery_sent_at: null,
    email_change_sent_at: null,
    new_email: null,
    new_phone: null,
    invited_at: null,
    action_link: null,
    email: "reviewer@example.com",
    phone: "",
    created_at: "2026-03-19T00:00:00.000Z",
    confirmed_at: null,
    email_confirmed_at: null,
    phone_confirmed_at: null,
    last_sign_in_at: null,
    role: "authenticated",
    updated_at: "2026-03-19T00:00:00.000Z",
    identities: [],
    is_anonymous: false,
    factors: null,
    ...overrides,
  } as unknown as User;
}

function makeMembership(role: AppMembership["role"] = "internal_estimator"): AppMembership {
  return {
    id: "membership-1",
    role,
    organizationId: "org-1",
    organizationName: "OptoMachina",
    organizationSlug: "optomachina",
  };
}

function makePart(overrides: Partial<PartAggregate> = {}): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "optic-bracket",
    normalized_key: "optic-bracket",
    cad_file_id: "file-cad-1",
    drawing_file_id: "file-drawing-1",
    quantity: 5,
    cadFile: {
      id: "file-cad-1",
      organization_id: "org-1",
      job_id: "job-1",
      file_kind: "cad",
      storage_bucket: "job-files",
      storage_path: "cad/optic-bracket.step",
      original_name: "optic-bracket.step",
      normalized_name: "optic-bracket.step",
      mime_type: "application/step",
      size_bytes: 100,
      created_at: "2026-03-19T00:00:00.000Z",
      updated_at: "2026-03-19T00:00:00.000Z",
    },
    drawingFile: {
      id: "file-drawing-1",
      organization_id: "org-1",
      job_id: "job-1",
      file_kind: "drawing",
      storage_bucket: "job-files",
      storage_path: "drawing/optic-bracket.pdf",
      original_name: "optic-bracket.pdf",
      normalized_name: "optic-bracket.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      created_at: "2026-03-19T00:00:00.000Z",
      updated_at: "2026-03-19T00:00:00.000Z",
    },
    extraction: {
      id: "extract-1",
      part_id: "part-1",
      organization_id: "org-1",
      extraction: {
        description: "Optic bracket",
        partNumber: "1093-05589",
        revision: "B",
        material: { raw: "6061-T6", normalized: "6061 aluminum", confidence: 0.92 },
        finish: { raw: "Clear anodize", confidence: 0.84 },
      },
      warnings: [],
      confidence: 0.8,
      status: "approved",
      created_at: "2026-03-19T00:00:00.000Z",
      updated_at: "2026-03-19T00:00:00.000Z",
    },
    approvedRequirement: null,
    vendorQuotes: [],
    ...overrides,
  } as PartAggregate;
}

function makeQuote(overrides: Partial<VendorQuoteAggregate> = {}): VendorQuoteAggregate {
  return {
    id: "quote-1",
    quote_run_id: "run-1",
    organization_id: "org-1",
    part_id: "part-1",
    vendor: "xometry",
    requested_quantity: 20,
    status: "official_quote_received",
    unit_price_usd: 12,
    total_price_usd: 240,
    lead_time_business_days: 8,
    quote_url: null,
    raw_payload: {},
    dfm_issues: [],
    summary_notes: null,
    failure_reason: null,
    created_at: "2026-03-19T00:00:00.000Z",
    updated_at: "2026-03-19T00:00:00.000Z",
    offers: [],
    artifacts: [],
    ...overrides,
  } as VendorQuoteAggregate;
}

function makeQuoteRun(overrides: Partial<QuoteRunAggregate> = {}): QuoteRunAggregate {
  return {
    id: "run-1",
    organization_id: "org-1",
    job_id: "job-1",
    requested_by: "user-1",
    quote_request_id: null,
    status: "completed",
    requested_vendors: ["xometry"],
    started_at: "2026-03-19T00:00:00.000Z",
    completed_at: "2026-03-19T00:10:00.000Z",
    created_at: "2026-03-19T00:00:00.000Z",
    updated_at: "2026-03-19T00:10:00.000Z",
    vendorQuotes: [makeQuote(), makeQuote({ id: "quote-2", requested_quantity: 10, vendor: "fictiv" })],
    ...overrides,
  } as QuoteRunAggregate;
}

function makePackage(overrides: Partial<PublishedPackageAggregate> = {}): PublishedPackageAggregate {
  return {
    id: "package-1",
    organization_id: "org-1",
    job_id: "job-1",
    quote_run_id: "run-1",
    client_summary: "Client-safe summary from latest package.",
    published_at: "2026-03-19T00:00:00.000Z",
    created_at: "2026-03-19T00:00:00.000Z",
    updated_at: "2026-03-19T00:00:00.000Z",
    options: [],
    selections: [],
    ...overrides,
  } as PublishedPackageAggregate;
}

function makeJobAggregate(overrides: Partial<JobAggregate> = {}): JobAggregate {
  return {
    job: {
      id: "job-1",
      organization_id: "org-1",
      selected_vendor_quote_offer_id: null,
      created_by: "user-1",
      title: "Optic Bracket",
      description: "Internal review route",
      status: "internal_review",
      source: "manual",
      active_pricing_policy_id: null,
      tags: ["urgent"],
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      requested_quote_quantities: [10, 5],
      requested_by_date: null,
      archived_at: null,
      created_at: "2026-03-19T00:00:00.000Z",
      updated_at: "2026-03-19T00:00:00.000Z",
    },
    files: [],
    parts: [makePart()],
    quoteRuns: [makeQuoteRun()],
    packages: [makePackage()],
    pricingPolicy: null,
    workQueue: [],
    drawingPreviewAssets: [],
    debugExtractionRuns: [],
    ...overrides,
  } as JobAggregate;
}

const readiness: QuoteRunReadiness = {
  ready: true,
  successfulVendorQuotes: 2,
  failedVendorQuotes: 0,
  blockingVendorStates: 0,
  unapprovedExtractions: 0,
  repairTasks: 0,
  priorRequirementsMatch: true,
  reasons: [],
};

describe("useInternalJobDetailQuery", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates drafts, client summary, and readiness from fetched data", async () => {
    fetchJobAggregateMock.mockResolvedValue(makeJobAggregate());
    getQuoteRunReadinessMock.mockResolvedValue(readiness);

    const { result } = renderHook(
      () =>
        useInternalJobDetailQuery({
          jobId: "job-1",
          user: makeUser(),
          activeMembership: makeMembership(),
        }),
      { wrapper: QueryProvider },
    );

    await waitFor(() => expect(result.current.job?.job.id).toBe("job-1"));
    await waitFor(() => expect(result.current.partViewModels).toHaveLength(1));
    await waitFor(() =>
      expect(result.current.activeCompareRequestedQuantity).toBe(
        result.current.compareQuantities[0],
      ),
    );

    expect(result.current.clientSummary).toBe("Client-safe summary from latest package.");
    expect(result.current.partViewModels[0].quoteQuantityInput.split("/").map(Number).sort((a, b) => a - b)).toEqual([
      5,
      10,
    ]);
    expect(result.current.partViewModels[0].draft.description).toBe("Optic bracket");
    expect([...result.current.compareQuantities].sort((a, b) => a - b)).toEqual([5, 10, 20]);
    expect(result.current.visibleQuoteRows.map((quote) => quote.requested_quantity)).toEqual([
      result.current.compareQuantities[0],
    ]);
    expect(getQuoteRunReadinessMock).toHaveBeenCalledWith("run-1");
  });

  it("falls back to the default client summary and exposes sorted quote rows when all quantities are shown", async () => {
    fetchJobAggregateMock.mockResolvedValue(
      makeJobAggregate({
        packages: [makePackage({ client_summary: null })],
        quoteRuns: [
          makeQuoteRun({
            vendorQuotes: [
              makeQuote({ id: "quote-3", requested_quantity: 20, part_id: "part-b", vendor: "xometry" }),
              makeQuote({ id: "quote-1", requested_quantity: 10, part_id: "part-b", vendor: "xometry" }),
              makeQuote({ id: "quote-2", requested_quantity: 10, part_id: "part-a", vendor: "fictiv" }),
            ],
          }),
        ],
      }),
    );
    getQuoteRunReadinessMock.mockResolvedValue(readiness);

    const { result } = renderHook(
      () =>
        useInternalJobDetailQuery({
          jobId: "job-1",
          user: makeUser(),
          activeMembership: makeMembership(),
        }),
      { wrapper: QueryProvider },
    );

    await waitFor(() => expect(result.current.job?.job.title).toBe("Optic Bracket"));
    await waitFor(() => expect(result.current.partViewModels).toHaveLength(1));

    expect(result.current.clientSummary).toBe("Curated CNC quote package for Optic Bracket.");

    act(() => {
      result.current.setActiveCompareRequestedQuantity("all");
    });

    await waitFor(() =>
      expect(result.current.visibleQuoteRows.map((quote) => quote.id)).toEqual([
        "quote-2",
        "quote-1",
        "quote-3",
      ]),
    );
  });

  it("preserves an intentionally cleared empty client summary across subsequent job updates", async () => {
    fetchJobAggregateMock
      .mockResolvedValueOnce(makeJobAggregate())
      .mockResolvedValueOnce(
        makeJobAggregate({
          packages: [makePackage({ client_summary: "New package summary that should not overwrite an empty string." })],
        }),
      );
    getQuoteRunReadinessMock.mockResolvedValue(readiness);

    const { result } = renderHook(
      () =>
        useInternalJobDetailQuery({
          jobId: "job-1",
          user: makeUser(),
          activeMembership: makeMembership(),
        }),
      { wrapper: QueryProvider },
    );

    await waitFor(() => expect(result.current.clientSummary).toBe("Client-safe summary from latest package."));

    act(() => {
      result.current.setClientSummary("");
    });

    expect(result.current.clientSummary).toBe("");

    await act(async () => {
      await result.current.jobQuery.refetch();
    });

    await waitFor(() => expect(result.current.jobQuery.dataUpdatedAt).toBeGreaterThan(0));
    expect(result.current.clientSummary).toBe("");
  });
});
