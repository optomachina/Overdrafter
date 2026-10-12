/**
 * OVD-463: provider neutral validation of normalized adapter results.
 *
 * Adapter output is untrusted. Every result must pass `validateProviderResult`
 * before it can be persisted or shown as a live offer. The validator is pure:
 * it reads no clock, network, database or environment, and it never echoes
 * adapter supplied strings into its rejection output (only paths and finite
 * codes), so a rejection is safe to show to admins and to persist.
 *
 * Out of scope here: browser extraction, persistence wiring, session leasing and
 * authorization consumption (OVD-461, OVD-462, OVD-464). The caller supplies the
 * authorized execution as `ProviderResultExpectation`.
 */
import type {
  GeographicOrigin,
  VendorAutomationErrorCode,
  VendorName,
  VendorQuoteAdapterOffer,
  VendorQuoteAdapterOutput,
} from "./types.js";

export const PROVIDER_RESULT_CONTRACT_VERSION = "ovd-463.provider-result.v1" as const;

export const MAX_OFFERS_PER_RESULT = 50;
export const MAX_ARTIFACTS_PER_RESULT = 20;
export const MAX_REJECTION_ISSUES = 20;
export const MAX_UNIT_OR_TOTAL_PRICE_USD = 10_000_000;
export const MAX_LEAD_TIME_BUSINESS_DAYS = 365;
export const DEFAULT_MAX_RESULT_AGE_MS = 30 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_ID_LENGTH = 160;
const MAX_TEXT_LENGTH = 300;
const MAX_RAW_PAYLOAD_BYTES = 16 * 1024;
const MAX_RAW_PAYLOAD_DEPTH = 4;
const MAX_RAW_STRING_LENGTH = 500;

/** The authorized execution a result must be bound to. Supplied by the caller, never the adapter. */
export type ProviderResultExpectation = {
  provider: VendorName;
  taskId: string;
  laneId: string;
  permitId: string;
  runId: string;
  envelopeRevision: string;
  policyRevision: string;
  /** Disclosed package identity (for example the exact file set hash). */
  packageId: string;
  requestedQuantity: number;
  /** Exact host or parent domain allowlist for quote URLs; HTTPS only. */
  allowedDomains: readonly string[];
  /** Validation instant; the validator reads no clock. */
  now: string;
  maxAgeMs?: number;
};

/** What the adapter returns, wrapped with the execution it claims to belong to. */
export type ProviderResultCandidate = {
  contractVersion: string;
  binding: {
    provider: string;
    taskId: string;
    laneId: string;
    permitId: string;
    runId: string;
    envelopeRevision: string;
    policyRevision: string;
    packageId: string;
    quantity: number;
    adapterRevision: string;
  };
  currency: string;
  collectedAt: string;
  simulated?: boolean;
  result: VendorQuoteAdapterOutput;
};

export type ProviderResultRejectionCode =
  | "unsupported_contract_version"
  | "malformed_candidate"
  | "binding_mismatch"
  | "simulated_result"
  | "adapter_admission_claim"
  | "provider_reported_non_quote"
  | "missing_offers"
  | "partial_offer_set"
  | "too_many_offers"
  | "duplicate_offer_id"
  | "invalid_offer_id"
  | "invalid_currency"
  | "invalid_quantity"
  | "invalid_price"
  | "price_inconsistent"
  | "invalid_lead_time"
  | "invalid_origin"
  | "untrusted_source"
  | "invalid_destination"
  | "invalid_timestamp"
  | "stale_result"
  | "expired_validity"
  | "invalid_artifacts"
  | "forbidden_content";

export type ProviderResultRetryDisposition = "none" | "bounded" | "manual_follow_up";

export type ProviderResultIssue = {
  code: ProviderResultRejectionCode;
  /** Dotted path into the candidate. Never contains adapter supplied values. */
  path: string;
};

