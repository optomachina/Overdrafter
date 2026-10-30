// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { genericFictivEnvelope } from "../test-support/genericDispatchResponse";
import { handleVendorQuoteTask } from "./index";
import { FictivAdapter } from "./adapters/fictiv";
import { fingerprintProviderDispatchEnvelope } from "./providerDispatchEnvelope";
import type { ProviderDispatchEnvelope } from "./providerDispatchTypes";
import { createProviderAuthorizationConsumer } from "./providerExecutionSeam";
import { markProviderMutationStarted } from "./providerMutationPhase";
import { runGenericProviderTask } from "./providerTaskRoute";
import type { QueueTaskRecord, VendorQuoteAdapterInput, WorkerConfig } from "./types";
import { providerDispatchReservation } from "../test-support/providerDispatchReservation";

/**
 * OVD-722 on the OVD-464 generic route: a live Fictiv task carrying a generic
 * permit runs through `runGenericProviderTask`, not the Xometry preflight. The
 * route's database plumbing (lane read, `api_authorize_provider_dispatch`,
 * staged byte reads) is replaced with the pipeline fixtures; everything the
 * handler builds (the guarded adapter, persist, day switch) and the real
 * pipeline and outcome recording run unchanged.
 */

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const CAD = new TextEncoder().encode("step-bytes");
const DRAWING = new TextEncoder().encode("pdf-bytes");
const NOW = Date.parse("2026-10-03T12:05:00.000Z");

const ENVELOPE: ProviderDispatchEnvelope = (() => {
  const base = genericFictivEnvelope();
  const outbound = (role: "cad" | "drawing", bytes: Uint8Array) =>
    ({ role, sourceSha256: sha(bytes), sha256: sha(bytes), derivation: "identity" as const });
  return {
    ...base,
    sourceFiles: [
      { role: "cad", fileId: base.sourceFiles[0].fileId, sha256: sha(CAD) },
      { role: "drawing", fileId: base.sourceFiles[1].fileId, sha256: sha(DRAWING) },
    ],
    outboundFiles: [outbound("cad", CAD), outbound("drawing", DRAWING)],
  };
})();
const FINGERPRINT = fingerprintProviderDispatchEnvelope(ENVELOPE);

