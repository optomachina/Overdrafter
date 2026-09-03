// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY } from "./evidenceBackedEnvelope.js";
import {
  evaluateRapidDirectEnvelope,
  RAPIDDIRECT_ENVELOPE_REVISION,
  type RapidDirectEnvelopeInput,
} from "./rapiddirectEnvelope.js";

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
    ["drawing flag", { drawingIncluded: true }],
    ["PDF drawing", { fileName: "drawing.PDF" }],
  ])("routes %s to manual review", (_label, overrides) => {
    expect(
      evaluateRapidDirectEnvelope(eligibleInput(overrides as Partial<RapidDirectEnvelopeInput>)),
    ).toMatchObject({
      state: "manual_review",
    });
  });

  it("is deterministic, non-mutating, and has no interaction-capable dependency", async () => {
    const source = await readFile(path.join(currentDir, "rapiddirectEnvelope.ts"), "utf8");
    const input = eligibleInput();
    const original = structuredClone(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      expect(evaluateRapidDirectEnvelope(input)).toEqual(evaluateRapidDirectEnvelope(input));
      expect(input).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(source).not.toMatch(/\b(?:playwright|browser|session|fetch|XMLHttpRequest|WebSocket)\b/);
    } finally {
      vi.unstubAllGlobals();
    }
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
  });

  it("remains absent from the production-certified allowlist", async () => {
    const source = await readFile(
      path.join(repoRoot, "src/features/quotes/sourcing-result.ts"),
      "utf8",
    );
    const allowlist = /PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS[^=]*=\s*\[([\s\S]*?)\]/
      .exec(source)?.[1] ?? "";

    expect(allowlist).toContain('"xometry"');
    expect(allowlist).not.toContain("rapiddirect");
  });
});
