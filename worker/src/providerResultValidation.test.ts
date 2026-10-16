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
import type { AdapterOfferInput } from "./providerResultValidation.js";
import type { LocalNativeCurrencyEvaluationResult } from "./adapters/localEvaluationResult.js";
import type { VendorName, VendorQuoteAdapterOutput } from "./types.js";
import { parseXometryOfferSnapshots } from "./adapters/xometryOffers.js";

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

/** Shape of `ProviderPortalNormalizedOffer` from the portal kernel normalizer. */
function offer(overrides: Partial<AdapterOfferInput> = {}): AdapterOfferInput {
  return {
    quantity: 10,
    validUntil: null,
    validityDurationDays: null,
    validitySource: null,
    validityTerms: null,
    artifactRefs: [],
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
    rawPayload: {
      normalizationRevision: "provider-offer-evidence.v1",
      anchoredFields: ["provider_option_id", "unit_price", "total_price"],
    },
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

  it("accepts the real Xometry offer parser output under the shared contract (OVD-381)", () => {
    const quoteUrl = "https://www.xometry.com/quoting/quote/Q-FIXTURE";
    const offers = parseXometryOfferSnapshots({
      requestedQuantity: 10,
      quoteUrl,
      snapshots: [
        {
          selector: ".price-tier",
          text: "Domestic Economy - Lead Time: 8 business days\nMade in USA\nUSD $12.00 ea.\nUSD $120.00",
          attributes: { "data-option-id": "domestic-economy" },
        },
        {
          selector: ".price-tier",
          text: "Standard - Lead Time: 10 business days\nMade Internationally\nUSD $9.00 ea.\nUSD $90.00",
          attributes: { "data-option-id": "foreign-standard" },
        },
      ],
    });
    const c = candidate("xometry", {
      offers,
      quoteUrl,
      unitPriceUsd: 9,
      totalPriceUsd: 90,
      leadTimeBusinessDays: 10,
      rawPayload: { requestedQuantity: 10, offerCount: offers.length },
    });
    const out = validateProviderResult(c, expectation("xometry"));
    expect(out.ok ? [] : out.rejection.issues).toEqual([]);
    if (!out.ok) return;
    expect(out.value.offers.map((o) => o.providerOptionId)).toEqual(["domestic-economy", "foreign-standard"]);
    expect(out.value.offers.map((o) => o.geographicOrigin)).toEqual(["domestic", "foreign"]);
    expect(out.value.provenance).toMatchObject({ provider: "xometry", runId: "run-1" });
  });

  it("accepts Fictiv total priced options", () => {
    const c = candidate("fictiv", {
      offers: [offer({ providerOptionId: "fictiv-standard", rawPayload: { currency: "USD", priceBasis: "total", cookieJar: "a1b2c3d4e5f6g7h8" } })],
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

  it("rejects the Weerg native EUR result as the adapter produces it, without converting", () => {
    const native: LocalNativeCurrencyEvaluationResult = {
      kind: "local_native_currency_evaluation",
      contractRevision: "local-native-currency-evidence.v1",
      executionContext: "live_evaluation",
      localOnly: true,
      customerOfferPersistence: false,
      providerAdmission: false,
      providerMutationPossible: false,
      vendor: "weerg",
      status: "native_offers_extracted",
      nativeOffers: [{
        providerOptionId: "standard",
        providerLabel: "Standard",
        quantity: 10,
        money: {
          currency: "EUR",
          unitAmount: 11,
          totalAmount: 110,
          provenance: {
            unitAmount: { source: "selector", selector: "[data-weerg-quote-option-unit]" },
            totalAmount: { source: "selector", selector: "[data-weerg-quote-option-total]" },
            unitCurrency: { source: "selector", selector: "[data-weerg-quote-option-currency]" },
            totalCurrency: { source: "selector", selector: "[data-weerg-quote-option-currency]" },
          },
        },
        leadTimeBusinessDays: 6,
        shipReceiveBy: null,
        tier: null,
        sourcing: null,
        geographicOrigin: "unknown",
        provenance: {
          containerSelector: "[data-weerg-quote-option]",
          providerOptionIdSource: "attribute",
          leadTimeSource: "selector",
          geographicOriginSource: "none",
        },
        validUntil: null,
        validityDurationDays: null,
        validitySource: null,
        validityTerms: null,
        artifactRefs: [],
      }],
      artifacts: [],
      manifestRevision: "m-1",
      envelopeRevision: "env-2026-10-01",
      adapterRevision: "adapter-1",
    };
    const c = candidate("weerg", {});
    c.result = native;
    const out = validateProviderResult(c, expectation("weerg"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("invalid_currency");
    expect(out.rejection.issues).toEqual([{ code: "invalid_currency", path: "result.kind" }]);
    expect(out.rejection.adminVisible).toBe(true);
  });

  it("accepts a Quickparts shaped portal result whose offers each state their own validity", () => {
    const c = candidate("quickparts", {
      offers: [
        offer({ providerOptionId: "standard", validUntil: "2026-10-20", validitySource: "vendor_date", validityTerms: "Valid until Oct 20" }),
        offer({ providerOptionId: "rush", unitPriceUsd: 20, totalPriceUsd: 200, leadTimeBusinessDays: 3, validUntil: "2026-10-14", validitySource: "vendor_date" }),
      ],
      validUntil: "2026-10-20",
    });
    const out = validateProviderResult(c, expectation("quickparts"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.offers.map((o) => o.validUntil)).toEqual(["2026-10-20", "2026-10-14"]);
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
    const inverted = candidate("xometry", {
      offers: [offer()],
      validUntil: "2026-10-12T12:01:00.000Z",
      quotedAt: "2026-10-12T12:02:00.000Z",
    });
    inverted.collectedAt = "2026-10-12T11:58:00.000Z";
    expect(codes(inverted, e)).toContain("invalid_timestamp");
    const invertedOffer = candidate("xometry", {
      offers: [offer({ validUntil: "2026-10-12T12:01:00.000Z" })],
      quotedAt: "2026-10-12T12:02:00.000Z",
    });
    invertedOffer.collectedAt = "2026-10-12T11:58:00.000Z";
    expect(codes(invertedOffer, e)).toContain("invalid_timestamp");
  });

  it("treats validUntil as inclusive at the validation instant", () => {
    expect(validateProviderResult(candidate("xometry", { offers: [offer()], validUntil: NOW }), e).ok).toBe(true);
    expect(validateProviderResult(candidate("xometry", { offers: [offer({ validUntil: NOW })] }), e).ok).toBe(true);
    expect(codes(candidate("xometry", { offers: [offer({ validUntil: "2026-10-12T11:59:59.999Z" })] }), e)).toContain("expired_validity");
  });

  it("derives an expiry from a vendor duration and rejects it once passed", () => {
    const stale = candidate("xometry", {
      offers: [offer({ validityDurationDays: 1, validitySource: "vendor_duration" })],
      quotedAt: "2026-10-10T10:00:00.000Z",
    });
    expect(codes(stale, e)).toContain("expired_validity");
    const live = candidate("xometry", {
      offers: [offer({ validityDurationDays: 3, validitySource: "vendor_duration" })],
      quotedAt: "2026-10-10T10:00:00.000Z",
    });
    expect(validateProviderResult(live, e).ok).toBe(true);
    const boundary = candidate("xometry", {
      offers: [offer({ validityDurationDays: 1, validitySource: "vendor_duration" })],
      quotedAt: "2026-10-11T12:00:00.000Z",
    });
    expect(validateProviderResult(boundary, e).ok).toBe(true);
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

  it("rejects a credential shaped note and never echoes adapter values", () => {
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const c = candidate("xometry", { offers: [offer()], notes: [secret] });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("forbidden_content");
    expect(JSON.stringify(toAdminRejectionDiagnostic(out.rejection))).not.toContain("abcdefghijkl");
  });

  it("rejects a storageState key holding a value on its own", () => {
    const c = candidate("xometry", { offers: [offer()], rawPayload: { requestedQuantity: 10, storageState: "x" } });
    expect(codes(c, e)).toEqual(["forbidden_content"]);
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

describe("review probes", () => {
  const e = expectation("quickparts");

  it("rejects an expired rush offer even when the first offer is live", () => {
    const c = candidate("quickparts", {
      offers: [
        offer({ providerOptionId: "standard", validUntil: "2026-10-20", validitySource: "vendor_date" }),
        offer({ providerOptionId: "rush", validUntil: "2026-10-11", validitySource: "vendor_date" }),
      ],
      validUntil: "2026-10-20",
    });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("expired_validity");
    expect(out.rejection.issues).toEqual([{ code: "expired_validity", path: "result.offers[1].validUntil" }]);
  });

  it("rejects inconsistent per offer validity declarations", () => {
    const dateWithoutValue = candidate("quickparts", { offers: [offer({ validitySource: "vendor_date", validUntil: null })] });
    expect(codes(dateWithoutValue, e)).toContain("invalid_timestamp");
    const badDuration = candidate("quickparts", { offers: [offer({ validityDurationDays: 0, validitySource: "vendor_duration" })] });
    expect(codes(badDuration, e)).toContain("invalid_timestamp");
  });

  it("does not let one offer inherit another offer's validity", () => {
    const c = candidate("quickparts", {
      offers: [
        offer({ providerOptionId: "a", validUntil: "2026-10-20", validitySource: "vendor_date" }),
        offer({ providerOptionId: "b" }),
      ],
      validUntil: "2026-10-20",
    });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.offers[1]!.validUntil).toBeNull();
    expect(toDeliveryObservation(out.value, out.value.offers[1]!).validUntil).toBeNull();
    expect(toDeliveryObservation(out.value, out.value.offers[0]!).validUntil).toBe("2026-10-20");
  });

  it("rejects adapter supplied extra keys instead of carrying them into the output", () => {
    const token = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const c = candidate("quickparts", { offers: [{ ...offer(), sessionToken: token } as AdapterOfferInput] });
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.issues).toEqual([{ code: "malformed_candidate", path: "result.offers[0].sessionToken" }]);
    expect(JSON.stringify(out.rejection)).not.toContain("abcdefghijkl");
  });

  it.each(["providerLabel", "tier", "sourcing", "shipReceiveBy", "quoteRef", "validityTerms"] as const)(
    "scans kept text field %s for credentials",
    (field) => {
      const c = candidate("quickparts", {
        offers: [offer({ [field]: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" })],
      });
      const out = validateProviderResult(c, e);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.rejection.issues).toContainEqual({ code: "forbidden_content", path: `result.offers[0].${field}` });
    },
  );

  it("only emits allowlisted offer keys", () => {
    const out = validateProviderResult(candidate("quickparts", { offers: [offer()] }), e);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.value.offers[0]!).sort()).toEqual([
      "artifactRefs", "currency", "derivedFromSummary", "geographicOrigin", "leadTimeBusinessDays", "provenance",
      "providerLabel", "providerOptionId", "quantity", "quoteRef", "quoteUrl", "rawPayload", "shipReceiveBy",
      "sortRank", "sourcing", "tier", "totalPriceUsd", "unitPriceUsd", "validUntil", "validityDurationDays",
      "validitySource", "validityTerms",
    ]);
  });

  it("does not treat a customer file name as an sk- credential", () => {
    const c = candidate("quickparts", {
      offers: [offer({ providerLabel: "bracket-housing-disk-0a1b2c3d4e5f6a7b8c9d.step" })],
    });
    expect(validateProviderResult(c, e).ok).toBe(true);
    const real = candidate("quickparts", { offers: [offer({ providerLabel: "key sk-abcdefghijklmnop1234" })] });
    expect(codes(real, e)).toContain("forbidden_content");
  });

  it("accepts descriptive admission and session words but rejects affirmative admission claims", () => {
    const benign = candidate("quickparts", {
      offers: [offer({ rawPayload: { providerAdmission: "required_unavailable", sessionPolicy: "required_unavailable", admitted: false } })],
      rawPayload: { requestedQuantity: 10, providerAdmission: "required_unavailable" },
    });
    expect(validateProviderResult(benign, e).ok).toBe(true);
    for (const claim of [{ admitted: true }, { providerAdmission: "admitted" }, { certified: "yes" }]) {
      const c = candidate("quickparts", { offers: [offer({ rawPayload: claim })] });
      expect(codes(c, e)).toContain("adapter_admission_claim");
    }
  });

  it("finds admission claims inside arrays and fails closed past the depth limit", () => {
    const inArray = candidate("quickparts", { offers: [offer()], rawPayload: { requestedQuantity: 10, lanes: [{ meta: { admitted: true } }] } });
    expect(codes(inArray, e)).toContain("adapter_admission_claim");
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i += 1) deep = { next: deep };
    const tooDeep = candidate("quickparts", { offers: [offer()], rawPayload: { requestedQuantity: 10, deep } });
    expect(codes(tooDeep, e)).toContain("malformed_candidate");
    expect(codes(tooDeep, e)).not.toContain("adapter_admission_claim");
  });

  it("keeps a sensitive key that holds a real value as forbidden", () => {
    const c = candidate("quickparts", { offers: [offer({ rawPayload: { sessionId: "9f8e7d6c5b4a3210" } })] });
    expect(codes(c, e)).toContain("forbidden_content");
    const empty = candidate("quickparts", { offers: [offer({ rawPayload: { sessionId: null } })] });
    expect(validateProviderResult(empty, e).ok).toBe(true);
  });
});

describe("OVD-463 follow up hardening", () => {
  const e = expectation("xometry");
  const withOffer = (o: Partial<AdapterOfferInput>) => candidate("xometry", { offers: [offer(o)] });
  const prov = (over: Record<string, unknown>) => ({ ...offer().provenance, ...over }) as AdapterOfferInput["provenance"];

  it("scans and constrains nested provenance and sortRank", () => {
    expect(codes(withOffer({ provenance: prov({ containerSelector: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" }) }), e)).toContain("forbidden_content");
    expect(codes(withOffer({ provenance: prov({ containerSelector: 7 }) }), e)).toContain("malformed_candidate");
    expect(codes(withOffer({ provenance: prov({ providerOptionIdSource: "guess" }) }), e)).toContain("untrusted_source");
    expect(codes(withOffer({ provenance: prov({ leadTimeSource: "sk-abcdefghijklmnopqrstuv" }) }), e)).toContain("untrusted_source");
    expect(codes(withOffer({ provenance: prov({ geographicOriginSource: "inferred" }) }), e)).toContain("untrusted_source");
    expect(codes(withOffer({ sortRank: 1.5 }), e)).toContain("malformed_candidate");
    expect(codes(withOffer({ sortRank: "1" as unknown as number }), e)).toContain("malformed_candidate");
    expect(validateProviderResult(withOffer({ sortRank: 3 }), e).ok).toBe(true);
  });

  it("does not exempt short lowercase secrets under a credential key", () => {
    const c = candidate("xometry", { offers: [offer({ rawPayload: { password: "correcthorsebattery" } })] });
    expect(codes(c, e)).toContain("forbidden_content");
    for (const word of ["none", "required_unavailable", "redacted", "not_applicable"]) {
      const ok = candidate("xometry", { offers: [offer({ rawPayload: { password: word } })] });
      expect(validateProviderResult(ok, e).ok).toBe(true);
    }
  });

  it("reports depth overflow as malformed, not as an admission claim", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i += 1) deep = { next: deep };
    const out = validateProviderResult(candidate("xometry", { offers: [offer({ rawPayload: { deep } })] }), e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.issues.map((i) => i.code)).toContain("malformed_candidate");
    expect(out.rejection.issues.map((i) => i.code)).not.toContain("adapter_admission_claim");
  });

  it("scans quoteUrl query string and fragment for credentials", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc";
    for (const url of [
      `https://www.xometry.com/q/1?access_token=${jwt}`,
      `https://www.xometry.com/q/1?ref=${jwt}`,
      "https://www.xometry.com/q/1?token=abc",
      "https://www.xometry.com/q/1?sig=abc",
      `https://www.xometry.com/q/1#access_token=${jwt}`,
      "https://www.xometry.com/q/1#password=hunter2",
    ]) {
      expect(codes(withOffer({ quoteUrl: url }), e), url).toContain("invalid_destination");
      expect(codes(candidate("xometry", { offers: [offer()], quoteUrl: url }), e), url).toContain("invalid_destination");
    }
    expect(validateProviderResult(withOffer({ quoteUrl: "https://www.xometry.com/q/1?quote=42&utm_source=mail#details" }), e).ok).toBe(true);
  });

  it("credential scans binding.adapterRevision", () => {
    const c = candidate("xometry", { offers: [offer()] });
    c.binding.adapterRevision = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const out = validateProviderResult(c, e);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.rejection.code).toBe("forbidden_content");
  });

  it("checks simulated markers on offer rawPayload", () => {
    for (const rawPayload of [{ mode: "simulate" }, { detectedFlow: "simulate" }, { source: "simulated_portal" }]) {
      const out = validateProviderResult(withOffer({ rawPayload }), e);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.rejection.code).toBe("simulated_result");
    }
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
  it("projects a validated offer with confirmed parts and unknown fees, tax and shipping", () => {
    const out = validateProviderResult(
      candidate("xometry", {
        offers: [offer({ validUntil: "2026-10-30", validitySource: "vendor_date" })],
      }),
      expectation("xometry"),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const observation = toDeliveryObservation(out.value, out.value.offers[0]!);
    expect(observation).toEqual({
      offerId: "xometry-standard",
      provider: "xometry",
      partsSubtotalUsd: 120,
      feesUsd: null,
      taxUsd: null,
      shippingOptions: [],
      leadTime: { kind: "business_days", businessDays: 8 },
      orderCutoffLocalTime: null,
      validUntil: "2026-10-30",
      invalidatedAt: null,
    });
    const projection = projectDeliveredCostAndArrival(observation, {
      orderAt: NOW,
      calendar: { timeZone: "America/New_York" },
    });
    expect(projection.validityAtOrder).toEqual({ status: "valid", validUntil: "2026-10-30" });
    const { components, total } = projection.scenarios[0]!.cost;
    expect(components.parts).toEqual({ provenance: "confirmed", amountUsd: 120 });
    expect(components.fees).toEqual({ provenance: "unknown", amountUsd: null });
    expect(components.tax).toEqual({ provenance: "unknown", amountUsd: null });
    expect(components.shipping).toEqual({ provenance: "unknown", amountUsd: null });
    expect(total.amountUsd).toBeNull();
    expect(total.knownAmountUsd).toBe(120);
    expect([...total.unknownComponents].sort()).toEqual(["fees", "shipping", "tax"]);
  });
});
