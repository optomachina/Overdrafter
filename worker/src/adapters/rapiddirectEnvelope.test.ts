// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY } from "./evidenceBackedEnvelope.js";
import {
  evaluateRapidDirectEnvelope,
  RAPIDDIRECT_ENVELOPE_REVISION,
  type RapidDirectEnvelopeInput,
} from "./rapiddirectEnvelope.js";
import { runOfflineProviderEnvelopeContract } from "./providerEnvelopeContractTest.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

function eligibleInput(
  overrides: Partial<RapidDirectEnvelopeInput> = {},
): RapidDirectEnvelopeInput {
  return {
    process: "cnc_machining",
    material: "aluminum_6061",
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

describe("RapidDirect evidence-backed envelope", () => {
  it("accepts only the exact reviewed quantity-one CNC package", () => {
    expect(evaluateRapidDirectEnvelope(eligibleInput())).toEqual({
      providerKey: "rapiddirect",
      state: "eligible_for_evaluation",
      envelopeRevision: RAPIDDIRECT_ENVELOPE_REVISION,
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

  it.each(PROVIDER_CATALOG.rapiddirect.capabilityEnvelope.files.values)(
    "accepts reviewed extension %s case-insensitively",
    (extension) => {
      const decision = evaluateRapidDirectEnvelope(
        eligibleInput({ fileName: `BRACKET.${extension.toUpperCase()}` }),
      );
      expect(decision.state).toBe("eligible_for_evaluation");
      expect(decision.normalized.fileExtension).toBe(extension);
    },
  );

  it("keeps quantities above the evidenced minimum unknown", () => {
    expect(evaluateRapidDirectEnvelope(eligibleInput({ quantity: 2 }))).toMatchObject({
      state: "unknown",
      reasonCodes: ["quantity_above_reviewed_minimum_unknown"],
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe quantity %s",
    (quantity) => {
      const decision = evaluateRapidDirectEnvelope(eligibleInput({ quantity }));
      expect(decision.state).toBe("unsupported");
      expect(decision.reasonCodes).toContain("quantity_invalid");
    },
  );

  it.each([
    ["process", { process: "sheet_metal" }, "process_unknown"],
    ["material", { material: "aluminum_7075" }, "material_unknown"],
    ["file", { fileName: "part.dxf" }, "file_format_unknown"],
    ["account", { accountMode: "guest" }, "account_mode_unknown"],
    ["tolerance", { explicitToleranceRequirement: true, requestedToleranceMm: 0.0254 }, "tolerance_requirement_unknown"],
    ["geometry", { explicitGeometryRequirements: true }, "geometry_requirement_unknown"],
  ])("keeps out-of-envelope %s unknown", (_label, overrides, reason) => {
    const decision = evaluateRapidDirectEnvelope(
      eligibleInput(overrides as Partial<RapidDirectEnvelopeInput>),
    );
    expect(decision.state).toBe("unknown");
    expect(decision.reasonCodes).toContain(reason);
  });

  it.each([
    ["drawing flag", { drawingIncluded: true }, "drawing_requirement_unknown"],
    ["PDF drawing", { fileName: "drawing.PDF" }, "file_format_unknown"],
  ])("keeps unsupported %s unknown", (_label, overrides, reasonCode) => {
    expect(
      evaluateRapidDirectEnvelope(eligibleInput(overrides as Partial<RapidDirectEnvelopeInput>)),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining([reasonCode]),
    });
  });

  it("matches the canonical manifest and generated catalog", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, "provider-integrations/rapiddirect/manifest.v1.json"),
        "utf8",
      ),
    );

    expect(PROVIDER_CATALOG.rapiddirect.capabilityEnvelope).toEqual(manifest.capabilityEnvelope);
    expect(PROVIDER_CATALOG.rapiddirect).toMatchObject({
      officialRfqUrl: "https://app.rapiddirect.com/",
      adapterKind: "declarative_portal",
      processFamily: "multi_process",
      implementationStage: "envelope_defined",
    });
    expect(manifest.capabilityEnvelope.drawings).toEqual({
      status: "unknown",
      values: [],
    });
    expect(manifest.evidence.firstPartyUrls).toContain(
      "https://www.rapiddirect.com/services/cnc-machining/",
    );
  });

  runOfflineProviderEnvelopeContract({
    providerKey: "rapiddirect",
    sourceFileName: "rapiddirectEnvelope.ts",
    makeEligibleInput: eligibleInput,
    evaluate: evaluateRapidDirectEnvelope,
  });
});
