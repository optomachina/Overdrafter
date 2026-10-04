import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_WORKSPACE_FIXTURE_SCENARIOS,
  getActiveClientWorkspaceGateway,
  resetClientWorkspaceFixtureStateForTests,
} from "@/features/quotes/client-workspace-fixtures";
import {
  buildClientQuoteSelectionResult,
  filterQuoteOptionsForScope,
} from "@/features/quotes/selection";
import {
  buildClientQuoteComparisonOptions,
  buildClientSourcingResult,
} from "@/features/quotes/sourcing-result";
import type { PartDetailAggregate } from "@/features/quotes/types";

const NOW = new Date("2026-10-04T15:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPARISON_JOB_ID = "fx-job-comparison";
const DOMESTIC_VARIANT_IDS = [
  "fx-offer-comparison-xometry-economy",
  "fx-offer-comparison-xometry-standard",
  "fx-offer-comparison-xometry-expedite",
];
const FOREIGN_ID = "fx-offer-comparison-xometry-overseas";
const NO_ORIGIN_ID = "fx-offer-comparison-xometry-network";
const NO_LEAD_TIME_ID = "fx-offer-comparison-xometry-custom-finish";
const EXPIRED_ID = "fx-offer-comparison-xometry-lapsed";
const STALE_ID = "fx-offer-comparison-xometry-archived";
const UNCERTIFIED_PROVIDER_ID = "fx-offer-comparison-fictiv-global";

async function loadComparisonPartDetail(): Promise<PartDetailAggregate> {
  window.history.replaceState({}, "", "/parts/fx-job-comparison?fixture=client-comparison");
  const gateway = getActiveClientWorkspaceGateway();
  expect(gateway).not.toBeNull();
  return gateway!.fetchPartDetail(COMPARISON_JOB_ID);
}

function buildComparisonPipeline(detail: PartDetailAggregate, now: Date) {
  const part = detail.part;
  expect(part).not.toBeNull();
  const { options } = buildClientQuoteSelectionResult({
    vendorQuotes: part!.vendorQuotes,
    requestedByDate: detail.job.requested_by_date,
    now,
  });
  const sourcingResult = buildClientSourcingResult({
    part: part!,
    profiles: [],
    liveOffers: options.map((option) => ({ ...option, offerKey: option.key })),
    automaticCollectionEnabled: true,
    now,
  });
  const liveOfferKeys = sourcingResult.outcome === "live_offers_available"
    ? sourcingResult.liveOfferKeys
    : [];

  return {
    options,
    liveOfferKeys,
    comparison: buildClientQuoteComparisonOptions({
      candidates: options,
      liveOfferKeys: new Set(liveOfferKeys),
      publishedOptions: [],
      requestedByDate: detail.job.requested_by_date,
    }),
  };
}

describe("client-comparison fixture scenario", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("VITE_ENABLE_FIXTURE_MODE", "1");
  });

  afterEach(() => {
    resetClientWorkspaceFixtureStateForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  });

  it("adds a part-route scenario after the existing scenarios", () => {
    expect(CLIENT_WORKSPACE_FIXTURE_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "landing-anonymous",
      "client-empty",
      "client-needs-attention",
      "client-quoted",
      "client-published",
      "client-comparison",
    ]);
    const scenario = CLIENT_WORKSPACE_FIXTURE_SCENARIOS.find(
      (candidate) => candidate.id === "client-comparison",
    );
    expect(scenario?.canonicalPath).toBe("/parts/fx-job-comparison?fixture=client-comparison");
  });

  it("models each comparison condition with explicit offer facts and HTTPS vendor URLs", async () => {
    const detail = await loadComparisonPartDetail();
    const quotes = detail.part?.vendorQuotes ?? [];
    const offers = quotes.flatMap((quote) => quote.offers.map((offer) => ({ quote, offer })));
    const byId = new Map(offers.map((entry) => [entry.offer.id, entry]));

    expect(offers).toHaveLength(9);
    expect(quotes.every((quote) => quote.quote_url?.startsWith("https://"))).toBe(true);

    const variantResultIds = new Set(
      DOMESTIC_VARIANT_IDS.map((id) => byId.get(id)?.quote.id),
    );
    expect(variantResultIds).toEqual(new Set(["fx-quote-comparison-xometry-us"]));
    for (const id of DOMESTIC_VARIANT_IDS) {
      expect(byId.get(id)?.quote.vendor).toBe("xometry");
      expect(byId.get(id)?.offer.geographic_origin).toBe("domestic");
    }

    expect(byId.get(FOREIGN_ID)?.offer.geographic_origin).toBe("foreign");
    expect(byId.get(NO_ORIGIN_ID)?.offer).not.toHaveProperty("geographic_origin");
    expect(byId.get(NO_LEAD_TIME_ID)?.offer.lead_time_business_days).toBeNull();
    expect(byId.get(UNCERTIFIED_PROVIDER_ID)?.quote.vendor).toBe("fictiv");
    expect(byId.get(UNCERTIFIED_PROVIDER_ID)?.offer.geographic_origin).toBe("foreign");

    const staleQuoteDate = byId.get(STALE_ID)?.offer.quote_date ?? "";
    expect(NOW.getTime() - Date.parse(staleQuoteDate)).toBeGreaterThan(14 * DAY_MS);
    expect(Date.parse(byId.get(EXPIRED_ID)?.offer.valid_until ?? "")).toBeLessThan(NOW.getTime());
    expect(detail.job.selected_vendor_quote_offer_id).toBe(DOMESTIC_VARIANT_IDS[0]);
  });

  it("admits every offer as live except the stale and uncertified-provider offers", async () => {
    const detail = await loadComparisonPartDetail();
    const { liveOfferKeys, comparison } = buildComparisonPipeline(detail, NOW);

    expect([...liveOfferKeys].sort()).toEqual(
      [...DOMESTIC_VARIANT_IDS, FOREIGN_ID, NO_ORIGIN_ID, NO_LEAD_TIME_ID, EXPIRED_ID].sort(),
    );
    expect(comparison.map((option) => option.key)).not.toContain(STALE_ID);
    expect(comparison.map((option) => option.key)).not.toContain(UNCERTIFIED_PROVIDER_ID);
  });

  it("fails the stale offer only on the 14-day window", async () => {
    const detail = await loadComparisonPartDetail();
    const staleQuoteDate = detail.part?.vendorQuotes
      .flatMap((quote) => quote.offers)
      .find((offer) => offer.id === STALE_ID)?.quote_date;
    expect(staleQuoteDate).toBeTruthy();

    // Evaluated one day after its quote date, the same offer passes every live rule.
    const { liveOfferKeys } = buildComparisonPipeline(
      detail,
      new Date(Date.parse(staleQuoteDate!) + DAY_MS),
    );
    expect(liveOfferKeys).toContain(STALE_ID);
  });

  it("blocks selection only for the expired offer and keeps unknown origin out of US-only", async () => {
    const detail = await loadComparisonPartDetail();
    const { comparison } = buildComparisonPipeline(detail, NOW);

    expect(
      comparison.filter((option) => !option.isSelectable).map((option) => option.key),
    ).toEqual([EXPIRED_ID]);
    expect(
      comparison.find((option) => option.key === NO_ORIGIN_ID)?.geographicOrigin,
    ).toBe("unknown");
    expect(
      filterQuoteOptionsForScope(comparison, "domestic").map((option) => option.key).sort(),
    ).toEqual([...DOMESTIC_VARIANT_IDS].sort());
    expect(filterQuoteOptionsForScope(comparison, "global")).toHaveLength(7);
  });
});
