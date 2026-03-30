import { describe, expect, it } from "vitest";
import { inferWorkspaceComposition } from "@/lib/north-star-assembly-inference";

describe("inferWorkspaceComposition", () => {
  it("returns loose parts when no artifacts exist", () => {
    expect(inferWorkspaceComposition([])).toEqual({
      composition: "loose_parts",
      viewportTargetArtifactId: null,
      reasons: ["no_artifacts"],
    });
  });

  it("prefers assembly classification when stem indicates an assembly", () => {
    const result = inferWorkspaceComposition([
      {
        artifactId: "artifact-parts",
        stem: "bracket",
        stepPath: "bracket.step",
        pdfPath: "bracket.pdf",
      },
      {
        artifactId: "artifact-assembly",
        stem: "main_assembly",
        stepPath: "main_assembly.step",
        pdfPath: null,
      },
    ]);

    expect(result.composition).toBe("assembly");
    expect(result.viewportTargetArtifactId).toBe("artifact-assembly");
  });

  it("does not treat part names containing asm as assembly evidence by themselves", () => {
    const result = inferWorkspaceComposition([
      {
        artifactId: "artifact-gasket",
        stem: "plasma-cut-gasket",
        stepPath: "plasma-cut-gasket.step",
        pdfPath: null,
      },
      {
        artifactId: "artifact-fastener",
        stem: "fastener",
        stepPath: "fastener.step",
        pdfPath: "fastener.pdf",
      },
    ]);

    expect(result.composition).toBe("loose_parts");
    expect(result.viewportTargetArtifactId).toBe("artifact-fastener");
  });

  it("chooses the densest artifact as the default viewport target for loose parts", () => {
    const result = inferWorkspaceComposition([
      {
        artifactId: "artifact-z",
        stem: "zeta",
        stepPath: "zeta.step",
        pdfPath: null,
      },
      {
        artifactId: "artifact-a",
        stem: "alpha",
        stepPath: "alpha.step",
        pdfPath: "alpha.pdf",
      },
    ]);

    expect(result.composition).toBe("loose_parts");
    expect(result.viewportTargetArtifactId).toBe("artifact-a");
  });
});
