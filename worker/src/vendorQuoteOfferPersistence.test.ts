// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  finalizeVendorQuoteResult,
  type VendorQuoteResultFinalization,
} from "./vendorQuoteOfferPersistence.js";

function makeClient(error?: unknown) {
  const rpc = vi.fn(async () => ({ error: error ?? null }));

  return {
    client: { rpc } as unknown as SupabaseClient,
    rpc,
  };
}

const payloads = [
  { offer_key: "xometry-domestic-standard" },
  { offer_key: "xometry-economy" },
] as Parameters<typeof finalizeVendorQuoteResult>[3];

const result = {
  status: "quoted",
  unit_price_usd: 95,
  total_price_usd: 95,
  lead_time_business_days: 8,
  quote_url: "https://example.test/quote",
  dfm_issues: [],
  notes: ["All variants collected."],
  raw_payload: { offers: [] },
} satisfies VendorQuoteResultFinalization;

describe("finalizeVendorQuoteResult", () => {
  it("passes the parent result and complete stable-key set to one transaction", async () => {
    const mock = makeClient();

    await finalizeVendorQuoteResult(mock.client, "result-1", result, payloads);

    expect(mock.rpc).toHaveBeenCalledWith("reconcile_vendor_quote_offers", {
      p_vendor_quote_result_id: "result-1",
      p_result: result,
      p_offers: payloads,
    });
  });

  it("clears prior variants when a replay returns no purchasable offers", async () => {
    const mock = makeClient();

    await finalizeVendorQuoteResult(mock.client, "result-1", result, []);

    expect(mock.rpc).toHaveBeenCalledWith("reconcile_vendor_quote_offers", {
      p_vendor_quote_result_id: "result-1",
      p_result: result,
      p_offers: [],
    });
  });

  it("replays stable keys through upsert so changed option fields replace prior values", async () => {
    const mock = makeClient();
    const initial = [
      { offer_key: "xometry-economy", total_price_usd: 100 },
    ] as Parameters<typeof finalizeVendorQuoteResult>[3];
    const changed = [
      { offer_key: "xometry-economy", total_price_usd: 95 },
    ] as Parameters<typeof finalizeVendorQuoteResult>[3];

    await finalizeVendorQuoteResult(mock.client, "result-1", result, initial);
    await finalizeVendorQuoteResult(mock.client, "result-1", result, changed);

    expect(mock.rpc).toHaveBeenNthCalledWith(1, "reconcile_vendor_quote_offers", {
      p_vendor_quote_result_id: "result-1",
      p_result: result,
      p_offers: initial,
    });
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "reconcile_vendor_quote_offers", {
      p_vendor_quote_result_id: "result-1",
      p_result: result,
      p_offers: changed,
    });
  });

  it("fails the task when the atomic reconciliation cannot complete", async () => {
    const mock = makeClient(new Error("transaction denied"));

    await expect(finalizeVendorQuoteResult(mock.client, "result-1", result, payloads)).rejects.toMatchObject({
      code: "persistence_failure",
      payload: expect.objectContaining({ reason: "quote_result_finalization_failed" }),
    });
  });
});
