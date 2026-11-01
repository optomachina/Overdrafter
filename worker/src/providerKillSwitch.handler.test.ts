// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanupPaths } from "./files";
import { createWorkerRuntimeState } from "./httpServer";
import { handleVendorQuoteTask, processClaimedTask } from "./index";
import { XometryAdapter } from "./adapters/xometry";
import { createProviderMutationPhase, markProviderMutationStarted, runInProviderMutationPhase } from "./providerMutationPhase";
import type { QueueTaskRecord, VendorQuoteAdapterInput, WorkerConfig } from "./types";
import { providerDispatchReservation } from "../test-support/providerDispatchReservation";

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

const task = { id: "task", organization_id: "org", quote_run_id: "run", part_id: "part", job_id: "job",
  task_type: "run_vendor_quote", attempts: 1, locked_at: "2026-10-11T00:00:00Z",
  payload: { vendor: "xometry", vendorQuoteResultId: "result", requestedQuantity: 2 } } as QueueTaskRecord;
const live = { workerMode: "live", workerName: "worker", workerLiveAdapters: ["xometry"], xometryUserDataDir: null,
  xometryProfileSnapshotBucket: null, workerTempDir: "/tmp/owned-fake-stage" } as unknown as WorkerConfig;
const part = { id: "part", job_id: "job", organization_id: "org", name: "part", normalized_key: "part",
  cad_file_id: "cad", drawing_file_id: null, quantity: 2 };
const cad = { id: "cad", job_id: "job", storage_bucket: "bucket", storage_path: "p/file.step",
  original_name: "file.step", file_kind: "cad" };
const requirement = { id: "req", part_id: "part", description: "d", part_number: "pn", revision: null, material: "",
  finish: null, tightest_tolerance_inch: null, quantity: 2, quote_quantities: [2], requested_by_date: null,
  applicable_vendors: ["xometry"], updated_at: "2026-10-11T00:00:00Z", spec_snapshot: {} };
const xometryAuthorized = { authorized: true, reasonCode: null, permitId: "00000000-0000-4000-8000-000000003680",
  provider: "xometry", scopeFingerprint: "a".repeat(64), envelopeRevision: "xometry-controlled-beta-envelope.v1",
  nonExportControlled: true };

