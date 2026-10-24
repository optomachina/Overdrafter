// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "../providerDispatchEnvelope.js";
import { runRmfgQuoteOnly, type RmfgQuoteInput, type RmfgQuoteRequest,
  type RmfgQuoteTransport } from "./rmfgQuoteTransport.js";

const input: RmfgQuoteInput = {
  file: { name: "synthetic.step", bytes: new Uint8Array([1, 2, 3]) },
  quantity: 10,
  selections: { "part-a": { materialId: "catalog-stock-a" } },
  analyzeKey: "analysis-synthetic-1", quoteKey: "quote-synthetic-1",
};
const design = {
  id: "design-synthetic", status: "ready", status_url: "/v1/designs/design-synthetic",
  parts: [{ id: "part-a", analysis_status: "ready", instance_count: 2,
    suggested_process: "sheet_metal" }],
};
const readyQuote = {
  id: "quote-synthetic", status: "ready", status_url: "/v1/quotes/quote-synthetic",
  currency: "usd", requirements: [], expires_at: "2099-11-21T00:00:00Z",
  amount_subtotal_cents: 12500, amount_shipping_cents: null, amount_tax_cents: null, amount_total_cents: 12500,
  items: [{ design_id: "design-synthetic", quantity: 10, status: "ready",
    unit_amount_cents: 1250, amount_cents: 12500, requirements: [],
    line_items: [{ part_id: "part-a", process: "sheet_metal", quantity: 20, material_id: "catalog-stock-a",
      unit_amount_cents: 625, amount_cents: 12500 }],
    dfm: { design_id: "design-synthetic", status: "ready", requirements: [],
      configuration: { parts: [{ part_id: "part-a", material_id: "catalog-stock-a" }] },
      parts: [{ part_id: "part-a", status: "ready", issues: [] }] } }],
  fulfillment: { production: [{ speed: "standard", production_days: 7,
    estimated_ship_date: "2026-10-07" }], shipping_status: "destination_required" },
};

function fixture(overrides: { analyze?: unknown; catalog?: unknown; quote?: unknown;
  quotePoll?: unknown; designPoll?: unknown; quoteStatus?: number } = {}) {
  const requests: RmfgQuoteRequest[] = [];
  const transport: RmfgQuoteTransport = vi.fn(async (request) => {
    requests.push(request);
    if (request.endpoint === "analyze") return { status: 202, body: overrides.analyze ?? design };
    if (request.endpoint === "design") return { status: 200, body: overrides.designPoll ?? design };
    if (request.endpoint === "materials") return { status: 200,
      body: overrides.catalog ?? { data: [{ id: "catalog-stock-a" }], has_more: false } };
    if (request.endpoint === "quote") return { status: overrides.quoteStatus ?? 201,
      body: overrides.quote ?? readyQuote };
    if (request.endpoint === "quote_status") return { status: 200,
      body: overrides.quotePoll ?? readyQuote };
    throw new Error("No tube catalog in this fixture");
  });
  return { requests, transport };
}