vi.mock("./providerTaskRoute.js", async (original) => {
  const actual = await original<typeof import("./providerTaskRoute.js")>();
  const { runProviderTaskPipeline } = await import("./providerTaskPipeline.js");
  return {
    ...actual,
    runGenericProviderTask: vi.fn((input: Parameters<typeof actual.runGenericProviderTask>[0]) =>
      runProviderTaskPipeline(
        {
          task: input.task,
          claim: input.claim,
          requestedQuantity: input.requestedQuantity,
          environment: "test",
          adapterRevision: input.adapterRevision,
          leaseSetting: "off",
          quoteInput: input.quoteInput,
        },
        {
          readLane: async () => ({
            laneId: ENVELOPE.task.quoteRequestLaneId,
            quoteRequestId: ENVELOPE.task.quoteRequestId,
            quoteRunId: ENVELOPE.task.quoteRunId,
            vendorQuoteResultId: ENVELOPE.task.vendorQuoteResultId,
            scopeFingerprint: ENVELOPE.scope.fingerprint,
          }),
          authorize: async () => ({
            permitId: ENVELOPE.permit.permitId,
            provider: ENVELOPE.provider,
            envelopeFingerprint: FINGERPRINT,
            expiresAt: ENVELOPE.expiresAt,
            sessionBindingId: ENVELOPE.sessionBindingId,
            envelope: ENVELOPE,
          }),
          readCapturedFiles: async () => [
            { role: "cad" as const, bytes: Uint8Array.from(CAD) },
            { role: "drawing" as const, bytes: Uint8Array.from(DRAWING) },
          ],
          adapter: input.adapter,
          persist: input.persist,
          daySwitch: input.daySwitch,
          consumer: createProviderAuthorizationConsumer(),
          onAdapterStart: input.onAdapterStart,
          now: () => NOW,
          log: () => {},
        },
      )),
  };
});
vi.mock("./files.js", async (original) => ({
  ...await original<typeof import("./files.js")>(), createRunDir: vi.fn(async () => "/tmp/owned-fake-stage"),
  stageStorageObject: vi.fn(async (_db, file) => file ? ({ originalName: file.original_name, localPath: "/tmp/fake.step",
    storageBucket: file.storage_bucket, storagePath: file.storage_path, trustedContentSha256: "b".repeat(64) }) : null),
  cleanupPaths: vi.fn(async () => undefined),
}));
vi.mock("./scoringIntegration.js", () => ({ computeAndStoreRoutingScores: vi.fn(async () => undefined) }));
// OVD-723: the staged STEP header is read for the export-control scan; a clean header records a clean scan.
vi.mock("./exportControl.js", async (original) => ({
  ...await original<typeof import("./exportControl.js")>(),
  readStagedStepHeaderPrefix: vi.fn(async () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\n")),
}));

const task = { id: ENVELOPE.task.workQueueTaskId, organization_id: ENVELOPE.subject.organizationId,
  quote_run_id: ENVELOPE.task.quoteRunId, part_id: "part", job_id: "job", task_type: "run_vendor_quote", attempts: 1,
  locked_at: "2026-10-03T12:00:00Z",
  payload: { vendor: "fictiv", vendorQuoteResultId: ENVELOPE.task.vendorQuoteResultId,
    requestedQuantity: ENVELOPE.scope.requestedQuantity,
    providerDispatchPermitId: ENVELOPE.permit.permitId, providerDispatchEnvelopeFingerprint: FINGERPRINT } } as QueueTaskRecord;
const live = { workerMode: "live", workerName: "worker", workerLiveAdapters: ["fictiv"], workerBuildVersion: "test",
  workerTempDir: "/tmp/owned-fake-stage", providerDurableDispatchCap: "on" } as unknown as WorkerConfig;
const part = { id: "part", job_id: "job", organization_id: ENVELOPE.subject.organizationId, name: "part",
  normalized_key: "part", cad_file_id: "cad", drawing_file_id: null, quantity: ENVELOPE.scope.requestedQuantity };
const cad = { id: "cad", job_id: "job", storage_bucket: "bucket", storage_path: "p/file.step",
  original_name: "file.step", file_kind: "cad" };
const requirement = { id: "req", part_id: "part", description: "d", part_number: "pn", revision: null, material: "",
  finish: null, tightest_tolerance_inch: null, quantity: ENVELOPE.scope.requestedQuantity,
  quote_quantities: [ENVELOPE.scope.requestedQuantity], requested_by_date: null, applicable_vendors: ["fictiv"],
  updated_at: "2026-10-03T12:00:00Z", spec_snapshot: {} };

/** In-memory DB: kill-switch rows are mutable data and lane writes are compare and set. */
function database() {
  const switches = { fictiv: false, global: false };
  // OVD-829: the admin-set daily cap read through api_worker_provider_settings_state. Null is no cap (the default).
  const settings = { cap: null as number | null };
  const writes: Record<string, unknown>[] = [];
  // Set when the task was settled elsewhere: a requeue then matches zero rows.
  const queue = { settledElsewhere: false };
  // OVD-723: answers to api_check_export_control_dispatch, in call order; the last one repeats.
  const exportControl = { answers: [{ allowed: true }] as unknown[], calls: 0 };
  const from = (table: string) => {
    let columns = ""; let mutation = false; let patch: Record<string, unknown> = {};
    const response = (list = false) => {
      if (mutation && table === "work_queue" && queue.settledElsewhere && patch.status === "queued") return { data: [], error: null };
      if (mutation) return { data: [{ id: "row" }], error: null };
      const data = table === "parts" ? part : table === "job_files" ? [cad]
        : table === "approved_part_requirements" ? requirement
          : table === "vendor_quote_results"
            ? (columns === "status" ? (list ? [{ status: "failed" }] : { status: "running" })
              : { id: ENVELOPE.task.vendorQuoteResultId, requested_quantity: ENVELOPE.scope.requestedQuantity })
            : table === "jobs" ? { organization_id: ENVELOPE.subject.organizationId, status: "internal_review" }
              : table === "quote_runs" ? { status: "received", quote_requests: { status: "requesting" } } : null;
      return { data, error: null };
    };
    const query = {
      select(value: string) { columns = value; return query; },
      eq() { return query; }, neq() { return query; }, in() { return query; },
      single: async () => response(), maybeSingle: async () => response(),
      update(value: unknown) {
        mutation = true; patch = structuredClone(value) as Record<string, unknown>;
        writes.push({ table, update: structuredClone(value) }); return query;
      },
      insert(value: unknown) { mutation = true; writes.push({ table, insert: structuredClone(value) }); return query; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(response(true)).then(resolve, reject);
      },
    };
    return query;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    writes.push({ rpc: name });
    const data = name === "accept_vendor_quote_result" ? { outcome: "accepted" } : name === "api_worker_provider_kill_switch_state"
      ? { schema: "provider-kill-switch-state.v1", provider: args.p_provider, engaged: switches.fictiv, globalEngaged: switches.global }
      : name === "api_reserve_spend" ? { allowed: true, reservationId: "r" }
        : name === "api_worker_reserve_provider_dispatch" ? providerDispatchReservation(args.p_provider)
        : name === "api_worker_provider_settings_state" ? { schema: "provider-settings-state.v1", provider: args.p_provider,
          globalEngaged: switches.global, engaged: switches.fictiv, dailyQuoteCap: settings.cap, usedToday: 0 }
        : name === "api_record_export_control_clean_scan" ? "export-scan"
        : name === "api_check_export_control_dispatch"
          ? exportControl.answers[Math.min(exportControl.calls++, exportControl.answers.length - 1)]
        : name === "api_get_worker_sourcing_intent" ? { activeDeadline: null, destination: { state: "confirmed",
          confirmationRevision: "1", street: "s", city: "c", region: "WA", postalCode: "z", country: "US" } } : null;
    const result = Promise.resolve({ data, error: null });
    return Object.assign(result, { abortSignal: () => result });
  };
  const rpcNames = () => writes.flatMap((write) => (typeof write.rpc === "string" ? [write.rpc] : []));
  const updates = (table: string) => writes.flatMap((write) =>
    write.table === table && write.update ? [write.update as Record<string, unknown>] : []);
  return { client: { from, rpc } as unknown as SupabaseClient, writes, switches, settings, rpcNames, updates, queue, exportControl };
}

const cancelledTask = expect.objectContaining({
  status: "cancelled",
  payload: expect.objectContaining({ cancellationReason: "cancelled_provider_disabled" }),
});

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(runGenericProviderTask).mockClear(); });

