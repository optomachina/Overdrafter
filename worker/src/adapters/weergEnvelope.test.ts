// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  evaluateWeergEnvelope,
  WEERG_ENVELOPE_REVISION,
  WEERG_OFFLINE_AUTHORIZATION_BOUNDARY,
  type WeergEnvelopeInput,
} from "./weergEnvelope.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

function makeEligibleInput(
  overrides: Partial<WeergEnvelopeInput> = {},
): WeergEnvelopeInput {
  return {
    process: "cnc_machining",
    material: "aluminum_6082",
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

describe("Weerg evidence-backed envelope", () => {
  it("accepts the exact reviewed package without authorizing interaction", () => {
    expect(evaluateWeergEnvelope(makeEligibleInput())).toEqual({
      providerKey: "weerg",
      state: "eligible_for_evaluation",
      envelopeRevision: WEERG_ENVELOPE_REVISION,
      reasonCodes: ["eligible_evidence_backed_envelope"],
      normalized: {
        process: "cnc_machining",
        material: "aluminum_6082",
        fileExtension: "step",
        quantity: 1,
        accountMode: "existing_authenticated_account",
        drawingIncluded: false,
        explicitToleranceRequirement: false,
        requestedToleranceMm: null,
        explicitGeometryRequirements: false,
        geometryWithinReviewedEnvelope: true,
      },
      authorizationBoundary: WEERG_OFFLINE_AUTHORIZATION_BOUNDARY,
    });
  });

  it.each(PROVIDER_CATALOG.weerg.capabilityEnvelope.files.values)(
    "accepts supported extension %s case-insensitively",
    (extension) => {
      const decision = evaluateWeergEnvelope(
        makeEligibleInput({ fileName: `BRACKET.${extension.toUpperCase()}` }),
      );

      expect(decision.state).toBe("eligible_for_evaluation");
      expect(decision.normalized.fileExtension).toBe(extension);
    },
  );

  it.each([
    ["zero", 0, "quantity_invalid"],
    ["negative", -1, "quantity_invalid"],
    ["fractional", 1.5, "quantity_invalid"],
    ["NaN", Number.NaN, "quantity_invalid"],
    ["infinite", Number.POSITIVE_INFINITY, "quantity_invalid"],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1, "quantity_invalid"],
    ["above maximum", 10001, "quantity_outside_supported_range"],
  ])("rejects %s quantity as unsupported", (_label, quantity, reasonCode) => {
    const decision = evaluateWeergEnvelope(makeEligibleInput({ quantity }));

    expect(decision.state).toBe("unsupported");
    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it.each([
    ["missing process", { process: null }, "process_unknown"],
    ["other process", { process: "sheet_fabrication" }, "process_unknown"],
    ["missing material", { material: null }, "material_unknown"],
    ["other material", { material: "aluminum_6061" }, "material_unknown"],
    ["missing file", { fileName: "part" }, "file_format_unknown"],
    ["other file", { fileName: "part.pdf" }, "file_format_unknown"],
    ["missing account", { accountMode: null }, "account_mode_unknown"],
    ["other account", { accountMode: "guest" }, "account_mode_unknown"],
  ])("keeps %s outside the reviewed envelope unknown", (_label, overrides, reasonCode) => {
    const decision = evaluateWeergEnvelope(
      makeEligibleInput(overrides as Partial<WeergEnvelopeInput>),
    );

    expect(decision.state).toBe("unknown");
    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it.each([
    ["drawing", { drawingIncluded: true }, "drawings_require_manual_review", "manual_review"],
    ["geometry", { explicitGeometryRequirements: true }, "geometry_requires_manual_review", "manual_review"],
    ["unknown drawing fact", { drawingIncluded: null }, "drawing_requirement_unknown", "unknown"],
    ["unknown geometry fit", { geometryWithinReviewedEnvelope: null }, "geometry_requirement_unknown", "unknown"],
    ["tolerance", { explicitToleranceRequirement: true }, "tolerance_requirement_unknown", "unknown"],
    ["unknown tolerance fact", { explicitToleranceRequirement: null }, "tolerance_requirement_unknown", "unknown"],
  ])("classifies %s conservatively", (_label, overrides, reasonCode, state) => {
    const decision = evaluateWeergEnvelope(
      makeEligibleInput(overrides as Partial<WeergEnvelopeInput>),
    );

    expect(decision.state).toBe(state);
    expect(decision.reasonCodes).toContain(reasonCode);
    expect(decision.authorizationBoundary).toBe(WEERG_OFFLINE_AUTHORIZATION_BOUNDARY);
  });

  it("rejects geometry outside Weerg's reviewed size envelope", () => {
    expect(
      evaluateWeergEnvelope(makeEligibleInput({ geometryWithinReviewedEnvelope: false })),
    ).toMatchObject({
      state: "unsupported",
      reasonCodes: ["geometry_outside_supported_range"],
    });
  });

  it("is deterministic, non-mutating, and has no interaction-capable dependency", async () => {
    const source = await readFile(path.join(currentDir, "weergEnvelope.ts"), "utf8");
    const input = makeEligibleInput();
    const original = structuredClone(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      expect(evaluateWeergEnvelope(input)).toEqual(evaluateWeergEnvelope(input));
      expect(input).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(source).not.toMatch(/\b(?:playwright|browser|session|fetch|XMLHttpRequest|WebSocket)\b/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("matches the canonical manifest and generated worker catalog", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, "provider-integrations/weerg/manifest.v1.json"), "utf8"),
    );

    expect(PROVIDER_CATALOG.weerg.capabilityEnvelope).toEqual(manifest.capabilityEnvelope);
    expect(PROVIDER_CATALOG.weerg).toMatchObject({
      officialRfqUrl: "https://www.weerg.com/",
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
    const allowlist = /PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS[^=]*=\s*\[([\s\S]*?)\]/
      .exec(source)?.[1] ?? "";

    expect(allowlist).toContain('"xometry"');
    expect(allowlist).not.toContain("weerg");
  });
});
