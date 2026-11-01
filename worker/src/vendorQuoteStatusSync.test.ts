// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAdapterRegistry } from "./adapters/index";
import { createRunDir } from "./files";
import { createWorkerRuntimeState } from "./httpServer";
import { processClaimedTask, syncRunStatus, syncSweptQuoteRuns } from "./index";
import { markProviderMutationStarted } from "./providerMutationPhase";
import { VendorAutomationError, type QueueTaskRecord, type VendorQuoteAdapterOutput, type WorkerConfig } from "./types";

vi.mock("./adapters/index.js", () => ({ buildAdapterRegistry: vi.fn() }));
vi.mock("./files.js", async (original) => ({
  ...await original<typeof import("./files.js")>(),
  createRunDir: vi.fn(async () => "/tmp/ovd-1134-mocked-stage"),
  stageStorageObject: vi.fn(async (_db, file) => file ? ({ originalName: file.original_name,
    localPath: "/tmp/ovd-1134-mocked-part.stl", trustedContentSha256: "a".repeat(64) }) : null),
  cleanupPaths: vi.fn(async () => undefined),
}));
vi.mock("./scoringIntegration.js", () => ({ computeAndStoreRoutingScores: vi.fn(async () => undefined) }));

const config = { workerMode: "simulate", workerName: "worker", workerLiveAdapters: ["xometry"] } as WorkerConfig;
const output: VendorQuoteAdapterOutput = { status: "instant_quote_received", unitPriceUsd: 10,
  totalPriceUsd: 20, leadTimeBusinessDays: 5, quoteUrl: null, dfmIssues: [], notes: [], rawPayload: {}, artifacts: [] };
const quote = vi.fn(async () => {
  markProviderMutationStarted();
  return output;
});
type Row = Record<string, unknown>;

