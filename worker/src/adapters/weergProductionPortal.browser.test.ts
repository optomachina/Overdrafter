// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createLocalPortalBrowserSession,
  localQuotePage,
  registerSharedPortalBrowserRefusals,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  type PortalOptionCard,
} from "../../test-support/localPortalBrowserFixture";
import { weergDispatchAuthorization, weergDispatchEnvelope } from "../../test-support/weergDispatchFixture";
import {
  buildWeergProductionPortalDefinition,
  WEERG_PRODUCTION_LOCATORS,
  WEERG_PRODUCTION_MATERIAL_OPTION,
} from "./weergPortal";

/**
 * OVD-675 browser fixture: drives the production Weerg definition through the
 * real portal kernel and a real Chromium against synthetic pages served for
 * https://www.weerg.com/. Every request is answered locally or aborted;
 * nothing reaches the network. The pages encode the reviewed locator table,
 * not an observation of the live portal.
 */

const session = createLocalPortalBrowserSession({
  vendor: "weerg",
  host: "www.weerg.com",
  pagePath: "/en/global/quotation-tool/upload",
  cadBytes: "synthetic weerg cad bytes for the browser fixture",
  cookieDomain: "www.weerg.com",
  tempPrefix: "weerg-browser-",
  locators: WEERG_PRODUCTION_LOCATORS,
  buildDefinition: buildWeergProductionPortalDefinition,
  bindAuthorization: (binding) => {
    const envelope = weergDispatchEnvelope(binding);
    return { envelope, authorization: weergDispatchAuthorization(envelope) };
  },
  extraInput: { requirement: { material: "EN AW-6082 T6" } },
});

function quotePage(options: {
  before?: string;
  afterUpload?: string;
  fileInput?: boolean;
  material?: boolean;
  extraHead?: string;
} = {}): string {
  const material = options.material === false ? "" : `<label>Material <select name="material">
      <option value="">Choose</option>
      <option value="aluminium-7075">Aluminium 7075</option>
      <option value="${WEERG_PRODUCTION_MATERIAL_OPTION}">Aluminium 6082</option>
    </select></label>`;
  return localQuotePage({
    title: "Weerg quotation tool",
    charset: true,
    before: options.before ?? "<p>Upload your 3D file to get an instant quote.</p>",
    afterUpload: options.afterUpload,
    fileInput: options.fileInput,
    extraHead: options.extraHead,
    extraControls: material,
    afterUploadWhen: `!select || select.value === ${JSON.stringify(WEERG_PRODUCTION_MATERIAL_OPTION)}`,
  });
}

describe("Weerg production portal definition in a browser fixture (OVD-675)", () => {
  it("records an EUR quote as non-comparable native evidence with every USD field null", async () => {
    const { output, error, observed } = await session.quoteAgainst(quotePage({
      afterUpload: [
        session.optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "€ 411,50", total: "€ 1.234,50", currency: "EUR", lead: "10" }),
        session.optionCard({ id: "fast-5", label: "Fast", quantity: "3", unit: "616,67", total: "1850,00", currency: "EUR", lead: "5" }),
      ].join(""),
    }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      vendor: "weerg",
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      offers: [],
      rawPayload: {
        executionContext: "production_dispatch",
        adapterRevision: "weerg-production-adapter.v1",
        terminalState: "native_offers_extracted",
        reason: "native_currency_not_comparable",
        providerMutationPossible: true,
        quoteOnly: true,
        orderProhibited: true,
        nativeCurrencyQuote: { comparable: false, currency: "EUR", currencyConversion: "none" },
      },
    });
    expect(output!.notes.join(" ")).toMatch(/quoted in EUR.*not converted to USD/);
    const native = (output!.rawPayload.nativeCurrencyQuote as { offers: Array<{ providerOptionId: string; money: Record<string, unknown> }> }).offers;
    expect(native.map((offer) => [offer.providerOptionId, offer.money.currency, offer.money.unitAmount, offer.money.totalAmount]))
      .toEqual([["standard-10", "EUR", 411.5, 1234.5], ["fast-5", "EUR", 616.67, 1850]]);
    expect(JSON.stringify(output!.rawPayload.nativeCurrencyQuote)).not.toMatch(/PriceUsd/);
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([session.cadBytes]);
    session.expectOnlyProviderHost(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("returns comparable offers only when Weerg itself anchors USD", async () => {
    const { output, error } = await session.quoteAgainst(quotePage({
      afterUpload: session.optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "$411.50", total: "$1,234.50", currency: "USD", lead: "10" }),
    }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      status: "instant_quote_received",
      unitPriceUsd: 411.5,
      totalPriceUsd: 1234.5,
      leadTimeBusinessDays: 10,
      rawPayload: { terminalState: "offers_extracted" },
    });
    expect(output!.offers[0]).toMatchObject({ providerOptionId: "standard-10", rawPayload: { anchoredCurrency: "USD", currencyConversion: "none" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["mixed EUR and USD options", { currency: "USD", unit: "10.00", total: "30.00" }],
    ["a currency symbol without an ISO code", { currency: "€" }],
    ["an ambiguous amount", { unit: "1.000", total: "3.000" }],
    ["a total that disagrees with unit times quantity", { total: "31,00" }],
    ["another quantity", { quantity: "2" }],
  ])("withholds every offer when one card carries %s", async (_name, change) => {
    const valid: PortalOptionCard = { id: "standard-10", label: "Standard", quantity: "3", unit: "10,00", total: "30,00", currency: "EUR" };
    const { output, error } = await session.quoteAgainst(quotePage({
      afterUpload: session.optionCard(valid) + session.optionCard({ ...valid, id: "malformed", ...change }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops rather than quote a portal-default material when the material control is missing", async () => {
    const { output, error, observed } = await session.quoteAgainst(quotePage({
      material: false,
      afterUpload: session.optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "10,00", total: "30,00", currency: "EUR" }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason: "weerg_material_control_missing", providerMutationPossible: true } });
    expect(observed.uploads).toHaveLength(1);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  registerSharedPortalBrowserRefusals(session, {
    missingCards: quotePage({ afterUpload: "<p>Total: € 25,00 in 7 days</p>" }),
    missingCad: quotePage({ fileInput: false }),
    login: quotePage({ before: "<h1>Session expired</h1><p>Please log in again.</p>" }),
    captcha: quotePage({ before: "<p>Please verify you are human</p>" }),
    maintenance: quotePage({ before: "<p>The quotation tool is under maintenance</p>" }),
    engineeringReview: quotePage({ afterUpload: "<p>Your part needs a manual review by our engineers.</p>" }),
    thirdParty: quotePage({
      extraHead: "<script src=\"https://cdn.example.com/tracker.js\"></script>",
      afterUpload: session.optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "10,00", total: "30,00", currency: "EUR" }),
    }),
  });
});
