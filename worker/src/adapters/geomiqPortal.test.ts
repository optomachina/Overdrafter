// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles.js";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";
import { evaluateProviderAdapterContract, evaluateProviderAdapterFailureContract } from "./providerAdapterContract.js";
import { buildExpectedProviderPortalApproval, normalizeAnchoredProviderOffers, runProviderPortalKernel } from "./providerPortalKernel.js";
import { buildGeomiqPortalDefinition, classifyGeomiqPortalState, extractGeomiqSyntheticOffers, runGeomiqLocalEvaluation } from "./geomiqPortal.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const definition = buildGeomiqPortalDefinition();
const config = {} as WorkerConfig;

async function syntheticInput(): Promise<VendorQuoteAdapterInput> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geomiq-offline-")));
  dirs.push(dir);
  const cadPath = path.join(dir, "synthetic.step");
  await fs.writeFile(cadPath, "synthetic contract fixture, not CAD");
  const digest = await sha256File(cadPath);
  const input = await authorizeLiveEvaluationInput({
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: { nonExportControlled: true, cadFileSha256: digest, drawingFileSha256: null },
    providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [5] },
    stagedCadFile: { originalName: "synthetic.step", localPath: cadPath, trustedContentSha256: digest },
    stagedDrawingFile: null,
    requestedQuantity: 5,
  } as VendorQuoteAdapterInput);
  if (!input) throw new Error("Synthetic input authorization failed");
  input.providerPortalApproval = buildExpectedProviderPortalApproval(definition, input)!;
  return input;
}

// Deliberately invented local anchors and values; no provider observation.
function fixtureReader(rows: Record<string, string>[]) {
  return {
    count: vi.fn(async () => rows.length),
    readText: vi.fn(async () => "unanchored price USD 999"),
    readTexts: vi.fn(async () => ["unanchored price USD 999"]),
    readAttribute: vi.fn(async (selector: string, attribute: string) => {
      const index = Number(selector.match(/nth-of-type\((\d+)\)/)?.[1]) - 1;
      return rows[index]?.[attribute] ?? null;
    }),
  };
}
const row = { "data-label": "Synthetic standard", "data-option-id": "synthetic-standard", "data-currency": "USD", "data-quantity": "5", "data-total": "100", "data-unit": "20", "data-lead-days": "7" };

