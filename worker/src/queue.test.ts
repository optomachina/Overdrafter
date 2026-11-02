// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  claimNextTask,
  markTaskCancelled,
  markTaskCompleted,
  markTaskFailed,
  markTaskQueuedForRetry,
  reapStaleTasks,
  reconcileTerminalFreeQuoteTasks,
} from "./queue";

const emptyReconciliation = { scanned: 0, reconciled: 0, indeterminate: 0, deferred: 0, nextCursor: null };
function reconciliationRpc(data = emptyReconciliation) {
  return vi.fn(() => ({ abortSignal: vi.fn().mockResolvedValue({ data, error: null }) }));
}

describe("claimNextTask", () => {
  function makeTask() {
    return {
      id: "task-abc",
      organization_id: "org-1",
      job_id: "job-1",
      part_id: "part-1",
      quote_run_id: null,
      package_id: null,
      task_type: "extract_part",
      status: "running",
      payload: {},
      attempts: 1,
      attempt_id: "97900000-0000-4000-8000-000000000001",
      available_at: new Date().toISOString(),
      locked_at: new Date().toISOString(),
      locked_by: "worker-1",
      last_error: null,
    };
  }

  it("calls rpc with the correct arguments and returns the claimed task", async () => {
    const task = makeTask();
    const maybeSingle = vi.fn().mockResolvedValue({ data: task, error: null });
    const rpc = vi.fn(() => ({ maybeSingle }));
    const client = { rpc } as never;

    const result = await claimNextTask(client, "worker-1");

    expect(rpc).toHaveBeenCalledWith("api_claim_next_task", { p_worker_name: "worker-1" });
    expect(maybeSingle).toHaveBeenCalled();
    expect(result).toEqual(task);
  });

  it("returns null when no task is available", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const rpc = vi.fn(() => ({ maybeSingle }));
    const client = { rpc } as never;

    const result = await claimNextTask(client, "worker-1");

    expect(result).toBeNull();
  });

  it("throws when the rpc returns an error", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: new Error("db error") });
    const rpc = vi.fn(() => ({ maybeSingle }));
    const client = { rpc } as never;

    await expect(claimNextTask(client, "worker-1")).rejects.toThrow("db error");
  });
});

function createSupabaseUpdateStub() {
  const neq = vi.fn().mockResolvedValue({ error: null });
  const eq = vi.fn(() => ({ neq }));
  const update = vi.fn(() => ({ eq }));

  return {
    client: {
      from: vi.fn(() => ({
        update,
      })),
    },
    update,
    eq,
    neq,
  };
}

function makeQueuedTask(payload: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    organization_id: "org-1",
    job_id: "job-1",
    part_id: "part-1",
    quote_run_id: null,
    package_id: null,
    task_type: "run_vendor_quote",
    status: "running",
    payload: { vendor: "xometry", requestedQuantity: 25, ...payload },
    attempts: 1,
    attempt_id: "97900000-0000-4000-8000-000000000001",
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: "worker-1",
    last_error: null,
  } as never;
}

describe("queue cancellation guards", () => {
  it("does not remark a cancelled task as completed", async () => {
    const stub = createSupabaseUpdateStub();

    await markTaskCompleted(stub.client as never, makeQueuedTask(), { done: true });

    expect(stub.client.from).toHaveBeenCalledWith("work_queue");
    expect(stub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        // The patch merges over the original inputs rather than replacing them.
        payload: { vendor: "xometry", requestedQuantity: 25, done: true },
      }),
    );
    expect(stub.eq).toHaveBeenCalledWith("id", "task-1");
    expect(stub.neq).toHaveBeenCalledWith("status", "cancelled");
  });

  it("does not remark a cancelled task as failed", async () => {
    const stub = createSupabaseUpdateStub();

    await markTaskFailed(stub.client as never, makeQueuedTask(), "boom", { failed: true });

    expect(stub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        payload: { vendor: "xometry", requestedQuantity: 25, failed: true },
        last_error: "boom",
      }),
    );
    expect(stub.neq).toHaveBeenCalledWith("status", "cancelled");
  });

  it("lets a patch override an existing payload key", async () => {
    const stub = createSupabaseUpdateStub();

    await markTaskCompleted(stub.client as never, makeQueuedTask({ vendorStatus: "pending" }), {
      vendorStatus: "instant_quote_received",
    });

    expect(stub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ vendorStatus: "instant_quote_received" }),
      }),
    );
  });

  it("marks cancelled tasks explicitly (no neq guard)", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq }));
    const client = {
      from: vi.fn(() => ({
        update,
      })),
    };

    await markTaskCancelled(client as never, makeQueuedTask(), "Canceled by client request.", {
      ignoredDueToCanceledRequest: true,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        payload: {
          vendor: "xometry",
          requestedQuantity: 25,
          ignoredDueToCanceledRequest: true,
        },
        last_error: "Canceled by client request.",
      }),
    );
    expect(eq).toHaveBeenCalledWith("id", "task-1");
  });
});

