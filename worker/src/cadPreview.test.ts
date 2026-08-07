import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OcctMesh } from "occt-import-js";
import {
  isRetryableCadPreviewError,
  renderCadMeshesToSvg,
  renderCadPreviewFromStepFile,
} from "./cadPreview";

const moduleMocks = vi.hoisted(() => ({
  occtImportJs: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("occt-import-js", () => ({
  default: moduleMocks.occtImportJs,
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: moduleMocks.readFile },
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

describe("CAD preview module loading", () => {
  it("clears a rejected OCCT import so the next task can retry loading", async () => {
    moduleMocks.readFile.mockResolvedValue(Buffer.from("STEP"));
    moduleMocks.occtImportJs
      .mockRejectedValueOnce(new Error("OCCT failed to load"))
      .mockResolvedValueOnce({
        ReadStepFile: () => ({ success: true, meshes: [createPlanarSquare()] }),
      });

    await expect(renderCadPreviewFromStepFile("part.step")).rejects.toThrow("OCCT failed to load");
    await expect(renderCadPreviewFromStepFile("part.step")).resolves.toMatchObject({
      displayStyle: "sketch",
    });
    expect(moduleMocks.occtImportJs).toHaveBeenCalledTimes(2);
  });
});

describe("isRetryableCadPreviewError", () => {
  it("treats deterministic geometry failures as terminal", () => {
    expect(isRetryableCadPreviewError(new Error("The STEP file could not be triangulated for a CAD preview."))).toBe(false);
    expect(isRetryableCadPreviewError(new Error("The CAD model exceeded the triangle limit."))).toBe(false);
    expect(isRetryableCadPreviewError(new Error("The CAD model did not contain renderable faces."))).toBe(false);
    expect(isRetryableCadPreviewError(new Error("The CAD model did not contain non-degenerate preview faces."))).toBe(false);
  });

  it("retries transient preview failures", () => {
    expect(isRetryableCadPreviewError(new Error("Failed to download storage object cad/part.step."))).toBe(true);
    expect(isRetryableCadPreviewError(new Error("OCCT failed to load"))).toBe(true);
  });
});
