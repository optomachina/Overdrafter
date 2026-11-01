import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { QUICKPARTS_DISPATCH_ENVELOPE } from "../providerDispatchEnvelope.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  type ProviderPortalDefinition,
  type ProviderPortalOfferCandidate,
  type ProviderPortalReadCapability,
} from "./providerPortalKernel.js";
import { QUICKPARTS_ENVELOPE_REVISION } from "./quickpartsEnvelope.js";
import { extractUsdOfferCards, type UsdOfferCardLocators } from "./usdOfferCards.js";

export const QUICKPARTS_ADAPTER_REVISION = "quickparts-offline-adapter.v2";
export const QUICKPARTS_PRODUCTION_ADAPTER_REVISION = "quickparts-production-adapter.v1";
export const QUICKPARTS_ALLOWED_HOSTS = ["quickparts.com", "quickquote.quickparts.com", "services.qpinternal.com"] as const;
const HOSTS = QUICKPARTS_ALLOWED_HOSTS;

const SYNTHETIC_LOCATORS: UsdOfferCardLocators = {
  revision: "quickparts-synthetic-locators.v1",
  card: "[data-ovd-synthetic-quickparts-option]",
  optionIdAttribute: "data-option-id",
  fields: {
    label: "[data-label]",
    quantity: "[data-quantity]",
    unitPrice: "[data-unit-price]",
    totalPrice: "[data-total-price]",
    currency: "[data-currency]",
    leadBusinessDays: "[data-lead-business-days]",
  },
  priceFormat: "plain",
  fieldJoin: " ",
};

/**
 * OVD-674 production locator table, pinned by the browser fixture in
 * `quickpartsProductionPortal.test.ts`. It is the reviewable contract for the
 * authenticated QuickQuote pricing panel; the live DOM has not been captured
 * (that is a protected action), so any drift ends in `selector_drift` and
 * never in an inferred price. A changed table needs a new revision.
 */
export const QUICKPARTS_PRODUCTION_LOCATORS: Readonly<UsdOfferCardLocators> = Object.freeze({
  revision: "quickparts-production-locators.v1",
  card: "[data-quote-option-id]",
  optionIdAttribute: "data-quote-option-id",
  fields: Object.freeze({
    label: "[data-quote-option-label]",
    quantity: "[data-quote-option-quantity]",
    unitPrice: "[data-quote-option-unit-price]",
    totalPrice: "[data-quote-option-total-price]",
    currency: "[data-quote-option-currency]",
    leadBusinessDays: "[data-quote-option-lead-days]",
  }),
  priceFormat: "display",
  fieldJoin: " >> ",
});

export const QUICKPARTS_PRODUCTION_SELECTORS = Object.freeze({
  cadUpload: "input[type='file']",
  quantity: "input[name='quantity' i], input[aria-label='Quantity' i]",
});

/** Exercises proposed option anchors against synthetic readers, never a live portal. */
export async function extractQuickpartsSyntheticOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
): Promise<ProviderPortalOfferCandidate[]> {
  return extractUsdOfferCards(reader, expectedQuantity, SYNTHETIC_LOCATORS, {
    fixtureKind: "synthetic", adapterRevision: QUICKPARTS_ADAPTER_REVISION,
  });
}

/** Reads production option cards through the reviewed locator table. */
export async function extractQuickpartsProductionOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
): Promise<ProviderPortalOfferCandidate[]> {
  return extractUsdOfferCards(reader, expectedQuantity, QUICKPARTS_PRODUCTION_LOCATORS, {
    adapterRevision: QUICKPARTS_PRODUCTION_ADAPTER_REVISION,
  });
}

const QUICKPARTS_TERMINAL_SIGNALS: ProviderPortalDefinition["terminalSignals"] = {
  login: [/login|sign[ -]?in/i], captcha: [/captcha|verify you are human/i],
  manualReview: [/manual review|engineering review|quote request received/i],
  configurationRequired: [/select material|configure your part/i],
  unavailable: [/service unavailable|maintenance/i],
};

function quickpartsDefinitionBase(): Omit<ProviderPortalDefinition, "adapterRevision" | "selectors" | "hooks"> {
  return {
    provider: "quickparts", displayName: "Quickparts", manifestRevision: "provider-manifest.v1",
    envelopeRevision: QUICKPARTS_ENVELOPE_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: "https://quickparts.com/",
      loginUrl: "https://quickquote.quickparts.com/#/login",
      uploadUrl: "https://quickquote.quickparts.com/",
    },
    allowedHosts: HOSTS,
    supportedFileExtensions: PROVIDER_CATALOG.quickparts.capabilityEnvelope.files.values,
    terminalSignals: QUICKPARTS_TERMINAL_SIGNALS,
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
  };
}

/**
 * Local evaluation definition unavailable before session access. Real portal
 * anchors/configuration need separate review; no flag enables synthetic hooks.
 * Classification uses the declared Quickparts terminal signals, rejects unexpected
 * origins, and maps an otherwise ready snapshot to selector drift.
 */
export function buildQuickpartsOfflinePortalDefinition(): ProviderPortalDefinition {
  return {
    ...quickpartsDefinitionBase(),
    adapterRevision: QUICKPARTS_ADAPTER_REVISION,
    selectors: { cadUpload: "input[data-ovd-synthetic-quickparts-upload]" },
    hooks: {
      assessEligibility: () => ({ state: "unavailable", reason: "quickparts_reviewed_portal_evidence_missing" }),
      configure: () => undefined,
      classifyPortalState: (snapshot) => {
        if (!isAllowedProviderUrl(snapshot.url, HOSTS)) return "unexpected_origin";
        const state = classifyProviderPortalSnapshot(snapshot, QUICKPARTS_TERMINAL_SIGNALS);
        return state === "ready" ? "selector_drift" : state;
      },
      // Synthetic extraction is deliberately unreachable from an actual session.
      extractOffers: () => [],
    },
  };
}

/**
 * OVD-674 production definition. It is default-off: the production registry
 * builds it only for a worker listing `quickparts` in WORKER_LIVE_ADAPTERS,
 * and the kernel launches only behind a current generic provider-dispatch
 * authorization for `quickparts-quote-envelope.v1` bound to the staged CAD
 * bytes. Instant quotes cover one CAD file without a drawing; anything else,
 * and every non-ready portal state, ends in a finite terminal state.
 */
export function buildQuickpartsProductionPortalDefinition(): ProviderPortalDefinition {
  return {
    ...quickpartsDefinitionBase(),
    adapterRevision: QUICKPARTS_PRODUCTION_ADAPTER_REVISION,
    selectors: { ...QUICKPARTS_PRODUCTION_SELECTORS },
    productionDispatch: { envelope: { ...QUICKPARTS_DISPATCH_ENVELOPE } },
    hooks: {
      // The kernel has already refused files outside the instant-file envelope
      // (SLDPRT is a manual quote) and any drawing, before this hook runs.
      assessEligibility: (input) =>
        Number.isSafeInteger(input.requestedQuantity) && input.requestedQuantity >= 1
          ? { state: "eligible", reason: "quickparts_instant_file_and_quantity_fit" }
          : { state: "unsupported", reason: "quantity_outside_envelope" },
      configure: () => undefined,
      classifyPortalState: (snapshot) => {
        if (!isAllowedProviderUrl(snapshot.url, HOSTS)) return "unexpected_origin";
        return classifyProviderPortalSnapshot(snapshot, QUICKPARTS_TERMINAL_SIGNALS);
      },
      extractOffers: (reader, input) => extractQuickpartsProductionOffers(reader, input.requestedQuantity),
    },
  };
}
