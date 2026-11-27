import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { UploadBatchOutcome } from "./UploadBatchOutcome";
import {
  beginUploadBatch,
  clearUploadBatch,
  completeUploadBatch,
  navigationPathAfterUploadBatch,
  readUploadBatchSeal,
  pathAfterUploadBatch,
  getUploadBatchSnapshot,
  publishUploadBatchProgress,
  resetUploadBatchStoreForTests,
  uploadLocationKey,
} from "./upload-batch-store";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderOutcome() {
  return render(
    <MemoryRouter>
      <UploadBatchOutcome />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("UploadBatchOutcome", () => {
  afterEach(() => {
    cleanup();
    resetUploadBatchStoreForTests();
  });

  it("shows a partial batch and opens the picker on that project", () => {
    act(() => {
      completeUploadBatch({
      jobIds: ["job-1", "job-2", "job-3"],
      projectId: "project-9",
      failed: [
        { fileNames: ["d.SLDPRT"], reason: "dropped" },
        { fileNames: ["e.SLDPRT"], reason: "dropped" },
      ],
      warnings: ["X.SLDASM and X.STEP share a name and were grouped into one part."],
    });
    });

    renderOutcome();

    expect(screen.getByRole("status", { name: "Upload result" })).toHaveTextContent(
      "Uploaded 3 of 5. 2 didn't finish: d.SLDPRT (dropped); e.SLDPRT (dropped)",
    );
    expect(screen.getByText("X.SLDASM and X.STEP share a name and were grouped into one part.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add them to this project" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/projects/project-9?addParts=1");
  });

  it("keeps a running batch visible and hides the add action until it finishes", () => {
    act(() => {
      const batchId = beginUploadBatch(readUploadBatchSeal(), {
        totalGroups: 5,
        warnings: [],
        projectId: "project-9",
      });
      publishUploadBatchProgress(batchId ?? 0, {
        finishedGroups: 2,
        projectId: "project-9",
        jobIds: ["job-1", "job-2"],
        failed: [],
      });
    });

    renderOutcome();

    expect(screen.getByRole("status", { name: "Upload result" })).toHaveTextContent("Uploading 2 of 5...");
    expect(screen.queryByRole("button", { name: "Add them to this project" })).toBeNull();

    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    act(() => {
      completeUploadBatch({
        jobIds: ["job-1", "job-2"],
        projectId: "project-9",
        failed: [],
        warnings: [],
      });
    });

    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("does not offer a new project when the batch has nowhere to add the files", () => {
    act(() => {
      completeUploadBatch({
        jobIds: [],
        projectId: null,
        failed: [{ fileNames: ["a.step"], reason: "dropped" }],
        warnings: [],
      });
    });

    renderOutcome();

    expect(screen.getByRole("status", { name: "Upload result" })).toHaveTextContent(
      "Uploaded 0 of 1. 1 didn't finish: a.step (dropped)",
    );
    expect(screen.queryByRole("button", { name: "Add them to this project" })).toBeNull();
  });
});

describe("upload batch identity", () => {
  afterEach(() => {
    resetUploadBatchStoreForTests();
  });

  it("ignores a batch that finished after a newer one started or the banner was cleared", () => {
    const first = beginUploadBatch(readUploadBatchSeal(), {
      totalGroups: 2,
      warnings: [],
      projectId: "project-old",
    });
    const second = beginUploadBatch(readUploadBatchSeal(), {
      totalGroups: 1,
      warnings: [],
      projectId: "project-new",
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    publishUploadBatchProgress(first ?? 0, {
      finishedGroups: 1,
      projectId: "project-old",
      jobIds: ["job-old"],
      failed: [],
    });
    completeUploadBatch({
      jobIds: ["job-old"],
      projectId: "project-old",
      failed: [],
      warnings: [],
    }, first ?? 0);

    expect(getUploadBatchSnapshot()).toMatchObject({
      phase: "running",
      totalGroups: 1,
      result: { projectId: "project-new", jobIds: [] },
    });

    clearUploadBatch();
    completeUploadBatch({
      jobIds: ["job-new"],
      projectId: "project-new",
      failed: [],
      warnings: [],
    }, second ?? 0);
    expect(getUploadBatchSnapshot()).toBeNull();
  });
});

describe("upload batch navigation", () => {
  it("stays put when every group failed, and opens the project when some of a batch failed", () => {
    expect(pathAfterUploadBatch({ jobIds: [], projectId: "project-1", failed: [{}] })).toBeNull();
    expect(pathAfterUploadBatch({
      jobIds: ["job-1"],
      projectId: "project-1",
      failed: [{}],
    })).toBe("/projects/project-1");
    expect(pathAfterUploadBatch({ jobIds: ["job-1", "job-2"], projectId: "project-1", failed: [] })).toBe(
      "/projects/project-1",
    );
    expect(pathAfterUploadBatch({ jobIds: ["job-1"], projectId: null, failed: [] })).toBe("/parts/job-1");
  });

  it("does not send the user back after they have navigated away", () => {
    expect(navigationPathAfterUploadBatch(
      { jobIds: ["job-1"], projectId: "project-1", failed: [] },
      `${uploadLocationKey()}left`,
    )).toBeNull();
    expect(navigationPathAfterUploadBatch(
      { jobIds: ["job-1"], projectId: null, failed: [] },
      uploadLocationKey(),
    )).toBe("/parts/job-1");
  });
});
