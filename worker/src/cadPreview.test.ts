import { describe, expect, it } from "vitest";
import type { OcctMesh } from "occt-import-js";
import { renderCadMeshesToSvg } from "./cadPreview";

function createPlanarSquare(): OcctMesh {
  return {
    attributes: {
      position: {
        array: [
          0, 0, 0,
          1, 0, 0,
          1, 1, 0,
          0, 1, 0,
        ],
      },
    },
    index: {
      array: [0, 1, 2, 0, 2, 3],
    },
  };
}

describe("renderCadMeshesToSvg", () => {
  it("suppresses coplanar tessellation seams while retaining boundary edges", () => {
    const preview = renderCadMeshesToSvg([createPlanarSquare()]);

    expect(preview.contentType).toBe("image/svg+xml");
    expect(preview.displayStyle).toBe("sketch");
    expect(preview.viewOrientation).toBe("isometric");
    expect(preview.triangleCount).toBe(2);
    expect(preview.featureEdgeCount).toBe(4);
    const svg = preview.content.toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain('aria-label="Isometric CAD sketch preview"');
    expect(svg).toContain('stroke="#49453e"');
    expect(svg).toContain('stroke-dasharray="1.15 0.72"');
  });

  it("rejects empty geometry", () => {
    expect(() =>
      renderCadMeshesToSvg([
        {
          attributes: { position: { array: [] } },
          index: { array: [] },
        },
      ]),
    ).toThrow(/renderable faces/i);
  });
});
