import { describe, expect, it } from "vitest";
import {
  PROVIDER_RESULT_CONTRACT_VERSION,
  classifyProviderFailure,
  toAdminRejectionDiagnostic,
  toDeliveryObservation,
  validateProviderResult,
  type ProviderResultCandidate,
  type ProviderResultExpectation,
} from "./providerResultValidation.js";
import { projectDeliveredCostAndArrival } from "../../shared/delivered-cost-arrival.js";
import type { VendorName, VendorQuoteAdapterOffer, VendorQuoteAdapterOutput } from "./types.js";

const NOW = "2026-10-12T12:00:00.000Z";
const COLLECTED = "2026-10-12T11:55:00.000Z";

const DOMAINS: Record<string, string> = {
  xometry: "xometry.com",
  fictiv: "fictiv.com",
  quickparts: "quickparts.com",
  weerg: "weerg.com",
};

function expectation(provider: VendorName, quantity = 10): ProviderResultExpectation {
  return {
    provider,
    taskId: "task-1",
    laneId: "lane-1",
    permitId: "permit-1",
    runId: "run-1",
    envelopeRevision: "env-2026-10-01",
    policyRevision: "policy-7",
    packageId: "pkg-sha256-abc",
    requestedQuantity: quantity,
    allowedDomains: [DOMAINS[provider] ?? "example.com"],
    now: NOW,
  };
}

function offer(overrides: Partial<VendorQuoteAdapterOffer> = {}): VendorQuoteAdapterOffer {
  return {
    providerOptionId: "standard",
    providerLabel: "Standard",
    quoteRef: "Q-1",
    quoteUrl: null,
    unitPriceUsd: 12,
    totalPriceUsd: 120,
    leadTimeBusinessDays: 8,
    shipReceiveBy: null,
    tier: "Standard",
    sourcing: null,
    geographicOrigin: "unknown",
    sortRank: 0,
    provenance: {
      containerSelector: ".option",
      providerOptionIdSource: "attribute",
      priceSource: "selector",
      leadTimeSource: "selector",
      geographicOriginSource: "none",
    },
    rawPayload: {},
    ...overrides,
  };
}

function candidate(
  provider: VendorName,
  result: Partial<VendorQuoteAdapterOutput>,
  quantity = 10,
): ProviderResultCandidate {
  const e = expectation(provider, quantity);
  return {
    contractVersion: PROVIDER_RESULT_CONTRACT_VERSION,
    binding: {
      provider,
      taskId: e.taskId,
      laneId: e.laneId,
      permitId: e.permitId,
      runId: e.runId,
      envelopeRevision: e.envelopeRevision,
      policyRevision: e.policyRevision,
      packageId: e.packageId,
      quantity,
      adapterRevision: "adapter-1",
    },
    currency: "USD",
    collectedAt: COLLECTED,
    result: {
      vendor: provider,
      status: "instant_quote_received",
      unitPriceUsd: 12,
      totalPriceUsd: 120,
      leadTimeBusinessDays: 8,
      quoteUrl: `https://www.${DOMAINS[provider]}/quotes/abc`,
      dfmIssues: [],
      notes: [],
      artifacts: [],
      rawPayload: { requestedQuantity: quantity },
      ...result,
    },
  };
}

function codes(c: ProviderResultCandidate, e: ProviderResultExpectation) {
  const out = validateProviderResult(c, e);
  return out.ok ? [] : out.rejection.issues.map((i) => i.code);
}