export type ProviderResultRejection = {
  contractVersion: typeof PROVIDER_RESULT_CONTRACT_VERSION;
  /** Always true: a rejection is persisted for admins, never silently dropped. */
  adminVisible: true;
  provider: VendorName;
  taskId: string;
  runId: string;
  code: ProviderResultRejectionCode;
  retry: ProviderResultRetryDisposition;
  /** Remaining retries allowed when `retry` is `bounded`; otherwise 0. */
  retryBudget: number;
  issues: ProviderResultIssue[];
  issueCount: number;
};

export type ValidatedProviderOffer = Omit<VendorQuoteAdapterOffer, "quantity" | "quoteUrl"> & {
  quantity: number;
  quoteUrl: string;
  currency: "USD";
  /** True when the offer was built from the singular compatibility summary. */
  derivedFromSummary: boolean;
};

export type ValidatedProviderResult = {
  contractVersion: typeof PROVIDER_RESULT_CONTRACT_VERSION;
  provenance: {
    provider: VendorName;
    taskId: string;
    laneId: string;
    permitId: string;
    runId: string;
    envelopeRevision: string;
    policyRevision: string;
    packageId: string;
    adapterRevision: string;
    collectedAt: string;
    validatedAt: string;
  };
  status: VendorQuoteAdapterOutput["status"];
  quotedAt: string | null;
  validUntil: string | null;
  offers: readonly ValidatedProviderOffer[];
};

export type ProviderResultValidation =
  | { ok: true; value: ValidatedProviderResult }
  | { ok: false; rejection: ProviderResultRejection };

const RETRY_BY_CODE: Record<ProviderResultRejectionCode, { retry: ProviderResultRetryDisposition; budget: number }> = {
  unsupported_contract_version: { retry: "none", budget: 0 },
  malformed_candidate: { retry: "manual_follow_up", budget: 0 },
  binding_mismatch: { retry: "none", budget: 0 },
  simulated_result: { retry: "none", budget: 0 },
  adapter_admission_claim: { retry: "none", budget: 0 },
  provider_reported_non_quote: { retry: "manual_follow_up", budget: 0 },
  missing_offers: { retry: "bounded", budget: 1 },
  partial_offer_set: { retry: "bounded", budget: 1 },
  too_many_offers: { retry: "manual_follow_up", budget: 0 },
  duplicate_offer_id: { retry: "manual_follow_up", budget: 0 },
  invalid_offer_id: { retry: "manual_follow_up", budget: 0 },
  invalid_currency: { retry: "manual_follow_up", budget: 0 },
  invalid_quantity: { retry: "none", budget: 0 },
  invalid_price: { retry: "manual_follow_up", budget: 0 },
  price_inconsistent: { retry: "manual_follow_up", budget: 0 },
  invalid_lead_time: { retry: "manual_follow_up", budget: 0 },
  invalid_origin: { retry: "manual_follow_up", budget: 0 },
  untrusted_source: { retry: "manual_follow_up", budget: 0 },
  invalid_destination: { retry: "none", budget: 0 },
  invalid_timestamp: { retry: "manual_follow_up", budget: 0 },
  stale_result: { retry: "bounded", budget: 1 },
  expired_validity: { retry: "bounded", budget: 1 },
  invalid_artifacts: { retry: "manual_follow_up", budget: 0 },
  forbidden_content: { retry: "none", budget: 0 },
};

/** Precedence when several issues exist: the most security relevant code leads. */
const CODE_PRECEDENCE: ProviderResultRejectionCode[] = [
  "unsupported_contract_version",
  "malformed_candidate",
  "binding_mismatch",
  "simulated_result",
  "adapter_admission_claim",
  "forbidden_content",
  "invalid_destination",
  "provider_reported_non_quote",
  "stale_result",
  "expired_validity",
  "missing_offers",
  "partial_offer_set",
  "too_many_offers",
  "duplicate_offer_id",
];

