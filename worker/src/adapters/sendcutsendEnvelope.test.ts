// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateSendCutSendCncEnvelope,
  inspectSendCutSendStepGeometry,
  SENDCUTSEND_CNC_ENVELOPE,
  type SendCutSendEnvelopeInput,
} from "./sendcutsendEnvelope";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const envelopeSourcePath = path.resolve(currentDir, "sendcutsendEnvelope.ts");
const planarSolidPath = path.resolve(currentDir, "fixtures/sendcutsend-planar-single-solid.step");
const curvedFixturePath = path.resolve(currentDir, "fixtures/sendcutsend-curved.step");
const assemblyFixturePath = path.resolve(currentDir, "fixtures/sendcutsend-assembly.step");
const oversizeSplineFixturePath = path.resolve(
  currentDir,
  "fixtures/sendcutsend-oversize-b-spline.step",
);

function replaceStepEntity(stepContent: string, entityId: number, replacement: string) {
  const pattern = new RegExp(`^#${entityId}\\s*=.*;$`, "m");
  if (!pattern.test(stepContent)) {
    throw new Error(`STEP fixture is missing entity #${entityId}.`);
  }
  return stepContent.replace(pattern, replacement);
}

function insertBeforeStepDataEnd(stepContent: string, additions: string) {
  const endMarker = "ENDSEC;\nEND-ISO-10303-21;";
  if (!stepContent.includes(endMarker)) {
    throw new Error("STEP fixture is missing the DATA section terminator.");
  }
  return stepContent.replace(endMarker, `${additions}\n${endMarker}`);
}

function buildOpenSurfaceFixture(stepContent: string) {
  return replaceStepEntity(
    replaceStepEntity(
      stepContent,
      140,
      "#140 = OPEN_SHELL('',(#131,#132,#133,#134,#135,#136));",
    ),
    141,
    "#141 = SHELL_BASED_SURFACE_MODEL('',(#140));",
  );
}

function buildMultipleBodyFixture(stepContent: string) {
  return insertBeforeStepDataEnd(
    stepContent,
    [
      "#142 = CLOSED_SHELL('',(#131,#132,#133,#134,#135,#136));",
      "#143 = MANIFOLD_SOLID_BREP('',#142);",
    ].join("\n"),
  );
}

function buildUnknownUnitFixture(stepContent: string) {
  return replaceStepEntity(
    stepContent,
    150,
    "#150 = (LENGTH_UNIT() NAMED_UNIT(*) CONVERSION_BASED_UNIT('parsec',()));",
  );
}

function buildPlanarBoxFixture(stepContent: string, halfExtentMillimeter: number) {
  return stepContent.replace(
    /\((-?1)\.,(-?1)\.,(-?1)\.\)/g,
    (_match, x: string, y: string, z: string) => {
      const scaled = [x, y, z].map((coordinate) =>
        Number(coordinate) * halfExtentMillimeter);
      return `(${scaled[0]}.,${scaled[1]}.,${scaled[2]}.)`;
    },
  );
}

function decisionFromStepFixture(fileName: string, stepContent: string) {
  const geometry = inspectSendCutSendStepGeometry({
    fileName,
    buffer: Buffer.from(stepContent),
  });
  return {
    geometry,
    decision: evaluateSendCutSendCncEnvelope(makeEligibleInput({
      fileName,
      geometry,
    })),
  };
}

function makeEligibleInput(
  overrides: Partial<SendCutSendEnvelopeInput> = {},
): SendCutSendEnvelopeInput {
  return {
    fileName: "bracket.step",
    process: "CNC machining",
    material: "6061-T6 aluminum",
    finish: "as machined",
    tightestToleranceInch: 0.005,
    quantity: 1,
    drawingIncluded: false,
    accountMode: "company_controlled",
    geometry: {
      units: "inch",
      solidBodyCount: 1,
      surfaceBodyCount: 0,
      dimensions: [2, 3, 4],
    },
    ...overrides,
  };
}