describe("RMFG offline quote transport", () => {
  it("uses only documented analyze, catalog, and quote steps with explicit stock and quote provenance", async () => {
    const { requests, transport } = fixture({ analyze: { ...design, status: "processing" },
      quote: { ...readyQuote, status: "processing" } });
    const outcome = await runRmfgQuoteOnly(input, transport);
    expect(requests.map((request) => request.endpoint)).toEqual([
      "analyze", "design", "materials", "quote", "quote_status",
    ]);
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/analyze", "/v1/designs/design-synthetic", "/v1/materials",
      "/v1/quotes", "/v1/quotes/quote-synthetic",
    ]);
    expect(requests[3]).toEqual({ endpoint: "quote", method: "POST", path: "/v1/quotes",
      idempotencyKey: expect.stringMatching(/^quote-synthetic-1-[0-9a-f]{16}$/), body: { items: [{ design_id: "design-synthetic",
        quantity: 10, configuration: { parts: [{ part_id: "part-a", material_id: "catalog-stock-a" }] } }] } });
    expect(outcome).toMatchObject({ state: "ready", requirementCodes: [], dfmIssueCodes: [], stock: null,
      offer: { quantity: 10, currency: "USD", unitPriceUsd: 12.5,
        totalPriceUsd: 125, leadTimeBusinessDays: null, validUntil: "2099-11-21T00:00:00.000Z",
        provenance: { leadTimeBusinessDays: "unknown" } } });
    // OVD-678 lists rmfg for live automation; its dispatch envelope stays unreviewed.
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES.some((reviewed) => reviewed.provider === "rmfg")).toBe(false);
  });

  it("sorts unique priced components alphabetically using locale comparison", async () => {
    const compare = vi.spyOn(String.prototype, "localeCompare");
    try {
      for (const types of [["bends", "base", "bends"], ["base", "bends", "base"]]) {
        const quote = { ...readyQuote, items: [{ ...readyQuote.items[0], line_items: [{
          ...readyQuote.items[0].line_items[0], breakdown: types.map((type) => ({ type })),
        }] }] };
        const { transport } = fixture({ quote, analyze: { ...design,
          parts: [{ ...design.parts[0], bend_count: 1 }] } });
        const outcome = await runRmfgQuoteOnly(input, transport);
        expect(outcome).toMatchObject({ state: "ready", offer: { pricedComponents: ["base", "bends"] } });
      }
      expect(compare).toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
  });

  it.each(["configuration", "dfm", "lines"])("rejects missing %s part lists", async (missing) => {
    const item = structuredClone(readyQuote.items[0]);
    if (missing === "configuration") Reflect.deleteProperty(item.dfm.configuration, "parts");
    if (missing === "dfm") Reflect.deleteProperty(item.dfm, "parts");
    if (missing === "lines") Reflect.deleteProperty(item, "line_items");
    const { transport } = fixture({ quote: { ...readyQuote, items: [item] } });
    expect(await runRmfgQuoteOnly(input, transport)).toMatchObject({ state: "unknown", offer: null,
      reason: missing === "lines" ? "line_items_unverified" : "dfm_configuration_unverified" });
  });

  it.each([
    ["failed", "error", "quote_failed"],
    ["processing", "blocked", "manufacturing_blocked"],
    ["requires_input", "blocked", "manufacturing_blocked"],
  ])("preserves stop precedence for a %s quote with conflicting findings", async (status, state, reason) => {
    const quote = { ...readyQuote, status, requirements: [{ code: "review" }], items: [{
      ...readyQuote.items[0], status: "requires_input", dfm: { ...readyQuote.items[0].dfm, status: "blocked" },
    }] };
    const { requests, transport } = fixture({ quote });
    expect(await runRmfgQuoteOnly(input, transport)).toMatchObject({ state, reason, offer: null });
    expect(requests.filter((request) => request.endpoint === "quote_status")).toHaveLength(0);
  });

  it("stops before quoting for an unverified stock ID or missing part selection", async () => {
    const { requests, transport } = fixture();
    const outcome = await runRmfgQuoteOnly({ ...input,
      selections: { "part-a": { materialId: "guessed-stock-id" } } }, transport);
    expect(outcome).toMatchObject({ state: "requires_input", offer: null });
    expect(requests.map((request) => request.endpoint)).toEqual(["analyze", "materials"]);
  });

  it.each(["requires_input", "blocked", "failed", "expired"])(
    "does not normalize a %s quote even when price fields exist", async (status) => {
      const { transport } = fixture({ quote: { ...readyQuote, status,
        requirements: [{ code: "review", message: "Synthetic finding" }] } });
      const outcome = await runRmfgQuoteOnly(input, transport);
      expect(outcome.offer).toBeNull();
      expect(outcome.requirementCodes).toContain("review");
      expect(outcome.state).toBe(status === "failed" || status === "expired" ? "error" : status);
    },
  );

  it("keeps a ready quote with incomplete DFM or missing currency unknown", async () => {
    const incomplete = fixture({ quote: { ...readyQuote, items: [
      { ...readyQuote.items[0], dfm: { status: "ready" } },
    ] } });
    expect(await runRmfgQuoteOnly(input, incomplete.transport)).toMatchObject({
      state: "unknown", reason: "ready_evidence_incomplete", offer: null,
    });
    const currency = fixture({ quote: { ...readyQuote, currency: "eur" } });
    expect(await runRmfgQuoteOnly(input, currency.transport)).toMatchObject({
      state: "unknown", reason: "offer_provenance_incomplete", offer: null,
    });
  });

  it("retains customer-visible DFM warnings with a ready offer", async () => {
    const warningQuote = { ...readyQuote, items: [{ ...readyQuote.items[0],
      dfm: { ...readyQuote.items[0].dfm, parts: [{ part_id: "part-a", status: "ready",
        issues: [{ code: "bend_review", source: "manufacturing_rules", severity: "warning",
          customer_visible: true }, { code: "internal_only", severity: "warning",
            customer_visible: false }] }] } }] };
    const { transport } = fixture({ quote: warningQuote });
    expect(await runRmfgQuoteOnly(input, transport)).toMatchObject({
      state: "ready", dfmIssueCodes: ["bend_review"], offer: { totalPriceUsd: 125 },
    });
  });

  it("rejects mismatched DFM configuration and blocked part states", async () => {
    const mismatched = fixture({ quote: { ...readyQuote, items: [{ ...readyQuote.items[0],
      dfm: { ...readyQuote.items[0].dfm,
        configuration: { parts: [{ part_id: "part-a", material_id: "different-stock" }] } } }] } });
    expect(await runRmfgQuoteOnly(input, mismatched.transport)).toMatchObject({
      state: "unknown", reason: "dfm_configuration_unverified", offer: null,
    });
    const blocked = fixture({ quote: { ...readyQuote, items: [{ ...readyQuote.items[0],
      dfm: { ...readyQuote.items[0].dfm,
        parts: [{ part_id: "part-a", status: "blocked", issues: [] }] } }] } });
    expect(await runRmfgQuoteOnly(input, blocked.transport)).toMatchObject({
      state: "blocked", offer: null,
    });
    const blockingIssue = fixture({ quote: { ...readyQuote, items: [{ ...readyQuote.items[0],
      dfm: { ...readyQuote.items[0].dfm,
        parts: [{ part_id: "part-a", status: "ready", issues: [
          { code: "synthetic_risk", severity: "blocking", accepted: false },
        ] }] } }] } });
    expect(await runRmfgQuoteOnly(input, blockingIssue.transport)).toMatchObject({
      state: "blocked", dfmIssueCodes: ["synthetic_risk"], offer: null,
    });
    const defaultBlocking = fixture({ quote: { ...readyQuote, items: [{ ...readyQuote.items[0],
      dfm: { ...readyQuote.items[0].dfm,
        parts: [{ part_id: "part-a", status: "ready", issues: [
          { code: "default_blocking", message: "Synthetic risk", source: "manufacturing_rules" },
        ] }] } }] } });
    expect(await runRmfgQuoteOnly(input, defaultBlocking.transport)).toMatchObject({
      state: "blocked", dfmIssueCodes: ["default_blocking"], offer: null,
    });
    const hiddenAcceptance = fixture({ quote: { ...readyQuote, items: [{ ...readyQuote.items[0],
      dfm: { ...readyQuote.items[0].dfm,
        configuration: { parts: [{ part_id: "part-a", material_id: "catalog-stock-a" }],
          accepted_risks: ["hole_too_close_to_bend"] } } }] } });
    expect(await runRmfgQuoteOnly(input, hiddenAcceptance.transport)).toMatchObject({
      state: "unknown", reason: "unrequested_work_priced", offer: null,
    });
  });

  it("keeps expired parent status authoritative over child input state", async () => {
    const expired = fixture({ quote: { ...readyQuote, status: "expired", items: [
      { ...readyQuote.items[0], status: "requires_input" },
    ] } });
    expect(await runRmfgQuoteOnly(input, expired.transport)).toMatchObject({
      state: "error", reason: "quote_expired", offer: null,
    });
  });

  it("bounds pending design and quote polling and never calls purchase endpoints", async () => {
    const waitingDesign = fixture({ analyze: { ...design, status: "queued" },
      designPoll: { ...design, status: "processing" } });
    expect(await runRmfgQuoteOnly(input, waitingDesign.transport)).toMatchObject({
      state: "pending", reason: "design_poll_budget_exhausted", offer: null,
    });
    expect(waitingDesign.requests.filter((request) => request.endpoint === "design")).toHaveLength(3);
    const waitingQuote = fixture({ quote: { ...readyQuote, status: "processing" },
      quotePoll: { ...readyQuote, status: "processing" } });
    expect(await runRmfgQuoteOnly(input, waitingQuote.transport)).toMatchObject({
      state: "pending", reason: "quote_poll_budget_exhausted", offer: null,
    });
    expect(waitingQuote.requests.filter((request) => request.endpoint === "quote_status")).toHaveLength(3);
    for (const request of [...waitingDesign.requests, ...waitingQuote.requests]) {
      expect(JSON.stringify(request)).not.toMatch(/cart|checkout|order|payment/i);
    }
  });

  it("handles transport and HTTP errors without reflecting raw response data", async () => {
    const rejected = vi.fn<RmfgQuoteTransport>().mockRejectedValue(new Error("secret synthetic URL"));
    expect(await runRmfgQuoteOnly(input, rejected)).toMatchObject({
      state: "error", reason: "transport_error", offer: null,
    });
    const denied = fixture({ quoteStatus: 403, quote: {
      error: { message: "sensitive synthetic account detail" },
    } });
    const outcome = await runRmfgQuoteOnly(input, denied.transport);
    expect(outcome.reason).toBe("authorization_required");
    expect(JSON.stringify(outcome)).not.toContain("sensitive");
    const stalled: RmfgQuoteTransport = () => new Promise(() => undefined);
    expect(await runRmfgQuoteOnly({ ...input, requestTimeoutMs: 1 }, stalled)).toMatchObject({
      state: "error", reason: "transport_error", offer: null,
    });
  });
});

