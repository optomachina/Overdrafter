/**
 * Offline RMFG REST quote contract. The caller supplies every response and file
 * byte; this module has no HTTP client, credential handling, or runtime registry
 * entry. Endpoint variants deliberately exclude carts, checkout, and orders.
 *
 * Source: https://api.rmfg.com/v1/openapi.json (2026-09-28), specifically
 * V1Design, V1Part, V1Material, V1QuoteRequest, V1Quote, V1QuotedDesign,
 * V1DFMReport, V1Requirement, and V1FulfillmentEstimate.
 */
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

export type RmfgQuoteInput = {
  file: { name: string; bytes: Uint8Array };
  quantity: number;
  /** IDs selected by a person from this design's current catalog, keyed by analyzed part ID. */
  selections: Record<string, { materialId?: string; tubeProfileId?: string }>;
  analyzeKey: string;
  quoteKey: string;
  /** Per injected request; capped at ten seconds so a stalled fixture is finite. */
  requestTimeoutMs?: number;
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
};

type Json = Record<string, unknown>;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_POLLS = 3;
const MAX_CATALOG_PAGES = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

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

function result(state: RmfgQuoteResult["state"], reason: string, designId: string | null = null,
  quoteId: string | null = null, requirementCodes: string[] = [],
  details: { dfmStatus?: RmfgQuoteResult["dfmStatus"]; offer?: RmfgQuoteOffer | null;
    dfmIssueCodes?: string[] } = {}): RmfgQuoteResult {
  return { revision: RMFG_QUOTE_TRANSPORT_REVISION, state, reason, designId, quoteId,
    requirementCodes, dfmIssueCodes: details.dfmIssueCodes ?? [],
    dfmStatus: details.dfmStatus ?? "unknown", offer: details.offer ?? null };
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
  if (status === 429) return "rate_limited";
  if (status === 409) return "conflict_or_not_ready";
  return `http_${status}`;
}

async function readyDesign(transport: RmfgQuoteTransport, first: Json, timeoutMs: number): Promise<Json | RmfgQuoteResult> {
  let design = first;
  const id = string(design.id);
  if (!id) return result("unknown", "design_id_missing");
  for (let poll = 0; poll <= MAX_POLLS; poll += 1) {
    if (design.status === "ready") return design;
    if (design.status === "failed") return result("error", "design_failed", id);
    if (design.status !== "queued" && design.status !== "processing")
      return result("unknown", "design_status_unknown", id);
    if (poll === MAX_POLLS) return result("pending", "design_poll_budget_exhausted", id);
    const response = await call(transport, { endpoint: "design", method: "GET",
      path: `/v1/designs/${encodeURIComponent(id)}`, designId: id }, timeoutMs);
    if (response.status !== 200 || !response.body)
      return result("error", httpReason(response.status), id);
    if (response.body.id !== id) return result("unknown", "design_identity_changed", id);
    design = response.body;
  }
  return result("unknown", "design_poll_unreachable", id);
}

async function catalogIds(transport: RmfgQuoteTransport, endpoint: "materials" | "tube_profiles", timeoutMs: number):
  Promise<Set<string> | null> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const response = await call(transport, { endpoint, method: "GET",
      path: endpoint === "materials" ? "/v1/materials" : "/v1/tube-profiles", cursor }, timeoutMs);
    if (response.status !== 200 || !response.body || !Array.isArray(response.body.data)) return null;
    for (const item of response.body.data) {
      const id = string(record(item)?.id);
      if (!id) return null;
      ids.add(id);
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

function hasUnacceptedBlockingIssue(dfm: Json | null): boolean {
  const parts = Array.isArray(dfm?.parts) ? dfm.parts : [];
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
    return (finding.severity === "blocking" || finding.severity === undefined)
      && finding.accepted !== true;
  });
}

type SelectedPart = { part_id: string; material_id?: string; tube_profile_id?: string };

function hasUnrequestedConfiguration(configuration: Json | null): boolean {
  const defaults = record(configuration?.defaults);
  return (Array.isArray(configuration?.accepted_risks) && configuration.accepted_risks.length > 0) ||
    (Array.isArray(configuration?.assembly_operations) && configuration.assembly_operations.length > 0) ||
    Boolean(defaults && Object.values(defaults).some((value) => value !== null && value !== undefined));
}

