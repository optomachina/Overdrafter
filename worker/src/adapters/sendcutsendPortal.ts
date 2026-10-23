import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import { VendorAutomationError, type VendorArtifact, type VendorQuoteAdapterInput } from "../types.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  type ProviderPortalConfigurationCapability,
  type ProviderPortalDefinition,
  type ProviderPortalEligibility,
  type ProviderPortalOfferCandidate,
  type ProviderPortalReadCapability,
  type ProviderPortalSnapshot,
  type ProviderPortalState,
} from "./providerPortalKernel.js";
import { inspectSendCutSendStepGeometry, SENDCUTSEND_CNC_ENVELOPE } from "./sendcutsendEnvelope.js";

export const SENDCUTSEND_SHEET_ADAPTER_REVISION = "sendcutsend-sheet-portal.v1";
export const SENDCUTSEND_SHEET_ENVELOPE_REVISION = "sendcutsend-sheet-envelope.v1";

const SENDCUTSEND_APP_HOST = "app.sendcutsend.com";

/**
 * Hosts the quote page needs, from the anonymous capture of 2026-10-22: the
 * Rails app itself, and Ably realtime, which the page calls on load (a token
 * POST and a WebSocket). The kernel treats either as a boundary violation
 * unless it is listed, and the operator approval names every host here.
 */
export const SENDCUTSEND_ALLOWED_HOSTS = [SENDCUTSEND_APP_HOST, "main.realtime.ably.net"] as const;

/** SendCutSend's own CDN serves the page's stylesheets, fonts and images; body-less requests only. */
export const SENDCUTSEND_OFF_HOST_ALLOWLIST = ["cdn.sendcutsend.com"] as const;

/** The hash-routed quote page. Sign-in is a header modal on the same page. */
export const SENDCUTSEND_QUOTE_URL = "https://app.sendcutsend.com/customer#/quote";

/**
 * OVD-1056 quote-only sheet envelope: one flat STEP plate, laser cut from
 * 6061-T6 aluminum at 0.125 in, no drawing. Anything else is refused before
 * the browser launches. The quantity cap is the evaluated range, not a
 * SendCutSend limit.
 */
export const SENDCUTSEND_SHEET_ENVELOPE = Object.freeze({
  revision: SENDCUTSEND_SHEET_ENVELOPE_REVISION,
  process: "sheet_laser_cutting",
  geometryFamily: "flat_sheet",
  material: SENDCUTSEND_CNC_ENVELOPE.material,
  materialAliases: SENDCUTSEND_CNC_ENVELOPE.materialAliases,
  thicknessInch: 0.125,
  /** The model's thinnest bounding dimension may differ from the stock by at most this much. */
  thicknessToleranceInch: 0.001,
  fileExtensions: ["step", "stp"],
  quantity: Object.freeze({ minimum: 1, maximum: 100 }),
  drawingUpload: false,
});

/**
 * The only stock the envelope quotes, as SendCutSend's public material
 * catalog names it (GET /materials and /material_groups, 2026-10-22). Only
 * the sheet SKU renders a bare thickness headline (".125"); tube tiles show
 * a width with an inch mark and billet tiles a name. The radio's value is a
 * Vue DOM property, not an attribute, so the tile title is the anchor.
 */
export const SENDCUTSEND_SHEET_STOCK = Object.freeze({
  sku: "ALU6061-125",
  productionMethod: "Sheet Cutting",
  group: "Metals",
  category: "Aluminum",
  type: "6061 T6 Aluminum",
  thickness: ".125",
});

/**
 * Read locators for the quote wizard's thickness step and side summary,
 * taken from the customer bundle of 2026-10-22. The summary shows the unit
 * price (`/ea`) and subtotal of the selected stock at the current quantity;
 * no cart item is needed. A changed table needs a new revision.
 */
export const SENDCUTSEND_SHEET_LOCATORS = Object.freeze({
  revision: "sendcutsend-sheet-locators.v1",
  skuTitles: ".material-skus .tile-sku p.title",
  disabledSkuTitles: ".material-skus .tile-sku.is-disabled p.title",
  selectedSkuTitles: ".material-skus .tile-sku.selected:has(input[type='radio']:checked) p.title",
  summary: ".post-processing-summary-container",
  unitPrice: ".post-processing-summary-container .price__each .currency .cash",
  subtotal: ".post-processing-summary-container .subtotal__summary",
  totalPrice: ".post-processing-summary-container .subtotal__summary .subtotal .currency .cash",
  shipDate: ".est-ship-date p",
  quoteDialog: ".modal-card .quote-footer",
});

