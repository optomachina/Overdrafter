import { describe, expect, it } from "vitest";
import { createNorthStarIngestionSnapshot, type NorthStarUploadCandidate } from "@/lib/north-star-ingestion";

function makeCandidate(overrides: Partial<NorthStarUploadCandidate>): NorthStarUploadCandidate {
  return {
    id: overrides.id ?? "upload-id",
    kind: overrides.kind ?? "unknown",
    path: overrides.path ?? "uploads/file.bin",
  };
}

describe("north-star-ingestion", () => {
  it("pairs STEP and PDF uploads by normalized filename stem", () => {
    const snapshot = createNorthStarIngestionSnapshot([
      makeCandidate({ id: "u-step-1", kind: "step", path: "parts/BRACKET-A.STEP" }),
      makeCandidate({ id: "u-pdf-1", kind: "pdf", path: "drawings/bracket-a.pdf" }),
    ]);

    expect(snapshot.artifacts).toEqual([
      {
        artifactId: "artifact_bracket-a_01",
        stem: "bracket-a",
        stepUploadId: "u-step-1",
        drawingUploadId: "u-pdf-1",
        sourceUploadIds: ["u-step-1", "u-pdf-1"],
      },
    ]);
    expect(snapshot.unmatchedUploadIds).toEqual([]);
  });

  it("produces deterministic, padded artifact IDs when multiple uploads share a stem", () => {
    const snapshot = createNorthStarIngestionSnapshot([
      makeCandidate({ id: "step-z", kind: "step", path: "parts/shaft.step" }),
      makeCandidate({ id: "step-a", kind: "step", path: "parts/shaft.stp" }),
      makeCandidate({ id: "pdf-b", kind: "pdf", path: "drawings/shaft.pdf" }),
    ]);

    expect(snapshot.artifacts.map((artifact) => artifact.artifactId)).toEqual([
      "artifact_shaft_01",
      "artifact_shaft_02",
    ]);
    expect(snapshot.artifacts[0]).toMatchObject({
      stepUploadId: "step-a",
      drawingUploadId: "pdf-b",
    });
    expect(snapshot.artifacts[1]).toMatchObject({
      stepUploadId: "step-z",
      drawingUploadId: null,
    });
  });

  it("tracks uploads that are not currently consumed by deterministic pairing", () => {
    const snapshot = createNorthStarIngestionSnapshot([
      makeCandidate({ id: "zip-1", kind: "zip", path: "bundle/full-package.zip" }),
      makeCandidate({ id: "folder-1", kind: "folder", path: "bundle/" }),
      makeCandidate({ id: "step-1", kind: "step", path: "parts/widget.step" }),
    ]);

    expect(snapshot.artifacts).toEqual([
      {
        artifactId: "artifact_widget_01",
        stem: "widget",
        stepUploadId: "step-1",
        drawingUploadId: null,
        sourceUploadIds: ["step-1"],
      },
    ]);
    expect(snapshot.unmatchedUploadIds).toEqual(["folder-1", "zip-1"]);
  });
});
