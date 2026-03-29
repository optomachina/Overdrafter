import { describe, expect, it } from "vitest";
import { createDeterministicIngestionResult } from "@/lib/north-star-ingestion";

describe("createDeterministicIngestionResult", () => {
  it("pairs STEP/PDF records by shared stem deterministically", () => {
    const result = createDeterministicIngestionResult([
      { path: "z/Widget.PDF" },
      { path: "a/widget.step" },
    ]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      stem: "widget",
      stepPath: "a/widget.step",
      pdfPath: "z/Widget.PDF",
    });
  });

  it("emits stable IDs and ordering", () => {
    const first = createDeterministicIngestionResult([
      { path: "B/part.step" },
      { path: "A/part.pdf" },
      { path: "extra/part.step" },
    ]);
    const second = createDeterministicIngestionResult([
      { path: "extra/part.step" },
      { path: "A/part.pdf" },
      { path: "B/part.step" },
    ]);

    expect(first.pairs.map((pair) => pair.artifactId)).toEqual(second.pairs.map((pair) => pair.artifactId));
    expect(first.pairs.map((pair) => pair.stepPath)).toEqual(["B/part.step", "extra/part.step"]);
  });

  it("tracks unmatched zip/folder style uploads and unsupported paths", () => {
    const result = createDeterministicIngestionResult([
      { path: "batch/archive.zip" },
      { path: "folder/raw_file" },
      { path: "notes.txt" },
    ]);

    expect(result.unmatchedPaths).toEqual(["batch/archive.zip", "folder/raw_file"]);
    expect(result.unsupportedPaths).toEqual(["notes.txt"]);
  });
});
