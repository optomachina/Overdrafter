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

export const QUICKPARTS_ADAPTER_REVISION = "quickparts-offline-adapter.v2";
export const QUICKPARTS_PRODUCTION_ADAPTER_REVISION = "quickparts-production-adapter.v1";
export const QUICKPARTS_ALLOWED_HOSTS = ["quickparts.com", "quickquote.quickparts.com"] as const;
const HOSTS = QUICKPARTS_ALLOWED_HOSTS;

/** Where one Quickparts option card and its fields are read from. */
export type QuickpartsOfferLocators = {
  revision: string;
  card: string;
  optionIdAttribute: string;
  /** Each selector is resolved inside the indexed card. */
  fields: {
    label: string;
    quantity: string;
    unitPrice: string;
    totalPrice: string;
    currency: string;
    leadBusinessDays: string;
  };
  /** `display` additionally accepts a leading `$` and thousands separators. */
  priceFormat: "plain" | "display";
  /**
   * Joins the indexed card and a field selector. A real browser needs `>>`
   * after `nth=`; the synthetic form is kept only for its pinned reader tests.
   */
  fieldJoin: " " | " >> ";
};

const SYNTHETIC_LOCATORS: QuickpartsOfferLocators = {
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
export const QUICKPARTS_PRODUCTION_LOCATORS: Readonly<QuickpartsOfferLocators> = Object.freeze({
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

function positiveNumber(text: string | null): number | null {
  if (!text || !/^\d+(?:\.\d{1,2})?$/.test(text.trim())) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positivePrice(text: string | null, format: QuickpartsOfferLocators["priceFormat"]): number | null {
  if (format === "plain" || !text) return positiveNumber(text);
  const match = /^\$?\s?(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?$/.exec(text.trim());
  return match ? positiveNumber(`${match[1].replaceAll(",", "")}${match[2] ?? ""}`) : null;
}

/**
 * Reads anchored option cards. Rejects options whose unit/total cents or
 * quantity product are not safe integers; accepted prices must agree within
 * one cent and match the requested quantity. Any malformed option withholds
 * the entire batch to avoid incomplete comparisons.
 */
async function extractQuickpartsOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
  locators: QuickpartsOfferLocators,
  rawPayload: Record<string, unknown>,
): Promise<ProviderPortalOfferCandidate[]> {
  const count = await reader.count(locators.card);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) return [];
  const offers: ProviderPortalOfferCandidate[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const container = `${locators.card} >> nth=${index}`;
    const field = (name: keyof QuickpartsOfferLocators["fields"]) =>
      `${container}${locators.fieldJoin}${locators.fields[name]}`;
    const read = (name: keyof QuickpartsOfferLocators["fields"]) => reader.readText(field(name));
    const id = await reader.readAttribute(container, locators.optionIdAttribute);
    const label = (await read("label"))?.trim();
    const quantity = positiveNumber(await read("quantity"));
    const unit = positivePrice(await read("unitPrice"), locators.priceFormat);
    const total = positivePrice(await read("totalPrice"), locators.priceFormat);
    const currency = (await read("currency"))?.trim();
    if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) return [];
    ids.add(id);
    if (!label || quantity !== expectedQuantity || !Number.isSafeInteger(quantity)
      || unit === null || total === null || currency !== "USD") return [];
    const unitCents = Math.round(unit * 100);
    const totalCents = Math.round(total * 100);
    const expectedTotalCents = unitCents * quantity;
    if (!Number.isSafeInteger(unitCents) || !Number.isSafeInteger(totalCents)
      || !Number.isSafeInteger(expectedTotalCents)) return [];
    if (Math.abs(expectedTotalCents - totalCents) > 1) return [];
    const leadText = (await read("leadBusinessDays"))?.trim() ?? "";
    // Check integer syntax before conversion can round a fractional large value.
    const lead = /^\d+(?:\.0{1,2})?$/.test(leadText) ? positiveNumber(leadText) : null;
    const leadTimeBusinessDays = lead !== null && Number.isSafeInteger(lead) ? lead : null;
    offers.push({
      providerOptionId: id, providerLabel: label, quoteRef: null, quoteUrl: null, quantity,
      unitPriceUsd: { value: unit, source: "selector", selector: field("unitPrice") },
      totalPriceUsd: { value: total, source: "selector", selector: field("totalPrice") },
      leadTimeBusinessDays: {
        value: leadTimeBusinessDays,
        source: leadTimeBusinessDays === null ? "none" : "selector",
        selector: leadTimeBusinessDays === null ? null : field("leadBusinessDays"),
      },
      containerSelector: container, providerOptionIdSource: "attribute",
      shipReceiveBy: null, tier: null, sourcing: null,
      geographicOrigin: null, geographicOriginSource: "none",
      validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null,
      rawPayload: { ...rawPayload, locatorRevision: locators.revision },
    });
  }
  return offers;
}

/** Exercises proposed option anchors against synthetic readers, never a live portal. */
export async function extractQuickpartsSyntheticOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
): Promise<ProviderPortalOfferCandidate[]> {
  return extractQuickpartsOffers(reader, expectedQuantity, SYNTHETIC_LOCATORS, {
    fixtureKind: "synthetic", adapterRevision: QUICKPARTS_ADAPTER_REVISION,
  });
}

/** Reads production option cards through the reviewed locator table. */
export async function extractQuickpartsProductionOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
): Promise<ProviderPortalOfferCandidate[]> {
  return extractQuickpartsOffers(reader, expectedQuantity, QUICKPARTS_PRODUCTION_LOCATORS, {
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
