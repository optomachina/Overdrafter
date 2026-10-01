// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import { parseSmokeArgs, runQuote } from "../tools/vendorWorkflowSmoke.js";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";
import { buildAdapterRegistry, buildLiveEvaluationAdapterRegistry } from "./index.js";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow.js";
import { ProtolabsAdapter } from "./protolabs.js";

const candidates = ["rapiddirect", "protolabsnetwork", "protolabs"] as const;
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function config(): WorkerConfig {
  return {
    workerMode: "live",
    workerLiveAdapters: [...candidates],
    workerTempDir: os.tmpdir(),
    get vendorStorageStateJson() { throw new Error("Unexpected session access"); },
    get vendorStorageStatePaths() { throw new Error("Unexpected session access"); },
  } as WorkerConfig;
}

function trapDelegation() {
  return [
    vi.spyOn(PortalQuoteWorkflowAdapter.prototype, "quote").mockRejectedValue(new Error("Unexpected portal delegation")),
    vi.spyOn(ProtolabsAdapter.prototype, "quote").mockRejectedValue(new Error("Unexpected Protolabs delegation")),
  ];
}

async function fixture(fileName = "synthetic.step"): Promise<VendorQuoteAdapterInput> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-preflight-")));
  directories.push(dir);
  const localPath = path.join(dir, fileName);
  const bytes = "synthetic preflight fixture; no customer CAD";
  await fs.writeFile(localPath, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    executionContext: "live_evaluation",
    stagedCadFile: { originalName: fileName, localPath, trustedContentSha256: hash },
    stagedDrawingFile: null,
    requestedQuantity: 1,
    requirement: { material: "aluminum_6061", spec_snapshot: { process: "cnc_machining", geometryWithinReviewedEnvelope: true } },
    liveEvaluationAuthorization: { nonExportControlled: true, cadFileSha256: hash, drawingFileSha256: null },
  } as VendorQuoteAdapterInput;
}

describe("candidate envelope admission in the local evaluation registry", () => {
  it.each(candidates)("requires file approval before reading %s package facts", async (vendor) => {
    const delegates = trapDelegation();
    const input = {
      executionContext: "live_evaluation",
      get requirement() { throw new Error("Envelope evaluated before file approval"); },
    } as VendorQuoteAdapterInput;
    await expect(buildLiveEvaluationAdapterRegistry(config())[vendor]!.quote(input)).rejects.toMatchObject({
      payload: { reason: "evaluation_export_control_authorization_missing" },
    });
    delegates.forEach((delegate) => expect(delegate).not.toHaveBeenCalled());
  });

  it.each(candidates)("stops %s's unknown envelope before delegation or session access", async (vendor) => {
    const delegates = trapDelegation();
    await expect(buildLiveEvaluationAdapterRegistry(config())[vendor]!.quote(await fixture())).rejects.toMatchObject({
      payload: {
        vendor,
        reason: "candidate_envelope_unknown",
        terminalState: "unavailable",
        envelopeRevision: `${vendor}-envelope.v1`,
        adapterRevision: "candidate-evaluation-preflight.v1",
        providerInteractionAttempted: false,
        providerMutationPossible: false,
        customerLiveOfferEligible: false,
      },
    });
    delegates.forEach((delegate) => expect(delegate).not.toHaveBeenCalled());
  });

  it("rejects changed bytes before reporting an envelope result", async () => {
    const delegates = trapDelegation();
    const input = await fixture();
    await fs.writeFile(input.stagedCadFile!.localPath, "changed synthetic bytes");
    await expect(buildLiveEvaluationAdapterRegistry(config()).rapiddirect!.quote(input)).rejects.toMatchObject({
      payload: { reason: "evaluation_export_control_authorization_missing" },
    });
    delegates.forEach((delegate) => expect(delegate).not.toHaveBeenCalled());
  });

  it("records invalid quantity and unknown format without fabricating an offer", async () => {
    const delegates = trapDelegation();
    const input = await fixture("synthetic.dxf");
    input.requestedQuantity = 0;
    await expect(buildLiveEvaluationAdapterRegistry(config()).rapiddirect!.quote(input)).rejects.toMatchObject({
      payload: {
        reason: "candidate_envelope_unsupported",
        terminalState: "unsupported",
        eligibilityReason: expect.stringContaining("quantity_invalid"),
      },
    });
    delegates.forEach((delegate) => expect(delegate).not.toHaveBeenCalled());
  });

  it.each(["rapiddirect", "protolabsnetwork"] as const)("retains %s's exact envelope and adapter revisions in CLI evidence", async (vendor) => {
    const delegates = trapDelegation();
    const input = await fixture();
    const cadPath = input.stagedCadFile!.localPath;
    const staged = await stageLiveEvaluationFiles({ cadPath, drawingPath: null, confirmedNonExportControlled: true });
    try {
      const args = parseSmokeArgs(["--vendor", vendor, "--cad", cadPath, "--confirm-non-export-controlled"]);
      const row = await runQuote(config(), args, vendor, 1, staged);
      expect(row.offers).toEqual([]);
      expect(row.evidence).toMatchObject({
        providerKey: vendor,
        terminalState: "unavailable",
        envelopeRevision: `${vendor}-envelope.v1`,
        adapterRevision: "candidate-evaluation-preflight.v1",
        persistence: { localOnly: true, customerOfferPersistence: false },
      });
      expect(row.errorPayload).toMatchObject({ providerInteractionAttempted: false, quoteOnly: true, orderProhibited: true });
      expect(JSON.stringify(row)).not.toContain(cadPath);
      delegates.forEach((delegate) => expect(delegate).not.toHaveBeenCalled());
    } finally {
      await staged.cleanup();
    }
  });

  it("does not add Protolabs to the CLI's supported live-evaluation vendors", () => {
    expect(() => parseSmokeArgs(["--vendor", "protolabs", "--cad", "/unused", "--confirm-non-export-controlled"]))
      .toThrow("Missing or unsupported --vendor");
  });

  it.each(candidates)("leaves %s's production adapter delegation unchanged", async (vendor) => {
    const delegates = trapDelegation();
    const input = { executionContext: "production_dispatch" } as VendorQuoteAdapterInput;
    await expect(buildAdapterRegistry(config())[vendor]!.quote(input)).rejects.toThrow("Unexpected");
    expect(delegates.reduce((count, delegate) => count + delegate.mock.calls.length, 0)).toBe(1);
  });
});