const ADMISSION_KEY = /admission|admitted|certif|permit_?granted|production_?ready|authorized_?by|bypass/i;
const CREDENTIAL_KEY = /cookie|password|passwd|secret|authorization|bearer|api_?key|storage_?state|access_?token|refresh_?token|session_?(id|token|secret)|credential/i;
const BULK_KEY = /^(html|dom|outerhtml|innerhtml|bodyexcerpt|body_excerpt|screenshot|pagecontent|fileBytes|cadBytes)$/i;
const CREDENTIAL_VALUE = /(bearer\s+[a-z0-9._-]{16,}|eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.|sk-[a-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY)/i;
function hasControlChars(value: string) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !hasControlChars(value);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_UNIT_OR_TOTAL_PRICE_USD;
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 40) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T23:59:59.999Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function hostAllowed(host: string, allowed: readonly string[]) {
  const lower = host.toLowerCase();
  return allowed.some((domain) => {
    const d = domain.toLowerCase();
    return lower === d || lower.endsWith(`.${d}`);
  });
}

function validDestination(value: unknown, allowed: readonly string[]): value is string {
  if (typeof value !== "string" || value.length > 2048) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && hostAllowed(url.hostname, allowed);
  } catch {
    return false;
  }
}

/** Walks a payload looking for credential shaped keys or values, bounded in depth and size. */
function containsCredentialMaterial(value: unknown, depth = 0): boolean {
  if (depth > 8) {
    return true;
  }
  if (typeof value === "string") {
    return CREDENTIAL_VALUE.test(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).some((item) => containsCredentialMaterial(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, item]) => CREDENTIAL_KEY.test(key) || containsCredentialMaterial(item, depth + 1),
    );
  }
  return false;
}

function hasAdmissionClaim(value: unknown, depth = 0): boolean {
  if (depth > 4 || !isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, item]) => (ADMISSION_KEY.test(key) && item !== false && item !== null && item !== undefined)
      || hasAdmissionClaim(item, depth + 1),
  );
}

/** Drops bulk keys, bounds depth and string length, and caps total size. Credentials were rejected earlier. */
export function sanitizeRawPayload(value: Record<string, unknown>): Record<string, unknown> {
  const clean = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") {
      return input.slice(0, MAX_RAW_STRING_LENGTH);
    }
    if (typeof input === "number") {
      return Number.isFinite(input) ? input : null;
    }
    if (typeof input === "boolean" || input === null) {
      return input;
    }
    if (depth >= MAX_RAW_PAYLOAD_DEPTH) {
      return null;
    }
    if (Array.isArray(input)) {
      return input.slice(0, 50).map((item) => clean(item, depth + 1));
    }
    if (isRecord(input)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) {
        if (!BULK_KEY.test(key)) {
          out[key] = clean(item, depth + 1);
        }
      }
      return out;
    }
    return null;
  };
  const cleaned = clean(value, 0) as Record<string, unknown>;
  return JSON.stringify(cleaned).length > MAX_RAW_PAYLOAD_BYTES ? {} : cleaned;
}

function reject(
  expectation: Pick<ProviderResultExpectation, "provider" | "taskId" | "runId">,
  issues: ProviderResultIssue[],
): ProviderResultValidation {
  const codes = new Set(issues.map((issue) => issue.code));
  const lead = CODE_PRECEDENCE.find((code) => codes.has(code)) ?? issues[0]?.code ?? "malformed_candidate";
  const policy = RETRY_BY_CODE[lead];
  // A set containing any terminal code is terminal: retrying cannot fix forged or mismatched scope.
  const terminal = issues.some((issue) => RETRY_BY_CODE[issue.code].retry === "none");
  const retry = terminal ? "none" : policy.retry;
  return {
    ok: false,
    rejection: {
      contractVersion: PROVIDER_RESULT_CONTRACT_VERSION,
      adminVisible: true,
      provider: expectation.provider,
      taskId: expectation.taskId,
      runId: expectation.runId,
      code: lead,
      retry,
      retryBudget: retry === "bounded" ? policy.budget : 0,
      issues: issues.slice(0, MAX_REJECTION_ISSUES),
      issueCount: issues.length,
    },
  };
}

