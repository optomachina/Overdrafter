// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles.js";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput, WorkerConfig } from "../types.js";
import { evaluateProviderAdapterContract } from "./providerAdapterContract.js";
import { buildExpectedProviderPortalApproval, normalizeAnchoredProviderOffers, runProviderPortalKernel, type ProviderPortalReadCapability } from "./providerPortalKernel.js";
import { buildQuickpartsOfflinePortalDefinition, extractQuickpartsSyntheticOffers } from "./quickpartsPortal.js";

// Invented data only; these attributes and options are not provider observations.
const fixture = { id: "synthetic-standard", label: "Synthetic standard", quantity: "1", "unit-price": "25.00", "total-price": "25.00", currency: "USD", "lead-business-days": "7" };
function reader(rows: Record<string, string>[] = [fixture]): ProviderPortalReadCapability {
  return {
    count: async () => rows.length,
    readTexts: async () => [],
    readAttribute: async (selector) => rows[Number(selector.match(/nth=(\d+)/)?.[1])]?.id ?? null,
    readText: async (selector) => {
      const row = rows[Number(selector.match(/nth=(\d+)/)?.[1])];
      const field = selector.match(/\[data-([\w-]+)\]$/)?.[1];
      return row?.[field ?? ""] ?? null;
    },
  };
}

describe("Quickparts offline portal preparation", () => {
  const definition = buildQuickpartsOfflinePortalDefinition();
  it("preserves stable multi-option IDs and unknown validity/geography through the shared contract", async () => {
    const candidates = await extractQuickpartsSyntheticOffers(reader([fixture, { ...fixture, id: "synthetic-fast", "lead-business-days": "3" }]), 1);
    const offers = normalizeAnchoredProviderOffers(candidates, { expectedQuantity: 1, allowedHosts: definition.allowedHosts });
    const output = { vendor: "quickparts", status: "instant_quote_received", unitPriceUsd: 25, totalPriceUsd: 25, leadTimeBusinessDays: 7, quoteUrl: null, offers, artifacts: [], rawPayload: { fixtureKind: "synthetic" } } as unknown as VendorQuoteAdapterOutput;
    const result = evaluateProviderAdapterContract({ definition, adapterInput: { requestedQuantity: 1 } as VendorQuoteAdapterInput, output });
    expect(result.violations).toEqual([]);
    expect(result.normalizedOffers.map((offer) => offer.providerOptionId)).toEqual(["synthetic-standard", "synthetic-fast"]);
    expect(offers.every((offer) => offer.geographicOrigin === "unknown" && offer.validUntil === null && offer.validitySource === null)).toBe(true);
  });
  it.each([
    { currency: "EUR" }, { "total-price": "$25" }, { "total-price": "24.00" },
    { quantity: "2" }, { id: "" }, { "unit-price": "NaN" }, { "unit-price": "0" },
  ])("refuses untrusted or mismatched option %j", async (change) => {
    expect(await extractQuickpartsSyntheticOffers(reader([{ ...fixture, ...change }]), 1)).toEqual([]);
  });
  it("refuses duplicate IDs and bounded overflow rather than selecting an arbitrary option", async () => {
    expect(await extractQuickpartsSyntheticOffers(reader([fixture, fixture]), 1)).toEqual([]);
    expect(await extractQuickpartsSyntheticOffers(reader(Array.from({ length: 21 }, () => fixture)), 1)).toEqual([]);
  });
  it("does not infer missing lead time or scan whole-page text", async () => {
    const source = reader([{ ...fixture, "lead-business-days": "" }]);
    const body = vi.spyOn(source, "readTexts");
    const result = await extractQuickpartsSyntheticOffers(source, 1);
    expect(result[0].leadTimeBusinessDays.value).toBeNull();
    expect(body).not.toHaveBeenCalled();
    expect(await extractQuickpartsSyntheticOffers(reader([]), 1)).toEqual([]);
  });
  it.each([
    ["https://other.example/", "", "unexpected_origin"],
    ["https://quickquote.quickparts.com/#/login", "", "login_required"],
    ["https://quickquote.quickparts.com/", "captcha", "captcha"],
    ["https://quickquote.quickparts.com/", "manual review", "manual_review"],
    ["https://quickquote.quickparts.com/", "select material", "configuration_required"],
    ["https://quickquote.quickparts.com/", "service unavailable", "unavailable"],
    ["https://quickquote.quickparts.com/", "$25 in 7 days", "selector_drift"],
  ])("classifies %s %s finitely", async (url, bodyText, expected) => {
    expect(await definition.hooks.classifyPortalState({ url, bodyText, passwordInputCount: 0 })).toBe(expected);
  });
  it("rejects missing exact authorization before any browser launch", async () => {
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(definition, {} as WorkerConfig, { stagedCadFile: { originalName: "part.step" }, requestedQuantity: 1 } as VendorQuoteAdapterInput, { launchBrowser })).rejects.toThrow();
    expect(launchBrowser).not.toHaveBeenCalled();
  });
  it("remains unavailable even with exact synthetic-file authorization, without reading a session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quickparts-offline-test-"));
    try {
      const cadPath = path.join(dir, "synthetic.step");
      await fs.writeFile(cadPath, "synthetic test bytes only");
      const digest = await sha256File(cadPath);
      const input = await authorizeLiveEvaluationInput({
        executionContext: "live_evaluation",
        stagedCadFile: { originalName: "synthetic.step", localPath: cadPath, trustedContentSha256: digest },
        stagedDrawingFile: null, requestedQuantity: 1,
        liveEvaluationAuthorization: { nonExportControlled: true, cadFileSha256: digest, drawingFileSha256: null },
        providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [1] },
      } as VendorQuoteAdapterInput);
      expect(input).not.toBeNull();
      input!.providerPortalApproval = buildExpectedProviderPortalApproval(definition, input!)!;
      const launchBrowser = vi.fn();
      const result = await runProviderPortalKernel(definition, {} as WorkerConfig, input!, { launchBrowser });
      expect(result).toMatchObject({ state: "unavailable", reason: "quickparts_reviewed_portal_evidence_missing", providerMutationPossible: false, offers: [] });
      expect(launchBrowser).not.toHaveBeenCalled();
      expect(await definition.hooks.extractOffers(reader(), input!)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
