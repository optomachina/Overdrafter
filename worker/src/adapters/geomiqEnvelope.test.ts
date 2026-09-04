// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY } from "./evidenceBackedEnvelope.js";
import {
  evaluateGeomiqEnvelope,
  GEOMIQ_ENVELOPE_REVISION,
  type GeomiqEnvelopeInput,
} from "./geomiqEnvelope.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

function makeEligibleInput(
  overrides: Partial<GeomiqEnvelopeInput> = {},
): GeomiqEnvelopeInput {
  return {
    process: "cnc_machining",
    material: "aluminum_6082",
    fileName: "bracket.step",
    quantity: 1,
    accountMode: "existing_authenticated_account",
    drawingIncluded: false,
    explicitToleranceRequirement: false,
    requestedToleranceMm: null,
    explicitGeometryRequirements: false,
    geometryWithinReviewedEnvelope: true,
    ...overrides,
  };
}

describe("Geomiq evidence-backed envelope", () => {
  it.each([
    ["without an explicit tolerance", {}],
    [
      "with an evidenced numeric tolerance",
      { explicitToleranceRequirement: true, requestedToleranceMm: 0.05 },
    ],
  ])("accepts the exact reviewed CNC package %s", (_label, overrides) => {
    expect(evaluateGeomiqEnvelope(makeEligibleInput(overrides))).toMatchObject({
      providerKey: "geomiq",
      state: "eligible_for_evaluation",
      envelopeRevision: GEOMIQ_ENVELOPE_REVISION,
      reasonCodes: ["eligible_evidence_backed_envelope"],
      authorizationBoundary: OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
    });
  });

  it.each(["step", "stp"])(
    "accepts supported extension %s case-insensitively",
    (extension) => {
      const decision = evaluateGeomiqEnvelope(
        makeEligibleInput({ fileName: `BRACKET.${extension.toUpperCase()}` }),
      );
      expect(decision.state).toBe("eligible_for_evaluation");
      expect(decision.normalized.fileExtension).toBe(extension);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid quantity %s", (quantity) => {
    expect(
      evaluateGeomiqEnvelope(makeEligibleInput({ quantity })),
    ).toMatchObject({
      state: "unsupported",
      reasonCodes: expect.arrayContaining(["quantity_invalid"]),
    });
  });

  it.each([1, 50_000])("accepts evidenced quantity bound %s", (quantity) => {
    expect(evaluateGeomiqEnvelope(makeEligibleInput({ quantity })).state).toBe(
      "eligible_for_evaluation",
    );
  });

  it.each([50_001])("rejects out-of-envelope quantity %s", (quantity) => {
    expect(
      evaluateGeomiqEnvelope(makeEligibleInput({ quantity })),
    ).toMatchObject({
      state: "unsupported",
      reasonCodes: expect.arrayContaining(["quantity_outside_supported_range"]),
    });
  });

  it.each([
    ["missing process", { process: null }, "process_unknown"],
    ["other process", { process: "sheet_fabrication" }, "process_unknown"],
    ["missing material", { material: null }, "material_unknown"],
    ["other material", { material: "aluminum_6061" }, "material_unknown"],
    ["missing account", { accountMode: null }, "account_mode_unknown"],
    ["other account", { accountMode: "guest" }, "account_mode_unknown"],
    ["missing file extension", { fileName: "part" }, "file_format_unknown"],
    ["DXF", { fileName: "part.dxf" }, "file_format_unknown"],
    ["IGES", { fileName: "part.iges" }, "file_format_unknown"],
    ["IGS", { fileName: "part.igs" }, "file_format_unknown"],
    ["STL", { fileName: "part.stl" }, "file_format_unknown"],
    ["drawing", { drawingIncluded: true }, "drawing_requirement_unknown"],
    [
      "missing drawing fact",
      { drawingIncluded: null },
      "drawing_requirement_unknown",
    ],
    [
      "geometry",
      { explicitGeometryRequirements: true },
      "geometry_requirement_unknown",
    ],
    [
      "missing geometry fit",
      { geometryWithinReviewedEnvelope: null },
      "geometry_requirement_unknown",
    ],
  ])("keeps %s unknown", (_label, overrides, reasonCode) => {
    const decision = evaluateGeomiqEnvelope(
      makeEligibleInput(overrides as Partial<GeomiqEnvelopeInput>),
    );
    expect(decision.state).toBe("unknown");
    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it("rejects geometry outside Geomiq's reviewed CNC limits", () => {
    expect(
      evaluateGeomiqEnvelope(makeEligibleInput({ geometryWithinReviewedEnvelope: false })),
    ).toMatchObject({
      state: "unsupported",
      reasonCodes: ["geometry_outside_supported_range"],
    });
  });

  it.each([0.005, 0.05, 0.127])(
    "accepts evidenced tolerance %s mm",
    (requestedToleranceMm) => {
      expect(
        evaluateGeomiqEnvelope(
          makeEligibleInput({
            explicitToleranceRequirement: true,
            requestedToleranceMm,
          }),
        ).state,
      ).toBe("eligible_for_evaluation");
    },
  );

  it.each([
    ["missing numeric value", null],
    ["below the reviewed range", 0.004],
    ["above the reviewed range", 0.128],
    ["not finite", Number.POSITIVE_INFINITY],
  ])(
    "keeps a requested tolerance %s unknown",
    (_label, requestedToleranceMm) => {
      expect(
        evaluateGeomiqEnvelope(
          makeEligibleInput({
            explicitToleranceRequirement: true,
            requestedToleranceMm,
          }),
        ),
      ).toMatchObject({
        state: "unknown",
        reasonCodes: expect.arrayContaining(["tolerance_requirement_unknown"]),
      });
    },
  );

  it("keeps a missing tolerance fact unknown", () => {
    expect(
      evaluateGeomiqEnvelope(
        makeEligibleInput({
          explicitToleranceRequirement: null,
        }),
      ),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining(["tolerance_requirement_unknown"]),
    });
  });

  it("is deterministic, non-mutating, and has no interaction-capable dependency", async () => {
    const source = await readFile(
      path.join(currentDir, "geomiqEnvelope.ts"),
      "utf8",
    );
    const input = makeEligibleInput();
    const original = structuredClone(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      expect(evaluateGeomiqEnvelope(input)).toEqual(
        evaluateGeomiqEnvelope(input),
      );
      expect(input).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(source).not.toMatch(
        /\b(?:playwright|browser|session|fetch|XMLHttpRequest|WebSocket)\b/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("matches the canonical manifest and generated catalog after provider sync", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, "provider-integrations/geomiq/manifest.v1.json"),
        "utf8",
      ),
    );

    expect(PROVIDER_CATALOG.geomiq.capabilityEnvelope).toEqual(
      manifest.capabilityEnvelope,
    );
    expect(PROVIDER_CATALOG.geomiq).toMatchObject({
      officialRfqUrl: "https://app.geomiq.com/",
      adapterKind: "declarative_portal",
      processFamily: "multi_process",
      implementationStage: "envelope_defined",
    });
  });

  it("remains outside the production-certified live-offer allowlist", async () => {
    const source = await readFile(
      path.join(repoRoot, "src/features/quotes/sourcing-result.ts"),
      "utf8",
    );
    const allowlist =
      /PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS[^=]*=\s*\[([\s\S]*?)\]/.exec(
        source,
      )?.[1] ?? "";

    expect(allowlist).toContain('"xometry"');
    expect(allowlist).not.toContain("geomiq");
  });
});
