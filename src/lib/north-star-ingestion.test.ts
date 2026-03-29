import { describe, expect, it } from "vitest";
import { createDeterministicIngestionArtifacts } from "@/lib/north-star-ingestion";

describe("createDeterministicIngestionArtifacts", () => {
  it("pairs step and pdf files by stem", () => {
    const result = createDeterministicIngestionArtifacts([
      { path: "uploads/bracket.step", source: "file" },
      { path: "uploads/bracket.pdf", source: "file" },
    ]);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      stem: "bracket",
      stepPath: "uploads/bracket.step",
      pdfPath: "uploads/bracket.pdf",
    });
  });

  it("returns deterministic ordering and ids", () => {
    const a = createDeterministicIngestionArtifacts([
      { path: "zeta.step", source: "file" },
      { path: "alpha.step", source: "file" },
    ]);
    const b = createDeterministicIngestionArtifacts([
      { path: "alpha.step", source: "file" },
      { path: "zeta.step", source: "file" },
    ]);

    expect(a.artifacts).toEqual(b.artifacts);
  });

  it("tracks unsupported and unpaired uploads", () => {
    const result = createDeterministicIngestionArtifacts([
      { path: "job.zip", source: "zip" },
      { path: "assembly-folder", source: "folder" },
      { path: "only-step.step", source: "file" },
      { path: "only-drawing.pdf", source: "file" },
    ]);

    expect(result.unmatched.unsupported.map((entry) => entry.path)).toEqual(["assembly-folder", "job.zip"]);
    expect(result.unmatched.unpairedStepPaths).toEqual(["only-step.step"]);
    expect(result.unmatched.unpairedPdfPaths).toEqual(["only-drawing.pdf"]);
  });
});
