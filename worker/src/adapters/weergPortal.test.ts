// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles.js";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";
import { evaluateProviderAdapterFailureContract } from "./providerAdapterContract.js";
import { buildExpectedProviderPortalApproval, normalizeAnchoredProviderOffers, type ProviderPortalOfferCandidate } from "./providerPortalKernel.js";
import { assessWeergEvaluationPackage, createWeergPortalDefinition, runWeergLocalEvaluationPreflight } from "./weergPortal.js";
import type { WeergEnvelopeInput } from "./weergEnvelope.js";

const facts: WeergEnvelopeInput = {
  process: "cnc_machining", material: "aluminum_6082", fileName: "synthetic.step",
  quantity: 2, accountMode: "existing_authenticated_account", drawingIncluded: false,
  explicitToleranceRequirement: false, explicitGeometryRequirements: false,
  geometryWithinReviewedEnvelope: true,
};
const input = () => ({
  executionContext: "live_evaluation", requestedQuantity: 2,
  stagedCadFile: { originalName: "synthetic.step", localPath: "/synthetic.step" },
  stagedDrawingFile: null, requirement: { material: "aluminum_6082" },
} as VendorQuoteAdapterInput);
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function authorizedInput() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "weerg-synthetic-"));
  dirs.push(dir);
  const cadPath = path.join(dir, "synthetic.step");
  await fs.writeFile(cadPath, "synthetic test bytes; not CAD");
  const raw = input();
  raw.stagedCadFile!.localPath = cadPath;
  raw.liveEvaluationAuthorization = { nonExportControlled: true, cadFileSha256: await sha256File(cadPath), drawingFileSha256: null };
  raw.stagedCadFile!.trustedContentSha256 = raw.liveEvaluationAuthorization.cadFileSha256;
  raw.providerPortalExecutionScope = { cadPath, drawingPath: null, requestedQuantities: [2] };
  const authorized = (await authorizeLiveEvaluationInput(raw))!;
  authorized.providerPortalApproval = buildExpectedProviderPortalApproval(createWeergPortalDefinition(facts), authorized)!;
  return authorized;
}

describe("Weerg offline preparation; no observed portal selectors", () => {
  it.each([
    { quantity: 3 }, { material: "aluminum_6061" }, { fileName: "other.step" }, { drawingIncluded: true },
  ])("rejects facts detached from actual package: %j", (override) => {
    expect(assessWeergEvaluationPackage(input(), { ...facts, ...override })).toEqual({ state: "unsupported", reason: "weerg_envelope_package_mismatch" });
  });
  it.each([
    { geometryWithinReviewedEnvelope: null }, { geometryWithinReviewedEnvelope: false },
    { explicitToleranceRequirement: true }, { explicitGeometryRequirements: true }, { process: null },
  ])("denies unknown, manual-review and unsupported envelopes: %j", (override) => {
    expect(assessWeergEvaluationPackage(input(), { ...facts, ...override }).state).toBe("unsupported");
  });
  it("copies envelope facts and cannot extract an unanchored price", async () => {
    const mutable = { ...facts };
    const definition = createWeergPortalDefinition(mutable);
    mutable.quantity = 10;
    expect(await definition.hooks.assessEligibility(input())).toEqual({ state: "unavailable", reason: "weerg_reviewed_portal_binding_missing" });
    expect(await definition.hooks.extractOffers({ count: vi.fn(), readText: vi.fn(), readTexts: vi.fn(), readAttribute: vi.fn() }, input())).toEqual([]);
  });
  it.each([
    ["session expired", "login_required"], ["captcha", "captcha"],
    ["manual review", "manual_review"], ["select material", "configuration_required"],
    ["service unavailable", "unavailable"], ["Total $99, 3 days", "selector_drift"],
  ])("classifies synthetic text %s as finite %s", async (bodyText, state) => {
    expect(await createWeergPortalDefinition(facts).hooks.classifyPortalState({ url: "https://www.weerg.com/", bodyText, passwordInputCount: 0 })).toBe(state);
  });
  it("rejects missing exact approval before browser launch", async () => {
    const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new Error("must not launch"));
    try {
      await runWeergLocalEvaluationPreflight({} as WorkerConfig, input(), facts);
      expect.fail("authorization must fail");
    } catch (error) {
      expect(evaluateProviderAdapterFailureContract(error).ok).toBe(true);
    }
    expect(launch).not.toHaveBeenCalled();
  });
  it("returns truthful missing binding even with exact authorization, without launch", async () => {
    const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new Error("must not launch"));
    const result = await runWeergLocalEvaluationPreflight({} as WorkerConfig, await authorizedInput(), facts);
    expect(result).toMatchObject({ state: "unavailable", reason: "weerg_reviewed_portal_binding_missing", offers: [], artifacts: [], providerMutationPossible: false });
    expect(launch).not.toHaveBeenCalled();
  });
  it("normalizes synthetic anchored options without inventing geography or validity", () => {
    const candidate = (id: string): ProviderPortalOfferCandidate => ({
      providerOptionId: id, providerLabel: id, quoteRef: null, quoteUrl: null, quantity: 2,
      unitPriceUsd: { value: 20, source: "selector", selector: "[synthetic-unit]" },
      totalPriceUsd: { value: 40, source: "selector", selector: "[synthetic-total]" },
      leadTimeBusinessDays: { value: 5, source: "selector", selector: "[synthetic-lead]" },
      shipReceiveBy: null, tier: null, sourcing: null, geographicOrigin: null, geographicOriginSource: "none",
      containerSelector: "[synthetic-option]", providerOptionIdSource: "attribute",
      validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null,
      rawPayload: {},
    });
    const normalized = normalizeAnchoredProviderOffers([candidate("synthetic-standard"), candidate("synthetic-fast")], { expectedQuantity: 2, allowedHosts: ["www.weerg.com"] });
    expect(normalized.map((offer) => offer.providerOptionId)).toEqual(["synthetic-standard", "synthetic-fast"]);
    for (const offer of normalized) expect(offer).toMatchObject({ quantity: 2, geographicOrigin: "unknown", validUntil: null, validityDurationDays: null, artifactRefs: [] });
    const unanchored = candidate("synthetic-unanchored");
    unanchored.totalPriceUsd = { value: 40, source: "body_text", selector: null };
    expect(normalizeAnchoredProviderOffers([unanchored], { expectedQuantity: 2, allowedHosts: ["www.weerg.com"] })).toEqual([]);
  });
});
