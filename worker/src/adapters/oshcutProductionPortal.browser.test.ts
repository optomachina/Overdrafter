// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createLocalPortalBrowserSession,
  localQuotePage,
  registerSharedPortalBrowserRefusals,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  type PortalOptionCard,
} from "../../test-support/localPortalBrowserFixture";
import { oshcutDispatchAuthorization, oshcutDispatchEnvelope } from "../../test-support/oshcutDispatchFixture";
import {
  buildOshcutProductionPortalDefinition,
  OSHCUT_PRODUCTION_LOCATORS,
  OSHCUT_PRODUCTION_MATERIAL_OPTION,
} from "./oshcutProductionPortal";

/**
 * OVD-677 browser fixture: drives the production OSH Cut definition through
 * the real portal kernel and a real Chromium against synthetic pages served
 * for https://app.oshcut.com/. Every request is answered locally or aborted;
 * nothing reaches the network. The pages encode the reviewed locator table,
 * not an observation of the live portal.
 */

const session = createLocalPortalBrowserSession({
  vendor: "oshcut",
  host: "app.oshcut.com",
  pagePath: "/",
  cadBytes: "synthetic oshcut cad bytes for the browser fixture",
  cookieDomain: "app.oshcut.com",
  tempPrefix: "oshcut-browser-",
  locators: OSHCUT_PRODUCTION_LOCATORS,
  buildDefinition: buildOshcutProductionPortalDefinition,
  bindAuthorization: (binding) => {
    const envelope = oshcutDispatchEnvelope(binding);
    return { envelope, authorization: oshcutDispatchAuthorization(envelope) };
  },
  extraInput: {
    requirement: {
      material: "Aluminum 6061-T6",
      spec_snapshot: { process: "Laser Cutting", geometryFamily: "flat_sheet" },
    },
  } as never,
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
      <option value="aluminum-5052-h32">Aluminum 5052-H32</option>
      <option value="${OSHCUT_PRODUCTION_MATERIAL_OPTION}">Aluminum 6061-T6</option>
    </select></label>`;
  return localQuotePage({
    title: "OSH Cut quoting app",
    charset: true,
    before: options.before ?? "<p>Upload a part to get instant pricing.</p>",
    afterUpload: options.afterUpload,
    fileInput: options.fileInput,
    extraHead: options.extraHead,
    extraControls: material,
    afterUploadWhen: `!select || select.value === ${JSON.stringify(OSHCUT_PRODUCTION_MATERIAL_OPTION)}`,
  });
}

const STANDARD: PortalOptionCard = { id: "standard", label: "Standard", quantity: "3", unit: "$411.50", total: "$1,234.50", currency: "USD", lead: "4" };

describe("OSH Cut production portal definition in a browser fixture (OVD-677)", () => {
  it("returns selector-anchored USD offers for the authorized bytes only", async () => {
    const { output, error, observed } = await session.quoteAgainst(quotePage({
      afterUpload: [
        session.optionCard(STANDARD),
        session.optionCard({ id: "expedited", label: "Expedited", quantity: "3", unit: "616.67", total: "1850.00", currency: "USD", lead: "2" }),
      ].join(""),
    }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      vendor: "oshcut",
      status: "instant_quote_received",
      unitPriceUsd: 411.5,
      totalPriceUsd: 1234.5,
      leadTimeBusinessDays: 4,
      rawPayload: {
        executionContext: "production_dispatch",
        adapterRevision: "oshcut-production-adapter.v1",
        terminalState: "offers_extracted",
        quoteOnly: true,
        orderProhibited: true,
      },
    });
    expect(output!.offers!.map((offer) => [offer.providerOptionId, offer.unitPriceUsd, offer.totalPriceUsd, offer.leadTimeBusinessDays]))
      .toEqual([["standard", 411.5, 1234.5, 4], ["expedited", 616.67, 1850, 2]]);
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([session.cadBytes]);
    session.expectOnlyProviderHost(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["a non-USD currency", { currency: "EUR" }],
    ["a total that disagrees with unit times quantity", { total: "$1,300.00" }],
    ["another quantity", { quantity: "2" }],
  ])("withholds every offer when one card carries %s", async (_name, change) => {
    const { output, error } = await session.quoteAgainst(quotePage({
      afterUpload: session.optionCard(STANDARD) + session.optionCard({ ...STANDARD, id: "malformed", ...change }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops rather than quote a portal-default material when the material control is missing", async () => {
    const { output, error, observed } = await session.quoteAgainst(quotePage({
      material: false,
      afterUpload: session.optionCard(STANDARD),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason: "oshcut_material_control_missing", providerMutationPossible: true } });
    expect(observed.uploads).toHaveLength(1);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  registerSharedPortalBrowserRefusals(session, {
    missingCards: quotePage({ afterUpload: "<p>Total: $25.00 in 7 days</p>" }),
    missingCad: quotePage({ fileInput: false }),
    login: quotePage({ before: "<h1>Session expired</h1><p>Please log in again.</p>" }),
    captcha: quotePage({ before: "<p>Please verify you are human</p>" }),
    maintenance: quotePage({ before: "<p>The quoting app is under maintenance</p>" }),
    engineeringReview: quotePage({ afterUpload: "<p>Your part needs a manual review by our engineers.</p>" }),
    thirdParty: quotePage({
      extraHead: "<script src=\"https://cdn.example.com/tracker.js\"></script>",
      afterUpload: session.optionCard(STANDARD),
    }),
  });
});
