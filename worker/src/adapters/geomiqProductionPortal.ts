import { VendorAutomationError, type VendorQuoteAdapterInput } from "../types.js";
import { GEOMIQ_DISPATCH_ENVELOPE } from "./geomiqDispatchAuthorization.js";
import { GEOMIQ_ENVELOPE_REVISION } from "./geomiqEnvelope.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  type ProviderPortalConfigurationCapability,
  type ProviderPortalDefinition,
  type ProviderPortalNativeOfferCandidate,
  type ProviderPortalOfferCandidate,
  type ProviderPortalReadCapability,
  type ProviderPortalState,
  type ProviderPortalTerminalState,
} from "./providerPortalKernel.js";

/**
 * OVD-1058 Geomiq quote-only portal definition.
 *
 * Bindings come from Geomiq's public buyer app (the Vue bundle served at
 * app.geomiq.com, build 7d297bfd, 2026-10-22) and its public reference data:
 * the quote page is `/quotes`, the app calls its Sanctum API and Pusher
 * socket on api.geomiq.com, STEP files preselect the `CNC` service, the
 * material is the searchable option "Aluminium 6061 T6" (EN 3.3216), and
 * prices render through `Intl.NumberFormat("en-UK", { currency: "GBP" })`.
 *
 * Only operator-approved local evaluation can reach the portal. Production
 * dispatch stays `unavailable` before any session read until Blaine enables it
 * (`provider-integrations/geomiq/admit/rollout-runbook.md`). No cart, checkout,
 * manual-quote or order control is declared, so none is reachable.
 */
export const GEOMIQ_PRODUCTION_ADAPTER_REVISION = "geomiq-production-adapter.v1";

/**
 * Every host that receives a credentialed or body-carrying request from the
 * quote page: the app, its API and socket, and the thumbnail service it posts
 * to after a STEP upload. Anything else is blocked by the kernel boundary.
 */
export const GEOMIQ_ALLOWED_HOSTS = ["app.geomiq.com", "geomiq.com", "api.geomiq.com", "gserve.geomiq.com"] as const;

/** The only Geomiq material this adapter selects, by its exact option label and EN number. */
export const GEOMIQ_MATERIAL_6061_T6 = Object.freeze({ label: "Aluminium 6061 T6", enNumber: "3.3216" });
export const GEOMIQ_SERVICE_CNC = "CNC";
export const GEOMIQ_FINISH_AS_MACHINED = "As Machined";

const PART_ROW = "[data-testid='single-part-row']";
const MATERIAL_DROPDOWN = ".g-input-dropdown:has(#options-material-input-dropdown)";

/** Reviewable locator table; a changed table needs a new revision. */
export const GEOMIQ_PRODUCTION_LOCATORS = Object.freeze({
  revision: "geomiq-production-locators.v1",
  signedIn: "[data-testid='menu-dropdown']",
  signedOut: "[data-testid='login-button']",
  cadUpload: "[data-testid='main-upload-hidden-input']",
  partRow: PART_ROW,
  selectedPartRow: `${PART_ROW}.is-selected`,
  /** The configurator's quantity, not the per-row copies that share its id. */
  quantity: `.number-input-wrapper input#quantity_initial:not(${PART_ROW} input)`,
  materialTrigger: `${MATERIAL_DROPDOWN} > .selected button`,
  materialSearch: `${MATERIAL_DROPDOWN} > .dropdown input[type='text']`,
  /**
   * The option whose text is exactly the label then the EN number, so "6061 T651" or another number
   * cannot match. `:text-matches` tests raw text, so separators are "not alphanumeric", which also
   * avoids backslash escapes inside the selector string.
   */
  material6061T6: `#options-material-input-dropdown button.option:has(div:text-matches("^[^A-Za-z0-9]*Aluminium 6061 T6[^A-Za-z0-9]+3[.]3216([^0-9]|$)"))`,
  finish: "button.select-target[entity='primary-finish'] [data-testid='configurator-preselected']",
  /** Row fields: each value is the paragraph after its label. */
  rowStatus: `${PART_ROW}.is-selected .quote-status-field`,
  rowService: `${PART_ROW}.is-selected p:text-is("Service:") + p`,
  rowMaterial: `${PART_ROW}.is-selected p:text-is("Material:") + p`,
  rowLeadTime: `${PART_ROW}.is-selected p:text-is("Shipping in:") + p`,
  rowUnitPrice: `${PART_ROW}.is-selected p:text-is("Price per unit:") + p`,
  rowSubtotal: `${PART_ROW}.is-selected p:text-is("Subtotal:") + p`,
  rowToolCost: `${PART_ROW}.is-selected p:text-is("Tool cost:")`,
});