/**
 * Wizard controls. Each step replaces the previous one, so a step's tiles
 * exist only while it is current. None of these reach the cart: the footer
 * buttons ("Next", "Add to Cart") are deliberately not declared.
 */
export const SENDCUTSEND_SHEET_SELECTORS = Object.freeze({
  cadUpload: "input[type='file']",
  configuration: Object.freeze({
    productionMethod: Object.freeze({ selector: ".select-tile p.has-text-weight-bold", operation: "click" as const }),
    materialGroup: Object.freeze({ selector: ".select-material-group p.title", operation: "click" as const }),
    materialCategory: Object.freeze({ selector: ".select-material-category p.title", operation: "click" as const }),
    materialType: Object.freeze({ selector: ".select-material-type p.title", operation: "click" as const }),
    thickness: Object.freeze({ selector: ".material-skus .tile-sku label.b-radio p.title", operation: "click" as const }),
    quantity: Object.freeze({ selector: ".post-processing-summary-container .quantity__input input", operation: "fill" as const }),
  }),
});

/** Upload, STEP conversion and pricing run server-side, so the first wizard step can take a while. */
export const SENDCUTSEND_PROCESSING_WAIT_MS = 120_000;
export const SENDCUTSEND_CONTROL_WAIT_MS = 15_000;
export const SENDCUTSEND_PRICE_WAIT_MS = 30_000;
const SENDCUTSEND_POLL_INTERVAL_MS = 500;
/** Repeated clicks of one step are harmless re-selections; a step that never advances is not. */
const SENDCUTSEND_MAX_CLICKS_PER_STEP = 3;

const SENDCUTSEND_TERMINAL_SIGNALS: ProviderPortalDefinition["terminalSignals"] = {
  login: [/\b(?:log ?in|sign[ -]?in)\b/i],
  captcha: [/captcha|verify you are human|checking your browser/i],
  manualReview: [/contact us for a custom quote/i],
  configurationRequired: [/some of your parts require material selection/i],
  unavailable: [/service unavailable|scheduled maintenance|down for maintenance/i],
};

/** The logged-out header renders a "LOGIN" link on a line of its own. */
const SENDCUTSEND_LOGGED_OUT_HEADER = /^[ \t\u00a0]*log ?in[ \t\u00a0]*$/im;