const BINDING_FIELDS = [
  "provider",
  "taskId",
  "laneId",
  "permitId",
  "runId",
  "envelopeRevision",
  "policyRevision",
  "packageId",
] as const;

/**
 * Validates one adapter result against the authorized execution. Fails closed:
 * any issue rejects the whole result, so a partial option set never publishes.
 */
export function validateProviderResult(
  candidate: ProviderResultCandidate,
  expectation: ProviderResultExpectation,
): ProviderResultValidation {
  const issues: ProviderResultIssue[] = [];
  const add = (code: ProviderResultRejectionCode, path: string) => issues.push({ code, path });

  const nowMs = parseInstant(expectation.now);
  if (
    nowMs === null
    || !Number.isInteger(expectation.requestedQuantity)
    || expectation.requestedQuantity < 1
    || expectation.allowedDomains.length === 0
  ) {
    throw new TypeError("Invalid provider result expectation.");
  }

  if (!isRecord(candidate) || !isRecord(candidate.binding) || !isRecord(candidate.result)) {
    return reject(expectation, [{ code: "malformed_candidate", path: "$" }]);
  }
  if (candidate.contractVersion !== PROVIDER_RESULT_CONTRACT_VERSION) {
    return reject(expectation, [{ code: "unsupported_contract_version", path: "contractVersion" }]);
  }

  const { binding, result } = candidate;
  for (const field of BINDING_FIELDS) {
    if (binding[field] !== expectation[field]) {
      add("binding_mismatch", `binding.${field}`);
    }
  }
  if (binding.quantity !== expectation.requestedQuantity) {
    add("invalid_quantity", "binding.quantity");
  }
  if (!isBoundedText(binding.adapterRevision, 80)) {
    add("malformed_candidate", "binding.adapterRevision");
  }
  if (result.vendor !== expectation.provider) {
    add("binding_mismatch", "result.vendor");
  }

  const raw = isRecord(result.rawPayload) ? result.rawPayload : {};
  if (
    candidate.simulated === true
    || raw.mode === "simulate"
    || raw.detectedFlow === "simulate"
    || (typeof raw.source === "string" && /simulat/i.test(raw.source))
    || (typeof result.quoteUrl === "string" && /^simulated:/i.test(result.quoteUrl))
  ) {
    add("simulated_result", "result.rawPayload");
  }
  if (hasAdmissionClaim(raw, 0) || hasAdmissionClaim(candidate as unknown as Record<string, unknown>, 3)) {
    add("adapter_admission_claim", "result.rawPayload");
  }
  if (containsCredentialMaterial(raw) || containsCredentialMaterial(result.notes) || containsCredentialMaterial(result.dfmIssues)) {
    add("forbidden_content", "result.rawPayload");
  }
  if (raw.requestedQuantity !== undefined && raw.requestedQuantity !== expectation.requestedQuantity) {
    add("invalid_quantity", "result.rawPayload.requestedQuantity");
  }

  if (candidate.currency !== "USD") {
    add("invalid_currency", "currency");
  }

  const collectedMs = parseInstant(candidate.collectedAt);
  const maxAge = expectation.maxAgeMs ?? DEFAULT_MAX_RESULT_AGE_MS;
  if (collectedMs === null || typeof candidate.collectedAt !== "string" || candidate.collectedAt.length < 20) {
    add("invalid_timestamp", "collectedAt");
  } else if (collectedMs > nowMs + CLOCK_SKEW_MS) {
    add("invalid_timestamp", "collectedAt");
  } else if (nowMs - collectedMs > maxAge) {
    add("stale_result", "collectedAt");
  }

  let quotedMs: number | null = null;
  if (result.quotedAt !== undefined && result.quotedAt !== null) {
    quotedMs = parseInstant(result.quotedAt);
    if (quotedMs === null || (collectedMs !== null && quotedMs > collectedMs + CLOCK_SKEW_MS)) {
      add("invalid_timestamp", "result.quotedAt");
    }
  }
  if (result.validUntil !== undefined && result.validUntil !== null) {
    const validMs = parseInstant(result.validUntil);
    if (validMs === null) {
      add("invalid_timestamp", "result.validUntil");
    } else if (validMs <= nowMs) {
      add("expired_validity", "result.validUntil");
    } else if (quotedMs !== null && validMs < quotedMs) {
      add("invalid_timestamp", "result.validUntil");
    }
  }

  if (result.status !== "instant_quote_received" && result.status !== "official_quote_received") {
    add("provider_reported_non_quote", "result.status");
    return reject(expectation, issues);
  }

  if (!Array.isArray(result.artifacts) || result.artifacts.length > MAX_ARTIFACTS_PER_RESULT
    || result.artifacts.some((artifact) => !isRecord(artifact)
      || !isBoundedText(artifact.label, 120)
      || !isBoundedText(artifact.localPath, 512)
      || !["screenshot", "html_snapshot", "trace", "json"].includes(String(artifact.kind)))) {
    add("invalid_artifacts", "result.artifacts");
  }

  const summaryUrlOk = validDestination(result.quoteUrl, expectation.allowedDomains);
  if (result.quoteUrl !== null && result.quoteUrl !== undefined && !summaryUrlOk) {
    add("invalid_destination", "result.quoteUrl");
  }

  let offers: VendorQuoteAdapterOffer[];
  let derived = false;
  if (Array.isArray(result.offers) && result.offers.length > 0) {
    offers = result.offers;
  } else if (isFinitePositive(result.totalPriceUsd) && isFinitePositive(result.unitPriceUsd)) {
    derived = true;
    offers = [{
      providerOptionId: String(expectation.requestedQuantity),
      providerLabel: `${expectation.provider} quote`,
      quoteRef: null,
      quoteUrl: result.quoteUrl,
      unitPriceUsd: result.unitPriceUsd,
      totalPriceUsd: result.totalPriceUsd,
      leadTimeBusinessDays: result.leadTimeBusinessDays,
      shipReceiveBy: null,
      tier: result.status === "official_quote_received" ? "Official" : "Instant",
      sourcing: null,
      geographicOrigin: "unknown",
      sortRank: 0,
      provenance: {
        containerSelector: "compatibility_summary",
        providerOptionIdSource: "provider_label",
        priceSource: "selector",
        leadTimeSource: result.leadTimeBusinessDays === null ? "none" : "selector",
        geographicOriginSource: "none",
      },
      rawPayload: {},
    }];
  } else {
    add("missing_offers", "result.offers");
    return reject(expectation, issues);
  }

  if (offers.length > MAX_OFFERS_PER_RESULT) {
    add("too_many_offers", "result.offers");
    return reject(expectation, issues);
  }

  // Reconciliation: the adapter declares how many options it saw; a shortfall is a partial set.
  const declared = raw.offerCount ?? raw.declaredOfferCount;
  if (declared !== undefined && declared !== offers.length) {
    add("partial_offer_set", "result.rawPayload.offerCount");
  }

  const seen = new Set<string>();
  const validated: ValidatedProviderOffer[] = [];
  offers.forEach((offer, index) => {
    const p = `result.offers[${index}]`;
    if (!isRecord(offer)) {
      add("malformed_candidate", p);
      return;
    }
    if (!isBoundedText(offer.providerOptionId, MAX_ID_LENGTH)) {
      add("invalid_offer_id", `${p}.providerOptionId`);
    } else {
      const key = offer.providerOptionId.trim().toLowerCase();
      if (seen.has(key)) {
        add("duplicate_offer_id", `${p}.providerOptionId`);
      }
      seen.add(key);
    }
    if (!isBoundedText(offer.providerLabel, MAX_TEXT_LENGTH)) {
      add("malformed_candidate", `${p}.providerLabel`);
    }
    if (offer.quoteRef !== null && !isBoundedText(offer.quoteRef, MAX_ID_LENGTH)) {
      add("malformed_candidate", `${p}.quoteRef`);
    }
    for (const field of ["tier", "sourcing", "shipReceiveBy"] as const) {
      const text = offer[field];
      if (text !== null && !isBoundedText(text, MAX_TEXT_LENGTH)) {
        add("malformed_candidate", `${p}.${field}`);
      }
    }

    const quantity = offer.quantity ?? expectation.requestedQuantity;
    if (quantity !== expectation.requestedQuantity) {
      add("invalid_quantity", `${p}.quantity`);
    }

    if (!isFinitePositive(offer.unitPriceUsd) || !isFinitePositive(offer.totalPriceUsd)) {
      add("invalid_price", `${p}.price`);
    } else if (Math.abs(offer.totalPriceUsd - offer.unitPriceUsd * expectation.requestedQuantity)
      > 0.005 * expectation.requestedQuantity + 0.01) {
      add("price_inconsistent", `${p}.totalPriceUsd`);
    }
    if (!isRecord(offer.provenance) || offer.provenance.priceSource !== "selector") {
      add("untrusted_source", `${p}.provenance.priceSource`);
    }

    const lead = offer.leadTimeBusinessDays;
    if (lead !== null) {
      if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_TIME_BUSINESS_DAYS) {
        add("invalid_lead_time", `${p}.leadTimeBusinessDays`);
      } else if (offer.provenance?.leadTimeSource !== "selector") {
        add("untrusted_source", `${p}.provenance.leadTimeSource`);
      }
    }

    const origin: unknown = offer.geographicOrigin;
    if (origin !== "domestic" && origin !== "foreign" && origin !== "unknown") {
      add("invalid_origin", `${p}.geographicOrigin`);
    } else if (origin !== "unknown" && offer.provenance?.geographicOriginSource !== "provider_text") {
      // Origin is never inferred from provider identity or free text; known values need provider evidence.
      add("invalid_origin", `${p}.provenance.geographicOriginSource`);
    }

    const offerUrl = offer.quoteUrl ?? result.quoteUrl;
    if (!validDestination(offerUrl, expectation.allowedDomains)) {
      add("invalid_destination", `${p}.quoteUrl`);
    }
    if (containsCredentialMaterial(offer.rawPayload)) {
      add("forbidden_content", `${p}.rawPayload`);
    }

    if (typeof offerUrl === "string") {
      validated.push({
        ...offer,
        quantity: expectation.requestedQuantity,
        quoteUrl: offerUrl,
        currency: "USD",
        derivedFromSummary: derived,
        geographicOrigin: origin as GeographicOrigin,
        rawPayload: sanitizeRawPayload(isRecord(offer.rawPayload) ? offer.rawPayload : {}),
      });
    }
  });

  if (issues.length > 0) {
    return reject(expectation, issues);
  }

  const offersOut = validated.map((offer) => Object.freeze(offer));
  return {
    ok: true,
    value: Object.freeze({
      contractVersion: PROVIDER_RESULT_CONTRACT_VERSION,
      provenance: Object.freeze({
        provider: expectation.provider,
        taskId: expectation.taskId,
        laneId: expectation.laneId,
        permitId: expectation.permitId,
        runId: expectation.runId,
        envelopeRevision: expectation.envelopeRevision,
        policyRevision: expectation.policyRevision,
        packageId: expectation.packageId,
        adapterRevision: binding.adapterRevision,
        collectedAt: candidate.collectedAt,
        validatedAt: expectation.now,
      }),
      status: result.status,
      quotedAt: result.quotedAt ?? null,
      validUntil: result.validUntil ?? null,
      offers: Object.freeze(offersOut),
    }),
  };
}