describe("SendCutSend CNC envelope", () => {
  it("records a versioned, first-party, quote-only CNC envelope", () => {
    expect(SENDCUTSEND_CNC_ENVELOPE).toMatchObject({
      revision: "sendcutsend-cnc-envelope.v1",
      accountMode: "company_controlled",
      process: "cnc_machining",
      fileExtensions: ["step", "stp"],
      material: "6061-T6 aluminum",
      materialAliases: [
        "6061-T6 aluminum",
        "Aluminum 6061-T6",
        "6061-T6 aluminium",
        "Aluminium 6061-T6",
      ],
      standardToleranceInch: 0.005,
      minimumQuantity: 1,
      maximumQuantity: null,
      maximumDimensionsInch: [7, 7, 12],
      drawingUpload: false,
      orderPlacement: false,
    });
    expect(SENDCUTSEND_CNC_ENVELOPE.evidence).toEqual([
      "https://sendcutsend.com/guidelines/cnc-machining/",
      "https://sendcutsend.com/materials/cnc/6061-aluminum/",
      "https://sendcutsend.com/services/cnc-machining/",
    ]);
  });

  it("uses the conservative 1-inch minimum while first-party pages conflict", () => {
    expect(SENDCUTSEND_CNC_ENVELOPE.minimumDimensionsInch).toEqual([1, 1, 1]);
    expect(SENDCUTSEND_CNC_ENVELOPE.evidenceNotes.join(" ")).toMatch(
      /0\.5-inch minimum.*1-inch minimum.*conservative 1-inch intersection/i,
    );

    const disputedBand = evaluateSendCutSendCncEnvelope(
      makeEligibleInput({
        geometry: {
          units: "inch",
          solidBodyCount: 1,
          surfaceBodyCount: 0,
          dimensions: [0.75, 2, 2],
        },
      }),
    );
    expect(disputedBand).toMatchObject({
      eligible: false,
      denialCodes: ["geometry_too_small"],
    });
  });

  it("accepts the exact CNC file, material, tolerance, quantity, geometry, and account mode", () => {
    expect(evaluateSendCutSendCncEnvelope(makeEligibleInput())).toEqual({
      eligible: true,
      envelopeRevision: "sendcutsend-cnc-envelope.v1",
      normalized: {
        accountMode: "company_controlled",
        dimensionsInch: [2, 3, 4],
        fileExtension: "step",
        finish: "as_machined",
        material: "6061-T6 aluminum",
        process: "cnc_machining",
        quantity: 1,
        tightestToleranceInch: 0.005,
      },
      denialCodes: [],
    });
  });

  it.each([
    "6061-T6 aluminum",
    "Aluminum 6061-T6",
    "6061-T6 aluminium",
    "Aluminium 6061-T6",
  ])("accepts the reviewed exact material alias %s", (material) => {
    const decision = evaluateSendCutSendCncEnvelope(makeEligibleInput({ material }));

    expect(decision.eligible).toBe(true);
    expect(decision.normalized.material).toBe("6061-T6 aluminum");
  });

  it.each([
    "6061-T4 aluminum",
    "Aluminum 6061",
    "not 6061-T6 aluminum",
    "6061-T6 aluminum or 7075 aluminum",
    "6061-T651 aluminum",
  ])("rejects the unreviewed or negated material string %s", (material) => {
    const decision = evaluateSendCutSendCncEnvelope(makeEligibleInput({ material }));

    expect(decision.eligible).toBe(false);
    expect(decision.normalized.material).toBeNull();
    expect(decision.denialCodes).toContain("material_unsupported");
  });

  it("is deterministic, does not mutate input, and has no interaction-capable dependency", async () => {
    const source = await readFile(envelopeSourcePath, "utf8");
    const imports = [...source.matchAll(/^import .* from ["']([^"']+)["'];$/gm)]
      .map((match) => match[1]);
    expect(imports).toEqual(["../extraction/stepGeometryMetadata.js"]);
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|XMLHttpRequest|playwright|browser|session)\b/);

    const input = makeEligibleInput();
    const originalInput = structuredClone(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const first = evaluateSendCutSendCncEnvelope(input);
      const second = evaluateSendCutSendCncEnvelope(input);

      expect(second).toEqual(first);
      expect(input).toEqual(originalInput);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes millimeters and part orientation before size checks", () => {
    const decision = evaluateSendCutSendCncEnvelope(
      makeEligibleInput({
        fileName: "bracket.STP",
        material: "Aluminium 6061-T6",
        finish: null,
        geometry: {
          units: "millimeter",
          solidBodyCount: 1,
          surfaceBodyCount: 0,
          dimensions: [101.6, 50.8, 76.2],
        },
      }),
    );

    expect(decision.eligible).toBe(true);
    expect(decision.normalized.dimensionsInch).toEqual([2, 3, 4]);
  });

  it.each([
    ["file format", { fileName: "bracket.dxf" }, "file_format_unsupported"],
    ["process", { process: "laser cutting" }, "process_unsupported"],
    ["material", { material: "7075 aluminum" }, "material_unsupported"],
    ["finish", { finish: "Type II anodize" }, "finish_unsupported"],
    ["account", { accountMode: "customer_connected" }, "account_mode_unsupported"],
    ["drawing", { drawingIncluded: true }, "drawing_not_supported"],
    ["quantity", { quantity: 0 }, "quantity_unsupported"],
    ["missing tolerance", { tightestToleranceInch: null }, "tolerance_missing"],
    ["tight tolerance", { tightestToleranceInch: 0.0049 }, "tolerance_too_tight"],
    ["missing geometry", { geometry: null }, "geometry_unavailable"],
    [
      "unsupported units",
      {
        geometry: {
          units: "unsupported",
          solidBodyCount: 1,
          surfaceBodyCount: 0,
          dimensions: [2, 2, 2],
        },
      },
      "geometry_units_unsupported",
    ],
    [
      "multiple bodies",
      {
        geometry: {
          units: "inch",
          solidBodyCount: 2,
          surfaceBodyCount: 0,
          dimensions: [2, 2, 2],
        },
      },
      "multiple_or_surface_bodies_unsupported",
    ],
    [
      "oversize geometry",
      {
        geometry: {
          units: "inch",
          solidBodyCount: 1,
          surfaceBodyCount: 0,
          dimensions: [8, 8, 7],
        },
      },
      "geometry_too_large",
    ],
  ])("fails closed for unsupported %s", (_label, overrides, denialCode) => {
    const decision = evaluateSendCutSendCncEnvelope(
      makeEligibleInput(overrides as Partial<SendCutSendEnvelopeInput>),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.denialCodes).toContain(denialCode);
  });

  it("derives solid-body dimensions and units from STEP bytes", async () => {
    const buffer = await readFile(planarSolidPath);
    expect(
      inspectSendCutSendStepGeometry({ fileName: "sendcutsend-planar-single-solid.step", buffer }),
    ).toEqual({
      units: "millimeter",
      solidBodyCount: 1,
      surfaceBodyCount: 0,
      dimensions: [2, 2, 2],
    });
  });

  it("rejects an explicit surface/open-shell fixture with the surface-body denial", async () => {
    const planarSolid = await readFile(planarSolidPath, "utf8");
    const openSurface = buildOpenSurfaceFixture(planarSolid);
    const { geometry, decision } = decisionFromStepFixture(
      "sendcutsend-surface-open-shell.step",
      openSurface,
    );

    expect(geometry).toBeNull();
    expect(decision.denialCodes).toContain("geometry_unavailable");
    expect(
      evaluateSendCutSendCncEnvelope(makeEligibleInput({
        geometry: {
          units: "millimeter",
          solidBodyCount: 0,
          surfaceBodyCount: 1,
          dimensions: [2, 2, 2],
        },
      })).denialCodes,
    ).toContain("multiple_or_surface_bodies_unsupported");
  });

  it("rejects an explicit multiple-body fixture with the body-count denial", async () => {
    const planarSolid = await readFile(planarSolidPath, "utf8");
    const multipleBody = buildMultipleBodyFixture(planarSolid);
    const { geometry, decision } = decisionFromStepFixture(
      "sendcutsend-multiple-body.step",
      multipleBody,
    );

    expect(geometry).toBeNull();
    expect(decision.denialCodes).toContain("geometry_unavailable");
    expect(
      evaluateSendCutSendCncEnvelope(makeEligibleInput({
        geometry: {
          units: "millimeter",
          solidBodyCount: 2,
          surfaceBodyCount: 0,
          dimensions: [2, 2, 2],
        },
      })).denialCodes,
    ).toContain("multiple_or_surface_bodies_unsupported");
  });

  it("derives unsupported units from an explicit unknown-unit fixture", async () => {
    const planarSolid = await readFile(planarSolidPath, "utf8");
    const { geometry, decision } = decisionFromStepFixture(
      "sendcutsend-unknown-unit.step",
      buildUnknownUnitFixture(planarSolid),
    );

    expect(geometry).toMatchObject({ units: "unsupported" });
    expect(decision.eligible).toBe(false);
    expect(decision.denialCodes).toContain("geometry_units_unsupported");
  });

  it("reaches the undersize denial with an explicit connected planar fixture", async () => {
    const planarSolid = await readFile(planarSolidPath, "utf8");
    const { geometry, decision } = decisionFromStepFixture(
      "sendcutsend-undersize.step",
      planarSolid,
    );

    expect(geometry).not.toBeNull();
    expect(decision.eligible).toBe(false);
    expect(decision.denialCodes).toContain("geometry_too_small");
  });

  it("reaches the oversize denial with a true connected planar fixture", async () => {
    const planarSolid = await readFile(planarSolidPath, "utf8");
    const { geometry, decision } = decisionFromStepFixture(
      "sendcutsend-planar-oversize.step",
      buildPlanarBoxFixture(planarSolid, 200),
    );

    expect(geometry).toMatchObject({
      solidBodyCount: 1,
      surfaceBodyCount: 0,
      dimensions: [400, 400, 400],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.denialCodes).toContain("geometry_too_large");
  });

  it("rejects detached topology instead of letting it expand the global bounding box", async () => {
    const planarSolid = await readFile(planarSolidPath, "utf8");
    const withDetachedVertex = insertBeforeStepDataEnd(
      planarSolid,
      [
        "#151 = CARTESIAN_POINT('',(10000.,10000.,10000.));",
        "#152 = VERTEX_POINT('',#151);",
      ].join("\n"),
    );

    expect(
      inspectSendCutSendStepGeometry({
        fileName: "sendcutsend-detached-vertex.step",
        buffer: Buffer.from(withDetachedVertex),
      }),
    ).toBeNull();
  });

  it("rejects unresolved topology references in an otherwise closed planar shell", async () => {
    const planarSolid = await readFile(planarSolidPath, "utf8");
    const withUnresolvedVertex = replaceStepEntity(
      planarSolid,
      51,
      "#51 = EDGE_CURVE('',#11,#999,#31,.T.);",
    );

    expect(
      inspectSendCutSendStepGeometry({
        fileName: "sendcutsend-unresolved-topology.step",
        buffer: Buffer.from(withUnresolvedVertex),
      }),
    ).toBeNull();
  });

  it("rejects a discontinuous oriented EDGE_LOOP even when membership and incidence remain valid", async () => {
    const planarSolid = await readFile(planarSolidPath, "utf8");
    const withBrokenLoopContinuity = replaceStepEntity(
      planarSolid,
      51,
      "#51 = EDGE_CURVE('',#11,#13,#31,.T.);",
    );

    expect(
      inspectSendCutSendStepGeometry({
        fileName: "sendcutsend-discontinuous-edge-loop.step",
        buffer: Buffer.from(withBrokenLoopContinuity),
      }),
    ).toBeNull();
  });

  it("rejects a nominal closed shell with no faces, edges, or vertices", () => {
    const emptyClosedShell = [
      "ISO-10303-21;",
      "HEADER;",
      "FILE_DESCRIPTION(('SendCutSend empty closed shell fixture'),'2;1');",
      "ENDSEC;",
      "DATA;",
      "#1 = CLOSED_SHELL('',());",
      "#2 = MANIFOLD_SOLID_BREP('',#1);",
      "#3 = (LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));",
      "ENDSEC;",
      "END-ISO-10303-21;",
    ].join("\n");

    expect(
      inspectSendCutSendStepGeometry({
        fileName: "sendcutsend-empty-closed-shell.step",
        buffer: Buffer.from(emptyClosedShell),
      }),
    ).toBeNull();
  });

  it("fails closed when STEP bytes are not parseable", () => {
    expect(
      inspectSendCutSendStepGeometry({
        fileName: "invalid.step",
        buffer: Buffer.from("not a STEP file"),
      }),
    ).toBeNull();
  });

  it.each([
    ["curved topology", curvedFixturePath],
    ["oversize curved subtype topology", oversizeSplineFixturePath],
    ["mapped assembly topology", assemblyFixturePath],
  ])("fails closed for %s that the canonical text parser cannot bound", async (_label, fixturePath) => {
    expect(
      inspectSendCutSendStepGeometry({
        fileName: path.basename(fixturePath),
        buffer: await readFile(fixturePath),
      }),
    ).toBeNull();
  });

  it.each([
    "PARABOLA",
    "HYPERBOLA",
    "OFFSET_CURVE_2D",
    "PCURVE",
    "TRIMMED_CURVE",
    "BOUNDED_CURVE",
    "UNKNOWN_CURVE",
    "UNKNOWN_SURFACE",
  ])("rejects unsupported %s declared inside an otherwise valid single solid", async (entityType) => {
    const validSolid = await readFile(planarSolidPath, "utf8");
    const withUnsupportedEntity = validSolid.replace(
      "ENDSEC;\nEND-ISO-10303-21;",
      `#999 = ${entityType}('',#1);\nENDSEC;\nEND-ISO-10303-21;`,
    );
    expect(
      inspectSendCutSendStepGeometry({
        fileName: "unsupported-curve-or-surface.step",
        buffer: Buffer.from(withUnsupportedEntity),
      }),
    ).toBeNull();
  });
});