// OVD-1057: a stated stock instead of per-part catalog IDs. Every catalog row,
// ID and price below is synthetic; the field names follow the published V1Material.
const plate = {
  id: "design-plate", status: "ready", status_url: "/v1/designs/design-plate",
  parts: [{ id: "part-plate", analysis_status: "ready", instance_count: 1, suggested_process: "sheet_metal",
    detected_thickness_mm: 3.175, bend_count: 0, bends: [] }],
};
const catalog = { has_more: false, data: [
  { id: "stock-5052-125", material: "Aluminum", type: "5052-H32", thickness_in: 0.125, thickness_mm: 3.175, bendable: true },
  { id: "stock-6061-090", material: "Aluminum", type: "6061 T6", thickness_in: 0.09, thickness_mm: 2.286, bendable: false },
  { id: "stock-6061-125", material: "Aluminum", type: "6061 T6", thickness_in: 0.125, thickness_mm: 3.175, bendable: false },
  { id: "stock-6061-t651-125", material: "Aluminum", type: "6061-T651", thickness_in: 0.125, thickness_mm: 3.175 },
] };
const plateQuote = {
  id: "quote-plate", status: "ready", currency: "usd", requirements: [],
  amount_subtotal_cents: 4321, amount_shipping_cents: null, amount_tax_cents: null, amount_total_cents: 4321,
  items: [{ design_id: "design-plate", quantity: 1, status: "ready", unit_amount_cents: 4321, amount_cents: 4321,
    requirements: [], assembly_operations_amount_cents: 0,
    line_items: [{ part_id: "part-plate", process: "sheet_metal", quantity: 1, material_id: "stock-6061-125",
      unit_amount_cents: 4321, amount_cents: 4321 }],
    dfm: { design_id: "design-plate", status: "ready", requirements: [],
      configuration: { parts: [{ part_id: "part-plate", material_id: "stock-6061-125", finish_id: null,
        taps: [], studs: [], nuts: [], standoffs: [], countersinks: [] }], assembly_operations: [], accepted_risks: [] },
      parts: [{ part_id: "part-plate", status: "ready", issues: [] }] } }],
};
const stockInput: RmfgQuoteInput = {
  file: { name: "plate.step", bytes: new Uint8Array([4, 5, 6]) }, quantity: 1, selections: {},
  stock: { grade: "6061-T6", thicknessIn: 0.125 },
  analyzeKey: "analysis-plate-1", quoteKey: "quote-plate-1",
};