describe("handleVendorQuoteTask on the generic provider route with the kill switch (OVD-722, OVD-464)", () => {
  it("engaged after the claim check, before launch: no adapter call, cancelled_provider_disabled, no requeue", async () => {
    const quote = vi.spyOn(FictivAdapter.prototype, "quote");
    const db = database();
    let reads = 0;
    const rpc = db.client.rpc.bind(db.client);
    // The claim time read passes; the switch is engaged before the launch read.
    (db.client as unknown as { rpc: typeof rpc }).rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === "api_worker_provider_kill_switch_state" && ++reads === 2) db.switches.fictiv = true;
      return rpc(name, args);
    }) as typeof rpc;

    await handleVendorQuoteTask(db.client, task, live);

    expect(runGenericProviderTask).toHaveBeenCalledOnce();
    expect(quote).not.toHaveBeenCalled();
    expect(reads).toBe(2);
    expect(db.updates("vendor_quote_results")).toEqual(expect.arrayContaining([expect.objectContaining({
      status: "failed",
      notes: ["Provider temporarily unavailable."],
      raw_payload: expect.objectContaining({
        failureCode: "cancelled_provider_disabled",
        killSwitchCheckpoint: "before_launch",
        adapterStarted: false,
        providerMutationPossible: false,
        retryScheduledFor: null,
      }),
    })]));
    expect(db.updates("work_queue")).toEqual([cancelledTask]);
    expect(db.updates("vendor_quote_results")).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "queued" }),
      expect.objectContaining({ status: "manual_vendor_followup" }),
    ]));
  });

  it("engaged mid run after the upload: the adapter stops at its next checkpoint, cancelled with providerMutationPossible, no requeue", async () => {
    const db = database();
    const steps: string[] = [];
    const quote = vi.spyOn(FictivAdapter.prototype, "quote").mockImplementation(async (input: VendorQuoteAdapterInput) => {
      await input.providerKillSwitchCheckpoint?.("before_navigation");
      await input.providerKillSwitchCheckpoint?.("before_upload");
      markProviderMutationStarted();
      steps.push("uploaded");
      db.switches.fictiv = true;
      await input.providerKillSwitchCheckpoint?.("before_configure");
      steps.push("configured");
      throw new Error("unreachable: configuration must not happen");
    });

    await handleVendorQuoteTask(db.client, task, live);

    expect(runGenericProviderTask).toHaveBeenCalledOnce();
    expect(quote).toHaveBeenCalledOnce();
    expect(steps).toEqual(["uploaded"]);
    expect(db.updates("vendor_quote_results")).toEqual(expect.arrayContaining([expect.objectContaining({
      status: "failed",
      notes: ["Provider temporarily unavailable."],
      raw_payload: expect.objectContaining({
        failureCode: "cancelled_provider_disabled",
        killSwitchCheckpoint: "before_configure",
        providerMutationPossible: true,
        requiresManualVendorFollowUp: false,
        retryScheduledFor: null,
      }),
    })]));
    expect(db.updates("work_queue")).toEqual([cancelledTask]);
    expect(db.updates("work_queue")).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "queued" })]));
  });

  describe("a requeue outcome", () => {
    const requeueOutcome = {
      disposition: "requeue" as const, code: "authorization_unavailable", stage: "authorize" as const,
      adapterStarted: false, retryAt: "2026-10-03T12:06:00.000Z", providerDisabledForDay: false, rejection: null,
      killSwitch: null, persisted: null, evidence: { adapterError: null, artifacts: [] },
    };

    it("requeues the task before the lane says queued", async () => {
      vi.mocked(runGenericProviderTask).mockResolvedValueOnce(requeueOutcome);
      const db = database();

      await handleVendorQuoteTask(db.client, task, live);

      const requeue = db.writes.findIndex((write) => write.table === "work_queue"
        && (write.update as Record<string, unknown> | undefined)?.status === "queued");
      const queuedLane = db.writes.findIndex((write) => write.table === "vendor_quote_results"
        && (write.update as Record<string, unknown> | undefined)?.status === "queued");
      expect(requeue).toBeGreaterThan(-1);
      expect(queuedLane).toBeGreaterThan(requeue);
    });

    it("matching zero rows leaves the lane as it is (no advertised retry) and logs once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.mocked(runGenericProviderTask).mockResolvedValueOnce(requeueOutcome);
      const db = database();
      db.queue.settledElsewhere = true;

      await handleVendorQuoteTask(db.client, task, live);

      expect(db.updates("work_queue")).toEqual([expect.objectContaining({ status: "queued" })]);
      expect(db.updates("vendor_quote_results")).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "queued" }),
      ]));
      expect(warn.mock.calls.filter(([line]) => String(line).includes("worker.task.requeue_skipped"))).toHaveLength(1);
    });
  });

  it("disengaged: every checkpoint is read, the launch read happens first, and the adapter runs to the normal persisted result", async () => {
    const db = database();
    const order: string[] = [];
    const rpc = db.client.rpc.bind(db.client);
    (db.client as unknown as { rpc: typeof rpc }).rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === "api_worker_provider_kill_switch_state") order.push("switch_read");
      if (name === "accept_vendor_quote_result") order.push("persist");
      return rpc(name, args);
    }) as typeof rpc;
    const adapterCheckpoints = ["before_navigation", "before_upload", "before_configure", "before_save"] as const;
    const quote = vi.spyOn(FictivAdapter.prototype, "quote").mockImplementation(async (input: VendorQuoteAdapterInput) => {
      order.push("adapter");
      expect(typeof input.providerKillSwitchCheckpoint).toBe("function");
      for (const checkpoint of adapterCheckpoints) {
        await input.providerKillSwitchCheckpoint?.(checkpoint);
        order.push(checkpoint);
      }
      return {
        vendor: "fictiv",
        status: "instant_quote_received",
        unitPriceUsd: 12,
        totalPriceUsd: 12,
        leadTimeBusinessDays: 8,
        quoteUrl: "https://app.fictiv.com/quotes/abc",
        dfmIssues: [],
        notes: [],
        artifacts: [],
        rawPayload: { source: "fictiv-live-adapter", requestedQuantity: ENVELOPE.scope.requestedQuantity },
      };
    });

    await handleVendorQuoteTask(db.client, task, live);

    expect(quote).toHaveBeenCalledOnce();
    // claim read, then the before_launch read, then one fresh read before each adapter checkpoint passes.
    expect(order).toEqual([
      "switch_read", "switch_read", "adapter",
      "switch_read", "before_navigation", "switch_read", "before_upload",
      "switch_read", "before_configure", "switch_read", "before_save",
      "persist",
    ]);
    expect(db.updates("work_queue")).toEqual([]);
    expect(db.updates("vendor_quote_results")).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "manual_vendor_followup" }),
    ]));
  });
});

