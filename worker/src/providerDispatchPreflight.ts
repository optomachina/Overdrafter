import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorAdapter } from "./adapters/base.js";
import {
  canonicalizeProviderDispatchEnvelope,
  evaluateProviderDispatchAdmission,
  isRetryableProviderDispatchDenial,
  parseProviderDispatchEnvelope,
  PROVIDER_DISPATCH_DENIAL_CODES,
  readExactPlainRecord,
  readPlainRecord,
  type ProviderDispatchCurrentEvidence,
  type ProviderDispatchDenialCode,
  type ProviderDispatchEnvelope,
  type ReviewedProviderDispatchEnvelope,
} from "./providerDispatchEnvelope.js";
import type { VendorName, VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "./types.js";

/**
 * OVD-459 consumer for the service-role provider preflight
 * (`public.api_authorize_provider_worker_dispatch`). The database decision is
 * authoritative; this module only accepts its bounded
 * `provider-dispatch-authorization.v1` response after strict parsing, binding
 * it to the worker's own claim, and re-evaluating the OVD-457 contract with the
 * stored envelope and the evidence read in the same database snapshot.
 *
 * Xometry keeps the unchanged specialized path in `xometryDispatchPreflight.ts`.
 * The live worker reaches this module only through `dispatchRouting.ts`
 * (OVD-381/OVD-464) for non-Xometry tasks carrying a generic permit. Fictiv is
 * the only generic envelope reviewed in code (OVD-673); it still admits nothing
 * until the database holds its reviewed envelope, approved admission, and
 * enabled rollout, and the worker lists it in WORKER_LIVE_ADAPTERS.
 */

export const PROVIDER_DISPATCH_AUTHORIZATION_SCHEMA = "provider-dispatch-authorization.v1" as const;
const PREFLIGHT_RPC = "api_authorize_provider_worker_dispatch";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** Canonical v1 envelopes are well under this; anything larger is not ours. */
const MAX_CANONICAL_ENVELOPE_LENGTH = 16_384;
const DENIAL_CODES: ReadonlySet<string> = new Set(PROVIDER_DISPATCH_DENIAL_CODES);
const DENIED_KEYS = ["schema", "authorized", "denial", "retryable"] as const;
const AUTHORIZED_KEYS = [
  "schema",
  "authorized",
  "permitId",
  "provider",
  "envelopeFingerprint",
  "canonicalEnvelope",
  "expiresAt",
  "sessionBindingId",
  "evidence",
] as const;
const EVIDENCE_KEYS = ["now", "permitState", "admission", "rollout"] as const;
/**
 * Longest round trip, measured on the worker's monotonic clock, after which a
 * decision is too old to launch an adapter on. The remaining permit lifetime
 * is also measured from the database clock in the response plus this age, so
 * worker clock skew never extends a permit.
 */
export const PROVIDER_DISPATCH_MAX_RESPONSE_AGE_MS = 5_000;
/**
 * SQLSTATE classes and PostgREST codes that mean the service could not answer
 * right now: connection exceptions (08), serialization failure and deadlock
 * (40001, 40P01), insufficient resources (53), operator intervention such as
 * statement timeout or shutdown (57014, 57P0x), and PostgREST pool/connection
 * failures (PGRST000-PGRST003). Every other code is a terminal rejection.
 */
const TRANSIENT_ERROR_CODE = /^(08[\dA-Z]{3}|40001|40P01|53[\dA-Z]{3}|57014|57P0\d|PGRST00[0-3])$/;
const SQLSTATE_OR_POSTGREST_CODE = /^([\dA-Z]{5}|PGRST\d{3})$/;
const TRANSIENT_HTTP_STATUS: ReadonlySet<number> = new Set([0, 408, 500, 502, 503, 504]);

export class ProviderDispatchAuthorizationError extends Error {
  readonly retryable: boolean;

  constructor(public readonly denial: ProviderDispatchDenialCode) {
    super("Provider dispatch authorization was denied before adapter launch.");
    this.name = "ProviderDispatchAuthorizationError";
    this.retryable = isRetryableProviderDispatchDenial(denial);
  }
}

/** The worker's own claim, taken from the claimed queue task, never from the response. */
export type ProviderDispatchClaim = {
  workQueueTaskId: string;
  vendorQuoteResultId: string;
  provider: VendorName;
  /** `providerDispatchPermitId` from the claimed task payload. */
  permitId: string;
  /** `providerDispatchEnvelopeFingerprint` from the claimed task payload. */
  envelopeFingerprint: string;
};

/** Bounded authority handed to the adapter seam. No credentials or file content. */
export type ProviderDispatchAuthorization = {
  permitId: string;
  provider: VendorName;
  envelopeFingerprint: string;
  expiresAt: string;
  sessionBindingId: string;
  envelope: ProviderDispatchEnvelope;
};

export type ProviderDispatchAuthorizationResult =
  | { ok: true; authorization: ProviderDispatchAuthorization }
  | { ok: false; denial: ProviderDispatchDenialCode };

function deny(denial: ProviderDispatchDenialCode): ProviderDispatchAuthorizationResult {
  return { ok: false, denial };
}

function parseDenied(data: unknown): ProviderDispatchAuthorizationResult {
  const response = readExactPlainRecord(data, DENIED_KEYS);
  if (
    response?.schema !== PROVIDER_DISPATCH_AUTHORIZATION_SCHEMA ||
    response.authorized !== false ||
    response.retryable !== false ||
    typeof response.denial !== "string" ||
    !DENIAL_CODES.has(response.denial) ||
    isRetryableProviderDispatchDenial(response.denial as ProviderDispatchDenialCode)
  ) {
    // The service never reports itself unavailable; only transport can.
    return deny("current_evidence_malformed");
  }
  return deny(response.denial as ProviderDispatchDenialCode);
}

function parseStoredEnvelope(
  canonicalEnvelope: string,
  envelopeFingerprint: string,
): { ok: true; envelope: ProviderDispatchEnvelope } | { ok: false; denial: ProviderDispatchDenialCode } {
  const digest = createHash("sha256").update(canonicalEnvelope, "utf8").digest("hex");
  if (digest !== envelopeFingerprint) return { ok: false, denial: "envelope_malformed" };
  let raw: unknown;
  try {
    raw = JSON.parse(canonicalEnvelope);
  } catch {
    return { ok: false, denial: "envelope_malformed" };
  }
  const parsed = parseProviderDispatchEnvelope(raw);
  if (!parsed.ok) return parsed;
  // Byte equality with our own canonical form proves both sides agree on it.
  if (canonicalizeProviderDispatchEnvelope(parsed.envelope) !== canonicalEnvelope) {
    return { ok: false, denial: "envelope_malformed" };
  }
  return parsed;
}

function bindingDenial(
  response: Record<string, unknown>,
  envelope: ProviderDispatchEnvelope,
  claim: ProviderDispatchClaim,
): ProviderDispatchDenialCode | null {
  if (response.provider !== envelope.provider || envelope.provider !== claim.provider) return "provider_mismatch";
  if (
    envelope.task.workQueueTaskId !== claim.workQueueTaskId ||
    envelope.task.vendorQuoteResultId !== claim.vendorQuoteResultId
  ) {
    return "task_lane_mismatch";
  }
  if (
    response.permitId !== envelope.permit.permitId ||
    envelope.permit.permitId !== claim.permitId ||
    response.envelopeFingerprint !== claim.envelopeFingerprint
  ) {
    return "permit_mismatch";
  }
  if (
    response.sessionBindingId !== envelope.sessionBindingId ||
    envelope.sessionBindingId !== `lease:${envelope.permit.permitId}`
  ) {
    return "session_binding_mismatch";
  }
  if (response.expiresAt !== envelope.expiresAt) return "expiry_mismatch";
  return null;
}

/**
 * Strictly parses the preflight response and binds it to the worker's claim.
 * Unknown versions, unknown or missing keys, accessors, inconsistent
 * fingerprints, and any mismatch fail closed with a terminal denial.
 */
export function parseProviderDispatchAuthorization(
  data: unknown,
  claim: ProviderDispatchClaim,
  options: {
    reviewedEnvelopes?: readonly ReviewedProviderDispatchEnvelope[];
    /** Worker-measured round trip of the RPC that produced `data`. */
    responseAgeMs?: number;
  } = {},
): ProviderDispatchAuthorizationResult {
  const responseAgeMs = options.responseAgeMs ?? 0;
  if (!Number.isFinite(responseAgeMs) || responseAgeMs < 0 || responseAgeMs > PROVIDER_DISPATCH_MAX_RESPONSE_AGE_MS) {
    return deny("preflight_unavailable");
  }
  const head = readPlainRecord(data);
  if (!head) return deny("current_evidence_malformed");
  if (head.schema !== PROVIDER_DISPATCH_AUTHORIZATION_SCHEMA) {
    return deny(typeof head.schema === "string" ? "envelope_version_unsupported" : "current_evidence_malformed");
  }
  if (head.authorized !== true) return parseDenied(head);

  const response = readExactPlainRecord(head, AUTHORIZED_KEYS);
  if (
    !response ||
    typeof response.permitId !== "string" ||
    !UUID.test(response.permitId) ||
    typeof response.envelopeFingerprint !== "string" ||
    !SHA256.test(response.envelopeFingerprint) ||
    typeof response.canonicalEnvelope !== "string" ||
    response.canonicalEnvelope.length > MAX_CANONICAL_ENVELOPE_LENGTH
  ) {
    return deny("current_evidence_malformed");
  }
  const evidence = readExactPlainRecord(response.evidence, EVIDENCE_KEYS);
  if (!evidence) return deny("current_evidence_malformed");

  const stored = parseStoredEnvelope(response.canonicalEnvelope, response.envelopeFingerprint);
  if (!stored.ok) return stored;
  const envelope = stored.envelope;
  const mismatch = bindingDenial(response, envelope, claim);
  if (mismatch) return deny(mismatch);

  // The stored envelope is the authoritative binding; the claim was bound to
  // it above, so it is evaluated as both expected and presented here.
  const decision = evaluateProviderDispatchAdmission({
    expected: envelope,
    presented: envelope,
    evidence: evidence as ProviderDispatchCurrentEvidence,
    reviewedEnvelopes: options.reviewedEnvelopes,
  });
  if (!decision.admitted) return deny(decision.denial);
  if (decision.envelopeFingerprint !== response.envelopeFingerprint) return deny("envelope_malformed");
  // evaluateProviderDispatchAdmission checked expiry at the database clock;
  // the decision has aged by the round trip since then.
  if (Date.parse(evidence.now as string) + responseAgeMs >= Date.parse(envelope.expiresAt)) {
    return deny("permit_expired");
  }

  return {
    ok: true,
    authorization: {
      permitId: envelope.permit.permitId,
      provider: envelope.provider,
      envelopeFingerprint: response.envelopeFingerprint,
      expiresAt: envelope.expiresAt,
      sessionBindingId: envelope.sessionBindingId,
      envelope,
    },
  };
}

/**
 * Classifies a failed RPC. Only transport failures, timeouts, and service
 * unavailability are retryable; SQL errors with a SQLSTATE (for example 42501
 * permission denied, 22xxx invalid input, P0001 raised exceptions), PostgREST
 * request errors, and other 4xx responses are terminal.
 */
export function classifyProviderDispatchRpcFailure(error: unknown, status: unknown): ProviderDispatchDenialCode {
  // postgrest-js reports a fetch exception as status 0, possibly with a Node
  // error code such as ECONNRESET, so status 0 is transport regardless of code.
  if (status === 0) return "preflight_unavailable";
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (SQLSTATE_OR_POSTGREST_CODE.test(code)) {
    return TRANSIENT_ERROR_CODE.test(code) ? "preflight_unavailable" : "preflight_rejected";
  }
  if (typeof status === "number" && TRANSIENT_HTTP_STATUS.has(status)) return "preflight_unavailable";
  return "preflight_rejected";
}

/**
 * Obtains the service-role decision for the exact claimed task. Only
 * transport failures, timeouts, and service unavailability are retryable
 * (`preflight_unavailable`); everything else is terminal.
 */
export async function authorizeProviderDispatch(
  supabase: SupabaseClient,
  input: {
    claim: ProviderDispatchClaim;
    scopeSnapshot: Record<string, unknown>;
    workerName: string;
    claimedAt: string;
    reviewedEnvelopes?: readonly ReviewedProviderDispatchEnvelope[];
  },
): Promise<ProviderDispatchAuthorization> {
  let response: { data: unknown; error: unknown; status?: unknown };
  const startedAt = performance.now();
  try {
    response = await supabase.rpc(PREFLIGHT_RPC, {
      p_work_queue_task_id: input.claim.workQueueTaskId,
      p_vendor_quote_result_id: input.claim.vendorQuoteResultId,
      p_scope_snapshot: input.scopeSnapshot,
      p_expected_worker_name: input.workerName,
      p_expected_claimed_at: input.claimedAt,
    });
  } catch {
    throw new ProviderDispatchAuthorizationError("preflight_unavailable");
  }
  if (response.error) {
    throw new ProviderDispatchAuthorizationError(classifyProviderDispatchRpcFailure(response.error, response.status));
  }

  const result = parseProviderDispatchAuthorization(response.data, input.claim, {
    reviewedEnvelopes: input.reviewedEnvelopes,
    responseAgeMs: performance.now() - startedAt,
  });
  if (!result.ok) throw new ProviderDispatchAuthorizationError(result.denial);
  return result.authorization;
}

/**
 * Keeps the final generic decision and the adapter call adjacent: the adapter
 * runs only after an admitted decision for the exact claim. Xometry is refused
 * here and must use the specialized `quoteWithDispatchPreflight`.
 */
export async function quoteWithProviderDispatchPreflight(input: {
  supabase: SupabaseClient;
  workerName: string;
  claimedAt: string;
  claim: ProviderDispatchClaim;
  scopeSnapshot: Record<string, unknown>;
  adapter: Pick<VendorAdapter, "quote">;
  quoteInput: VendorQuoteAdapterInput;
  onAuthorized?: (authorization: ProviderDispatchAuthorization) => void;
  reviewedEnvelopes?: readonly ReviewedProviderDispatchEnvelope[];
}): Promise<VendorQuoteAdapterOutput> {
  if (input.claim.provider === "xometry") {
    throw new ProviderDispatchAuthorizationError("provider_mismatch");
  }

  const authorization = await authorizeProviderDispatch(input.supabase, {
    claim: input.claim,
    scopeSnapshot: input.scopeSnapshot,
    workerName: input.workerName,
    claimedAt: input.claimedAt,
    reviewedEnvelopes: input.reviewedEnvelopes,
  });

  input.onAuthorized?.(authorization);
  return input.adapter.quote({ ...input.quoteInput, providerDispatchAuthorization: authorization });
}
