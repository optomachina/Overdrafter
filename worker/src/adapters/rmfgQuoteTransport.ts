/**
 * Offline RMFG REST quote contract. The caller supplies every response and file
 * byte; this module has no HTTP client, credential handling, or runtime registry
 * entry. Endpoint variants deliberately exclude carts, checkout, and orders.
 *
 * Source: https://api.rmfg.com/v1/openapi.json (2026-09-28, rechecked
 * 2026-10-22 at api_version 2026-09-01), specifically V1Design, V1Part,
 * V1Material, V1QuoteRequest, V1Quote, V1QuotedDesign, V1QuoteLineItem,
 * V1DFMReport, V1Requirement, and V1FulfillmentEstimate.
 */
import { createHash } from "node:crypto";

export const RMFG_QUOTE_TRANSPORT_REVISION = "rmfg-quote-transport.v1" as const;

export type RmfgQuoteRequest =
  | { endpoint: "analyze"; method: "POST"; path: "/v1/analyze";
      file: { name: string; bytes: Uint8Array }; idempotencyKey: string }
  | { endpoint: "design"; method: "GET"; path: string; designId: string }
  | { endpoint: "materials" | "tube_profiles"; method: "GET";
      path: "/v1/materials" | "/v1/tube-profiles"; cursor: string | null }
  | { endpoint: "quote"; method: "POST"; path: "/v1/quotes"; idempotencyKey: string; body: {
      items: Array<{ design_id: string; quantity: number; configuration: {
        parts: Array<{ part_id: string; material_id?: string; tube_profile_id?: string }>;
      } }>;
    } }
  | { endpoint: "quote_status"; method: "GET"; path: string; quoteId: string };

export type RmfgQuoteTransport = (request: RmfgQuoteRequest) => Promise<{ status: number; body: unknown }>;

/**
 * Operator-stated sheet stock (OVD-1057). The design must be exactly one sheet
 * part of this thickness (formed only on stock RMFG lists as bendable), and the
 * quote uses the single current catalog material of this grade and thickness.
 * Nothing is substituted: no match, or more than one, stops before the quote.
 */
export type RmfgStockRequirement = {
  /** Four digit alloy and its temper as written on the drawing or approval, such as "6061-T6" or "5052-H32". */
  grade: string;
  thicknessIn: number;
};

export type RmfgQuoteInput = {
  file: { name: string; bytes: Uint8Array };
  quantity: number;
  /** IDs selected by a person from this design's current catalog, keyed by analyzed part ID. */
  selections: Record<string, { materialId?: string; tubeProfileId?: string }>;
  /** When set, selections must be empty; the stock is picked from the current catalog. */
  stock?: RmfgStockRequirement;
  analyzeKey: string;
  /** Prefix only: the sent key adds a digest of the exact quote body, so a changed request never reuses it. */
  quoteKey: string;
  /** Clock for the quote's `expires_at`; defaults to the system clock. */
  now?: () => number;
  /** Per injected request; capped at ten seconds so a stalled fixture is finite. */
  requestTimeoutMs?: number;
  /** Pause before each status poll. Real analysis is asynchronous; fixtures leave it at 0. */
  pollIntervalMs?: number;
  /** Status polls allowed for each of the design and the quote; default 3, at most 60. */
  maxPolls?: number;
};

export type RmfgQuoteOffer = {
  providerOptionId: string;
  quoteRef: string;
  designId: string;
  quantity: number;
  currency: "USD";
  unitPriceUsd: number;
  totalPriceUsd: number;
  leadTimeBusinessDays: null;
  /** The quote's own `expires_at`, when RMFG states one. */
  validUntil: string | null;
  /** Integer cents behind the USD figures. */
  totalCents: number;
  /** What RMFG stated alongside the price, kept for audit. None of it is published as a lead time. */
  fulfillment: { standardProductionDays: number | null; standardShipDate: string | null; expeditedOffered: boolean };
  /** Line price component types, such as "base". */
  pricedComponents: string[];
  provenance: {
    quantity: "items[0].quantity";
    currency: "currency";
    unitPrice: "items[0].unit_amount_cents";
    totalPrice: "items[0].amount_cents";
    leadTimeBusinessDays: "unknown";
  };
};

export type RmfgQuoteResult = {
  revision: typeof RMFG_QUOTE_TRANSPORT_REVISION;
  state: "ready" | "pending" | "requires_input" | "blocked" | "error" | "unknown";
  reason: string;
  designId: string | null;
  quoteId: string | null;
  requirementCodes: string[];
  dfmIssueCodes: string[];
  dfmStatus: "ready" | "requires_input" | "blocked" | "unknown";
  offer: RmfgQuoteOffer | null;
  /** The catalog stock picked for an operator-stated stock requirement, with its catalog label. */
  stock: { materialId: string; thicknessIn: number; label: string; displayThickness: string | null } | null;
  /** On a stock stop: current public catalog entries at the stated thickness, so a person can see what was offered. */
  stockMatches?: Array<{ materialId: string; label: string; thicknessIn: number }>;
};