/** In-memory DB whose kill-switch rows are mutable data; the handler module is loaded once. */
function database() {
  const switches = { xometry: false, global: false };
  let failResultUpdates = false;
  const writes: Record<string, unknown>[] = [];
  // The claimed queue row; updates apply only when every filter matches, as in Postgres.
  const queueRow: Record<string, unknown> = { id: "task", status: "running", locked_by: "worker", attempts: 1 };
  const from = (table: string) => {
    let columns = ""; let mutation = false;
    let patch: Record<string, unknown> | null = null;
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const response = () => {
      if (mutation && table === "work_queue") {
        const matched = filters.every((filter) => filter(queueRow));
        if (matched && patch) Object.assign(queueRow, patch);
        patch = null;
        return { data: matched ? [{ id: queueRow.id }] : [], error: null };
      }
      if (mutation) return { data: table === "vendor_quote_results" && !failResultUpdates ? [{ id: "result" }] : null,
        error: table === "vendor_quote_results" && failResultUpdates ? { message: "db down" } : null };
      const data = table === "parts" ? part : table === "job_files" ? [cad]
        : table === "approved_part_requirements" ? requirement
          : table === "vendor_quote_results" ? (columns === "status" ? [{ status: "failed" }] : { id: "result", requested_quantity: 2 })
            : table === "jobs" ? { organization_id: "org", status: "internal_review" }
              : table === "quote_runs" ? { status: "received", quote_requests: { status: "requesting" } } : null;
      return { data, error: null };
    };
    const query = {
      select(value: string) { columns = value; return query; },
      eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return query; },
      neq(column: string, value: unknown) { filters.push((row) => row[column] !== value); return query; },
      is(column: string, value: unknown) { filters.push((row) => row[column] === value); return query; },
      in() { return query; },
      single: async () => response(), maybeSingle: async () => response(),
      update(value: unknown) {
        mutation = true; patch = structuredClone(value) as Record<string, unknown>;
        writes.push({ table, update: structuredClone(value) }); return query;
      },
      insert(value: unknown) { mutation = true; writes.push({ table, insert: structuredClone(value) }); return query; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(response()).then(resolve, reject);
      },
    };
    return query;
  };
  let onPreflight = () => undefined as void;
  let preflight: unknown = xometryAuthorized;
  let spend: unknown = { allowed: true, reservationId: "r" };
  // OVD-723: answers to api_check_export_control_dispatch, in call order; the last one repeats.
  let exportChecks: unknown[] = [{ allowed: true }];
  let exportCalls = 0;
  let stateReads = 0;
  let readableStateReads = Number.POSITIVE_INFINITY;
  const rpc = (name: string, args: Record<string, unknown>) => {
    writes.push({ rpc: name });
    if (name === "api_worker_provider_kill_switch_state" && ++stateReads > readableStateReads) {
      const failure = Promise.resolve({ data: null, error: { message: "rpc down" } });
      return Object.assign(failure, { abortSignal: () => failure });
    }
    if (name === "api_authorize_xometry_beta_worker_dispatch") onPreflight();
    const data = name === "api_worker_provider_kill_switch_state"
      ? { schema: "provider-kill-switch-state.v1", provider: args.p_provider, engaged: switches.xometry, globalEngaged: switches.global }
      : name === "api_authorize_xometry_beta_worker_dispatch" ? preflight
        : name === "api_reserve_spend" ? spend
          : name === "api_worker_reserve_provider_dispatch" ? providerDispatchReservation(args.p_provider)
          : name === "api_record_export_control_clean_scan" ? "export-scan"
          : name === "api_check_export_control_dispatch" ? exportChecks[Math.min(exportCalls++, exportChecks.length - 1)]
          : name === "api_get_worker_sourcing_intent" ? { activeDeadline: null, destination: { state: "confirmed", confirmationRevision: "1",
            street: "s", city: "c", region: "WA", postalCode: "z", country: "US" } } : null;
    const result = Promise.resolve({ data, error: null });
    return Object.assign(result, { abortSignal: () => result });
  };
  const rpcNames = () => writes.flatMap((write) => (typeof write.rpc === "string" ? [write.rpc] : []));
  return {
    client: { from, rpc } as unknown as SupabaseClient, writes, switches, rpcNames, queueRow,
    flipDuringPreflight: () => { onPreflight = () => { switches.xometry = true; }; },
    denyPreflight: (decision: unknown) => { preflight = decision; },
    refuseSpend: () => { spend = { allowed: false, reason: "Daily cap reached.", reasonCode: "daily_cap" }; },
    unreadableAfter: (reads: number) => { readableStateReads = reads; },
    unreadableNow: () => { readableStateReads = stateReads; },
    failResultUpdates: () => { failResultUpdates = true; },
    answerExportChecks: (answers: unknown[]) => { exportChecks = answers; },
  };
}

const cancelledTaskWrite = expect.objectContaining({ table: "work_queue", update: expect.objectContaining({
  status: "cancelled",
  payload: expect.objectContaining({ cancellationReason: "cancelled_provider_disabled" }),
}) });
const unavailableResultWrite = expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({
  status: "failed",
  notes: ["Provider temporarily unavailable."],
  raw_payload: expect.objectContaining({ failureCode: "cancelled_provider_disabled" }),
}) });

afterEach(() => { vi.restoreAllMocks(); });

