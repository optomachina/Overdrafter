// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOffer,
  VendorQuoteAdapterOutput,
} from "../types";
import { VendorAutomationError } from "../types";
import { FICTIV_AUTOMATION_VERSION } from "./fictiv";
import {
  assertProviderAdapterContract,
  evaluateProviderAdapterFailureContract,
  evaluateProviderAdapterContract,
} from "./providerAdapterContract";
import type { ProviderPortalDefinition } from "./providerPortalKernel";
import { normalizeSendCutSendOffers } from "./sendcutsend";
import { parseXometryOfferSnapshots } from "./xometryOffers";

const definition = {
  provider: "quickparts",
  displayName: "Quickparts",
  manifestRevision: "quickparts-manifest.v1",
  envelopeRevision: "quickparts-envelope.v1",
  adapterRevision: "quickparts-adapter.v1",
  accountMode: "company_controlled",
  routes: {
    publicUrl: "https://quickparts.com/",
    loginUrl: "https://quickquote.quickparts.com/#/login",
    uploadUrl: "https://quickquote.quickparts.com/",
  },
  allowedHosts: ["quickparts.com", "quickquote.quickparts.com"],
  selectors: { cadUpload: "input[type='file']" },
  supportedFileExtensions: ["step"],
  terminalSignals: {
    login: [/login/i],
    captcha: [/captcha/i],
    manualReview: [/manual review/i],
    configurationRequired: [/configure/i],
    unavailable: [/unavailable/i],
  },
  requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
  hooks: {
    assessEligibility: () => ({ state: "eligible", reason: "eligible" } as const),
    configure: () => undefined,
    classifyPortalState: () => "ready" as const,
    extractOffers: () => [],
  },
} satisfies ProviderPortalDefinition;

const adapterInput = {
  requestedQuantity: 5,
} as VendorQuoteAdapterInput;

function offer(overrides: Partial<VendorQuoteAdapterOffer> = {}): VendorQuoteAdapterOffer {
  return {
    providerOptionId: "economy-7d",
    providerLabel: "Economy",
    quoteRef: "QP-123",
    quoteUrl: "https://quickquote.quickparts.com/quotes/QP-123",
    unitPriceUsd: 20,
    totalPriceUsd: 100,
    leadTimeBusinessDays: 7,
    shipReceiveBy: null,
    tier: "economy",
    sourcing: null,
    geographicOrigin: "unknown",
    sortRank: 0,
    provenance: {
      containerSelector: "[data-option-id='economy-7d']",
      providerOptionIdSource: "attribute",
      priceSource: "selector",
      leadTimeSource: "selector",
      geographicOriginSource: "none",
    },
    rawPayload: { observed: true },
    ...overrides,
  };
}

function output(overrides: Partial<VendorQuoteAdapterOutput> = {}): VendorQuoteAdapterOutput {
  return {
    vendor: "quickparts",
    status: "instant_quote_received",
    unitPriceUsd: 20,
    totalPriceUsd: 100,
    leadTimeBusinessDays: 7,
    quoteUrl: "https://quickquote.quickparts.com/quotes/QP-123",
    validUntil: null,
    validityDurationDays: null,
    validitySource: null,
    validityTerms: null,
    offers: [offer()],
    dfmIssues: [],
    notes: [],
    artifacts: [{
      kind: "json",
      label: "scrubbed result",
      localPath: "/private/evidence/quickparts-result.json",
      contentType: "application/json",
    }],
    rawPayload: {
      terminalState: "offers_extracted",
      quoteOnly: true,
      orderProhibited: true,
    },
    ...overrides,
  };
}

function familyDefinition(input: {
  provider: ProviderPortalDefinition["provider"];
  host: string;
  adapterRevision: string;
}): ProviderPortalDefinition {
  const baseUrl = `https://${input.host}/`;
  return {
    ...definition,
    provider: input.provider,
    displayName: input.provider,
    adapterRevision: input.adapterRevision,
    routes: { publicUrl: baseUrl, loginUrl: baseUrl, uploadUrl: baseUrl },
    allowedHosts: [input.host],
  };
}

