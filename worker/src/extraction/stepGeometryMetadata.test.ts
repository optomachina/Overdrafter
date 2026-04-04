// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeStepToCanonicalGeometryMetadata } from "./stepGeometryMetadata";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const demoBracketFixturePath = path.resolve(currentDir, "../../../public/fixtures/demo-bracket.step");

async function loadDemoBracketFixture() {
  return readFile(demoBracketFixturePath, "utf8");
}

function replaceVertexPoint(stepContent: string, pointEntityId: number, coordinates: string) {
  return stepContent.replace(
    new RegExp(`(#${pointEntityId}\\s*=\\s*CARTESIAN_POINT\\('',\\()([^)]*)(\\)\\);)`),
    `$1${coordinates}$3`,
  );
}

describe("normalizeStepToCanonicalGeometryMetadata", () => {
  it("normalizes a representative solid STEP fixture into canonical geometry metadata", async () => {
    const stepContent = await loadDemoBracketFixture();

    const result = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: "demo-bracket.step",
    });

    expect(result.schemaVersion).toBe("canonical-part-geometry.v1");
    expect(result.sourceFormat).toBe("step");
    expect(result.sourceName).toBe("demo-bracket.step");
    expect(result.source.declaredName).toBe("Open CASCADE Shape Model");
    expect(result.source.schemaIdentifiers).toEqual(["AUTOMOTIVE_DESIGN_CC2 { 1 2 10303 214 -1 1 5 4 }"]);
    expect(result.source.productNames).toEqual(["Open CASCADE STEP translator 6.3 1"]);
    expect(result.units).toEqual({
      length: "millimeter",
      raw: "SI_UNIT(.MILLI.,.METRE.)",
    });
    expect(result.summary).toEqual({
      sourceEntityCount: 350,
      bodyCount: 1,
      solidBodyCount: 1,
      surfaceBodyCount: 0,
      shellCount: 1,
      faceCount: 6,
      edgeCount: 12,
      vertexCount: 8,
    });
    expect(result.boundingBox).toEqual({
      min: { x: -1, y: -1, z: -1 },
      max: { x: 1, y: 1, z: 1 },
      size: { x: 2, y: 2, z: 2 },
    });
    expect(result.vertices).toHaveLength(8);
    expect(result.edges).toHaveLength(12);
    expect(result.faces).toHaveLength(6);
    expect(result.shells).toEqual([
      {
        id: "shell-001",
        sourceEntityId: "#16",
        closure: "closed",
        faceIds: ["face-001", "face-002", "face-003", "face-004", "face-005", "face-006"],
      },
    ]);
    expect(result.bodies).toEqual([
      {
        id: "body-001",
        sourceEntityId: "#15",
        kind: "solid",
        shellIds: ["shell-001"],
        faceIds: ["face-001", "face-002", "face-003", "face-004", "face-005", "face-006"],
        edgeIds: [
          "edge-001",
          "edge-002",
          "edge-003",
          "edge-004",
          "edge-005",
          "edge-006",
          "edge-007",
          "edge-008",
          "edge-009",
          "edge-010",
          "edge-011",
          "edge-012",
        ],
        vertexIds: [
          "vertex-001",
          "vertex-002",
          "vertex-003",
          "vertex-004",
          "vertex-005",
          "vertex-006",
          "vertex-007",
          "vertex-008",
        ],
        boundingBox: {
          min: { x: -1, y: -1, z: -1 },
          max: { x: 1, y: 1, z: 1 },
          size: { x: 2, y: 2, z: 2 },
        },
      },
    ]);
    expect(result.faces[0]).toMatchObject({
      id: "face-001",
      sourceEntityId: "#17",
      surfaceType: "PLANE",
      orientation: false,
      edgeIds: ["edge-001", "edge-002", "edge-003", "edge-004"],
      vertexIds: ["vertex-001", "vertex-002", "vertex-003", "vertex-004"],
    });
  });

  it("returns byte-for-byte stable normalized output for identical STEP inputs", async () => {
    const stepContent = await loadDemoBracketFixture();

    const first = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: "demo-bracket.step",
    });
    const second = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: "demo-bracket.step",
    });

    expect(second).toEqual(first);
  });

  it("normalizes translated and resized STEP geometry into the same typed surface", async () => {
    const baseFixture = await loadDemoBracketFixture();
    const transformedFixture = [
      [23, "10.,-4.,0."],
      [25, "10.,-4.,6."],
      [58, "10.,4.,0."],
      [86, "10.,4.,6."],
      [143, "18.,-4.,0."],
      [145, "18.,-4.,6."],
      [173, "18.,4.,0."],
      [196, "18.,4.,6."],
    ].reduce(
      (current, [pointEntityId, coordinates]) =>
        replaceVertexPoint(current, pointEntityId, coordinates),
      baseFixture
        .replace("Open CASCADE Shape Model", "Shifted Block Model")
        .replace(
          /#7 = PRODUCT\('Open CASCADE STEP translator 6\.3 1',\s*'Open CASCADE STEP translator 6\.3 1'/,
          "#7 = PRODUCT('Shifted Block','Shifted Block'",
        ),
    );

    const result = normalizeStepToCanonicalGeometryMetadata({
      stepContent: transformedFixture,
      sourceName: "shifted-block.step",
    });

    expect(result.source.declaredName).toBe("Shifted Block Model");
    expect(result.source.productNames).toEqual(["Shifted Block"]);
    expect(result.summary).toMatchObject({
      bodyCount: 1,
      faceCount: 6,
      edgeCount: 12,
      vertexCount: 8,
    });
    expect(result.boundingBox).toEqual({
      min: { x: 10, y: -4, z: 0 },
      max: { x: 18, y: 4, z: 6 },
      size: { x: 8, y: 8, z: 6 },
    });
    expect(result.bodies[0]?.boundingBox).toEqual({
      min: { x: 10, y: -4, z: 0 },
      max: { x: 18, y: 4, z: 6 },
      size: { x: 8, y: 8, z: 6 },
    });
    expect(result.vertices.map((vertex) => vertex.id)).toEqual([
      "vertex-001",
      "vertex-002",
      "vertex-003",
      "vertex-004",
      "vertex-005",
      "vertex-006",
      "vertex-007",
      "vertex-008",
    ]);
  });
});
