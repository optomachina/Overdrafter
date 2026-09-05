import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
  type EvidenceBackedEnvelopeDecision,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

type ProviderEnvelopeContractOptions<TInput extends EvidenceBackedEnvelopeInput> = {
  providerKey: string;
  sourceFileName: string;
  makeEligibleInput: (overrides?: Partial<TInput>) => TInput;
  evaluate: (input: TInput) => EvidenceBackedEnvelopeDecision;
};

/** Registers the provider-neutral offline and default-off contract checks. */
export function runOfflineProviderEnvelopeContract<
  TInput extends EvidenceBackedEnvelopeInput,
>(options: ProviderEnvelopeContractOptions<TInput>): void {
  it("is deterministic, non-mutating, and has no interaction-capable dependency", async () => {
    const source = await readFile(path.join(currentDir, options.sourceFileName), "utf8");
    const input = options.makeEligibleInput();
    const original = structuredClone(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const firstDecision = options.evaluate(input);
      expect(firstDecision).toEqual(options.evaluate(input));
      expect(firstDecision.authorizationBoundary).toBe(
        OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
      );
      expect(input).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(source).not.toMatch(
        /\b(?:playwright|browser|session|fetch|XMLHttpRequest|WebSocket)\b/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("remains outside the production-certified live-offer allowlist", async () => {
    const source = await readFile(
      path.join(repoRoot, "src/features/quotes/sourcing-result.ts"),
      "utf8",
    );
    const allowlist = /PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS[^=]*=\s*\[([\s\S]*?)\]/
      .exec(source)?.[1] ?? "";

    expect(allowlist).toContain('"xometry"');
    expect(allowlist).not.toContain(options.providerKey);
  });

  it("requires an affirmative reviewed geometry fit before evaluation", () => {
    expect(
      options.evaluate(options.makeEligibleInput(
        { geometryWithinReviewedEnvelope: null } as Partial<TInput>,
      )),
    ).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining(["geometry_requirement_unknown"]),
    });
    expect(
      options.evaluate(options.makeEligibleInput(
        { geometryWithinReviewedEnvelope: false } as Partial<TInput>,
      )),
    ).toMatchObject({
      state: "unsupported",
      reasonCodes: expect.arrayContaining(["geometry_outside_supported_range"]),
    });
  });
}
