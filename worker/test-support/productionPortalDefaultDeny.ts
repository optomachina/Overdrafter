import type { SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { quoteWithRoutedDispatchPreflight } from "../src/dispatchRouting.js";
import type { ProviderDispatchAuthorization } from "../src/providerDispatchTypes.js";
import type { VendorName, VendorQuoteAdapterInput, WorkerConfig } from "../src/types.js";
import { buildAdapterRegistry } from "../src/adapters/index.js";
import type { ProviderPortalDefinition } from "../src/adapters/providerPortalKernel.js";
import { runProviderPortalKernel } from "../src/adapters/providerPortalKernel.js";

export type ProductionPortalDefaultDenyHarness = {
  vendor: VendorName;
  envelopeId: string;
  taskId: string;
  vendorQuoteResultId: string;
  claimedAt: string;
  unauthorizedCadName: string;
  otherProviderAuthorization: (input: VendorQuoteAdapterInput) => ProviderDispatchAuthorization;
  buildDefinition: () => ProviderPortalDefinition;
  observedConfig: () => { config: WorkerConfig; sessionRead: ReturnType<typeof vi.fn> };
  authorizedInput: (overrides?: Partial<VendorQuoteAdapterInput>) => Promise<VendorQuoteAdapterInput>;
  stagedCad: (name: string) => Promise<NonNullable<VendorQuoteAdapterInput["stagedCadFile"]>>;
};

async function expectRefusedBeforeLaunch(
  harness: ProductionPortalDefaultDenyHarness,
  input: VendorQuoteAdapterInput,
  reason: string,
) {
  const { config, sessionRead } = harness.observedConfig();
  const launchBrowser = vi.fn();
  await expect(
    runProviderPortalKernel(harness.buildDefinition(), config, input, { launchBrowser }),
  ).rejects.toMatchObject({
    payload: { vendor: harness.vendor, terminalState: "unsupported", reason, providerInteractionAttempted: false },
  });
  expect(launchBrowser).not.toHaveBeenCalled();
  expect(sessionRead).not.toHaveBeenCalled();
}

/**
 * Shared default-deny proofs for a production portal. Cases are a mutation
 * table, not copied `it` bodies, so stacked provider PRs do not reintroduce
 * the same 60+ line clone that Sonar rejects on new code.
 */
export function registerProductionPortalAuthorizationRefusals(harness: ProductionPortalDefaultDenyHarness) {
  const mutateAuth = (
    input: VendorQuoteAdapterInput,
    change: (authorization: ProviderDispatchAuthorization) => void,
  ) => {
    const authorization = structuredClone(input.providerDispatchAuthorization!);
    change(authorization);
    return { ...input, providerDispatchAuthorization: authorization };
  };

  const cases: Array<{
    name: string;
    reason: string;
    input: () => Promise<VendorQuoteAdapterInput>;
  }> = [
    {
      name: "launches nothing and reads no session without a provider-dispatch authorization",
      reason: "dispatch_authorization_missing",
      input: () => harness.authorizedInput({ providerDispatchAuthorization: undefined }),
    },
    {
      name: "refuses an authorization minted for a different provider",
      reason: "dispatch_authorization_provider_mismatch",
      input: async () => {
        const input = await harness.authorizedInput();
        return { ...input, providerDispatchAuthorization: harness.otherProviderAuthorization(input) };
      },
    },
    {
      name: "refuses an envelope revision that is not reviewed in code",
      reason: "dispatch_authorization_envelope_unreviewed",
      input: async () => mutateAuth(await harness.authorizedInput(), (authorization) => {
        authorization.envelope.envelope = { id: harness.envelopeId, version: 2 };
      }),
    },
    {
      name: "refuses a quantity other than the authorized one",
      reason: "dispatch_authorization_quantity_mismatch",
      input: async () => ({ ...(await harness.authorizedInput()), requestedQuantity: 4 }),
    },
    {
      name: "refuses staged bytes the authorization does not name",
      reason: "dispatch_authorization_file_mismatch",
      input: async () => {
        const input = await harness.authorizedInput();
        return { ...input, stagedCadFile: { ...input.stagedCadFile!, trustedContentSha256: "a".repeat(64) } };
      },
    },
    {
      name: "refuses when the file on disk no longer hashes to the authorized bytes",
      reason: "dispatch_authorization_file_mismatch",
      input: async () => {
        const input = await harness.authorizedInput();
        await fs.writeFile(input.stagedCadFile!.localPath, "swapped after authorization");
        return input;
      },
    },
    {
      name: "refuses an authorization that would also disclose a drawing",
      reason: "dispatch_authorization_file_mismatch",
      input: async () => mutateAuth(await harness.authorizedInput(), (authorization) => {
        authorization.envelope.outboundFiles.push({
          role: "drawing", sourceSha256: "c".repeat(64), sha256: "c".repeat(64), derivation: "identity",
        });
      }),
    },
    {
      name: "refuses a staged drawing before authorization is consulted",
      reason: "drawing_upload_outside_adapter_contract",
      input: async () => {
        const input = await harness.authorizedInput();
        return { ...input, stagedDrawingFile: await harness.stagedCad("drawing.pdf") };
      },
    },
    {
      name: "refuses a CAD type outside the envelope before authorization is consulted",
      reason: "cad_file_type_outside_envelope",
      input: async () => {
        const input = await harness.authorizedInput();
        return { ...input, stagedCadFile: await harness.stagedCad(harness.unauthorizedCadName) };
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      await expectRefusedBeforeLaunch(harness, await testCase.input(), testCase.reason);
    });
  }

  it("refuses an expired or inconsistent permit lifetime", async () => {
    const input = await harness.authorizedInput();
    for (const expiresAt of ["2020-01-01T00:00:00.000Z", "not-a-date"]) {
      await expectRefusedBeforeLaunch(harness, mutateAuth(input, (authorization) => {
        authorization.expiresAt = expiresAt;
        authorization.envelope.expiresAt = expiresAt;
      }), "dispatch_authorization_expired");
    }
    await expectRefusedBeforeLaunch(
      harness,
      mutateAuth(input, (authorization) => { authorization.expiresAt = "2098-01-01T00:00:00.000Z"; }),
      "dispatch_authorization_expired",
    );
  });
}

export function registerProductionPortalRoutingRefusals(harness: ProductionPortalDefaultDenyHarness) {
  it("never launches a browser through the registered adapter without authorization", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const { config, sessionRead } = harness.observedConfig();
    const adapter = buildAdapterRegistry(config)[harness.vendor]!;
    await expect(adapter.quote(await harness.authorizedInput({ providerDispatchAuthorization: undefined })))
      .rejects.toMatchObject({ payload: { reason: "dispatch_authorization_missing", providerInteractionAttempted: false } });
    expect(launch).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("returns manual follow-up in simulate mode without touching the provider", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const { config, sessionRead } = harness.observedConfig();
    config.workerMode = "simulate";
    const adapter = buildAdapterRegistry(config)[harness.vendor]!;
    await expect(adapter.quote(await harness.authorizedInput())).resolves.toMatchObject({
      status: "manual_vendor_followup",
      rawPayload: { reason: "simulate_hidden_vendor", providerMutationPossible: false },
    });
    expect(launch).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("refuses a live task without a generic permit before the adapter runs", async () => {
    const quote = vi.fn();
    const rpc = vi.fn();
    await expect(quoteWithRoutedDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      config: { workerMode: "live", workerName: "worker-1" },
      task: { id: harness.taskId, payload: {} },
      vendorQuoteResultId: harness.vendorQuoteResultId,
      claimedAt: harness.claimedAt,
      vendor: harness.vendor,
      scopeSnapshot: {},
      adapter: { quote },
      quoteInput: await harness.authorizedInput({ providerDispatchAuthorization: undefined }),
    })).rejects.toMatchObject({ reasonCode: "dispatch_live_provider_not_permitted" });
    expect(quote).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
}
