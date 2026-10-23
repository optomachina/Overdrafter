import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { WEERG_DISPATCH_ENVELOPE } from "../providerDispatchEnvelope.js";
import { VendorAutomationError, type VendorQuoteAdapterInput, type WorkerConfig } from "../types.js";
import type { LocalEvidenceCurrency } from "./localEvaluationResult.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  runProviderPortalKernel,
  type ProviderPortalDefinition,
  type ProviderPortalEligibility,
  type ProviderPortalNativeOfferCandidate,
  type ProviderPortalReadCapability,
  type ProviderPortalSnapshot,
  type ProviderPortalState,
} from "./providerPortalKernel.js";
import { evaluateWeergEnvelope, WEERG_ENVELOPE_REVISION, type WeergEnvelopeInput } from "./weergEnvelope.js";

export const WEERG_ADAPTER_REVISION = "weerg-offline-preflight.v4" as const;
export const WEERG_PRODUCTION_ADAPTER_REVISION = "weerg-production-adapter.v1" as const;
export const WEERG_ALLOWED_HOSTS = ["www.weerg.com"] as const;

const WEERG_TERMINAL_SIGNALS: ProviderPortalDefinition["terminalSignals"] = {
  login: [/\b(?:login|sign in|session expired)\b/i],
  captcha: [/\b(?:captcha|verify you are human)\b/i],
  manualReview: [/\b(?:manual review|engineering review)\b/i],
  configurationRequired: [/\b(?:select material|configure part)\b/i],
  unavailable: [/\b(?:unavailable|maintenance)\b/i],
};

/**
 * Exact origin first, then CAPTCHA over mixed session-expired text, then the
 * declared terminal signals (OVD-432 v4 priorities).
 */
function classifyWeergSnapshot(snapshot: ProviderPortalSnapshot): ProviderPortalState {
  if (!isAllowedProviderUrl(snapshot.url, WEERG_ALLOWED_HOSTS)) return "unexpected_origin";
  const state = classifyProviderPortalSnapshot(snapshot, WEERG_TERMINAL_SIGNALS);
  if (state === "captcha") return state;
  if (/\bsession expired\b/i.test(snapshot.bodyText)) return "login_required";
  return state;
}

/**
 * Projects only package facts carried by the local harness. Process, account
 * access, tolerance completeness and geometry review are not inferred from a
 * filename, material, requested account mode or absent metadata.
 */
export function deriveWeergEvaluationFacts(input: VendorQuoteAdapterInput): WeergEnvelopeInput {
  return {
    process: null,
    material: input.requirement.material,
    fileName: input.stagedCadFile?.originalName ?? null,
    quantity: input.requestedQuantity,
    accountMode: null,
    drawingIncluded: Boolean(input.stagedDrawingFile),
    explicitToleranceRequirement: null,
    requestedToleranceMm: null,
    explicitGeometryRequirements: null,
    geometryWithinReviewedEnvelope: null,
  };
}

/** Binds reviewed envelope facts to the actual evaluation package without inferring unknown facts. */
export function assessWeergEvaluationPackage(
  input: VendorQuoteAdapterInput,
  facts: WeergEnvelopeInput,
): ProviderPortalEligibility {
  if (facts.quantity !== input.requestedQuantity
    || facts.fileName !== input.stagedCadFile?.originalName
    || facts.material !== input.requirement.material
    || facts.drawingIncluded !== Boolean(input.stagedDrawingFile)) {
    return { state: "unsupported", reason: "weerg_envelope_package_mismatch" };
  }
  const decision = evaluateWeergEnvelope(facts);
  if (decision.state !== "eligible_for_evaluation") {
    return {
      state: "unsupported",
      reason: `weerg_envelope_${decision.state}:${decision.reasonCodes.join(",")}`,
    };
  }
  return { state: "unavailable", reason: "weerg_reviewed_portal_binding_missing" };
}