/** OVD-723 with OVD-722 on the generic route: inside the pipeline's adapter step both gates run before adapter.quote. */
describe("handleVendorQuoteTask on the generic provider route with both gates", () => {
  it("an export blocked job is refused with the kill switch off: the before_launch read passes, the export recheck denies, no adapter", async () => {
    const quote = vi.spyOn(FictivAdapter.prototype, "quote");
    const db = database();
    // Cleared at the first gate and before the route; blocked at the recheck right before adapter.quote.
    db.exportControl.answers = [{ allowed: true }, { allowed: true }, { allowed: false, reasonCode: "export_review_pending" }];

    await handleVendorQuoteTask(db.client, task, live);

    expect(runGenericProviderTask).toHaveBeenCalledOnce();
    expect(quote).not.toHaveBeenCalled();
    const names = db.rpcNames();
    expect(names.filter((name) => name === "api_worker_provider_kill_switch_state")).toHaveLength(2);
    expect(names.lastIndexOf("api_worker_provider_kill_switch_state")).toBeLessThan(names.lastIndexOf("api_check_export_control_dispatch"));
    expect(db.exportControl.calls).toBe(3);
    expect(db.updates("vendor_quote_results")).toEqual(expect.arrayContaining([expect.objectContaining({
      status: "failed",
      raw_payload: expect.objectContaining({ exportControlHold: true, exportControlReasonCode: "export_review_pending",
        requiresManualVendorFollowUp: false }),
    })]));
    expect(db.updates("work_queue")).not.toEqual(expect.arrayContaining([cancelledTask]));
    expect(db.updates("work_queue")).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "queued" })]));
  });

  it("an engaged kill switch refuses an export cleared job before launch: cancelled_provider_disabled, no export recheck, no adapter", async () => {
    const quote = vi.spyOn(FictivAdapter.prototype, "quote");
    const db = database();
    let reads = 0;
    const rpc = db.client.rpc.bind(db.client);
    (db.client as unknown as { rpc: typeof rpc }).rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === "api_worker_provider_kill_switch_state" && ++reads === 2) db.switches.fictiv = true;
      return rpc(name, args);
    }) as typeof rpc;

    await handleVendorQuoteTask(db.client, task, live);

    expect(quote).not.toHaveBeenCalled();
    // The export checks before the route cleared the job; the switch read first in the adapter step refused it.
    expect(db.exportControl.calls).toBe(2);
    expect(db.updates("work_queue")).toEqual([cancelledTask]);
    expect(db.updates("vendor_quote_results")).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ raw_payload: expect.objectContaining({ exportControlHold: true }) }),
    ]));
  });
});

