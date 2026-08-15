// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "./types";
import {
  quoteWithDispatchPreflight,
  XometryDispatchAuthorizationError,
} from "./xometryDispatchPreflight";

const scopeFingerprint = "a".repeat(64);
const authorizedDecision = {
  authorized: true,
  reasonCode: null,
  permitId: "00000000-0000-4000-8000-000000003680",
  provider: "xometry",
  scopeFingerprint,
  envelopeRevision: "xometry-controlled-beta-envelope.v1",
  nonExportControlled: true,
};

function makeSupabase(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return {
    client: { rpc } as unknown as SupabaseClient,
    rpc,
  };
}

function makeQuoteInput(): VendorQuoteAdapterInput {
  return {
    organizationId: "org-1",
    quoteRunId: "run-1",
    requestedQuantity: 1,
    part: {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Bracket",
      normalized_key: "bracket",
      cad_file_id: "cad-1",
      drawing_file_id: null,
      quantity: 1,
    },
    cadFile: {
      id: "cad-1",
      job_id: "job-1",
      organization_id: "org-1",
      storage_bucket: "job-files",
      storage_path: "org-1/part.step",
      original_name: "part.step",
      file_kind: "cad",
      trusted_content_sha256: "b".repeat(64),
    },
    drawingFile: null,
    stagedCadFile: {
      originalName: "part.step",
      localPath: "/tmp/part.step",
      storageBucket: "job-files",
      storagePath: "org-1/part.step",
      trustedContentSha256: "b".repeat(64),
    },
    stagedDrawingFile: null,
    requirement: {
      id: "req-1",
      part_id: "part-1",
      organization_id: "org-1",
      description: "Bracket",
      part_number: "VALIDATION-001",
      revision: "A",
      material: "6061-T6 Aluminum",
      finish: "As machined",
      tightest_tolerance_inch: 0.005,
      quantity: 1,
      quote_quantities: [1],
      requested_by_date: null,
      applicable_vendors: ["xometry"],
    },
  };
}

function makeOutput(): VendorQuoteAdapterOutput {
  return {
    vendor: "xometry",
    status: "instant_quote_received",
    unitPriceUsd: 25,
    totalPriceUsd: 25,
    leadTimeBusinessDays: 5,
    quoteUrl: "https://example.test/quote",
    dfmIssues: [],
    notes: [],
    artifacts: [],
    rawPayload: {},
  };
}

function makeInvocation(
  supabase: SupabaseClient,
  quote: ReturnType<typeof vi.fn>,
) {
  return {
    supabase,
    config: { workerMode: "live" as const, workerName: "worker-1" },
    workQueueTaskId: "task-1",
    vendorQuoteResultId: "result-1",
    claimedAt: "2026-08-15T18:00:00.000Z",
    vendor: "xometry" as const,
    scopeSnapshot: {
      schema: "quote-lane-scope.v1",
      vendor: "xometry",
    },
    adapter: { quote },
    quoteInput: makeQuoteInput(),
  };
}

describe("quoteWithDispatchPreflight", () => {
  it("calls the adapter exactly once with the bounded authorization after a valid decision", async () => {
    const { client, rpc } = makeSupabase(authorizedDecision);
    const quote = vi.fn().mockResolvedValue(makeOutput());
    const onAuthorized = vi.fn();

    await expect(
      quoteWithDispatchPreflight({
        ...makeInvocation(client, quote),
        onAuthorized,
      }),
    ).resolves.toMatchObject({ vendor: "xometry" });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "api_authorize_xometry_beta_worker_dispatch",
      expect.objectContaining({
        p_work_queue_task_id: "task-1",
        p_vendor_quote_result_id: "result-1",
        p_expected_worker_name: "worker-1",
        p_expected_claimed_at: "2026-08-15T18:00:00.000Z",
      }),
    );
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        xometryDispatchAuthorization: {
          permitId: authorizedDecision.permitId,
          provider: "xometry",
          scopeFingerprint,
          envelopeRevision: "xometry-controlled-beta-envelope.v1",
          nonExportControlled: true,
        },
      }),
    );
  });

  it("makes zero adapter calls when the server denies current authorization", async () => {
    const { client } = makeSupabase({
      authorized: false,
      reasonCode: "dispatch_rollout_disabled",
    });
    const quote = vi.fn();

    await expect(
      quoteWithDispatchPreflight(makeInvocation(client, quote)),
    ).rejects.toEqual(
      new XometryDispatchAuthorizationError("dispatch_rollout_disabled"),
    );
    expect(quote).not.toHaveBeenCalled();
  });

  it("does not persist an unrecognized server denial string", async () => {
    const { client } = makeSupabase({
      authorized: false,
      reasonCode: "customer-file-name-or-other-unbounded-detail",
    });
    const quote = vi.fn();

    await expect(
      quoteWithDispatchPreflight(makeInvocation(client, quote)),
    ).rejects.toMatchObject({ reasonCode: "dispatch_authorization_denied" });
    expect(quote).not.toHaveBeenCalled();
  });

  it("makes zero adapter calls when preflight is unavailable or malformed", async () => {
    for (const response of [
      { data: null, error: new Error("network unavailable") },
      { data: { authorized: true, provider: "xometry" }, error: null },
    ]) {
      const { client } = makeSupabase(response.data, response.error);
      const quote = vi.fn();

      await expect(
        quoteWithDispatchPreflight(makeInvocation(client, quote)),
      ).rejects.toBeInstanceOf(XometryDispatchAuthorizationError);
      expect(quote).not.toHaveBeenCalled();
    }
  });

  it("rejects every non-Xometry live adapter before RPC or adapter invocation", async () => {
    const { client, rpc } = makeSupabase(authorizedDecision);
    const quote = vi.fn();

    await expect(
      quoteWithDispatchPreflight({
        ...makeInvocation(client, quote),
        vendor: "fictiv",
      }),
    ).rejects.toMatchObject({
      reasonCode: "dispatch_live_provider_not_permitted",
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it("keeps simulated quoting local without requiring a disclosure permit", async () => {
    const { client, rpc } = makeSupabase(null);
    const quote = vi.fn().mockResolvedValue(makeOutput());

    await quoteWithDispatchPreflight({
      ...makeInvocation(client, quote),
      config: { workerMode: "simulate", workerName: "worker-1" },
    });

    expect(rpc).not.toHaveBeenCalled();
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote.mock.calls[0]?.[0].xometryDispatchAuthorization).toBeUndefined();
  });
});