function selectedPartMatches(part: Json | undefined, selection: SelectedPart): boolean {
  if (!part || (part.material_id ?? null) !== (selection.material_id ?? null) ||
      (part.tube_profile_id ?? null) !== (selection.tube_profile_id ?? null)) return false;
  if (["finish_id", "powder_coat_color_id"].some((key) => part[key] !== null && part[key] !== undefined)) return false;
  return !["taps", "studs", "nuts", "standoffs", "countersinks"].some((key) =>
    Array.isArray(part[key]) && (part[key] as unknown[]).length > 0);
}

function dfmMatchesSelection(dfm: Json | null, selectedParts: SelectedPart[]): boolean {
  const configuration = record(dfm?.configuration);
  const configuredParts = Array.isArray(configuration?.parts) ? configuration.parts : null;
  const reportedParts = Array.isArray(dfm?.parts) ? dfm.parts : null;
  if (hasUnrequestedConfiguration(configuration)) return false;
  if (!configuredParts || !reportedParts || configuredParts.length !== selectedParts.length ||
      reportedParts.length !== selectedParts.length) return false;
  const configured = new Map<string, Json>();
  for (const value of configuredParts) {
    const part = record(value);
    const id = string(part?.part_id);
    if (!id || configured.has(id)) return false;
    configured.set(id, part!);
  }
  const reported = new Set<string>();
  for (const value of reportedParts) {
    const part = record(value);
    const id = string(part?.part_id);
    if (!id || reported.has(id) || part?.status !== "ready") return false;
    reported.add(id);
  }
  for (const selection of selectedParts) {
    if (!reported.has(selection.part_id) || !selectedPartMatches(configured.get(selection.part_id), selection))
      return false;
  }
  return true;
}

function quoteDisposition(quote: Json, designId: string, requestedQuantity: number,
  selectedParts: Array<{ part_id: string; material_id?: string; tube_profile_id?: string }>): RmfgQuoteResult {
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
  if (quote.status === "processing") return finish("pending", "quote_processing");
  if (quote.status === "failed" || quote.status === "expired")
    return finish("error", `quote_${quote.status}`);
  const reportedParts = Array.isArray(dfm?.parts) ? dfm.parts : [];
  if (quote.status === "blocked" || dfmStatus === "blocked" || item?.status === "blocked" ||
      reportedParts.some((part) => record(part)?.status === "blocked") || hasUnacceptedBlockingIssue(dfm))
    return finish("blocked", "manufacturing_blocked");
  if (quote.status === "requires_input" || dfmStatus === "requires_input" || item?.status === "requires_input" ||
      reportedParts.some((part) => record(part)?.status === "requires_input"))
    return finish("requires_input", "manufacturing_input_required");
  if (quote.status !== "ready") return finish("unknown", "quote_status_unknown");
  if (item?.status !== "ready" || dfmStatus !== "ready" ||
      requirements === null || itemRequirements === null || dfmRequirements === null)
    return finish("unknown", "ready_evidence_incomplete");
  if (codes.length) return finish("requires_input", "unresolved_requirements");
  if (dfm?.design_id !== designId || !dfmMatchesSelection(dfm, selectedParts))
    return finish("unknown", "dfm_configuration_unverified");
  if (item.design_id !== designId || item.quantity !== requestedQuantity || quote.currency !== "usd" ||
      !cents(item.unit_amount_cents) || !cents(item.amount_cents))
    return finish("unknown", "offer_provenance_incomplete");
  const offer: RmfgQuoteOffer = {
    providerOptionId: `${quoteId}:${designId}:${item.quantity}`,
    quoteRef: quoteId, designId, quantity: item.quantity as number, currency: "USD",
    unitPriceUsd: (item.unit_amount_cents as number) / 100,
    totalPriceUsd: (item.amount_cents as number) / 100,
    leadTimeBusinessDays: null,
    provenance: {
      quantity: "items[0].quantity", currency: "currency",
      unitPrice: "items[0].unit_amount_cents", totalPrice: "items[0].amount_cents",
      leadTimeBusinessDays: "unknown",
    },
  };
  return finish("ready", "quote_ready", offer);
}

function validInput(input: RmfgQuoteInput): boolean {
  return Boolean(input?.file && input.file.bytes instanceof Uint8Array &&
    typeof input.file.name === "string" && record(input.selections) &&
    /\.(step|stp)$/i.test(input.file.name) && input.file.bytes.length > 0 &&
    input.file.bytes.length <= MAX_FILE_BYTES && positiveInteger(input.quantity) &&
    input.quantity <= 1_000_000 && string(input.analyzeKey) && string(input.quoteKey) &&
    input.analyzeKey !== input.quoteKey &&
    (input.requestTimeoutMs === undefined || (positiveInteger(input.requestTimeoutMs) &&
      input.requestTimeoutMs <= DEFAULT_REQUEST_TIMEOUT_MS)));
}

