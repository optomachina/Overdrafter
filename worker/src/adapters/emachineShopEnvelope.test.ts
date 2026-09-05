// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import { OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY } from "./evidenceBackedEnvelope.js";
import {
  EMACHINESHOP_ENVELOPE_REVISION,
  evaluateEMachineShopEnvelope,
  type EMachineShopEnvelopeInput,
} from "./emachineShopEnvelope.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

function makeMatchingInput(
  overrides: Partial<EMachineShopEnvelopeInput> = {},
): EMachineShopEnvelopeInput {
  return {
    process: "cnc_machining",
    material: "aluminum",
    fileName: "bracket.step",
    quantity: 1,
    accountMode: "public_unauthenticated_quote_request",
    drawingIncluded: false,
    explicitToleranceRequirement: false,
    explicitGeometryRequirements: false,
    geometryWithinReviewedEnvelope: null,
    ...overrides,
  };
}

describe("eMachineShop evidence-backed guidance envelope", () => {
  it("keeps an otherwise matching package unknown without automation authority", () => {
    expect(evaluateEMachineShopEnvelope(makeMatchingInput())).toEqual({
      providerKey: "emachineshop",
      state: "unknown",
      envelopeRevision: EMACHINESHOP_ENVELOPE_REVISION,
      reasonCodes: ["geometry_requirement_unknown", "guidance_only_provider"],
      normalized: {
        process: "cnc_machining",
        material: "aluminum",
        fileExtension: "step",
        quantity: 1,
        accountMode: "public_unauthenticated_quote_request",
        drawingIncluded: false,
        explicitToleranceRequirement: false,
        requestedToleranceMm: null,
        explicitGeometryRequirements: false,
        geometryWithinReviewedEnvelope: null,
      },
      authorizationBoundary: OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
    });
  });

  it.each([2, 10_000, 100_000])(
    "keeps evidence-backed positive quantity %s unknown pending geometry evidence",
    (quantity) => {
      const decision = evaluateEMachineShopEnvelope(
        makeMatchingInput({ quantity }),
      );
      expect(decision.state).toBe("unknown");
      expect(decision.reasonCodes).toEqual([
        "geometry_requirement_unknown",
        "guidance_only_provider",
      ]);
    },
  );

  it("rejects quantities above the reviewed range without automating contact", () => {
    expect(evaluateEMachineShopEnvelope(makeMatchingInput({ quantity: 100_001 }))).toMatchObject({
      state: "unsupported",
      reasonCodes: expect.arrayContaining([
        "quantity_outside_supported_range",
        "guidance_only_provider",
      ]),
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid quantity %s", (quantity) => {
    const decision = evaluateEMachineShopEnvelope(
      makeMatchingInput({ quantity }),
    );
    expect(decision.state).toBe("unsupported");
    expect(decision.reasonCodes).toContain("quantity_invalid");
    expect(decision.reasonCodes).toContain("guidance_only_provider");
  });

  it.each([
    ["process", { process: "die_casting" }, "process_unknown"],
    ["material", { material: "brass" }, "material_unknown"],
    [
      "account mode",
      { accountMode: "existing_authenticated_account" },
      "account_mode_unknown",
    ],
    ["file", { fileName: "part.3mf" }, "file_format_unknown"],
    ["drawing fact", { drawingIncluded: null }, "drawing_requirement_unknown"],
    [
      "tolerance",
      { explicitToleranceRequirement: true },
      "tolerance_requirement_unknown",
    ],
    [
      "tolerance fact",
      { explicitToleranceRequirement: null },
      "tolerance_requirement_unknown",
    ],
    [
      "geometry",
      { explicitGeometryRequirements: true },
      "geometry_requirement_unknown",
    ],
    [
      "geometry fact",
      { explicitGeometryRequirements: null },
      "geometry_requirement_unknown",
    ],
  ])("keeps out-of-envelope %s unknown", (_label, overrides, reasonCode) => {
    const decision = evaluateEMachineShopEnvelope(
      makeMatchingInput(overrides as Partial<EMachineShopEnvelopeInput>),
    );
    expect(decision.state).toBe("unknown");
    expect(decision.reasonCodes).toContain(reasonCode);
    expect(decision.reasonCodes).toContain("guidance_only_provider");
  });

  it("never grants automated eligibility to a manifest-supported combination", () => {
    const envelope = PROVIDER_CATALOG.emachineshop.capabilityEnvelope;

    for (const process of envelope.processes.values) {
      for (const material of envelope.materials.values) {
        for (const extension of envelope.files.values) {
          const decision = evaluateEMachineShopEnvelope(
            makeMatchingInput({
              process,
              material,
              fileName: `part.${extension}`,
            }),
          );
          expect(decision.state).toBe("unknown");
          expect(decision.reasonCodes).toContain("geometry_requirement_unknown");
          expect(decision.reasonCodes).toContain("guidance_only_provider");
        }
      }
    }
  });

  it("requires manual review for drawings while retaining unknown geometry", () => {
    const decision = evaluateEMachineShopEnvelope(
      makeMatchingInput({ drawingIncluded: true }),
    );
    expect(decision.state).toBe("unknown");
    expect(decision.reasonCodes).toEqual([
      "drawings_require_manual_review",
      "geometry_requirement_unknown",
      "guidance_only_provider",
    ]);
  });

  it.each(["dxf", "stl", "obj", "pdf", "png", "jpg"])(
    "keeps conditional %s input unautomated instead of flattening compatibility",
    (extension) => {
      const decision = evaluateEMachineShopEnvelope(
        makeMatchingInput({ fileName: `part.${extension}` }),
      );
      expect(decision.state).toBe("unknown");
      expect(decision.reasonCodes).toEqual([
        "geometry_requirement_unknown",
        "file_requires_manual_review",
        "guidance_only_provider",
      ]);
      expect(
        PROVIDER_CATALOG.emachineshop.capabilityEnvelope.files.values,
      ).not.toContain(extension);
    },
  );

  it("is deterministic, non-mutating, and unable to launch network or browser activity", async () => {
    const source = await readFile(
      path.join(currentDir, "emachineShopEnvelope.ts"),
      "utf8",
    );
    const input = makeMatchingInput();
    const original = structuredClone(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      expect(evaluateEMachineShopEnvelope(input)).toEqual(
        evaluateEMachineShopEnvelope(input),
      );
      expect(input).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(source).not.toMatch(
        /\b(?:playwright|browser|session|fetch|XMLHttpRequest|WebSocket)\b/,
      );
      expect(source.match(/^import .* from /gm)).toEqual([
        "import { PROVIDER_CATALOG } from ",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("matches the canonical manifest and generated catalog projection", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(
          repoRoot,
          "provider-integrations/emachineshop/manifest.v1.json",
        ),
        "utf8",
      ),
    );

    expect(PROVIDER_CATALOG.emachineshop.capabilityEnvelope).toEqual(
      manifest.capabilityEnvelope,
    );
    expect(PROVIDER_CATALOG.emachineshop).toMatchObject({
      officialRfqUrl: null,
      adapterKind: "guidance_only",
      processFamily: "multi_process",
      implementationStage: "manual_quote",
    });
    expect(manifest.evidence.firstPartyUrls).toContain(
      "https://www.emachineshop.com/terms-and-order-policies/",
    );
  });

  it("remains outside the production-certified live-offer allowlist", async () => {
    const source = await readFile(
      path.join(repoRoot, "src/features/quotes/sourcing-result.ts"),
      "utf8",
    );
    const allowlist =
      /PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS[^=]*=\s*\[([\s\S]*?)\]/.exec(
        source,
      )?.[1] ?? "";

    expect(allowlist).toContain('"xometry"');
    expect(allowlist).not.toContain("emachineshop");
  });
});
