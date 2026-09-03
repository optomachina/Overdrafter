// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  evaluatePonokoEnvelope,
  PONOKO_ENVELOPE_REVISION,
  PONOKO_OFFLINE_AUTHORIZATION_BOUNDARY,
  type PonokoEnvelopeInput,
} from "./ponokoEnvelope.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

function makeEligibleInput(
  overrides: Partial<PonokoEnvelopeInput> = {},
): PonokoEnvelopeInput {
  return {
    process: "laser_cutting",
    material: "acrylic",
    fileName: "panel.svg",
    quantity: 1,
    accountMode: "existing_authenticated_account",
    drawingIncluded: false,
    explicitToleranceRequirement: false,
    explicitGeometryRequirements: false,
    ...overrides,
  };
}

describe("Ponoko evidence-backed envelope", () => {
  it.each(["laser_cutting", "laser_engraving"])(
    "accepts the exact reviewed %s package without authorizing interaction",
    (process) => {
      expect(evaluatePonokoEnvelope(makeEligibleInput({ process }))).toMatchObject({
        providerKey: "ponoko",
        state: "eligible_for_evaluation",
        envelopeRevision: PONOKO_ENVELOPE_REVISION,
        reasonCodes: ["eligible_evidence_backed_envelope"],
        authorizationBoundary: PONOKO_OFFLINE_AUTHORIZATION_BOUNDARY,
      });
    },
  );

  it.each(PROVIDER_CATALOG.ponoko.capabilityEnvelope.files.values)(
    "accepts supported extension %s case-insensitively",
    (extension) => {
      const decision = evaluatePonokoEnvelope(
        makeEligibleInput({ fileName: `PANEL.${extension.toUpperCase()}` }),
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
    const decision = evaluatePonokoEnvelope(makeEligibleInput({ quantity }));

    expect(decision.state).toBe("unsupported");
    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it("accepts both reviewed quantity boundaries", () => {
    expect(evaluatePonokoEnvelope(makeEligibleInput({ quantity: 1 })).state).toBe(
      "eligible_for_evaluation",
    );
    expect(evaluatePonokoEnvelope(makeEligibleInput({ quantity: 10000 })).state).toBe(
      "eligible_for_evaluation",
    );
  });

  it.each([
    ["missing process", { process: null }, "process_unknown"],
    ["other process", { process: "cnc_machining" }, "process_unknown"],
    ["missing material", { material: null }, "material_unknown"],
    ["other material", { material: "aluminum_6061" }, "material_unknown"],
    ["missing file", { fileName: "part" }, "file_format_unknown"],
    ["conditional STL", { fileName: "part.stl" }, "file_format_unknown"],
    ["missing account", { accountMode: null }, "account_mode_unknown"],
    ["other account", { accountMode: "guest" }, "account_mode_unknown"],
    ["drawing", { drawingIncluded: true }, "drawing_requirement_unknown"],
    ["unknown drawing fact", { drawingIncluded: null }, "drawing_requirement_unknown"],
  ])("keeps %s outside the reviewed envelope unknown", (_label, overrides, reasonCode) => {
    const decision = evaluatePonokoEnvelope(
      makeEligibleInput(overrides as Partial<PonokoEnvelopeInput>),
    );

    expect(decision.state).toBe("unknown");
    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it("accepts only the exact reviewed tolerance", () => {
    expect(
      evaluatePonokoEnvelope(
        makeEligibleInput({
          explicitToleranceRequirement: true,
          requestedToleranceMm: 0.127,
        }),
      ).state,
    ).toBe("eligible_for_evaluation");

    for (const requestedToleranceMm of [null, 0.126, 0.128, Number.NaN]) {
      const decision = evaluatePonokoEnvelope(
        makeEligibleInput({
          explicitToleranceRequirement: true,
          requestedToleranceMm,
        }),
      );

      expect(decision.state).toBe("unknown");
      expect(decision.reasonCodes).toContain("tolerance_requirement_unknown");
    }
  });

  it("keeps an unknown tolerance fact unknown", () => {
    expect(
      evaluatePonokoEnvelope(
        makeEligibleInput({ explicitToleranceRequirement: null }),
      ),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: ["tolerance_requirement_unknown"],
    });
  });

  it("routes explicit geometry constraints to manual review", () => {
    expect(
      evaluatePonokoEnvelope(
        makeEligibleInput({ explicitGeometryRequirements: true }),
      ),
    ).toMatchObject({
      state: "manual_review",
      reasonCodes: ["geometry_requires_manual_review"],
    });
  });

  it("keeps an unknown geometry fact unknown", () => {
    expect(
      evaluatePonokoEnvelope(
        makeEligibleInput({ explicitGeometryRequirements: null }),
      ),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: ["geometry_requirement_unknown"],
    });
  });

  it("is deterministic, non-mutating, and has no interaction-capable dependency", async () => {
    const source = await readFile(path.join(currentDir, "ponokoEnvelope.ts"), "utf8");
    const input = makeEligibleInput();
    const original = structuredClone(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      expect(evaluatePonokoEnvelope(input)).toEqual(evaluatePonokoEnvelope(input));
      expect(input).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(source).not.toMatch(/\b(?:playwright|browser|session|fetch|XMLHttpRequest|WebSocket)\b/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("matches the canonical manifest and generated worker catalog", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, "provider-integrations/ponoko/manifest.v1.json"), "utf8"),
    );

    expect(PROVIDER_CATALOG.ponoko.capabilityEnvelope).toEqual(manifest.capabilityEnvelope);
    expect(PROVIDER_CATALOG.ponoko).toMatchObject({
      officialRfqUrl: "https://www.ponoko.com/designs",
      adapterKind: "declarative_portal",
      processFamily: "sheet_fabrication",
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
    expect(allowlist).not.toContain("ponoko");
  });
});