type Json = Record<string, unknown>;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_POLLS = 3;
const MAX_POLL_LIMIT = 60;
const MAX_POLL_INTERVAL_MS = 10_000;
const MAX_CATALOG_PAGES = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Analyzer thickness may differ from the stated thickness by measurement noise only, well under 0.001 in. */
const PART_THICKNESS_TOLERANCE_MM = 0.02;

type Polling = { timeoutMs: number; intervalMs: number; maxPolls: number; now: () => number };

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A positive total whose unit amount is that total over the quantity, rounded
 * (RMFG rounds unit amounts when batch fees do not divide evenly). Anything
 * further apart is two different prices.
 */
function consistentPrice(unit: unknown, total: unknown, quantity: unknown): boolean {
  return cents(unit) && cents(total) && positiveInteger(quantity) && unit > 0 && total > 0 &&
    Math.abs(unit * quantity - total) < quantity;
}

function result(state: RmfgQuoteResult["state"], reason: string, designId: string | null = null,
  quoteId: string | null = null, requirementCodes: string[] = [],
  details: { dfmStatus?: RmfgQuoteResult["dfmStatus"]; offer?: RmfgQuoteOffer | null;
    dfmIssueCodes?: string[] } = {}): RmfgQuoteResult {
  return { revision: RMFG_QUOTE_TRANSPORT_REVISION, state, reason, designId, quoteId,
    requirementCodes, dfmIssueCodes: details.dfmIssueCodes ?? [],
    dfmStatus: details.dfmStatus ?? "unknown", offer: details.offer ?? null, stock: null };
}

function isResult(value: Json | RmfgQuoteResult): value is RmfgQuoteResult {
  return value.revision === RMFG_QUOTE_TRANSPORT_REVISION;
}

async function call(transport: RmfgQuoteTransport, request: RmfgQuoteRequest,
  timeoutMs: number): Promise<{ status: number; body: Json | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      transport(request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("request_timeout")), timeoutMs);
      }),
    ]);
    return { status: response.status, body: record(response.body) };
  } catch {
    return { status: 0, body: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function httpReason(status: number): string {
  if (status === 0) return "transport_error";
  if (status === 401 || status === 403) return "authorization_required";
  if (status === 402) return "account_action_required";
  if (status === 429) return "rate_limited";
  if (status === 409) return "conflict_or_not_ready";
  return `http_${status}`;
}

async function readyDesign(transport: RmfgQuoteTransport, first: Json, polling: Polling): Promise<Json | RmfgQuoteResult> {
  let design = first;
  const id = string(design.id);
  if (!id) return result("unknown", "design_id_missing");
  for (let poll = 0; poll <= polling.maxPolls; poll += 1) {
    if (design.status === "ready") return design;
    if (design.status === "failed") return result("error", "design_failed", id);
    if (design.status !== "queued" && design.status !== "processing")
      return result("unknown", "design_status_unknown", id);
    if (poll === polling.maxPolls) return result("pending", "design_poll_budget_exhausted", id);
    await pause(polling.intervalMs);
    const response = await call(transport, { endpoint: "design", method: "GET",
      path: `/v1/designs/${encodeURIComponent(id)}`, designId: id }, polling.timeoutMs);
    if (response.status !== 200 || !response.body)
      return result("error", httpReason(response.status), id);
    if (response.body.id !== id) return result("unknown", "design_identity_changed", id);
    design = response.body;
  }
  return result("unknown", "design_poll_unreachable", id);
}

async function catalogEntries(transport: RmfgQuoteTransport, endpoint: "materials" | "tube_profiles", timeoutMs: number):
  Promise<Map<string, Json> | null> {
  const ids = new Map<string, Json>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const response = await call(transport, { endpoint, method: "GET",
      path: endpoint === "materials" ? "/v1/materials" : "/v1/tube-profiles", cursor }, timeoutMs);
    if (response.status !== 200 || !response.body || !Array.isArray(response.body.data)) return null;
    for (const item of response.body.data) {
      const entry = record(item);
      const id = string(entry?.id);
      if (!id || ids.has(id)) return null;
      ids.set(id, entry!);
    }
    if (response.body.has_more !== true) return ids;
    const next = string(response.body.next_cursor);
    if (!next || seen.has(next)) return null;
    seen.add(next);
    cursor = next;
  }
  return null;
}

function requirementCodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const codes = value.map((entry) => string(record(entry)?.code));
  return codes.every((code) => code !== null) ? codes as string[] : null;
}

function visibleDfmIssueCodes(dfm: Json | null): string[] {
  const parts = Array.isArray(dfm?.parts) ? dfm.parts : [];
  const issues = [
    ...(Array.isArray(dfm?.assembly_issues) ? dfm.assembly_issues : []),
    ...parts.flatMap((part) => {
      const found = record(part)?.issues;
      return Array.isArray(found) ? found : [];
    }),
  ];
  return issues.flatMap((issue) => {
    const finding = record(issue);
    const code = string(finding?.code);
    return code && finding?.customer_visible !== false ? [code] : [];
  });
}

/**
 * Any blocking finding stops the quote. No request ever lists accepted risks,
 * so a finding RMFG marks `accepted` was not accepted by this caller.
 */
