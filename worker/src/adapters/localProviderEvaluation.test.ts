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
import { buildQuickpartsProductionPortalDefinition } from "./quickpartsPortal.js";
import { buildGeomiqPortalDefinition } from "./geomiqPortal.js";
import { createWeergPortalDefinition } from "./weergPortal.js";
import { buildExpectedProviderPortalApproval } from "./providerPortalKernel.js";
import { PROVIDER_KILL_SWITCH_STATE_SCHEMA } from "../providerSettings.js";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow.js";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
// Quickparts evaluates through its production definition and reaches the provider (OVD-1059).
const offlineDefinitions = [
  createWeergPortalDefinition(),
  buildGeomiqPortalDefinition(),
];
const definitions = [buildQuickpartsProductionPortalDefinition(), ...offlineDefinitions];

async function stagedSyntheticCad() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "provider-registry-")));
  directories.push(dir);
  const cadPath = path.join(dir, "synthetic.step");
  await fs.writeFile(cadPath, "synthetic offline fixture, not a customer CAD file");
  const staged = await stageLiveEvaluationFiles({ cadPath, drawingPath: null, confirmedNonExportControlled: true });
  return { cadPath, staged };
}

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
  it.each(offlineDefinitions)("reports $provider preflight through the real CLI registry without session access", async (definition) => {
    const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new Error("Unexpected browser launch"));
    const { cadPath, staged } = await stagedSyntheticCad();
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

  /** An approved synthetic Quickparts run with no settings credentials, so no test can reach a database. */
  async function approvedQuickpartsRun() {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("WORKER_PROVIDER_DURABLE_DISPATCH_CAP", "");
    const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new Error("Unexpected browser launch"));
    const { cadPath, staged } = await stagedSyntheticCad();
    const args = parseSmokeArgs(["--vendor", "quickparts", "--cad", cadPath, "--confirm-non-export-controlled"]);
    const approval = buildExpectedProviderPortalApproval(buildQuickpartsProductionPortalDefinition(), {
      requestedQuantity: 1,
      liveEvaluationAuthorization: staged.authorization,
      providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [1] },
    } as VendorQuoteAdapterInput)!;
    return { launch, staged, args, approval };
  }

  it("stops an approved Quickparts evaluation at the kill switch before session access or launch", async () => {
    const { launch, staged, args, approval } = await approvedQuickpartsRun();
    const killSwitchReader = vi.fn(async () => { throw new Error("switch unreadable"); });
    try {
      await expect(runQuote(isolatedConfig(), args, "quickparts", 1, staged, undefined, null, approval, killSwitchReader))
        .rejects.toMatchObject({ reasonCode: "provider_kill_switch_unavailable", checkpoint: "before_launch" });
      expect(killSwitchReader).toHaveBeenCalledWith("quickparts");
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await staged.cleanup();
    }
  });

  it("runs an approved Quickparts evaluation through the production definition up to session lookup", async () => {
    const { launch, staged, args, approval } = await approvedQuickpartsRun();
    const disengaged = vi.fn(async () => ({
      schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider: "quickparts", engaged: false, globalEngaged: false,
    }));
    // No stored session: the production definition is eligible and stops at session lookup, where the
    // offline definition would already have returned quickparts_reviewed_portal_evidence_missing.
    const noSession = {
      workerMode: "live", workerLiveAdapters: ["quickparts"], workerTempDir: os.tmpdir(),
      vendorStorageStateJson: {}, vendorStorageStatePaths: {},
    } as unknown as WorkerConfig;
    try {
      const row = await runQuote(noSession, args, "quickparts", 1, staged, undefined, null, approval, disengaged);
      expect(row.errorPayload).toMatchObject({
        terminalState: "missing_session", reason: "missing_storage_state", providerInteractionAttempted: false,
      });
      expect(disengaged).toHaveBeenCalledWith("quickparts");
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

  it.each(definitions)("keeps $provider production dispatch off its local evaluation definition", async (definition) => {
    const adapter = buildAdapterRegistry(isolatedConfig())[definition.provider]!;
    // OVD-674 and OVD-675 give Quickparts and Weerg their own default-off
    // production definitions.
    const adapterRevision = ({
      quickparts: "quickparts-production-adapter.v1",
      weerg: "weerg-production-adapter.v1",
    } as Partial<Record<string, string>>)[definition.provider] ?? "generic-portal-reconnaissance.v2";
    await expect(adapter.quote({ executionContext: "production_dispatch" } as VendorQuoteAdapterInput)).rejects.toMatchObject({
      payload: { adapterRevision, reason: "missing_staged_cad_file" },
    });
  });

  it("rejects a definition bound to a different provider", () => {
    expect(() => new PortalQuoteWorkflowAdapter("quickparts", isolatedConfig(), getExtendedVendorWorkflow("quickparts")!, buildGeomiqPortalDefinition())).toThrow("must match");
  });
});