describe("provider adapter contract harness", () => {
  it("applies one offline output contract across generic and existing adapter families", () => {
    const xometryOffers = parseXometryOfferSnapshots({
      requestedQuantity: 5,
      quoteUrl: "https://www.xometry.com/quoting/quote/Q-FIXTURE",
      snapshots: [{
        selector: ".price-tier",
        text: "Domestic Economy - Lead Time: 8 business days\nMade in USA\n$20.00 ea.\n$100.00",
        attributes: { "data-option-id": "domestic-economy" },
      }],
    });
    const sendCutSend = normalizeSendCutSendOffers([{
      availability: "purchasable",
      domMatchId: "dom-standard",
      selector: "[data-testid='quote-option']",
      providerOptionId: "standard",
      providerLabel: "Standard",
      quoteRef: "SCS-FIXTURE",
      quoteUrl: "https://app.sendcutsend.com/quotes/SCS-FIXTURE",
      text: "Standard $100.00 5 business days. Quoted on 2026-08-27. Valid for 14 days.",
    }], 5);
    if (!sendCutSend.ok) {
      throw new Error(`Expected SendCutSend offline fixture: ${sendCutSend.reason}`);
    }

    const cases = [
      {
        label: "generic portal",
        definition,
        output: output(),
      },
      {
        label: "Xometry custom browser adapter",
        definition: familyDefinition({
          provider: "xometry",
          host: "www.xometry.com",
          adapterRevision: "xometry-offline-contract.v1",
        }),
        output: output({
          vendor: "xometry",
          quoteUrl: "https://www.xometry.com/quoting/quote/Q-FIXTURE",
          offers: xometryOffers,
        }),
      },
      {
        label: "Fictiv custom browser adapter",
        definition: familyDefinition({
          provider: "fictiv",
          host: "www.fictiv.com",
          adapterRevision: FICTIV_AUTOMATION_VERSION,
        }),
        output: output({
          vendor: "fictiv",
          quoteUrl: "https://www.fictiv.com/quote",
          offers: [offer({
            providerOptionId: "fictiv-standard",
            quoteUrl: "https://www.fictiv.com/quote",
          })],
          rawPayload: { automationVersion: FICTIV_AUTOMATION_VERSION, quoteOnly: true },
        }),
      },
      {
        label: "SendCutSend normalized fixture output",
        definition: familyDefinition({
          provider: "sendcutsend",
          host: "app.sendcutsend.com",
          adapterRevision: "sendcutsend-offline-contract.v1",
        }),
        output: output({
          vendor: "sendcutsend",
          quoteUrl: "https://app.sendcutsend.com/quotes/SCS-FIXTURE",
          offers: sendCutSend.offers,
        }),
      },
      {
        label: "OSH Cut custom provider finite output",
        definition: familyDefinition({
          provider: "oshcut",
          host: "app.oshcut.com",
          adapterRevision: "oshcut-offline-contract.v1",
        }),
        output: output({
          vendor: "oshcut",
          status: "manual_vendor_followup",
          unitPriceUsd: null,
          totalPriceUsd: null,
          leadTimeBusinessDays: null,
          quoteUrl: null,
          offers: [],
          rawPayload: { terminalState: "unsupported", quoteOnly: true },
        }),
      },
    ];

    for (const family of cases) {
      expect(
        evaluateProviderAdapterContract({
          definition: family.definition,
          adapterInput,
          output: family.output,
        }),
        family.label,
      ).toMatchObject({ ok: true, violations: [] });
    }
  });

  it("accepts anchored multi-option quote-only output and preserves unknown validity/origin", () => {
    const result = assertProviderAdapterContract({
      definition,
      adapterInput,
      output: output({
        offers: [offer(), offer({
          providerOptionId: "expedite-3d",
          providerLabel: "Expedite",
          totalPriceUsd: 150,
          unitPriceUsd: 30,
          leadTimeBusinessDays: 3,
          sortRank: 1,
        })],
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.normalizedOffers).toHaveLength(2);
    expect(result.normalizedOffers[0]).toMatchObject({
      quantity: 5,
      validUntil: null,
      validitySource: null,
      geographicOrigin: "unknown",
      artifactRefs: ["quickparts-result.json"],
    });
  });

  it("rejects unanchored prices, lead times, duplicate IDs, and unexpected quote origins", () => {
    const result = evaluateProviderAdapterContract({
      definition,
      adapterInput,
      output: output({
        quoteUrl: "https://malicious.example/quote",
        offers: [
          offer({ provenance: { ...offer().provenance, priceSource: "body_text" as "selector" } }),
          offer({ provenance: { ...offer().provenance, leadTimeSource: "body_text" } }),
        ],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      "quote_url_outside_allowed_hosts",
      "offer_price_unanchored",
      "offer_lead_time_unanchored",
      "provider_option_id_missing_or_duplicate",
    ]));
  });

  it("preserves and rejects a kernel-reported quantity mismatch", () => {
    const result = evaluateProviderAdapterContract({
      definition,
      adapterInput,
      output: output({ offers: [offer({ quantity: 4 })] }),
    });

    expect(result.normalizedOffers[0]?.quantity).toBe(4);
    expect(result.violations).toContain("offer_quantity_mismatch");
  });

  it("nulls and rejects an external URL on one option in a multi-option result", () => {
    const result = evaluateProviderAdapterContract({
      definition,
      adapterInput,
      output: output({
        offers: [
          offer(),
          offer({
            providerOptionId: "external-option",
            quoteUrl: "https://malicious.example/quote/123",
          }),
        ],
      }),
    });

    expect(result.normalizedOffers[0]?.quoteUrl).toBe("https://quickquote.quickparts.com/quotes/QP-123");
    expect(result.normalizedOffers[1]?.quoteUrl).toBeNull();
    expect(result.violations).toContain("offer_quote_url_outside_allowed_hosts");
  });

  it("rejects any purchasing action exposed by selectors or result payloads", () => {
    const result = evaluateProviderAdapterContract({
      definition: {
        ...definition,
        selectors: {
          ...definition.selectors,
          paymentAction: "button[data-place-order]",
        } as ProviderPortalDefinition["selectors"],
      },
      adapterInput,
      output: output({ rawPayload: { nextUrl: "/checkout" } }),
    });

    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringMatching(/^purchasing_action_reachable:/),
      expect.stringMatching(/^purchasing_action_observed:/),
    ]));
  });

  it("permits finite truthful non-price terminal states", () => {
    for (const terminalState of [
      "configuration_required",
      "unsupported",
      "unavailable",
      "selector_drift",
    ] as const) {
      const result = evaluateProviderAdapterContract({
        definition,
        adapterInput,
        output: output({
          status: "manual_vendor_followup",
          unitPriceUsd: null,
          totalPriceUsd: null,
          leadTimeBusinessDays: null,
          quoteUrl: null,
          offers: [],
          rawPayload: { terminalState },
        }),
      });
      expect(result).toMatchObject({ ok: true, terminalState });
    }
  });

  it("rejects prices attached to failure or review states", () => {
    const result = evaluateProviderAdapterContract({
      definition,
      adapterInput,
      output: output({
        status: "manual_review_pending",
        offers: [],
      }),
    });
    expect(result.violations).toContain("terminal_failure_contains_publishable_price");
  });

  it.each([
    ["login_required", "login_required"],
    ["captcha", "captcha"],
    ["missing_session", "login_required"],
    ["unexpected_origin", "unexpected_ui_state"],
    ["selector_drift", "selector_failure"],
    ["configuration_required", "unexpected_ui_state"],
    ["manual_review", "unexpected_ui_state"],
    ["unsupported", "unexpected_ui_state"],
    ["unavailable", "unexpected_ui_state"],
  ] as const)("accepts finite %s failures", (terminalState, code) => {
    expect(evaluateProviderAdapterFailureContract(new VendorAutomationError(
      terminalState,
      code,
      { terminalState },
    ))).toEqual({ ok: true, terminalState, violations: [] });
  });

  it("rejects unclassified or priced failures", () => {
    expect(evaluateProviderAdapterFailureContract(new Error("boom")).ok).toBe(false);
    expect(evaluateProviderAdapterFailureContract(new VendorAutomationError(
      "drift",
      "selector_failure",
      { terminalState: "selector_drift", totalPriceUsd: 99 },
    )).violations).toContain("failure_contains_publishable_price");
  });
});