describe("reapStaleTasks", () => {
  function createReaperStub(returnedRows: { id: string }[] = []) {
    const select = vi.fn().mockResolvedValue({ data: returnedRows, error: null });
    const lt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ lt }));
    const update = vi.fn(() => ({ eq }));

    return {
      client: {
        from: vi.fn(() => ({ update })),
        rpc: reconciliationRpc(),
      },
      update,
      eq,
      lt,
      select,
    };
  }

  it("marks stale running tasks as failed with worker_crash_recovery reason", async () => {
    const stub = createReaperStub([{ id: "task-stale-1" }]);

    const reaped = await reapStaleTasks(stub.client as never, 10);

    expect(stub.client.from).toHaveBeenCalledWith("work_queue");
    expect(stub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        locked_at: null,
        locked_by: null,
        last_error: "worker_crash_recovery",
      }),
    );
    expect(stub.eq).toHaveBeenCalledWith("status", "running");
    expect(stub.lt).toHaveBeenCalledWith("locked_at", expect.any(String));
    expect(reaped).toBe(1);
    expect(stub.client.rpc).toHaveBeenCalledWith("api_reconcile_terminal_free_quote_tasks", { p_after_admission_id: null, p_limit: 100 });
    expect(stub.select.mock.invocationCallOrder[0]).toBeLessThan(stub.client.rpc.mock.invocationCallOrder[1]);
  });

  it("returns 0 when no stale tasks exist", async () => {
    const stub = createReaperStub([]);

    const reaped = await reapStaleTasks(stub.client as never, 10);

    expect(reaped).toBe(0);
    expect(stub.client.rpc).toHaveBeenCalledTimes(2);
    expect(stub.client.rpc).toHaveBeenCalledWith("drain_quote_run_rollup_followups", { p_limit: 50 });
  });

  it("returns 0 when data is null", async () => {
    const select = vi.fn().mockResolvedValue({ data: null, error: null });
    const lt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ lt }));
    const update = vi.fn(() => ({ eq }));
    const client = { from: vi.fn(() => ({ update })), rpc: reconciliationRpc() };

    const reaped = await reapStaleTasks(client as never, 10);

    expect(reaped).toBe(0);
  });

  it("throws when the database update fails", async () => {
    const select = vi.fn().mockResolvedValue({ data: null, error: new Error("db error") });
    const lt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ lt }));
    const update = vi.fn(() => ({ eq }));
    const client = { from: vi.fn(() => ({ update })) };

    await expect(reapStaleTasks(client as never, 10)).rejects.toThrow("db error");
  });
});