function plateFixture(overrides: { design?: unknown; catalog?: unknown; quote?: unknown } = {}) {
  return fixture({ analyze: overrides.design ?? plate, designPoll: overrides.design ?? plate,
    catalog: overrides.catalog ?? catalog, quote: overrides.quote ?? plateQuote });
}

describe("RMFG quote transport with a stated stock (OVD-1057)", () => {
  it("quotes the one current catalog entry of the stated grade and thickness", async () => {
    const { requests, transport } = plateFixture();
    const outcome = await runRmfgQuoteOnly(stockInput, transport);
    expect(requests.map((request) => request.endpoint)).toEqual(["analyze", "materials", "quote"]);
    expect(requests[2]).toMatchObject({ idempotencyKey: expect.stringMatching(/^quote-plate-1-[0-9a-f]{16}$/),
      body: { items: [{ design_id: "design-plate",
      quantity: 1, configuration: { parts: [{ part_id: "part-plate", material_id: "stock-6061-125" }] } }] } });
    expect(outcome).toMatchObject({ state: "ready",
      stock: { materialId: "stock-6061-125", thicknessIn: 0.125, label: "Aluminum 6061 T6", displayThickness: null },
      offer: { quantity: 1, unitPriceUsd: 43.21, totalPriceUsd: 43.21, validUntil: null, totalCents: 4321,
        fulfillment: { standardProductionDays: null, standardShipDate: null, expeditedOffered: false }, pricedComponents: [] } });
  });

  it("keeps RMFG's stated production estimate and price components as evidence", async () => {
    const withFulfillment = { ...plateQuote,
      fulfillment: { shipping_status: "destination_required", production: [
        { speed: "standard", production_days: 5, estimated_ship_date: "2099-10-30" },
        { speed: "expedited", production_days: 2, estimated_ship_date: "2099-10-27", surcharge_cents: 900 }] },
      items: [{ ...plateQuote.items[0], line_items: [{ ...plateQuote.items[0].line_items[0],
        breakdown: [{ type: "base", unit_amount_cents: 4321, amount_cents: 4321 }] }] }] };
    expect(await runRmfgQuoteOnly(stockInput, plateFixture({ quote: withFulfillment }).transport)).toMatchObject({
      state: "ready", offer: { leadTimeBusinessDays: null, pricedComponents: ["base"],
        fulfillment: { standardProductionDays: 5, standardShipDate: "2099-10-30", expeditedOffered: true } } });
  });

  it.each([
    ["only other thicknesses or a T651 temper", stockInput,
      { has_more: false, data: catalog.data.filter((entry) => entry.id !== "stock-6061-125") }],
    ["a temper that only shares a prefix", { ...stockInput, stock: { grade: "6061-T65", thicknessIn: 0.125 } }, catalog],
  ])("never substitutes: %s stops before the quote", async (_label, request, offered) => {
    const { requests, transport } = plateFixture({ catalog: offered });
    expect(await runRmfgQuoteOnly(request, transport)).toMatchObject({
      state: "requires_input", reason: "stock_not_offered", offer: null });
    expect(requests.map((entry) => entry.endpoint)).toEqual(["analyze", "materials"]);
  });

  it("stops when two catalog entries both match", async () => {
    const { transport } = plateFixture({ catalog: { has_more: false, data: [...catalog.data,
      { id: "stock-6061-125-film", material: "Aluminum 6061-T6", type: "Sheet", thickness_in: 0.125 }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "requires_input", reason: "stock_ambiguous" });
  });

  it.each([
    ["two parts", { ...plate, parts: [...plate.parts, { ...plate.parts[0], id: "part-other" }] }, "stock_scope_multiple_parts"],
    ["two instances", { ...plate, parts: [{ ...plate.parts[0], instance_count: 2 }] }, "stock_scope_instance_count"],
    ["a tube", { ...plate, parts: [{ ...plate.parts[0], suggested_process: "tube_laser" }] }, "stock_scope_process_mismatch"],
    ["another thickness", { ...plate, parts: [{ ...plate.parts[0], detected_thickness_mm: 2.286 }] }, "stock_scope_thickness_mismatch"],
    ["no detected thickness", { ...plate, parts: [{ ...plate.parts[0], detected_thickness_mm: null }] }, "stock_scope_thickness_unverified"],
  ])("stops on %s before reading the catalog", async (_label, analyzed, reason) => {
    const { requests, transport } = plateFixture({ design: analyzed });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "requires_input", reason, offer: null });
    expect(requests.map((entry) => entry.endpoint)).toEqual(["analyze"]);
  });

  it("stops when a bent part would need stock RMFG cannot bend", async () => {
    const bent = { ...plate, parts: [{ ...plate.parts[0], bend_count: 2 }] };
    const { requests, transport } = plateFixture({ design: bent });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "requires_input", reason: "stock_not_bendable" });
    expect(requests.map((entry) => entry.endpoint)).toEqual(["analyze", "materials"]);
  });

  it("reads omitted part defaults as documented and still checks the priced quantity", async () => {
    const sparse = { ...plate, parts: [{ id: "part-plate", suggested_process: "sheet_metal", detected_thickness_mm: 3.18 }] };
    const { transport } = plateFixture({ design: sparse });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "ready" });
  });

  it.each([
    ["a substituted line material", { line_items: [{ ...plateQuote.items[0].line_items[0], material_id: "stock-5052-125" }] }],
    ["a line quantity that is not the request", { line_items: [{ ...plateQuote.items[0].line_items[0], quantity: 2 }] }],
    ["lines that do not add up", { line_items: [{ ...plateQuote.items[0].line_items[0], amount_cents: 4000 }] }],
    ["no line items", { line_items: undefined }],
  ])("keeps a ready quote with %s unknown", async (_label, itemOverride) => {
    const { transport } = plateFixture({ quote: { ...plateQuote, items: [{ ...plateQuote.items[0], ...itemOverride }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({
      state: "unknown", reason: "line_items_unverified", offer: null });
  });

  it.each([
    ["an assembly charge", { assembly_operations_amount_cents: 500 }],
    ["an explicit null assembly charge", { assembly_operations_amount_cents: null }],
  ])("stops on %s", async (_label, itemOverride) => {
    const { transport } = plateFixture({ quote: { ...plateQuote, items: [{ ...plateQuote.items[0], ...itemOverride }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({
      state: "unknown", reason: "unrequested_work_priced", offer: null });
  });

  it.each([
    ["a shipping charge", { amount_shipping_cents: 1500, amount_total_cents: 5821 }],
    ["a tax amount", { amount_tax_cents: 300 }],
    ["a total that is not the item", { amount_total_cents: 9999 }],
  ])("keeps a ready quote with %s unknown", async (_label, quoteOverride) => {
    const { transport } = plateFixture({ quote: { ...plateQuote, ...quoteOverride } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({
      state: "unknown", reason: "quote_totals_unverified", offer: null });
  });

  it("refuses a stated stock alongside per-part selections or out of range", async () => {
    const { requests, transport } = plateFixture();
    for (const bad of [{ ...stockInput, selections: { "part-plate": { materialId: "stock-6061-125" } } },
      { ...stockInput, stock: { grade: " - ", thicknessIn: 0.125 } },
      // An alloy or family alone would let the catalog pick the temper.
      { ...stockInput, stock: { grade: "6061", thicknessIn: 0.125 } },
      { ...stockInput, stock: { grade: "Aluminum", thicknessIn: 0.125 } },
      { ...stockInput, stock: { grade: "304", thicknessIn: 0.125 } },
      { ...stockInput, stock: { grade: "6061-T6", thicknessIn: 3.175 } },
      { ...stockInput, pollIntervalMs: 60_000 }, { ...stockInput, maxPolls: 0 }]) {
      expect(await runRmfgQuoteOnly(bad, transport)).toMatchObject({ state: "error", reason: "invalid_quote_input" });
    }
    expect(requests).toEqual([]);
  });

  it("never treats 0.124 in stock as the stated 0.125 in", async () => {
    const { transport } = plateFixture({ catalog: { has_more: false, data: [
      { id: "stock-6061-124", material: "Aluminum", type: "6061 T6", thickness_in: 0.124 }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "requires_input", reason: "stock_not_offered" });
    const nearPart = plateFixture({ design: { ...plate, parts: [{ ...plate.parts[0], detected_thickness_mm: 3.1496 }] } });
    expect(await runRmfgQuoteOnly(stockInput, nearPart.transport)).toMatchObject({
      state: "requires_input", reason: "stock_scope_thickness_mismatch" });
  });

  it.each([
    ["an item unit price that is not the total", { unit_amount_cents: 1 }, "offer_provenance_incomplete"],
    ["a zero price", { unit_amount_cents: 0, amount_cents: 0,
      line_items: [{ ...plateQuote.items[0].line_items[0], unit_amount_cents: 0, amount_cents: 0 }] }, "offer_provenance_incomplete"],
    ["a line unit price that is not its total", { line_items: [{ ...plateQuote.items[0].line_items[0], unit_amount_cents: 1 }] },
      "line_items_unverified"],
  ])("keeps a ready quote with %s unknown", async (_label, itemOverride, reason) => {
    const { transport } = plateFixture({ quote: { ...plateQuote, items: [{ ...plateQuote.items[0], ...itemOverride }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "unknown", reason, offer: null });
  });

  it("accepts a unit price RMFG rounded from a total that does not divide evenly", async () => {
    const twoUp = { ...plateQuote, amount_subtotal_cents: 4321, amount_total_cents: 4321, items: [{ ...plateQuote.items[0],
      quantity: 2, unit_amount_cents: 2161, amount_cents: 4321,
      line_items: [{ ...plateQuote.items[0].line_items[0], quantity: 2, unit_amount_cents: 2161, amount_cents: 4321 }] }] };
    const { transport } = plateFixture({ quote: twoUp });
    expect(await runRmfgQuoteOnly({ ...stockInput, quantity: 2 }, transport)).toMatchObject({
      state: "ready", offer: { unitPriceUsd: 21.61, totalPriceUsd: 43.21 } });
  });

  it("stops on a blocked or input finding even while the quote is still processing", async () => {
    for (const [dfmStatus, state] of [["blocked", "blocked"], ["requires_input", "requires_input"]] as const) {
      const processing = { ...plateQuote, status: "processing",
        items: [{ ...plateQuote.items[0], dfm: { ...plateQuote.items[0].dfm, status: dfmStatus } }] };
      const { requests, transport } = plateFixture({ quote: processing });
      expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state, offer: null });
      expect(requests.some((request) => request.endpoint === "quote_status")).toBe(false);
    }
    const required = { ...plateQuote, status: "processing", requirements: [{ code: "terms_review", message: "Synthetic" }] };
    const { requests, transport } = plateFixture({ quote: required });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({
      state: "requires_input", reason: "unresolved_requirements", requirementCodes: ["terms_review"] });
    expect(requests.some((request) => request.endpoint === "quote_status")).toBe(false);
  });

  it("never publishes a quote whose stated expiry has passed or cannot be read", async () => {
    const now = () => Date.parse("2026-10-22T12:00:00Z");
    const cases = [["2026-10-22T11:59:59Z", "error", "quote_expired"], ["next week", "unknown", "quote_expiry_unverified"],
      [1_790_000_000, "unknown", "quote_expiry_unverified"]] as const;
    for (const [expiresAt, state, reason] of cases) {
      const { transport } = plateFixture({ quote: { ...plateQuote, expires_at: expiresAt } });
      expect(await runRmfgQuoteOnly({ ...stockInput, now }, transport)).toMatchObject({ state, reason, offer: null });
    }
    const { transport } = plateFixture({ quote: { ...plateQuote, expires_at: "2026-11-21T00:00:00Z" } });
    expect(await runRmfgQuoteOnly({ ...stockInput, now }, transport)).toMatchObject({
      state: "ready", offer: { validUntil: "2026-11-21T00:00:00.000Z" } });
  });

  it("binds the quote idempotency key to the exact request body", async () => {
    const first = plateFixture();
    await runRmfgQuoteOnly(stockInput, first.transport);
    const again = plateFixture();
    await runRmfgQuoteOnly(stockInput, again.transport);
    const other = plateFixture({ catalog: { has_more: false, data: [{ ...catalog.data[2], id: "stock-6061-125-new" }] },
      quote: { ...plateQuote, items: [{ ...plateQuote.items[0],
        line_items: [{ ...plateQuote.items[0].line_items[0], material_id: "stock-6061-125-new" }],
        dfm: { ...plateQuote.items[0].dfm, configuration: { parts: [{ part_id: "part-plate", material_id: "stock-6061-125-new" }] } } }] } });
    expect(await runRmfgQuoteOnly(stockInput, other.transport)).toMatchObject({ state: "ready" });
    const keyOf = (requests: RmfgQuoteRequest[]) =>
      (requests.find((request) => request.endpoint === "quote") as { idempotencyKey: string }).idempotencyKey;
    expect(keyOf(again.requests)).toBe(keyOf(first.requests));
    expect(keyOf(other.requests)).not.toBe(keyOf(first.requests));
    expect(keyOf(other.requests).startsWith("quote-plate-1-")).toBe(true);
  });

  it.each([
    ["a finish applied to the part", { finish_id: "finish-synthetic-deburr" }],
    ["a recommended finish", { finish_id: "finish-synthetic-tumble", finish_recommended: true }],
  ])("does not quote a part RMFG priced with %s", async (_label, partOverride) => {
    const { transport } = plateFixture({ quote: { ...plateQuote, items: [{ ...plateQuote.items[0],
      dfm: { ...plateQuote.items[0].dfm, parts: [{ ...plateQuote.items[0].dfm.parts[0], ...partOverride }] } }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({
      state: "unknown", reason: "unrequested_work_priced", offer: null });
  });

  it("accepts cutting and forming price components but not a priced operation", async () => {
    const withBreakdown = (types: string[]) => ({ ...plateQuote, items: [{ ...plateQuote.items[0],
      line_items: [{ ...plateQuote.items[0].line_items[0],
        breakdown: types.map((type) => ({ type, unit_amount_cents: 1, amount_cents: 1 })) }] }] });
    expect(await runRmfgQuoteOnly(stockInput, plateFixture({ quote: withBreakdown(["base"]) }).transport))
      .toMatchObject({ state: "ready" });
    for (const extra of ["finish", "powder_coat", "taps", "countersinks"]) {
      expect(await runRmfgQuoteOnly(stockInput, plateFixture({ quote: withBreakdown(["base", extra]) }).transport))
        .toMatchObject({ state: "unknown", reason: "unrequested_work_priced", offer: null });
    }
    // The plate has no bends, so a priced bend is not this part.
    expect(await runRmfgQuoteOnly(stockInput, plateFixture({ quote: withBreakdown(["base", "bends"]) }).transport))
      .toMatchObject({ state: "unknown", reason: "line_items_unverified", offer: null });
  });

  it("does not quote a configuration RMFG echoes back with its recommended finish", async () => {
    const { transport } = plateFixture({ quote: { ...plateQuote, items: [{ ...plateQuote.items[0],
      dfm: { ...plateQuote.items[0].dfm, configuration: { ...plateQuote.items[0].dfm.configuration, recommended_finish: true } } }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({
      state: "unknown", reason: "unrequested_work_priced", offer: null });
  });

  it("stops on a second item or a finish even while the quote is still processing", async () => {
    const twoItems = { ...plateQuote, status: "processing", items: [plateQuote.items[0], { ...plateQuote.items[0], status: "blocked" }] };
    const finished = { ...plateQuote, status: "processing", items: [{ ...plateQuote.items[0],
      dfm: { ...plateQuote.items[0].dfm, parts: [{ ...plateQuote.items[0].dfm.parts[0], finish_id: "finish-synthetic" }] } }] };
    const configured = (part: Record<string, unknown>) => ({ ...plateQuote, status: "processing", items: [{ ...plateQuote.items[0],
      dfm: { ...plateQuote.items[0].dfm, configuration: { parts: [{ part_id: "part-plate", material_id: "stock-6061-125", ...part }] } } }] });
    for (const [quote, reason] of [[twoItems, "quote_items_unverified"], [finished, "unrequested_work_priced"],
      [configured({ finish_id: "finish-synthetic" }), "unrequested_work_priced"],
      [configured({ taps: [{ hole_id: 1 }] }), "unrequested_work_priced"],
      [configured({ countersinks: "malformed" }), "unrequested_work_priced"]] as const) {
      const { requests, transport } = plateFixture({ quote });
      expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "unknown", reason, offer: null });
      expect(requests.some((request) => request.endpoint === "quote_status")).toBe(false);
    }
  });

  it.each([
    ["a substituted configured stock", (quote: typeof plateQuote) => ({ ...quote.items[0], dfm: { ...quote.items[0].dfm,
      configuration: { parts: [{ part_id: "part-plate", material_id: "stock-5052-125" }] } } }), "dfm_configuration_unverified"],
    ["a line on substituted stock", (quote: typeof plateQuote) => ({ ...quote.items[0],
      line_items: [{ ...quote.items[0].line_items[0], material_id: "stock-5052-125" }] }), "line_items_unverified"],
    ["another quantity", (quote: typeof plateQuote) => ({ ...quote.items[0], quantity: 2 }), "offer_provenance_incomplete"],
    ["another design", (quote: typeof plateQuote) => ({ ...quote.items[0], design_id: "design-other" }),
      "offer_provenance_incomplete"],
  ])("stops on %s while the quote is processing, before any later clean answer", async (_label, item, reason) => {
    const { requests, transport } = plateFixture({ quote: { ...plateQuote, status: "processing", items: [item(plateQuote)] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "unknown", reason, offer: null });
    expect(requests.some((request) => request.endpoint === "quote_status")).toBe(false);
  });

  it.each([
    ["a reported part that was not selected", (quote: typeof plateQuote) => ({ ...quote.items[0], dfm: { ...quote.items[0].dfm,
      parts: [{ part_id: "part-other", status: "ready", issues: [] }] } }), "dfm_configuration_unverified"],
    ["the same line twice", (quote: typeof plateQuote) => ({ ...quote.items[0],
      line_items: [quote.items[0].line_items[0], quote.items[0].line_items[0]] }), "line_items_unverified"],
  ])("stops on %s while the quote is processing", async (_label, item, reason) => {
    const { requests, transport } = plateFixture({ quote: { ...plateQuote, status: "processing", items: [item(plateQuote)] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "unknown", reason, offer: null });
    expect(requests.some((request) => request.endpoint === "quote_status")).toBe(false);
  });

  it("waits through a partial processing answer and quotes the complete ready one", async () => {
    const partial = { id: "quote-plate", status: "processing", currency: "usd", requirements: [],
      items: [{ design_id: "design-plate", quantity: 1, line_items: [{ part_id: "part-plate" }],
        dfm: { design_id: "design-plate", configuration: {}, parts: [{ part_id: "part-plate" }] } }] };
    const { requests, transport } = fixture({ analyze: plate, designPoll: plate, catalog, quote: partial, quotePoll: plateQuote });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "ready", offer: { totalPriceUsd: 43.21 } });
    expect(requests.filter((request) => request.endpoint === "quote_status")).toHaveLength(1);
  });

  it("blocks when an issue list cannot be read", async () => {
    const unreadable = { ...plateQuote, items: [{ ...plateQuote.items[0], dfm: { ...plateQuote.items[0].dfm,
      parts: [{ ...plateQuote.items[0].dfm.parts[0], issues: { code: "synthetic", severity: "blocking" } }] } }] };
    expect(await runRmfgQuoteOnly(stockInput, plateFixture({ quote: unreadable }).transport)).toMatchObject({
      state: "blocked", offer: null });
    const assembly = { ...plateQuote, items: [{ ...plateQuote.items[0], dfm: { ...plateQuote.items[0].dfm,
      assembly_issues: { code: "synthetic" } } }] };
    expect(await runRmfgQuoteOnly(stockInput, plateFixture({ quote: assembly }).transport)).toMatchObject({
      state: "blocked", offer: null });
  });

  it("stops on a shipping charge while the quote is processing", async () => {
    const { requests, transport } = plateFixture({ quote: { ...plateQuote, status: "processing", amount_shipping_cents: 900 } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "unknown", reason: "quote_totals_unverified" });
    expect(requests.some((request) => request.endpoint === "quote_status")).toBe(false);
  });

  it("treats a blocking finding RMFG marks accepted as blocking, since no risk was ever accepted", async () => {
    const accepted = { ...plateQuote, items: [{ ...plateQuote.items[0], dfm: { ...plateQuote.items[0].dfm,
      parts: [{ ...plateQuote.items[0].dfm.parts[0], issues: [{ code: "hole_too_close_to_bend", severity: "blocking",
        accepted: true, source: "geometry", message: "Synthetic" }] }] } }] };
    expect(await runRmfgQuoteOnly(stockInput, plateFixture({ quote: accepted }).transport)).toMatchObject({
      state: "blocked", dfmIssueCodes: ["hole_too_close_to_bend"], offer: null });
  });

  it.each([
    ["accepted_risks", "hole_too_close_to_bend"],
    ["assembly_operations", { weld: true }],
    ["recommended_finish", "yes"],
    ["defaults", "stock-6061-125"],
  ])("stops on a malformed %s in the echoed configuration", async (key, value) => {
    const { transport } = plateFixture({ quote: { ...plateQuote, items: [{ ...plateQuote.items[0], dfm: {
      ...plateQuote.items[0].dfm, configuration: { ...plateQuote.items[0].dfm.configuration, [key]: value } } }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({
      state: "unknown", reason: "unrequested_work_priced", offer: null });
  });

  it.each([
    ["instance_count", { instance_count: null }],
    ["analysis_status", { analysis_status: null }],
  ])("does not read an explicit null %s as its documented default", async (_label, partOverride) => {
    const { requests, transport } = plateFixture({ design: { ...plate, parts: [{ ...plate.parts[0], ...partOverride }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "unknown", reason: "parts_unverified" });
    expect(requests.map((request) => request.endpoint)).toEqual(["analyze"]);
  });

  it("treats an unreadable bend count as bent, so unbendable stock stops", async () => {
    const { transport } = plateFixture({ design: { ...plate, parts: [{ ...plate.parts[0], bend_count: null }] } });
    expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({ state: "requires_input", reason: "stock_not_bendable" });
  });

  it("picks the plain stock over a variant, and never a variant alone", async () => {
    const variant = { id: "stock-6061-125-pvc", material: "Aluminum", type: "6061 T6 PVC Coated", thickness_in: 0.125 };
    const diamond = { id: "stock-6061-125-diamond", material: "Aluminum 6061-T6", type: "Diamond Plate", thickness_in: 0.125 };
    const both = plateFixture({ catalog: { has_more: false, data: [...catalog.data, variant, diamond] } });
    expect(await runRmfgQuoteOnly(stockInput, both.transport)).toMatchObject({
      state: "ready", stock: { materialId: "stock-6061-125" } });
    for (const only of [variant, diamond]) {
      const { requests, transport } = plateFixture({ catalog: { has_more: false, data: [only] } });
      expect(await runRmfgQuoteOnly(stockInput, transport)).toMatchObject({
        state: "requires_input", reason: "stock_not_offered",
        stockMatches: [{ materialId: only.id, thicknessIn: 0.125 }] });
      expect(requests.map((request) => request.endpoint)).toEqual(["analyze", "materials"]);
    }
  });

  it("waits between status polls and honors the poll budget", async () => {
    vi.useFakeTimers();
    try {
      const { requests, transport } = plateFixture({ design: { ...plate, status: "processing" } });
      const pending = runRmfgQuoteOnly({ ...stockInput, pollIntervalMs: 3_000, maxPolls: 5 }, transport);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(requests.map((entry) => entry.endpoint)).toEqual(["analyze"]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toMatchObject({ state: "pending", reason: "design_poll_budget_exhausted" });
      expect(requests.filter((entry) => entry.endpoint === "design")).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
