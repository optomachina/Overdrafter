import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuoteStatsBar } from "./QuoteStatsBar";
import { makeClientQuoteOption } from "./test-option-factory";

describe("QuoteStatsBar", () => {
  it("shows a decision prompt when the price spread is unusually large", () => {
    render(
      <QuoteStatsBar
        options={[
          makeClientQuoteOption({
            key: "low",
            offerId: "offer-low",
            persistedOfferId: "offer-low",
            vendorQuoteResultId: "result-low",
            unitPriceUsd: 10,
            supplier: "Low Cost Shop",
          }),
          makeClientQuoteOption({
            key: "high",
            offerId: "offer-high",
            persistedOfferId: "offer-high",
            vendorQuoteResultId: "result-high",
            unitPriceUsd: 118,
            supplier: "Premium Shop",
          }),
        ]}
      />,
    );

    expect(screen.getByText("11.8x spread")).toBeInTheDocument();
    expect(screen.getByText("Decision Prompt")).toBeInTheDocument();
    expect(
      screen.getByText(/Large price variation across quotes\./i),
    ).toBeInTheDocument();
  });

  it("keeps the spread stat passive when the range is normal", () => {
    render(
      <QuoteStatsBar
        options={[
          makeClientQuoteOption({
            key: "baseline",
            offerId: "offer-baseline",
            persistedOfferId: "offer-baseline",
            vendorQuoteResultId: "result-baseline",
            unitPriceUsd: 40,
          }),
          makeClientQuoteOption({
            key: "close",
            offerId: "offer-close",
            persistedOfferId: "offer-close",
            vendorQuoteResultId: "result-close",
            unitPriceUsd: 72,
          }),
        ]}
      />,
    );

    expect(screen.getByText("1.8x spread")).toBeInTheDocument();
    expect(screen.queryByText("Decision Prompt")).not.toBeInTheDocument();
  });
});
