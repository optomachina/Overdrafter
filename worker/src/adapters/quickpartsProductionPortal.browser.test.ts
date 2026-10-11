// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createLocalPortalBrowserSession,
  localQuotePage,
  registerSharedPortalBrowserRefusals,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  type PortalOptionCard,
} from "../../test-support/localPortalBrowserFixture";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import {
  buildQuickpartsProductionPortalDefinition,
  QUICKPARTS_PRODUCTION_LOCATORS,
} from "./quickpartsPortal";

/**
 * OVD-674 browser fixture: drives the production Quickparts definition through
 * the real portal kernel and a real Chromium against synthetic pages served for
 * https://quickquote.quickparts.com/. Every request is answered locally or
 * aborted; nothing reaches the network. The pages encode the reviewed locator
 * table, not an observation of the live portal.
 */

const session = createLocalPortalBrowserSession({
  vendor: "quickparts",
  host: "quickquote.quickparts.com",
  pagePath: "/",
  cadBytes: "synthetic quickparts cad bytes for the browser fixture",
  cookieDomain: ".quickquote.quickparts.com",
  tempPrefix: "quickparts-browser-",
  locators: QUICKPARTS_PRODUCTION_LOCATORS,
  buildDefinition: buildQuickpartsProductionPortalDefinition,
  bindAuthorization: (binding) => {
    const envelope = quickpartsDispatchEnvelope(binding);
    return { envelope, authorization: quickpartsDispatchAuthorization(envelope) };
  },
});

function quotePage(options: {
  before?: string;
  afterUpload?: string;
  fileInput?: boolean;
  extraHead?: string;
} = {}): string {
  return localQuotePage({
    title: "QuickQuote",
    before: options.before ?? "<p>Upload a part to get an instant quote.</p>",
    afterUpload: options.afterUpload,
    fileInput: options.fileInput,
    extraHead: options.extraHead,
  });
}

describe("Quickparts production portal definition in a browser fixture (OVD-674)", () => {
  it("uploads exactly the authorized bytes and returns normalized USD offers", async () => {
    const { output, error, observed } = await session.quoteAgainst(quotePage({
      afterUpload: [
        session.optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "$411.50", total: "$1,234.50", lead: "10" }),
        session.optionCard({ id: "expedite-5", label: "Expedited", quantity: "3", unit: "616.67", total: "1850.00", lead: "5" }),
      ].join(""),
    }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      vendor: "quickparts",
      status: "instant_quote_received",
      unitPriceUsd: 411.5,
      totalPriceUsd: 1234.5,
      leadTimeBusinessDays: 10,
      rawPayload: {
        executionContext: "production_dispatch",
        adapterRevision: "quickparts-production-adapter.v1",
        terminalState: "offers_extracted",
        providerMutationPossible: true,
        quoteOnly: true,
        orderProhibited: true,
      },
    });
    expect(output!.offers.map((offer) => [offer.providerOptionId, offer.unitPriceUsd, offer.totalPriceUsd, offer.leadTimeBusinessDays]))
      .toEqual([["standard-10", 411.5, 1234.5, 10], ["expedite-5", 616.67, 1850, 5]]);
    expect(output!.offers.every((offer) => offer.provenance?.priceSource === "selector")).toBe(true);
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([session.cadBytes]);
    session.expectOnlyProviderHost(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["a non-USD option", { currency: "EUR" }],
    ["a total that disagrees with unit times quantity", { total: "$1,300.00" }],
    ["another quantity", { quantity: "2" }],
    ["an unpriced option", { unit: "Request quote" }],
  ])("withholds every offer when one card carries %s", async (_name, change) => {
    const valid: PortalOptionCard = { id: "standard-10", label: "Standard", quantity: "3", unit: "10.00", total: "30.00" };
    const { output, error } = await session.quoteAgainst(quotePage({
      afterUpload: session.optionCard(valid) + session.optionCard({ ...valid, id: "malformed", ...change }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("routes a post-upload configuration prompt to manual follow-up", async () => {
    const { output } = await session.quoteAgainst(quotePage({ afterUpload: "<p>Select material to continue.</p>" }));
    expect(output).toMatchObject({ status: "manual_vendor_followup", offers: [], rawPayload: { terminalState: "configuration_required" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  registerSharedPortalBrowserRefusals(session, {
    missingCards: quotePage({ afterUpload: "<p>Your price: $25.00 in 7 days</p>" }),
    missingCad: quotePage({ fileInput: false }),
    login: quotePage({ before: "<h1>Sign in</h1><input type=\"password\">" }),
    captcha: quotePage({ before: "<p>Please verify you are human</p>" }),
    maintenance: quotePage({ before: "<p>QuickQuote is down for maintenance</p>" }),
    engineeringReview: quotePage({ afterUpload: "<p>Quote request received. Our engineering review team will follow up.</p>" }),
    thirdParty: quotePage({
      extraHead: "<script src=\"https://cdn.example.com/tracker.js\"></script>",
      afterUpload: session.optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "10.00", total: "30.00" }),
    }),
  });
});