function hasBlockingIssue(dfm: Json | null): boolean {
  const parts = Array.isArray(dfm?.parts) ? dfm.parts : [];
  // An issue list that is present but not a list cannot be read, so it blocks.
  if (filledList(dfm?.assembly_issues) && !Array.isArray(dfm?.assembly_issues)) return true;
  if (parts.some((part) => filledList(record(part)?.issues) && !Array.isArray(record(part)?.issues))) return true;
  const issues = [
    ...(Array.isArray(dfm?.assembly_issues) ? dfm.assembly_issues : []),
    ...parts.flatMap((part) => {
      const found = record(part)?.issues;
      return Array.isArray(found) ? found : [];
    }),
  ];
  return issues.some((issue) => {
    const finding = record(issue);
    if (!finding) return false;
    return finding.severity === "blocking" || finding.severity === undefined;
  });
}

type SelectedPart = { part_id: string; material_id?: string; tube_profile_id?: string };

/** Present and not an empty list: a list RMFG fills, or a value that is not a list at all. */
function filledList(value: unknown): boolean {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
}

function hasUnrequestedConfiguration(configuration: Json | null): boolean {
  const defaults = configuration?.defaults;
  return (configuration?.recommended_finish ?? false) !== false ||
    filledList(configuration?.accepted_risks) || filledList(configuration?.assembly_operations) ||
    (defaults !== undefined && defaults !== null &&
      (!record(defaults) || Object.values(record(defaults)!).some((value) => value !== null && value !== undefined)));
}

/** A configured part with a finish, a coating or any hole operation; none was requested. */
function configuresUnrequestedWork(part: Json | null): boolean {
  if (["finish_id", "powder_coat_color_id"].some((key) => part?.[key] !== null && part?.[key] !== undefined)) return true;
  return ["taps", "studs", "nuts", "standoffs", "countersinks"].some((key) => filledList(part?.[key]));
}

function selectedPartMatches(part: Json | undefined, selection: SelectedPart): boolean {
  if (!part || (part.material_id ?? null) !== (selection.material_id ?? null) ||
      (part.tube_profile_id ?? null) !== (selection.tube_profile_id ?? null)) return false;
  return !configuresUnrequestedWork(part);
}

/** V1PartDFM.finish_id is the finish the part is priced with; absent means As Cut, the only finish requested. */
function pricedWithFinish(part: Json | null): boolean {
  return (part?.finish_id ?? null) !== null || part?.finish_recommended === true;
}

/** Line price components for cutting and forming; finishes, coating and hardware were not requested. */
const REQUESTED_BREAKDOWN_TYPES = new Set(["base", "bends"]);

function pricesBends(line: Json): boolean {
  return Array.isArray(line.breakdown) && line.breakdown.some((part) => record(part)?.type === "bends");
}

function hasUnrequestedCharge(line: Json | null): boolean {
  const breakdown = line?.breakdown;
  if (breakdown === undefined) return false;
  return !Array.isArray(breakdown) ||
    breakdown.some((part) => !REQUESTED_BREAKDOWN_TYPES.has(record(part)?.type as string));
}

/**
 * Evidence, complete or not, that RMFG is pricing something other than the
 * request: echoed configuration, a finish on a part, or a priced operation.
 * It stops the run as soon as it appears, even while the quote is processing.
 */
function showsUnrequestedWork(item: Json | null, dfm: Json | null): boolean {
  const parts = Array.isArray(dfm?.parts) ? dfm.parts : [];
  const lines = Array.isArray(item?.line_items) ? item.line_items : [];
  const configuration = record(dfm?.configuration);
  const configuredParts = Array.isArray(configuration?.parts) ? configuration.parts : [];
  return hasUnrequestedConfiguration(configuration) ||
    configuredParts.some((part) => configuresUnrequestedWork(record(part))) ||
    parts.some((part) => pricedWithFinish(record(part))) ||
    lines.some((line) => hasUnrequestedCharge(record(line))) ||
    (item?.assembly_operations_amount_cents !== undefined && item?.assembly_operations_amount_cents !== 0);
}

/** The echoed configuration is exactly the selected parts, each on its selected stock with nothing added. */
function configurationMatches(configuration: Json | null, selectedParts: SelectedPart[]): boolean {
  const configuredParts = Array.isArray(configuration?.parts) ? configuration.parts : null;
  if (hasUnrequestedConfiguration(configuration) || configuredParts?.length !== selectedParts.length) return false;
  const seen = new Set<string>();
  for (const value of configuredParts) {
    const part = record(value);
    const id = string(part?.part_id);
    const selection = selectedParts.find((entry) => entry.part_id === id);
    if (!id || seen.has(id) || !selection || !selectedPartMatches(part!, selection)) return false;
    seen.add(id);
  }
  return true;
}

function dfmMatchesSelection(dfm: Json | null, selectedParts: SelectedPart[]): boolean {
  const reportedParts = Array.isArray(dfm?.parts) ? dfm.parts : null;
  if (!configurationMatches(record(dfm?.configuration), selectedParts) || reportedParts?.length !== selectedParts.length) return false;
  const reported = new Set<string>();
  for (const value of reportedParts) {
    const part = record(value);
    const id = string(part?.part_id);
    if (!id || reported.has(id) || part?.status !== "ready" || pricedWithFinish(part) ||
        !selectedParts.some((selection) => selection.part_id === id)) return false;
    reported.add(id);
  }
  return true;
}

