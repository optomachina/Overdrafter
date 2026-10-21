import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";
import { fetchJobPartSummariesByJobIds, fetchJobPartSummariesByOrganization, updateClientPartRequest } from "./jobs-api";

const { callRpcMock, callUntypedRpcMock, fromMock } = vi.hoisted(() => ({
  callRpcMock: vi.fn(),
  callUntypedRpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: fromMock } }));
vi.mock("@/features/quotes/client-workspace-fixtures", () => ({
  getActiveClientWorkspaceGateway: () => null,
}));
vi.mock("./shared/rpc", () => ({
  callRpc: callRpcMock,
  callUntypedRpc: callUntypedRpcMock,
}));

const extractionObject = {
  raw: null,
  reasons: [],
  confidence: 0,
  normalized: null,
  reviewNeeded: false,
};

function makeInput(finish: unknown): ClientPartRequestUpdateInput {
  return {
    jobId: "job-1",
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    material: "6061-T6",
    finish,
    tightestToleranceInch: 0.001,
    quantity: 5,
    requestedQuoteQuantities: [5],
    shipping: {},
    certifications: [],
    sourcing: {},
    release: {},
  } as unknown as ClientPartRequestUpdateInput;
}

describe("updateClientPartRequest finish handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves tolerance while leaving a string finish intact", async () => {
    callRpcMock.mockResolvedValue({ data: "job-1", error: null });

    await updateClientPartRequest(makeInput("Black anodize"));

    expect(callRpcMock).toHaveBeenCalledWith(
      "api_update_client_part_request",
      expect.objectContaining({ p_finish: "Black anodize", p_tightest_tolerance_inch: 0.001 }),
    );
  });

  it("sends a null finish instead of a raw JSON object on the primary path", async () => {
    callRpcMock.mockResolvedValue({ data: "job-1", error: null });

    await updateClientPartRequest(makeInput(extractionObject));

    expect(callRpcMock).toHaveBeenCalledTimes(1);
    expect(callRpcMock.mock.calls[0][1]).toMatchObject({ p_finish: null, p_tightest_tolerance_inch: 0.001 });
  });

  it("sends a null finish instead of a raw JSON object on the legacy fallback path", async () => {
    callRpcMock
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function api_update_client_part_request",
          details: "",
          hint: "",
        },
      })
      .mockResolvedValueOnce({ data: "job-1", error: null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await updateClientPartRequest(makeInput(extractionObject));

    expect(callRpcMock).toHaveBeenCalledTimes(2);
    expect(callRpcMock.mock.calls[1][1]).toMatchObject({ p_finish: null, p_tightest_tolerance_inch: 0.001 });
  });
});


describe("published package selection summaries", () => {
  const tables = new Map<string, Record<string, unknown>[]>();
  beforeEach(() => {
    tables.clear();
    tables.set("jobs", [{ id: "job-1", selected_vendor_quote_offer_id: "offer-1", requested_quote_quantities: [10] }]);
    tables.set("parts", [{ id: "part-1", job_id: "job-1", quantity: 10 }]);
    tables.set("published_quote_packages", [{ id: "package-new", job_id: "job-1" }, { id: "package-old", job_id: "job-1" }]);
    tables.set("published_quote_options", [
      { id: "option-A", package_id: "package-new", label: "Lowest cost", published_price_usd: 100 },
      { id: "option-B", package_id: "package-new", label: "Fastest delivery", published_price_usd: 150, lead_time_business_days: 4, source_vendor_quote_offer_id: "offer-2" },
    ]);
    tables.set("client_selections", [
      { package_id: "package-new", option_id: "option-B" },
      { package_id: "package-new", option_id: "option-A" },
      { package_id: "package-old", option_id: "option-A" },
    ]);
    fromMock.mockImplementation((table: string) => {
      const filters: Array<[string, unknown[]]> = [];
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        in: vi.fn((column: string, values: unknown[]) => { filters.push([column, values]); return query; }),
        order: vi.fn(() => query),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({
          data: (tables.get(table) ?? []).filter((row) => filters.every(([column, values]) => values.includes(row[column]))), error: null,
        }).then(resolve),
      };
      return query;
    });
    callRpcMock.mockResolvedValue({ data: [{ jobId: "job-1", partId: "part-1", organizationId: "org-1", quantity: 10 }], error: null });
    callUntypedRpcMock.mockResolvedValue({ data: [{ jobId: "job-1", selectedOffer: { id: "offer-1", supplier: "Old supplier", total_price_usd: 100, lead_time_business_days: 9 }, vendorQuotes: [] }], error: null });
  });

  for (const scope of ["jobs", "organization"] as const) {
    const fetchSummaries = () => scope === "jobs" ? fetchJobPartSummariesByJobIds(["job-1"]) : fetchJobPartSummariesByOrganization("org-1");
    it(`${scope} summary uses the latest package selection and published price instead of the old pointer`, async () => {
      expect(await fetchSummaries()).toEqual([expect.objectContaining({ selectedSupplier: "Fastest delivery", selectedPriceUsd: 150, selectedLeadTimeBusinessDays: 4 })]);
    });
    it(`${scope} summary resolves a package selection with a null job pointer`, async () => {
      tables.get("jobs")![0].selected_vendor_quote_offer_id = null;
      expect(await fetchSummaries()).toEqual([expect.objectContaining({ selectedSupplier: "Fastest delivery", selectedPriceUsd: 150 })]);
    });
    it(`${scope} summary ignores old selections when the latest package awaits selection`, async () => {
      tables.set("client_selections", [{ package_id: "package-old", option_id: "option-A" }]);
      expect(await fetchSummaries()).toEqual([expect.objectContaining({ selectedSupplier: null, selectedPriceUsd: null })]);
    });
    it(`${scope} summary keeps the published selection without extracted part metadata`, async () => {
      callRpcMock.mockResolvedValue({ data: [], error: null });
      expect(await fetchSummaries()).toEqual([expect.objectContaining({ selectedSupplier: "Fastest delivery", selectedPriceUsd: 150 })]);
    });
    it(`${scope} summary preserves the job selection before publication`, async () => {
      tables.set("published_quote_packages", []);
      expect(await fetchSummaries()).toEqual([expect.objectContaining({ selectedSupplier: "Old supplier", selectedPriceUsd: 100 })]);
    });
  }
});
