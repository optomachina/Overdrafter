// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../liveEvaluationFiles";
import { QUICKPARTS_DISPATCH_ENVELOPE } from "../providerDispatchEnvelope";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import { fictivDispatchAuthorization, fictivDispatchEnvelope } from "../../test-support/fictivDispatchFixture";
import {
  registerProductionPortalAuthorizationRefusals,
  registerProductionPortalRoutingRefusals,
  type ProductionPortalDefaultDenyHarness,
} from "../../test-support/productionPortalDefaultDeny";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import { buildAdapterRegistry } from "./index";
import { providerDispatchAuthorizationDenial } from "./providerDispatchAuthorization";
import { buildQuickpartsProductionPortalDefinition, QUICKPARTS_ALLOWED_HOSTS } from "./quickpartsPortal";

/**
 * OVD-674: the production Quickparts branch is default-off. Without a current
 * generic provider-dispatch authorization for the reviewed Quickparts envelope,
 * bound to the staged bytes and quantity, there is zero provider interaction:
 * no session is read and no browser launches. Synthetic data only.
 */

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });

/** A live config whose session lookups are observable. */
function observedConfig() {
  const sessionRead = vi.fn(() => ({ quickparts: STORAGE_STATE }));
  const config = {
    workerMode: "live",
    workerLiveAdapters: ["quickparts"],
    workerTempDir: os.tmpdir(),
    browserTimeoutMs: 100,
    playwrightHeadless: true,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: false,
    vendorStorageStatePaths: {},
    vendorStorageStateDir: null,
  } as unknown as WorkerConfig;
  Object.defineProperty(config, "vendorStorageStateJson", { get: sessionRead, enumerable: true });
  return { config, sessionRead };
}

async function stagedCad(name = "part.step", bytes = "synthetic quickparts cad bytes") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quickparts-production-"));
  tempDirs.push(dir);
  const localPath = path.join(dir, name);
  await fs.writeFile(localPath, bytes);
  return { originalName: name, localPath, storageBucket: "job-files", storagePath: `cad/${name}`, trustedContentSha256: await sha256File(localPath) };
}

async function authorizedInput(overrides: Partial<VendorQuoteAdapterInput> = {}): Promise<VendorQuoteAdapterInput> {
  const cad = await stagedCad();
  const envelope = quickpartsDispatchEnvelope({ cadSha256: cad.trustedContentSha256, requestedQuantity: 3 });
  return {
    organizationId: envelope.subject.organizationId,
    quoteRunId: envelope.task.quoteRunId,
    requestedQuantity: 3,
    executionContext: "production_dispatch",
    stagedCadFile: cad,
    stagedDrawingFile: null,
    providerDispatchAuthorization: quickpartsDispatchAuthorization(envelope),
    ...overrides,
  } as unknown as VendorQuoteAdapterInput;
}

function defaultDenyHarness(): ProductionPortalDefaultDenyHarness {
  return {
    vendor: "quickparts",
    envelopeId: "quickparts-quote-envelope",
    taskId: "00000000-0000-4000-8000-00000000674b",
    vendorQuoteResultId: "00000000-0000-4000-8000-000000006749",
    claimedAt: "2026-10-10T12:04:00.000Z",
    unauthorizedCadName: "part.sldprt",
    otherProviderAuthorization: (input: VendorQuoteAdapterInput) => {
      const fictiv = fictivDispatchEnvelope({
        cadSha256: input.stagedCadFile!.trustedContentSha256!,
        requestedQuantity: 3,
      });
      return fictivDispatchAuthorization(fictiv);
    },
    buildDefinition: buildQuickpartsProductionPortalDefinition,
    observedConfig,
    authorizedInput,
    stagedCad,
  };
}

describe("Quickparts production dispatch envelope (OVD-674)", () => {
  it("declares the Quickparts envelope on the production portal definition", () => {
    expect(buildQuickpartsProductionPortalDefinition().productionDispatch).toEqual({
      envelope: { ...QUICKPARTS_DISPATCH_ENVELOPE },
    });
  });

  it("keeps the offline evaluation definition out of production dispatch", async () => {
    const { buildQuickpartsOfflinePortalDefinition } = await import("./quickpartsPortal");
    expect(buildQuickpartsOfflinePortalDefinition().productionDispatch).toBeUndefined();
  });
});

describe("Quickparts production branch default-deny (OVD-674)", () => {
  registerProductionPortalAuthorizationRefusals(defaultDenyHarness());

  it("accepts exactly the authorized bytes and quantity at the adapter seam", async () => {
    expect(providerDispatchAuthorizationDenial(await authorizedInput(), {
      provider: "quickparts", ...QUICKPARTS_DISPATCH_ENVELOPE,
    })).toBeNull();
  });
});

describe("Quickparts production registry and routing (OVD-674)", () => {
  it("is absent from a live worker that does not list quickparts", () => {
    const { config } = observedConfig();
    expect(buildAdapterRegistry({ ...config, workerLiveAdapters: ["xometry"] } as WorkerConfig).quickparts)
      .toBeUndefined();
  });

  registerProductionPortalRoutingRefusals(defaultDenyHarness());

  it("declares the same hosts as the governed egress contract", async () => {
    const { STABLE_EGRESS_PROVIDER_HOSTS } = await import("../../../scripts/xometry-stable-egress-contract.mjs");
    expect([...STABLE_EGRESS_PROVIDER_HOSTS.quickparts]).toEqual([...QUICKPARTS_ALLOWED_HOSTS]);
    expect([...buildQuickpartsProductionPortalDefinition().allowedHosts]).toEqual([...QUICKPARTS_ALLOWED_HOSTS]);
  });
});
