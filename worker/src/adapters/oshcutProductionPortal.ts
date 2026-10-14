import { VendorAutomationError } from "../types.js";
import { assessOshcutEligibility, OSHCUT_ENVELOPE_REVISION, OSHCUT_PROVIDER_ENVELOPE } from "./oshcut.js";
import { OSHCUT_DISPATCH_ENVELOPE } from "./oshcutDispatchAuthorization.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  type ProviderPortalDefinition,
  type ProviderPortalEligibility,
  type ProviderPortalOfferCandidate,
  type ProviderPortalReadCapability,
} from "./providerPortalKernel.js";
import { extractUsdOfferCards, type UsdOfferCardLocators } from "./usdOfferCards.js";

export const OSHCUT_PRODUCTION_ADAPTER_REVISION = "oshcut-production-adapter.v1";

/**
 * The quoting app origin from the reviewed workflow catalog. The kernel aborts
 * every other request, so the governed egress contract pins the same list.
 */
export const OSHCUT_ALLOWED_HOSTS = ["app.oshcut.com"] as const;

/**
 * OVD-677 production locator table, pinned by the browser fixture in
 * `oshcutProductionPortal.browser.test.ts`. It is the reviewable contract for
 * the authenticated OSH Cut quoting app; the live DOM has not been captured
 * (that is a protected action), so any drift ends in `selector_drift` and
 * never in an inferred price. A changed table needs a new revision.
 */
export const OSHCUT_PRODUCTION_LOCATORS: Readonly<UsdOfferCardLocators> = Object.freeze({
  revision: "oshcut-production-locators.v1",
  card: "[data-oshcut-quote-option-id]",
  optionIdAttribute: "data-oshcut-quote-option-id",
  fields: Object.freeze({
    label: "[data-oshcut-quote-option-label]",
    quantity: "[data-oshcut-quote-option-quantity]",
    unitPrice: "[data-oshcut-quote-option-unit-price]",
    totalPrice: "[data-oshcut-quote-option-total-price]",
    currency: "[data-oshcut-quote-option-currency]",
    leadBusinessDays: "[data-oshcut-quote-option-lead-days]",
  }),
  priceFormat: "display",
  fieldJoin: " >> ",
});

/** The only material in the OSH Cut envelope and its reviewed portal option value. */
export const OSHCUT_PRODUCTION_MATERIAL_OPTION = "aluminum-6061-t6" as const;

export const OSHCUT_PRODUCTION_SELECTORS = Object.freeze({
  cadUpload: "input[type='file']",
  quantity: "input[name='quantity' i], input[aria-label='Quantity' i]",
  configuration: Object.freeze({
    material: Object.freeze({ selector: "select[name='material' i]", operation: "select" as const }),
  }),
});

const OSHCUT_TERMINAL_SIGNALS: ProviderPortalDefinition["terminalSignals"] = {
  login: [/\b(?:log ?in|sign[ -]?in|session expired)\b/i],
  captcha: [/captcha|verify you are human|security check/i],
  manualReview: [/manual review|engineering review|requires review/i],
  configurationRequired: [/select material|configure (?:your )?part/i],
  unavailable: [/service unavailable|maintenance/i],
};

/** Projects the provider-local envelope decision onto the kernel's finite states. */
export function assessOshcutProductionEligibility(
  input: Parameters<typeof assessOshcutEligibility>[0],
): ProviderPortalEligibility {
  const decision = assessOshcutEligibility(input);
  if (decision.state === "eligible") return { state: "eligible", reason: "oshcut_static_envelope_match" };
  return {
    state: decision.state === "unsupported" ? "unsupported" : "unavailable",
    reason: decision.reasonCode,
  };
}

/** Reads production option cards through the reviewed locator table; USD only. */
export function extractOshcutProductionOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
): Promise<ProviderPortalOfferCandidate[]> {
  return extractUsdOfferCards(reader, expectedQuantity, OSHCUT_PRODUCTION_LOCATORS, {
    adapterRevision: OSHCUT_PRODUCTION_ADAPTER_REVISION,
  });
}

/**
 * OVD-677 production definition. It is default-off: the production registry
 * builds it only for a worker listing `oshcut` in WORKER_LIVE_ADAPTERS, and the
 * kernel launches only behind a current generic provider-dispatch
 * authorization for `oshcut-quote-envelope.v1` bound to the staged CAD bytes.
 * That envelope is not reviewed in code, so no permit can name it yet. The
 * envelope is flat-sheet laser cutting in Aluminum 6061-T6, one CAD file, no
 * drawing, quantities 1–10,000; anything else, and every non-ready portal
 * state, ends in a finite terminal state. Offers are USD only.
 */
export function buildOshcutProductionPortalDefinition(): ProviderPortalDefinition {
  return {
    provider: "oshcut",
    displayName: "OSH Cut",
    manifestRevision: "provider-manifest.v1",
    envelopeRevision: OSHCUT_ENVELOPE_REVISION,
    adapterRevision: OSHCUT_PRODUCTION_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: "https://app.oshcut.com/",
      loginUrl: "https://app.oshcut.com/login",
      uploadUrl: "https://app.oshcut.com/",
    },
    allowedHosts: OSHCUT_ALLOWED_HOSTS,
    selectors: {
      cadUpload: OSHCUT_PRODUCTION_SELECTORS.cadUpload,
      quantity: OSHCUT_PRODUCTION_SELECTORS.quantity,
      configuration: { ...OSHCUT_PRODUCTION_SELECTORS.configuration },
    },
    supportedFileExtensions: [...OSHCUT_PROVIDER_ENVELOPE.supportedFileExtensions],
    terminalSignals: OSHCUT_TERMINAL_SIGNALS,
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    productionDispatch: { envelope: { ...OSHCUT_DISPATCH_ENVELOPE } },
    hooks: {
      // The kernel has already refused files outside the envelope and any
      // drawing, and re-checked the authorization, before this hook runs.
      assessEligibility: assessOshcutProductionEligibility,
      // A quote for a portal-default material would be a quote for the wrong
      // part, so a missing material control stops the attempt.
      configure: async (configuration) => {
        if (!(await configuration.select("material", OSHCUT_PRODUCTION_MATERIAL_OPTION))) {
          throw new VendorAutomationError("OSH Cut material control is missing.", "selector_failure", {
            vendor: "oshcut",
            terminalState: "selector_drift",
            reason: "oshcut_material_control_missing",
            providerMutationPossible: true,
          });
        }
      },
      // Exact origin first, then CAPTCHA over mixed session-expired text, as for Weerg.
      classifyPortalState: (snapshot) => {
        if (!isAllowedProviderUrl(snapshot.url, OSHCUT_ALLOWED_HOSTS)) return "unexpected_origin";
        const state = classifyProviderPortalSnapshot(snapshot, OSHCUT_TERMINAL_SIGNALS);
        if (state === "captcha") return state;
        if (/\bsession expired\b/i.test(snapshot.bodyText)) return "login_required";
        return state;
      },
      extractOffers: (reader, input) => extractOshcutProductionOffers(reader, input.requestedQuantity),
    },
  };
}
