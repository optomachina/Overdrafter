// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY } from "./evidenceBackedEnvelope.js";
import {
  evaluateProtolabsNetworkEnvelope,
  PROTOLABS_NETWORK_ENVELOPE_REVISION,
  type ProtolabsNetworkEnvelopeInput,
} from "./protolabsNetworkEnvelope.js";
import { runOfflineProviderEnvelopeContract } from "./providerEnvelopeContractTest.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

function eligibleInput(
  overrides: Partial<ProtolabsNetworkEnvelopeInput> = {},
): ProtolabsNetworkEnvelopeInput {
  return {
    process: "cnc_machining",
    material: "aluminum_6061",
    fileName: "part.step",
    quantity: 1,
    accountMode: "existing_authenticated_account",
    drawingIncluded: false,
    explicitToleranceRequirement: false,
    explicitGeometryRequirements: false,
    geometryWithinReviewedEnvelope: true,
    ...overrides,
  };
}

describe("Protolabs Network evidence-backed envelope", () => {
  it("accepts only the exact reviewed CNC package without granting runtime authority", () => {
    expect(evaluateProtolabsNetworkEnvelope(eligibleInput())).toEqual({
      providerKey: "protolabsnetwork",
      state: "eligible_for_evaluation",
      envelopeRevision: PROTOLABS_NETWORK_ENVELOPE_REVISION,
      reasonCodes: ["eligible_evidence_backed_envelope"],
      normalized: {
        process: "cnc_machining",
        material: "aluminum_6061",
        fileExtension: "step",
        quantity: 1,
        accountMode: "existing_authenticated_account",
        drawingIncluded: false,
        explicitToleranceRequirement: false,
        requestedToleranceMm: null,
        explicitGeometryRequirements: false,
        geometryWithinReviewedEnvelope: true,
      },
      authorizationBoundary: OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
    });
  });

  it.each(PROVIDER_CATALOG.protolabsnetwork.capabilityEnvelope.files.values)(
    "accepts reviewed CNC extension %s case-insensitively",
    (extension) => {
      const decision = evaluateProtolabsNetworkEnvelope(
        eligibleInput({ fileName: `PART.${extension.toUpperCase()}` }),
      );
      expect(decision.state).toBe("eligible_for_evaluation");
      expect(decision.normalized.fileExtension).toBe(extension);
    },
  );

  it.each(["stl", "obj", "dxf", "pdf"])(
    "keeps non-CNC or non-CAD extension %s outside the automated envelope",
    (extension) => {
      expect(
        evaluateProtolabsNetworkEnvelope(eligibleInput({ fileName: `part.${extension}` })),
      ).toMatchObject({
        state: "unknown",
        reasonCodes: expect.arrayContaining(["file_format_unknown"]),
      });
    },
  );

  it("keeps quantities above the evidence-backed minimum unknown", () => {
    expect(evaluateProtolabsNetworkEnvelope(eligibleInput({ quantity: 2 }))).toMatchObject({
      state: "unknown",
      reasonCodes: ["quantity_above_reviewed_minimum_unknown"],
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid quantity %s",
    (quantity) => {
      expect(evaluateProtolabsNetworkEnvelope(eligibleInput({ quantity }))).toMatchObject({
        state: "unsupported",
        reasonCodes: expect.arrayContaining(["quantity_invalid"]),
      });
    },
  );

  it.each([
    ["process", { process: null }, "process_unknown"],
    ["material", { material: "aluminum_7075" }, "material_unknown"],
    ["account mode", { accountMode: null }, "account_mode_unknown"],
  ])("keeps non-evidenced %s unknown", (_label, overrides, reasonCode) => {
    expect(
      evaluateProtolabsNetworkEnvelope(
        eligibleInput(overrides as Partial<ProtolabsNetworkEnvelopeInput>),
      ),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining([reasonCode]),
    });
  });

  it.each([
    ["drawing fact", { drawingIncluded: null }, "drawing_requirement_unknown"],
    ["tolerance", { explicitToleranceRequirement: true }, "tolerance_requirement_unknown"],
    ["geometry", { explicitGeometryRequirements: true }, "geometry_requirement_unknown"],
  ])("keeps unresolved %s unknown", (_label, overrides, reasonCode) => {
    expect(
      evaluateProtolabsNetworkEnvelope(
        eligibleInput(overrides as Partial<ProtolabsNetworkEnvelopeInput>),
      ),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining([reasonCode]),
    });
  });

  it("routes a reviewed PDF technical drawing through manual review", () => {
    expect(
      PROVIDER_CATALOG.protolabsnetwork.capabilityEnvelope.drawings,
    ).toEqual({ status: "supported", values: ["pdf"] });
    expect(
      evaluateProtolabsNetworkEnvelope(eligibleInput({ drawingIncluded: true })),
    ).toMatchObject({
      state: "manual_review",
      reasonCodes: ["drawings_require_manual_review"],
    });
  });

  it("keeps exact tolerance and geometry requirements unknown", () => {
    expect(
      evaluateProtolabsNetworkEnvelope(
        eligibleInput({ explicitToleranceRequirement: true, requestedToleranceMm: 0.02032 }),
      ),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: ["tolerance_requirement_unknown"],
    });
    expect(
      evaluateProtolabsNetworkEnvelope(eligibleInput({ explicitGeometryRequirements: true })),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: ["geometry_requirement_unknown"],
    });
  });

  it("matches the canonical manifest and synchronized worker catalog", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, "provider-integrations/protolabsnetwork/manifest.v1.json"),
        "utf8",
      ),
    );

    expect(PROVIDER_CATALOG.protolabsnetwork.capabilityEnvelope).toEqual(
      manifest.capabilityEnvelope,
    );
    expect(PROVIDER_CATALOG.protolabsnetwork).toMatchObject({
      officialRfqUrl: "https://www.hubs.com/manufacture/",
      purchasingDomains: [],
      adapterKind: "declarative_portal",
      processFamily: "multi_process",
      implementationStage: "envelope_defined",
    });
    expect(manifest.capabilityEnvelope.tolerance).toEqual({
      status: "unknown",
      minimumMm: null,
      maximumMm: null,
    });
  });

  runOfflineProviderEnvelopeContract({
    providerKey: "protolabsnetwork",
    sourceFileName: "protolabsNetworkEnvelope.ts",
    makeEligibleInput: eligibleInput,
    evaluate: evaluateProtolabsNetworkEnvelope,
  });
});
