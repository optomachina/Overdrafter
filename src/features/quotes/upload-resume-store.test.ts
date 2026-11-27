import { afterEach, describe, expect, it } from "vitest";
import {
  UPLOAD_RESUME_KEY,
  UPLOAD_RESUME_MAX_AGE_MS,
  beginUploadResume,
  clearUploadResume,
  formatUnfinishedUploadMessage,
  noteUploadResumeProgress,
  readUploadResume,
  resetUploadResumeStoreForTests,
  unfinishedUploadNames,
} from "./upload-resume-store";

describe("uploadResumeStore", () => {
  afterEach(() => {
    resetUploadResumeStoreForTests();
  });

  it("keeps the start time as each group finishes and removes the record when cleared", () => {
    beginUploadResume({
      projectId: "project-1",
      expectedNames: ["a.sldprt", "b.sldprt", "c.sldprt"],
    });
    const startedAt = readUploadResume()?.startedAt;

    noteUploadResumeProgress(["a.sldprt"]);
    noteUploadResumeProgress(["a.sldprt", "c.sldprt"]);

    expect(readUploadResume()).toEqual({
      projectId: "project-1",
      expectedNames: ["a.sldprt", "b.sldprt", "c.sldprt"],
      doneNames: ["a.sldprt", "c.sldprt"],
      startedAt,
    });
    expect(window.sessionStorage.getItem(UPLOAD_RESUME_KEY)).toContain("\"projectId\":\"project-1\"");
    expect(unfinishedUploadNames(readUploadResume()!)).toEqual(["b.sldprt"]);
    expect(formatUnfinishedUploadMessage(["a.sldprt", "b.sldprt"])).toBe(
      "2 files from your last upload didn't finish: a.sldprt, b.sldprt",
    );

    clearUploadResume();

    expect(readUploadResume()).toBeNull();
    expect(window.sessionStorage.getItem(UPLOAD_RESUME_KEY)).toBeNull();
  });

  it("ignores a record older than 24 hours and a record that is not one", () => {
    const startedAt = 1_700_000_000_000;
    window.sessionStorage.setItem(UPLOAD_RESUME_KEY, JSON.stringify({
      projectId: "project-1",
      expectedNames: ["a.sldprt"],
      doneNames: [],
      startedAt,
    }));

    expect(readUploadResume(startedAt + UPLOAD_RESUME_MAX_AGE_MS)).toMatchObject({
      projectId: "project-1",
    });
    expect(readUploadResume(startedAt + UPLOAD_RESUME_MAX_AGE_MS + 1)).toBeNull();

    window.sessionStorage.setItem(UPLOAD_RESUME_KEY, "not-json");
    expect(readUploadResume()).toBeNull();

    window.sessionStorage.setItem(UPLOAD_RESUME_KEY, JSON.stringify({ projectId: "project-1" }));
    expect(readUploadResume()).toBeNull();
  });

  it("does not move the finished names when no record is open", () => {
    noteUploadResumeProgress(["a.sldprt"]);
    expect(readUploadResume()).toBeNull();
  });
});
