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

  it("keeps unreviewed values and requirements unknown", () => {
    const cases = [
      [{ process: null }, "process_unknown"],
      [{ process: "sheet_fabrication" }, "process_unknown"],
      [{ material: null }, "material_unknown"],
      [{ material: "aluminum_6061" }, "material_unknown"],
      [{ fileName: "part" }, "file_format_unknown"],
      [{ fileName: "part.step" }, "file_format_unknown"],
      [{ accountMode: null }, "account_mode_unknown"],
      [{ accountMode: "guest" }, "account_mode_unknown"],
      [{ drawingIncluded: true }, "drawing_requirement_unknown"],
      [{ drawingIncluded: null }, "drawing_requirement_unknown"],
      [{ explicitToleranceRequirement: true }, "tolerance_requirement_unknown"],
      [{ explicitToleranceRequirement: null }, "tolerance_requirement_unknown"],
      [{ explicitGeometryRequirements: true }, "geometry_requirement_unknown"],
      [{ explicitGeometryRequirements: null }, "geometry_requirement_unknown"],
    ] as const;

    for (const [overrides, reasonCode] of cases) {
      const decision = evaluateProtolabsEnvelope(
        makeEligibleInput(overrides),
      );
      expect(decision).toMatchObject({
        state: "unknown",
        authorizationBoundary: PROTOLABS_OFFLINE_AUTHORIZATION_BOUNDARY,
      });
      expect(decision.reasonCodes).toContain(reasonCode);
    }
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
