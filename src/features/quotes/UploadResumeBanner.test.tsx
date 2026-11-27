import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { UploadResumeBanner } from "./UploadResumeBanner";
import { beginUploadBatch, readUploadBatchSeal, resetUploadBatchStoreForTests } from "./upload-batch-store";
import {
  UPLOAD_RESUME_KEY,
  UPLOAD_RESUME_MAX_AGE_MS,
  beginUploadResume,
  noteUploadResumeProgress,
  resetUploadResumeStoreForTests,
} from "./upload-resume-store";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderBanner(projectId = "project-9") {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
      <UploadResumeBanner projectId={projectId} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("UploadResumeBanner", () => {
  afterEach(() => {
    cleanup();
    resetUploadResumeStoreForTests();
    resetUploadBatchStoreForTests();
  });

  it("names the files that did not finish and opens this project's picker", () => {
    act(() => {
      beginUploadResume({
        projectId: "project-9",
        expectedNames: ["done.sldprt", "a.sldprt", "b.sldprt"],
      });
      noteUploadResumeProgress(["done.sldprt"]);
    });

    renderBanner();

    expect(screen.getByRole("status", { name: "Unfinished upload" })).toHaveTextContent(
      "2 files from your last upload didn't finish: a.sldprt, b.sldprt",
    );

    fireEvent.click(screen.getByRole("button", { name: "Add them to this project" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/projects/project-9?addParts=1");
  });

  it("stays hidden while that project's batch is still running", () => {
    act(() => {
      beginUploadResume({
        projectId: "project-9",
        expectedNames: ["a.sldprt", "b.sldprt"],
      });
      beginUploadBatch(readUploadBatchSeal(), { totalGroups: 2, warnings: [], projectId: "project-9" });
    });

    renderBanner();

    expect(screen.queryByRole("status", { name: "Unfinished upload" })).toBeNull();
  });

  it("dismiss removes the banner and the stored record", () => {
    act(() => {
      beginUploadResume({
        projectId: "project-9",
        expectedNames: ["a.sldprt"],
      });
    });

    renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("status", { name: "Unfinished upload" })).toBeNull();
    expect(window.sessionStorage.getItem(UPLOAD_RESUME_KEY)).toBeNull();
  });

  it("ignores another project and a record older than 24 hours", () => {
    act(() => {
      beginUploadResume({ projectId: "project-other", expectedNames: ["a.sldprt"] });
    });
    renderBanner("project-9");
    expect(screen.queryByRole("status", { name: "Unfinished upload" })).toBeNull();

    cleanup();
    resetUploadResumeStoreForTests();
    window.sessionStorage.setItem(UPLOAD_RESUME_KEY, JSON.stringify({
      projectId: "project-9",
      expectedNames: ["a.sldprt"],
      doneNames: [],
      startedAt: Date.now() - UPLOAD_RESUME_MAX_AGE_MS - 1,
    }));

    renderBanner("project-9");
    expect(screen.queryByRole("status", { name: "Unfinished upload" })).toBeNull();
  });
});
