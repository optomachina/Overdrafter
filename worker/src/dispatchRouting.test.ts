// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../test-fixtures/provider-dispatch-envelope/v1.json";
import {
  dispatchAuthorizationFailure,
  providerDispatchClaimFromTask,
  quoteWithRoutedDispatchPreflight,
} from "./dispatchRouting";
import {
  canonicalizeProviderDispatchEnvelope,
  fingerprintProviderDispatchEnvelope,
  type ProviderDispatchEnvelope,
} from "./providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight";
import { createProviderMutationPhase } from "./providerMutationPhase";
import type { VendorName, VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "./types";
import { failureCodeForError, isRetryableVendorTaskError } from "./vendorTaskRetry";
import { XometryDispatchAuthorizationError } from "./xometryDispatchPreflight";

const PERMIT_ID = "00000000-0000-4000-8000-00000000457c";
const GENERIC_RPC = "api_authorize_provider_worker_dispatch";
const XOMETRY_RPC = "api_authorize_xometry_beta_worker_dispatch";

/** A fictiv generic envelope derived from the shared OVD-457 golden. */
function fictivEnvelope(): ProviderDispatchEnvelope {
  const golden = structuredClone(fixture.golden.envelope) as unknown as ProviderDispatchEnvelope;
  return {
    ...golden,
    provider: "fictiv",
    envelope: { id: "fictiv-quote-envelope", version: 1 },
    admission: { policyRevision: "fictiv-generic-2026-10-03.v1", evidenceReference: "OVD-458" },
    sessionBindingId: `lease:${PERMIT_ID}`,
  };
}

/** A well-formed, database-admitted generic decision for the fictiv envelope. */
function admittedGenericResponse(envelope = fictivEnvelope()): Record<string, unknown> {
  return {
    schema: "provider-dispatch-authorization.v1",
    authorized: true,
    permitId: envelope.permit.permitId,
    provider: envelope.provider,
    envelopeFingerprint: fingerprintProviderDispatchEnvelope(envelope),
    canonicalEnvelope: canonicalizeProviderDispatchEnvelope(envelope),
    expiresAt: envelope.expiresAt,
    sessionBindingId: envelope.sessionBindingId,
    evidence: {
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
    },
  };
}

function genericTask(payload: Record<string, unknown> = {}) {
  const envelope = fictivEnvelope();
  return {
    id: envelope.task.workQueueTaskId,
    vendorQuoteResultId: envelope.task.vendorQuoteResultId,
    payload: {
      providerDispatchPermitId: PERMIT_ID,
      providerDispatchEnvelopeRevision: "fictiv-quote-envelope.v1",
      providerDispatchEnvelopeFingerprint: fingerprintProviderDispatchEnvelope(envelope),
      ...payload,
    },
  };
}

function harness(rpcResult: { data: unknown; error: unknown; status?: number }) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const quote = vi.fn().mockResolvedValue({ artifacts: [] } as unknown as VendorQuoteAdapterOutput);
  const onAuthorized = vi.fn();
  const run = (input: {
    vendor: VendorName;
    workerMode?: "live" | "simulate";
    task?: ReturnType<typeof genericTask>;
  }) => {
    const task = input.task ?? genericTask();
    return quoteWithRoutedDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      config: { workerMode: input.workerMode ?? "live", workerName: "worker-1" },
      task,
      vendorQuoteResultId: task.vendorQuoteResultId,
      claimedAt: "2026-10-03T12:04:00.000Z",
      vendor: input.vendor,
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: input.vendor },
      adapter: { quote },
      quoteInput: { organizationId: "org-1", quoteRunId: "run-1", requestedQuantity: 5 } as unknown as VendorQuoteAdapterInput,
      onAuthorized,
    });
  };
  return { rpc, quote, onAuthorized, run };
}

const xometryAuthorized = {
  authorized: true,
  reasonCode: null,
  permitId: "00000000-0000-4000-8000-000000003680",
  provider: "xometry",
  scopeFingerprint: "a".repeat(64),
  envelopeRevision: "xometry-controlled-beta-envelope.v1",
  nonExportControlled: true,
};