/**
 * Inert local preflight definition. Public homepage URLs are placeholders, not
 * observed login/upload routes. No selector or portal readiness is claimed.
 * Omitted facts use the conservative local-harness projection.
 * The eligibility hook always terminates before session resolution or launch.
 */
export function createWeergPortalDefinition(facts?: WeergEnvelopeInput): ProviderPortalDefinition {
  const reviewedFacts = facts ? structuredClone(facts) : null;
  return {
    provider: "weerg",
    displayName: "Weerg",
    manifestRevision: "weerg-manifest.v1",
    envelopeRevision: WEERG_ENVELOPE_REVISION,
    adapterRevision: WEERG_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: "https://www.weerg.com/",
      loginUrl: "https://www.weerg.com/",
      uploadUrl: "https://www.weerg.com/",
    },
    allowedHosts: [...WEERG_ALLOWED_HOSTS],
    selectors: { cadUpload: ":not(*)" },
    supportedFileExtensions: ["step", "stp"],
    terminalSignals: WEERG_TERMINAL_SIGNALS,
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    hooks: {
      assessEligibility: (input) => assessWeergEvaluationPackage(input, reviewedFacts ?? deriveWeergEvaluationFacts(input)),
      configure: () => undefined,
      classifyPortalState: (snapshot) => {
        const state = classifyWeergSnapshot(snapshot);
        return state === "ready" ? "selector_drift" : state;
      },
      extractOffers: () => [],
    },
  };
}

/** Performs exact-file kernel preflight only; never produces offers or provider traffic. */
export function runWeergLocalEvaluationPreflight(
  config: WorkerConfig,
  input: VendorQuoteAdapterInput,
  facts?: WeergEnvelopeInput,
) {
  return runProviderPortalKernel(createWeergPortalDefinition(facts), config, input);
}

/**
 * OVD-675 production locator table, pinned by the browser fixture in
 * `weergProductionPortal.browser.test.ts`. It is the reviewable contract for
 * the authenticated Weerg quotation tool; the live DOM has not been captured
 * (that is a protected action), so any drift ends in `selector_drift` and
 * never in an inferred price or currency. A changed table needs a new revision.
 */
export const WEERG_PRODUCTION_LOCATORS = Object.freeze({
  revision: "weerg-production-locators.v1",
  card: "[data-weerg-quote-option-id]",
  optionIdAttribute: "data-weerg-quote-option-id",
  /** Each selector is resolved inside the indexed card. */
  fields: Object.freeze({
    label: "[data-weerg-quote-option-label]",
    quantity: "[data-weerg-quote-option-quantity]",
    unitPrice: "[data-weerg-quote-option-unit-price]",
    totalPrice: "[data-weerg-quote-option-total-price]",
    /** An ISO 4217 code (`EUR` or `USD`); a bare symbol is not a currency anchor. */
    currency: "[data-weerg-quote-option-currency]",
    leadBusinessDays: "[data-weerg-quote-option-lead-days]",
  }),
});

/** The only material in Weerg's reviewed envelope and its reviewed portal option value. */
export const WEERG_PRODUCTION_MATERIAL_OPTION = "aluminium-6082" as const;

export const WEERG_PRODUCTION_SELECTORS = Object.freeze({
  cadUpload: "input[type='file']",
  quantity: "input[name='quantity' i], input[aria-label='Quantity' i]",
  configuration: Object.freeze({
    material: Object.freeze({ selector: "select[name='material' i]", operation: "select" as const }),
  }),
});

const WEERG_QUANTITY_MAXIMUM = PROVIDER_CATALOG.weerg.capabilityEnvelope.quantity.maximum;

/** EN AW-6082 is an aluminium designation; the envelope admits nothing else. */
export function isWeergEnvelopeMaterial(material: string | null | undefined): boolean {
  return typeof material === "string" && /(?:^|\D)6082(?:\D|$)/.test(material);
}

