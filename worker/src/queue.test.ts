// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  claimNextTask,
  markTaskCancelled,
  markTaskCompleted,
  markTaskFailed,
  reapStaleTasks,
} from "./queue";

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

describe("queue cancellation guards", () => {
  it("does not remark a cancelled task as completed", async () => {
    const stub = createSupabaseUpdateStub();

    await markTaskCompleted(stub.client as never, "task-1", { done: true });

    expect(stub.client.from).toHaveBeenCalledWith("work_queue");
    expect(stub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        payload: { done: true },
      }),
    );
    expect(stub.eq).toHaveBeenCalledWith("id", "task-1");
    expect(stub.neq).toHaveBeenCalledWith("status", "cancelled");
  });

  it("does not remark a cancelled task as failed", async () => {
    const stub = createSupabaseUpdateStub();

    await markTaskFailed(stub.client as never, "task-1", "boom", { failed: true });

    expect(stub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        payload: { failed: true },
        last_error: "boom",
      }),
    );
    expect(stub.neq).toHaveBeenCalledWith("status", "cancelled");
  });

  it("marks cancelled tasks explicitly (no neq guard)", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq }));
    const client = {
      from: vi.fn(() => ({
        update,
      })),
    };

    await markTaskCancelled(client as never, "task-1", "Canceled by client request.", {
      ignoredDueToCanceledRequest: true,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        payload: { ignoredDueToCanceledRequest: true },
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
  });

  it("returns 0 when no stale tasks exist", async () => {
    const stub = createReaperStub([]);

    const reaped = await reapStaleTasks(stub.client as never, 10);

    expect(reaped).toBe(0);
  });

  it("returns 0 when data is null", async () => {
    const select = vi.fn().mockResolvedValue({ data: null, error: null });
    const lt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ lt }));
    const update = vi.fn(() => ({ eq }));
    const client = { from: vi.fn(() => ({ update })) };

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