describe("synthetic live provider payloads", () => {
  it("accepts a Xometry one-to-many variant set intact with typed origin", () => {
    const offers = [
      offer({ providerOptionId: "domestic-economy", providerLabel: "Domestic Economy", unitPriceUsd: 12, totalPriceUsd: 120, geographicOrigin: "domestic", sourcing: "Made in USA", provenance: { containerSelector: ".price-tier", providerOptionIdSource: "attribute", priceSource: "selector", leadTimeSource: "selector", geographicOriginSource: "provider_text" } }),
      offer({ providerOptionId: "foreign-standard", providerLabel: "Standard", unitPriceUsd: 9, totalPriceUsd: 90, geographicOrigin: "foreign", sourcing: "Made Internationally", provenance: { containerSelector: ".price-tier", providerOptionIdSource: "attribute", priceSource: "selector", leadTimeSource: "selector", geographicOriginSource: "provider_text" } }),
      offer({ providerOptionId: "expedited", providerLabel: "Expedited", unitPriceUsd: 20, totalPriceUsd: 200, leadTimeBusinessDays: 3 }),
    ];
    const c = candidate("xometry", {
      offers,
      unitPriceUsd: 9,
      totalPriceUsd: 90,
      leadTimeBusinessDays: 8,
      rawPayload: { requestedQuantity: 10, detectedFlow: "instant_quote", bodyExcerpt: "<div>big dom</div>", offerCount: 3 },
    });
    const out = validateProviderResult(c, expectation("xometry"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.offers.map((o) => o.providerOptionId)).toEqual(["domestic-economy", "foreign-standard", "expedited"]);
    expect(out.value.offers.map((o) => o.geographicOrigin)).toEqual(["domestic", "foreign", "unknown"]);
    expect(out.value.offers.every((o) => o.derivedFromSummary === false)).toBe(true);
    expect(out.value.provenance).toMatchObject({ provider: "xometry", runId: "run-1", envelopeRevision: "env-2026-10-01" });
    expect(Object.isFrozen(out.value)).toBe(true);
  });

  it("accepts Fictiv total priced options", () => {
    const c = candidate("fictiv", {
      offers: [offer({ providerOptionId: "fictiv-standard", rawPayload: { currency: "USD", priceBasis: "total", cookie_banner_dismissed: true } })],
    });
    // A credential shaped key anywhere in an offer payload is rejected, not silently kept.
    expect(codes(c, expectation("fictiv"))).toContain("forbidden_content");
    c.result.offers![0]!.rawPayload = { currency: "USD", priceBasis: "total", optionSelector: ".opt" };
    expect(validateProviderResult(c, expectation("fictiv")).ok).toBe(true);
  });

  it("accepts a Quickparts summary only result as a flagged derived offer", () => {
    const out = validateProviderResult(candidate("quickparts", {}), expectation("quickparts"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.offers).toHaveLength(1);
    expect(out.value.offers[0]).toMatchObject({ derivedFromSummary: true, geographicOrigin: "unknown", quantity: 10 });
  });

  it("rejects Weerg native EUR as non comparable rather than converting it", () => {
    const c = candidate("weerg", {});
    c.currency = "EUR";
    const out = validateProviderResult(c, expectation("weerg"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("invalid_currency");
    expect(out.rejection.adminVisible).toBe(true);
  });
});

describe("fail closed matrix", () => {
  const e = expectation("xometry");
  const base = () => candidate("xometry", { offers: [offer()] });

  it.each([
    ["provider", (c: ProviderResultCandidate) => { c.binding.provider = "fictiv"; }],
    ["task", (c: ProviderResultCandidate) => { c.binding.taskId = "other"; }],
    ["lane", (c: ProviderResultCandidate) => { c.binding.laneId = "other"; }],
    ["permit", (c: ProviderResultCandidate) => { c.binding.permitId = "other"; }],
    ["run", (c: ProviderResultCandidate) => { c.binding.runId = "other"; }],
    ["envelope", (c: ProviderResultCandidate) => { c.binding.envelopeRevision = "old"; }],
    ["policy", (c: ProviderResultCandidate) => { c.binding.policyRevision = "old"; }],
    ["package", (c: ProviderResultCandidate) => { c.binding.packageId = "other"; }],
    ["result vendor", (c: ProviderResultCandidate) => { c.result.vendor = "fictiv"; }],
  ])("rejects mismatched %s binding as terminal", (_name, mutate) => {
    const c = base();
    mutate(c);
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("binding_mismatch");
    expect(out.rejection.retry).toBe("none");
  });

  it("rejects unsupported versions and non object input", () => {
    const c = base();
    c.contractVersion = "v0";
    expect(codes(c, e)).toEqual(["unsupported_contract_version"]);
    expect(codes(null as unknown as ProviderResultCandidate, e)).toEqual(["malformed_candidate"]);
  });

  it("rejects simulated results", () => {
    const sim = base();
    sim.simulated = true;
    expect(codes(sim, e)).toContain("simulated_result");
    const flow = base();
    flow.result.rawPayload = { mode: "simulate" };
    expect(codes(flow, e)).toContain("simulated_result");
    const url = candidate("fictiv", { quoteUrl: "simulated://fictiv/part-1", offers: undefined });
    expect(codes(url, expectation("fictiv"))).toContain("simulated_result");
  });

  it("rejects adapter asserted admission claims", () => {
    const c = base();
    c.result.rawPayload = { requestedQuantity: 10, admitted: true };
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("adapter_admission_claim");
    expect(out.rejection.retry).toBe("none");
  });

  it("rejects duplicate identifiers case insensitively", () => {
    const c = candidate("xometry", { offers: [offer({ providerOptionId: "A" }), offer({ providerOptionId: " a " })] });
    expect(codes(c, e)).toContain("duplicate_offer_id");
  });

  it("rejects partial option sets declared by the adapter", () => {
    const c = candidate("xometry", { offers: [offer()], rawPayload: { requestedQuantity: 10, offerCount: 3 } });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("partial_offer_set");
    expect(out.rejection.retry).toBe("bounded");
    expect(out.rejection.retryBudget).toBe(1);
  });

  it("rejects a result with no offers and no usable summary", () => {
    const c = candidate("xometry", { unitPriceUsd: null, totalPriceUsd: null, offers: [] });
    expect(codes(c, e)).toEqual(["missing_offers"]);
  });

  it.each([
    ["negative", -1], ["zero", 0], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["huge", 1e12], ["string", "12" as unknown as number],
  ])("rejects %s price", (_n, price) => {
    const c = candidate("xometry", { offers: [offer({ unitPriceUsd: price, totalPriceUsd: 120 })] });
    expect(codes(c, e)).toContain("invalid_price");
  });

  it("rejects total not consistent with unit price and quantity", () => {
    const c = candidate("xometry", { offers: [offer({ unitPriceUsd: 12, totalPriceUsd: 500 })] });
    expect(codes(c, e)).toContain("price_inconsistent");
    const rounded = candidate("xometry", { offers: [offer({ unitPriceUsd: 12.004, totalPriceUsd: 120 })] });
    expect(validateProviderResult(rounded, e).ok).toBe(true);
  });

  it("rejects wrong quantity at binding, offer and payload level", () => {
    const b = base();
    b.binding.quantity = 5;
    expect(codes(b, e)).toContain("invalid_quantity");
    const o = candidate("xometry", { offers: [offer({ quantity: 25 })] });
    expect(codes(o, e)).toContain("invalid_quantity");
    const p = candidate("xometry", { offers: [offer()], rawPayload: { requestedQuantity: 3 } });
    expect(codes(p, e)).toContain("invalid_quantity");
  });

  it.each(["usd", "EUR", "", "US$"])("rejects currency %j", (currency) => {
    const c = base();
    c.currency = currency;
    expect(codes(c, e)).toContain("invalid_currency");
  });

  it.each([-1, 1.5, 366, Number.NaN])("rejects lead time %s", (lead) => {
    const c = candidate("xometry", { offers: [offer({ leadTimeBusinessDays: lead })] });
    expect(codes(c, e)).toContain("invalid_lead_time");
  });

  it("accepts unknown lead time and refuses unanchored lead time", () => {
    const unknown = candidate("xometry", { offers: [offer({ leadTimeBusinessDays: null, provenance: { ...offer().provenance, leadTimeSource: "none" } })] });
    expect(validateProviderResult(unknown, e).ok).toBe(true);
    const unanchored = candidate("xometry", { offers: [offer({ provenance: { ...offer().provenance, leadTimeSource: "body_text" } })] });
    expect(codes(unanchored, e)).toContain("untrusted_source");
  });

  it("never accepts a known origin without provider text evidence", () => {
    const c = candidate("xometry", { offers: [offer({ geographicOrigin: "domestic" })] });
    expect(codes(c, e)).toContain("invalid_origin");
    const bad = candidate("xometry", { offers: [offer({ geographicOrigin: "usa" as never })] });
    expect(codes(bad, e)).toContain("invalid_origin");
  });

  it.each([
    "http://www.xometry.com/q/1",
    "https://evil.example.com/q/1",
    "https://xometry.com.evil.com/q/1",
    "https://user:pw@www.xometry.com/q/1",
    "not a url",
    "javascript:alert(1)",
  ])("rejects destination %s", (url) => {
    const c = candidate("xometry", { quoteUrl: url, offers: [offer()] });
    expect(codes(c, e)).toContain("invalid_destination");
  });

  it("rejects stale, future and malformed collection times", () => {
    const stale = base();
    stale.collectedAt = "2026-10-12T10:00:00.000Z";
    const out = validateProviderResult(stale, e);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.rejection.code).toBe("stale_result");
      expect(out.rejection.retry).toBe("bounded");
    }
    const future = base();
    future.collectedAt = "2026-10-12T13:00:00.000Z";
    expect(codes(future, e)).toContain("invalid_timestamp");
    const junk = base();
    junk.collectedAt = "yesterday";
    expect(codes(junk, e)).toContain("invalid_timestamp");
  });

  it("rejects expired and inverted validity", () => {
    const expired = candidate("xometry", { offers: [offer()], validUntil: "2026-10-11" });
    expect(codes(expired, e)).toContain("expired_validity");
    const ok = candidate("xometry", { offers: [offer()], validUntil: "2026-10-12", quotedAt: "2026-10-12T11:00:00.000Z" });
    expect(validateProviderResult(ok, e).ok).toBe(true);
  });

  it("rejects non quote statuses with a classified admin rejection", () => {
    const c = candidate("xometry", { status: "manual_review_pending", offers: [offer()] });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("provider_reported_non_quote");
    expect(out.rejection.retry).toBe("manual_follow_up");
  });

  it("rejects unbounded artifacts and too many offers", () => {
    const art = candidate("xometry", {
      offers: [offer()],
      artifacts: Array.from({ length: 21 }, () => ({ kind: "json" as const, label: "x", localPath: "/tmp/x.json", contentType: "application/json" })),
    });
    expect(codes(art, e)).toContain("invalid_artifacts");
    const many = candidate("xometry", {
      offers: Array.from({ length: 51 }, (_, i) => offer({ providerOptionId: `o${i}` })),
    });
    expect(codes(many, e)).toContain("too_many_offers");
  });

  it("rejects credential material and never echoes adapter values", () => {
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const c = candidate("xometry", { offers: [offer()], notes: [secret], rawPayload: { requestedQuantity: 10, storageState: "x" } });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("forbidden_content");
    expect(JSON.stringify(toAdminRejectionDiagnostic(out.rejection))).not.toContain("abcdefghijkl");
  });

  it("strips bulk DOM payload keys from accepted offers", () => {
    const c = candidate("xometry", { offers: [offer({ rawPayload: { html: "<p>x</p>", optionSelector: ".o" } })] });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.offers[0]!.rawPayload).toEqual({ optionSelector: ".o" });
  });

  it("does not mutate the candidate", () => {
    const c = candidate("xometry", { offers: [offer({ rawPayload: { html: "x" } })] });
    const before = JSON.stringify(c);
    validateProviderResult(c, e);
    expect(JSON.stringify(c)).toBe(before);
  });

  it("returns a bounded, admin visible diagnostic for multi issue rejections", () => {
    const c = candidate("xometry", {
      offers: Array.from({ length: 30 }, (_, i) => offer({ providerOptionId: `o${i}`, unitPriceUsd: -1 })),
    });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.issues.length).toBeLessThanOrEqual(20);
    expect(out.rejection.issueCount).toBeGreaterThan(20);
    const diag = toAdminRejectionDiagnostic(out.rejection);
    expect(diag).toMatchObject({ kind: "provider_result_rejected", provider: "xometry", runId: "run-1" });
  });

  it("throws on an invalid expectation rather than guessing", () => {
    expect(() => validateProviderResult(base(), { ...e, allowedDomains: [] })).toThrow(TypeError);
    expect(() => validateProviderResult(base(), { ...e, now: "bad" })).toThrow(TypeError);
  });
});

