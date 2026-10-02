// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseXometryOfferSnapshots } from "./xometryOffers.js";
const snapshot = (price: string, id = "synthetic-standard") => ({ selector: "[data-synthetic-option]",
  text: `Standard\n${price}\n5 business days`, attributes: { "data-option-id": id } });
const parse = (price: string) => parseXometryOfferSnapshots({ snapshots: [snapshot(price)], requestedQuantity: 1, quoteUrl: "https://www.xometry.com/quoting/Q26-SYNTHETIC" });
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
    expect(() => parseXometryOfferSnapshots({ snapshots: [snapshot("USD $90.00", "usd"), snapshot("CAD $100.00", "cad")], requestedQuantity: 1, quoteUrl: "https://www.xometry.com/quoting/Q26-SYNTHETIC" })).toThrow();
  });
  it("does not borrow a following line's currency marker", () => {
    expect(() => parse("$50.00 ea.\nUSD $100.00")).toThrow();
  });
  it("does not let explicit USD in an unrelated amount bless bare dollars", () => {
    expect(() => parse("USD $50.00 ea.\n$100.00")).toThrow();
  });
});
