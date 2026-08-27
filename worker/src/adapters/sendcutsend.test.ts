// @vitest-environment node

import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isApprovedSendCutSendOrigin,
  normalizeSendCutSendOffers,
  parseSendCutSendValidityEvidence,
  safeSendCutSendEvaluationError,
  type SendCutSendQuoteContainer,
} from "./sendcutsend";

function container(overrides: Partial<SendCutSendQuoteContainer> = {}): SendCutSendQuoteContainer {
  return {
    availability: "purchasable",
    domMatchId: "dom-standard",
    selector: "[data-testid='quote-option']",
    providerOptionId: "standard",
    providerLabel: "Standard",
    quoteRef: "SCS-101",
    quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101",
    text: "Standard $120.00 5 business days. Quoted on 2026-08-27. Valid for 14 days.",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SendCutSend complete unique offers", () => {
  it("normalizes price, quantity, provenance, destination, reference, and validity", () => {
    const fixtures = [
      container(),
      container({
        domMatchId: "dom-rush",
        providerOptionId: "rush",
        providerLabel: "Rush",
        quoteRef: "SCS-101-RUSH",
        quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101?speed=rush",
        text: "Rush per part: $80.00 3 business days. Valid through 2026-09-10.",
      }),
    ];
    const originalFixtures = structuredClone(fixtures);

    const normalized = normalizeSendCutSendOffers(fixtures, 2);

    expect(normalized).toMatchObject({
      ok: true,
      offers: [
        {
          providerOptionId: "standard",
          quoteRef: "SCS-101",
          quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101",
          unitPriceUsd: 60,
          totalPriceUsd: 120,
          leadTimeBusinessDays: 5,
          provenance: { containerSelector: "[data-testid='quote-option']" },
          rawPayload: {
            containerDomMatchId: "dom-standard",
            validityEvidence: {
              quotedAt: "2026-08-27",
              validityDurationDays: 14,
              validitySource: "vendor_duration",
            },
            evidenceTrust: "evaluation_only_untrusted",
            customerLiveOfferEligible: false,
            persistenceEligible: false,
          },
        },
        {
          providerOptionId: "rush",
          unitPriceUsd: 80,
          totalPriceUsd: 160,
          leadTimeBusinessDays: 3,
        },
      ],
    });
    expect(fixtures).toEqual(originalFixtures);
  });

  it.each([
    "Standard exact $100.00 ships in under 5 business days",
    "Available from 2026-08-27. Standard exact $100.00",
  ])("does not treat ordinary qualified numbers as price bounds: %s", (text) => {
    expect(normalizeSendCutSendOffers([container({ text })], 1)).toMatchObject({
      ok: true,
      offers: [{ unitPriceUsd: 100, totalPriceUsd: 100 }],
    });
  });

  it("derives provider ID provenance from the trimmed identifier", () => {
    expect(normalizeSendCutSendOffers([container({ providerOptionId: "   " })], 1))
      .toMatchObject({
        ok: true,
        offers: [{
          providerOptionId: "Standard",
          provenance: { providerOptionIdSource: "provider_label" },
        }],
      });
    expect(normalizeSendCutSendOffers([container({ providerOptionId: " standard-trimmed " })], 1))
      .toMatchObject({
        ok: true,
        offers: [{
          providerOptionId: "standard-trimmed",
          provenance: { providerOptionIdSource: "attribute" },
        }],
      });
  });
});

describe("SendCutSend duplicate evidence", () => {
  it("collapses exact matches and rejects conflicting duplicate provider IDs", () => {
    const exact = container();
    expect(normalizeSendCutSendOffers([exact, { ...exact }], 2)).toMatchObject({
      ok: true,
      offers: [{ providerOptionId: "standard" }],
    });

    expect(normalizeSendCutSendOffers([
      exact,
      container({
        domMatchId: "dom-conflict",
        providerLabel: "Different",
        quoteRef: "SCS-202",
        text: "Different $130.00 6 business days",
      }),
    ], 2)).toEqual({
      ok: false,
      reason: "duplicate_provider_option_id",
      providerOptionId: "standard",
    });
  });

  it.each([
    ["unavailable first", [
      container({ availability: "unavailable", text: "Standard unavailable" }),
      container(),
    ]],
    ["purchasable first", [
      container(),
      container({ availability: "unavailable", text: "Standard unavailable" }),
    ]],
  ])("rejects conflicting availability with the same provider ID: %s", (_label, fixtures) => {
    expect(normalizeSendCutSendOffers(fixtures, 2)).toEqual({
      ok: false,
      reason: "duplicate_provider_option_id",
      providerOptionId: "standard",
    });
  });
});

