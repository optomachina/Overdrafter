// @vitest-environment node
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows";
import { buildOshcutEvaluationDefinition } from "./oshcut";
import { OSHCUT_PORTAL_DISABLED_MESSAGE } from "./oshcutPortalDisabled";
import { buildOshcutProductionPortalDefinition } from "./oshcutProductionPortal";
import { runProviderPortalKernel } from "./providerPortalKernel";

afterEach(() => vi.restoreAllMocks());

// OVD-1022: the former portal replay must not launch even a fixture browser.
describe("OSH Cut production portal refusal before browser launch", () => {
  it.each(["production_dispatch", "live_evaluation"] as const)("refuses %s without page or session access", async (executionContext) => {
    const launch = vi.spyOn(chromium, "launch");
    const launchBrowser = vi.fn();
    const access = vi.fn(() => { throw new Error("Unexpected session access"); });
    const config = new Proxy({}, { get: access }) as WorkerConfig;
    const definitions = [buildOshcutProductionPortalDefinition(), buildOshcutEvaluationDefinition(getExtendedVendorWorkflow("oshcut")!)];
    for (const definition of definitions) {
      await expect(runProviderPortalKernel(definition, config, { executionContext } as VendorQuoteAdapterInput, { launchBrowser }))
        .rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    }
    expect(access).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});
