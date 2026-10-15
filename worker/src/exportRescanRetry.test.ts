// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processClaimedTask } from "./index";
import { createWorkerRuntimeState } from "./httpServer";
import { isRetryableExportRescanError, ExportMarkingRescanTaskInvalidError } from "./vendorTaskRetry";
import { ExportControlLookupError } from "./exportControl";
import type { QueueTaskRecord, WorkerConfig } from "./types";

const config = { workerMode: "simulate", workerName: "worker", workerLiveAdapters: [], xometryUserDataDir: null,
  xometryProfileSnapshotBucket: null, workerTempDir: "/tmp/owned-fake-stage" } as unknown as WorkerConfig;

function rescanTask(attempts: number, payload: Record<string, unknown> = { jobFileId: "file-1" }): QueueTaskRecord {
  return { id: "task-1", organization_id: "org", quote_run_id: null, part_id: "part", job_id: "job",
    task_type: "export_marking_rescan", attempts, locked_at: "2026-10-12T00:00:00Z", payload } as unknown as QueueTaskRecord;
}

/** A database whose job_files read fails like a transient Storage or PostgREST error. */
function database() {
  const queueUpdates: Record<string, unknown>[] = [];
  const builder = (table: string) => {
    let update: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    for (const name of ["select", "eq", "neq", "in", "is", "order", "limit"]) chain[name] = () => chain;
    chain.update = (values: Record<string, unknown>) => {
      update = values;
      if (table === "work_queue") queueUpdates.push(values);
      return chain;
    };
    chain.maybeSingle = async () =>
      table === "job_files" ? { data: null, error: new Error("fetch failed: ECONNRESET") } : { data: null, error: null };
    chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: update ? [] : null, error: null });
    return chain;
  };
  return { client: { from: builder, rpc: async () => ({ data: null, error: null }) } as unknown as SupabaseClient, queueUpdates };
}

describe("OVD-723 review round 4: rescan recovery", () => {
  it("requeues a rescan that failed on a transient error", async () => {
    const db = database();
    await processClaimedTask(db.client, rescanTask(1), config, createWorkerRuntimeState());
    expect(db.queueUpdates.at(-1)).toMatchObject({ status: "queued", available_at: expect.any(String) });
  });

  it("stops retrying once the finite schedule is spent", async () => {
    const db = database();
    await processClaimedTask(db.client, rescanTask(4), config, createWorkerRuntimeState());
    expect(db.queueUpdates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("never retries a rescan row that names no file", async () => {
    const db = database();
    await processClaimedTask(db.client, rescanTask(1, {}), config, createWorkerRuntimeState());
    expect(db.queueUpdates.at(-1)).toMatchObject({ status: "failed" });
    expect(isRetryableExportRescanError(new ExportMarkingRescanTaskInvalidError())).toBe(false);
    expect(isRetryableExportRescanError(new ExportControlLookupError("extraction"))).toBe(true);
  });
});
