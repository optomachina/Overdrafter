import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { OcctMesh } from "occt-import-js";
import { projectCadMeshesForThumbnail } from "@/lib/cad-iso-thumbnail";
import { createCadProjectionCache } from "@/lib/cad-projection-cache";
import { CadIsoThumbnail } from "./CadIsoThumbnail";

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

describe("CAD thumbnail projection cache", () => {
  const projection = projectCadMeshesForThumbnail([createMesh([0, 1, 2])]);

  it("evicts the least-recently-used successful projection", async () => {
    const cache = createCadProjectionCache(2);
    const loadA = vi.fn().mockResolvedValue(projection);
    const loadB = vi.fn().mockResolvedValue(projection);
    const loadC = vi.fn().mockResolvedValue(projection);

    await cache.getOrCreate("a", loadA);
    await cache.getOrCreate("b", loadB);
    await cache.getOrCreate("a", loadA);
    await cache.getOrCreate("c", loadC);
    await cache.getOrCreate("b", loadB);

    expect(loadA).toHaveBeenCalledOnce();
    expect(loadB).toHaveBeenCalledTimes(2);
    expect(loadC).toHaveBeenCalledOnce();
  });

  it("removes failed projections so a later request can recover", async () => {
    const cache = createCadProjectionCache(2);
    const failedLoad = vi.fn().mockRejectedValue(new Error("projection failed"));
    const successfulLoad = vi.fn().mockResolvedValue(projection);

    await expect(cache.getOrCreate("part", failedLoad)).rejects.toThrow("projection failed");
    await expect(cache.getOrCreate("part", successfulLoad)).resolves.toBe(projection);
  });

  it("does not let an evicted failed request remove its replacement", async () => {
    const cache = createCadProjectionCache(1);
    let rejectOldLoad: ((error: Error) => void) | undefined;
    const oldLoad = new Promise<ReturnType<typeof projectCadMeshesForThumbnail>>((_, reject) => {
      rejectOldLoad = reject;
    });
    const replacementLoad = vi.fn().mockResolvedValue(projection);

    const oldRequest = cache.getOrCreate("part", () => oldLoad);
    await cache.getOrCreate("other", vi.fn().mockResolvedValue(projection));
    await cache.getOrCreate("part", replacementLoad);
    rejectOldLoad?.(new Error("old projection failed"));
    await expect(oldRequest).rejects.toThrow("old projection failed");
    await cache.getOrCreate("part", replacementLoad);

    expect(replacementLoad).toHaveBeenCalledOnce();
  });
});

describe("CadIsoThumbnail accessibility", () => {
  it("puts unavailable status in the image accessible name", async () => {
    render(
      createElement(CadIsoThumbnail, {
        source: {
          cacheKey: "drawing-only",
          fileName: "drawing.pdf",
          loadStepBuffer: vi.fn(),
        },
      }),
    );

    expect(await screen.findByRole("img", { name: "Part preview unavailable for drawing.pdf" })).toBeInTheDocument();
  });
});