describe("SendCutSend incomplete and ambiguous offers", () => {
  it.each([
    ["missing label", { providerLabel: null }, "purchasable_offer_incomplete"],
    ["missing reference", { quoteRef: null }, "purchasable_offer_incomplete"],
    ["blank DOM identity", { domMatchId: "  " }, "purchasable_offer_incomplete"],
    ["blank selector", { selector: "\t" }, "purchasable_offer_incomplete"],
    ["missing destination", { quoteUrl: null }, "unapproved_destination"],
    ["unapproved destination", { quoteUrl: "https://sendcutsend.com/quotes/SCS-101" }, "unapproved_destination"],
    ["missing price", { text: "Standard pricing unavailable" }, "purchasable_offer_unparseable"],
    ["ambiguous prices", { text: "Was $150.00, now $125.00" }, "purchasable_offer_unparseable"],
    ["price range", { text: "Standard $100.00-$120.00" }, "purchasable_offer_unparseable"],
    ["USD to range", { text: "Standard USD 100.00 to 120.00" }, "purchasable_offer_unparseable"],
    ["en-dash range", { text: "Standard $100.00–$120.00" }, "purchasable_offer_unparseable"],
    ["em-dash USD range", { text: "Standard USD 100.00—USD 120.00" }, "purchasable_offer_unparseable"],
    ["redundant second currency", { text: "Standard $100.00 - USD $120.00" }, "purchasable_offer_unparseable"],
    ["malformed first range price", { text: "Standard $1,20.00-$120.00" }, "purchasable_offer_unparseable"],
    ["starting-at price", { text: "Standard starting at $100.00" }, "purchasable_offer_unparseable"],
    ["prices start at", { text: "Standard prices start at $100.00" }, "purchasable_offer_unparseable"],
    ["prices start from", { text: "Standard prices start from $100.00" }, "purchasable_offer_unparseable"],
    ["redundant USD marker", { text: "Standard starting at USD $100.00" }, "purchasable_offer_unparseable"],
    ["from price", { text: "Standard from USD 100.00" }, "purchasable_offer_unparseable"],
    ["up-to price", { text: "Standard up to $100.00" }, "purchasable_offer_unparseable"],
    ["minimum price", { text: "Standard minimum price: $100.00" }, "purchasable_offer_unparseable"],
    ["maximum price", { text: "Standard maximum: $100.00" }, "purchasable_offer_unparseable"],
    ["max price", { text: "Standard max cost $100.00" }, "purchasable_offer_unparseable"],
    ["open-ended price", { text: "Standard $100.00 or more" }, "purchasable_offer_unparseable"],
    ["invalid price", { text: "Standard $0.00" }, "purchasable_offer_unparseable"],
    ["malformed price", { text: "Standard $1,20.00" }, "purchasable_offer_unparseable"],
  ])("rejects %s", (_label, overrides, reason) => {
    expect(normalizeSendCutSendOffers([container(overrides)], 2)).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("rejects an invalid requested quantity", () => {
    expect(normalizeSendCutSendOffers([container()], 0)).toEqual({
      ok: false,
      reason: "purchasable_offer_unparseable",
      providerOptionId: null,
    });
  });

  it("rejects non-finite or zero derived prices", () => {
    expect(normalizeSendCutSendOffers([
      container({ text: `Standard per part: $1${"0".repeat(308)}` }),
    ], 2)).toMatchObject({ ok: false, reason: "purchasable_offer_unparseable" });
    expect(normalizeSendCutSendOffers([container({ text: "Standard $0.01" })], Number.MAX_SAFE_INTEGER))
      .toMatchObject({ ok: false, reason: "purchasable_offer_unparseable" });
  });

  it.each([
    "Standard $100.00 5-7 business days",
    "Standard $100.00 5–7 business days",
    "Standard $100.00 5—7 business days",
    "Standard $100.00 5 to 7 business days",
  ])("does not normalize a lead-time range endpoint: %s", (text) => {
    expect(normalizeSendCutSendOffers([container({ text })], 1)).toMatchObject({
      ok: true,
      offers: [{ leadTimeBusinessDays: null }],
    });
  });
});

describe("SendCutSend unavailable evidence", () => {
  it("filters only fixtures explicitly marked unavailable", () => {
    expect(normalizeSendCutSendOffers([
      container({
        availability: "unavailable",
        providerLabel: null,
        quoteRef: null,
        quoteUrl: null,
        text: "Contact support",
      }),
    ], 1)).toEqual({ ok: true, offers: [] });
  });

  it("filters multiple unavailable-only fixtures sharing an option ID", () => {
    expect(normalizeSendCutSendOffers([
      container({ availability: "unavailable", text: "Standard unavailable" }),
      container({
        availability: "unavailable",
        domMatchId: "dom-standard-secondary",
        text: "Standard currently unavailable",
      }),
    ], 1)).toEqual({ ok: true, offers: [] });
  });
});

describe("SendCutSend approved origin", () => {
  it.each([
    ["https://app.sendcutsend.com/", true],
    ["https://app.sendcutsend.com:443/", true],
    ["https://app.sendcutsend.com:8443/", false],
    ["http://app.sendcutsend.com/", false],
    ["https://sendcutsend.com/", false],
    ["https://quotes.sendcutsend.com/", false],
    ["https://app.sendcutsend.com.example.com/", false],
    ["https://user:secret@app.sendcutsend.com/", false],
    ["not a URL", false],
  ])("classifies %s", (url, expected) => {
    expect(isApprovedSendCutSendOrigin(url)).toBe(expected);
  });
});

describe("SendCutSend validity evidence", () => {
  it("retains explicit dates or durations and never invents missing evidence", () => {
    expect(parseSendCutSendValidityEvidence(
      "Quoted on 2026-08-27. Valid through 2026-09-10.",
    )).toMatchObject({
      quotedAt: "2026-08-27",
      validUntil: "2026-09-10",
      validitySource: "vendor_date",
    });
    expect(parseSendCutSendValidityEvidence("Valid for 14 days")).toMatchObject({
      validUntil: null,
      validityDurationDays: 14,
      validitySource: "vendor_duration",
    });
    expect(parseSendCutSendValidityEvidence("Valid until not-a-date")).toEqual({
      quotedAt: null,
      validUntil: null,
      validityDurationDays: null,
      validitySource: null,
      validityTerms: null,
    });
    expect(parseSendCutSendValidityEvidence("Valid until 2026-02-31")).toEqual({
      quotedAt: null,
      validUntil: null,
      validityDurationDays: null,
      validitySource: null,
      validityTerms: null,
    });
    expect(parseSendCutSendValidityEvidence("No validity shown")).toEqual({
      quotedAt: null,
      validUntil: null,
      validityDurationDays: null,
      validitySource: null,
      validityTerms: null,
    });
  });
});

describe("SendCutSend bounded pure error evidence", () => {
  it("redacts exact paths before bounding and has no provider-capable module boundary", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sensitivePath = "/opt/Acme Defense/Project X/secret.step";
    const sanitized = safeSendCutSendEvaluationError(
      new Error(`${"x".repeat(970)}${sensitivePath} trailing detail`),
      [sensitivePath],
    );

    expect(sanitized.length).toBeLessThanOrEqual(1_000);
    expect(sanitized).toContain("<redacted-path>");
    expect(sanitized).not.toContain("Acme Defense");
    expect(sanitized).not.toContain("secret.step");
    expect(safeSendCutSendEvaluationError(
      new Error("failed at /srv/Project Alpha/private folder then stopped"),
      ["/srv/Project Alpha/private folder"],
    )).toBe("failed at <redacted-path> then stopped");
    expect(safeSendCutSendEvaluationError(new Error("failed at /mnt/private/part.step")))
      .not.toContain("/mnt/private");
    const genericPaths = safeSendCutSendEvaluationError(new Error(
      "failed at /opt/Acme Defense/Project X/other part.step; then retry denied "
      + "C:\\Acme Defense\\Project X\\drawing file.dxf, no disclosure occurred",
    ));
    expect(genericPaths).not.toContain("Acme Defense");
    expect(genericPaths).not.toContain("other part.step");
    expect(genericPaths).not.toContain("drawing file.dxf");
    expect(genericPaths).toContain("then retry denied");
    expect(genericPaths).toContain("no disclosure occurred");
    const extensionlessPaths = safeSendCutSendEvaluationError(new Error(
      "failed at /opt/Acme Defense/Project X/private model; retry denied "
      + "C:\\Acme Defense\\Project X\\private drawing, no disclosure occurred",
    ));
    expect(extensionlessPaths).not.toContain("Acme Defense");
    expect(extensionlessPaths).not.toContain("private model");
    expect(extensionlessPaths).not.toContain("private drawing");
    expect(extensionlessPaths).toContain("retry denied");
    expect(extensionlessPaths).toContain("no disclosure occurred");
    expect(fetchSpy).not.toHaveBeenCalled();

    const moduleSource = await fs.readFile(new URL("./sendcutsend.ts", import.meta.url), "utf8");
    expect(moduleSource).not.toMatch(
      /liveEvaluationFiles|stageLiveEvaluationFiles|playwright|puppeteer|chromium|fetch\s*\(/i,
    );
  });
});