describe("dispatch routing (OVD-381)", () => {
  it("keeps live Xometry on the specialized preflight even when generic permit keys are present", async () => {
    const { rpc, quote, onAuthorized, run } = harness({ data: xometryAuthorized, error: null });
    await expect(run({ vendor: "xometry" })).resolves.toEqual({ artifacts: [] });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(XOMETRY_RPC, expect.objectContaining({ p_expected_worker_name: "worker-1" }));
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({
      xometryDispatchAuthorization: expect.objectContaining({ provider: "xometry" }),
    }));
  });

  it("routes a live non-Xometry task with a generic permit to the provider-neutral preflight", async () => {
    const { rpc, run } = harness({
      data: { schema: "provider-dispatch-authorization.v1", authorized: false, denial: "permit_revoked", retryable: false },
      error: null,
    });
    const task = genericTask();
    await expect(run({ vendor: "fictiv", task })).rejects.toMatchObject({ denial: "permit_revoked", retryable: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(GENERIC_RPC, {
      p_work_queue_task_id: task.id,
      p_vendor_quote_result_id: task.vendorQuoteResultId,
      p_scope_snapshot: { schema: "quote-lane-scope.v1", vendor: "fictiv" },
      p_expected_worker_name: "worker-1",
      p_expected_claimed_at: "2026-10-03T12:04:00.000Z",
    });
  });

  it("hands a database-admitted decision for the reviewed Fictiv envelope to the adapter (OVD-673)", async () => {
    const { quote, onAuthorized, run } = harness({ data: admittedGenericResponse(), error: null });
    await expect(run({ vendor: "fictiv" })).resolves.toEqual({ artifacts: [] });
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({
      providerDispatchAuthorization: expect.objectContaining({
        provider: "fictiv",
        permitId: PERMIT_ID,
        envelope: expect.objectContaining({ envelope: { id: "fictiv-quote-envelope", version: 1 } }),
      }),
    }));
  });

  it("default-denies a database-admitted decision for an envelope revision not reviewed in code", async () => {
    const unreviewed = { ...fictivEnvelope(), envelope: { id: "fictiv-quote-envelope", version: 2 } };
    const { quote, onAuthorized, run } = harness({ data: admittedGenericResponse(unreviewed), error: null });
    const task = genericTask({ providerDispatchEnvelopeFingerprint: fingerprintProviderDispatchEnvelope(unreviewed) });
    await expect(run({ vendor: "fictiv", task })).rejects.toMatchObject({
      name: "ProviderDispatchAuthorizationError",
      denial: "provider_envelope_unknown",
      retryable: false,
    });
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it("surfaces generic transport failures as retryable without launching the adapter", async () => {
    const { quote, run } = harness({ data: null, error: { message: "fetch failed" }, status: 0 });
    await expect(run({ vendor: "protolabs" })).rejects.toMatchObject({ denial: "preflight_unavailable", retryable: true });
    expect(quote).not.toHaveBeenCalled();
  });

  it.each([
    ["no permit keys", {}],
    ["permit id only", { providerDispatchPermitId: PERMIT_ID }],
    ["fingerprint only", { providerDispatchEnvelopeFingerprint: "a".repeat(64) }],
    ["non-string permit id", { providerDispatchPermitId: 4570, providerDispatchEnvelopeFingerprint: "a".repeat(64) }],
  ])("keeps the legacy live refusal for a non-Xometry task with %s", async (_label, payload) => {
    const { rpc, quote, run } = harness({ data: admittedGenericResponse(), error: null });
    const task = { ...genericTask(), payload };
    await expect(run({ vendor: "fictiv", task })).rejects.toMatchObject({
      name: "XometryDispatchAuthorizationError",
      reasonCode: "dispatch_live_provider_not_permitted",
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it.each(["xometry", "fictiv"] as const)("keeps simulate mode local for %s without any preflight RPC", async (vendor) => {
    const { rpc, quote, onAuthorized, run } = harness({ data: null, error: null });
    await expect(run({ vendor, workerMode: "simulate" })).resolves.toEqual({ artifacts: [] });
    expect(rpc).not.toHaveBeenCalled();
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("builds the claim only from the worker's own task for non-Xometry providers", () => {
    const task = genericTask();
    expect(providerDispatchClaimFromTask({ task, vendorQuoteResultId: task.vendorQuoteResultId, vendor: "xometry" })).toBeNull();
    expect(providerDispatchClaimFromTask({ task, vendorQuoteResultId: task.vendorQuoteResultId, vendor: "fictiv" })).toEqual({
      workQueueTaskId: task.id,
      vendorQuoteResultId: task.vendorQuoteResultId,
      provider: "fictiv",
      permitId: PERMIT_ID,
      envelopeFingerprint: task.payload.providerDispatchEnvelopeFingerprint,
    });
  });
});

describe("dispatch authorization failure classification", () => {
  it("keeps the Xometry reason codes and retryability unchanged", () => {
    expect(dispatchAuthorizationFailure(new XometryDispatchAuthorizationError("dispatch_preflight_unavailable")))
      .toEqual({ boundary: "xometry", reasonCode: "dispatch_preflight_unavailable", retryable: true });
    expect(dispatchAuthorizationFailure(new XometryDispatchAuthorizationError("dispatch_rollout_disabled")))
      .toEqual({ boundary: "xometry", reasonCode: "dispatch_rollout_disabled", retryable: false });
  });

  it("maps generic denials to their closed-vocabulary code and retryability", () => {
    expect(dispatchAuthorizationFailure(new ProviderDispatchAuthorizationError("preflight_unavailable")))
      .toEqual({ boundary: "provider", reasonCode: "preflight_unavailable", retryable: true });
    expect(dispatchAuthorizationFailure(new ProviderDispatchAuthorizationError("permit_revoked")))
      .toEqual({ boundary: "provider", reasonCode: "permit_revoked", retryable: false });
    expect(dispatchAuthorizationFailure(new Error("dispatch_preflight_unavailable"))).toBeNull();
  });

  it("classifies generic denials in the shared retry helpers", () => {
    expect(failureCodeForError(new ProviderDispatchAuthorizationError("permit_expired"))).toBe("permit_expired");
    expect(isRetryableVendorTaskError(new ProviderDispatchAuthorizationError("preflight_unavailable"), undefined)).toBe(true);
    expect(isRetryableVendorTaskError(new ProviderDispatchAuthorizationError("preflight_rejected"), undefined)).toBe(false);
    const started = createProviderMutationPhase();
    started.started = true;
    expect(isRetryableVendorTaskError(new ProviderDispatchAuthorizationError("preflight_unavailable"), started)).toBe(false);
  });
});
