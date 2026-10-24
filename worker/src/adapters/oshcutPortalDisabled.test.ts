// @vitest-environment node
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapVendor } from "../tools/vendorAuth";
import { runEvaluationBatch, runQuote } from "../tools/vendorWorkflowSmoke";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows";
import { buildAdapterRegistry, buildLiveEvaluationAdapterRegistry } from "./index";
import { buildOshcutEvaluationDefinition } from "./oshcut";
import { OSHCUT_PORTAL_DISABLED_MESSAGE } from "./oshcutPortalDisabled";
import { buildOshcutProductionPortalDefinition } from "./oshcutProductionPortal";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow";
import { runProviderPortalKernel } from "./providerPortalKernel";

const workflow = getExtendedVendorWorkflow("oshcut")!;
const definitions = [buildOshcutProductionPortalDefinition(), buildOshcutEvaluationDefinition(workflow)];
const input = { executionContext: "live_evaluation" } as VendorQuoteAdapterInput;
const config = { workerMode: "live", workerLiveAdapters: ["oshcut"] } as WorkerConfig;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** Any read is evidence of reaching a page, session, or dependency too early. */
function untouched<T>() {
  const access = vi.fn(() => { throw new Error("Unexpected dependency access"); });
  return { value: new Proxy({}, { get: access }) as T, access };
}

describe("OSH Cut unconditional portal refusal (OVD-1022)", () => {
  it.each(["production_dispatch", "live_evaluation"] as const)("blocks either definition in %s before any dependency access", async (executionContext) => {
    const launch = vi.spyOn(chromium, "launch");
    for (const definition of definitions) {
      const observedConfig = untouched<WorkerConfig>();
      const dependencies = untouched<Parameters<typeof runProviderPortalKernel>[3]>();
      await expect(runProviderPortalKernel(definition, observedConfig.value, { ...input, executionContext }, dependencies.value))
        .rejects.toMatchObject({ message: OSHCUT_PORTAL_DISABLED_MESSAGE, payload: {
          reason: "oshcut_portal_automation_disabled", providerInteractionAttempted: false, providerMutationPossible: false,
        } });
      expect(observedConfig.access).not.toHaveBeenCalled();
      expect(dependencies.access).not.toHaveBeenCalled();
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it("blocks both registries and direct workflow quote/local evaluation despite live configuration", async () => {
    vi.stubEnv("WORKER_LIVE_ADAPTERS", "oshcut");
    const launch = vi.spyOn(chromium, "launch");
    const evaluation = buildLiveEvaluationAdapterRegistry(config).oshcut!;
    await expect(evaluation.evaluateLocally!(input)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    const adapters = [buildAdapterRegistry(config).oshcut!, evaluation];
    for (const adapter of adapters) await expect(adapter.quote(input)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    for (const definition of definitions) {
      const adapter = new PortalQuoteWorkflowAdapter("oshcut", config, workflow, definition);
      await expect(adapter.quote(input)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
      await expect(adapter.evaluateLocally(input)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it("blocks upload, configuration, and cleanup hooks before touching their page capabilities", async () => {
    for (const definition of definitions) {
      const page = untouched<never>();
      await expect(definition.hooks.beforeUpload!(page.value)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
      await expect(definition.hooks.configure(page.value, input, page.value)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
      await expect(definition.hooks.cleanup!(page.value, input)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
      expect(page.access).not.toHaveBeenCalled();
    }
  });

  it("blocks harness batches, direct harness quotes, and session bootstrap before setup or launch", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const dependencies = untouched<Parameters<typeof runEvaluationBatch>[1]>();
    const args = { vendors: ["oshcut"] } as Parameters<typeof runEvaluationBatch>[0];
    await expect(runEvaluationBatch(args, dependencies.value)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    const observedConfig = untouched<WorkerConfig>();
    await expect(runQuote(observedConfig.value, args, "oshcut", 1, {} as Parameters<typeof runQuote>[4]))
      .rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    await expect(bootstrapVendor("oshcut", null)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    expect(dependencies.access).not.toHaveBeenCalled();
    expect(observedConfig.access).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
