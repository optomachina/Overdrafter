import { describe, expect, it } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { resolveVendorPurchasingLink } from "@/features/quotes/vendor-purchasing-links";

function makeLinkInput(
  overrides: Partial<
    Pick<ClientQuoteSelectionOption, "quoteUrl" | "vendorKey" | "vendorLabel">
  > = {},
) {
  return {
    vendorKey: "xometry" as const,
    vendorLabel: "Xometry",
    quoteUrl: "https://www.xometry.com/quoting/home/Q-123",
    ...overrides,
  };
}

describe("resolveVendorPurchasingLink", () => {
  it.each([
    ["xometry", "Xometry", "https://www.xometry.com/quoting/home/Q-123"],
    ["fictiv", "Fictiv", "https://app.fictiv.com/quotes/quote-123"],
    ["protolabs", "Protolabs", "https://ecommerce.protolabs.com/quotes/quote-123"],
    ["sendcutsend", "SendCutSend", "https://app.sendcutsend.com/quote/quote-123"],
    ["emachineshop", "eMachineShop", "https://www.emachineshop.com/quote/Q-123"],
  ] as const)("allows a matching %s HTTPS quote link", (vendorKey, vendorLabel, quoteUrl) => {
    expect(resolveVendorPurchasingLink(makeLinkInput({ vendorKey, vendorLabel, quoteUrl }))).toEqual({
      url: quoteUrl,
      vendorLabel,
    });
  });

  it.each([
    ["an unsupported vendor", makeLinkInput({ vendorKey: "partsbadger" })],
    ["a mismatched vendor domain", makeLinkInput({ quoteUrl: "https://example.com/quote/1" })],
    ["an insecure URL", makeLinkInput({ quoteUrl: "http://www.xometry.com/quote/1" })],
    ["a credential-bearing URL", makeLinkInput({ quoteUrl: "https://user:pass@www.xometry.com/quote/1" })],
    ["a simulated URL", makeLinkInput({ quoteUrl: "simulated://xometry/quote/1" })],
    ["a deceptive subdomain", makeLinkInput({ quoteUrl: "https://xometry.com.evil.test/quote/1" })],
  ])("rejects %s", (_label, input) => {
    expect(resolveVendorPurchasingLink(input)).toBeNull();
  });
});
