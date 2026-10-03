// @vitest-environment node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../test-fixtures/provider-dispatch-envelope/v1.json";
import {
  canonicalizeProviderDispatchEnvelope,
  fingerprintProviderDispatchEnvelope,
  PROVIDER_DISPATCH_DENIAL_CODES,
  type ProviderDispatchEnvelope,
  type ReviewedProviderDispatchEnvelope,
} from "./providerDispatchEnvelope";
import {
  classifyProviderDispatchRpcFailure,
  parseProviderDispatchAuthorization,
  PROVIDER_DISPATCH_MAX_RESPONSE_AGE_MS,
  ProviderDispatchAuthorizationError,
  quoteWithProviderDispatchPreflight,
  type ProviderDispatchClaim,
} from "./providerDispatchPreflight";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "./types";

const PERMIT_ID = "00000000-0000-4000-8000-00000000457c";
const migration = readFileSync(
  new URL("../../supabase/migrations/20261003170000_ovd459_provider_dispatch_preflight.sql", import.meta.url),
  "utf8",
);

/** A fictiv generic envelope derived from the shared OVD-457 golden. */
function fictivEnvelope(overrides: Partial<ProviderDispatchEnvelope> = {}): ProviderDispatchEnvelope {
  const golden = structuredClone(fixture.golden.envelope) as unknown as ProviderDispatchEnvelope;
  return {
    ...golden,
    provider: "fictiv",
    envelope: { id: "fictiv-quote-envelope", version: 1 },
    admission: { policyRevision: "fictiv-generic-2026-10-03.v1", evidenceReference: "OVD-458" },
    sessionBindingId: `lease:${PERMIT_ID}`,
    ...overrides,
  };
}

const REVIEWED: readonly ReviewedProviderDispatchEnvelope[] = [
  { provider: "fictiv", id: "fictiv-quote-envelope", version: 1, requiredAdmission: "generic_dispatch" },
];

function evidence(): Record<string, unknown> {
  return {
    now: "2026-10-03T12:05:00.000Z",
    permitState: "active",
    admission: {
      policy_present: true,
      provider_admitted: true,
      generically_dispatchable: true,
      provider: "fictiv",
      admission_state: "approved",
      policy_revision: "fictiv-generic-2026-10-03.v1",
      evidence_reference: "OVD-458",
      permission_basis: "written_provider_authorization",
      supported_processes: ["cnc_milling"],
      accepted_file_extensions: ["step", "stp", "pdf"],
      session_owner: "overdrafter_managed",
      reviewed_at: "2026-10-02T12:00:00.123456+00:00",
      expires_at: null,
      reason_code: "provider_approved",
    },
    rollout: { capability: "automatic_quote_collection", enabled: true, revision: 3 },
  };
}

function authorizedResponse(envelope = fictivEnvelope()): Record<string, unknown> {
  return {
    schema: "provider-dispatch-authorization.v1",
    authorized: true,
    permitId: envelope.permit.permitId,
    provider: envelope.provider,
    envelopeFingerprint: fingerprintProviderDispatchEnvelope(envelope),
    canonicalEnvelope: canonicalizeProviderDispatchEnvelope(envelope),
    expiresAt: envelope.expiresAt,
    sessionBindingId: envelope.sessionBindingId,
    evidence: evidence(),
  };
}

function claim(overrides: Partial<ProviderDispatchClaim> = {}): ProviderDispatchClaim {
  const envelope = fictivEnvelope();
  return {
    workQueueTaskId: envelope.task.workQueueTaskId,
    vendorQuoteResultId: envelope.task.vendorQuoteResultId,
    provider: "fictiv",
    permitId: PERMIT_ID,
    envelopeFingerprint: fingerprintProviderDispatchEnvelope(envelope),
    ...overrides,
  };
}

function denied(denial: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "provider-dispatch-authorization.v1", authorized: false, denial, retryable: false, ...extra };
}

function withEvidence(change: (value: Record<string, unknown>) => void): Record<string, unknown> {
  const response = authorizedResponse();
  change(response.evidence as Record<string, unknown>);
  return response;
}

function quoteInput(): VendorQuoteAdapterInput {
  return { organizationId: "org-1", quoteRunId: "run-1", requestedQuantity: 5 } as unknown as VendorQuoteAdapterInput;
}