function validAnalyzedPart(part: Json | null): boolean {
  return Boolean(part && string(part.id) && positiveInteger(part.instance_count) &&
    part.analysis_status === "ready" &&
    (part.suggested_process === "sheet_metal" || part.suggested_process === "tube_laser"));
}

function selectedPartFor(part: Json, selection: RmfgQuoteInput["selections"][string] | null,
  materialIds: Set<string>, tubeIds: Set<string>): SelectedPart | "sheet_material_id_required" | "tube_profile_id_required" {
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

async function prepareSelection(input: RmfgQuoteInput, transport: RmfgQuoteTransport,
  design: Json, timeoutMs: number): Promise<{ designId: string; selectedParts: SelectedPart[] } | RmfgQuoteResult> {
  const designId = string(design.id)!;
  const parts = Array.isArray(design.parts) ? design.parts.map(record) : null;
  if (!parts?.length || parts.some((part) => !validAnalyzedPart(part)))
    return result("unknown", "parts_unverified", designId);
  const sheet = parts.some((part) => part?.suggested_process === "sheet_metal");
  const tube = parts.some((part) => part?.suggested_process === "tube_laser");
  const materialIds = sheet ? await catalogIds(transport, "materials", timeoutMs) : new Set<string>();
  const tubeIds = tube ? await catalogIds(transport, "tube_profiles", timeoutMs) : new Set<string>();
  if (!materialIds || !tubeIds) return result("error", "catalog_incomplete", designId);
  const selectedParts: SelectedPart[] = [];
  const seenPartIds = new Set<string>();
  for (const part of parts) {
    const partId = string(part?.id)!;
    if (seenPartIds.has(partId)) return result("unknown", "part_identity_duplicate", designId);
    seenPartIds.add(partId);
    const selection = Object.hasOwn(input.selections, partId) ? input.selections[partId] : null;
    const selected = selectedPartFor(part!, selection, materialIds, tubeIds);
    if (typeof selected === "string") return result("requires_input", selected, designId);
    selectedParts.push(selected);
  }
  if (Object.keys(input.selections).some((partId) => !seenPartIds.has(partId)))
    return result("unknown", "unrecognized_part_selection", designId);
  return { designId, selectedParts };
}

async function requestQuote(input: RmfgQuoteInput, transport: RmfgQuoteTransport,
  designId: string, selectedParts: SelectedPart[], timeoutMs: number): Promise<RmfgQuoteResult> {
  const quoted = await call(transport, { endpoint: "quote", method: "POST", path: "/v1/quotes", idempotencyKey: input.quoteKey,
    body: { items: [{ design_id: designId, quantity: input.quantity,
      configuration: { parts: selectedParts } }] } }, timeoutMs);
  if ((quoted.status !== 200 && quoted.status !== 201 && quoted.status !== 202) || !quoted.body)
    return result("error", httpReason(quoted.status), designId);
  let quote = quoted.body;
  const quoteId = string(quote.id);
  if (!quoteId) return result("unknown", "quote_id_missing", designId);
  for (let poll = 0; poll <= MAX_POLLS; poll += 1) {
    const disposition = quoteDisposition(quote, designId, input.quantity, selectedParts);
    if (disposition.state !== "pending" || poll === MAX_POLLS)
      return poll === MAX_POLLS && disposition.state === "pending"
        ? result("pending", "quote_poll_budget_exhausted", designId, quoteId,
          disposition.requirementCodes,
          { dfmStatus: disposition.dfmStatus, dfmIssueCodes: disposition.dfmIssueCodes }) : disposition;
    const response = await call(transport, { endpoint: "quote_status", method: "GET",
      path: `/v1/quotes/${encodeURIComponent(quoteId)}`, quoteId }, timeoutMs);
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
  const timeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const analyzed = await call(transport, { endpoint: "analyze", method: "POST", path: "/v1/analyze", file: input.file,
    idempotencyKey: input.analyzeKey }, timeoutMs);
  if ((analyzed.status !== 200 && analyzed.status !== 202) || !analyzed.body)
    return result("error", httpReason(analyzed.status));
  const design = await readyDesign(transport, analyzed.body, timeoutMs);
  if (isResult(design)) return design;
  const selection = await prepareSelection(input, transport, design, timeoutMs);
  if ("state" in selection) return selection;
  return requestQuote(input, transport, selection.designId, selection.selectedParts, timeoutMs);
}
