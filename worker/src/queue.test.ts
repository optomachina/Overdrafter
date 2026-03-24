// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { markTaskCancelled, markTaskCompleted, markTaskFailed } from "./queue";

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

  it("marks cancelled tasks explicitly", async () => {
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
