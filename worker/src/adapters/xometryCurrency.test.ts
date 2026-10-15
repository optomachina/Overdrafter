// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseXometryOfferSnapshots } from "./xometryOffers.js";
const snapshot = (price: string, id = "synthetic-standard") => ({ selector: "[data-synthetic-option]",
  text: `Standard\n${price}\n5 business days`, attributes: { "data-option-id": id } });
const quoteUrl = "https://www.xometry.com/quoting/Q26-SYNTHETIC";
// Unknown registry currency: bare `$` must carry its own USD marker.
const parse = (price: string, registryCurrency: string | null = null) =>
  parseXometryOfferSnapshots({ snapshots: [snapshot(price)], requestedQuantity: 1, quoteUrl, registryCurrency });
// Standard tier text from a saved real Xometry quote page (OVD-778); quote id is a placeholder.
const savedStandardTier = "Standard\nArrives by Oct 30\n$128.25 ea.\n$1,282.46\n$1,750.44 (Save $467.98)";
const parseSaved = (registryCurrency?: string | null) => parseXometryOfferSnapshots({
  snapshots: [{ selector: "[data-synthetic-option]", text: savedStandardTier, attributes: { "data-option-id": "standard" } }],
  requestedQuantity: 10, quoteUrl, registryCurrency,
});
describe("Xometry native currency boundary", () => {
  it("preserves CAD evidence without producing a USD offer", () => {
    expect(() => parse("CAD $100.00")).toThrowError(expect.objectContaining({
      payload: expect.objectContaining({ reason: "xometry_offer_currency_untrusted", observedCurrencies: ["CAD"], providerText: expect.stringContaining("CAD $100.00") }),
    }));
  });
  it.each(["$100.00", "C$100.00", "CA$100.00", "AUD $100.00", "$100.00 CAD", "USD $100.00 CAD", "EUR €100.00", "$100.00 USD/CAD", "CAD US$100.00", "cad us$100.00", "USD $100.00 (CAD)", "usd $100.00 / cad", "Currency: CAD\nUS$100.00", "currency = cad\nUSD $100.00", "cad/USD $100.00", "cad usd $100.00", "Currency: USD/CAD\nUS$100.00", "Currency: USD and CAD\nUS$100.00"])("rejects unsupported/ambiguous %s", (price) => {
    expect(() => parse(price)).toThrow();
  });
  it.each(["USD $100.00", "US$100.00", "$100.00 USD", "USD $100.00 per order", "USD $100.00 tax included", "Pay $100.00 USD", "USD $100.00 all taxes included", "USD $100.00 (all taxes included)"])("accepts explicit anchored %s", (price) => {
    expect(parse(price)[0]).toMatchObject({ totalPriceUsd: 100, unitPriceUsd: 100 });
  });
  it("does not return partial USD options when another option is CAD", () => {
    expect(() => parseXometryOfferSnapshots({ snapshots: [snapshot("USD $90.00", "usd"), snapshot("CAD $100.00", "cad")], requestedQuantity: 1, quoteUrl })).toThrow();
  });
  it("does not borrow a following line's currency marker", () => {
    expect(() => parse("$50.00 ea.\nUSD $100.00")).toThrow();
  });
  it("does not let explicit USD in an unrelated amount bless bare dollars", () => {
    expect(() => parse("USD $50.00 ea.\n$100.00")).toThrow();
  });
  it("defaults to the manifest quote currency, which is USD for Xometry", () => {
    expect(parseSaved()[0]).toMatchObject({ unitPriceUsd: 128.25, totalPriceUsd: 1282.46 });
  });
  it("accepts bare-dollar saved tier text when the registry currency is USD", () => {
    expect(parseSaved("USD")).toEqual([expect.objectContaining({ providerLabel: "Standard", unitPriceUsd: 128.25, totalPriceUsd: 1282.46 })]);
  });
  it.each([null, "CAD", "EUR"])("fails closed on bare-dollar saved tier text when registry currency is %s", (registryCurrency) => {
    expect(() => parseSaved(registryCurrency)).toThrowError(expect.objectContaining({
      payload: expect.objectContaining({ reason: "price_currency_unverified", observedCurrencies: ["unknown"] }),
    }));
  });
  it.each(["C$41.41 ea.\n$414.15", "CA$41.41 ea.\nCA$414.15", "A$41.41 ea.\nA$414.15", "EUR $41.41 ea.\nEUR $414.15", "GBP $414.15",
    "£414.15", "€414.15", "$414.15 CAD", "$41.41 ea.\n$414.15 AUD", "Currency: CAD\n$414.15", "CAD $100.00", "USD $100.00 CAD"])(
    "still rejects explicit foreign marker %s when the registry currency is USD", (price) => {
      expect(() => parse(price, "USD")).toThrowError(expect.objectContaining({
        payload: expect.objectContaining({ reason: "xometry_offer_currency_untrusted" }),
      }));
    });
  describe("OVD-778 bare-dollar registry boundary", () => {
    // Least Expensive (T1) tier text from the saved real Xometry page; quote id is a placeholder.
    const t1Tier = "Least Expensive\nArrives by Nov 6\n$41.41 ea.\n$414.15\n$539.62 (Save $125.47)";
    const parseText = (text: string, registryCurrency: string | null | undefined, requestedQuantity = 10) =>
      parseXometryOfferSnapshots({ snapshots: [{ selector: "[data-synthetic-option]", text: /Arrives by/.test(text) ? text : `${text}\nArrives by Nov 6`, attributes: { "data-option-id": "t1" } }],
        requestedQuantity, quoteUrl: "https://www.xometry.com/quoting/Q26-PLACEHOLDER", registryCurrency });
    const unverified = expect.objectContaining({ code: "unexpected_ui_state",
      payload: expect.objectContaining({ vendor: "xometry", reason: "price_currency_unverified" }) });

    it("parses '$41.41' ea. and '$414.15' for a USD registry", () => {
      expect(parseText(t1Tier, "USD")).toEqual([expect.objectContaining({ unitPriceUsd: 41.41, totalPriceUsd: 414.15 })]);
    });
    it("fails closed on '$41.41' with price_currency_unverified for a non-USD registry", () => {
      expect(() => parseText("$41.41", "CAD", 1)).toThrowError(unverified);
      expect(() => parseText(t1Tier, "EUR")).toThrowError(unverified);
    });
    it("fails closed on '$41.41' with price_currency_unverified for a missing registry", () => {
      expect(() => parseText("$41.41", null, 1)).toThrowError(unverified);
      expect(() => parseText(t1Tier, null)).toThrowError(unverified);
    });
    it.each(["C$41.41", "A$41.41", "€41.41", "£41.41"])("rejects '%s' even for a USD registry", (price) => {
      expect(() => parseText(price, "USD", 1)).toThrowError(expect.objectContaining({
        payload: expect.objectContaining({ reason: "xometry_offer_currency_untrusted" }),
      }));
    });
    it("parses thousands separators in '$1,234.56'", () => {
      expect(parseText("$1,234.56", "USD", 1)[0]).toMatchObject({ unitPriceUsd: 1234.56, totalPriceUsd: 1234.56 });
    });
    it.each(["US$41.41", "USD 41.41"])("parses explicit '%s' regardless of registry", (price) => {
      for (const registryCurrency of ["USD", null]) {
        expect(parseText(price, registryCurrency, 1)[0]).toMatchObject({ unitPriceUsd: 41.41, totalPriceUsd: 41.41 });
      }
    });
  });
});
