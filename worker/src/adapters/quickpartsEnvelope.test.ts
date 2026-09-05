// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  evaluateQuickpartsEnvelope,
  QUICKPARTS_ENVELOPE_REVISION,
  QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY,
  type QuickpartsEnvelopeInput,
} from "./quickpartsEnvelope.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

function makeEligibleInput(
  overrides: Partial<QuickpartsEnvelopeInput> = {},
): QuickpartsEnvelopeInput {
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

describe("Quickparts evidence-backed envelope", () => {
  it("accepts the exact reviewed CNC package without authorizing interaction", () => {
    expect(evaluateQuickpartsEnvelope(makeEligibleInput())).toEqual({
      providerKey: "quickparts",
      state: "eligible_for_evaluation",
      envelopeRevision: QUICKPARTS_ENVELOPE_REVISION,
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
      authorizationBoundary: QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY,
    });
  });

  it.each(PROVIDER_CATALOG.quickparts.capabilityEnvelope.files.values)(
    "accepts supported extension %s case-insensitively",
    (extension) => {
      const decision = evaluateQuickpartsEnvelope(
        makeEligibleInput({ fileName: `BRACKET.${extension.toUpperCase()}` }),
      );
      expect(decision.state).toBe("eligible_for_evaluation");
      expect(decision.normalized.fileExtension).toBe(extension);
    },
  );

  it("routes SLDPRT to a manual quote without treating it as instant-compatible", () => {
    expect(
      evaluateQuickpartsEnvelope(makeEligibleInput({ fileName: "part.SLDPRT" })),
    ).toMatchObject({
      state: "manual_review",
      reasonCodes: ["file_requires_manual_review"],
      authorizationBoundary: QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects invalid quantity %s as unsupported input",
    (quantity) => {
      const decision = evaluateQuickpartsEnvelope(makeEligibleInput({ quantity }));
      expect(decision.state).toBe("unsupported");
      expect(decision.reasonCodes).toContain("quantity_invalid");
    },
  );

  it("keeps quantities above the proved minimum unknown", () => {
    expect(evaluateQuickpartsEnvelope(makeEligibleInput({ quantity: 2 }))).toMatchObject({
      state: "unknown",
      reasonCodes: ["quantity_above_reviewed_minimum_unknown"],
    });
  });

  it.each([
    ["missing process", { process: null }, "process_unknown"],
    ["other process", { process: "sheet_metal" }, "process_unknown"],
    ["missing material", { material: null }, "material_unknown"],
    ["other material", { material: "aluminum_7075" }, "material_unknown"],
    ["missing account", { accountMode: null }, "account_mode_unknown"],
    ["other account", { accountMode: "guest" }, "account_mode_unknown"],
    ["missing format", { fileName: "part" }, "file_format_unknown"],
    ["other format", { fileName: "part.dxf" }, "file_format_unknown"],
    ["drawing", { drawingIncluded: true }, "drawing_requirement_unknown"],
    ["missing drawing fact", { drawingIncluded: null }, "drawing_requirement_unknown"],
    ["tolerance", { explicitToleranceRequirement: true }, "tolerance_requirement_unknown"],
    ["missing tolerance fact", { explicitToleranceRequirement: null }, "tolerance_requirement_unknown"],
    ["geometry", { explicitGeometryRequirements: true }, "geometry_requirement_unknown"],
    ["missing geometry fit", { geometryWithinReviewedEnvelope: null }, "geometry_requirement_unknown"],
  ])("keeps %s unknown", (_label, overrides, reasonCode) => {
    const decision = evaluateQuickpartsEnvelope(
      makeEligibleInput(overrides as Partial<QuickpartsEnvelopeInput>),
    );
    expect(decision.state).toBe("unknown");
    expect(decision.reasonCodes).toContain(reasonCode);
    expect(decision.authorizationBoundary).toBe(QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY);
  });

  it("rejects geometry outside the reviewed machining envelope", () => {
    expect(
      evaluateQuickpartsEnvelope(makeEligibleInput({ geometryWithinReviewedEnvelope: false })),
    ).toMatchObject({
      state: "unsupported",
      reasonCodes: ["geometry_outside_supported_range"],
    });
  });

  it("is deterministic, non-mutating, and has no interaction-capable dependency", async () => {
    const sourcePath = path.join(currentDir, "quickpartsEnvelope.ts");
    const source = await readFile(sourcePath, "utf8");
    const input = makeEligibleInput();
    const original = structuredClone(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      expect(evaluateQuickpartsEnvelope(input)).toEqual(evaluateQuickpartsEnvelope(input));
      expect(input).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(source).not.toMatch(/\b(?:playwright|browser|session|fetch|XMLHttpRequest|WebSocket)\b/);
      expect(source.match(/^import .* from /gm)).toEqual([
        'import { PROVIDER_CATALOG } from ',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("matches the canonical manifest and worker catalog", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, "provider-integrations/quickparts/manifest.v1.json"), "utf8"),
    );

    expect(PROVIDER_CATALOG.quickparts.capabilityEnvelope).toEqual(manifest.capabilityEnvelope);
    expect(PROVIDER_CATALOG.quickparts).toMatchObject({
      officialRfqUrl: "https://quickparts.com/quickquote/",
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
    expect(allowlist).not.toContain("quickparts");
  });
});
