// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeStepToCanonicalGeometryMetadata } from "./stepGeometryMetadata";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const demoBracketFixturePath = path.resolve(currentDir, "../../../public/fixtures/demo-bracket.step");
const unitMillimeter = {
  length: "millimeter",
  raw: "SI_UNIT(.MILLI.,.METRE.)",
} as const;
const centeredBlockBounds = {
  min: { x: -1, y: -1, z: -1 },
  max: { x: 1, y: 1, z: 1 },
  size: { x: 2, y: 2, z: 2 },
} as const;
const shellFaceIds = ["face-001", "face-002", "face-003", "face-004", "face-005", "face-006"] as const;
const bodyEdgeIds = [
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
] as const;
const bodyVertexIds = [
  "vertex-001",
  "vertex-002",
  "vertex-003",
  "vertex-004",
  "vertex-005",
  "vertex-006",
  "vertex-007",
  "vertex-008",
] as const;
const shiftedBlockBounds = {
  min: { x: 10, y: -4, z: 0 },
  max: { x: 18, y: 4, z: 6 },
  size: { x: 8, y: 8, z: 6 },
} as const;

async function loadDemoBracketFixture() {
  return readFile(demoBracketFixturePath, "utf8");
}

function replaceEntityAssignment(stepContent: string, entityId: number, replacement: string) {
  const marker = `#${entityId} = `;
  const start = stepContent.indexOf(marker);
  if (start < 0) {
    return stepContent;
  }

  const end = stepContent.indexOf(";\n", start);
  if (end < 0) {
    return stepContent;
  }

  return `${stepContent.slice(0, start)}${replacement}${stepContent.slice(end + 2)}`;
}

function replaceVertexPoint(stepContent: string, pointEntityId: number, coordinates: string) {
  return stepContent.replace(
    new RegExp(String.raw`(#${pointEntityId}\s*=\s*CARTESIAN_POINT\('',\()([^)]*)(\)\);)`),
    `$1${coordinates}$3`,
  );
}

function buildSurfaceModelFixture(stepContent: string) {
  return replaceEntityAssignment(
    replaceEntityAssignment(
      stepContent,
      15,
      "#15 = SHELL_BASED_SURFACE_MODEL('',(#16));",
    ),
    16,
    "#16 = OPEN_SHELL('',(#17,#137,#237,#284,#331,#338));",
  )
    .replace("Open CASCADE Shape Model", "Open Shell Model")
    .replace(
      /#7 = PRODUCT\('Open CASCADE STEP translator 6\.3 1',\s*'Open CASCADE STEP translator 6\.3 1'/,
      "#7 = PRODUCT('Open Shell Model','Open Shell Model'",
    );
}

function buildShellOnlyFixture(stepContent: string) {
  return replaceEntityAssignment(
    replaceEntityAssignment(
      stepContent,
      15,
      "#15 = SHAPE_REPRESENTATION('',(),#345);",
    ),
    16,
    "#16 = OPEN_SHELL('',(#17,#137,#237,#284,#331,#338));",
  );
}

function insertBeforeEndsec(stepContent: string, insertion: string) {
  return stepContent.replace("ENDSEC;", `${insertion}\nENDSEC;`);
}

function insertBeforeDataEndsec(stepContent: string, insertion: string) {
  const endsecIndex = stepContent.lastIndexOf("ENDSEC;");
  if (endsecIndex < 0) {
    return stepContent;
  }

  return `${stepContent.slice(0, endsecIndex)}${insertion}\n${stepContent.slice(endsecIndex)}`;
}

function buildQuotedHeaderFixture(stepContent: string, marker: "DATA" | "ENDSEC") {
  return stepContent
    .replace("Open CASCADE Shape Model", `Quoted ${marker}; Model`)
    .replace(
      /#7 = PRODUCT\('Open CASCADE STEP translator 6\.3 1',\s*'Open CASCADE STEP translator 6\.3 1'/,
      `#7 = PRODUCT('Quoted ${marker}; Product','Quoted ${marker}; Product'`,
    );
}

function expectSingleBodyTopology(
  result: ReturnType<typeof normalizeStepToCanonicalGeometryMetadata>,
  summary: Partial<(typeof result)["summary"]>,
) {
  expect(result.summary).toMatchObject({
    bodyCount: 1,
    faceCount: 6,
    edgeCount: 12,
    ...summary,
  });
}

