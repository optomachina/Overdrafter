// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";
import { parseSmokeArgs, runQuote } from "../tools/vendorWorkflowSmoke.js";
import { buildAdapterRegistry, buildLiveEvaluationAdapterRegistry } from "./index.js";
import { buildQuickpartsOfflinePortalDefinition } from "./quickpartsPortal.js";
import { buildGeomiqPortalDefinition } from "./geomiqPortal.js";
import { createWeergPortalDefinition } from "./weergPortal.js";
import { buildExpectedProviderPortalApproval } from "./providerPortalKernel.js";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow.js";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const definitions = [
  buildQuickpartsOfflinePortalDefinition(),
  createWeergPortalDefinition(),
  buildGeomiqPortalDefinition(),
];

function isolatedConfig(): WorkerConfig {
  return {
    workerMode: "live",
    workerLiveAdapters: definitions.map((definition) => definition.provider),
    workerTempDir: os.tmpdir(),
    get vendorStorageStateJson() { throw new Error("Unexpected session access"); },
    get vendorStorageStatePaths() { throw new Error("Unexpected session access"); },
  } as WorkerConfig;
}

describe("local provider registry integration", () => {
  it.each(definitions)("reports $provider preflight through the real CLI registry without session access", async (definition) => {
    const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new Error("Unexpected browser launch"));
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "provider-registry-")));
    directories.push(dir);
    const cadPath = path.join(dir, "synthetic.step");
    await fs.writeFile(cadPath, "synthetic offline fixture, not a customer CAD file");
    const staged = await stageLiveEvaluationFiles({ cadPath, drawingPath: null, confirmedNonExportControlled: true });
    const args = parseSmokeArgs(["--vendor", definition.provider, "--cad", cadPath, "--confirm-non-export-controlled"]);
    const approval = buildExpectedProviderPortalApproval(definition, {
      requestedQuantity: 1,
      liveEvaluationAuthorization: staged.authorization,
      providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [1] },
    } as VendorQuoteAdapterInput)!;
    try {
      const row = await runQuote(isolatedConfig(), args, definition.provider, 1, staged, undefined, null, approval);
      expect(row.evidence).toMatchObject({
        adapterRevision: definition.adapterRevision,
        envelopeRevision: definition.envelopeRevision,
        manifestRevision: definition.manifestRevision,
        accountMode: definition.accountMode,
        terminalState: definition.provider === "weerg" ? "unsupported" : "unavailable",
        persistence: { localOnly: true, customerOfferPersistence: false },
      });
      expect(row.rawPayload ?? row.errorPayload).toMatchObject({ providerMutationPossible: false, quoteOnly: true, orderProhibited: true });
      expect(JSON.stringify(row)).not.toContain(cadPath);
      const rejected = await runQuote(isolatedConfig(), args, definition.provider, 1, staged, undefined, null, {
        ...approval, allowedOrigins: ["https://unapproved.invalid"],
      });
      expect(rejected.errorPayload).toMatchObject({ reason: "exact_provider_approval_mismatch", providerInteractionAttempted: false });
      expect(rejected.offers).toEqual([]);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await staged.cleanup();
    }
  });

  it.each(definitions)("requires exact file authorization for $provider before delegation", async (definition) => {
    const adapter = buildLiveEvaluationAdapterRegistry(isolatedConfig())[definition.provider]!;
    await expect(adapter.quote({ executionContext: "live_evaluation" } as VendorQuoteAdapterInput)).rejects.toMatchObject({
      payload: { reason: "evaluation_export_control_authorization_missing" },
    });
  });

  it.each(definitions)("keeps $provider production dispatch on its existing definition", async (definition) => {
    const adapter = buildAdapterRegistry(isolatedConfig())[definition.provider]!;
    await expect(adapter.quote({ executionContext: "production_dispatch" } as VendorQuoteAdapterInput)).rejects.toMatchObject({
      payload: { adapterRevision: "generic-portal-reconnaissance.v2", reason: "missing_staged_cad_file" },
    });
  });

  it("rejects a definition bound to a different provider", () => {
    expect(() => new PortalQuoteWorkflowAdapter("quickparts", isolatedConfig(), getExtendedVendorWorkflow("quickparts")!, buildGeomiqPortalDefinition())).toThrow("must match");
  });
});
