// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildSpreadsheetImportSource,
  findOrphanDeleteCandidates,
  findRenameCandidates,
  summarizeBatchCounts,
} from "./cleanupDmriflesDemoData";

describe("cleanupDmriflesDemoData", () => {
  it("identifies the QB00002 test job rename target", () => {
    const candidates = findRenameCandidates(
      [
        {
          id: "job-qb2",
          title: "Test",
          description: "Imported spreadsheet quote",
          status: "published",
          source: "client",
          created_at: "2026-03-03T19:00:00Z",
        },
      ],
      [
        {
          jobId: "job-qb2",
          partNumber: "1093-05589",
          revision: "2",
          description: "TENSIONER, BELT, CAMERA FOCUS, PC6010",
          importedBatch: "QB00002",
        },
      ],
    );

    expect(candidates).toEqual([
      {
        jobId: "job-qb2",
        currentTitle: "Test",
        nextTitle: "1093-05589 rev 2",
        currentDescription: "Imported spreadsheet quote",
        nextDescription: "TENSIONER, BELT, CAMERA FOCUS, PC6010",
        currentSource: "client",
        nextSource: buildSpreadsheetImportSource("QB00002", "1093-05589", "2"),
      },
    ]);
  });

  it("only marks empty generic test jobs as delete candidates", () => {
    const candidates = findOrphanDeleteCandidates(
      [
        {
          id: "job-empty",
          title: "Test",
          description: null,
          status: "uploaded",
          source: "client",
          created_at: "2026-03-03T18:00:00Z",
        },
        {
          id: "job-keep",
          title: "Test",
          description: null,
          status: "published",
          source: "client",
          created_at: "2026-03-03T19:00:00Z",
        },
      ],
      new Map([
        ["job-empty", { parts: 0, quoteRuns: 0, packages: 0, files: 0 }],
        ["job-keep", { parts: 1, quoteRuns: 1, packages: 1, files: 0 }],
      ]),
    );

    expect(candidates.map((job) => job.id)).toEqual(["job-empty"]);
  });

  it("marks duplicate-file-only test jobs as delete candidates when they mirror the retained job", () => {
    const candidates = findOrphanDeleteCandidates(
      [
        {
          id: "job-delete",
          title: "Test",
          description: "Test",
          status: "uploaded",
          source: "client",
          created_at: "2026-03-03T18:00:00Z",
        },
        {
          id: "job-retain",
          title: "1093-05589 rev 2",
          description: "Part",
          status: "published",
          source: "spreadsheet_import:qb00002:1093-05589:2",
          created_at: "2026-03-03T18:01:00Z",
        },
      ],
      new Map([
        ["job-delete", { parts: 0, quoteRuns: 0, packages: 0, files: 2 }],
        ["job-retain", { parts: 1, quoteRuns: 1, packages: 1, files: 2 }],
      ]),
      new Map([
        [
          "job-delete",
          [
            {
              id: "file-a",
              job_id: "job-delete",
              storage_bucket: "job-files",
              storage_path: "job-delete/1093-05589-02.STEP",
              original_name: "1093-05589-02.STEP",
              normalized_name: "1093-05589-02",
              file_kind: "cad",
            },
            {
              id: "file-b",
              job_id: "job-delete",
              storage_bucket: "job-files",
              storage_path: "job-delete/1093-05589-02.pdf",
              original_name: "1093-05589-02.pdf",
              normalized_name: "1093-05589-02",
              file_kind: "drawing",
            },
          ],
        ],
        [
          "job-retain",
          [
            {
              id: "file-c",
              job_id: "job-retain",
              storage_bucket: "job-files",
              storage_path: "job-retain/1093-05589-02.STEP",
              original_name: "1093-05589-02.STEP",
              normalized_name: "1093-05589-02",
              file_kind: "cad",
            },
            {
              id: "file-d",
              job_id: "job-retain",
              storage_bucket: "job-files",
              storage_path: "job-retain/1093-05589-02.pdf",
              original_name: "1093-05589-02.pdf",
              normalized_name: "1093-05589-02",
              file_kind: "drawing",
            },
          ],
        ],
      ]),
      "job-retain",
    );

    expect(candidates.map((job) => job.id)).toEqual(["job-delete"]);
  });

  it("summarizes batch counts from requirements and source fallback", () => {
    const summary = summarizeBatchCounts(
      [
        {
          id: "job-1",
          title: "A",
          description: null,
          status: "published",
          source: "client",
          created_at: "2026-03-03T19:00:00Z",
        },
        {
          id: "job-2",
          title: "B",
          description: null,
          status: "published",
          source: "spreadsheet_import:qb00003:1093-05907:1",
          created_at: "2026-03-03T19:00:00Z",
        },
      ],
      [
        {
          jobId: "job-1",
          partNumber: "1093-03242",
          revision: "3",
          description: "Bracket",
          importedBatch: "QB00001",
        },
      ],
    );

    expect(summary).toEqual({
      QB00001: 1,
      QB00003: 1,
    });
  });
});