describe("Geomiq offline kernel boundary", () => {
  it("has no browser launch without exact authorization", async () => {
    const launchBrowser = vi.fn();
    try {
      await runProviderPortalKernel(definition, config, { stagedCadFile: { originalName: "part.step" } } as VendorQuoteAdapterInput, { launchBrowser });
      throw new Error("Expected authorization failure");
    } catch (error) {
      expect(evaluateProviderAdapterFailureContract(error)).toMatchObject({ ok: true });
    }
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("stops before session access and launch even for exactly authorized synthetic files", async () => {
    const launchBrowser = vi.fn();
    const result = await runProviderPortalKernel(definition, config, await syntheticInput(), { launchBrowser });
    expect(result).toMatchObject({ state: "unavailable", reason: "geomiq_geometry_and_portal_evidence_unreviewed", offers: [], artifacts: [], providerMutationPossible: false });
    expect(launchBrowser).not.toHaveBeenCalled();
    expect(await runGeomiqLocalEvaluation(config, await syntheticInput())).toMatchObject({ state: "unavailable" });
  });

  it("rejects a changed exact origin tuple before any browser launch", async () => {
    const input = await syntheticInput();
    input.providerPortalApproval!.allowedOrigins = ["https://geomiq.com"];
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(definition, config, input, { launchBrowser })).rejects.toBeDefined();
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("never connects synthetic extraction to the runtime hook", async () => {
    const reader = fixtureReader([row]);
    expect(await definition.hooks.extractOffers(reader, {} as VendorQuoteAdapterInput)).toEqual([]);
    expect(reader.count).not.toHaveBeenCalled();
    expect(definition.selectors).toEqual({ cadUpload: ":not(*)" });
  });

  it.each([
    ["session expired", "login_required"], ["CAPTCHA", "captcha"],
    ["engineering review", "manual_review"], ["select material", "configuration_required"],
    ["service unavailable", "unavailable"], ["unsupported file", "unsupported"],
    ["USD 99, 3 days", "selector_drift"],
  ])("classifies synthetic %s as %s", (bodyText, state) => {
    expect(classifyGeomiqPortalState({ url: "https://app.geomiq.com/", bodyText, passwordInputCount: 0 })).toBe(state);
  });

  it.each([
    ["session expired; CAPTCHA", "captcha"],
    ["authentication required; verify you are human", "captcha"],
    ["session expired; engineering review", "login_required"],
    ["service unavailable; engineering review", "unavailable"],
    ["unsupported file; select material", "configuration_required"],
  ])("preserves the terminal priority for synthetic %s", (bodyText, state) => {
    expect(classifyGeomiqPortalState({ url: "https://app.geomiq.com/", bodyText, passwordInputCount: 0 })).toBe(state);
  });

  it("rejects recapture of changed approved bytes before eligibility or launch", async () => {
    const input = await syntheticInput();
    await fs.writeFile(input.stagedCadFile!.localPath, "changed synthetic bytes");
    const changedInput = { ...input };
    expect(await authorizeLiveEvaluationInput(changedInput)).toBeNull();
    const launchBrowser = vi.fn();
    const assessEligibility = vi.fn(definition.hooks.assessEligibility);
    await expect(runProviderPortalKernel({ ...definition, hooks: { ...definition.hooks, assessEligibility } }, config, changedInput, { launchBrowser })).rejects.toBeDefined();
    expect(assessEligibility).not.toHaveBeenCalled();
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it.each(["quantity", "account", "provider"])("rejects changed approved %s scope before eligibility or launch", async (field) => {
    const input = await syntheticInput();
    if (field === "quantity") input.providerPortalApproval!.requestedQuantities = [6];
    if (field === "account") Object.assign(input.providerPortalApproval!, { accountMode: "anonymous" });
    if (field === "provider") input.providerPortalApproval!.providerKey = "quickparts";
    const launchBrowser = vi.fn();
    const assessEligibility = vi.fn(definition.hooks.assessEligibility);
    await expect(runProviderPortalKernel({ ...definition, hooks: { ...definition.hooks, assessEligibility } }, config, input, { launchBrowser })).rejects.toBeDefined();
    expect(assessEligibility).not.toHaveBeenCalled();
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("rejects an unexpected origin even with recognizable text", () => {
    expect(classifyGeomiqPortalState({ url: "https://evil.app.geomiq.com/", bodyText: "engineering review", passwordInputCount: 0 })).toBe("unexpected_origin");
  });
});

describe("Geomiq synthetic anchored offer contract", () => {
  it("preserves stable multi-option identity, prices, lead, quantity, provenance and unknowns", async () => {
    const reader = fixtureReader([row, { ...row, "data-option-id": "synthetic-expedited", "data-total": "150", "data-unit": "30", "data-lead-days": "3" }]);
    const candidates = await extractGeomiqSyntheticOffers(reader, 5);
    const offers = normalizeAnchoredProviderOffers(candidates, { expectedQuantity: 5, allowedHosts: definition.allowedHosts });
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({ providerOptionId: "synthetic-standard", quantity: 5, totalPriceUsd: 100, leadTimeBusinessDays: 7, geographicOrigin: "unknown", validUntil: null, validitySource: null, provenance: { priceSource: "selector", leadTimeSource: "selector", geographicOriginSource: "none" } });
    const contract = evaluateProviderAdapterContract({ definition, adapterInput: { requestedQuantity: 5 } as VendorQuoteAdapterInput, output: {
      vendor: "geomiq", status: "instant_quote_received", unitPriceUsd: 20, totalPriceUsd: 100, leadTimeBusinessDays: 7, quoteUrl: null,
      validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null,
      offers, dfmIssues: [], notes: [], artifacts: [], rawPayload: { syntheticFixture: true, providerObserved: false, terminalState: "offers_extracted" },
    } });
    expect(contract.violations).toEqual([]);
    expect(reader.readText).not.toHaveBeenCalled();
    expect(reader.readTexts).not.toHaveBeenCalled();
  });

  it.each([
    { "data-currency": "GBP" }, { "data-total": "100 USD" }, { "data-total": "101" },
    { "data-quantity": "4" }, { "data-lead-days": "soon" }, { "data-option-id": "" },
    { "data-unit": "-20" }, { "data-lead-days": "3.5" },
  ])("rejects ambiguous fixture fields %j without a partial result", async (changed) => {
    expect(await extractGeomiqSyntheticOffers(fixtureReader([{ ...row, ...changed }]), 5)).toEqual([]);
  });

  it("rejects duplicate IDs and excessive option counts", async () => {
    expect(await extractGeomiqSyntheticOffers(fixtureReader([row, row]), 5)).toEqual([]);
    expect(await extractGeomiqSyntheticOffers(fixtureReader(Array.from({ length: 21 }, () => row)), 5)).toEqual([]);
  });

  it.each([
    { "data-quantity": "5.0000000000000001" },
    { "data-quantity": "4.9999999999999999" },
    { "data-lead-days": "7.0000000000000001" },
    { "data-lead-days": "9007199254740990.1" },
    ...["0", "-1", "9007199254740992", "5e0", "+5", "5.", "5 days"].flatMap((value) => [
      { "data-quantity": value }, { "data-lead-days": value },
    ]),
  ])("rejects invalid integer evidence %j including either malformed sibling order", async (changed) => {
    const invalid = { ...row, ...changed, "data-option-id": "synthetic-invalid" };
    for (const rows of [[invalid], [row, invalid], [invalid, row]]) {
      expect(await extractGeomiqSyntheticOffers(fixtureReader(rows), 5)).toEqual([]);
    }
  });

  it.each([
    ["5", "7", 7],
    ["5.000", "7.0000", 7],
    ["5.0", "9007199254740991.000", Number.MAX_SAFE_INTEGER],
  ])("preserves positive integer evidence %s / %s including zero-only padding", async (quantity, lead, expectedLead) => {
    const candidates = await extractGeomiqSyntheticOffers(fixtureReader([
      { ...row, "data-quantity": quantity, "data-lead-days": lead },
    ]), 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ quantity: 5, leadTimeBusinessDays: { value: expectedLead } });
  });

  it.each([
    { "data-unit": "20.001", "data-total": "100.005" },
    { "data-unit": "20", "data-total": "100.001" },
    { "data-unit": "0.0000000000000000001", "data-total": "0.0000000000000000005" },
    { "data-unit": "90071992547410", "data-total": "450359962737050" },
    // Unit cents are safe, but total cents and their product are not.
    { "data-unit": "18014398509481.99", "data-total": "90071992547409.95" },
    // Both observed prices are safe; the quantity product alone overflows.
    { "data-unit": "45035996273704.96", "data-total": "90071992547409.91", "data-quantity": "2" },
    { "data-unit": "20", "data-total": "100.02" },
    { "data-unit": "20", "data-total": "99.98" },
  ])("rejects invalid money %j and either ordering of a malformed sibling", async (changed) => {
    const invalid = { ...row, ...changed, "data-option-id": "synthetic-invalid" };
    const quantity = Number(invalid["data-quantity"]);
    const valid = { ...row, "data-quantity": String(quantity), "data-total": String(20 * quantity) };
    for (const rows of [[invalid], [valid, invalid], [invalid, valid]]) {
      expect(await extractGeomiqSyntheticOffers(fixtureReader(rows), quantity)).toEqual([]);
    }
  });

  it.each([
    ["20.00", "100.00", 100],
    ["20.0000", "100.00000", 100],
    ["20.00", "100.01", 100.01],
    ["20.00", "99.99", 99.99],
  ])("preserves cent-accurate prices %s / %s and the one-cent tolerance", async (unit, total, expectedTotal) => {
    const candidates = await extractGeomiqSyntheticOffers(fixtureReader([
      { ...row, "data-unit": unit, "data-total": total },
    ]), 5);
    const offers = normalizeAnchoredProviderOffers(candidates, { expectedQuantity: 5, allowedHosts: definition.allowedHosts });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ unitPriceUsd: 20, totalPriceUsd: expectedTotal, quantity: 5 });
  });
});
