// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleVendorQuoteTask } from "./index";
import { XometryAdapter } from "./adapters/xometry";
import { EXPORT_CONTROL_HOLD_NOTE } from "./dispatchRouting";
import type { QueueTaskRecord, WorkerConfig } from "./types";

/**
 * OVD-723 findings 5 and 6, against the real quote task handler. Only the
 * database, Storage staging, and scoring boundaries are faked.
 *
 * 6: the export gate runs before any route that could turn the lane into
 *    manual work (adapter not enabled in WORKER_LIVE_ADAPTERS, spend cap
 *    exhausted), so a held job never becomes a manual quote task.
 * 5: the gate is asked again after the preflight authorizes and immediately
 *    before adapter.quote.
 */

vi.mock("./files.js", async (original) => ({
  ...await original<typeof import("./files.js")>(),
  createRunDir: vi.fn(async () => "/tmp/ovd723-gate-stage"),
  stageStorageObject: vi.fn(async (_db, file) => file ? ({ originalName: file.original_name, localPath: "/tmp/ovd723-gate.step",
    storageBucket: file.storage_bucket, storagePath: file.storage_path, trustedContentSha256: "b".repeat(64) }) : null),
  cleanupPaths: vi.fn(async () => undefined),
}));
vi.mock("./scoringIntegration.js", () => ({ computeAndStoreRoutingScores: vi.fn(async () => undefined) }));
vi.mock("./exportControl.js", async (original) => ({
  ...await original<typeof import("./exportControl.js")>(),
  readStagedStepHeaderPrefix: vi.fn(async () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\n")),
}));

const task = { id: "task-1", organization_id: "org-1", quote_run_id: "run-1", part_id: "part", job_id: "job",
  task_type: "run_vendor_quote", attempts: 1, locked_at: "2026-10-02T00:00:00Z",
  payload: { vendor: "xometry", vendorQuoteResultId: "result", requestedQuantity: 2 } } as QueueTaskRecord;
const part = { id: "part", job_id: "job", organization_id: "org-1", name: "bracket",
  normalized_key: "bracket", cad_file_id: "cad", drawing_file_id: null, quantity: 2 };
const cad = { id: "cad", job_id: "job", storage_bucket: "job-files", storage_path: "org/file.step",
  original_name: "bracket.step", file_kind: "cad" };
const requirement = { id: "req", part_id: "part", description: "bracket", part_number: "B-1",
  revision: null, material: "6061", finish: null, tightest_tolerance_inch: null, quantity: 2, quote_quantities: [2],
  requested_by_date: null, applicable_vendors: ["xometry"], updated_at: "2026-10-02T00:00:00Z", spec_snapshot: {} };

type Write = { table?: string; update?: Record<string, unknown>; rpc?: string; args?: unknown };

function database(options: {
  /** Answers to api_check_export_control_dispatch, in call order; the last one repeats. */
  exportChecks: unknown[];
  spendAllowed?: boolean;
}) {
  const writes: Write[] = [];
  let exportCalls = 0;
  const from = (table: string) => {
    let columns = "";
    let mutation = false;
    const response = () => {
      if (mutation) return { data: null, error: null };
      const data = table === "parts" ? part : table === "job_files" ? [cad]
        : table === "approved_part_requirements" ? requirement
          : table === "vendor_quote_results" ? (columns === "status" ? [{ status: "failed" }] : { id: "result", requested_quantity: 2 })
            : table === "jobs" ? { organization_id: "org-1", status: "internal_review" }
              : table === "quote_runs" ? { status: "received", quote_requests: { status: "requesting" } } : null;
      return { data, error: null };
    };
    const query = {
      select(value: string) { columns = value; return query; },
      eq() { return query; }, neq() { return query; }, in() { return query; },
      single: async () => response(), maybeSingle: async () => response(),
      update(value: Record<string, unknown>) { mutation = true; writes.push({ table, update: structuredClone(value) }); return query; },
      insert(value: Record<string, unknown>) { mutation = true; writes.push({ table, update: structuredClone(value) }); return query; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(response()).then(resolve, reject);
      },
    };
    return query;
  };
  const rpc = (name: string, args: unknown) => {
    writes.push({ rpc: name, args: structuredClone(args) });
    let data: unknown = null;
    if (name === "api_check_export_control_dispatch") {
      data = options.exportChecks[Math.min(exportCalls, options.exportChecks.length - 1)];
      exportCalls += 1;
    } else if (name === "api_reserve_spend") {
      data = options.spendAllowed === false
        ? { allowed: false, reason: "Daily cap reached.", reasonCode: "daily_cap" }
        : { allowed: true, reservationId: "reservation-1" };
    } else if (name === "api_record_export_control_clean_scan") {
      data = "scan-1";
    } else if (name === "api_get_worker_sourcing_intent") {
      data = { activeDeadline: null, destination: { state: "confirmed", confirmationRevision: "1",
        street: "1 Main", city: "Seattle", region: "WA", postalCode: "98101", country: "US" } };
    } else if (name === "api_authorize_xometry_beta_worker_dispatch") {
      data = { authorized: true };
    }
    const result = Promise.resolve({ data, error: null });
    return Object.assign(result, { abortSignal: () => result });
  };
  return { client: { from, rpc } as unknown as SupabaseClient, writes };
}

const resultUpdates = (writes: Write[]) =>
  writes.filter((write) => write.table === "vendor_quote_results" && write.update).map((write) => write.update!);
const rpcNames = (writes: Write[]) => writes.filter((write) => write.rpc).map((write) => write.rpc!);
const denied = { allowed: false, reasonCode: "export_declaration_missing" };

afterEach(() => { vi.restoreAllMocks(); });

describe("OVD-723 quote task export gate order", () => {
  it("holds a lane whose adapter is not enabled instead of making it manual vendor follow-up", async () => {
    const live = { workerMode: "live", workerName: "worker", workerLiveAdapters: [], workerTempDir: "/tmp" } as unknown as WorkerConfig;
    const db = database({ exportChecks: [denied] });

    await handleVendorQuoteTask(db.client, task, live);

    const updates = resultUpdates(db.writes);
    expect(updates.map((update) => update.status)).toEqual(["running", "failed"]);
    expect(updates.at(-1)).toMatchObject({
      notes: [EXPORT_CONTROL_HOLD_NOTE],
      raw_payload: expect.objectContaining({ exportControlHold: true, requiresManualVendorFollowUp: false }),
    });
    expect(JSON.stringify(db.writes)).not.toContain("manual_vendor_followup");
    expect(rpcNames(db.writes)).not.toContain("api_reserve_spend");
  });

  it("still routes a cleared lane with no enabled adapter to manual follow-up", async () => {
    const live = { workerMode: "live", workerName: "worker", workerLiveAdapters: [], workerTempDir: "/tmp" } as unknown as WorkerConfig;
    const db = database({ exportChecks: [{ allowed: true }] });

    await handleVendorQuoteTask(db.client, task, live);

    expect(resultUpdates(db.writes).at(-1)?.status).toBe("manual_vendor_followup");
    // The gate answered before the manual route.
    const names = rpcNames(db.writes);
    expect(names.indexOf("api_check_export_control_dispatch")).toBeGreaterThan(-1);
  });

  it("holds a lane before the spend cap can make it manual vendor follow-up", async () => {
    const simulate = { workerMode: "simulate", workerName: "worker", workerLiveAdapters: [], workerTempDir: "/tmp" } as unknown as WorkerConfig;
    const db = database({ exportChecks: [denied], spendAllowed: false });

    await handleVendorQuoteTask(db.client, { ...task, attempts: 99 }, simulate);

    const updates = resultUpdates(db.writes);
    expect(updates.at(-1)).toMatchObject({ status: "failed", raw_payload: expect.objectContaining({ exportControlHold: true }) });
    expect(JSON.stringify(db.writes)).not.toContain("manual_vendor_followup");
    expect(rpcNames(db.writes)).not.toContain("api_reserve_spend");
  });

  it("asks again after the preflight authorizes and stops before adapter.quote", async () => {
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const simulate = { workerMode: "simulate", workerName: "worker", workerLiveAdapters: [], workerTempDir: "/tmp" } as unknown as WorkerConfig;
    // Allowed before the manual routes and before the preflight; denied at the send.
    const db = database({ exportChecks: [{ allowed: true }, { allowed: true }, { allowed: false, reasonCode: "export_review_pending" }] });

    await handleVendorQuoteTask(db.client, task, simulate);

    expect(quote).not.toHaveBeenCalled();
    expect(rpcNames(db.writes).filter((name) => name === "api_check_export_control_dispatch")).toHaveLength(3);
    expect(resultUpdates(db.writes).at(-1)).toMatchObject({
      status: "failed",
      raw_payload: expect.objectContaining({ exportControlHold: true, exportControlReasonCode: "export_review_pending" }),
    });
  });
});
