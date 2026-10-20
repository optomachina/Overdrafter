import { VendorAutomationError } from "../types.js";
import {
  assessOshcutEligibility,
  OSHCUT_ENVELOPE_REVISION,
  OSHCUT_PROVIDER_ENVELOPE,
  resolveOshcutThicknessLabel,
} from "./oshcut.js";
import { cleanupOshcutCart, OSHCUT_CART_CLEANUP_SELECTORS } from "./oshcutCartCleanup.js";
import { OSHCUT_DISPATCH_ENVELOPE } from "./oshcutDispatchAuthorization.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  type ProviderPortalConfigurationCapability,
  type ProviderPortalDefinition,
  type ProviderPortalEligibility,
  type ProviderPortalOfferCandidate,
  type ProviderPortalReadCapability,
  type ProviderPortalSnapshot,
} from "./providerPortalKernel.js";

export const OSHCUT_PRODUCTION_ADAPTER_REVISION = "oshcut-production-adapter.v2";

/**
 * The quoting app origin, confirmed by the authenticated capture of
 * 2026-10-15 (no other host was observed). The kernel aborts every other
 * request, so the governed egress contract pins the same list.
 */
export const OSHCUT_ALLOWED_HOSTS = ["app.oshcut.com"] as const;

/**
 * OVD-677 production locator table, revised from the authenticated capture of
 * 2026-10-15 and pinned by the browser fixture in
 * `oshcutProductionPortal.browser.test.ts`. OSH Cut prices one cart row: the
 * single and extended price cells read `-` until material and thickness are
 * set. Any drift ends in `selector_drift` and never in an inferred price. A
 * changed table needs a new revision.
 */
export const OSHCUT_PRODUCTION_LOCATORS = Object.freeze({
  revision: "oshcut-production-locators.v2",
  singlePrice: ".cartSinglePrice",
  extendedPrice: ".cartExtendedPrice",
});

/** The only material in the OSH Cut envelope, as the material slideover labels it. */
export const OSHCUT_PRODUCTION_MATERIAL_LABEL = "6061 T6 Aluminum" as const;

/**
 * Configuration controls from the capture. The kernel refuses configuration
 * selectors that mention the cart, so the "Select material" link
 * (`.cartInformationArea span.error.link`) is anchored on its own text.
 */
export const OSHCUT_PRODUCTION_SELECTORS = Object.freeze({
  cadUpload: "input[type='file']",
  quantity: ".cartQuantity input.input",
  configuration: Object.freeze({
    openMaterial: Object.freeze({ selector: "span.error.link:text-is('Select material')", operation: "click" as const }),
    materialFilter: Object.freeze({ selector: ".Slideover .filterItem", operation: "click" as const }),
    thicknessFilter: Object.freeze({ selector: ".Slideover .filterItem", operation: "click" as const }),
  }),
});

/** Bounded waits for asynchronously rendered cart controls and prices. */
export const OSHCUT_CONTROL_WAIT_MS = 15_000;
export const OSHCUT_PRICE_WAIT_MS = 30_000;
const OSHCUT_POLL_INTERVAL_MS = 250;

const OSHCUT_TERMINAL_SIGNALS: ProviderPortalDefinition["terminalSignals"] = {
  login: [/\b(?:log ?in|sign[ -]?in|session expired)\b/i],
  captcha: [/captcha|verify you are human|security check/i],
  manualReview: [/manual review|engineering review|requires review/i],
  // The cart row's "Select material" link on its own line, not the open
  // slideover heading ("Select Material - <file>").
  configurationRequired: [/^[ \t\u00a0]*select material[ \t\u00a0]*$/im, /configure (?:your )?part/i],
  unavailable: [/service unavailable|maintenance/i],
};

/**
 * The logged-out header renders a "Sign In" control that opens the sign-in
 * modal. Matched case-sensitively, as the control labels itself; the header
 * text may run into it without a separator.
 */
const OSHCUT_SIGN_IN_CONTROL = /Sign In\b/;

