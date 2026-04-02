// @vitest-environment node

import { describe, expect, it } from "vitest";
import { evaluateOpenclawGateFromRows } from "./openclawGate";

const BASE_TIME = "2026-04-02T20:00:00.000Z";

function makeRow(overrides: Partial<{
  id: string;
  vendor: string;
  status: string;
  total_price_usd: number | null;
  lead_time_business_days: number | null;
  quote_url: string | null;
  raw_payload: unknown;
  notes: unknown;
  updated_at: string;
}> = {}) {
  return {
    id: "row-1",
    vendor: "xometry",
    status: "instant_quote_received",
    total_price_usd: 120.5,
    lead_time_business_days: 6,
    quote_url: "https://vendor.example/quote/1",
    raw_payload: {},
    notes: [],
    updated_at: BASE_TIME,
    ...overrides,
  };
}

describe("evaluateOpenclawGateFromRows", () => {
  it("passes when both xometry and fictiv have real persisted quote evidence", () => {
    const report = evaluateOpenclawGateFromRows("run-1", [
      makeRow({
        id: "xometry-real",
        vendor: "xometry",
      }),
      makeRow({
        id: "fictiv-real",
        vendor: "fictiv",
      }),
    ]);

    expect(report.decision).toBe("pass");
    expect(report.realQuoteVendorCount).toBe(2);
    expect(report.blockedVendorCount).toBe(0);
    expect(report.concurrentSessionRisk.detected).toBe(false);
  });

  it("fails anti-detection when two vendors are blocked by login/captcha style failures", () => {
    const report = evaluateOpenclawGateFromRows("run-2", [
      makeRow({
        id: "xometry-blocked",
        vendor: "xometry",
        status: "failed",
        total_price_usd: null,
        lead_time_business_days: null,
        raw_payload: { failureCode: "login_required" },
      }),
      makeRow({
        id: "fictiv-blocked",
        vendor: "fictiv",
        status: "failed",
        total_price_usd: null,
        lead_time_business_days: null,
        raw_payload: { failureCode: "captcha" },
      }),
    ]);

    expect(report.decision).toBe("fail_anti_detection");
    expect(report.blockedVendorCount).toBe(2);
  });

  it("fails stub/simulation when a vendor result is synthetic", () => {
    const report = evaluateOpenclawGateFromRows("run-3", [
      makeRow({
        id: "xometry-real",
        vendor: "xometry",
      }),
      makeRow({
        id: "fictiv-sim",
        vendor: "fictiv",
        quote_url: "simulated://fictiv/part-1",
        raw_payload: { mode: "simulate" },
        notes: ["Simulated Fictiv quote generated from deterministic model."],
      }),
    ]);

    expect(report.decision).toBe("fail_stub_or_simulation");
    expect(report.hasSyntheticOrStubSignal).toBe(true);
  });

  it("flags concurrency risk when xometry shows blocking auth state and non-blocked progress", () => {
    const report = evaluateOpenclawGateFromRows("run-4", [
      makeRow({
        id: "xometry-real",
        vendor: "xometry",
      }),
      makeRow({
        id: "xometry-login-failure",
        vendor: "xometry",
        status: "failed",
        total_price_usd: null,
        lead_time_business_days: null,
        raw_payload: { failureCode: "login_required" },
      }),
      makeRow({
        id: "fictiv-real",
        vendor: "fictiv",
      }),
    ]);

    expect(report.decision).toBe("pass");
    expect(report.concurrentSessionRisk.detected).toBe(true);
    expect(report.concurrentSessionRisk.reason).toContain("Xometry rows show both");
  });

  it("fails with insufficient data when required vendor evidence is missing", () => {
    const report = evaluateOpenclawGateFromRows("run-5", [
      makeRow({
        id: "xometry-only",
        vendor: "xometry",
      }),
    ]);

    expect(report.decision).toBe("fail_insufficient_data");
    expect(report.realQuoteVendorCount).toBe(1);
  });
});