describe("terminal free quote reconciliation", () => {
  it("uses a bounded cursor across passes and wraps at the end", async () => {
    const cursor = "00000000-0000-4000-8000-000000000001";
    const abortSignal = vi.fn().mockResolvedValueOnce({ data: { ...emptyReconciliation, scanned: 100, nextCursor: cursor }, error: null })
      .mockResolvedValue({ data: emptyReconciliation, error: null });
    const client = { rpc: vi.fn(() => ({ abortSignal })) };
    for (let pass = 0; pass < 3; pass += 1) await reconcileTerminalFreeQuoteTasks(client as never);
    expect(client.rpc.mock.calls.map((call) => call[1].p_after_admission_id)).toEqual([null, cursor, null]);
    expect(abortSignal.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
  });

  it("retains the old page after an RPC failure so a later pass retries it", async () => {
    const abortSignal = vi.fn().mockResolvedValueOnce({ data: null, error: new Error("unavailable") })
      .mockResolvedValue({ data: emptyReconciliation, error: null });
    const client = { rpc: vi.fn(() => ({ abortSignal })) };
    await expect(reconcileTerminalFreeQuoteTasks(client as never)).rejects.toThrow("unavailable");
    await reconcileTerminalFreeQuoteTasks(client as never);
    expect(client.rpc.mock.calls.map((call) => call[1].p_after_admission_id)).toEqual([null, null]);
  });

  it("reports indeterminate identities and still advances the next bounded scan", async () => {
    const cursor = "00000000-0000-4000-8000-000000000002";
    const abortSignal = vi.fn().mockResolvedValueOnce({ data: { ...emptyReconciliation, scanned: 100, indeterminate: 1, nextCursor: cursor }, error: null })
      .mockResolvedValue({ data: emptyReconciliation, error: null });
    const client = { rpc: vi.fn(() => ({ abortSignal })) };
    await expect(reconcileTerminalFreeQuoteTasks(client as never)).rejects.toThrow("free_quote_lifecycle_indeterminate");
    await reconcileTerminalFreeQuoteTasks(client as never);
    expect(client.rpc.mock.calls[1][1].p_after_admission_id).toBe(cursor);
  });

  it.each([null, {}, { ...emptyReconciliation, scanned: -1 }, { ...emptyReconciliation, reconciled: 1 }, { ...emptyReconciliation, nextCursor: "bad" }])(
    "rejects malformed reconciliation output without claiming success: %j", async (data) => {
      const client = { rpc: vi.fn(() => ({ abortSignal: vi.fn().mockResolvedValue({ data, error: null }) })) };
      await expect(reconcileTerminalFreeQuoteTasks(client as never)).rejects.toThrow("free_quote_reconciliation_response_invalid");
    },
  );
});

describe("markTaskQueuedForRetry", () => {
  function requeueStub(rows: { id: string }[]) {
    const filters: [string, string, unknown][] = [];
    const select = vi.fn().mockResolvedValue({ data: rows, error: null });
    const query = {
      eq: vi.fn((column: string, value: unknown) => { filters.push(["eq", column, value]); return query; }),
      is: vi.fn((column: string, value: unknown) => { filters.push(["is", column, value]); return query; }),
      select,
    };
    const update = vi.fn(() => query);
    return { client: { from: vi.fn(() => ({ update })) }, update, filters };
  }

  it("requeues only while the row is still running under this worker's lock", async () => {
    const stub = requeueStub([{ id: "task-1" }]);

    const requeued = await markTaskQueuedForRetry(stub.client as never, makeQueuedTask(), "boom", "2026-10-12T00:00:00Z");

    expect(requeued).toBe(true);
    expect(stub.update).toHaveBeenCalledWith(expect.objectContaining({ status: "queued", locked_by: null, attempt_id: null }));
    expect(stub.filters).toEqual([
      ["eq", "id", "task-1"],
      ["eq", "status", "running"],
      ["eq", "attempts", 1],
      ["eq", "locked_by", "worker-1"],
    ]);
  });

  it("an old handler cannot requeue a newer claim of the same task under the same worker", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The row as stored: reaped, then claimed again by the same worker name, so
    // status and locked_by match the old claim but attempts has moved on.
    const row: Record<string, unknown> = { id: "task-1", status: "running", locked_by: "worker-1", attempts: 2 };
    const filters: [string, unknown][] = [];
    let patch: Record<string, unknown> = {};
    const query = {
      eq: vi.fn((column: string, value: unknown) => { filters.push([column, value]); return query; }),
      is: vi.fn((column: string, value: unknown) => { filters.push([column, value]); return query; }),
      select: vi.fn(async () => {
        if (!filters.every(([column, value]) => row[column] === value)) return { data: [], error: null };
        Object.assign(row, patch);
        return { data: [{ id: row.id }], error: null };
      }),
    };
    const client = { from: vi.fn(() => ({ update: vi.fn((next: Record<string, unknown>) => { patch = next; return query; }) })) };

    const requeued = await markTaskQueuedForRetry(client as never, makeQueuedTask(), "boom", "2026-10-12T00:00:00Z");

    expect(requeued).toBe(false);
    expect(row).toMatchObject({ status: "running", locked_by: "worker-1", attempts: 2 });
    warn.mockRestore();
  });

  it("zero matched rows (already cancelled or settled elsewhere) logs and does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stub = requeueStub([]);

    await expect(
      markTaskQueuedForRetry(stub.client as never, makeQueuedTask(), "boom", "2026-10-12T00:00:00Z"),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("worker.task.requeue_skipped"));
    warn.mockRestore();
  });
});