describe("handleVendorQuoteTask with the provider kill switch (OVD-722)", () => {
  it("a queued task for a switched-off provider ends cancelled_provider_disabled at claim; no preflight, no adapter", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.switches.xometry = true;
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).not.toHaveBeenCalled();
    expect(db.rpcNames()).toEqual(["api_worker_provider_kill_switch_state"]);
    expect(db.writes).toEqual(expect.arrayContaining([unavailableResultWrite, cancelledTaskWrite]));
    expect(db.writes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({ status: "running" }) }),
    ]));
  });

  it("the global switch cancels the same way", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.switches.global = true;
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).not.toHaveBeenCalled();
    expect(db.writes).toEqual(expect.arrayContaining([cancelledTaskWrite]));
  });

  it("flipped after the server authorized: refused before launch and recorded as cancelled, not failed or retried", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.flipDuringPreflight();
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).not.toHaveBeenCalled();
    expect(db.rpcNames()).toEqual(expect.arrayContaining([
      "api_worker_provider_kill_switch_state", "api_authorize_xometry_beta_worker_dispatch"]));
    expect(db.rpcNames().filter((name) => name === "api_worker_provider_kill_switch_state")).toHaveLength(2);
    expect(db.writes).toEqual(expect.arrayContaining([unavailableResultWrite, cancelledTaskWrite]));
    expect(db.writes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "work_queue", update: expect.objectContaining({ status: "queued" }) }),
    ]));
  });

  it("the server preflight denying provider_kill_switch_engaged also ends cancelled_provider_disabled, not failed", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.denyPreflight({ authorized: false, reasonCode: "provider_kill_switch_engaged" });
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).not.toHaveBeenCalled();
    expect(db.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({
        raw_payload: expect.objectContaining({ failureCode: "cancelled_provider_disabled", killSwitchCheckpoint: "server_preflight" }),
      }) }),
      cancelledTaskWrite,
    ]));
    expect(db.writes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "work_queue", update: expect.objectContaining({ status: "failed" }) }),
    ]));
  });

  it("a retryable error after the kill switch cancel never requeues the cancelled task (no revival)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.denyPreflight({ authorized: false, reasonCode: "provider_kill_switch_engaged" });
    // The handler's finally block fails with a retryable network error after the cancel was written.
    vi.mocked(cleanupPaths).mockRejectedValueOnce(new Error("network unreachable"));
    const claimed = { ...task, locked_by: "worker" } as QueueTaskRecord;

    await processClaimedTask(db.client, claimed, live, createWorkerRuntimeState());

    expect(quote).not.toHaveBeenCalled();
    expect(db.writes).toEqual(expect.arrayContaining([cancelledTaskWrite]));
    // The outer loop tried to requeue, but the row is no longer running under this lock.
    expect(db.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "work_queue", update: expect.objectContaining({ status: "queued" }) }),
    ]));
    expect(db.queueRow.status).toBe("cancelled");
    // Logged once, by queue.ts, not again by the outer loop.
    expect(warn.mock.calls.filter(([line]) => String(line).includes("worker.task.requeue_skipped"))).toHaveLength(1);
  });

  it("a spend cap refusal with a retry left requeues the task before the lane says queued", async () => {
    const db = database();
    db.refuseSpend();
    const claimed = { ...task, locked_by: "worker" } as QueueTaskRecord;

    await handleVendorQuoteTask(db.client, claimed, live);

    const requeue = db.writes.findIndex((write) => write.table === "work_queue"
      && (write.update as Record<string, unknown> | undefined)?.status === "queued");
    const queuedLane = db.writes.findIndex((write) => write.table === "vendor_quote_results"
      && (write.update as Record<string, unknown> | undefined)?.status === "queued");
    expect(requeue).toBeGreaterThan(-1);
    expect(queuedLane).toBeGreaterThan(requeue);
    expect(db.queueRow.status).toBe("queued");
  });

  it("a spend cap requeue that matches zero rows leaves the lane as it is (no advertised retry)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = database();
    db.refuseSpend();
    // Settled elsewhere (the kill switch cancelled it) while this handler ran.
    db.queueRow.status = "cancelled";
    const claimed = { ...task, locked_by: "worker" } as QueueTaskRecord;

    await handleVendorQuoteTask(db.client, claimed, live);

    expect(db.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "work_queue", update: expect.objectContaining({ status: "queued" }) }),
    ]));
    expect(db.writes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({ status: "queued" }) }),
    ]));
    expect(db.queueRow.status).toBe("cancelled");
    expect(warn.mock.calls.filter(([line]) => String(line).includes("worker.task.requeue_skipped"))).toHaveLength(1);
  });

  it("a running task stops at its next adapter checkpoint and ends cancelled_provider_disabled", async () => {
    const db = database();
    const quote = vi.spyOn(XometryAdapter.prototype, "quote").mockImplementation(async (input: VendorQuoteAdapterInput) => {
      await input.providerKillSwitchCheckpoint?.("before_navigation");
      db.switches.xometry = true;
      await input.providerKillSwitchCheckpoint?.("before_upload");
      throw new Error("unreachable: upload must not happen");
    });
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).toHaveBeenCalledOnce();
    expect(db.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({
        raw_payload: expect.objectContaining({ failureCode: "cancelled_provider_disabled", killSwitchCheckpoint: "before_upload" }),
      }) }),
      cancelledTaskWrite,
    ]));
  });

  it("same handler, no restart: flip off cancels, flip back on and the next task reaches the adapter", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote").mockResolvedValue({ artifacts: [] } as never);
    const db = database();
    db.switches.xometry = true;
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).not.toHaveBeenCalled();
    db.switches.xometry = false;
    await handleVendorQuoteTask(db.client, task, live).catch(() => undefined);
    expect(quote).toHaveBeenCalledOnce();
  });

  const spentTask = { ...task, attempts: 4 } as QueueTaskRecord;
  const resultWrites = (db: ReturnType<typeof database>) => db.writes.filter((write) => write.table === "vendor_quote_results");

  it("an unreadable switch at claim with retries left rethrows and leaves the lane queued for the retry", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.unreadableAfter(0);
    await expect(handleVendorQuoteTask(db.client, task, live)).rejects.toMatchObject({ reasonCode: "provider_kill_switch_unavailable" });
    expect(quote).not.toHaveBeenCalled();
    expect(resultWrites(db).filter((write) => "update" in write)).toEqual([]);
  });

  it("an unreadable switch at claim with retries spent settles the lane failed, not manual, and still rethrows", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.unreadableAfter(0);
    await expect(handleVendorQuoteTask(db.client, spentTask, live)).rejects.toMatchObject({ reasonCode: "provider_kill_switch_unavailable" });
    expect(quote).not.toHaveBeenCalled();
    expect(db.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({
        status: "failed",
        raw_payload: expect.objectContaining({
          failureCode: "provider_kill_switch_unavailable", retryScheduledFor: null, requiresManualVendorFollowUp: false }),
      }) }),
    ]));
    expect(db.writes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({ status: "manual_vendor_followup" }) }),
    ]));
  });

  it("an unreadable switch at claim with retries spent: a database error while settling does not replace the kill switch error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = database();
    db.unreadableAfter(0);
    db.failResultUpdates();
    await expect(handleVendorQuoteTask(db.client, spentTask, live))
      .rejects.toMatchObject({ name: "ProviderKillSwitchError", reasonCode: "provider_kill_switch_unavailable" });
  });

  it("an unreadable switch before launch with retries spent: the note and the state agree (failed, no manual follow up)", async () => {
    const db = database();
    db.unreadableAfter(1);
    await expect(handleVendorQuoteTask(db.client, spentTask, live)).rejects.toMatchObject({ reasonCode: "provider_kill_switch_unavailable" });
    const failed = resultWrites(db).map((write) => write.update as Record<string, unknown>)
      .find((update) => update?.status === "failed");
    expect(failed).toBeDefined();
    expect(String((failed?.notes as string[])[0])).not.toMatch(/manual follow-up/i);
    expect(failed?.raw_payload).toEqual(expect.objectContaining({ requiresManualVendorFollowUp: false, retryScheduledFor: null }));
  });

  it("an unreadable switch after a provider mutation started: manual follow up, and the note never says nothing was sent", async () => {
    const db = database();
    vi.spyOn(XometryAdapter.prototype, "quote").mockImplementation(async (input: VendorQuoteAdapterInput) => {
      await input.providerKillSwitchCheckpoint?.("before_navigation");
      markProviderMutationStarted();
      db.unreadableNow();
      await input.providerKillSwitchCheckpoint?.("before_configure");
      throw new Error("unreachable: configuration must not happen");
    });
    // The queue loop runs every task inside a mutation phase; do the same here.
    await runInProviderMutationPhase(createProviderMutationPhase(), () => handleVendorQuoteTask(db.client, task, live));
    const manual = resultWrites(db).map((write) => write.update as Record<string, unknown>)
      .find((update) => update?.status === "manual_vendor_followup");
    expect(manual).toBeDefined();
    const note = String((manual?.notes as string[])[0]);
    expect(note).not.toMatch(/nothing was sent/i);
    expect(note).toMatch(/may already hold the upload/);
    expect(note).toMatch(/manual follow-up is required/i);
    expect(manual?.raw_payload).toEqual(expect.objectContaining({
      failureCode: "provider_kill_switch_unavailable", providerMutationPossible: true, requiresManualVendorFollowUp: true }));
  });
});