/** Weerg anchors only these ISO codes; other local-evidence currencies never apply here. */
type WeergCurrency = Extract<LocalEvidenceCurrency, "EUR" | "USD">;

const CURRENCY_SYMBOLS: Readonly<Record<WeergCurrency, string>> = { EUR: "€", USD: "$" };

/**
 * Parses one anchored amount for an already anchored ISO currency. Accepts a
 * single leading or trailing symbol or code that agrees with that currency,
 * and either `.` or `,` as the decimal separator when it is unambiguous: two
 * decimal digits, and thousands groups that use a different separator.
 * `1.234` or `1,234` (grouping or decimals?) and any other currency marker
 * are refused, so a misread amount or currency can never become an offer.
 */
export function parseWeergAmount(text: string | null, currency: WeergCurrency): number | null {
  let value = text?.trim() ?? "";
  for (const marker of [CURRENCY_SYMBOLS[currency], currency]) {
    if (value.startsWith(marker)) value = value.slice(marker.length).trim();
    else if (value.endsWith(marker)) value = value.slice(0, -marker.length).trim();
  }
  const match = /^(\d{1,3}(?:([.,\u00a0\u202f ])\d{3})(?:\2\d{3})*|\d+)(?:([.,])(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, integer, group, decimal, cents] = match;
  if (group && (!decimal || decimal === group)) return null;
  const amount = Number(`${integer.replace(/\D/g, "")}.${cents ?? "00"}`);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function anchoredCurrency(text: string | null): WeergCurrency | null {
  const code = text?.trim();
  return code === "EUR" || code === "USD" ? code : null;
}

/**
 * Reads production option cards through the reviewed locator table as native
 * money: the amount and its ISO currency stay together and nothing is
 * converted. Every card needs an ID, a label, the exact requested quantity,
 * unit and total amounts that agree to within one cent, and an explicit ISO
 * currency. One malformed card, or cards in different currencies, withholds
 * the whole batch.
 */
export async function extractWeergProductionOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
): Promise<ProviderPortalNativeOfferCandidate[]> {
  const locators = WEERG_PRODUCTION_LOCATORS;
  const count = await reader.count(locators.card);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) return [];
  const offers: ProviderPortalNativeOfferCandidate[] = [];
  const ids = new Set<string>();
  const currencies = new Set<LocalEvidenceCurrency>();
  for (let index = 0; index < count; index += 1) {
    const container = `${locators.card} >> nth=${index}`;
    const field = (name: keyof typeof locators.fields) => `${container} >> ${locators.fields[name]}`;
    const read = (name: keyof typeof locators.fields) => reader.readText(field(name));
    const id = await reader.readAttribute(container, locators.optionIdAttribute);
    const label = (await read("label"))?.trim();
    const quantityText = (await read("quantity"))?.trim() ?? "";
    const quantity = /^\d{1,6}$/.test(quantityText) ? Number(quantityText) : null;
    const currency = anchoredCurrency(await read("currency"));
    if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id) || !label || !currency
      || quantity !== expectedQuantity) return [];
    ids.add(id);
    currencies.add(currency);
    if (currencies.size > 1) return [];
    const unit = parseWeergAmount(await read("unitPrice"), currency);
    const total = parseWeergAmount(await read("totalPrice"), currency);
    if (unit === null || total === null) return [];
    const unitCents = Math.round(unit * 100);
    const totalCents = Math.round(total * 100);
    const expectedTotalCents = unitCents * quantity;
    if (!Number.isSafeInteger(expectedTotalCents) || Math.abs(expectedTotalCents - totalCents) > 1) return [];
    const leadText = (await read("leadBusinessDays"))?.trim() ?? "";
    const lead = /^\d{1,3}$/.test(leadText) && Number(leadText) > 0 ? Number(leadText) : null;
    offers.push({
      providerOptionId: id, providerLabel: label, quoteRef: null, quoteUrl: null, quantity,
      money: {
        unitAmount: { value: unit, source: "selector", selector: field("unitPrice") },
        totalAmount: { value: total, source: "selector", selector: field("totalPrice") },
        unitCurrency: { value: currency, source: "selector", selector: field("currency") },
        totalCurrency: { value: currency, source: "selector", selector: field("currency") },
      },
      leadTimeBusinessDays: {
        value: lead,
        source: lead === null ? "none" : "selector",
        selector: lead === null ? null : field("leadBusinessDays"),
      },
      containerSelector: container, providerOptionIdSource: "attribute",
      shipReceiveBy: null, tier: null, sourcing: null,
      geographicOrigin: null, geographicOriginSource: "none",
      validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null,
      rawPayload: { adapterRevision: WEERG_PRODUCTION_ADAPTER_REVISION, locatorRevision: locators.revision },
    });
  }
  return offers;
}

