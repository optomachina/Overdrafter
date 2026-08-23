// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseXometryOfferSnapshots,
  selectCompatibilityOffer,
} from "./xometryOffers.js";

const quoteUrl = "https://www.xometry.com/quoting/quote/Q05-1358-0164";

describe("Xometry multi-offer normalization", () => {
  it("preserves domestic, foreign, and unknown variants independently", () => {
    const offers = parseXometryOfferSnapshots({
      requestedQuantity: 2,
      quoteUrl,
      snapshots: [
        {
          selector: ".price-tier",
          text: "Domestic Economy - Lead Time: 8 business days\nMade in USA\n$60.00 ea.\n$120.00\n$150.00\nArrives by Aug 31, 2026",
          attributes: { "data-option-id": "domestic-economy" },
        },
        {
          selector: '[data-testid="tierAndLeadTime"]',
          text: "Standard\nMade Internationally Except China\n$95.00\n12 working days",
          attributes: { "data-option-id": "global-standard" },
        },
        {
          selector: '[data-testid="tierAndLeadTime"]',
          text: "Expedited\n$175.50\n4 business days",
          attributes: { "data-option-id": "expedited" },
        },
      ],
    });

    expect(offers).toHaveLength(3);
    expect(offers.map((offer) => offer.geographicOrigin)).toEqual([
      "domestic",
      "foreign",
      "unknown",
    ]);
    expect(offers[0]).toMatchObject({
      providerOptionId: "domestic-economy",
      providerLabel: "Domestic Economy",
      quoteRef: "Q05-1358-0164",
      totalPriceUsd: 120,
      unitPriceUsd: 60,
      leadTimeBusinessDays: 8,
      shipReceiveBy: "Aug 31, 2026",
      tier: "Domestic Economy",
      sortRank: 0,
      provenance: {
        providerOptionIdSource: "attribute",
        priceSource: "selector",
        geographicOriginSource: "provider_text",
      },
    });
    expect(offers[2]?.provenance.geographicOriginSource).toBe("none");
    expect(offers[1]?.sourcing).toBe("Made Internationally Except China");
  });

  it("normalizes an arrival-only price tier without treating the crossed-out price as current", () => {
    const [offer] = parseXometryOfferSnapshots({
      requestedQuantity: 2,
      quoteUrl,
      snapshots: [{
        selector: ".price-tier",
        text: "Standard\nArrives by Sep 2\n$172.83 ea.\n$345.66\n$475.72\nSave $130.06",
        attributes: {},
      }],
    });

    expect(offer).toMatchObject({
      providerLabel: "Standard",
      totalPriceUsd: 345.66,
      unitPriceUsd: 172.83,
      leadTimeBusinessDays: null,
      shipReceiveBy: "Sep 2",
      geographicOrigin: "unknown",
    });
  });

  it("derives fallback identifiers from tier text instead of shared badges", () => {
    const offers = parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [
        {
          selector: ".price-tier",
          text: "Least Expensive\nMade in USA\nDomestic Economy - Lead Time: 8 business days\n$100.00 ea.\n$100.00",
          tierText: "Domestic Economy - Lead Time: 8 business days",
          attributes: {},
        },
        {
          selector: ".price-tier",
          text: "Made in USA\nStandard - Lead Time: 5 business days\n$125.00 ea.\n$125.00",
          tierText: "Standard - Lead Time: 5 business days",
          attributes: {},
        },
      ],
    });

    expect(offers.map((offer) => offer.providerOptionId)).toEqual([
      "domestic-economy",
      "domestic-standard",
    ]);
    expect(offers.map((offer) => offer.providerLabel)).toEqual([
      "Domestic Economy",
      "Standard",
    ]);
  });

  it("keeps domestic and international variants distinct when their tier names match", () => {
    const offers = parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [
        {
          selector: ".price-tier",
          text: "Standard - Lead Time: 5 business days\nMade in USA\n$125.00 ea.\n$125.00",
          attributes: {},
        },
        {
          selector: ".price-tier",
          text: "Standard - Lead Time: 8 business days\nMade Internationally Except China\n$100.00 ea.\n$100.00",
          attributes: {},
        },
      ],
    });

    expect(offers.map((offer) => offer.providerOptionId)).toEqual([
      "domestic-standard",
      "foreign-standard",
    ]);
  });

  it("fails closed rather than using a presentation badge as a fallback identifier", () => {
    expect(() => parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [
        {
          selector: ".price-tier",
          text: "Least Expensive\nMade in USA\nArrives by Sep 2\n$100.00 ea.\n$100.00",
          attributes: {},
        },
        {
          selector: ".price-tier",
          text: "Least Expensive\nMade Internationally\nArrives by Sep 5\n$90.00 ea.\n$90.00",
          attributes: {},
        },
      ],
    })).toThrow("did not expose a stable manufacturing tier");
  });

  it("rejects a hyphenated presentation badge as a manufacturing tier", () => {
    expect(() => parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [
        {
          selector: ".price-tier",
          text: "Least Expensive - Lead Time: 5 business days\nMade in USA\n$100.00 ea.\n$100.00",
          attributes: {},
        },
        {
          selector: ".price-tier",
          text: "Least Expensive - Lead Time: 8 business days\nMade Internationally\n$90.00 ea.\n$90.00",
          attributes: {},
        },
      ],
    })).toThrow("did not expose a stable manufacturing tier");
  });

  it("fails closed when a discovered option has no anchored price", () => {
    expect(() => parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [{
        selector: '[data-testid="tierAndLeadTime"]',
        text: "Standard\n7 business days",
        attributes: { "data-option-id": "standard" },
      }],
    })).toThrow("did not expose an anchored price");
  });

  it("skips a tier that Xometry explicitly marks unavailable", () => {
    const offers = parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [
        {
          selector: ".price-tier",
          text: "Fastest\nUnavailable for this configuration",
          attributes: { "aria-disabled": "true" },
        },
        {
          selector: ".price-tier",
          text: "Standard\nArrives by Sep 2\n$120.00 ea.\n$120.00",
          attributes: {},
        },
      ],
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]?.providerLabel).toBe("Standard");
    expect(offers[0]?.sortRank).toBe(0);
  });

  it("fails closed when multiple prices have no unit or total relationship", () => {
    expect(() => parseXometryOfferSnapshots({
      requestedQuantity: 2,
      quoteUrl,
      snapshots: [{
        selector: ".price-tier",
        text: "Standard\n$100.00\n$120.00\n7 business days",
        attributes: { "data-option-id": "standard" },
      }],
    })).toThrow("did not expose an anchored price");
  });

  it("fails closed when a priced option has neither lead nor arrival evidence", () => {
    expect(() => parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [{
        selector: '[data-testid="tierAndLeadTime"]',
        text: "Standard $100.00",
        attributes: { "data-option-id": "standard" },
      }],
    })).toThrow("did not expose an anchored lead or arrival time");
  });

  it("returns an empty set when no supported option container is present", () => {
    expect(parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [],
    })).toEqual([]);
  });

  it("rejects duplicate provider identifiers instead of dropping a variant", () => {
    expect(() => parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [
        {
          selector: "button",
          text: "Standard $100.00 7 business days",
          attributes: { "data-option-id": "standard" },
        },
        {
          selector: "button",
          text: "Standard $110.00 5 business days",
          attributes: { "data-option-id": "standard" },
        },
      ],
    })).toThrow("duplicate provider option identifiers");
  });

  it("uses a deterministic lowest-total compatibility summary", () => {
    const offers = parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [
        { selector: "button", text: "Expedited $140.00 3 business days", attributes: { id: "expedited" } },
        { selector: "button", text: "Economy $90.00 12 business days", attributes: { id: "economy" } },
      ],
    });

    expect(selectCompatibilityOffer(offers)?.providerOptionId).toBe("economy");
  });
});