const L = GEOMIQ_PRODUCTION_LOCATORS;

const GEOMIQ_TERMINAL_SIGNALS: ProviderPortalDefinition["terminalSignals"] = {
  // The app shows an expired session as the anonymous quote page, so the
  // signed-in guard in `beforeUpload` carries most of the login detection.
  login: [/\/(?:login|two-factor-challenge|register)\b/i, /two-factor authentication challenge/i],
  // reCAPTCHA v3 loads on every page, so only an interstitial counts.
  captcha: [/verify you are human|cloudflare challenge|checking your browser|just a moment\.\.\./i],
  // Part status is per row; page-wide text from other draft parts must not decide this run.
  manualReview: [],
  configurationRequired: [],
  unavailable: [/service unavailable|temporarily unavailable|under maintenance/i],
};

const QUANTITY_MAXIMUM = 50_000;
const PAGE_RENDER_BUDGET_MS = 20_000;
/** The signed-in, nothing-selected state must hold across two reads this far apart. */
const PAGE_STABLE_MS = 1_500;
/** The configurator renders once the new part is created and selected. */
const CONFIGURATOR_AWAIT_MS = 60_000;
/** Bound for the row to finish pricing the quantity before the material is changed. */
const ROW_IDLE_BUDGET_MS = 60_000;
/** Window after the material click in which the requote is watched for before extraction starts. */
const REQUOTE_OBSERVE_MS = 15_000;
const CONFIGURE_POLL_MS = 250;
const SETTLE_POLL_MS = 3_000;
/** Equal reads one poll apart after a requote was seen; without one no price is accepted. */
const SETTLE_STABLE_READS = 3;
const SETTLE_BUDGET_MS = 180_000;
const LOADING_STATUSES = new Set(["Uploading file", "Analysing file", "Pricing part", "Updating part"]);

type GeomiqMoney = { currency: "USD" | "EUR" | "GBP"; amount: number };

function stop(state: ProviderPortalTerminalState, reason: string, providerMutationPossible: boolean, extra: Record<string, unknown> = {}): never {
  throw new VendorAutomationError(`Geomiq evaluation stopped: ${reason}.`, state === "login_required" ? "login_required" : state === "selector_drift" ? "selector_failure" : "unexpected_ui_state", {
    vendor: "geomiq", terminalState: state, reason, providerMutationPossible, ...extra,
  });
}

/**
 * Untempered 6061 (the harness default for this package) and 6061-T6 both map
 * to Geomiq's "Aluminium 6061 T6": the designated drawing calls for 6061-T6.
 * The whole requirement must name that one material; any other alloy, temper
 * or combination is outside the adapter and never substituted.
 */
export function geomiqMaterialFor(material: string | null | undefined): typeof GEOMIQ_MATERIAL_6061_T6 | null {
  const text = (material ?? "").trim().replace(/\s+/g, " ");
  return /^(?:(?:aluminum|aluminium|al) )?6061(?:[- ]?t6)?(?: (?:aluminum|aluminium))?$/i.test(text) ? GEOMIQ_MATERIAL_6061_T6 : null;
}

/** The drawing's as-machined finish is Geomiq's default; any other requested finish is outside the adapter. */
export function isGeomiqAsMachinedFinish(finish: string | null | undefined): boolean {
  return /^(?:as[- ]machined)?$/i.test((finish ?? "").trim());
}

/** Parses one `Intl.NumberFormat("en-UK")` currency string; anything else is null. */
export function parseGeomiqMoney(text: string | null): GeomiqMoney | null {
  const match = /^(US\$|£|€)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(text?.trim() ?? "");
  if (!match) return null;
  const currency = match[1] === "£" ? "GBP" : match[1] === "€" ? "EUR" : "USD";
  const amount = Number(`${match[2].replaceAll(",", "")}.${match[3]}`);
  return Number.isFinite(amount) && amount > 0 ? { currency, amount } : null;
}

function leadBusinessDays(text: string | null): number | null {
  const match = /^(\d{1,3}) business days?$/.exec(text?.trim() ?? "");
  const days = match ? Number(match[1]) : null;
  return days !== null && days > 0 ? days : null;
}

