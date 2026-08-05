import { describe, expect, it } from "vitest";
import type { OcctMesh } from "occt-import-js";
import { projectCadMeshesForThumbnail } from "@/lib/cad-iso-thumbnail";

function createMesh(indices: number[]): OcctMesh {
  return {
    attributes: {
      position: {
        array: [
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
        ],
      },
    },
    index: { array: indices },
  } as unknown as OcctMesh;
}

describe("projectCadMeshesForThumbnail", () => {
  it("projects CAD faces into a bounded isometric thumbnail", () => {
    const projection = projectCadMeshesForThumbnail([
      createMesh([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]),
    ]);

    expect(projection.triangles).toHaveLength(4);
    expect(projection.bounds.minX).toBeLessThan(projection.bounds.maxX);
    expect(projection.bounds.minY).toBeLessThan(projection.bounds.maxY);
    expect(projection.triangles.every((triangle) => triangle.shade >= 0.42 && triangle.shade <= 0.9)).toBe(true);
    expect(projection.triangles.flatMap((triangle) => triangle.edges).length).toBeGreaterThan(0);
  });

  it("limits dense meshes to the requested triangle budget", () => {
    const projection = projectCadMeshesForThumbnail(
      [createMesh([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2, 0, 1, 2, 0, 3, 1])],
      2,
    );

    expect(projection.triangles).toHaveLength(2);
    expect(projection.triangles.flatMap((triangle) => triangle.edges)).toHaveLength(0);
  });

  it("rejects meshes without renderable faces", () => {
    expect(() => projectCadMeshesForThumbnail([createMesh([])])).toThrow(/renderable faces/i);
  });
});
