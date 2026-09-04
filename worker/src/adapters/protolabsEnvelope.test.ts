// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  evaluateProtolabsEnvelope,
  PROTOLABS_ENVELOPE_REVISION,
  PROTOLABS_OFFLINE_AUTHORIZATION_BOUNDARY,
  type ProtolabsEnvelopeInput,
} from "./protolabsEnvelope.js";
import { runOfflineProviderEnvelopeContract } from "./providerEnvelopeContractTest.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

function makeEligibleInput(
  overrides: Partial<ProtolabsEnvelopeInput> = {},
): ProtolabsEnvelopeInput {
  return {
    process: "cnc_machining",
    material: "aluminum_6061_t651",
    fileName: "bracket.stp",
    quantity: 1,
    accountMode: "existing_authenticated_account",
    drawingIncluded: false,
    explicitToleranceRequirement: false,
    explicitGeometryRequirements: false,
    geometryWithinReviewedEnvelope: true,
    ...overrides,
  };
}

describe("Protolabs evidence-backed envelope", () => {
  it("accepts only the exact reviewed quantity-one package without authorizing interaction", () => {
    expect(evaluateProtolabsEnvelope(makeEligibleInput())).toEqual({
      providerKey: "protolabs",
      state: "eligible_for_evaluation",
      envelopeRevision: PROTOLABS_ENVELOPE_REVISION,
      reasonCodes: ["eligible_evidence_backed_envelope"],
      normalized: {
        process: "cnc_machining",
        material: "aluminum_6061_t651",
        fileExtension: "stp",
        quantity: 1,
        accountMode: "existing_authenticated_account",
        drawingIncluded: false,
        explicitToleranceRequirement: false,
        requestedToleranceMm: null,
        explicitGeometryRequirements: false,
        geometryWithinReviewedEnvelope: true,
      },
      authorizationBoundary: PROTOLABS_OFFLINE_AUTHORIZATION_BOUNDARY,
    });
  });

  it.each(PROVIDER_CATALOG.protolabs.capabilityEnvelope.files.values)(
    "accepts supported extension %s case-insensitively",
    (extension) => {
      const decision = evaluateProtolabsEnvelope(
        makeEligibleInput({ fileName: `BRACKET.${extension.toUpperCase()}` }),
      );

      expect(decision.state).toBe("eligible_for_evaluation");
      expect(decision.normalized.fileExtension).toBe(extension);
    },
  );

  it.each([
    ["zero", 0, "quantity_invalid", "unsupported"],
    ["negative", -1, "quantity_invalid", "unsupported"],
    ["fractional", 1.5, "quantity_invalid", "unsupported"],
    ["NaN", Number.NaN, "quantity_invalid", "unsupported"],
    ["infinite", Number.POSITIVE_INFINITY, "quantity_invalid", "unsupported"],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1, "quantity_invalid", "unsupported"],
    ["above reviewed minimum", 2, "quantity_above_reviewed_minimum_unknown", "unknown"],
    ["advertised production volume", 200, "quantity_above_reviewed_minimum_unknown", "unknown"],
  ])("classifies %s quantity conservatively", (_label, quantity, reasonCode, state) => {
    const decision = evaluateProtolabsEnvelope(makeEligibleInput({ quantity }));

    expect(decision.state).toBe(state);
    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it.each([
    ["missing process", { process: null }, "process_unknown"],
    ["other process", { process: "sheet_fabrication" }, "process_unknown"],
    ["missing material", { material: null }, "material_unknown"],
    ["other material", { material: "aluminum_6061" }, "material_unknown"],
    ["missing file", { fileName: "part" }, "file_format_unknown"],
    ["other file", { fileName: "part.step" }, "file_format_unknown"],
    ["missing account", { accountMode: null }, "account_mode_unknown"],
    ["other account", { accountMode: "guest" }, "account_mode_unknown"],
  ])("keeps %s outside the reviewed envelope unknown", (_label, overrides, reasonCode) => {
    const decision = evaluateProtolabsEnvelope(
      makeEligibleInput(overrides as Partial<ProtolabsEnvelopeInput>),
    );

    expect(decision.state).toBe("unknown");
    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it.each([
    ["drawing", { drawingIncluded: true }, "drawing_requirement_unknown", "unknown"],
    ["unknown drawing fact", { drawingIncluded: null }, "drawing_requirement_unknown", "unknown"],
    ["tolerance", { explicitToleranceRequirement: true }, "tolerance_requirement_unknown", "unknown"],
    ["unknown tolerance fact", { explicitToleranceRequirement: null }, "tolerance_requirement_unknown", "unknown"],
    ["geometry", { explicitGeometryRequirements: true }, "geometry_requirement_unknown", "unknown"],
    ["unknown geometry fact", { explicitGeometryRequirements: null }, "geometry_requirement_unknown", "unknown"],
  ])("classifies %s conservatively", (_label, overrides, reasonCode, state) => {
    const decision = evaluateProtolabsEnvelope(
      makeEligibleInput(overrides as Partial<ProtolabsEnvelopeInput>),
    );

    expect(decision.state).toBe(state);
    expect(decision.reasonCodes).toContain(reasonCode);
    expect(decision.authorizationBoundary).toBe(PROTOLABS_OFFLINE_AUTHORIZATION_BOUNDARY);
  });

  it("matches the canonical manifest and generated worker catalog", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, "provider-integrations/protolabs/manifest.v1.json"), "utf8"),
    );

    expect(PROVIDER_CATALOG.protolabs.capabilityEnvelope).toEqual(manifest.capabilityEnvelope);
    expect(PROVIDER_CATALOG.protolabs).toMatchObject({
      officialRfqUrl: "https://www.protolabs.com/request-a-quote/",
      purchasingDomains: ["protolabs.com"],
      adapterKind: "custom_portal",
      processFamily: "multi_process",
      implementationStage: "envelope_defined",
    });
    expect(manifest.capabilityEnvelope.drawings).toEqual({
      status: "unknown",
      values: [],
    });
    expect(manifest.evidence.firstPartyUrls).not.toContain(
      "https://www.protolabs.com/help-center/sheet-metal-quoting-and-dfm/",
    );
  });

  runOfflineProviderEnvelopeContract({
    providerKey: "protolabs",
    sourceFileName: "protolabsEnvelope.ts",
    makeEligibleInput,
    evaluate: evaluateProtolabsEnvelope,
  });
});
