import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastError, toastSuccess, deleteArchivedJobs, logArchivedDeleteFailure } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  deleteArchivedJobs: vi.fn(),
  logArchivedDeleteFailure: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("@/features/quotes/api/archive-api", () => ({
  deleteArchivedJobs,
  isArchivedDeleteCapabilityError: () => false,
}));
vi.mock("@/features/quotes/archive-delete-errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/quotes/archive-delete-errors")>()),
  logArchivedDeleteFailure,
}));

import { getArchivedDeleteReporting } from "@/features/quotes/archive-delete-errors";
import { deleteArchivedPartsWithFeedback } from "./archived-parts-delete";

const base = { organizationId: "org-1", userId: "user-1" };

describe("deleteArchivedPartsWithFeedback", () => {
  const invalidate = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    invalidate.mockResolvedValue(undefined);
  });

  it("rejects an empty selection without calling the API", async () => {
    await deleteArchivedPartsWithFeedback({ ...base, jobIds: [], invalidate });
    expect(toastError).toHaveBeenCalledWith("No archived parts selected.");
    expect(deleteArchivedJobs).not.toHaveBeenCalled();
  });

  it("dedupes ids, invalidates with them, and toasts success", async () => {
    deleteArchivedJobs.mockResolvedValue({ deletedJobIds: ["a"], failures: [] });
    await deleteArchivedPartsWithFeedback({ ...base, jobIds: ["a", "a"], invalidate });
    expect(deleteArchivedJobs).toHaveBeenCalledWith(["a"]);
    expect(invalidate).toHaveBeenCalledWith(["a"]);
    expect(toastSuccess).toHaveBeenCalledWith("Archived part deleted.");
  });

  it("pluralizes success and reports partial failures", async () => {
    deleteArchivedJobs.mockResolvedValueOnce({ deletedJobIds: ["a", "b"], failures: [] });
    await deleteArchivedPartsWithFeedback({ ...base, jobIds: ["a", "b"], invalidate });
    expect(toastSuccess).toHaveBeenCalledWith("2 archived parts deleted.");

    deleteArchivedJobs.mockResolvedValueOnce({ deletedJobIds: ["a"], failures: [{ jobId: "b", message: "x" }] });
    await deleteArchivedPartsWithFeedback({ ...base, jobIds: ["a", "b"], invalidate });
    expect(toastError).toHaveBeenCalledWith("Deleted 1 archived parts, but 1 could not be removed.");
  });

  it("throws, logs, and fills reporting partIds when every delete fails", async () => {
    deleteArchivedJobs.mockResolvedValue({
      deletedJobIds: [],
      failures: [
        {
          jobId: "a",
          message: "boom",
          reporting: {
            operation: "archived_delete",
            fallbackPath: "job-archive-fallback",
            failureCategory: "unknown",
            failureSummary: "s",
            likelyCause: "c",
            recommendedChecks: [],
          },
        },
      ],
    });

    const error = await deleteArchivedPartsWithFeedback({ ...base, jobIds: ["a"], invalidate }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(getArchivedDeleteReporting(error)?.partIds).toEqual(["a"]);
    expect(logArchivedDeleteFailure).toHaveBeenCalledWith(
      expect.objectContaining({ jobIds: ["a"], organizationId: "org-1", userId: "user-1" }),
    );
    expect(toastError).toHaveBeenCalled();
  });

  it("uses the generic message when no failure detail exists", async () => {
    deleteArchivedJobs.mockResolvedValue({ deletedJobIds: [], failures: [] });
    deleteArchivedJobs.mockResolvedValueOnce({ deletedJobIds: [], failures: [{ jobId: "a", message: "nope" }] });
    await expect(
      deleteArchivedPartsWithFeedback({ ...base, jobIds: ["a"], invalidate }),
    ).rejects.toThrow();
  });
});