/** A formatted en-US USD amount, as SendCutSend's Currency component renders it. */
const SENDCUTSEND_USD = /^\$(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/;

/** "Ships as soon as: Oct 28" or "Arrives as soon as: Oct 30" (no year). */
const SENDCUTSEND_SHIP_DATE = /^(Ships|Arrives) as soon as:\s*([A-Z][a-z]{2} \d{1,2})$/;

function terminal(
  terminalState: "selector_drift" | "configuration_required" | "manual_review",
  reason: string,
  message: string,
): VendorAutomationError {
  return new VendorAutomationError(`SendCutSend quote stopped: ${message}.`, terminalState === "selector_drift"
    ? "selector_failure"
    : "unexpected_ui_state", {
    vendor: "sendcutsend",
    terminalState,
    reason,
    providerMutationPossible: true,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Polls `attempt` until it returns true or the bound elapses. */
async function within(
  budgetMs: number,
  attempt: () => Promise<boolean>,
  pollMs: number = SENDCUTSEND_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await attempt()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

export type SendCutSendWaits = {
  processingWaitMs?: number;
  controlWaitMs?: number;
  priceWaitMs?: number;
  pollIntervalMs?: number;
};

function usdCents(text: string | null | undefined): number | null {
  const match = text ? SENDCUTSEND_USD.exec(text.trim()) : null;
  if (!match) return null;
  const cents = Number(match[1].replaceAll(",", "")) * 100 + Number(match[2]);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extensionOf(fileName: string) {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * Admits only the reviewed sheet envelope, and binds the declared 0.125 in
 * thickness to the authorized CAD bytes: the STEP must be one planar solid
 * whose thinnest bounding dimension is the stock thickness. A bent part has
 * no such dimension, so it is refused here rather than quoted flat.
 */
export function assessSendCutSendSheetEligibility(input: VendorQuoteAdapterInput): ProviderPortalEligibility {
  const envelope = SENDCUTSEND_SHEET_ENVELOPE;
  const spec = isRecord(input.requirement.spec_snapshot) ? input.requirement.spec_snapshot : {};
  if (spec.process !== envelope.process || spec.geometryFamily !== envelope.geometryFamily) {
    return { state: "unsupported", reason: "sendcutsend_process_outside_sheet_envelope" };
  }
  if (!(envelope.materialAliases as readonly string[]).includes(input.requirement.material)) {
    return { state: "unsupported", reason: "sendcutsend_material_outside_sheet_envelope" };
  }
  if (spec.sheetThicknessInch !== envelope.thicknessInch) {
    return { state: "unsupported", reason: "sendcutsend_thickness_outside_sheet_envelope" };
  }
  const quantity = input.requestedQuantity;
  if (!Number.isSafeInteger(quantity) || quantity < envelope.quantity.minimum || quantity > envelope.quantity.maximum) {
    return { state: "unsupported", reason: "sendcutsend_quantity_outside_sheet_envelope" };
  }
  const files = getAuthorizedLiveEvaluationFiles(input);
  if (!files || files.drawing) {
    return { state: "unsupported", reason: "sendcutsend_sheet_files_outside_envelope" };
  }
  if (!(envelope.fileExtensions as readonly string[]).includes(extensionOf(files.cad.name))) {
    return { state: "unsupported", reason: "sendcutsend_file_type_outside_sheet_envelope" };
  }
  const geometry = inspectSendCutSendStepGeometry({ fileName: files.cad.name, buffer: files.cad.buffer });
  if (!geometry?.dimensions || geometry.units === "unsupported" || geometry.solidBodyCount !== 1) {
    return { state: "unsupported", reason: "sendcutsend_sheet_geometry_unverified" };
  }
  const inchesPerUnit = geometry.units === "millimeter" ? 1 / 25.4 : 1;
  const thinnest = Math.min(...geometry.dimensions) * inchesPerUnit;
  if (!Number.isFinite(thinnest) || Math.abs(thinnest - envelope.thicknessInch) > envelope.thicknessToleranceInch) {
    return { state: "unsupported", reason: "sendcutsend_geometry_thickness_mismatch" };
  }
  return { state: "eligible", reason: "sendcutsend_sheet_envelope_match" };
}

/**
 * What this run's wizard walk actually clicked. The thickness tiles show
 * only a thickness, so the stock is proven by the exact type tile clicked
 * in the same run followed by the exact thickness tile.
 */
export type SendCutSendWizardWalk = {
  typeSelected: boolean;
  thicknessSelected: boolean;
};

export function newSendCutSendWizardWalk(): SendCutSendWizardWalk {
  return { typeSelected: false, thicknessSelected: false };
}

/**
 * Walks the quote wizard to the reviewed stock: production method, material
 * group, category, type, then the thickness tile, and sets the quantity in
 * the side summary. The deepest visible step is tried first; each wizard
 * step replaces the last, so at most one matches at a time. A step that
 * never appears ends the walk without a guess; the offer reader then decides
 * between `configuration_required` and `selector_drift`.
 */
export async function configureSendCutSendSheet(
  configuration: ProviderPortalConfigurationCapability,
  input: Pick<VendorQuoteAdapterInput, "requestedQuantity">,
  walk: SendCutSendWizardWalk,
  waits: SendCutSendWaits = {},
): Promise<void> {
  const stock = SENDCUTSEND_SHEET_STOCK;
  const steps: Array<[field: string, text: string]> = [
    ["thickness", stock.thickness],
    ["materialType", stock.type],
    ["materialCategory", stock.category],
    ["materialGroup", stock.group],
    ["productionMethod", stock.productionMethod],
  ];
  const clicks = new Map<string, number>();
  await within(waits.processingWaitMs ?? SENDCUTSEND_PROCESSING_WAIT_MS, async () => {
    for (const [field, text] of steps) {
      if ((clicks.get(field) ?? 0) >= SENDCUTSEND_MAX_CLICKS_PER_STEP) continue;
      if (await configuration.click(field, text)) {
        clicks.set(field, (clicks.get(field) ?? 0) + 1);
        if (field === "materialType") walk.typeSelected = true;
        // A thickness picked from a type this run did not choose proves nothing.
        if (field === "thickness") walk.thicknessSelected = walk.typeSelected;
        return field === "thickness";
      }
    }
    return false;
  }, waits.pollIntervalMs);
  if (!walk.thicknessSelected) return;
  const quantity = String(input.requestedQuantity);
  const filled = await within(
    waits.controlWaitMs ?? SENDCUTSEND_CONTROL_WAIT_MS,
    () => configuration.fill("quantity", quantity),
    waits.pollIntervalMs,
  );
  if (!filled) {
    throw terminal("selector_drift", "sendcutsend_quantity_control_missing", "the quantity control did not appear");
  }
}

function trimmedTexts(texts: readonly string[]) {
  return texts.map((text) => text.replace(/\s+/g, " ").trim());
}

async function assertExactStockSelected(
  reader: ProviderPortalReadCapability,
  walk: SendCutSendWizardWalk,
): Promise<void> {
  const locators = SENDCUTSEND_SHEET_LOCATORS;
  const thickness = SENDCUTSEND_SHEET_STOCK.thickness;
  const selected = trimmedTexts(await reader.readTexts(locators.selectedSkuTitles));
  if (walk.thicknessSelected && selected.length === 1 && selected[0] === thickness) return;
  if (trimmedTexts(await reader.readTexts(locators.disabledSkuTitles)).includes(thickness)) {
    throw terminal("configuration_required", "sendcutsend_thickness_unavailable", "6061-T6 at 0.125 in is not selectable for this part");
  }
  const offered = trimmedTexts(await reader.readTexts(locators.skuTitles));
  if (walk.typeSelected && offered.length > 0 && !offered.includes(thickness)) {
    throw terminal("configuration_required", "sendcutsend_thickness_not_offered", "6061-T6 at 0.125 in is not offered for this part");
  }
  throw terminal("selector_drift", "sendcutsend_material_path_incomplete", "the 6061-T6 0.125 in stock was not reached");
}

type SummaryRead =
  | { kind: "priced"; unit: string; total: string }
  | { kind: "pending" }
  | { kind: "ambiguous" }
  | { kind: "custom" };

async function readSummary(reader: ProviderPortalReadCapability): Promise<SummaryRead> {
  const locators = SENDCUTSEND_SHEET_LOCATORS;
  const [units, totals] = [await reader.readTexts(locators.unitPrice), await reader.readTexts(locators.totalPrice)];
  if (units.length > 1 || totals.length > 1) return { kind: "ambiguous" };
  if (units.length === 1 && totals.length === 1) {
    const [unit, total] = [units[0].trim(), totals[0].trim()];
    return usdCents(unit) !== null && usdCents(total) !== null ? { kind: "priced", unit, total } : { kind: "pending" };
  }
  const subtotal = await reader.readText(locators.subtotal);
  return subtotal && /custom quote/i.test(subtotal) ? { kind: "custom" } : { kind: "pending" };
}

function parseShipDate(text: string | null): { qualifier: "ships" | "arrives"; date: string } | null {
  const match = text ? SENDCUTSEND_SHIP_DATE.exec(text.replace(/\s+/g, " ").trim()) : null;
  return match ? { qualifier: match[1] === "Ships" ? "ships" : "arrives", date: match[2] } : null;
}

/**
 * Reads the side summary for the exact stock. The price must read the same
 * on two consecutive polls (the summary reprices asynchronously), the unit
 * price times the quantity must equal the subtotal to the cent, and the SKU
 * must still be the checked one afterwards. Anything else withholds the
 * offer. USD only. SendCutSend shows a ship date, not a duration, so the
 * lead time stays null and the date is kept as `shipReceiveBy`.
 */
export async function extractSendCutSendSheetOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
  walk: SendCutSendWizardWalk,
  waits: SendCutSendWaits = {},
): Promise<ProviderPortalOfferCandidate[]> {
  const locators = SENDCUTSEND_SHEET_LOCATORS;
  await assertExactStockSelected(reader, walk);
  let previous: string | null = null;
  let settled: { unit: string; total: string } | null = null;
  let last: SummaryRead = { kind: "pending" };
  await within(waits.priceWaitMs ?? SENDCUTSEND_PRICE_WAIT_MS, async () => {
    last = await readSummary(reader);
    if (last.kind === "ambiguous" || last.kind === "custom") return true;
    if (last.kind !== "priced") {
      previous = null;
      return false;
    }
    const key = `${last.unit}|${last.total}`;
    if (previous === key) {
      settled = { unit: last.unit, total: last.total };
      return true;
    }
    previous = key;
    return false;
  }, waits.pollIntervalMs);
  const outcome = last as SummaryRead;
  if (outcome.kind === "custom") {
    throw terminal("manual_review", "sendcutsend_custom_quote", "SendCutSend asks for a custom quote");
  }
  if (outcome.kind === "ambiguous") {
    throw terminal("selector_drift", "sendcutsend_price_ambiguous", "more than one price is shown");
  }
  if (!settled) {
    throw terminal("selector_drift", "sendcutsend_price_pending", "the price did not settle");
  }
  const { unit, total } = settled as { unit: string; total: string };
  const unitCents = usdCents(unit);
  const totalCents = usdCents(total);
  if (unitCents === null || totalCents === null || !Number.isSafeInteger(expectedQuantity) || expectedQuantity < 1
    || unitCents * expectedQuantity !== totalCents) {
    throw terminal("selector_drift", "sendcutsend_price_arithmetic_mismatch", "the unit price and subtotal disagree");
  }
  await assertExactStockSelected(reader, walk);
  const shipDate = parseShipDate(await reader.readText(locators.shipDate));
  return [{
    providerOptionId: SENDCUTSEND_SHEET_STOCK.sku,
    providerLabel: `SendCutSend ${SENDCUTSEND_SHEET_STOCK.type} ${SENDCUTSEND_SHEET_STOCK.thickness} in sheet`,
    quoteRef: null,
    quoteUrl: null,
    quantity: expectedQuantity,
    unitPriceUsd: { value: unitCents / 100, source: "selector", selector: locators.unitPrice },
    totalPriceUsd: { value: totalCents / 100, source: "selector", selector: locators.totalPrice },
    leadTimeBusinessDays: { value: null, source: "none", selector: null },
    containerSelector: locators.summary,
    providerOptionIdSource: "provider_label",
    shipReceiveBy: shipDate?.date ?? null,
    tier: null,
    sourcing: null,
    geographicOrigin: null,
    geographicOriginSource: "none",
    validUntil: null,
    validityDurationDays: null,
    validitySource: null,
    validityTerms: null,
    rawPayload: {
      adapterRevision: SENDCUTSEND_SHEET_ADAPTER_REVISION,
      locatorRevision: locators.revision,
      shipDateQualifier: shipDate?.qualifier ?? null,
    },
  }];
}

/** Exact app origin first, then CAPTCHA, then the logged-out header or an expired session. */
export function classifySendCutSendPortalState(snapshot: ProviderPortalSnapshot): ProviderPortalState {
  if (!isAllowedProviderUrl(snapshot.url, [SENDCUTSEND_APP_HOST])) return "unexpected_origin";
  const state = classifyProviderPortalSnapshot(snapshot, SENDCUTSEND_TERMINAL_SIGNALS);
  if (state === "captcha") return state;
  if (SENDCUTSEND_LOGGED_OUT_HEADER.test(snapshot.bodyText) || /\bsession (?:has )?expired\b/i.test(snapshot.bodyText)) {
    return "login_required";
  }
  return state;
}

/** Never upload into a wizard or summary left open by an earlier part. */
async function refuseOpenQuoteDialog(reader: ProviderPortalReadCapability): Promise<void> {
  const locators = SENDCUTSEND_SHEET_LOCATORS;
  if (await reader.count(locators.quoteDialog) > 0 || await reader.count(locators.summary) > 0) {
    throw new VendorAutomationError("SendCutSend quote dialog already open; manual attention required.", "unexpected_ui_state", {
      vendor: "sendcutsend",
      terminalState: "manual_review",
      reason: "sendcutsend_quote_dialog_already_open",
      providerMutationPossible: false,
    });
  }
}

/** Writes operator-local, scrubbed page text for a stop the kernel captures no evidence for. */
export type SendCutSendDiagnosticWriter = (diagnostic: {
  terminalState: string;
  reason: string;
  bodyText: string;
}) => Promise<VendorArtifact[]>;

export type SendCutSendSheetPortalOptions = SendCutSendWaits & {
  writeDiagnostic?: SendCutSendDiagnosticWriter;
};

/**
 * The kernel captures evidence for the states it classifies, not for a stop
 * the offer reader throws, so that stop records the page text through the
 * adapter's writer before it propagates. A writer failure never replaces it.
 */
async function extractWithDiagnostics(
  reader: ProviderPortalReadCapability,
  input: VendorQuoteAdapterInput,
  walk: SendCutSendWizardWalk,
  options: SendCutSendSheetPortalOptions,
): Promise<ProviderPortalOfferCandidate[]> {
  try {
    return await extractSendCutSendSheetOffers(reader, input.requestedQuantity, walk, options);
  } catch (error) {
    if (error instanceof VendorAutomationError && options.writeDiagnostic) {
      const bodyText = await reader.readText("body").catch(() => null) ?? "";
      const artifacts = await options.writeDiagnostic({
        terminalState: String(error.payload.terminalState),
        reason: String(error.payload.reason),
        bodyText,
      }).catch(() => []);
      error.artifacts.push(...artifacts);
    }
    throw error;
  }
}

/**
 * OVD-1056 quote-only live-evaluation definition. It has no
 * `productionDispatch`, so the kernel refuses every production input; it
 * serves only an operator-approved live evaluation of the sheet envelope
 * with Blaine's own saved session. It uploads one STEP, walks the wizard to
 * the exact stock, sets the quantity and reads the summary price. It never
 * clicks the wizard footer, so nothing reaches the cart or checkout.
 */
export function buildSendCutSendSheetPortalDefinition(
  options: SendCutSendSheetPortalOptions = {},
): ProviderPortalDefinition {
  // One walk per definition: the adapter builds a fresh definition for every attempt.
  const walk = newSendCutSendWizardWalk();
  return {
    provider: "sendcutsend",
    displayName: "SendCutSend",
    manifestRevision: "provider-manifest.v1",
    envelopeRevision: SENDCUTSEND_SHEET_ENVELOPE_REVISION,
    adapterRevision: SENDCUTSEND_SHEET_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: SENDCUTSEND_QUOTE_URL,
      loginUrl: SENDCUTSEND_QUOTE_URL,
      uploadUrl: SENDCUTSEND_QUOTE_URL,
    },
    allowedHosts: SENDCUTSEND_ALLOWED_HOSTS,
    offHostAllowlist: SENDCUTSEND_OFF_HOST_ALLOWLIST,
    selectors: {
      cadUpload: SENDCUTSEND_SHEET_SELECTORS.cadUpload,
      configuration: { ...SENDCUTSEND_SHEET_SELECTORS.configuration },
    },
    supportedFileExtensions: [...SENDCUTSEND_SHEET_ENVELOPE.fileExtensions],
    terminalSignals: SENDCUTSEND_TERMINAL_SIGNALS,
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    hooks: {
      beforeUpload: refuseOpenQuoteDialog,
      assessEligibility: assessSendCutSendSheetEligibility,
      configure: (configuration, input) => configureSendCutSendSheet(configuration, input, walk, options),
      classifyPortalState: classifySendCutSendPortalState,
      extractOffers: (reader, input) => extractWithDiagnostics(reader, input, walk, options),
    },
  };
}

type StorageStateCookie = { domain?: unknown };
type StorageStateOrigin = { origin?: unknown };

/**
 * The kernel refuses a saved session that holds any cookie or origin outside
 * the definition's exact hosts, and a manual sign-in also collects cookies
 * from analytics, chat and payment scripts. Keep only the exact-host entries
 * and report the dropped cookie domains (never names or values).
 */
export function filterSendCutSendStorageState(state: unknown): {
  state: { cookies: unknown[]; origins: unknown[] };
  keptCookies: number;
  droppedCookieDomains: string[];
} {
  const record = isRecord(state) ? state : {};
  const cookies = Array.isArray(record.cookies) ? record.cookies as StorageStateCookie[] : [];
  const origins = Array.isArray(record.origins) ? record.origins as StorageStateOrigin[] : [];
  const allowed = new Set<string>(SENDCUTSEND_ALLOWED_HOSTS);
  const cookieHost = (cookie: StorageStateCookie) => typeof cookie?.domain === "string"
    ? cookie.domain.trim().toLowerCase().replace(/^\./, "")
    : "";
  const kept = cookies.filter((cookie) => allowed.has(cookieHost(cookie)));
  const dropped = [...new Set(cookies.filter((cookie) => !allowed.has(cookieHost(cookie))).map(cookieHost))].sort();
  const keptOrigins = origins.filter((entry) => {
    if (typeof entry?.origin !== "string") return false;
    try {
      const url = new URL(entry.origin);
      return url.protocol === "https:" && allowed.has(url.hostname) && url.pathname === "/"
        && !url.search && !url.hash && !url.username && !url.password && (url.port === "" || url.port === "443");
    } catch {
      return false;
    }
  });
  return { state: { cookies: kept, origins: keptOrigins }, keptCookies: kept.length, droppedCookieDomains: dropped };
}
