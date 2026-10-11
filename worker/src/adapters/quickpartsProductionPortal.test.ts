// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quoteWithRoutedDispatchPreflight } from "../dispatchRouting";
import { sha256File } from "../liveEvaluationFiles";
import { QUICKPARTS_DISPATCH_ENVELOPE } from "../providerDispatchEnvelope";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import { fictivDispatchAuthorization, fictivDispatchEnvelope } from "../../test-support/fictivDispatchFixture";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import { buildAdapterRegistry } from "./index";
import { providerDispatchAuthorizationDenial } from "./providerDispatchAuthorization";
import { runProviderPortalKernel } from "./providerPortalKernel";
import { buildQuickpartsProductionPortalDefinition, QUICKPARTS_ALLOWED_HOSTS } from "./quickpartsPortal";

/**
 * OVD-674: the production Quickparts branch is default-off. Without a current
 * generic provider-dispatch authorization for the reviewed Quickparts envelope,
 * bound to the staged bytes and quantity, there is zero provider interaction:
 * no session is read and no browser launches. Synthetic data only.
 */

const tempDirs: string[] = [];
afterEach(async () => {
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

async function expectRefusedBeforeLaunch(input: VendorQuoteAdapterInput, reason: string) {
  const { config, sessionRead } = observedConfig();
  const launchBrowser = vi.fn();
  await expect(
    runProviderPortalKernel(buildQuickpartsProductionPortalDefinition(), config, input, { launchBrowser }),
  ).rejects.toMatchObject({
    payload: { vendor: "quickparts", terminalState: "unsupported", reason, providerInteractionAttempted: false },
  });
  expect(launchBrowser).not.toHaveBeenCalled();
  expect(sessionRead).not.toHaveBeenCalled();
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
  it("launches nothing and reads no session without a provider-dispatch authorization", async () => {
    await expectRefusedBeforeLaunch(
      await authorizedInput({ providerDispatchAuthorization: undefined }),
      "dispatch_authorization_missing",
    );
  });

  it("refuses an authorization minted for a different provider", async () => {
    const input = await authorizedInput();
    const fictiv = fictivDispatchEnvelope({ cadSha256: input.stagedCadFile!.trustedContentSha256!, requestedQuantity: 3 });
    await expectRefusedBeforeLaunch(
      { ...input, providerDispatchAuthorization: fictivDispatchAuthorization(fictiv) },
      "dispatch_authorization_provider_mismatch",
    );
  });

  it("refuses an envelope revision that is not reviewed in code", async () => {
    const input = await authorizedInput();
    const authorization = structuredClone(input.providerDispatchAuthorization!);
    authorization.envelope.envelope = { id: "quickparts-quote-envelope", version: 2 };
    await expectRefusedBeforeLaunch(
      { ...input, providerDispatchAuthorization: authorization },
      "dispatch_authorization_envelope_unreviewed",
    );
  });

  it("refuses an expired or inconsistent permit lifetime", async () => {
    const input = await authorizedInput();
    for (const expiresAt of ["2020-01-01T00:00:00.000Z", "not-a-date"]) {
      const authorization = structuredClone(input.providerDispatchAuthorization!);
      authorization.expiresAt = expiresAt;
      authorization.envelope.expiresAt = expiresAt;
      await expectRefusedBeforeLaunch(
        { ...input, providerDispatchAuthorization: authorization },
        "dispatch_authorization_expired",
      );
    }
    const drifted = structuredClone(input.providerDispatchAuthorization!);
    drifted.expiresAt = "2098-01-01T00:00:00.000Z";
    await expectRefusedBeforeLaunch({ ...input, providerDispatchAuthorization: drifted }, "dispatch_authorization_expired");
  });

  it("refuses a quantity other than the authorized one", async () => {
    await expectRefusedBeforeLaunch(
      { ...(await authorizedInput()), requestedQuantity: 4 },
      "dispatch_authorization_quantity_mismatch",
    );
  });

  it("refuses staged bytes the authorization does not name", async () => {
    const input = await authorizedInput();
    await expectRefusedBeforeLaunch(
      { ...input, stagedCadFile: { ...input.stagedCadFile!, trustedContentSha256: "a".repeat(64) } },
      "dispatch_authorization_file_mismatch",
    );
  });

  it("refuses when the file on disk no longer hashes to the authorized bytes", async () => {
    const input = await authorizedInput();
    await fs.writeFile(input.stagedCadFile!.localPath, "swapped after authorization");
    await expectRefusedBeforeLaunch(input, "dispatch_authorization_file_mismatch");
  });

  it("refuses an authorization that would also disclose a drawing", async () => {
    const input = await authorizedInput();
    const authorization = structuredClone(input.providerDispatchAuthorization!);
    authorization.envelope.outboundFiles.push({
      role: "drawing", sourceSha256: "c".repeat(64), sha256: "c".repeat(64), derivation: "identity",
    });
    await expectRefusedBeforeLaunch(
      { ...input, providerDispatchAuthorization: authorization },
      "dispatch_authorization_file_mismatch",
    );
  });

  it("refuses a staged drawing and manual-quote CAD types before authorization is consulted", async () => {
    const input = await authorizedInput();
    await expectRefusedBeforeLaunch(
      { ...input, stagedDrawingFile: await stagedCad("drawing.pdf") },
      "drawing_upload_outside_adapter_contract",
    );
    const sldprt = await stagedCad("part.sldprt");
    await expectRefusedBeforeLaunch({ ...input, stagedCadFile: sldprt }, "cad_file_type_outside_envelope");
  });

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

  it("never launches a browser through the registered adapter without authorization", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const { config, sessionRead } = observedConfig();
    const adapter = buildAdapterRegistry(config).quickparts!;
    await expect(adapter.quote(await authorizedInput({ providerDispatchAuthorization: undefined })))
      .rejects.toMatchObject({ payload: { reason: "dispatch_authorization_missing", providerInteractionAttempted: false } });
    expect(launch).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("returns manual follow-up in simulate mode without touching the provider", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const { config, sessionRead } = observedConfig();
    // Mutate in place: a spread copy would itself invoke the observed getter.
    config.workerMode = "simulate";
    const adapter = buildAdapterRegistry(config).quickparts!;
    await expect(adapter.quote(await authorizedInput())).resolves.toMatchObject({
      status: "manual_vendor_followup",
      rawPayload: { reason: "simulate_hidden_vendor", providerMutationPossible: false },
    });
    expect(launch).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("refuses a live Quickparts task without a generic permit before the adapter runs", async () => {
    const quote = vi.fn();
    const rpc = vi.fn();
    await expect(quoteWithRoutedDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      config: { workerMode: "live", workerName: "worker-1" },
      task: { id: "00000000-0000-4000-8000-00000000674b", payload: {} },
      vendorQuoteResultId: "00000000-0000-4000-8000-000000006749",
      claimedAt: "2026-10-10T12:04:00.000Z",
      vendor: "quickparts",
      scopeSnapshot: {},
      adapter: { quote },
      quoteInput: await authorizedInput({ providerDispatchAuthorization: undefined }),
    })).rejects.toMatchObject({ reasonCode: "dispatch_live_provider_not_permitted" });
    expect(quote).not.toHaveBeenCalled();
  });

  it("declares the same hosts as the governed egress contract", async () => {
    const { STABLE_EGRESS_PROVIDER_HOSTS } = await import("../../../scripts/xometry-stable-egress-contract.mjs");
    expect([...STABLE_EGRESS_PROVIDER_HOSTS.quickparts]).toEqual([...QUICKPARTS_ALLOWED_HOSTS]);
    expect([...buildQuickpartsProductionPortalDefinition().allowedHosts]).toEqual([...QUICKPARTS_ALLOWED_HOSTS]);
  });
});