describe("handleVendorQuoteTask on the generic provider route with the supplier settings gate (OVD-829)", () => {
  function withReservation(db: ReturnType<typeof database>, answer: () => { data: unknown; error: unknown }) {
    const rpc = db.client.rpc.bind(db.client);
    (db.client as unknown as { rpc: typeof rpc }).rpc = ((name: string, args: Record<string, unknown>) => {
      if (name !== "api_worker_reserve_provider_dispatch") return rpc(name, args);
      db.writes.push({ rpc: name });
      const result = Promise.resolve(answer());
      return Object.assign(result, { abortSignal: () => result });
    }) as typeof rpc;
  }

  it("a spent daily cap refuses before launch: no adapter call, provider_daily_cap_reached, manual follow-up, no requeue", async () => {
    const quote = vi.spyOn(FictivAdapter.prototype, "quote");
    const db = database();
    withReservation(db, () => ({
      data: providerDispatchReservation("fictiv", { allowed: false, reason: "provider_daily_cap_reached", cap: 5, used: 5 }),
      error: null,
    }));

    await handleVendorQuoteTask(db.client, task, live);

    expect(quote).not.toHaveBeenCalled();
    expect(db.rpcNames()).toContain("api_worker_reserve_provider_dispatch");
    expect(db.updates("vendor_quote_results")).toEqual(expect.arrayContaining([expect.objectContaining({
      status: "manual_vendor_followup",
      raw_payload: expect.objectContaining({
        failureCode: "provider_daily_cap_reached",
        adapterStarted: false,
        providerMutationPossible: false,
        retryScheduledFor: null,
      }),
    })]));
    expect(db.updates("work_queue")).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "queued" })]));
  });

  it("an unreachable counter fails closed before launch for a capped supplier: no adapter call, provider_dispatch_counter_unavailable", async () => {
    const quote = vi.spyOn(FictivAdapter.prototype, "quote");
    const db = database();
    db.settings.cap = 5;
    withReservation(db, () => ({ data: null, error: { message: "function does not exist" } }));

    await handleVendorQuoteTask(db.client, task, live);

    expect(quote).not.toHaveBeenCalled();
    expect(db.updates("vendor_quote_results")).toEqual(expect.arrayContaining([expect.objectContaining({
      status: "failed",
      raw_payload: expect.objectContaining({ failureCode: "provider_dispatch_counter_unavailable", adapterStarted: false }),
    })]));
  });

  it("an unreachable counter does not stop an uncapped supplier: there is no default cap", async () => {
    const quote = vi.spyOn(FictivAdapter.prototype, "quote").mockImplementation(async () => {
      throw new Error("adapter reached");
    });
    const db = database();
    withReservation(db, () => ({ data: null, error: { message: "function does not exist" } }));

    await handleVendorQuoteTask(db.client, task, live);

    expect(quote).toHaveBeenCalledOnce();
    expect(db.updates("vendor_quote_results")).not.toEqual(expect.arrayContaining([expect.objectContaining({
      raw_payload: expect.objectContaining({ failureCode: "provider_dispatch_counter_unavailable" }),
    })]));
  });

  it("a supplier switched off between the switch read and the reservation is cancelled_provider_disabled", async () => {
    const quote = vi.spyOn(FictivAdapter.prototype, "quote");
    const db = database();
    withReservation(db, () => ({
      data: providerDispatchReservation("fictiv", { allowed: false, reason: "provider_disabled" }),
      error: null,
    }));

    await handleVendorQuoteTask(db.client, task, live);

    expect(quote).not.toHaveBeenCalled();
    expect(db.updates("vendor_quote_results")).toEqual(expect.arrayContaining([expect.objectContaining({
      status: "failed",
      notes: ["Provider temporarily unavailable."],
      raw_payload: expect.objectContaining({ failureCode: "cancelled_provider_disabled", killSwitchCheckpoint: "before_launch" }),
    })]));
    expect(db.updates("work_queue")).toEqual([cancelledTask]);
  });
});


