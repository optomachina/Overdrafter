// @vitest-environment node

import { describe, expect, it } from "vitest";
import { VendorAutomationError } from "../types.js";
import { evaluateProviderAdapterFailureContract } from "./providerAdapterContract.js";
import { readFileSync } from "node:fs";
import {
  FILE_NAME_TEXT,
  parseXometryOfferSnapshots,
  selectCompatibilityOffer,
  type XometryOfferSnapshot,
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
          text: "Domestic Economy - Lead Time: 8 business days\nMade in USA\nUSD $60.00 ea.\nUSD $120.00\nUSD $150.00\nArrives by Aug 31, 2026",
          attributes: { "data-option-id": "domestic-economy" },
        },
        {
          selector: '[data-testid="tierAndLeadTime"]',
          text: "Standard\nMade Internationally Except China\nUSD $47.50 ea.\nUSD $95.00\n12 working days",
          attributes: { "data-option-id": "global-standard" },
        },
        {
          selector: '[data-testid="tierAndLeadTime"]',
          text: "Expedited\nUSD $87.75 ea.\nUSD $175.50\n4 business days",
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
        text: "Standard\nArrives by Sep 2\nUSD $172.83 ea.\nUSD $345.66\nUSD $475.72\nSave USD $130.06",
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
          text: "Least Expensive\nMade in USA\nDomestic Economy - Lead Time: 8 business days\nUSD $100.00 ea.\nUSD $100.00",
          tierText: "Domestic Economy - Lead Time: 8 business days",
          attributes: {},
        },
        {
          selector: ".price-tier",
          text: "Made in USA\nStandard - Lead Time: 5 business days\nUSD $125.00 ea.\nUSD $125.00",
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
          text: "Standard - Lead Time: 5 business days\nMade in USA\nUSD $125.00 ea.\nUSD $125.00",
          attributes: {},
        },
        {
          selector: ".price-tier",
          text: "Standard - Lead Time: 8 business days\nMade Internationally Except China\nUSD $100.00 ea.\nUSD $100.00",
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
          text: "Least Expensive\nMade in USA\nArrives by Sep 2\nUSD $100.00 ea.\nUSD $100.00",
          attributes: {},
        },
        {
          selector: ".price-tier",
          text: "Least Expensive\nMade Internationally\nArrives by Sep 5\nUSD $90.00 ea.\nUSD $90.00",
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
          text: "Least Expensive - Lead Time: 5 business days\nMade in USA\nUSD $100.00 ea.\nUSD $100.00",
          attributes: {},
        },
        {
          selector: ".price-tier",
          text: "Least Expensive - Lead Time: 8 business days\nMade Internationally\nUSD $90.00 ea.\nUSD $90.00",
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
          text: "Standard\nArrives by Sep 2\nUSD $120.00 ea.\nUSD $120.00",
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
        text: "Standard\nUSD $100.00\nUSD $120.00\n7 business days",
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
        text: "Standard USD $100.00",
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
          text: "Standard USD $100.00 7 business days",
          attributes: { "data-option-id": "standard" },
        },
        {
          selector: "button",
          text: "Standard USD $110.00 5 business days",
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
        { selector: "button", text: "Expedited USD $140.00 3 business days", attributes: { id: "expedited" } },
        { selector: "button", text: "Economy USD $90.00 12 business days", attributes: { id: "economy" } },
      ],
    });

    expect(selectCompatibilityOffer(offers)?.providerOptionId).toBe("economy");
  });

  // OVD-776: tier text shaped like the T1 quote page. Prices carry an explicit
  // USD marker because bare "$" amounts are not trusted on main (OVD-778).
  const t1Tier = (each: string, total: string, list: string, save: string) =>
    `Least Expensive\nArrives by Nov 6\nUSD $${each} ea.\nUSD $${total}\nUSD $${list} (Save USD $${save})`;

  it("accepts a qty-1 tier whose total equals its each price", () => {
    const [offer] = parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [{ selector: ".price-tier", text: t1Tier("41.41", "41.41", "53.96", "12.55"), attributes: {} }],
    });

    expect(offer).toMatchObject({ unitPriceUsd: 41.41, totalPriceUsd: 41.41 });
  });

  it("accepts a multi-piece total within per-piece cent rounding", () => {
    const [offer] = parseXometryOfferSnapshots({
      requestedQuantity: 10,
      quoteUrl,
      snapshots: [{ selector: ".price-tier", text: t1Tier("41.41", "414.15", "539.62", "125.47"), attributes: {} }],
    });

    expect(offer).toMatchObject({ unitPriceUsd: 41.41, totalPriceUsd: 414.15 });
  });

  it("refuses the T1 ten-piece price ($41.41 ea. / $414.15) for a qty-1 request", () => {
    let failure: unknown;
    try {
      parseXometryOfferSnapshots({
        requestedQuantity: 1,
        quoteUrl,
        snapshots: [{ selector: ".price-tier", text: t1Tier("41.41", "414.15", "539.62", "125.47"), attributes: {} }],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(VendorAutomationError);
    expect((failure as VendorAutomationError).payload).toMatchObject({
      reason: "quantity_mismatch",
      requestedQuantity: 1,
      observedQuantity: 10,
      observedUnitPriceUsd: 41.41,
      observedTotalPriceUsd: 414.15,
    });
  });

  it("refuses a tier that states a different quantity", () => {
    expect(() => parseXometryOfferSnapshots({
      requestedQuantity: 1,
      quoteUrl,
      snapshots: [{ selector: ".price-tier", text: "Standard\nQty: 10\nUSD $414.15\n5 business days", attributes: {} }],
    })).toThrow(expect.objectContaining({ payload: expect.objectContaining({ reason: "quantity_mismatch", observedQuantity: 10 }) }));
  });

  it("refuses a lone multi-piece price that does not show which quantity it covers", () => {
    expect(() => parseXometryOfferSnapshots({
      requestedQuantity: 2,
      quoteUrl,
      snapshots: [{ selector: ".price-tier", text: "Standard\nUSD $120.00\n5 business days", attributes: {} }],
    })).toThrow(expect.objectContaining({ payload: expect.objectContaining({ reason: "quantity_unverified" }) }));
  });

  // OVD-1052: the quote page observed 2026-10-23 (synthetic values). Each
  // card names its tier in a header slot before the tierAndLeadTime label,
  // which now holds only the arrival date; the struck-through list total and
  // its "(Save $X)" note follow the current total. The leading no-break space
  // is the icon gap Xometry renders before the tier name.
  const currentCard = (input: {
    name: string;
    arrives: string;
    each: string;
    total: string;
    list: string;
    save: string;
  }): XometryOfferSnapshot => ({
    selector: ".price-tier",
    text: `\u00a0${input.name}\nArrives by ${input.arrives}\n$${input.each} ea.\n$${input.total}\n$${input.list} (Save $${input.save})`,
    tierText: `Arrives by ${input.arrives}`,
    attributes: {},
  });
  const currentPanel = () => [
    currentCard({ name: "Least Expensive", arrives: "Nov 3", each: "101.25", total: "101.25", list: "146.80", save: "45.55" }),
    currentCard({ name: "Standard", arrives: "Nov 6", each: "106.40", total: "106.40", list: "139.95", save: "33.55" }),
    currentCard({ name: "Fastest", arrives: "Oct 30", each: "117.10", total: "117.10", list: "171.85", save: "54.75" }),
  ];
  const failureOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected the parse to fail closed");
  };

  describe("OVD-1052 current price panel", () => {
    it("turns every tier card into an offer named by its header slot", () => {
      const offers = parseXometryOfferSnapshots({ requestedQuantity: 1, quoteUrl, snapshots: currentPanel() });

      expect(offers.map((offer) => ({
        id: offer.providerOptionId,
        label: offer.providerLabel,
        tier: offer.tier,
        unit: offer.unitPriceUsd,
        total: offer.totalPriceUsd,
        arrives: offer.shipReceiveBy,
        lead: offer.leadTimeBusinessDays,
        rank: offer.sortRank,
      }))).toEqual([
        { id: "least-expensive", label: "Least Expensive", tier: "Least Expensive", unit: 101.25, total: 101.25, arrives: "Nov 3", lead: null, rank: 0 },
        { id: "standard", label: "Standard", tier: "Standard", unit: 106.4, total: 106.4, arrives: "Nov 6", lead: null, rank: 1 },
        { id: "fastest", label: "Fastest", tier: "Fastest", unit: 117.1, total: 117.1, arrives: "Oct 30", lead: null, rank: 2 },
      ]);
      expect(offers.every((offer) => offer.geographicOrigin === "unknown")).toBe(true);
      expect(offers.every((offer) => offer.provenance.leadTimeSource === "none")).toBe(true);
      expect(selectCompatibilityOffer(offers)?.providerOptionId).toBe("least-expensive");
    });

    it("prices each card at the discounted total, never the struck-through list total", () => {
      const offers = parseXometryOfferSnapshots({ requestedQuantity: 1, quoteUrl, snapshots: currentPanel() });

      expect(offers.map((offer) => offer.totalPriceUsd)).toEqual([101.25, 106.4, 117.1]);
      expect(offers.map((offer) => offer.totalPriceUsd)).not.toContain(146.8);
    });

    it("keeps the discounted total when the list total renders before it", () => {
      const [offer] = parseXometryOfferSnapshots({
        requestedQuantity: 1,
        quoteUrl,
        snapshots: [{
          selector: ".price-tier",
          text: "\u00a0Standard\nArrives by Nov 6\n$106.40 ea.\n$139.95 (Save $33.55)\n$106.40",
          tierText: "Arrives by Nov 6",
          attributes: {},
        }],
      });

      expect(offer).toMatchObject({ unitPriceUsd: 106.4, totalPriceUsd: 106.4 });
    });

    describe("list total and savings note", () => {
      const standardCard = (amounts: string, listPriceText?: string): XometryOfferSnapshot => ({
        selector: ".price-tier",
        text: `\u00a0Standard\nArrives by Nov 6\n${amounts}`,
        tierText: "Arrives by Nov 6",
        ...(listPriceText === undefined ? {} : { listPriceText }),
        attributes: {},
      });
      const parseOne = (snapshot: XometryOfferSnapshot, requestedQuantity = 1) =>
        parseXometryOfferSnapshots({ requestedQuantity, quoteUrl, snapshots: [snapshot] })[0];
      const unreconciled = (discountFailure: string) => ({
        code: "selector_failure",
        payload: {
          reason: "xometry_offer_discount_unreconciled",
          terminalState: "selector_drift",
          discountFailure,
        },
      });

      it("prices at the current total when the note follows the list total", () => {
        expect(parseOne(standardCard("$101.25\n$146.80 (Save $45.55)")))
          .toMatchObject({ unitPriceUsd: 101.25, totalPriceUsd: 101.25 });
        expect(parseOne(standardCard("$146.80 (Save $45.55)\n$101.25")))
          .toMatchObject({ unitPriceUsd: 101.25, totalPriceUsd: 101.25 });
      });

      it("prices at the current total when the note follows the current total", () => {
        expect(parseOne(standardCard("$146.80\n$101.25 (Save $45.55)")))
          .toMatchObject({ unitPriceUsd: 101.25, totalPriceUsd: 101.25 });
        expect(parseOne(standardCard("$101.25 ea.\n$146.80\n$101.25 (Save $45.55)")))
          .toMatchObject({ unitPriceUsd: 101.25, totalPriceUsd: 101.25 });
      });

      it("fails closed when no shown amount is the list total minus the savings", () => {
        for (const amounts of [
          "$101.25\n$146.80 (Save $40.00)",
          "$146.80\n$101.25 (Save $40.00)",
          "$101.25 (Save $45.55)",
        ]) {
          const failure = failureOf(() => parseOne(standardCard(amounts)));

          expect(failure).toMatchObject(unreconciled("list_price_unreconciled"));
          expect(evaluateProviderAdapterFailureContract(failure))
            .toMatchObject({ ok: true, terminalState: "selector_drift", violations: [] });
        }
      });

      it("fails closed when two amounts could each be the list total", () => {
        const failure = failureOf(() => parseOne(standardCard("$50.00 ea.\n$100.00\n$150.00 (Save $50.00)"), 2));

        expect(failure).toMatchObject(unreconciled("list_price_ambiguous"));
      });

      it("fails closed when a card carries two different savings figures", () => {
        const failure = failureOf(() => parseOne(standardCard("$101.25\n$146.80 (Save $45.55)\nYou save $40.00")));

        expect(failure).toMatchObject(unreconciled("savings_ambiguous"));
      });

      it("fails closed when the parsed total is not the list total minus the savings", () => {
        // $146.80 - $45.55 = $101.25 only matches the each price; the $1,012.50
        // total the card would otherwise publish does not reconcile.
        const failure = failureOf(() => parseOne(standardCard("$101.25 ea.\n$1,012.50\n$146.80 (Save $45.55)\n10 pcs"), 10));

        expect(failure).toMatchObject(unreconciled("current_total_mismatch"));
      });

      it("takes the list total from the captured part-discount slot", () => {
        // Captured structure: <div data-testid="part-discount"><span>$146.80</span> (Save $45.55)</div>.
        expect(parseOne(standardCard("$101.25 ea.\n$101.25\n$146.80 (Save $45.55)", "$146.80")))
          .toMatchObject({ unitPriceUsd: 101.25, totalPriceUsd: 101.25 });
        expect(parseOne(standardCard("$146.80\n$101.25 (Save $45.55)", "$146.80")))
          .toMatchObject({ unitPriceUsd: 101.25, totalPriceUsd: 101.25 });
        // Arithmetic alone is ambiguous here; the slot settles it.
        expect(parseOne(standardCard("$50.00 ea.\n$100.00\n$150.00 (Save $50.00)", "$150.00"), 2))
          .toMatchObject({ unitPriceUsd: 50, totalPriceUsd: 100 });
      });

      it("fails closed when the part-discount slot disagrees with the amounts", () => {
        for (const [amounts, listPriceText] of [
          // The slot names the current total as the list total.
          ["$101.25 ea.\n$101.25\n$146.80 (Save $45.55)", "$101.25"],
          // The slot names an amount the card does not show.
          ["$101.25 ea.\n$101.25\n$146.80 (Save $45.55)", "$150.00"],
          // The slot holds two amounts, or none.
          ["$101.25 ea.\n$101.25\n$146.80 (Save $45.55)", "$146.80\n$101.25"],
          ["$101.25 ea.\n$101.25\n$146.80 (Save $45.55)", "List price"],
          // The slot shows a list total but the card has no savings note.
          ["$101.25 ea.\n$101.25\n$146.80", "$146.80"],
        ]) {
          const failure = failureOf(() => parseOne(standardCard(amounts, listPriceText)));

          expect(failure).toMatchObject(unreconciled("list_price_unreconciled"));
        }
      });
    });

    it("fails closed instead of pricing at the list total when the current total is missing", () => {
      const failure = failureOf(() => parseXometryOfferSnapshots({
        requestedQuantity: 1,
        quoteUrl,
        snapshots: [{
          selector: ".price-tier",
          text: "\u00a0Standard\nArrives by Nov 6\n$106.40 ea.\n$139.95 (Save $33.55)",
          tierText: "Arrives by Nov 6",
          attributes: {},
        }],
      }));

      expect(failure).toMatchObject({
        code: "selector_failure",
        payload: { reason: "xometry_offer_price_missing", terminalState: "selector_drift" },
      });
    });

    it("fails closed when two cards carry the same header name", () => {
      const [cheapest, standard] = currentPanel();
      const failure = failureOf(() => parseXometryOfferSnapshots({
        requestedQuantity: 1,
        quoteUrl,
        snapshots: [cheapest, { ...standard, text: standard.text.replace("Standard", "Least Expensive") }],
      }));

      expect(failure).toMatchObject({
        code: "selector_failure",
        payload: { reason: "xometry_offer_tier_missing", terminalState: "selector_drift" },
      });
    });

    it("does not take a sourcing statement or a multi-line header as the tier name", () => {
      const [cheapest, , fastest] = currentPanel();
      for (const header of ["Made in USA", "Least Expensive\nNew"]) {
        const failure = failureOf(() => parseXometryOfferSnapshots({
          requestedQuantity: 1,
          quoteUrl,
          snapshots: [{ ...cheapest, text: cheapest.text.replace("Least Expensive", header) }, fastest],
        }));

        expect(failure).toMatchObject({ payload: { reason: "xometry_offer_tier_missing" } });
      }
    });

    it("takes only an exact tier name from the header line, never a badge rendered beside it", () => {
      const [cheapest, standard, fastest] = currentPanel();
      for (const [card, header] of [
        [standard, "StandardPopular"],
        [standard, "Standard Recommended"],
        [fastest, "Fastest Recommended"],
        [cheapest, "Best Value Least Expensive"],
      ] as const) {
        const name = /^\u00a0([^\n]+)/.exec(card.text)?.[1] ?? "";
        const failure = failureOf(() => parseXometryOfferSnapshots({
          requestedQuantity: 1,
          quoteUrl,
          snapshots: [{ ...card, text: card.text.replace(name, header) }],
        }));

        expect(failure).toMatchObject({
          code: "selector_failure",
          payload: { reason: "xometry_offer_tier_missing", terminalState: "selector_drift" },
        });
      }
      // The exact names, in any case, still name their tiers.
      expect(parseXometryOfferSnapshots({
        requestedQuantity: 1,
        quoteUrl,
        snapshots: [{ ...standard, text: standard.text.replace("Standard", "STANDARD") }],
      }).map((offer) => offer.providerLabel)).toEqual(["STANDARD"]);
    });

    it("names a current-layout card only from its one header line, never from another line or a lone-card fallback", () => {
      const [cheapest, standard, fastest] = currentPanel();
      for (const [card, text] of [
        // A block badge or a second line in the header slot.
        [fastest, fastest.text.replace(" Fastest", "Rush\n Fastest")],
        [fastest, fastest.text.replace(" Fastest", " Fastest\nPriority")],
        [cheapest, cheapest.text.replace(" Least Expensive", "Best Value\n Least Expensive\nEconomy production")],
        [standard, standard.text.replace(" Standard", "Recommended\n Standard")],
      ] as const) {
        for (const snapshots of [[{ ...card, text }], [{ ...card, text }, card === fastest ? cheapest : fastest]]) {
          const failure = failureOf(() => parseXometryOfferSnapshots({ requestedQuantity: 1, quoteUrl, snapshots }));

          expect(failure).toMatchObject({
            code: "selector_failure",
            payload: { reason: "xometry_offer_tier_missing", terminalState: "selector_drift", optionIndex: 0 },
          });
        }
      }
    });

    it("refuses a current-layout card line that is not its tier, its timing or a price line", () => {
      const [cheapest, standard] = currentPanel();
      for (const [card, line] of [
        [cheapest, "Ground shipping - Arrives by Nov 3"],
        [standard, "Expedited shipping included"],
        [standard, "Fetching new price..."],
        [cheapest, "Arrives by Nov 3"],
      ] as const) {
        const failure = failureOf(() => parseXometryOfferSnapshots({
          requestedQuantity: 1,
          quoteUrl,
          snapshots: [{ ...card, text: `${card.text}\n${line}` }],
        }));

        expect(failure).toMatchObject({
          code: "selector_failure",
          payload: { reason: "xometry_offer_line_unrecognized", terminalState: "selector_drift", unrecognizedCardLines: 1 },
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      }
      // The captured price lines, USD-marked amounts and a "Lead Time" label all still parse.
      const usd = { ...standard, text: standard.text.replaceAll("$", "USD ") };
      const leadTime = { ...standard, text: standard.text.replace("Arrives by Nov 6", "Lead Time: 5 Days"), tierText: "Lead Time: 5 Days" };
      for (const snapshot of [standard, usd, leadTime]) {
        expect(parseXometryOfferSnapshots({ requestedQuantity: 1, quoteUrl, snapshots: [snapshot] }).map((offer) => offer.providerOptionId))
          .toEqual(["standard"]);
      }
    });

    it("ends every price-capture refusal in a finite terminal state", () => {
      const [cheapest] = currentPanel();
      const refusals: Array<[XometryOfferSnapshot, number, string]> = [
        [{ ...cheapest, text: "\u00a0Least Expensive\nArrives by Nov 3" }, 1, "selector_drift"],
        [{ ...cheapest, text: "\u00a0Least Expensive\n$101.25 ea.\n$101.25", tierText: undefined }, 1, "selector_drift"],
        [{ ...cheapest, text: cheapest.text.replace("$101.25\n", "$1012.50\n") }, 1, "configuration_required"],
        [{ ...cheapest, text: cheapest.text.replaceAll("$", "CAD $") }, 1, "unsupported"],
      ];
      for (const [snapshot, requestedQuantity, terminalState] of refusals) {
        const failure = failureOf(() => parseXometryOfferSnapshots({ requestedQuantity, quoteUrl, snapshots: [snapshot] }));

        expect(failure).toBeInstanceOf(VendorAutomationError);
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState });
      }
    });
  });
});


describe("FILE_NAME_TEXT", () => {
  it("still strips ordinary CAD file names", () => {
    expect("part-1.v2.STEP is loading".replaceAll(FILE_NAME_TEXT, " ")).toBe("  is loading");
  });

  it("runs in linear time on a long adversarial input", () => {
    const segment = `${"a".repeat(254)}.`;
    const adversarial = segment.repeat(Math.ceil(100_000 / segment.length)).slice(0, 100_000);
    expect(adversarial).toHaveLength(100_000);
    const started = performance.now();
    adversarial.replaceAll(FILE_NAME_TEXT, " ");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("matches the in-page copy in xometry.ts", () => {
    const source = readFileSync(new URL("./xometry.ts", import.meta.url), "utf8");
    expect(source).toContain(`${FILE_NAME_TEXT.toString()},`);
  });
});