/**
 * Each unique part is priced once, on the selected stock, at the requested
 * quantity times its instance count, and the lines add up to the item total.
 * A substituted stock, an extra line, a priced operation or an assembly charge
 * is not this request.
 */
/** One line prices a selected part, on its selected stock and process, at the requested quantity, with nothing added. */
function lineMatches(line: Json | null, selection: PreparedSelection, requestedQuantity: number): boolean {
  const partId = string(line?.part_id);
  const part = selection.selectedParts.find((entry) => entry.part_id === partId);
  const instances = partId ? selection.instanceCounts.get(partId) : undefined;
  if (!line || !partId || !part || instances === undefined) return false;
  return line.process === (part.material_id ? "sheet_metal" : "tube_laser") &&
    (line.material_id ?? null) === (part.material_id ?? null) &&
    (line.tube_profile_id ?? null) === (part.tube_profile_id ?? null) &&
    line.quantity === requestedQuantity * instances &&
    !hasUnrequestedCharge(line) && (selection.bentParts.has(partId) || !pricesBends(line));
}

function lineItemsMatch(item: Json, selection: PreparedSelection, requestedQuantity: number): boolean {
  const lines = Array.isArray(item.line_items) ? item.line_items.map(record) : null;
  if (lines?.length !== selection.selectedParts.length) return false;
  if (item.assembly_operations_amount_cents !== undefined && item.assembly_operations_amount_cents !== 0) return false;
  const priced = new Set<string>();
  let total = 0;
  for (const line of lines) {
    const partId = string(line?.part_id);
    if (!partId || priced.has(partId) || !lineMatches(line, selection, requestedQuantity) ||
        !consistentPrice(line!.unit_amount_cents, line!.amount_cents, line!.quantity)) return false;
    priced.add(partId);
    total += line!.amount_cents as number;
  }
  return total === item.amount_cents;
}

/** A value the answer states (present and not null) that differs from the requested one. */
function statedOtherThan(value: unknown, expected: unknown): boolean {
  return value !== undefined && value !== null && value !== expected;
}

/** Part IDs a list names, or null when an entry names none or one appears twice. */
function namedPartIds(entries: unknown[]): string[] | null {
  const ids = entries.map((entry) => string(record(entry)?.part_id));
  return ids.every((id) => id !== null) && new Set(ids).size === ids.length ? ids as string[] : null;
}

/**
 * Evidence in any answer, processing or ready, that RMFG is quoting something
 * other than the request: a charge, another design or quantity, an unselected
 * or repeated part, another stock or process, or another line quantity. Only
 * stated fields are compared, so a partial processing answer is not rejected
 * for what it has not filled in yet; the ready answer is then checked in full.
 */
function contradictsRequest(quote: Json, item: Json | null, dfm: Json | null, designId: string,
  requestedQuantity: number, selection: PreparedSelection): string | null {
  const selected = new Map(selection.selectedParts.map((part) => [part.part_id, part]));
  const unselected = (ids: string[] | null) => ids === null || ids.some((id) => !selected.has(id));
  if ((quote.amount_shipping_cents ?? null) !== null || (quote.amount_tax_cents ?? null) !== null)
    return "quote_totals_unverified";
  if (statedOtherThan(item?.design_id, designId) || statedOtherThan(item?.quantity, requestedQuantity))
    return "offer_provenance_incomplete";
  const configuration = record(dfm?.configuration);
  const configured = configuration?.parts;
  const reported = dfm?.parts;
  if (statedOtherThan(dfm?.design_id, designId) ||
      (configured !== undefined && (!Array.isArray(configured) || unselected(namedPartIds(configured)) ||
        configured.some((entry) => {
          const part = record(entry)!;
          const want = selected.get(string(part.part_id)!)!;
          return statedOtherThan(part.material_id, want.material_id ?? null) ||
            statedOtherThan(part.tube_profile_id, want.tube_profile_id ?? null);
        }))) ||
      (reported !== undefined && (!Array.isArray(reported) || unselected(namedPartIds(reported)))))
    return "dfm_configuration_unverified";
  const lines = item?.line_items;
  if (lines !== undefined && (!Array.isArray(lines) || unselected(namedPartIds(lines)) ||
      lines.some((entry) => {
        const line = record(entry)!;
        const partId = string(line.part_id)!;
        const want = selected.get(partId)!;
        return statedOtherThan(line.process, want.material_id ? "sheet_metal" : "tube_laser") ||
          statedOtherThan(line.material_id, want.material_id ?? null) ||
          statedOtherThan(line.tube_profile_id, want.tube_profile_id ?? null) ||
          statedOtherThan(line.quantity, requestedQuantity * selection.instanceCounts.get(partId)!) ||
          hasUnrequestedCharge(line) || (!selection.bentParts.has(partId) && pricesBends(line));
      })))
    return "line_items_unverified";
  return null;
}