/** Stateful Supabase mock: writes honor every filter and errors do not commit. */
function database(failTable = "", failures = 0, failStatus?: string, drainFailures = 0, lostAcceptanceReplies = 0) {
  const rows: Record<string, Row[]> = {
    work_queue: [{ id: "task", task_type: "run_vendor_quote", organization_id: "org", job_id: "job",
      part_id: "part", quote_run_id: "run", status: "running", attempts: 1, locked_by: "worker",
      locked_at: "2026-10-30T00:00:00Z", payload: { vendor: "xometry", vendorQuoteResultId: "result",
        requestedQuantity: 2, quoteRequestId: "request" } }],
    quote_requests: [{ id: "request", status: "requesting" }],
    quote_runs: [{ id: "run", status: "running" }],
    jobs: [{ id: "job", organization_id: "org", status: "quoting" }],
    vendor_quote_results: [{ id: "result", quote_run_id: "run", part_id: "part", vendor: "xometry",
      requested_quantity: 2, status: "queued" }],
    parts: [{ id: "part", job_id: "job", cad_file_id: "cad", drawing_file_id: null }],
    job_files: [{ id: "cad", original_name: "part.stl" }],
    approved_part_requirements: [{ id: "req", part_id: "part", updated_at: "2026-10-30T00:00:00Z", spec_snapshot: {} }],
    audit_events: [],
  };
  const writes: { table: string; patch: Row }[] = [];
  let beforeUpdate: ((table: string) => void) | undefined;
  const from = (table: string) => {
    let patch: Row | undefined;
    let insert: Row | undefined;
    let single = false;
    const filters: ((row: Row) => boolean)[] = [];
    const response = () => {
      if (patch) {
        writes.push({ table, patch: structuredClone(patch) });
        if (table === failTable && (!failStatus || patch.status === failStatus) && failures-- > 0) {
          return { data: null, error: { message: `${table} write refused` } };
        }
        beforeUpdate?.(table);
      }
      if (insert) rows[table].push(insert);
      const matched = rows[table].filter((row) => filters.every((test) => test(row)));
      if (patch) matched.forEach((row) => Object.assign(row, patch));
      return { data: structuredClone(single ? matched[0] ?? null : matched), error: null };
    };
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
      neq: (column: string, value: unknown) => { filters.push((row) => row[column] !== value); return query; },
      is: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
      in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return query; },
      update: (value: Row) => { patch = value; return query; },
      insert: (value: Row) => { insert = value; return query; },
      single: async () => { single = true; return response(); },
      maybeSingle: async () => { single = true; return response(); },
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(response()).then(resolve, reject),
    };
    return query;
  };
  const rpc = vi.fn((name: string, args: Row) => {
    if (name === "reconcile_vendor_quote_offers") Object.assign(rows.vendor_quote_results[0], args.p_result);
    // The claim-fenced acceptance settles the result and the task in one transaction.
    if (name === "accept_vendor_quote_result") {
      Object.assign(rows.vendor_quote_results[0], args.p_result);
      Object.assign(rows.work_queue[0], { status: "completed", locked_by: null, locked_at: null,
        payload: { ...(rows.work_queue[0].payload as Row), ...(args.p_task_payload_patch as Row) } });
    }
    if (name === "accept_vendor_quote_result" && lostAcceptanceReplies-- > 0) {
      const lost = Promise.reject(new TypeError("fetch failed"));
      lost.catch(() => undefined);
      return Object.assign(lost, { abortSignal: () => lost });
    }
    if (name === "drain_quote_run_rollup_followups" && drainFailures-- > 0) {
      const failed = Promise.resolve({ data: null, error: { message: "drain refused" } });
      return Object.assign(failed, { abortSignal: () => failed });
    }
    const data = name === "accept_vendor_quote_result" ? { outcome: "accepted" }
      : name === "api_reserve_spend" ? { allowed: true, reservationId: "reservation" }
      : name === "api_check_export_control_dispatch" ? { allowed: true }
        : name === "api_get_worker_sourcing_intent" ? { activeDeadline: null, destination: { state: "confirmed",
          confirmationRevision: "1", street: "street", city: "city", region: "AZ", postalCode: "00000", country: "US" } }
          : null;
    const result = Promise.resolve({ data, error: null });
    return Object.assign(result, { abortSignal: () => result });
  });
  return {
    client: { from, rpc } as unknown as SupabaseClient, rows, writes, rpc,
    queue: rows.work_queue[0], result: rows.vendor_quote_results[0], run: rows.quote_runs[0], job: rows.jobs[0],
    claim: (attempts: number) => {
      Object.assign(rows.work_queue[0], { status: "running", attempts, locked_by: "worker" });
      return structuredClone(rows.work_queue[0]) as QueueTaskRecord;
    },
    race: (hook: (table: string) => void) => { beforeUpdate = hook; },
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.mocked(buildAdapterRegistry).mockReturnValue({ xometry: { vendor: "xometry", quote } });
  quote.mockImplementation(async () => { markProviderMutationStarted(); return output; });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("vendor quote status persistence (OVD-1134)", () => {
  it("settles a fresh provider result through the claim-fenced acceptance, not worker status writes", async () => {
    const db = database();
    await processClaimedTask(db.client, db.claim(1), config, createWorkerRuntimeState());
    expect(db.queue.status).toBe("completed");
    expect(db.result.status).toBe("instant_quote_received");
    expect(db.rpc.mock.calls.filter(([name]) => name === "accept_vendor_quote_result")).toHaveLength(1);
    expect(db.rpc.mock.calls.filter(([name]) => name === "drain_quote_run_rollup_followups")).toHaveLength(1);
    expect(db.writes.some((write) => write.table === "quote_runs" || write.table === "jobs")).toBe(false);
    expect(db.writes.some((write) => write.table === "work_queue")).toBe(false);
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("keeps an accepted task completed when the rollup drain fails, without another provider call", async () => {
    const db = database("", 0, undefined, 1);
    await processClaimedTask(db.client, db.claim(1), config, createWorkerRuntimeState());
    expect(db.queue.status).toBe("completed");
    expect(db.result.status).toBe("instant_quote_received");
    expect(db.writes.some((write) => write.table === "work_queue")).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"source":"worker.quote_run_rollups"'));
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("keeps a task completed when the acceptance committed but every reply was lost", async () => {
    const db = database("", 0, undefined, 0, Infinity);
    await processClaimedTask(db.client, db.claim(1), config, createWorkerRuntimeState());
    expect(db.rpc.mock.calls.filter(([name]) => name === "accept_vendor_quote_result")).toHaveLength(3);
    expect(db.result.status).toBe("instant_quote_received");
    expect(db.queue.status).toBe("completed");
    expect(db.queue.last_error).toBeUndefined();
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it.each(["quote_runs", "jobs"])("retries one failed %s write from a stored result without provider work", async (table) => {
    const db = database(table, 1);
    db.result.status = "instant_quote_received";
    const runtime = createWorkerRuntimeState();
    await processClaimedTask(db.client, db.claim(1), config, runtime);
    expect(db.queue.status).toBe("queued");
    expect(db.result.status).toBe("instant_quote_received");
    expect(db.queue.payload).toMatchObject({ failureCode: "quote_bookkeeping_failed" });
    expect(db.writes.some((write) => write.table === "work_queue" && write.patch.status === "completed")).toBe(false);
    // Bookkeeping recovery must work even if the original part context is gone.
    db.rows.parts = [];
    await processClaimedTask(db.client, db.claim(2), config, runtime);
    expect(db.queue.status).toBe("completed");
    expect(db.run.status).toBe("completed");
    expect(db.job.status).toBe("internal_review");
    expect(quote).not.toHaveBeenCalled();
    expect(createRunDir).not.toHaveBeenCalled();
  });

  it("exhausts the existing backoff and leaves a visible failed task when status writes keep failing", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-30T00:00:00Z");
    vi.setSystemTime(now);
    const db = database("quote_runs", Infinity);
    db.result.status = "instant_quote_received";
    const runtime = createWorkerRuntimeState();
    for (const [attempts, delay] of [[1, 60_000], [2, 300_000], [3, 900_000], [4, null]] as const) {
      await processClaimedTask(db.client, db.claim(attempts), config, runtime);
      expect(db.queue.status).toBe(delay === null ? "failed" : "queued");
      if (delay !== null) expect(db.queue.available_at).toBe(new Date(now.getTime() + delay).toISOString());
    }
    expect(db.queue.last_error).toContain("quote_runs write refused");
    expect(db.run.status).toBe("running");
    expect(db.job.status).toBe("quoting");
    expect(quote).not.toHaveBeenCalled();
    expect(db.writes.some((write) => write.table === "work_queue" && write.patch.status === "completed")).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"source":"worker.task.failure"'));
    const failure = JSON.parse(vi.mocked(console.error).mock.calls.at(-1)![0]);
    expect(failure.context).toMatchObject({ jobId: "job", quoteRunId: "run", retryCount: 3, nextRetryAt: null });
    vi.useRealTimers();
  });

  it("makes duplicate sync a no-op and does not regress after a stale result snapshot", async () => {
    const db = database();
    db.result.status = "instant_quote_received";
    await syncRunStatus(db.client, "job", "run");
    const writes = db.writes.length;
    const audits = db.rows.audit_events.length;
    await syncRunStatus(db.client, "job", "run");
    expect(db.writes).toHaveLength(writes);
    expect(db.rows.audit_events).toHaveLength(audits);
    db.result.status = "running";
    await syncRunStatus(db.client, "job", "run");
    expect(db.run.status).toBe("completed");
    expect(db.job.status).toBe("internal_review");
    expect(db.writes).toHaveLength(writes);
  });

  it("guards against a concurrent publication between the read and the update", async () => {
    const db = database();
    db.result.status = "instant_quote_received";
    db.race((table) => {
      if (table === "quote_runs") db.run.status = "published";
      if (table === "jobs") db.job.status = "published";
    });
    await syncRunStatus(db.client, "job", "run");
    expect(db.run.status).toBe("published");
    expect(db.job.status).toBe("published");
    expect(db.rows.audit_events).toHaveLength(0);
  });

  it.each(["failed", "published"])("never moves a %s run or later job backwards", async (status) => {
    const db = database();
    db.result.status = "instant_quote_received";
    db.run.status = status;
    db.job.status = "client_selected";
    await syncRunStatus(db.client, "job", "run");
    expect(db.run.status).toBe(status);
    expect(db.job.status).toBe("client_selected");
    expect(db.writes).toEqual([]);
  });

  it.each(["running", "manual_vendor_followup", "failed"])("does not complete after a failed result write to %s", async (status) => {
    const db = database("vendor_quote_results", Infinity, status);
    if (status === "manual_vendor_followup") vi.mocked(buildAdapterRegistry).mockReturnValue({});
    if (status === "failed") quote.mockRejectedValue(new VendorAutomationError("selector missing", "selector_failure"));
    await processClaimedTask(db.client, db.claim(1), config, createWorkerRuntimeState());
    expect(db.queue.status).toBe("queued");
    expect(db.queue.last_error).toContain("vendor_quote_results write refused");
    expect(db.writes.some((write) => write.table === "work_queue" && write.patch.status === "completed")).toBe(false);
    expect(quote).toHaveBeenCalledTimes(status === "failed" ? 1 : 0);
  });

  it.each(["manual_review_pending", "manual_vendor_followup", "failed", "stale"])("recovers a stored %s outcome without provider work", async (status) => {
    const db = database();
    db.result.status = status;
    await processClaimedTask(db.client, db.claim(2), config, createWorkerRuntimeState());
    expect(quote).not.toHaveBeenCalled();
    expect(createRunDir).not.toHaveBeenCalled();
    expect(db.queue.status).toBe(status === "failed" ? "failed" : "completed");
    expect(db.writes.some((write) => write.table === "vendor_quote_results")).toBe(false);
  });
  it("cancels a spend-capped task with exhausted retries even when the result write fails", async () => {
    const db = database("vendor_quote_results", Infinity, "manual_vendor_followup");
    const base = db.rpc.getMockImplementation()!;
    db.rpc.mockImplementation((name: string, args: Row) => {
      if (name !== "api_reserve_spend") return base(name, args);
      const result = Promise.resolve({ data: { allowed: false, reasonCode: "daily_cap" }, error: null });
      return Object.assign(result, { abortSignal: () => result });
    });
    await processClaimedTask(db.client, db.claim(4), config, createWorkerRuntimeState());
    expect(db.queue.status).toBe("cancelled");
    expect(db.result.status).toBe("running");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("vendor_quote_results write refused"));
    expect(db.queue.last_error).toContain("Spend cap reached");
  });

  it("keeps syncing the remaining swept runs when one sync fails", async () => {
    const db = database("quote_runs", 1);
    db.rows.quote_runs.push({ id: "run2", status: "running" });
    db.rows.vendor_quote_results.push({ id: "result2", quote_run_id: "run2", status: "failed" });
    db.result.status = "instant_quote_received";
    const runtime = createWorkerRuntimeState();
    await syncSweptQuoteRuns(db.client, [{ jobId: "job", quoteRunId: "run" }, { jobId: "job", quoteRunId: "run2" }], runtime);
    expect(db.run.status).toBe("running");
    expect(db.rows.quote_runs[1].status).toBe("failed");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"source":"worker.kill_switch"'));
  });
});
