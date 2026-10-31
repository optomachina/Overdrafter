import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import { VendorAutomationError, type VendorArtifact, type VendorAutomationErrorCode, type VendorQuoteAdapterInput } from "../types.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  type ProviderPortalConfigurationCapability,
  type ProviderPortalDefinition,
  type ProviderPortalEligibility,
  type ProviderPortalOfferCandidate,
  type ProviderPortalReadCapability,
  type ProviderPortalSessionCapability,
  type ProviderPortalSnapshot,
  type ProviderPortalState,
} from "./providerPortalKernel.js";
import { normalizeStepToCanonicalGeometryMetadata, type Vector3 } from "../extraction/stepGeometryMetadata.js";
import { inspectSendCutSendStepGeometry, SENDCUTSEND_CNC_ENVELOPE } from "./sendcutsendEnvelope.js";

export const SENDCUTSEND_SHEET_ADAPTER_REVISION = "sendcutsend-sheet-portal.v1";
export const SENDCUTSEND_SHEET_ENVELOPE_REVISION = "sendcutsend-sheet-envelope.v1";

const SENDCUTSEND_APP_HOST = "app.sendcutsend.com";

/**
 * Hosts the quote page needs, from the anonymous capture of 2026-10-22: the
 * Rails app itself, and Ably realtime, which the page calls on load (a token
 * POST and a WebSocket). The kernel treats either as a boundary violation
 * unless it is listed, and the operator approval names every host here. The
 * apex `sendcutsend.com` is deliberately absent: a saved cookie on the parent
 * domain would ride along on every CDN request, and the kernel ends the run
 * on any credential-bearing off-host request. The session filter rescopes
 * such cookies to the app host instead (see `filterSendCutSendStorageState`).
 */
export const SENDCUTSEND_ALLOWED_HOSTS = [SENDCUTSEND_APP_HOST, "main.realtime.ably.net"] as const;

/** The parent domain whose cookies the session filter moves onto the app host. */
const SENDCUTSEND_PARENT_DOMAIN = "sendcutsend.com";

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
  revision: "sendcutsend-sheet-locators.v2",
  /**
   * The quote dialog's material breadcrumbs ("Categories > Metals > Aluminum >
   * 6061 T6 Aluminum") render on the desktop tile view at the thickness step.
   * They are the on-page proof of the material; the thickness tiles show only
   * a thickness, identical across alloys.
   */
  materialCrumbs: ".material_breadcrumbs a",
  skuTitles: ".material-skus .tile-sku p.title",
  disabledSkuTitles: ".material-skus .tile-sku.is-disabled p.title",
  selectedSkuTitles: ".material-skus .tile-sku.selected:has(input[type='radio']:checked) p.title",
  summary: ".post-processing-summary-container",
  unitPrice: ".post-processing-summary-container .price__each .currency .cash",
  subtotal: ".post-processing-summary-container .subtotal__summary",
  totalPrice: ".post-processing-summary-container .subtotal__summary .subtotal .currency .cash",
  shipDate: ".est-ship-date p",
  quoteDialog: ".modal-card .quote-footer",
  /** Buefy's loading overlay: the wizard shows it while quotes load or reprice. */
  activeLoading: ".modal-card .loading-overlay.is-active",
  /** The logged-out header's sign-in link (anonymous capture, 2026-10-22); visible only while signed out. */
  visibleLoginLink: "a.login:visible",
  /** The header's navigation items render with the header itself. */
  navbar: "a.navbar-item",
  uploadInput: "input[type='file']",
});

/**
 * Wizard controls. Each step replaces the previous one, so a step's tiles
 * exist only while it is current. None of these reach the cart: the footer
 * buttons ("Next", "Add to Cart") are deliberately not declared.
 */