/** A quote selects no shipping and computes no tax, so its totals equal the one item. */
function quoteTotalsMatch(quote: Json, item: Json): boolean {
  if ((quote.amount_shipping_cents ?? null) !== null || (quote.amount_tax_cents ?? null) !== null) return false;
  return [quote.amount_subtotal_cents, quote.amount_total_cents]
    .every((value) => value === undefined || value === null || value === item.amount_cents);
}

/** The quote's stated expiry: absent, or a readable instant still in the future. */
/** RMFG's own standard production estimate (V1FulfillmentEstimate.production). */
function fulfillmentEvidence(quote: Json): RmfgQuoteOffer["fulfillment"] {
  const production = Array.isArray(record(quote.fulfillment)?.production)
    ? (record(quote.fulfillment)!.production as unknown[]).map(record) : [];
  const standard = production.find((estimate) => estimate?.speed === "standard") ?? null;
  const shipDate = string(standard?.estimated_ship_date);
  return {
    standardProductionDays: nonNegativeInteger(standard?.production_days) ? standard!.production_days as number : null,
    standardShipDate: shipDate && /^\d{4}-\d{2}-\d{2}$/.test(shipDate) ? shipDate : null,
    expeditedOffered: production.some((estimate) => estimate?.speed === "expedited"),
  };
}

function pricedComponents(item: Json): string[] {
  const lines = Array.isArray(item.line_items) ? item.line_items : [];
  const types = lines.flatMap((line) => {
    const breakdown = record(line)?.breakdown;
    return Array.isArray(breakdown) ? breakdown.map((part) => string(record(part)?.type)) : [];
  });
  return [...new Set(types.filter((type): type is string => type !== null))].sort((left, right) => left.localeCompare(right));
}

function expiry(value: unknown, nowMs: number): { validUntil: string | null } | "elapsed" | "unreadable" {
  if (value === undefined || value === null) return { validUntil: null };
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return "unreadable";
  return at <= nowMs ? "elapsed" : { validUntil: new Date(at).toISOString() };
}

function manufacturingStop(quote: Json, item: Json | null, dfm: Json | null):
  { state: "blocked" | "requires_input"; reason: string } | null {
  // A stop reported while the quote is still processing stops now; it is never polled past.
  const reportedParts = Array.isArray(dfm?.parts) ? dfm.parts : [];
  if (quote.status === "blocked" || dfm?.status === "blocked" || item?.status === "blocked" ||
      reportedParts.some((part) => record(part)?.status === "blocked") || hasBlockingIssue(dfm))
    return { state: "blocked", reason: "manufacturing_blocked" };
  if (quote.status === "requires_input" || dfm?.status === "requires_input" || item?.status === "requires_input" ||
      reportedParts.some((part) => record(part)?.status === "requires_input"))
    return { state: "requires_input", reason: "manufacturing_input_required" };
  return null;
}

function readyEvidenceIssue(quote: Json, item: Json | null, dfm: Json | null, designId: string,
  requestedQuantity: number, selection: PreparedSelection): string | null {
  if (item?.status !== "ready" || dfm?.status !== "ready" ||
      [quote.requirements, item?.requirements, dfm?.requirements].some((value) => requirementCodes(value) === null))
    return "ready_evidence_incomplete";
  if (dfm?.design_id !== designId || !dfmMatchesSelection(dfm, selection.selectedParts))
    return "dfm_configuration_unverified";
  if (item.design_id !== designId || item.quantity !== requestedQuantity || quote.currency !== "usd" ||
      !consistentPrice(item.unit_amount_cents, item.amount_cents, item.quantity))
    return "offer_provenance_incomplete";
  if (!lineItemsMatch(item, selection, requestedQuantity))
    return "line_items_unverified";
  if (!quoteTotalsMatch(quote, item)) return "quote_totals_unverified";
  return null;
}