function buildImperialFixture(stepContent: string, unitName: "inch" | "foot") {
  const conversionFactor = unitName === "inch" ? "25.4" : "304.8";
  const withUnitOverrides = replaceEntityAssignment(
    replaceEntityAssignment(
      stepContent,
      346,
      "#346 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() CONVERSION_BASED_UNIT('degree',#349) );",
    ),
    347,
    `#347 = ( LENGTH_UNIT() NAMED_UNIT(*) CONVERSION_BASED_UNIT('${unitName}',#350) );`,
  );

  return insertBeforeEndsec(
    withUnitOverrides,
    [
      "#349 = PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(0.0174532925199433),#351);",
      `#350 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${conversionFactor}),#352);`,
      "#351 = ( NAMED_UNIT(*) SI_UNIT($,.RADIAN.) PLANE_ANGLE_UNIT() );",
      "#352 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );",
    ].join("\n"),
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
    expect(result.units).toEqual(unitMillimeter);
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
    expect(result.boundingBox).toEqual(centeredBlockBounds);
    expect(result.vertices).toHaveLength(8);
    expect(result.edges).toHaveLength(12);
    expect(result.faces).toHaveLength(6);
    expect(result.shells).toEqual([
      {
        id: "shell-001",
        sourceEntityId: "#16",
        closure: "closed",
        faceIds: [...shellFaceIds],
      },
    ]);
    expect(result.bodies).toEqual([
      {
        id: "body-001",
        sourceEntityId: "#15",
        kind: "solid",
        shellIds: ["shell-001"],
        faceIds: [...shellFaceIds],
        edgeIds: [...bodyEdgeIds],
        vertexIds: [...bodyVertexIds],
        boundingBox: centeredBlockBounds,
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
    expect(result.faces[0]?.bounds[0]?.kind).toBe("unknown");
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

  it("normalizes OPEN_SHELL surface models as surface bodies", async () => {
    const stepContent = buildSurfaceModelFixture(await loadDemoBracketFixture());

    const result = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: "open-shell.step",
    });

    expect(result.source.declaredName).toBe("Open Shell Model");
    expect(result.source.productNames).toEqual(["Open Shell Model"]);
    expect(result.units).toEqual(unitMillimeter);
    expectSingleBodyTopology(result, {
      solidBodyCount: 0,
      surfaceBodyCount: 1,
      shellCount: 1,
      vertexCount: 8,
    });
    expect(result.shells).toEqual([
      {
        id: "shell-001",
        sourceEntityId: "#16",
        closure: "open",
        faceIds: [...shellFaceIds],
      },
    ]);
    expect(result.bodies[0]).toMatchObject({
      id: "body-001",
      sourceEntityId: "#15",
      kind: "surface",
      shellIds: ["shell-001"],
    });
  });

  it("synthesizes a surface body when STEP topology only includes shells", async () => {
    const stepContent = buildShellOnlyFixture(await loadDemoBracketFixture());

    const result = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: "shell-only.step",
    });

    expectSingleBodyTopology(result, {
      solidBodyCount: 0,
      surfaceBodyCount: 1,
      shellCount: 1,
    });
    expect(result.shells[0]).toMatchObject({
      sourceEntityId: "#16",
      closure: "open",
    });
    expect(result.bodies[0]).toMatchObject({
      id: "body-001",
      sourceEntityId: "#16",
      kind: "surface",
      shellIds: ["shell-001"],
    });
  });

  it.each([
    ["inch", "inch"],
    ["foot", "foot"],
  ] as const)(
    "prefers LENGTH_UNIT conversion-based %s definitions over earlier non-length conversions",
    async (unitName, expectedLength) => {
      const stepContent = buildImperialFixture(await loadDemoBracketFixture(), unitName);

      const result = normalizeStepToCanonicalGeometryMetadata({
        stepContent,
        sourceName: `${unitName}.step`,
      });

      expect(result.units.length).toBe(expectedLength);
      expect(result.units.raw).toContain(`CONVERSION_BASED_UNIT('${unitName}'`);
      expectSingleBodyTopology(result, {
        solidBodyCount: 1,
        surfaceBodyCount: 0,
        shellCount: 1,
      });
    },
  );

  it("does not terminate HEADER or DATA parsing when ENDSEC appears inside quoted STEP strings", async () => {
    const stepContent = buildQuotedHeaderFixture(await loadDemoBracketFixture(), "ENDSEC");

    const result = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: "quoted-endsec.step",
    });

    expect(result.source.declaredName).toBe("Quoted ENDSEC; Model");
    expect(result.source.productNames).toEqual(["Quoted ENDSEC; Product"]);
    expectSingleBodyTopology(result, {
      vertexCount: 8,
    });
  });

  it("does not start DATA parsing from quoted DATA markers inside header strings", async () => {
    const stepContent = buildQuotedHeaderFixture(await loadDemoBracketFixture(), "DATA");

    const result = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: "quoted-data.step",
    });

    expect(result.source.declaredName).toBe("Quoted DATA; Model");
    expect(result.source.productNames).toEqual(["Quoted DATA; Product"]);
    expectSingleBodyTopology(result, {
      vertexCount: 8,
    });
  });

  it("includes unattached materialized vertices in the overall bounding box", async () => {
    const stepContent = insertBeforeDataEndsec(
      await loadDemoBracketFixture(),
      ["#351 = CARTESIAN_POINT('',(50.,50.,50.));", "#352 = VERTEX_POINT('',#351);"].join("\n"),
    );

    const result = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: "detached-vertex.step",
    });

    expectSingleBodyTopology(result, {
      vertexCount: 9,
    });
    expect(result.boundingBox).toEqual({
      min: { x: -1, y: -1, z: -1 },
      max: { x: 50, y: 50, z: 50 },
      size: { x: 51, y: 51, z: 51 },
    });
    expect(result.bodies[0]?.boundingBox).toEqual(centeredBlockBounds);
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
    expectSingleBodyTopology(result, {
      vertexCount: 8,
    });
    expect(result.boundingBox).toEqual(shiftedBlockBounds);
    expect(result.bodies[0]?.boundingBox).toEqual(shiftedBlockBounds);
    expect(result.vertices.map((vertex) => vertex.id)).toEqual([...bodyVertexIds]);
  });
});