function harness(rpcResult: Promise<{ data: unknown; error: unknown; status?: number }>) {
  const rpc = vi.fn().mockReturnValue(rpcResult);
  const quote = vi.fn().mockResolvedValue({ artifacts: [] } as unknown as VendorQuoteAdapterOutput);
  const onAuthorized = vi.fn();
  const run = (overrides: { claim?: ProviderDispatchClaim; reviewed?: readonly ReviewedProviderDispatchEnvelope[] | null } = {}) =>
    quoteWithProviderDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      workerName: "worker-1",
      claimedAt: "2026-10-03T12:04:00.000Z",
      claim: overrides.claim ?? claim(),
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "fictiv" },
      adapter: { quote },
      quoteInput: quoteInput(),
      onAuthorized,
      reviewedEnvelopes: overrides.reviewed === null ? undefined : (overrides.reviewed ?? REVIEWED),
    });
  return { rpc, quote, onAuthorized, run };
}

describe("provider dispatch preflight consumer", () => {
  it("calls the adapter once only after an admitted decision for the exact claim", async () => {
    const { rpc, quote, onAuthorized, run } = harness(Promise.resolve({ data: authorizedResponse(), error: null }));
    await expect(run()).resolves.toEqual({ artifacts: [] });
    expect(rpc).toHaveBeenCalledWith("api_authorize_provider_worker_dispatch", {
      p_work_queue_task_id: claim().workQueueTaskId,
      p_vendor_quote_result_id: claim().vendorQuoteResultId,
      p_scope_snapshot: { schema: "quote-lane-scope.v1", vendor: "fictiv" },
      p_expected_worker_name: "worker-1",
      p_expected_claimed_at: "2026-10-03T12:04:00.000Z",
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(quoteInput());
    expect(onAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        permitId: PERMIT_ID,
        provider: "fictiv",
        sessionBindingId: `lease:${PERMIT_ID}`,
        envelopeFingerprint: claim().envelopeFingerprint,
      }),
    );
  });

  it("admits no generic provider with the code-reviewed envelope list", async () => {
    const { quote, run } = harness(Promise.resolve({ data: authorizedResponse(), error: null }));
    await expect(run({ reviewed: null })).rejects.toMatchObject({ denial: "provider_envelope_unknown", retryable: false });
    expect(quote).not.toHaveBeenCalled();
  });

  it("refuses Xometry, which keeps the specialized preflight, before any RPC", async () => {
    const { rpc, quote, run } = harness(Promise.resolve({ data: authorizedResponse(), error: null }));
    await expect(run({ claim: claim({ provider: "xometry" }) })).rejects.toMatchObject({ denial: "provider_mismatch" });
    expect(rpc).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it("retries a rejected transport promise as preflight_unavailable", async () => {
    const { quote, run } = harness(Promise.reject(new Error("fetch failed")));
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderDispatchAuthorizationError);
    expect(error).toMatchObject({ denial: "preflight_unavailable", retryable: true });
    expect(quote).not.toHaveBeenCalled();
  });

  const rpcFailures: Array<[string, Record<string, unknown>, number, string]> = [
    ["a network failure reported by postgrest-js", { code: "", message: "TypeError: fetch failed" }, 0, "preflight_unavailable"],
    ["a connection reset reported by postgrest-js", { code: "ECONNRESET", message: "socket hang up" }, 0, "preflight_unavailable"],
    ["a gateway timeout without a SQLSTATE", { code: "", message: "upstream request timeout" }, 504, "preflight_unavailable"],
    ["a service-unavailable response", { code: "", message: "Service Unavailable" }, 503, "preflight_unavailable"],
    ["a request timeout", { code: "", message: "Request Timeout" }, 408, "preflight_unavailable"],
    ["a PostgREST connection-pool timeout", { code: "PGRST003", message: "Timed out acquiring connection" }, 504, "preflight_unavailable"],
    ["a statement timeout", { code: "57014", message: "canceling statement due to statement timeout" }, 500, "preflight_unavailable"],
    ["a deadlock", { code: "40P01", message: "deadlock detected" }, 500, "preflight_unavailable"],
    ["a database connection failure", { code: "08006", message: "connection failure" }, 503, "preflight_unavailable"],
    ["a permission failure", { code: "42501", message: "permission denied for function" }, 403, "preflight_rejected"],
    ["an invalid argument", { code: "22P02", message: "invalid input syntax for type uuid" }, 400, "preflight_rejected"],
    ["a raised SQL exception", { code: "P0001", message: "unexpected" }, 400, "preflight_rejected"],
    ["a SQL error reported as a 500", { code: "XX000", message: "internal error" }, 500, "preflight_rejected"],
    ["an unknown RPC", { code: "PGRST202", message: "Could not find the function" }, 404, "preflight_rejected"],
    ["an expired service token", { code: "PGRST301", message: "JWT expired" }, 401, "preflight_rejected"],
    ["a 4xx without a code", { code: "", message: "Bad Request" }, 400, "preflight_rejected"],
  ];

  it.each(rpcFailures)("classifies %s as %s with zero adapter calls", async (_name, error, status, denial) => {
    expect(classifyProviderDispatchRpcFailure(error, status)).toBe(denial);
    const { quote, run } = harness(Promise.resolve({ data: null, error, status }));
    await expect(run()).rejects.toMatchObject({ denial, retryable: denial === "preflight_unavailable" });
    expect(quote).not.toHaveBeenCalled();
  });

  it("refuses a decision older than the maximum response age", () => {
    const options = { reviewedEnvelopes: REVIEWED, responseAgeMs: PROVIDER_DISPATCH_MAX_RESPONSE_AGE_MS + 1 };
    expect(parseProviderDispatchAuthorization(authorizedResponse(), claim(), options)).toEqual({
      ok: false,
      denial: "preflight_unavailable",
    });
    expect(
      parseProviderDispatchAuthorization(authorizedResponse(), claim(), { reviewedEnvelopes: REVIEWED, responseAgeMs: Number.NaN }),
    ).toEqual({ ok: false, denial: "preflight_unavailable" });
  });

  it("measures remaining permit lifetime from the database clock plus the response age", () => {
    const response = withEvidence((value) => { value.now = "2026-10-03T12:14:59.000Z"; });
    expect(parseProviderDispatchAuthorization(response, claim(), { reviewedEnvelopes: REVIEWED, responseAgeMs: 999 }))
      .toMatchObject({ ok: true });
    expect(parseProviderDispatchAuthorization(response, claim(), { reviewedEnvelopes: REVIEWED, responseAgeMs: 1_000 }))
      .toEqual({ ok: false, denial: "permit_expired" });
  });

  const terminalServiceDenials = PROVIDER_DISPATCH_DENIAL_CODES.filter((code) => code !== "preflight_unavailable");

  it.each(terminalServiceDenials)("passes the service denial %s through as terminal with zero adapter calls", async (code) => {
    const { quote, onAuthorized, run } = harness(Promise.resolve({ data: denied(code), error: null }));
    await expect(run()).rejects.toMatchObject({ denial: code, retryable: false });
    expect(quote).not.toHaveBeenCalled();
    expect(onAuthorized).not.toHaveBeenCalled();
  });

  const envelopeWithBinding = fictivEnvelope({ sessionBindingId: "lease:00000000-0000-4000-8000-0000000045ff" });
  const malformedCases: Array<[string, unknown, string, ProviderDispatchClaim?]> = [
    ["a null response", null, "current_evidence_malformed"],
    ["an array response", [], "current_evidence_malformed"],
    ["an unknown response version", { ...authorizedResponse(), schema: "provider-dispatch-authorization.v2" }, "envelope_version_unsupported"],
    ["an unknown response key", { ...authorizedResponse(), credentials: "x" }, "current_evidence_malformed"],
    ["a missing response key", (({ sessionBindingId: _, ...rest }) => rest)(authorizedResponse()), "current_evidence_malformed"],
    ["a non-boolean authorized flag", { ...authorizedResponse(), authorized: "true" }, "current_evidence_malformed"],
    ["an unknown denial code", denied("dispatch_task_not_running"), "current_evidence_malformed"],
    ["a denial that claims to be retryable", denied("permit_revoked", { retryable: true }), "current_evidence_malformed"],
    ["a service-claimed unavailability", denied("preflight_unavailable"), "current_evidence_malformed"],
    ["a denial with an extra key", denied("permit_revoked", { permitId: PERMIT_ID }), "current_evidence_malformed"],
    ["a fingerprint that does not hash the text", { ...authorizedResponse(), envelopeFingerprint: "0".repeat(64) }, "envelope_malformed"],
    ["non-canonical envelope text", (() => {
      const response = authorizedResponse();
      const text = JSON.stringify(JSON.parse(response.canonicalEnvelope as string), null, 2);
      return { ...response, canonicalEnvelope: text, envelopeFingerprint: sha(text) };
    })(), "envelope_malformed"],
    ["envelope text that is not JSON", (() => ({ ...authorizedResponse(), canonicalEnvelope: "{", envelopeFingerprint: sha("{") }))(), "envelope_malformed"],
    ["an oversized envelope text", { ...authorizedResponse(), canonicalEnvelope: "x".repeat(20_000) }, "current_evidence_malformed"],
    ["a response provider that differs from the envelope", { ...authorizedResponse(), provider: "protolabs" }, "provider_mismatch"],
    ["a response permit that differs from the envelope", { ...authorizedResponse(), permitId: "00000000-0000-4000-8000-0000000045ff" }, "permit_mismatch"],
    ["a response session binding that differs from the envelope", { ...authorizedResponse(), sessionBindingId: "lease:other-binding-01" }, "session_binding_mismatch"],
    ["an envelope session binding not reserved for its permit", authorizedResponse(envelopeWithBinding), "session_binding_mismatch",
      claim({ envelopeFingerprint: fingerprintProviderDispatchEnvelope(envelopeWithBinding) })],
    ["a response expiry that differs from the envelope", { ...authorizedResponse(), expiresAt: "2026-10-04T12:15:00.000Z" }, "expiry_mismatch"],
    ["a claim for another task", authorizedResponse(), "task_lane_mismatch", claim({ workQueueTaskId: "00000000-0000-4000-8000-0000000045ff" })],
    ["a claim for another result", authorizedResponse(), "task_lane_mismatch", claim({ vendorQuoteResultId: "00000000-0000-4000-8000-0000000045ff" })],
    ["a claim for another provider", authorizedResponse(), "provider_mismatch", claim({ provider: "protolabs" })],
    ["a claim bound to another permit", authorizedResponse(), "permit_mismatch", claim({ permitId: "00000000-0000-4000-8000-0000000045ff" })],
    ["a claim bound to another envelope fingerprint", authorizedResponse(), "permit_mismatch", claim({ envelopeFingerprint: "0".repeat(64) })],
    ["evidence with an extra key", withEvidence((value) => { value.debug = true; }), "current_evidence_malformed"],
    ["evidence past expiry on the database clock", withEvidence((value) => { value.now = "2026-10-03T12:15:00.000Z"; }), "permit_expired"],
    ["evidence before issue", withEvidence((value) => { value.now = "2026-10-03T11:59:59.999Z"; }), "permit_not_yet_valid"],
    ["revoked permit evidence", withEvidence((value) => { value.permitState = "revoked"; }), "permit_revoked"],
    ["generic dispatch disabled in admission evidence", withEvidence((value) => {
      Object.assign(value.admission as object, { generically_dispatchable: false, reason_code: "generic_dispatch_disabled" });
    }), "admission_disabled"],
    ["a superseded admission revision", withEvidence((value) => {
      Object.assign(value.admission as object, { policy_revision: "fictiv-generic-2026-10-03.v2" });
    }), "admission_stale"],
    ["a disabled rollout", withEvidence((value) => { (value.rollout as Record<string, unknown>).enabled = false; }), "rollout_disabled"],
    ["a superseded rollout revision", withEvidence((value) => { (value.rollout as Record<string, unknown>).revision = 4; }), "rollout_stale"],
  ];

  it.each(malformedCases)("denies %s as %s with zero adapter calls", async (_name, data, denial, claimOverride) => {
    const { quote, onAuthorized, run } = harness(Promise.resolve({ data, error: null }));
    await expect(run({ claim: claimOverride })).rejects.toMatchObject({ denial, retryable: false });
    expect(quote).not.toHaveBeenCalled();
    expect(onAuthorized).not.toHaveBeenCalled();
  });

  it("rejects accessor-backed responses before reading them", () => {
    const response = authorizedResponse();
    let reads = 0;
    Object.defineProperty(response, "authorized", { enumerable: true, get: () => reads++ === 0 });
    expect(parseProviderDispatchAuthorization(response, claim(), { reviewedEnvelopes: REVIEWED })).toEqual({
      ok: false,
      denial: "current_evidence_malformed",
    });
    expect(reads).toBe(0);
  });
});

describe("provider dispatch preflight SQL contract", () => {
  it("emits only terminal denial codes from the shared OVD-457 vocabulary", () => {
    const emitted = [...migration.matchAll(/provider_dispatch_authorization_denial\('([a-z_]+)'\)/g)].map((match) => match[1]);
    expect(emitted.length).toBeGreaterThan(20);
    for (const code of emitted) {
      expect(PROVIDER_DISPATCH_DENIAL_CODES).toContain(code);
      expect(code).not.toBe("preflight_unavailable");
    }
  });

  it("returns the response keys this parser requires", () => {
    for (const key of ["permitId", "provider", "envelopeFingerprint", "canonicalEnvelope", "expiresAt", "sessionBindingId", "evidence"]) {
      expect(migration).toContain(`'${key}'`);
    }
    for (const key of ["now", "permitState", "admission", "rollout"]) {
      expect(migration).toContain(`'${key}'`);
    }
    expect(migration).toContain("'provider-dispatch-authorization.v1'");
  });
});

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