function quoteDisposition(quote: Json, designId: string, requestedQuantity: number,
  selection: PreparedSelection, nowMs: number): RmfgQuoteResult {
  const quoteId = string(quote.id);
  if (!quoteId) return result("unknown", "quote_id_missing", designId);
  const items = Array.isArray(quote.items) ? quote.items : null;
  const item = items?.length === 1 ? record(items[0]) : null;
  const dfm = record(item?.dfm);
  const dfmStatus = dfm?.status === "ready" || dfm?.status === "requires_input" || dfm?.status === "blocked"
    ? dfm.status : "unknown";
  const requirements = requirementCodes(quote.requirements);
  const itemRequirements = requirementCodes(item?.requirements);
  const dfmRequirements = requirementCodes(dfm?.requirements);
  const codes = [...(requirements ?? []), ...(itemRequirements ?? []), ...(dfmRequirements ?? [])];
  const findings = visibleDfmIssueCodes(dfm);
  const finish = (state: RmfgQuoteResult["state"], reason: string, offer: RmfgQuoteOffer | null = null) =>
    result(state, reason, designId, quoteId, codes,
      { dfmStatus, offer, dfmIssueCodes: findings });
  if (quote.status === "failed" || quote.status === "expired")
    return finish("error", `quote_${quote.status}`);
  // One item was requested: another count is not this request, processing or not.
  if ((items?.length ?? 0) > 1) return finish("unknown", "quote_items_unverified");
  const stop = manufacturingStop(quote, item, dfm);
  if (stop) return finish(stop.state, stop.reason);
  if (codes.length) return finish("requires_input", "unresolved_requirements");
  if (showsUnrequestedWork(item, dfm)) return finish("unknown", "unrequested_work_priced");
  const contradiction = contradictsRequest(quote, item, dfm, designId, requestedQuantity, selection);
  if (contradiction) return finish("unknown", contradiction);
  if (quote.status === "processing") return finish("pending", "quote_processing");
  if (quote.status !== "ready") return finish("unknown", "quote_status_unknown");
  const readyIssue = readyEvidenceIssue(quote, item, dfm, designId, requestedQuantity, selection);
  if (readyIssue) return finish("unknown", readyIssue);
  const validity = expiry(quote.expires_at, nowMs);
  if (validity === "elapsed") return finish("error", "quote_expired");
  if (validity === "unreadable") return finish("unknown", "quote_expiry_unverified");
  const verifiedItem = item!;
  const offer: RmfgQuoteOffer = {
    providerOptionId: `${quoteId}:${designId}:${verifiedItem.quantity}`,
    quoteRef: quoteId, designId, quantity: verifiedItem.quantity as number, currency: "USD",
    unitPriceUsd: (verifiedItem.unit_amount_cents as number) / 100,
    totalPriceUsd: (verifiedItem.amount_cents as number) / 100,
    leadTimeBusinessDays: null,
    validUntil: validity.validUntil,
    totalCents: verifiedItem.amount_cents as number,
    fulfillment: fulfillmentEvidence(quote),
    pricedComponents: pricedComponents(verifiedItem),
    provenance: {
      quantity: "items[0].quantity", currency: "currency",
      unitPrice: "items[0].unit_amount_cents", totalPrice: "items[0].amount_cents",
      leadTimeBusinessDays: "unknown",
    },
  };
  return finish("ready", "quote_ready", offer);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Lower case words and numbers only, with a letter split from a leading number: "6061-T6" and "6061T6" read "6061 t6". */
function normalizedLabel(value: string): string {
  return value.toLowerCase().replaceAll(/(\d)([a-z])/g, "$1 $2").replaceAll(/[^a-z0-9]+/g, " ").trim();
}

/** "6061 t6", "5052 h32", "6061 o": an alloy alone, or a family name, would let the catalog choose the temper. */
const STOCK_GRADE_PATTERN = /^\d{4} [a-z]\d*$/;

function validStock(stock: RmfgStockRequirement | undefined, selections: RmfgQuoteInput["selections"]): boolean {
  if (stock === undefined) return true;
  const grade = typeof stock?.grade === "string" ? normalizedLabel(stock.grade) : "";
  return Object.keys(selections).length === 0 && STOCK_GRADE_PATTERN.test(grade) &&
    typeof stock.thicknessIn === "number" && Number.isFinite(stock.thicknessIn) &&
    stock.thicknessIn > 0 && stock.thicknessIn <= 1;
}

function validInput(input: RmfgQuoteInput): boolean {
  return Boolean(input?.file && input.file.bytes instanceof Uint8Array &&
    typeof input.file.name === "string" && record(input.selections) &&
    /\.(step|stp)$/i.test(input.file.name) && input.file.bytes.length > 0 &&
    input.file.bytes.length <= MAX_FILE_BYTES && positiveInteger(input.quantity) &&
    input.quantity <= 1_000_000 && string(input.analyzeKey) && string(input.quoteKey) &&
    input.analyzeKey !== input.quoteKey && validStock(input.stock, input.selections) &&
    (input.now === undefined || typeof input.now === "function") &&
    (input.requestTimeoutMs === undefined || (positiveInteger(input.requestTimeoutMs) &&
      input.requestTimeoutMs <= DEFAULT_REQUEST_TIMEOUT_MS)) &&
    (input.pollIntervalMs === undefined || (nonNegativeInteger(input.pollIntervalMs) &&
      input.pollIntervalMs <= MAX_POLL_INTERVAL_MS)) &&
    (input.maxPolls === undefined || (positiveInteger(input.maxPolls) && input.maxPolls <= MAX_POLL_LIMIT)));
}

/**
 * V1Part documents `instance_count` 1 and `analysis_status` "ready" as the
 * defaults when a field is omitted. An explicit null or any other value is not
 * the default and is not trusted.
 */
function instanceCount(part: Json): number | null {
  const count = part.instance_count === undefined ? 1 : part.instance_count;
  return positiveInteger(count) ? count : null;
}

function validAnalyzedPart(part: Json | null): boolean {
  return Boolean(part && string(part.id) && instanceCount(part) !== null &&
    (part.analysis_status === undefined || part.analysis_status === "ready") &&
    (part.suggested_process === "sheet_metal" || part.suggested_process === "tube_laser"));
}

function selectedPartFor(part: Json, selection: RmfgQuoteInput["selections"][string] | null,
  materialIds: ReadonlyMap<string, Json>, tubeIds: ReadonlyMap<string, Json>): SelectedPart | "sheet_material_id_required" | "tube_profile_id_required" {
  const partId = string(part.id)!;
  if (part.suggested_process === "sheet_metal") {
    if (!selection?.materialId || selection.tubeProfileId || !materialIds.has(selection.materialId))
      return "sheet_material_id_required";
    return { part_id: partId, material_id: selection.materialId };
  }
  if (!selection?.tubeProfileId || selection.materialId || !tubeIds.has(selection.tubeProfileId))
    return "tube_profile_id_required";
  return { part_id: partId, tube_profile_id: selection.tubeProfileId };
}

/** The design is exactly the one sheet part, of the stated thickness, that the stated stock describes. */
function stockScopeReason(parts: Json[], stock: RmfgStockRequirement): string | null {
  if (parts.length !== 1) return "stock_scope_multiple_parts";
  const [part] = parts;
  if (instanceCount(part) !== 1) return "stock_scope_instance_count";
  if (part.suggested_process !== "sheet_metal") return "stock_scope_process_mismatch";
  const thicknessMm = part.detected_thickness_mm;
  if (typeof thicknessMm !== "number" || !Number.isFinite(thicknessMm)) return "stock_scope_thickness_unverified";
  if (Math.abs(thicknessMm - stock.thicknessIn * 25.4) > PART_THICKNESS_TOLERANCE_MM)
    return "stock_scope_thickness_mismatch";
  return null;
}

/** Bends are assumed when the analyzer's count is present but not a whole number (omitted means 0). */
function hasBends(part: Json): boolean {
  const count = part.bend_count === undefined ? 0 : part.bend_count;
  return !nonNegativeInteger(count) || count > 0 || (Array.isArray(part.bends) && part.bends.length > 0);
}

/** Words that name the metal family or stock form, not a different product. */
const PLAIN_STOCK_WORDS = new Set(["aluminum", "aluminium", "sheet", "plate"]);

function rawStockLabel(entry: Json): string {
  return `${string(entry.material) ?? ""} ${string(entry.type) ?? ""}`.trim();
}

/** Catalog entries at the stated nominal thickness; 0.124 in is not 0.125 in. */
function atStockThickness(catalog: ReadonlyMap<string, Json>, stock: RmfgStockRequirement): Json[] {
  return [...catalog.values()].filter((entry) => typeof entry.thickness_in === "number" &&
    Math.round(entry.thickness_in * 10_000) === Math.round(stock.thicknessIn * 10_000));
}

/**
 * The entry is the stated grade itself: its `material` and `type` name that
 * alloy and temper, and any other word only names the family or form. "6061 T6
 * PVC coated" or "6061-T6 diamond plate" is a different product.
 */
function isPlainStock(entry: Json, stock: RmfgStockRequirement): boolean {
  const grade = ` ${normalizedLabel(stock.grade)} `;
  const label = ` ${normalizedLabel(rawStockLabel(entry))} `;
  if (!label.includes(grade)) return false;
  return label.replace(grade, " ").trim().split(" ").filter(Boolean).every((word) => PLAIN_STOCK_WORDS.has(word));
}

type PreparedSelection = {
  designId: string;
  selectedParts: SelectedPart[];
  instanceCounts: Map<string, number>;
  /** Parts the analyzer found (or could not rule out) bends on; only these may carry a bend price. */
  bentParts: Set<string>;
  stock: RmfgQuoteResult["stock"];
};

async function prepareStock(stock: RmfgStockRequirement, transport: RmfgQuoteTransport,
  designId: string, parts: Json[], timeoutMs: number): Promise<PreparedSelection | RmfgQuoteResult> {
  const scope = stockScopeReason(parts, stock);
  if (scope) return result("requires_input", scope, designId);
  const [part] = parts;
  const catalog = await catalogEntries(transport, "materials", timeoutMs);
  if (!catalog) return result("error", "catalog_incomplete", designId);
  const offered = atStockThickness(catalog, stock);
  const candidates = offered.filter((entry) => isPlainStock(entry, stock));
  if (candidates.length !== 1) {
    const stockMatches = offered.slice(0, 8).map((entry) => ({ materialId: string(entry.id)!,
      label: rawStockLabel(entry).slice(0, 80), thicknessIn: entry.thickness_in as number }));
    return { ...result("requires_input", candidates.length ? "stock_ambiguous" : "stock_not_offered", designId),
      stockMatches };
  }
  const [material] = candidates;
  if (hasBends(part) && material.bendable !== true) return result("requires_input", "stock_not_bendable", designId);
  const partId = string(part.id)!;
  const materialId = string(material.id)!;
  return { designId, selectedParts: [{ part_id: partId, material_id: materialId }],
    instanceCounts: new Map([[partId, 1]]), bentParts: new Set(hasBends(part) ? [partId] : []),
    stock: { materialId, thicknessIn: material.thickness_in as number, label: rawStockLabel(material).slice(0, 80),
      displayThickness: string(material.display_thickness)?.slice(0, 40) ?? null } };
}

async function prepareSelection(input: RmfgQuoteInput, transport: RmfgQuoteTransport,
  design: Json, timeoutMs: number): Promise<PreparedSelection | RmfgQuoteResult> {
  const designId = string(design.id)!;
  const parts = Array.isArray(design.parts) ? design.parts.map(record) : null;
  if (!parts?.length || parts.some((part) => !validAnalyzedPart(part)))
    return result("unknown", "parts_unverified", designId);
  const instanceCounts = new Map<string, number>();
  for (const part of parts) {
    const partId = string(part?.id)!;
    if (instanceCounts.has(partId)) return result("unknown", "part_identity_duplicate", designId);
    instanceCounts.set(partId, instanceCount(part!)!);
  }
  if (input.stock) return prepareStock(input.stock, transport, designId, parts as Json[], timeoutMs);
  const sheet = parts.some((part) => part?.suggested_process === "sheet_metal");
  const tube = parts.some((part) => part?.suggested_process === "tube_laser");
  const materialIds = sheet ? await catalogEntries(transport, "materials", timeoutMs) : new Map<string, Json>();
  const tubeIds = tube ? await catalogEntries(transport, "tube_profiles", timeoutMs) : new Map<string, Json>();
  if (!materialIds || !tubeIds) return result("error", "catalog_incomplete", designId);
  const selectedParts: SelectedPart[] = [];
  for (const part of parts) {
    const partId = string(part?.id)!;
    const selection = Object.hasOwn(input.selections, partId) ? input.selections[partId] : null;
    const selected = selectedPartFor(part!, selection, materialIds, tubeIds);
    if (typeof selected === "string") return result("requires_input", selected, designId);
    selectedParts.push(selected);
  }
  if (Object.keys(input.selections).some((partId) => !instanceCounts.has(partId)))
    return result("unknown", "unrecognized_part_selection", designId);
  const bentParts = new Set(parts.filter((part) => hasBends(part!)).map((part) => string(part!.id)!));
  return { designId, selectedParts, instanceCounts, bentParts, stock: null };
}

async function requestQuote(input: RmfgQuoteInput, transport: RmfgQuoteTransport,
  selection: PreparedSelection, polling: Polling): Promise<RmfgQuoteResult> {
  const { designId, selectedParts } = selection;
  const body = { items: [{ design_id: designId, quantity: input.quantity, configuration: { parts: selectedParts } }] };
  const bodyDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  const quoted = await call(transport, { endpoint: "quote", method: "POST", path: "/v1/quotes",
    idempotencyKey: `${input.quoteKey}-${bodyDigest}`, body }, polling.timeoutMs);
  if ((quoted.status !== 200 && quoted.status !== 201 && quoted.status !== 202) || !quoted.body)
    return result("error", httpReason(quoted.status), designId);
  let quote = quoted.body;
  const quoteId = string(quote.id);
  if (!quoteId) return result("unknown", "quote_id_missing", designId);
  for (let poll = 0; poll <= polling.maxPolls; poll += 1) {
    const disposition = quoteDisposition(quote, designId, input.quantity, selection, polling.now());
    if (disposition.state !== "pending" || poll === polling.maxPolls)
      return poll === polling.maxPolls && disposition.state === "pending"
        ? result("pending", "quote_poll_budget_exhausted", designId, quoteId,
          disposition.requirementCodes,
          { dfmStatus: disposition.dfmStatus, dfmIssueCodes: disposition.dfmIssueCodes }) : disposition;
    await pause(polling.intervalMs);
    const response = await call(transport, { endpoint: "quote_status", method: "GET",
      path: `/v1/quotes/${encodeURIComponent(quoteId)}`, quoteId }, polling.timeoutMs);
    if (response.status !== 200 || !response.body)
      return result("error", httpReason(response.status), designId, quoteId);
    if (response.body.id !== quoteId) return result("unknown", "quote_identity_changed", designId, quoteId);
    quote = response.body;
  }
  return result("unknown", "quote_poll_unreachable", designId, quoteId);
}

/** Runs one bounded synthetic-friendly quote path; no default network transport exists. */
export async function runRmfgQuoteOnly(input: RmfgQuoteInput, transport: RmfgQuoteTransport): Promise<RmfgQuoteResult> {
  if (!validInput(input)) return result("error", "invalid_quote_input");
  const polling: Polling = { timeoutMs: input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    intervalMs: input.pollIntervalMs ?? 0, maxPolls: input.maxPolls ?? DEFAULT_MAX_POLLS, now: input.now ?? Date.now };
  const analyzed = await call(transport, { endpoint: "analyze", method: "POST", path: "/v1/analyze", file: input.file,
    idempotencyKey: input.analyzeKey }, polling.timeoutMs);
  if ((analyzed.status !== 200 && analyzed.status !== 202) || !analyzed.body)
    return result("error", httpReason(analyzed.status));
  const design = await readyDesign(transport, analyzed.body, polling);
  if (isResult(design)) return design;
  const selection = await prepareSelection(input, transport, design, polling.timeoutMs);
  if ("state" in selection) return selection;
  const quoted = await requestQuote(input, transport, selection, polling);
  return { ...quoted, stock: selection.stock };
}