describe("claim-fenced acceptance route", () => {
  const scenarios = [
    { name: "accepted", replies: [{ outcome: "accepted" }], drain: true },
    { name: "request_canceled", replies: [{ outcome: "request_canceled" }], drain: true },
    { name: "stale", replies: [{ outcome: "stale" }], drain: false },
    { name: "fenced", replies: [{ outcome: "fenced" }], drain: false, failed: true },
    { name: "payload_mismatch", replies: [{ outcome: "payload_mismatch" }], drain: false, failed: true },
    { name: "busy then accepted", replies: [{ outcome: "busy" }, { outcome: "accepted" }], drain: true },
    { name: "busy exhausted", replies: [{ outcome: "busy" }], drain: false, failed: true, attempts: 10 },
    { name: "lost response then replayed", replies: [new Error("lost response"), { outcome: "replayed", original_outcome: "accepted" }], drain: true },
    { name: "replayed cancellation", replies: [{ outcome: "replayed", original_outcome: "request_canceled" }], drain: true },
    { name: "drain failure", replies: [{ outcome: "accepted" }], drain: true, drainError: true },
  ];
  it.each(scenarios)("$name preserves the claim boundary", async (scenario) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(FictivAdapter.prototype, "quote").mockResolvedValue({
      vendor: "fictiv", status: "instant_quote_received", unitPriceUsd: 12, totalPriceUsd: 12,
      leadTimeBusinessDays: 8, quoteUrl: "https://app.fictiv.com/quotes/abc", dfmIssues: [], notes: [], artifacts: [],
      rawPayload: { source: "fictiv-live-adapter", requestedQuantity: ENVELOPE.scope.requestedQuantity },
    });
    const db = database();
    const rpc = db.client.rpc.bind(db.client);
    const acceptanceArgs: Record<string, unknown>[] = [];
    let drains = 0;
    (db.client as unknown as { rpc: typeof rpc }).rpc = ((name: string, args: Record<string, unknown>) => {
      if (name !== "accept_vendor_quote_result" && name !== "drain_quote_run_rollup_followups") return rpc(name, args);
      return (async () => {
      if (name === "accept_vendor_quote_result") {
        const reply = scenario.replies[Math.min(acceptanceArgs.length, scenario.replies.length - 1)];
        acceptanceArgs.push(structuredClone(args));
        if (reply instanceof Error) throw reply;
        return { data: reply, error: null };
      }
      if (name === "drain_quote_run_rollup_followups") {
        drains += 1;
        if (scenario.drainError) throw new Error("drain failed");
        return { data: {}, error: null };
      }
      return rpc(name, args);
      })();
    }) as typeof rpc;
    const claimed = { ...task, locked_by: "worker", locked_at: "2026-10-29T12:34:56.123456+00:00" };
    const run = handleVendorQuoteTask(db.client, claimed, live);
    const assertion = expect(run).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(18000);
    await assertion;
    if (scenario.failed) expect(db.updates("vendor_quote_results")).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw_payload: expect.objectContaining({ failureCode: "persistence_failure" }) }),
    ]));
    expect(acceptanceArgs).toHaveLength(scenario.attempts ?? scenario.replies.length);
    expect(acceptanceArgs[0]).toMatchObject({
      p_task_id: claimed.id, p_locked_by: claimed.locked_by, p_locked_at: claimed.locked_at,
      p_attempts: claimed.attempts, p_task_payload_patch: { vendorStatus: "instant_quote_received", artifactCount: 0 , offerCount: 1 },
    });
    for (const args of acceptanceArgs) expect(args).toEqual(acceptanceArgs[0]);
    expect(drains).toBe(scenario.drain ? 1 : 0);
    if (!scenario.failed) {
      expect(db.writes.filter((write) => write.table === "work_queue")).toEqual([]);
    }
    if (scenario.name === "stale") {
      expect(db.writes.filter((write) => write.table === "vendor_quote_results" &&
        (write.update as { status?: string })?.status !== "running")).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("claim lost"));
    }
  });
});
