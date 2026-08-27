// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateSendCutSendCncEnvelope,
  inspectSendCutSendStepGeometry,
  SENDCUTSEND_CNC_ENVELOPE,
  type SendCutSendEnvelopeInput,
} from "./sendcutsendEnvelope";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const planarSolidPath = path.resolve(currentDir, "fixtures/sendcutsend-planar-single-solid.step");
const curvedFixturePath = path.resolve(currentDir, "fixtures/sendcutsend-curved.step");
const assemblyFixturePath = path.resolve(currentDir, "fixtures/sendcutsend-assembly.step");
const oversizeSplineFixturePath = path.resolve(
  currentDir,
  "fixtures/sendcutsend-oversize-b-spline.step",
);

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

  it("normalizes millimeters and part orientation before size checks", () => {
    const decision = evaluateSendCutSendCncEnvelope(
      makeEligibleInput({
        fileName: "bracket.STP",
        material: "Aluminium 6061",
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