export const SENDCUTSEND_SHEET_SELECTORS = Object.freeze({
  cadUpload: "input[type='file']",
  configuration: Object.freeze({
    // `:visible` keeps a step hidden by v-show from being clicked (the click would hang until timeout).
    productionMethod: Object.freeze({ selector: ".select-tile p.has-text-weight-bold:visible", operation: "click" as const }),
    materialGroup: Object.freeze({ selector: ".select-material-group p.title:visible", operation: "click" as const }),
    materialCategory: Object.freeze({ selector: ".select-material-category p.title:visible", operation: "click" as const }),
    materialType: Object.freeze({ selector: ".select-material-type p.title:visible", operation: "click" as const }),
    // A disabled tile is never clicked: its label retargets to the disabled radio and the click would hang.
    thickness: Object.freeze({
      selector: ".material-skus .tile-sku:not(.is-disabled) label.b-radio:has(input[type='radio']:enabled) p.title:visible",
      operation: "click" as const,
    }),
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
/** A tile that ignored a click (still processing) is clicked again only after this long. */
const SENDCUTSEND_RECLICK_AFTER_MS = 5_000;
/** The summary price must read the same, at least three times, for this long. */
const SENDCUTSEND_PRICE_STABLE_MS = 2_500;
/** The header resolves the session asynchronously; it must show no sign-in link for this long. */
const SENDCUTSEND_SESSION_SETTLE_MS = 2_000;
const SENDCUTSEND_SESSION_WAIT_MS = 15_000;

const SENDCUTSEND_TERMINAL_SIGNALS: ProviderPortalDefinition["terminalSignals"] = {
  login: [/\b(?:log ?in|sign[ -]?in)\b/i],
  captcha: [/captcha|verif(?:y|ying) you are human|checking your browser|security of your connection/i],
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
  terminalState: "selector_drift" | "configuration_required" | "manual_review" | "login_required",
  reason: string,
  message: string,
  providerMutationPossible = true,
): VendorAutomationError {
  let code: VendorAutomationErrorCode = "unexpected_ui_state";
  if (terminalState === "selector_drift") code = "selector_failure";
  else if (terminalState === "login_required") code = "login_required";
  return new VendorAutomationError(`SendCutSend quote stopped: ${message}.`, code, {
    vendor: "sendcutsend",
    terminalState,
    reason,
    providerMutationPossible,
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
  reclickAfterMs?: number;
  priceStableMs?: number;
  sessionSettleMs?: number;
  sessionWaitMs?: number;
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
 * Proves the model is a straight extrusion through its thinnest axis: one
 * planar, straight-edged solid (the shared inspector's topology gate), every
 * vertex on one of the two cap planes, every edge between the caps parallel
 * to the thin axis (no taper or slope), and identical cap profiles (no
 * pocket, step or wedge). Returns the thickness in inches, or null.
 */
export function inspectSendCutSendFlatPlate(input: { fileName: string; buffer: Buffer }): number | null {
  const geometry = inspectSendCutSendStepGeometry(input);
  if (!geometry?.dimensions || geometry.units === "unsupported" || geometry.solidBodyCount !== 1) return null;
  try {
    const metadata = normalizeStepToCanonicalGeometryMetadata({
      stepContent: input.buffer.toString("utf8"),
      sourceName: input.fileName,
    });
    const body = metadata.bodies[0];
    const box = body?.boundingBox;
    if (!body || !box || body.vertexIds.length > MAX_FLAT_PLATE_VERTICES) return null;
    const inchesPerUnit = geometry.units === "millimeter" ? 1 / 25.4 : 1;
    // Scale-relative, but never looser than a ten-thousandth of an inch.
    const tolerance = Math.min(Math.max(box.size.x, box.size.y, box.size.z) * 1e-6, 0.0001 / inchesPerUnit);
    const positions = new Map<string, Vector3>(metadata.vertices.map((vertex) => [vertex.id, vertex.position]));
    const vertices = body.vertexIds.map((id) => positions.get(id));
    const edges = metadata.edges.filter((edge) => body.edgeIds.includes(edge.id))
      .map((edge) => [edge.startVertexId ? positions.get(edge.startVertexId) : undefined,
        edge.endVertexId ? positions.get(edge.endVertexId) : undefined] as const);
    if (vertices.some((position) => !position) || edges.some(([start, end]) => !start || !end)) return null;
    const thinnest = Math.min(box.size.x, box.size.y, box.size.z);
    // Every axis tied for thinnest is a candidate extrusion direction.
    const candidates = (["x", "y", "z"] as const).filter((axis) => box.size[axis] - thinnest <= tolerance);
    const extruded = candidates.some((thin) => isStraightExtrusion(
      thin, box, vertices as Vector3[], edges as ReadonlyArray<readonly [Vector3, Vector3]>, tolerance,
    ));
    return extruded ? thinnest * inchesPerUnit : null;
  } catch {
    return null;
  }
}

const MAX_FLAT_PLATE_VERTICES = 5_000;

function isStraightExtrusion(
  thin: "x" | "y" | "z",
  box: { min: Vector3; max: Vector3 },
  vertices: readonly Vector3[],
  edges: ReadonlyArray<readonly [Vector3, Vector3]>,
  tolerance: number,
): boolean {
  const [u, v] = (["x", "y", "z"] as const).filter((axis) => axis !== thin);
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const cap = (position: Vector3): "low" | "high" | null => {
    if (near(position[thin], box.min[thin])) return "low";
    if (near(position[thin], box.max[thin])) return "high";
    return null;
  };
  if (vertices.some((position) => cap(position) === null)) return false;
  // Edges between the caps must run straight through the thickness (no taper or slope).
  if (edges.some(([start, end]) => cap(start) !== cap(end) && !(near(start[u], end[u]) && near(start[v], end[v])))) {
    return false;
  }
  // The cap profiles must match one-to-one within tolerance (no pocket, step or wedge).
  const low = vertices.filter((position) => cap(position) === "low");
  const high = vertices.filter((position) => cap(position) === "high");
  if (low.length < 3 || low.length !== high.length) return false;
  const unmatched = [...high];
  for (const point of low) {
    const match = unmatched.findIndex((other) => near(point[u], other[u]) && near(point[v], other[v]));
    if (match < 0) return false;
    unmatched.splice(match, 1);
  }
  return true;
}

/**
 * Admits only the reviewed sheet envelope, and binds the declared 0.125 in
 * thickness to the authorized CAD bytes: the STEP must be a straight
 * extrusion (see `inspectSendCutSendFlatPlate`) whose thickness is the stock
 * thickness. A bent, tapered, pocketed or stepped part is refused here
 * rather than quoted as a flat outline.
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
  const thickness = inspectSendCutSendFlatPlate({ fileName: files.cad.name, buffer: files.cad.buffer });
  if (thickness === null) {
    return { state: "unsupported", reason: "sendcutsend_sheet_geometry_unverified" };
  }
  if (!Number.isFinite(thickness) || Math.abs(thickness - envelope.thicknessInch) > envelope.thicknessToleranceInch) {
    return { state: "unsupported", reason: "sendcutsend_geometry_thickness_mismatch" };
  }
  return { state: "eligible", reason: "sendcutsend_sheet_envelope_match" };
}

/**
 * What this run's wizard walk actually clicked. A thickness counts only when
 * the click immediately before it was the exact type tile; clicking an
 * earlier step clears the type. This is necessary, not sufficient: the
 * offer reader also checks the material breadcrumbs on the page.
 */
export type SendCutSendWizardWalk = {
  typeSelected: boolean;
  thicknessSelected: boolean;
  /** Set only by the pre-upload guard once the app confirmed a signed-in, non-guest user. */
  sessionConfirmed: boolean;
};

export function newSendCutSendWizardWalk(): SendCutSendWizardWalk {
  return { typeSelected: false, thicknessSelected: false, sessionConfirmed: false };
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
  const clicks = new Map<string, { count: number; at: number }>();
  const reclickAfterMs = waits.reclickAfterMs ?? SENDCUTSEND_RECLICK_AFTER_MS;
  let lastClicked: string | null = null;
  await within(waits.processingWaitMs ?? SENDCUTSEND_PROCESSING_WAIT_MS, async () => {
    for (const [field, text] of steps) {
      const prior = clicks.get(field);
      // A step that ignored a click (still processing) gets a bounded number of spaced retries.
      if (prior && (prior.count >= SENDCUTSEND_MAX_CLICKS_PER_STEP || Date.now() - prior.at < reclickAfterMs)) continue;
      if (await configuration.click(field, text)) {
        clicks.set(field, { count: (prior?.count ?? 0) + 1, at: Date.now() });
        if (field === "thickness") {
          // A thickness picked from a type this run did not just choose proves nothing.
          walk.thicknessSelected = walk.typeSelected && lastClicked === "materialType";
        } else {
          walk.typeSelected = field === "materialType";
          walk.thicknessSelected = false;
        }
        lastClicked = field;
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

async function assertSignedIn(reader: ProviderPortalReadCapability, providerMutationPossible: boolean): Promise<void> {
  if (await reader.count(SENDCUTSEND_SHEET_LOCATORS.visibleLoginLink) > 0) {
    throw terminal("login_required", "sendcutsend_signed_out", "the session is signed out", providerMutationPossible);
  }
}

/** The breadcrumbs must end in the reviewed group, category and type. */
async function hasReviewedMaterialCrumbs(reader: ProviderPortalReadCapability): Promise<boolean> {
  const stock = SENDCUTSEND_SHEET_STOCK;
  const crumbs = trimmedTexts(await reader.readTexts(SENDCUTSEND_SHEET_LOCATORS.materialCrumbs));
  return JSON.stringify(crumbs.slice(-3)) === JSON.stringify([stock.group, stock.category, stock.type]);
}

async function assertExactStockSelected(
  reader: ProviderPortalReadCapability,
  walk: SendCutSendWizardWalk,
): Promise<void> {
  const locators = SENDCUTSEND_SHEET_LOCATORS;
  const thickness = SENDCUTSEND_SHEET_STOCK.thickness;
  await assertSignedIn(reader, true);
  const crumbsMatch = await hasReviewedMaterialCrumbs(reader);
  const selected = trimmedTexts(await reader.readTexts(locators.selectedSkuTitles));
  if (walk.thicknessSelected && crumbsMatch && selected.length === 1 && selected[0] === thickness) return;
  if (walk.thicknessSelected && !crumbsMatch) {
    throw terminal("selector_drift", "sendcutsend_material_unverified", "the page does not show 6061 T6 Aluminum as the material");
  }
  if (!walk.typeSelected || !crumbsMatch) {
    throw terminal("selector_drift", "sendcutsend_material_path_incomplete", "the 6061-T6 0.125 in stock was not reached");
  }
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

/** One read of the side summary; an ambiguous read is final only if it persists. */
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
 * Reads the side summary for the exact stock, signed in, with the reviewed
 * material breadcrumbs, before and after the price read. The summary renders
 * the selected tile's quote reactively; a read counts only while the dialog
 * shows no loading overlay (the wizard's own "quotes loading or repricing"
 * signal), and the price must read the same at least three times over
 * `priceStableMs`, the unit price times the quantity must equal the subtotal
 * to the cent, and the SKU must still be the checked one afterwards. Anything
 * else withholds the offer. USD only. SendCutSend shows a ship date, not a
 * duration, so the lead time stays null and the date is kept as
 * `shipReceiveBy`.
 */
export async function extractSendCutSendSheetOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
  walk: SendCutSendWizardWalk,
  waits: SendCutSendWaits = {},
): Promise<ProviderPortalOfferCandidate[]> {
  const locators = SENDCUTSEND_SHEET_LOCATORS;
  if (!walk.sessionConfirmed) {
    throw terminal("login_required", "sendcutsend_session_unconfirmed", "the signed-in session was never confirmed");
  }
  await assertExactStockSelected(reader, walk);
  const stableMs = waits.priceStableMs ?? SENDCUTSEND_PRICE_STABLE_MS;
  let streak: { key: string; since: number; reads: number } | null = null;
  let settled: { unit: string; total: string } | null = null;
  let last: SummaryRead = { kind: "pending" };
  // While the dialog shows its loading overlay, quotes are still loading or
  // repricing. The overlay is checked on both sides of the price read, so a
  // read that overlaps the start of a reprice does not count.
  const readWhenIdle = async (): Promise<SummaryRead> => {
    if (await reader.count(locators.activeLoading) > 0) return { kind: "pending" };
    const read = await readSummary(reader);
    return await reader.count(locators.activeLoading) > 0 ? { kind: "pending" } : read;
  };
  await within(waits.priceWaitMs ?? SENDCUTSEND_PRICE_WAIT_MS, async () => {
    last = await readWhenIdle();
    if (last.kind === "custom") return true;
    if (last.kind !== "priced") {
      streak = null;
      return false;
    }
    const key = `${last.unit}|${last.total}`;
    const current: { key: string; since: number; reads: number } = streak?.key === key
      ? { ...streak, reads: streak.reads + 1 }
      : { key, since: Date.now(), reads: 1 };
    streak = current;
    if (current.reads >= 3 && Date.now() - current.since >= stableMs) {
      settled = { unit: last.unit, total: last.total };
      return true;
    }
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
  const final = await readWhenIdle();
  if (final.kind !== "priced" || final.unit !== unit || final.total !== total) {
    throw terminal("selector_drift", "sendcutsend_price_pending", "the price changed after it settled");
  }
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

// Session-save tooling shares the fixed evaluator owned by the kernel.
export { checkSendCutSendCurrentUser } from "./providerPortalKernel.js";

/**
 * Read-only guard before classification and again before upload. The header
 * resolves the session asynchronously, so it must render and then show no
 * visible sign-in link for `sessionSettleMs` (the link's text may share a
 * line with other items, so the element is checked, not the page text). An
 * absent sign-in link is not proof of a session, so the app must then
 * confirm a signed-in, non-guest user (`checkSendCutSendCurrentUser`); only
 * that confirmation lets the offer reader run. There must be exactly one
 * upload input, and no wizard or summary left open by an earlier part.
 */
async function guardBeforeUpload(
  reader: ProviderPortalReadCapability,
  session: ProviderPortalSessionCapability | undefined,
  walk: SendCutSendWizardWalk,
  waits: SendCutSendWaits = {},
): Promise<void> {
  const locators = SENDCUTSEND_SHEET_LOCATORS;
  walk.sessionConfirmed = false;
  const settleMs = waits.sessionSettleMs ?? SENDCUTSEND_SESSION_SETTLE_MS;
  let quietSince: number | null = null;
  const settled = await within(waits.sessionWaitMs ?? SENDCUTSEND_SESSION_WAIT_MS, async () => {
    if (await reader.count(locators.navbar) === 0 || await reader.count(locators.visibleLoginLink) > 0) {
      quietSince = null;
      return false;
    }
    const since: number = quietSince ?? Date.now();
    quietSince = since;
    return Date.now() - since >= settleMs;
  }, waits.pollIntervalMs);
  if (!settled) {
    await assertSignedIn(reader, false);
    throw terminal("selector_drift", "sendcutsend_header_missing", "the page header did not render", false);
  }
  const check = session ? await session.confirmSignedIn()
    : { signedIn: false, detail: "no session check" };
  if (!check.signedIn) {
    throw terminal(
      "login_required",
      "sendcutsend_session_unconfirmed",
      `the app did not confirm a signed-in, non-guest user (${check.detail})`,
      false,
    );
  }
  if (await reader.count(locators.uploadInput) !== 1) {
    throw terminal("selector_drift", "sendcutsend_upload_input_ambiguous", "the upload input is missing or not unique", false);
  }
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
      beforeUpload: async (reader, session) => {
        await guardBeforeUpload(reader, session, walk, options);
        // Confirmed only once every pre-upload check has passed.
        walk.sessionConfirmed = true;
      },
      assessEligibility: assessSendCutSendSheetEligibility,
      configure: (configuration, input) => configureSendCutSendSheet(configuration, input, walk, options),
      classifyPortalState: classifySendCutSendPortalState,
      extractOffers: (reader, input) => extractWithDiagnostics(reader, input, walk, options),
    },
  };
}

type StorageStateCookie = { domain?: unknown; name?: unknown; path?: unknown };
type StorageStateOrigin = { origin?: unknown };

/**
 * The kernel refuses a saved session that holds any cookie or origin outside
 * the definition's exact hosts, and a manual sign-in also collects cookies
 * from analytics, chat and payment scripts. Keep only the exact-host entries
 * and report the dropped cookie domains (never names or values). A cookie
 * on the parent domain (`.sendcutsend.com`) is kept but rescoped to the app
 * host, so it reaches the app and never rides along on CDN requests.
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
  const isParent = (cookie: StorageStateCookie) => cookieHost(cookie) === SENDCUTSEND_PARENT_DOMAIN;
  const slot = (cookie: StorageStateCookie) => `${String(cookie?.name)}\u0000${typeof cookie?.path === "string" ? cookie.path : "/"}`;
  const appSlots = new Set(cookies.filter((cookie) => cookieHost(cookie) === SENDCUTSEND_APP_HOST).map(slot));
  // An app-host cookie of the same name and path wins over a rescoped parent one.
  const kept = cookies.filter((cookie) => allowed.has(cookieHost(cookie)) || (isParent(cookie) && !appSlots.has(slot(cookie))))
    .map((cookie) => isParent(cookie) ? { ...cookie, domain: SENDCUTSEND_APP_HOST } : cookie);
  const dropped = [...new Set(cookies.filter((cookie) => !allowed.has(cookieHost(cookie)) && !isParent(cookie))
    .map(cookieHost))].sort((left, right) => left.localeCompare(right, "en"));
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
