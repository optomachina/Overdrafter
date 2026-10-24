// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  GENERIC_PERMIT_ID,
  genericAuthorizedResponse,
  genericFictivEnvelope,
} from "../test-support/genericDispatchResponse";
import {
  DISPATCH_QUANTITY_NOT_ADMITTED_NOTE,
  dispatchAuthorizationFailure,
  providerDispatchClaimFromTask,
  quoteWithRoutedDispatchPreflight,
  xometryDispatchDenialNote,
} from "./dispatchRouting";
import { fingerprintProviderDispatchEnvelope } from "./providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight";
import { createProviderMutationPhase } from "./providerMutationPhase";
import type { VendorName, VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "./types";
import { failureCodeForError, isRetryableVendorTaskError } from "./vendorTaskRetry";
import { XometryDispatchAuthorizationError } from "./xometryDispatchPreflight";
import { providerDispatchReservation } from "../test-support/providerDispatchReservation";

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

function harness(rpcResult: { data: unknown; error: unknown; status?: number }) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const quote = vi.fn().mockResolvedValue({ artifacts: [] } as unknown as VendorQuoteAdapterOutput);
  const onAuthorized = vi.fn();
  const killSwitchReader = vi.fn(async (provider: VendorName) => ({
    schema: "provider-kill-switch-state.v1",
    provider,
    engaged: false,
    globalEngaged: false,
  }));
  const run = (input: {
    vendor: VendorName;
    workerMode?: "live" | "simulate";
    task?: ReturnType<typeof genericTask>;
  }) => {
    const task = input.task ?? genericTask();
    return quoteWithRoutedDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      config: { workerMode: input.workerMode ?? "live", workerName: "worker-1", providerDurableDispatchCap: "on" },
      task,
      vendorQuoteResultId: task.vendorQuoteResultId,
      claimedAt: "2026-10-03T12:04:00.000Z",
      vendor: input.vendor,
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: input.vendor },
      adapter: { quote },
      quoteInput: { organizationId: "org-1", quoteRunId: "run-1", requestedQuantity: 5 } as unknown as VendorQuoteAdapterInput,
      onAuthorized,
      reserveDispatch: async (provider: VendorName) => providerDispatchReservation(provider),
      killSwitchReader,
    });
  };
  return { rpc, quote, onAuthorized, run, killSwitchReader };
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

  it("names the OVD-987 quantity refusal as a terminal Xometry denial", () => {
    const error = new XometryDispatchAuthorizationError("dispatch_quantity_not_admitted");
    expect(dispatchAuthorizationFailure(error))
      .toEqual({ boundary: "xometry", reasonCode: "dispatch_quantity_not_admitted", retryable: false });
    expect(failureCodeForError(error)).toBe("dispatch_quantity_not_admitted");
    expect(isRetryableVendorTaskError(error, undefined)).toBe(false);
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

describe("Xometry denial lane notes (OVD-998)", () => {
  const failureOf = (error: unknown) => dispatchAuthorizationFailure(error)!;

  it("says the quantity was the reason, that nothing was sent, and that manual follow-up is next", () => {
    const note = xometryDispatchDenialNote(
      failureOf(new XometryDispatchAuthorizationError("dispatch_quantity_not_admitted")),
    );
    expect(note).toBe(DISPATCH_QUANTITY_NOT_ADMITTED_NOTE);
    expect(note).toContain("quantity above 1");
    expect(note).toContain("Nothing was sent to Xometry");
    expect(note).toContain("Manual follow-up is required");
    // The rollout may admit a quantity per participant or per request, so the note never calls the switch global.
    expect(note).not.toMatch(/switch|global|currently/i);
    expect(note).not.toContain("dispatch_");
  });

  it("leaves every other denial on the generic note", () => {
    for (const reasonCode of ["dispatch_rollout_disabled", "dispatch_lane_identity_mismatch", "dispatch_preflight_unavailable"]) {
      expect(xometryDispatchDenialNote(failureOf(new XometryDispatchAuthorizationError(reasonCode)))).toBeNull();
    }
  });

  it("never lends the Xometry wording to another boundary or to a retryable result", () => {
    expect(xometryDispatchDenialNote({ boundary: "provider", reasonCode: "dispatch_quantity_not_admitted", retryable: false })).toBeNull();
    expect(xometryDispatchDenialNote({ boundary: "xometry", reasonCode: "dispatch_quantity_not_admitted", retryable: true })).toBeNull();
  });
});

describe("dispatch routing upload capability checkpoint (OVD-414)", () => {
  it("supplies the upload capability checkpoint to production Xometry dispatch and reads admission from the RPC", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === XOMETRY_RPC) return { data: xometryAuthorized, error: null };
      if (name === "api_worker_resolve_xometry_admission") return { data: null, error: { message: "db detail" } };
      return { data: null, error: { message: "unexpected" } };
    });
    const quote = vi.fn(async (input: VendorQuoteAdapterInput) => {
      const decision = await input.uploadCapabilityCheckpoint?.({
        state: "fresh",
        provider: "xometry",
        route: "quote_home",
        surface: "dashboard_upload",
        revision: "xometry-upload-surface.v1",
        acceptAttributePresent: true,
        extensions: ["step"],
      });
      expect(decision?.classification).toBe("observation_missing");
      return { artifacts: [] } as unknown as VendorQuoteAdapterOutput;
    });
    const task = genericTask();
    await quoteWithRoutedDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      config: { workerMode: "live", workerName: "worker-1" },
      task,
      vendorQuoteResultId: task.vendorQuoteResultId,
      claimedAt: "2026-10-03T12:04:00.000Z",
      vendor: "xometry",
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "xometry" },
      adapter: { quote },
      quoteInput: { organizationId: "org-1", quoteRunId: "run-1", requestedQuantity: 5 } as unknown as VendorQuoteAdapterInput,
      reserveDispatch: async (provider: VendorName) => providerDispatchReservation(provider),
      killSwitchReader: async (provider) => ({
        schema: "provider-kill-switch-state.v1",
        provider,
        engaged: false,
        globalEngaged: false,
      }),
    });
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ uploadCapabilityCheckpoint: expect.any(Function) }));
    expect(rpc).toHaveBeenCalledWith("api_worker_resolve_xometry_admission");
  });

  it("does not attach the Xometry checkpoint to other providers", async () => {
    const { quote, run } = harness({ data: admittedGenericResponse(), error: null });
    await run({ vendor: "fictiv" });
    expect(quote.mock.calls[0][0].uploadCapabilityCheckpoint).toBeUndefined();
  });
});