/** The row names the part by its file name, with or without the extension, on a line of its own. */
function uploadedPartNames(input: VendorQuoteAdapterInput): Set<string> {
  const name = (input.stagedCadFile?.originalName ?? "").trim().toLowerCase();
  return new Set(name ? [name, name.replace(/\.[^.]+$/, "")] : []);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Interstitials stop the run with their own state before any quote-page wait can mask them. */
async function assertNoInterstitial(reader: ProviderPortalReadCapability, providerMutationPossible = false): Promise<void> {
  const text = (await reader.readText("body")) ?? "";
  if (GEOMIQ_TERMINAL_SIGNALS.captcha.some((pattern) => pattern.test(text))) stop("captcha", "geomiq_bot_challenge", providerMutationPossible);
  if (GEOMIQ_TERMINAL_SIGNALS.unavailable.some((pattern) => pattern.test(text))) {
    stop("unavailable", "geomiq_portal_unavailable", providerMutationPossible);
  }
}

/**
 * An expired session renders as the anonymous quote page while retained rows
 * stay on screen, so every post-upload read and write first rechecks it.
 */
async function assertSignedIn(reader: ProviderPortalReadCapability, providerMutationPossible: boolean): Promise<void> {
  await assertNoInterstitial(reader, providerMutationPossible);
  await assertSessionMarkers(reader, providerMutationPossible);
}

async function assertSessionMarkers(reader: ProviderPortalReadCapability, providerMutationPossible: boolean): Promise<void> {
  if (await reader.count(L.signedOut) > 0 || await reader.count(L.signedIn) === 0) {
    stop("login_required", "geomiq_session_anonymous", providerMutationPossible);
  }
}

type GeomiqRow = { status: string | null; material: string | null; unit: string | null; subtotal: string | null };

/**
 * Revalidate identity and session after awaited field reads, immediately before
 * using their result. Optional fields can take seconds to return when absent.
 */
async function assertUploadedPart(reader: ProviderPortalReadCapability, names: Set<string>): Promise<void> {
  await assertSignedIn(reader, true);
  if (await reader.count(L.selectedPartRow) !== 1) stop("selector_drift", "geomiq_selected_part_not_unique", true);
  const rowLines = ((await reader.readText(L.selectedPartRow)) ?? "").split("\n").map((line) => line.trim().toLowerCase());
  if (!rowLines.some((line) => names.has(line))) stop("selector_drift", "geomiq_selected_part_not_uploaded_file", true);
  await assertSessionMarkers(reader, true);
}

async function readUploadedRow(reader: ProviderPortalReadCapability, names: Set<string>): Promise<GeomiqRow> {
  await assertUploadedPart(reader, names);
  const read = async (selector: string) => (await reader.readText(selector))?.trim() || null;
  const status = await read(L.rowStatus);
  if (status === "Manual quote needed") {
    // Manual quotes have no price fields. Stop every pricing wait before reading
    // those absent fields, but recheck identity/session after the awaited status.
    await assertUploadedPart(reader, names);
    stop("manual_review", "geomiq_manual_quote_needed", true);
  }
  const row = { status, material: await read(L.rowMaterial), unit: await read(L.rowUnitPrice), subtotal: await read(L.rowSubtotal) };
  await assertUploadedPart(reader, names);
  return row;
}

const isLoading = (row: GeomiqRow) => row.status !== null && LOADING_STATUSES.has(row.status);
const priceOf = (row: GeomiqRow) => `${row.unit ?? ""}|${row.subtotal ?? ""}`;

/** Drain upload pricing first; after quantity, require a distinct requote before idle counts. */
async function waitForIdleRow(reader: ProviderPortalReadCapability, names: Set<string>, baselinePrice?: string): Promise<GeomiqRow> {
  const deadline = Date.now() + ROW_IDLE_BUDGET_MS;
  let previous: GeomiqRow | null = null;
  let requoteSeen = baselinePrice === undefined;
  for (;;) {
    const row = await readUploadedRow(reader, names);
    const priced = row.unit !== null && row.subtotal !== null;
    if (isLoading(row) || (priced && priceOf(row) !== baselinePrice)) requoteSeen = true;
    const idle = requoteSeen && priced && !isLoading(row);
    if (idle && previous && priceOf(row) === priceOf(previous)) return row;
    previous = idle ? row : null;
    if (Date.now() > deadline) {
      stop("selector_drift", !requoteSeen ? "geomiq_quantity_requote_not_observed"
        : baselinePrice === undefined ? "geomiq_row_not_idle_before_quantity" : "geomiq_row_not_idle_before_material", true);
    }
    await sleep(idle ? PAGE_STABLE_MS : CONFIGURE_POLL_MS);
  }
}

/**
 * Requote evidence from `configure`, keyed by the run's input, for its
 * extraction: the row's price just before the material click and whether a
 * loading status or a different price followed it.
 */
const materialRequotes = new WeakMap<VendorQuoteAdapterInput, { baselinePrice: string; seen: boolean }>();

/**
 * Read-only, before upload: a signed-in quote page with one upload input, no
 * configurator, and no selected part. The configurator edits the selected
 * parts; after an upload the app selects only the new draft
 * (`selectParts(<last draft>.hash)` in the public bundle), so a part selected
 * now, or a configurator already open, would receive our configuration. The
 * state must hold across two reads PAGE_STABLE_MS apart, so a signed-in header
 * rendered from saved client state before a 401, or a late restored
 * selection, stops the run instead of disclosing the file.
 */
async function assertSignedInQuotePage(reader: ProviderPortalReadCapability): Promise<void> {
  const deadline = Date.now() + PAGE_RENDER_BUDGET_MS;
  while (await reader.count(L.signedIn) === 0 && await reader.count(L.signedOut) === 0) {
    await assertNoInterstitial(reader);
    if (Date.now() > deadline) stop("selector_drift", "geomiq_quote_page_not_rendered", false);
    await sleep(500);
  }
  for (const check of [0, 1]) {
    if (check) await sleep(PAGE_STABLE_MS);
    await assertSignedIn(reader, false);
    if (await reader.count(L.cadUpload) !== 1) stop("selector_drift", "geomiq_upload_input_not_unique", false);
    if (await reader.count(L.selectedPartRow) > 0 || await reader.count(L.quantity) > 0) {
      stop("configuration_required", "geomiq_other_part_selected", false);
    }
  }
}

/**
 * Configures only the uploaded part: it waits for the configurator, then
 * rechecks the session and the selected row's identity before the quantity
 * write and before each material step. The quantity requote must finish
 * before the material changes, so a later loading status or price change
 * belongs to the material save; that evidence is recorded for extraction.
 */
async function configureUploadedPart(
  configuration: ProviderPortalConfigurationCapability,
  input: VendorQuoteAdapterInput,
  reader: ProviderPortalReadCapability,
): Promise<void> {
  const names = uploadedPartNames(input);
  const configuratorDeadline = Date.now() + CONFIGURATOR_AWAIT_MS;
  for (;;) {
    await assertSignedIn(reader, true);
    if (await reader.count(L.quantity) > 0 && await reader.count(L.selectedPartRow) > 0) break;
    if (Date.now() > configuratorDeadline) stop("selector_drift", "geomiq_configurator_not_rendered", true);
    await sleep(CONFIGURE_POLL_MS);
  }
  if (await reader.count(L.quantity) !== 1) stop("selector_drift", "geomiq_quantity_not_unique", true);
  const quantityBaseline = priceOf(await waitForIdleRow(reader, names));
  if (!(await configuration.fill("quantity", String(input.requestedQuantity)))) stop("selector_drift", "geomiq_quantity_control_missing", true);

  // Unchanged samples before a delayed quantity requote starts are not completion evidence.
  await waitForIdleRow(reader, names, quantityBaseline);

  // A portal-default material would quote the wrong part, so every step must land.
  if (!(await configuration.click("materialTrigger"))) stop("selector_drift", "geomiq_material_control_missing", true);
  await readUploadedRow(reader, names);
  if (!(await configuration.fill("materialSearch", GEOMIQ_MATERIAL_6061_T6.label))) {
    stop("selector_drift", "geomiq_material_search_missing", true);
  }
  const baselinePrice = priceOf(await readUploadedRow(reader, names));
  if (!(await configuration.click("material6061T6"))) {
    stop("configuration_required", "geomiq_material_6061_t6_not_offered", true);
  }
  const evidence = { baselinePrice, seen: false };
  materialRequotes.set(input, evidence);
  const observeDeadline = Date.now() + REQUOTE_OBSERVE_MS;
  while (!evidence.seen && Date.now() <= observeDeadline) {
    const row = await readUploadedRow(reader, names);
    evidence.seen = isLoading(row) || priceOf(row) !== baselinePrice;
    if (!evidence.seen) await sleep(CONFIGURE_POLL_MS);
  }
}

/**
 * Polls the selected row until its price is settled for 6061-T6. A material
 * change relabels the row at once (the bundle's UPDATE_DRAFT commits the new
 * configuration before saving) while the previous price stays until the
 * requote marks the row "Updating part"/"Pricing part". A price counts only
 * after a requote was seen (in `configure`, or here as a loading status, no
 * price, or a price other than the pre-click one) and then SETTLE_STABLE_READS
 * equal reads one poll apart, each with the 6061-T6 label and no loading
 * status. A label change alone, as after a failed or still-pending save, never
 * yields a price; Geomiq exposes no quote revision to bind to.
 */
async function readSettledRow(reader: ProviderPortalReadCapability, input: VendorQuoteAdapterInput): Promise<{ unit: string; subtotal: string }> {
  const names = uploadedPartNames(input);
  const evidence = materialRequotes.get(input);
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  let previous: string | null = null;
  let stableReads = 0;
  let requoteSeen = evidence?.seen ?? false;
  for (;;) {
    const row = await readUploadedRow(reader, names);
    const { status, material, unit, subtotal } = row;
    if (status === "Unable to quote") stop("unsupported", "geomiq_unable_to_quote", true);
    const priced = unit !== null && subtotal !== null;
    if (isLoading(row) || !priced || (evidence && priceOf(row) !== evidence.baselinePrice)
      || (previous !== null && priceOf(row) !== previous)) requoteSeen = true;
    const settled = priced && material === GEOMIQ_MATERIAL_6061_T6.label && !isLoading(row);
    const sample = settled ? priceOf(row) : null;
    stableReads = sample !== null && sample === previous ? stableReads + 1 : sample === null ? 0 : 1;
    previous = priced ? priceOf(row) : null;
    if (settled && requoteSeen && stableReads >= SETTLE_STABLE_READS) return { unit: unit!, subtotal: subtotal! };
    if (Date.now() > deadline) {
      // A priced row that never showed 6061-T6 means the material selection did not take.
      if (unit && material && material !== GEOMIQ_MATERIAL_6061_T6.label) stop("configuration_required", "geomiq_material_not_6061_t6", true);
      // Only the label changed: the material save failed or never repriced, so the shown price is not 6061-T6's.
      if (!requoteSeen) stop("configuration_required", "geomiq_material_requote_not_observed", true);
      stop("selector_drift", "geomiq_price_not_settled", true);
    }
    await sleep(SETTLE_POLL_MS);
  }
}

/**
 * Reads the uploaded part's settled price. The row must echo CNC, Aluminium
 * 6061 T6 and an As Machined finish; unit and subtotal must agree for the
 * requested quantity with no tool cost. GBP, the app's display currency, and
 * EUR go through the native-currency lane: recorded as non-comparable
 * evidence in their own currency, never converted or relabelled as USD.
 * Only an explicit US$ amount becomes a USD offer.
 */
export async function extractGeomiqProductionOffers(
  reader: ProviderPortalReadCapability,
  input: VendorQuoteAdapterInput,
): Promise<Array<ProviderPortalOfferCandidate | ProviderPortalNativeOfferCandidate>> {
  const { unit, subtotal } = await readSettledRow(reader, input);
  const service = (await reader.readText(L.rowService))?.trim();
  const material = (await reader.readText(L.rowMaterial))?.trim();
  const finish = (await reader.readText(L.finish))?.trim();
  if (service !== GEOMIQ_SERVICE_CNC) stop("configuration_required", "geomiq_service_not_cnc", true);
  if (material !== GEOMIQ_MATERIAL_6061_T6.label) stop("configuration_required", "geomiq_material_not_6061_t6", true);
  if (finish !== GEOMIQ_FINISH_AS_MACHINED) stop("configuration_required", "geomiq_finish_not_as_machined", true);
  if (await reader.count(L.rowToolCost) > 0) stop("selector_drift", "geomiq_unexpected_tool_cost", true);
  const unitMoney = parseGeomiqMoney(unit);
  const totalMoney = parseGeomiqMoney(subtotal);
  if (!unitMoney || !totalMoney || unitMoney.currency !== totalMoney.currency) {
    stop("selector_drift", "geomiq_price_unparsed", true);
  }
  const quantity = input.requestedQuantity;
  const unitCents = Math.round(unitMoney.amount * 100);
  // The unit price is shown rounded to the penny, so the product can drift by up to half a penny per part.
  const tolerance = Math.max(1, Math.ceil(quantity / 2));
  if (!Number.isSafeInteger(unitCents * quantity) || Math.abs(unitCents * quantity - Math.round(totalMoney.amount * 100)) > tolerance) {
    stop("selector_drift", "geomiq_price_quantity_mismatch", true);
  }
  const lead = leadBusinessDays(await reader.readText(L.rowLeadTime));
  await assertUploadedPart(reader, uploadedPartNames(input));
  const base = {
    providerOptionId: "subtotal", providerOptionIdSource: "provider_label" as const, providerLabel: "Subtotal",
    quoteRef: null, quoteUrl: null, quantity,
    leadTimeBusinessDays: { value: lead, source: lead === null ? "none" as const : "selector" as const, selector: lead === null ? null : L.rowLeadTime },
    shipReceiveBy: null, tier: null, sourcing: null, geographicOrigin: null, geographicOriginSource: "none" as const,
    containerSelector: L.selectedPartRow,
    validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null,
    rawPayload: {
      adapterRevision: GEOMIQ_PRODUCTION_ADAPTER_REVISION, locatorRevision: L.revision,
      configuration: { service, material, finish }, requestedMaterial: input.requirement?.material ?? null,
    },
  };
  if (unitMoney.currency !== "USD") {
    return [{ ...base, money: {
      unitAmount: { value: unitMoney.amount, source: "selector", selector: L.rowUnitPrice },
      totalAmount: { value: totalMoney.amount, source: "selector", selector: L.rowSubtotal },
      unitCurrency: { value: unitMoney.currency, source: "selector", selector: L.rowUnitPrice },
      totalCurrency: { value: totalMoney.currency, source: "selector", selector: L.rowSubtotal },
    } }];
  }
  return [{
    ...base,
    unitPriceUsd: { value: unitMoney.amount, source: "selector", selector: L.rowUnitPrice },
    totalPriceUsd: { value: totalMoney.amount, source: "selector", selector: L.rowSubtotal },
  }];
}

function classifyGeomiqSnapshot(snapshot: Parameters<ProviderPortalDefinition["hooks"]["classifyPortalState"]>[0]): ProviderPortalState {
  if (!isAllowedProviderUrl(snapshot.url, GEOMIQ_ALLOWED_HOSTS)) return "unexpected_origin";
  return classifyProviderPortalSnapshot(snapshot, GEOMIQ_TERMINAL_SIGNALS);
}

export function buildGeomiqProductionPortalDefinition(): ProviderPortalDefinition {
  return {
    provider: "geomiq",
    displayName: "Geomiq",
    manifestRevision: "provider-manifest.v1",
    envelopeRevision: GEOMIQ_ENVELOPE_REVISION,
    adapterRevision: GEOMIQ_PRODUCTION_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: "https://geomiq.com/",
      loginUrl: "https://app.geomiq.com/login",
      uploadUrl: "https://app.geomiq.com/quotes",
    },
    allowedHosts: GEOMIQ_ALLOWED_HOSTS,
    selectors: {
      cadUpload: L.cadUpload,
      // Quantity is a configuration step, written only after the uploaded row is verified.
      configuration: {
        quantity: { selector: L.quantity, operation: "fill" },
        materialTrigger: { selector: L.materialTrigger, operation: "click" },
        materialSearch: { selector: L.materialSearch, operation: "fill" },
        material6061T6: { selector: L.material6061T6, operation: "click" },
      },
    },
    supportedFileExtensions: ["step", "stp"],
    terminalSignals: GEOMIQ_TERMINAL_SIGNALS,
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    productionDispatch: { envelope: { ...GEOMIQ_DISPATCH_ENVELOPE } },
    hooks: {
      beforeUpload: assertSignedInQuotePage,
      assessEligibility: (input) => {
        if (input.executionContext !== "live_evaluation") {
          return { state: "unavailable", reason: "geomiq_production_enablement_pending" };
        }
        if (!Number.isSafeInteger(input.requestedQuantity) || input.requestedQuantity < 1
          || input.requestedQuantity > QUANTITY_MAXIMUM) {
          return { state: "unsupported", reason: "quantity_outside_envelope" };
        }
        if (!geomiqMaterialFor(input.requirement?.material)) {
          return { state: "unsupported", reason: "geomiq_material_outside_adapter" };
        }
        if (!isGeomiqAsMachinedFinish(input.requirement?.finish)) {
          return { state: "unsupported", reason: "geomiq_finish_outside_adapter" };
        }
        return { state: "eligible", reason: "geomiq_step_6061_t6_and_quantity_fit" };
      },
      configure: configureUploadedPart,
      classifyPortalState: classifyGeomiqSnapshot,
      extractOffers: extractGeomiqProductionOffers,
    },
  };
}
