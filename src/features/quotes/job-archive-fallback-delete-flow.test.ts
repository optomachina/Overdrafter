import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVED_DELETE_STORAGE_CLEANUP_FAILED_MESSAGE,
  ArchivedDeleteFlowError,
  executeArchivedDelete,
  type ArchivedDeletePlan,
} from "../../../supabase/functions/job-archive-fallback/delete-flow";

function createDeletePlan(overrides: Partial<ArchivedDeletePlan> = {}): ArchivedDeletePlan {
  return {
    job: {
      id: "job-123",
    },
    orphanBlobIds: [],
    storageCandidates: [
      {
        bucket: "job-files",
        path: "org/job-123/part.step",
      },
    ],
    ...overrides,
  };
}

describe("job archive delete flow", () => {
  it("runs storage cleanup before committing the archived delete", async () => {
    const order: string[] = [];
    const removeStorageCandidates = vi.fn(async () => {
      order.push("storage");
      return true;
    });
    const commitDelete = vi.fn(async () => {
      order.push("commit");
    });

    await expect(
      executeArchivedDelete({
        deletePlan: createDeletePlan(),
        hasStorageServiceRoleKey: true,
        missingServiceRoleMessage: "Missing service role key.",
        removeStorageCandidates,
        commitDelete,
      }),
    ).resolves.toBe("job-123");

    expect(order).toEqual(["storage", "commit"]);
  });

  it("fails closed when storage cleanup fails and never commits the archived delete", async () => {
    const removeStorageCandidates = vi.fn(async () => false);
    const commitDelete = vi.fn();

    await expect(
      executeArchivedDelete({
        deletePlan: createDeletePlan(),
        hasStorageServiceRoleKey: true,
        missingServiceRoleMessage: "Missing service role key.",
        removeStorageCandidates,
        commitDelete,
      }),
    ).rejects.toMatchObject({
      message: ARCHIVED_DELETE_STORAGE_CLEANUP_FAILED_MESSAGE,
      status: 500,
    });

    expect(removeStorageCandidates).toHaveBeenCalledOnce();
    expect(commitDelete).not.toHaveBeenCalled();
  });

  it("fails before mutation when storage cleanup is required but the service role key is missing", async () => {
    const removeStorageCandidates = vi.fn();
    const commitDelete = vi.fn();

    await expect(
      executeArchivedDelete({
        deletePlan: createDeletePlan(),
        hasStorageServiceRoleKey: false,
        missingServiceRoleMessage: "Archived part deletion requires SUPABASE_SERVICE_ROLE_KEY for storage cleanup.",
        removeStorageCandidates,
        commitDelete,
      }),
    ).rejects.toMatchObject({
      message: "Archived part deletion requires SUPABASE_SERVICE_ROLE_KEY for storage cleanup.",
      status: 500,
    });

    expect(removeStorageCandidates).not.toHaveBeenCalled();
    expect(commitDelete).not.toHaveBeenCalled();
  });

  it("skips storage cleanup when there are no storage candidates and still commits the delete", async () => {
    const removeStorageCandidates = vi.fn();
    const commitDelete = vi.fn(async () => undefined);

    await expect(
      executeArchivedDelete({
        deletePlan: createDeletePlan({ storageCandidates: [] }),
        hasStorageServiceRoleKey: false,
        missingServiceRoleMessage: "Missing service role key.",
        removeStorageCandidates,
        commitDelete,
      }),
    ).resolves.toBe("job-123");

    expect(removeStorageCandidates).not.toHaveBeenCalled();
    expect(commitDelete).toHaveBeenCalledOnce();
  });

  it("throws the flow-specific error type for fail-closed cleanup handling", async () => {
    const removeStorageCandidates = vi.fn(async () => false);

    try {
      await executeArchivedDelete({
        deletePlan: createDeletePlan(),
        hasStorageServiceRoleKey: true,
        missingServiceRoleMessage: "Missing service role key.",
        removeStorageCandidates,
        commitDelete: vi.fn(),
      });
      throw new Error("Expected archived delete flow to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchivedDeleteFlowError);
    }
  });
});