/**
 * Admin visible diagnostic for a rejection. Contains only finite codes, paths,
 * identifiers the caller already holds and counts, so it is safe to persist
 * (OVD-464 wires the write).
 */
export function toAdminRejectionDiagnostic(rejection: ProviderResultRejection) {
  return {
    kind: "provider_result_rejected" as const,
    contractVersion: rejection.contractVersion,
    provider: rejection.provider,
    taskId: rejection.taskId,
    runId: rejection.runId,
    code: rejection.code,
    retry: rejection.retry,
    retryBudget: rejection.retryBudget,
    issueCount: rejection.issueCount,
    issues: rejection.issues.map((issue) => ({ code: issue.code, path: issue.path })),
  };
}

export type ProviderFailureClass =
  | "authentication"
  | "challenge"
  | "portal_drift"
  | "transport"
  | "capacity"
  | "unsupported"
  | "persistence";

export type ClassifiedProviderFailure = {
  code: VendorAutomationErrorCode;
  failureClass: ProviderFailureClass;
  retry: ProviderResultRetryDisposition;
  retryBudget: number;
  adminVisible: true;
};

const FAILURE_POLICY: Record<VendorAutomationErrorCode, Omit<ClassifiedProviderFailure, "code" | "adminVisible">> = {
  login_required: { failureClass: "authentication", retry: "manual_follow_up", retryBudget: 0 },
  captcha: { failureClass: "challenge", retry: "manual_follow_up", retryBudget: 0 },
  anti_detection_block: { failureClass: "challenge", retry: "manual_follow_up", retryBudget: 0 },
  selector_failure: { failureClass: "portal_drift", retry: "manual_follow_up", retryBudget: 0 },
  unexpected_ui_state: { failureClass: "portal_drift", retry: "manual_follow_up", retryBudget: 0 },
  upload_failure: { failureClass: "transport", retry: "bounded", retryBudget: 1 },
  navigation_failure: { failureClass: "transport", retry: "bounded", retryBudget: 1 },
  profile_in_use: { failureClass: "capacity", retry: "bounded", retryBudget: 1 },
  persistence_failure: { failureClass: "persistence", retry: "bounded", retryBudget: 1 },
  not_implemented: { failureClass: "unsupported", retry: "none", retryBudget: 0 },
};