describe("failure classification", () => {
  it("maps each known code to a finite class with bounded retry", () => {
    expect(classifyProviderFailure("captcha")).toMatchObject({ failureClass: "challenge", retry: "manual_follow_up", retryBudget: 0 });
    expect(classifyProviderFailure("upload_failure")).toMatchObject({ retry: "bounded", retryBudget: 1 });
    expect(classifyProviderFailure("not_implemented").retry).toBe("none");
    expect(classifyProviderFailure("selector_failure").failureClass).toBe("portal_drift");
  });

  it("fails closed for unknown or prototype codes", () => {
    for (const code of ["totally_new", "__proto__", "constructor", ""]) {
      expect(classifyProviderFailure(code)).toMatchObject({ retry: "manual_follow_up", retryBudget: 0, adminVisible: true });
    }
  });
});

describe("OVD-569 delivered cost feed", () => {
  it("projects a validated offer with unknown fees, tax and shipping", () => {
    const out = validateProviderResult(
      candidate("xometry", { offers: [offer()], validUntil: "2026-10-30" }),
      expectation("xometry"),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const observation = toDeliveryObservation(out.value, out.value.offers[0]!);
    expect(observation.offerId).toBe("xometry-standard");
    const projection = projectDeliveredCostAndArrival(observation, {
      orderAt: NOW,
      calendar: { timeZone: "America/New_York" },
    });
    expect(JSON.stringify(projection)).toContain("unknown");
    expect(JSON.stringify(projection)).toContain("120");
  });
});
