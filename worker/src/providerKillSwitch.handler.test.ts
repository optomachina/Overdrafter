// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleVendorQuoteTask } from "./index";
import { XometryAdapter } from "./adapters/xometry";
import type { QueueTaskRecord, VendorQuoteAdapterInput, WorkerConfig } from "./types";

vi.mock("./files.js", async (original) => ({
  ...await original<typeof import("./files.js")>(), createRunDir: vi.fn(async () => "/tmp/owned-fake-stage"),
  stageStorageObject: vi.fn(async (_db, file) => file ? ({ originalName: file.original_name, localPath: "/tmp/fake.step",
    storageBucket: file.storage_bucket, storagePath: file.storage_path, trustedContentSha256: "b".repeat(64) }) : null),
  cleanupPaths: vi.fn(async () => undefined),
}));
vi.mock("./scoringIntegration.js", () => ({ computeAndStoreRoutingScores: vi.fn(async () => undefined) }));

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
  const writes: Record<string, unknown>[] = [];
  const from = (table: string) => {
    let columns = ""; let mutation = false;
    const response = () => {
      if (mutation) return { data: null, error: null };
      const data = table === "parts" ? part : table === "job_files" ? [cad]
        : table === "approved_part_requirements" ? requirement
          : table === "vendor_quote_results" ? (columns === "status" ? [{ status: "failed" }] : { id: "result", requested_quantity: 2 })
            : table === "jobs" ? { organization_id: "org", status: "internal_review" }
              : table === "quote_runs" ? { status: "received", quote_requests: { status: "requesting" } } : null;
      return { data, error: null };
    };
    const query = {
      select(value: string) { columns = value; return query; },
      eq() { return query; }, neq() { return query; }, in() { return query; },
      single: async () => response(), maybeSingle: async () => response(),
      update(value: unknown) { mutation = true; writes.push({ table, update: structuredClone(value) }); return query; },
      insert(value: unknown) { mutation = true; writes.push({ table, insert: structuredClone(value) }); return query; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(response()).then(resolve, reject);
      },
    };
    return query;
  };
  let onPreflight = () => undefined as void;
  let preflight: unknown = xometryAuthorized;
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
        : name === "api_reserve_spend" ? { allowed: true, reservationId: "r" }
          : name === "api_get_worker_sourcing_intent" ? { activeDeadline: null, destination: { state: "confirmed", confirmationRevision: "1",
            street: "s", city: "c", region: "WA", postalCode: "z", country: "US" } } : null;
    const result = Promise.resolve({ data, error: null });
    return Object.assign(result, { abortSignal: () => result });
  };
  const rpcNames = () => writes.flatMap((write) => (typeof write.rpc === "string" ? [write.rpc] : []));
  return {
    client: { from, rpc } as unknown as SupabaseClient, writes, switches, rpcNames,
    flipDuringPreflight: () => { onPreflight = () => { switches.xometry = true; }; },
    denyPreflight: (decision: unknown) => { preflight = decision; },
    unreadableAfter: (reads: number) => { readableStateReads = reads; },
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
});