/**
 * Maps an adapter failure code to a finite sanitized class and bounded retry
 * policy. Unknown codes fail closed to manual follow up with no retry.
 */
export function classifyProviderFailure(code: string): ClassifiedProviderFailure {
  const known = Object.prototype.hasOwnProperty.call(FAILURE_POLICY, code)
    ? (code as VendorAutomationErrorCode)
    : null;
  if (!known) {
    return {
      code: "unexpected_ui_state",
      failureClass: "portal_drift",
      retry: "manual_follow_up",
      retryBudget: 0,
      adminVisible: true,
    };
  }
  return { code: known, ...FAILURE_POLICY[known], adminVisible: true };
}

/**
 * Structural match for `ProviderDeliveryObservation` in
 * `shared/delivered-cost-arrival.ts` (OVD-569), kept local so the worker build
 * does not import across the repository root.
 */
export type DeliveryObservationInput = {
  offerId: string;
  provider: string;
  partsSubtotalUsd: number | null;
  feesUsd: number | null;
  taxUsd: number | null;
  shippingOptions: readonly never[];
  leadTime: { kind: "business_days"; businessDays: number } | { kind: "unknown" };
  orderCutoffLocalTime: string | null;
  validUntil: string | null;
  invalidatedAt: string | null;
};

/**
 * Feeds one validated offer into the OVD-569 projection. Fees, tax and
 * shipping are unstated by the validated contract, so they stay null.
 */
export function toDeliveryObservation(
  result: ValidatedProviderResult,
  offer: ValidatedProviderOffer,
): DeliveryObservationInput {
  return {
    offerId: `${result.provenance.provider}-${offer.providerOptionId}`,
    provider: result.provenance.provider,
    partsSubtotalUsd: offer.totalPriceUsd,
    feesUsd: null,
    taxUsd: null,
    shippingOptions: [],
    leadTime: offer.leadTimeBusinessDays === null
      ? { kind: "unknown" }
      : { kind: "business_days", businessDays: offer.leadTimeBusinessDays },
    orderCutoffLocalTime: null,
    validUntil: result.validUntil,
    invalidatedAt: null,
  };
}