/** A `$` amount, optionally suffixed `USD`; `-` (not priced yet) never matches. */
const OSHCUT_USD_PRICE = /^\$\s?(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?(?:\s?USD)?$/;

function drift(reason: string): VendorAutomationError {
  return new VendorAutomationError(`OSH Cut configuration stopped: ${reason}.`, "selector_failure", {
    vendor: "oshcut",
    terminalState: "selector_drift",
    reason,
    providerMutationPossible: true,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Polls `attempt` until it returns true or the bound elapses. */
async function within(budgetMs: number, attempt: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  const poll = async (): Promise<boolean> => {
    if (await attempt()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(OSHCUT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    return poll();
  };
  return poll();
}

function usdCents(text: string | null): number | null {
  const match = text ? OSHCUT_USD_PRICE.exec(text.trim()) : null;
  if (!match) return null;
  const cents = Math.round(Number(`${match[1].replaceAll(",", "")}${match[2] ?? ""}`) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

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

/**
 * Reads the single cart row's price cells. `-` means "not priced yet": the
 * read is repeated within `priceWaitMs` and then stops in `selector_drift`
 * (`oshcut_price_pending`); `-` is never parsed. More than one priced row,
 * a non-`$` amount, or a single price times quantity that disagrees with the
 * extended price by more than one cent withholds the offer. USD only.
 */
export async function extractOshcutProductionOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
  priceWaitMs: number = OSHCUT_PRICE_WAIT_MS,
): Promise<ProviderPortalOfferCandidate[]> {
  const { singlePrice, extendedPrice } = OSHCUT_PRODUCTION_LOCATORS;
  let texts: { single: string; extended: string } | null = null;
  let pending = false;
  await within(priceWaitMs, async () => {
    const [singles, extendeds] = [await reader.readTexts(singlePrice), await reader.readTexts(extendedPrice)];
    if (singles.length !== 1 || extendeds.length !== 1) {
      pending = false;
      return singles.length > 1 || extendeds.length > 1;
    }
    const [single, extended] = [singles[0].trim(), extendeds[0].trim()];
    pending = single === "-" || extended === "-" || single === "" || extended === "";
    if (pending) return false;
    texts = { single, extended };
    return true;
  });
  if (!texts) {
    if (pending) throw drift("oshcut_price_pending");
    return [];
  }
  const { single, extended } = texts as { single: string; extended: string };
  const unitCents = usdCents(single);
  const totalCents = usdCents(extended);
  if (unitCents === null || totalCents === null || !Number.isSafeInteger(expectedQuantity) || expectedQuantity < 1) {
    return [];
  }
  const expectedTotalCents = unitCents * expectedQuantity;
  if (!Number.isSafeInteger(expectedTotalCents) || Math.abs(expectedTotalCents - totalCents) > 1) return [];
  return [{
    providerOptionId: "cart",
    providerLabel: "OSH Cut cart price",
    quoteRef: null,
    quoteUrl: null,
    quantity: expectedQuantity,
    unitPriceUsd: { value: unitCents / 100, source: "selector", selector: singlePrice },
    totalPriceUsd: { value: totalCents / 100, source: "selector", selector: extendedPrice },
    leadTimeBusinessDays: { value: null, source: "none", selector: null },
    containerSelector: singlePrice,
    providerOptionIdSource: "provider_label",
    shipReceiveBy: null, tier: null, sourcing: null,
    geographicOrigin: null, geographicOriginSource: "none",
    validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null,
    rawPayload: {
      adapterRevision: OSHCUT_PRODUCTION_ADAPTER_REVISION,
      locatorRevision: OSHCUT_PRODUCTION_LOCATORS.revision,
    },
  }];
}

/**
 * Opens the material slideover and checks the reviewed material and thickness
 * filters. The kernel has already filled the quantity. A missing control
 * stops in `selector_drift` rather than quote a portal default; an unknown
 * thickness stops in `configuration_required` (the adapter refuses that case
 * before upload, so this is a second line).
 */
export async function configureOshcutCart(
  configuration: ProviderPortalConfigurationCapability,
  input: Parameters<typeof resolveOshcutThicknessLabel>[0],
  controlWaitMs: number = OSHCUT_CONTROL_WAIT_MS,
): Promise<void> {
  const thickness = resolveOshcutThicknessLabel(input);
  if (!thickness) {
    throw new VendorAutomationError("OSH Cut sheet thickness is not recorded.", "unexpected_ui_state", {
      vendor: "oshcut",
      terminalState: "configuration_required",
      reason: "oshcut_thickness_unknown",
      providerMutationPossible: true,
    });
  }
  if (!(await within(controlWaitMs, () => configuration.click("openMaterial")))) {
    throw drift("oshcut_material_control_missing");
  }
  if (!(await within(controlWaitMs, () => configuration.click("materialFilter", OSHCUT_PRODUCTION_MATERIAL_LABEL)))) {
    throw drift("oshcut_material_option_missing");
  }
  if (!(await within(controlWaitMs, () => configuration.click("thicknessFilter", thickness)))) {
    throw drift("oshcut_thickness_option_missing");
  }
}

/** Exact origin first, then CAPTCHA, then the logged-out header control or "session expired". */
export function classifyOshcutPortalState(snapshot: ProviderPortalSnapshot) {
  if (!isAllowedProviderUrl(snapshot.url, OSHCUT_ALLOWED_HOSTS)) return "unexpected_origin" as const;
  const state = classifyProviderPortalSnapshot(snapshot, OSHCUT_TERMINAL_SIGNALS);
  if (state === "captcha") return state;
  if (OSHCUT_SIGN_IN_CONTROL.test(snapshot.bodyText) || /\bsession expired\b/i.test(snapshot.bodyText)) {
    return "login_required" as const;
  }
  return state;
}

export type OshcutProductionPortalOptions = {
  /** Test seams; production uses the reviewed defaults. */
  controlWaitMs?: number;
  priceWaitMs?: number;
};

/**
 * OVD-677 production definition. It is default-off: the production registry
 * builds it only for a worker listing `oshcut` in WORKER_LIVE_ADAPTERS, and the
 * kernel launches only behind a current generic provider-dispatch
 * authorization for the reviewed `oshcut-quote-envelope.v1`, bound to the
 * staged CAD bytes, which needs an approved admission. The envelope is
 * flat-sheet laser cutting in Aluminum 6061-T6 at a reviewed thickness, one
 * CAD file, no drawing, quantities 1–10,000; anything else, and every
 * non-ready portal state, ends in a finite terminal state. Offers are USD only.
 */
export function buildOshcutProductionPortalDefinition(
  options: OshcutProductionPortalOptions = {},
): ProviderPortalDefinition {
  const controlWaitMs = options.controlWaitMs ?? OSHCUT_CONTROL_WAIT_MS;
  const priceWaitMs = options.priceWaitMs ?? OSHCUT_PRICE_WAIT_MS;
  return {
    provider: "oshcut",
    displayName: "OSH Cut",
    manifestRevision: "provider-manifest.v1",
    envelopeRevision: OSHCUT_ENVELOPE_REVISION,
    adapterRevision: OSHCUT_PRODUCTION_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    // `/login` only redirects to `/cart`; sign-in is a header modal, so the
    // session is judged on the cart page itself. Upload lands on
    // `/cart/O-<uuid>` (and `/cart/O-<uuid>/P-<uuid>`), all on the same host.
    routes: {
      publicUrl: "https://app.oshcut.com/cart",
      loginUrl: "https://app.oshcut.com/cart",
      uploadUrl: "https://app.oshcut.com/cart",
    },
    allowedHosts: OSHCUT_ALLOWED_HOSTS,
    selectors: {
      cadUpload: OSHCUT_PRODUCTION_SELECTORS.cadUpload,
      quantity: OSHCUT_PRODUCTION_SELECTORS.quantity,
      quantityAwaitMs: controlWaitMs,
      configuration: { ...OSHCUT_PRODUCTION_SELECTORS.configuration },
      cleanup: { ...OSHCUT_CART_CLEANUP_SELECTORS },
    },
    supportedFileExtensions: [...OSHCUT_PROVIDER_ENVELOPE.supportedFileExtensions],
    terminalSignals: OSHCUT_TERMINAL_SIGNALS,
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    productionDispatch: { envelope: { ...OSHCUT_DISPATCH_ENVELOPE } },
    hooks: {
      // The kernel has already refused files outside the envelope and any
      // drawing, and re-checked the authorization, before this hook runs.
      assessEligibility: assessOshcutProductionEligibility,
      configure: (configuration, input) => configureOshcutCart(configuration, input, controlWaitMs),
      classifyPortalState: classifyOshcutPortalState,
      extractOffers: (reader, input) => extractOshcutProductionOffers(reader, input.requestedQuantity, priceWaitMs),
      // Standing rule: the uploaded test part leaves the cart once captured.
      cleanup: cleanupOshcutCart,
    },
  };
}
