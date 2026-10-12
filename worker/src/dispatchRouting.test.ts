// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  CONSUME_PERMIT_RPC,
  createPermitConsumptionDatabase,
  GENERIC_PERMIT_ID,
  genericAuthorizedResponse,
  genericDispatchRpc,
  genericFictivEnvelope,
  PERMIT_OUTCOME_RPC,
  PERMIT_SIDE_EFFECT_RPC,
} from "../test-support/genericDispatchResponse";
import {
  dispatchAuthorizationFailure,
  providerDispatchClaimFromTask,
  quoteWithRoutedDispatchPreflight,
} from "./dispatchRouting";
import { fingerprintProviderDispatchEnvelope } from "./providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight";
import {
  createProviderDispatchPermitConsumer,
  createProviderDispatchPermitLocalGuard,
} from "./providerDispatchPermitConsumption";
import { createProviderMutationPhase, runInProviderMutationPhase } from "./providerMutationPhase";
import { VendorAutomationError, type VendorName, type VendorQuoteAdapterInput, type VendorQuoteAdapterOutput } from "./types";
import { failureCodeForError, isRetryableVendorTaskError } from "./vendorTaskRetry";
import { XometryDispatchAuthorizationError } from "./xometryDispatchPreflight";

const PERMIT_ID = GENERIC_PERMIT_ID;
const GENERIC_RPC = "api_authorize_provider_worker_dispatch";
const XOMETRY_RPC = "api_authorize_xometry_beta_worker_dispatch";
const fictivEnvelope = genericFictivEnvelope;
const admittedGenericResponse = genericAuthorizedResponse;

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

type RpcResult = { data: unknown; error: unknown; status?: number };

/**
 * One harness is one simulated worker process (its own in-process guard). Pass
 * the same `database` to several harnesses to simulate workers sharing the
 * OVD-734 consumption table. `rpc` overrides individual RPC names.
 */
function harness(
  rpcResult: RpcResult,
  options: {
    workerName?: string;
    database?: ReturnType<typeof createPermitConsumptionDatabase>;
    rpc?: (name: string, args: Record<string, unknown>) => Promise<RpcResult> | undefined;
    timeoutMs?: number;
    quote?: () => Promise<VendorQuoteAdapterOutput>;
  } = {},
) {
  const simulated = genericDispatchRpc(rpcResult, options.database);
  const rpc = vi.fn((name: string, args: Record<string, unknown>) =>
    options.rpc?.(name, args) ?? simulated(name, args));
  const quote = vi.fn(options.quote ?? (async () => ({ artifacts: [] }) as unknown as VendorQuoteAdapterOutput));
  const onAuthorized = vi.fn();
  const supabase = { rpc } as unknown as SupabaseClient;
  const permitConsumer = createProviderDispatchPermitConsumer(supabase, {
    localGuard: createProviderDispatchPermitLocalGuard(),
    timeoutMs: options.timeoutMs,
    // The synthetic envelope expires 2026-10-03T12:15Z; keep the guard's clock inside it.
    now: () => Date.parse("2026-10-03T12:05:00.000Z"),
  });
  const run = (input: {
    vendor: VendorName;
    workerMode?: "live" | "simulate";
    task?: ReturnType<typeof genericTask>;
  }) => {
    const task = input.task ?? genericTask();
    return quoteWithRoutedDispatchPreflight({
      supabase,
      config: { workerMode: input.workerMode ?? "live", workerName: options.workerName ?? "worker-1" },
      task,
      vendorQuoteResultId: task.vendorQuoteResultId,
      claimedAt: "2026-10-03T12:04:00.000Z",
      vendor: input.vendor,
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: input.vendor },
      adapter: { quote },
      quoteInput: { organizationId: "org-1", quoteRunId: "run-1", requestedQuantity: 5 } as unknown as VendorQuoteAdapterInput,
      onAuthorized,
      permitConsumer,
    });
  };
  const calledRpcs = () => rpc.mock.calls.map(([name]) => name);
  return { rpc, quote, onAuthorized, run, calledRpcs };
}

const CONSUMPTION_RPCS = [CONSUME_PERMIT_RPC, PERMIT_SIDE_EFFECT_RPC, PERMIT_OUTCOME_RPC];

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