/**
 * OVD-675 production definition. It is default-off: the production registry
 * builds it only for a worker listing `weerg` in WORKER_LIVE_ADAPTERS, and the
 * kernel launches only behind a current generic provider-dispatch
 * authorization for `weerg-quote-envelope.v1` bound to the staged STEP bytes.
 * The envelope covers one STEP file, no drawing, aluminium 6082 and quantities
 * 1–10,000; anything else, and every non-ready portal state, ends in a finite
 * terminal state. Offers are native money: the adapter records EUR as
 * non-comparable evidence and never converts or relabels it as USD.
 */
export function buildWeergProductionPortalDefinition(): ProviderPortalDefinition {
  return {
    provider: "weerg",
    displayName: "Weerg",
    manifestRevision: "weerg-manifest.v1",
    envelopeRevision: WEERG_ENVELOPE_REVISION,
    adapterRevision: WEERG_PRODUCTION_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: "https://www.weerg.com/",
      loginUrl: "https://www.weerg.com/",
      uploadUrl: "https://www.weerg.com/en/global/quotation-tool/upload",
    },
    allowedHosts: [...WEERG_ALLOWED_HOSTS],
    selectors: {
      cadUpload: WEERG_PRODUCTION_SELECTORS.cadUpload,
      quantity: WEERG_PRODUCTION_SELECTORS.quantity,
      configuration: { ...WEERG_PRODUCTION_SELECTORS.configuration },
    },
    supportedFileExtensions: ["step", "stp"],
    terminalSignals: WEERG_TERMINAL_SIGNALS,
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    productionDispatch: { envelope: { ...WEERG_DISPATCH_ENVELOPE } },
    hooks: {
      // The kernel has already refused files outside the STEP envelope and any
      // drawing, and re-checked the authorization, before this hook runs.
      assessEligibility: (input) => {
        if (!Number.isSafeInteger(input.requestedQuantity) || input.requestedQuantity < 1
          || input.requestedQuantity > WEERG_QUANTITY_MAXIMUM) {
          return { state: "unsupported", reason: "quantity_outside_envelope" };
        }
        if (!isWeergEnvelopeMaterial(input.requirement?.material)) {
          return { state: "unsupported", reason: "weerg_material_outside_envelope" };
        }
        return { state: "eligible", reason: "weerg_step_material_and_quantity_fit" };
      },
      // A quote for a portal-default material would be a quote for the wrong
      // part, so a missing material control stops the attempt.
      configure: async (configuration) => {
        if (!(await configuration.select("material", WEERG_PRODUCTION_MATERIAL_OPTION))) {
          throw new VendorAutomationError("Weerg material control is missing.", "selector_failure", {
            vendor: "weerg",
            terminalState: "selector_drift",
            reason: "weerg_material_control_missing",
            providerMutationPossible: true,
          });
        }
      },
      classifyPortalState: classifyWeergSnapshot,
      extractOffers: (reader, input) => extractWeergProductionOffers(reader, input.requestedQuantity),
    },
  };
}
