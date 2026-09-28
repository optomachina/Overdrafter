// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { LIVE_AUTOMATION_VENDORS } from "../types.js";
import { createEvidenceBackedEnvelopeEvaluator } from "./evidenceBackedEnvelope.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("RMFG source envelope", () => {
  it("keeps a STEP CNC package ineligible despite the supported file extension", async () => {
    const manifest = JSON.parse(await readFile(
      path.join(repoRoot, "provider-integrations/rmfg/manifest.v1.json"),
      "utf8",
    ));
    const envelope = PROVIDER_CATALOG.rmfg.capabilityEnvelope;

    expect(envelope).toEqual(manifest.capabilityEnvelope);
    expect(envelope.processes.values).toEqual(["laser_cutting", "sheet_metal_fabrication"]);
    expect(envelope.files.values).toEqual(["step", "stp"]);
    expect(envelope.materials).toEqual({ status: "unknown", values: [] });
    expect(envelope.accountModes).toEqual({ status: "unknown", values: [] });

    const evaluate = createEvidenceBackedEnvelopeEvaluator({
      providerKey: "rmfg",
      envelopeRevision: "rmfg-public-source-v1",
      envelope,
      quantityMaximum: "unknown",
      drawingDisposition: "unknown",
      toleranceDisposition: "unknown",
      geometryDisposition: "unknown",
    });
    const decision = evaluate({
      process: "cnc_milling",
      material: "aluminum_6061",
      fileName: "bracket.step",
      quantity: 1,
      accountMode: "existing_authenticated_account",
      drawingIncluded: false,
      explicitToleranceRequirement: false,
      explicitGeometryRequirements: false,
      geometryWithinReviewedEnvelope: null,
    });

    expect(decision.state).not.toBe("eligible_for_evaluation");
    expect(decision.reasonCodes).toContain("process_unknown");
    expect(LIVE_AUTOMATION_VENDORS).not.toContain("rmfg");
  });
});
