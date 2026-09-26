// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  evaluateFictivEnvelope,
  FICTIV_ENVELOPE_REVISION,
  type FictivEnvelopeInput,
} from "./fictivEnvelope.js";
import { runOfflineProviderEnvelopeContract } from "./providerEnvelopeContractTest.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function makeReviewedInput(overrides: Partial<FictivEnvelopeInput> = {}): FictivEnvelopeInput {
  return {
    process: "cnc_machining",
    material: "aluminum_6061",
    fileName: "bracket.step",
    quantity: 1,
    accountMode: "existing_authenticated_account",
    drawingIncluded: false,
    explicitToleranceRequirement: false,
    explicitGeometryRequirements: false,
    geometryWithinReviewedEnvelope: true,
    ...overrides,
  };
}

describe("Fictiv public-evidence envelope", () => {
  it.each(["step", "stp"])("classifies a reviewed CNC 6061 %s package for offline evaluation", (extension) => {
    const decision = evaluateFictivEnvelope(makeReviewedInput({ fileName: `part.${extension}` }));
    expect(decision).toMatchObject({
      providerKey: "fictiv",
      state: "eligible_for_evaluation",
      envelopeRevision: FICTIV_ENVELOPE_REVISION,
      reasonCodes: ["eligible_evidence_backed_envelope"],
    });
  });

  it.each(["iges", "f3d", "stl", "sldasm"])(
    "rejects first-party documented unsupported CNC file %s",
    (extension) => {
      const decision = evaluateFictivEnvelope(makeReviewedInput({ fileName: `part.${extension}` }));
      expect(decision.state).toBe("unsupported");
      expect(decision.reasonCodes).toContain("file_format_unsupported");
      expect(decision.reasonCodes).not.toContain("eligible_evidence_backed_envelope");
    },
  );

  it("keeps unproved files and values unknown rather than eligible", () => {
    for (const overrides of [
      { fileName: "part.3mf" },
      { material: "steel" },
      { process: "sheet_metal" },
      { accountMode: "guest" },
      { drawingIncluded: true },
      { explicitToleranceRequirement: true },
    ]) {
      expect(evaluateFictivEnvelope(makeReviewedInput(overrides))).toMatchObject({
        state: "unknown",
      });
    }
  });

  it("keeps larger quantities unproved and rejects invalid quantities", () => {
    expect(evaluateFictivEnvelope(makeReviewedInput({ quantity: 2 }))).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining(["quantity_above_reviewed_minimum_unknown"]),
    });
    expect(evaluateFictivEnvelope(makeReviewedInput({ quantity: 0 }))).toMatchObject({
      state: "unsupported",
      reasonCodes: expect.arrayContaining(["quantity_invalid"]),
    });
  });

  it("projects only the canonical Fictiv manifest and preserves the Xometry envelope", async () => {
    const fictivManifest = JSON.parse(await readFile(
      path.join(repoRoot, "provider-integrations/fictiv/manifest.v1.json"), "utf8",
    ));
    const xometryManifest = JSON.parse(await readFile(
      path.join(repoRoot, "provider-integrations/xometry/manifest.v1.json"), "utf8",
    ));
    expect(PROVIDER_CATALOG.fictiv.capabilityEnvelope).toEqual(fictivManifest.capabilityEnvelope);
    expect(PROVIDER_CATALOG.xometry.capabilityEnvelope).toEqual(xometryManifest.capabilityEnvelope);
    expect(fictivManifest.evidence.firstPartyUrls).toContain(
      "https://www.fictiv.com/help/uploading-and-organizing-parts/what-file-formats-does-fictiv-support",
    );
  });

  runOfflineProviderEnvelopeContract({
    providerKey: "fictiv",
    sourceFileName: "fictivEnvelope.ts",
    makeEligibleInput: makeReviewedInput,
    evaluate: evaluateFictivEnvelope,
  });
});