describe("durable permit consumption on the generic path (OVD-734)", () => {
  const admitted = () => ({ data: admittedGenericResponse(), error: null });

  it("consumes the permit and stamps its side effect before the adapter, then records the outcome", async () => {
    const { rpc, quote, onAuthorized, run, calledRpcs } = harness(admitted());
    const task = genericTask();
    await expect(run({ vendor: "fictiv", task })).resolves.toEqual({ artifacts: [] });
    expect(calledRpcs()).toEqual([GENERIC_RPC, CONSUME_PERMIT_RPC, PERMIT_SIDE_EFFECT_RPC, PERMIT_OUTCOME_RPC]);
    expect(rpc).toHaveBeenCalledWith(CONSUME_PERMIT_RPC, {
      p_work_queue_task_id: task.id,
      p_vendor_quote_result_id: task.vendorQuoteResultId,
      p_permit_id: PERMIT_ID,
      p_envelope_fingerprint: task.payload.providerDispatchEnvelopeFingerprint,
      p_worker_name: "worker-1",
    });
    expect(rpc).toHaveBeenCalledWith(PERMIT_OUTCOME_RPC, expect.objectContaining({ p_attempt: 1, p_outcome: "completed" }));
    const sideEffectCall = rpc.mock.invocationCallOrder[calledRpcs().indexOf(PERMIT_SIDE_EFFECT_RPC)];
    expect(sideEffectCall).toBeLessThan(quote.mock.invocationCallOrder[0]);
    expect(onAuthorized.mock.invocationCallOrder[0]).toBeGreaterThan(sideEffectCall);
  });

  it("refuses a requeued task on a second simulated worker with no adapter call", async () => {
    const database = createPermitConsumptionDatabase();
    const first = harness(admitted(), { database, workerName: "worker-1" });
    await expect(first.run({ vendor: "fictiv" })).resolves.toEqual({ artifacts: [] });
    const second = harness(admitted(), { database, workerName: "worker-2" });
    const error = await second.run({ vendor: "fictiv" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderDispatchAuthorizationError);
    expect(error).toMatchObject({ denial: "permit_already_consumed", retryable: false });
    expect(second.quote).not.toHaveBeenCalled();
    expect(second.onAuthorized).not.toHaveBeenCalled();
    expect(first.quote).toHaveBeenCalledTimes(1);
    expect(failureCodeForError(error)).toBe("permit_already_consumed");
    expect(isRetryableVendorTaskError(error, undefined)).toBe(false);
    expect(dispatchAuthorizationFailure(error)).toEqual({ boundary: "provider", reasonCode: "permit_already_consumed", retryable: false });
  });

  it("refuses a second presentation on the same worker in-process, before any consumption round trip", async () => {
    const { quote, run, calledRpcs } = harness(admitted());
    await run({ vendor: "fictiv" });
    await expect(run({ vendor: "fictiv" })).rejects.toMatchObject({ denial: "permit_already_consumed", retryable: false });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(calledRpcs().filter((name) => name === CONSUME_PERMIT_RPC)).toHaveLength(1);
  });

  it.each([
    ["a thrown consume RPC", () => Promise.reject(new Error("fetch failed")), "preflight_unavailable", true],
    ["a transport failure", () => Promise.resolve({ data: null, error: { message: "fetch failed" }, status: 0 }), "preflight_unavailable", true],
    ["a lock timeout (55P03)", () => Promise.resolve({ data: null, error: { code: "55P03" }, status: 500 }), "preflight_unavailable", true],
    ["a missing RPC (PGRST202)", () => Promise.resolve({ data: null, error: { code: "PGRST202" }, status: 404 }), "preflight_rejected", false],
    ["a malformed response", () => Promise.resolve({ data: { consumed: true }, error: null }), "current_evidence_malformed", false],
    ["a grant for another permit", () => Promise.resolve({ data: {
      schema: "provider-dispatch-permit-consumption.v1", consumed: true, permitId: "00000000-0000-4000-8000-0000000045ff", attempt: 1,
    }, error: null }), "current_evidence_malformed", false],
    ["an attempt 3", () => Promise.resolve({ data: {
      schema: "provider-dispatch-permit-consumption.v1", consumed: true, permitId: PERMIT_ID, attempt: 3,
    }, error: null }), "current_evidence_malformed", false],
    ["an unknown denial", () => Promise.resolve({ data: {
      schema: "provider-dispatch-permit-consumption.v1", consumed: false, denial: "try_again_later",
    }, error: null }), "current_evidence_malformed", false],
    ["an engaged kill switch", () => Promise.resolve({ data: {
      schema: "provider-dispatch-permit-consumption.v1", consumed: false, denial: "provider_kill_switch_engaged",
    }, error: null }), "provider_kill_switch_engaged", false],
  ] as const)("fails closed on %s with no adapter call", async (_label, consume, denial, retryable) => {
    const { quote, onAuthorized, run, calledRpcs } = harness(admitted(), {
      rpc: (name) => (name === CONSUME_PERMIT_RPC ? consume() : undefined),
    });
    await expect(run({ vendor: "fictiv" })).rejects.toMatchObject({ name: "ProviderDispatchAuthorizationError", denial, retryable });
    expect(quote).not.toHaveBeenCalled();
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(calledRpcs()).not.toContain(PERMIT_SIDE_EFFECT_RPC);
  });

  it("fails closed when the consume RPC never answers, with no adapter call", async () => {
    const { quote, onAuthorized, run } = harness(admitted(), {
      timeoutMs: 20,
      rpc: (name) => (name === CONSUME_PERMIT_RPC ? new Promise<never>(() => undefined) : undefined),
    });
    await expect(run({ vendor: "fictiv" })).rejects.toMatchObject({ denial: "preflight_unavailable", retryable: true });
    expect(quote).not.toHaveBeenCalled();
    expect(onAuthorized).not.toHaveBeenCalled();
  });

  it("after a transient pre-launch failure, exactly one retry dispatches", async () => {
    const database = createPermitConsumptionDatabase();
    let sideEffectStampsToFail = 1;
    const failFirstStamp = (name: string) => {
      if (name !== PERMIT_SIDE_EFFECT_RPC || sideEffectStampsToFail === 0) return undefined;
      sideEffectStampsToFail -= 1;
      return Promise.reject(new Error("fetch failed"));
    };

    const first = harness(admitted(), { database, workerName: "worker-1", rpc: failFirstStamp });
    const transient = await first.run({ vendor: "fictiv" }).catch((caught: unknown) => caught);
    expect(transient).toMatchObject({ denial: "preflight_unavailable", retryable: true });
    expect(isRetryableVendorTaskError(transient, undefined)).toBe(true);
    expect(first.quote).not.toHaveBeenCalled();
    expect(first.rpc).toHaveBeenCalledWith(PERMIT_OUTCOME_RPC, expect.objectContaining({
      p_attempt: 1, p_outcome: "transient_pre_launch_failure",
    }));

    // The retry lands on the same process (its guard never recorded the key) and dispatches as attempt 2.
    await expect(first.run({ vendor: "fictiv" })).resolves.toEqual({ artifacts: [] });
    expect(first.rpc).toHaveBeenCalledWith(PERMIT_SIDE_EFFECT_RPC, expect.objectContaining({ p_attempt: 2 }));
    expect(first.quote).toHaveBeenCalledTimes(1);

    const third = harness(admitted(), { database, workerName: "worker-3" });
    await expect(third.run({ vendor: "fictiv" })).rejects.toMatchObject({ denial: "permit_already_consumed", retryable: false });
    expect(third.quote).not.toHaveBeenCalled();
    expect(database.attempts.get(PERMIT_ID)).toHaveLength(2);
  });

  it("does not retry a transient failure of the retry itself", async () => {
    const database = createPermitConsumptionDatabase();
    const failStamp = (name: string) =>
      name === PERMIT_SIDE_EFFECT_RPC ? Promise.reject(new Error("fetch failed")) : undefined;
    await expect(harness(admitted(), { database, workerName: "worker-1", rpc: failStamp }).run({ vendor: "fictiv" }))
      .rejects.toMatchObject({ denial: "preflight_unavailable", retryable: true });
    const retry = harness(admitted(), { database, workerName: "worker-2", rpc: failStamp });
    const exhausted = await retry.run({ vendor: "fictiv" }).catch((caught: unknown) => caught);
    expect(exhausted).toMatchObject({ denial: "preflight_unavailable", retryable: false });
    expect(isRetryableVendorTaskError(exhausted, undefined)).toBe(false);
    expect(retry.quote).not.toHaveBeenCalled();
  });

  it("never retries a failure after the side effect is stamped, and records it as failed", async () => {
    const failure = new VendorAutomationError("Navigation timed out.", "navigation_failure");
    const { rpc, run } = harness(admitted(), { quote: () => Promise.reject(failure) });
    const phase = createProviderMutationPhase();
    await expect(runInProviderMutationPhase(phase, () => run({ vendor: "fictiv" }))).rejects.toBe(failure);
    expect(phase.permitSideEffectStarted).toBe(true);
    expect(phase.started).toBe(false);
    expect(isRetryableVendorTaskError(failure, phase)).toBe(false);
    expect(isRetryableVendorTaskError(failure, createProviderMutationPhase())).toBe(true);
    expect(rpc).toHaveBeenCalledWith(PERMIT_OUTCOME_RPC, expect.objectContaining({ p_outcome: "failed" }));
  });

  it("is terminal when the database refuses the side-effect stamp", async () => {
    const { quote, run } = harness(admitted(), {
      rpc: (name) => (name === PERMIT_SIDE_EFFECT_RPC
        ? Promise.resolve({ data: {
          schema: "provider-dispatch-permit-consumption.v1", consumed: false, denial: "provider_kill_switch_engaged",
        }, error: null })
        : undefined),
    });
    await expect(run({ vendor: "fictiv" })).rejects.toMatchObject({ denial: "provider_kill_switch_engaged", retryable: false });
    expect(quote).not.toHaveBeenCalled();
  });

  it.each([
    ["live Xometry", "xometry", "live"],
    ["simulated Xometry", "xometry", "simulate"],
    ["simulated Fictiv", "fictiv", "simulate"],
  ] as const)("leaves %s without any consumption RPC", async (_label, vendor, workerMode) => {
    const { quote, run, calledRpcs } = harness({ data: xometryAuthorized, error: null });
    await expect(run({ vendor, workerMode })).resolves.toEqual({ artifacts: [] });
    expect(quote).toHaveBeenCalledTimes(1);
    for (const name of CONSUMPTION_RPCS) expect(calledRpcs()).not.toContain(name);
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