/** OVD-723 with OVD-722 on the merged tree: each gate refuses on its own; neither one stands in for the other. */
describe("handleVendorQuoteTask with both the export-control gate and the kill switch", () => {
  const exportCheckAnswers = (db: ReturnType<typeof database>) =>
    db.rpcNames().filter((name) => name === "api_check_export_control_dispatch").length;
  const heldLane = expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({
    status: "failed",
    raw_payload: expect.objectContaining({ exportControlHold: true, exportControlReasonCode: "export_review_pending" }),
  }) });
  // This fixture's lane compare and set matches no row, so task settlement is
  // not asserted here; exportControlQuoteGate.test.ts covers the held task.
  const requeuedTask = expect.objectContaining({ table: "work_queue", update: expect.objectContaining({ status: "queued" }) });

  it("an export blocked job is refused with the kill switch off: held at the first gate, no preflight, no adapter", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.answerExportChecks([{ allowed: false, reasonCode: "export_review_pending" }]);
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).not.toHaveBeenCalled();
    // The switch was read and is off; the export gate alone refused.
    expect(db.rpcNames()).toContain("api_worker_provider_kill_switch_state");
    expect(db.switches).toEqual({ xometry: false, global: false });
    expect(db.rpcNames()).not.toContain("api_authorize_xometry_beta_worker_dispatch");
    expect(db.writes).toEqual(expect.arrayContaining([heldLane]));
    expect(db.writes).not.toEqual(expect.arrayContaining([cancelledTaskWrite]));
    expect(db.writes).not.toEqual(expect.arrayContaining([requeuedTask]));
  });

  it("an export blocked job is refused with the kill switch off even after the before_launch read passed", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    // Cleared at the first gate and before the preflight; blocked at the recheck right before adapter.quote.
    db.answerExportChecks([{ allowed: true }, { allowed: true }, { allowed: false, reasonCode: "export_review_pending" }]);
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).not.toHaveBeenCalled();
    const names = db.rpcNames();
    // claim read, then the before_launch read after the preflight, then the denied export recheck.
    expect(names.filter((name) => name === "api_worker_provider_kill_switch_state")).toHaveLength(2);
    expect(names.lastIndexOf("api_worker_provider_kill_switch_state")).toBeLessThan(names.lastIndexOf("api_check_export_control_dispatch"));
    expect(exportCheckAnswers(db)).toBe(3);
    expect(db.writes).toEqual(expect.arrayContaining([heldLane]));
    expect(db.writes).not.toEqual(expect.arrayContaining([cancelledTaskWrite]));
    expect(db.writes).not.toEqual(expect.arrayContaining([requeuedTask]));
  });

  it("an engaged kill switch refuses an export cleared job: cancelled_provider_disabled before launch, no adapter", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database();
    db.answerExportChecks([{ allowed: true }]);
    db.flipDuringPreflight();
    await handleVendorQuoteTask(db.client, task, live);
    expect(quote).not.toHaveBeenCalled();
    // Both export checks before the launch cleared the job; the switch alone refused.
    expect(exportCheckAnswers(db)).toBe(2);
    expect(db.writes).toEqual(expect.arrayContaining([unavailableResultWrite, cancelledTaskWrite]));
    expect(db.writes).not.toEqual(expect.arrayContaining([heldLane]));
  });
});
