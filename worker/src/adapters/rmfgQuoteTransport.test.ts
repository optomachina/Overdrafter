// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { LIVE_AUTOMATION_VENDORS } from "../types.js";
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
  currency: "usd", requirements: [],
  items: [{ design_id: "design-synthetic", quantity: 10, status: "ready",
    unit_amount_cents: 1250, amount_cents: 12500, requirements: [],
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
      idempotencyKey: "quote-synthetic-1", body: { items: [{ design_id: "design-synthetic",
        quantity: 10, configuration: { parts: [{ part_id: "part-a", material_id: "catalog-stock-a" }] } }] } });
    expect(outcome).toMatchObject({ state: "ready", requirementCodes: [], dfmIssueCodes: [],
      offer: { quantity: 10, currency: "USD", unitPriceUsd: 12.5,
        totalPriceUsd: 125, leadTimeBusinessDays: null,
        provenance: { leadTimeBusinessDays: "unknown" } } });
    expect(LIVE_AUTOMATION_VENDORS).not.toContain("rmfg");
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
      state: "unknown", reason: "dfm_configuration_unverified", offer: null,
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
