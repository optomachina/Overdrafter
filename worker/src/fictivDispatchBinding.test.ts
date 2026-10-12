// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { fictivDispatchAuthorizationDenial } from "./adapters/fictivDispatchAuthorization";
import { quoteWithRoutedDispatchPreflight } from "./dispatchRouting";
import {
  canonicalizeProviderDispatchEnvelope,
  fingerprintProviderDispatchEnvelope,
} from "./providerDispatchEnvelope";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "./types";
import { fictivDispatchEnvelope } from "../test-support/fictivDispatchFixture";

/**
 * OVD-673: once Fictiv v1 is on the code-reviewed list, a database-admitted
 * generic decision reaches the adapter, which accepts only the exact staged
 * bytes. Synthetic fixtures; no provider, database, or browser.
 */

const CAD_SHA256 = "e".repeat(64);
const envelope = fictivDispatchEnvelope({ cadSha256: CAD_SHA256, requestedQuantity: 2 });
const fingerprint = fingerprintProviderDispatchEnvelope(envelope);

const admitted = {
  schema: "provider-dispatch-authorization.v1",
  authorized: true,
  permitId: envelope.permit.permitId,
  provider: "fictiv",
  envelopeFingerprint: fingerprint,
  canonicalEnvelope: canonicalizeProviderDispatchEnvelope(envelope),
  expiresAt: envelope.expiresAt,
  sessionBindingId: envelope.sessionBindingId,
  evidence: {
    now: "2026-10-10T12:05:00.000Z",
    permitState: "active",
    admission: {
      policy_present: true,
      provider_admitted: true,
      generically_dispatchable: true,
      provider: "fictiv",
      admission_state: "approved",
      policy_revision: envelope.admission.policyRevision,
      evidence_reference: envelope.admission.evidenceReference,
      permission_basis: "written_provider_authorization",
      supported_processes: ["cnc_milling"],
      accepted_file_extensions: ["step", "stp", "pdf"],
      session_owner: "overdrafter_managed",
      reviewed_at: "2026-10-10T11:00:00+00:00",
      expires_at: null,
      reason_code: "provider_approved",
    },
    rollout: { capability: "automatic_quote_collection", enabled: true, revision: envelope.rollout.revision },
  },
};

function stagedInput(trustedContentSha256: string): VendorQuoteAdapterInput {
  return {
    organizationId: envelope.subject.organizationId,
    quoteRunId: envelope.task.quoteRunId,
    requestedQuantity: 2,
    stagedCadFile: {
      originalName: "part.step",
      localPath: "/tmp/part.step",
      storageBucket: "job-files",
      storagePath: "cad/part.step",
      trustedContentSha256,
    },
    stagedDrawingFile: null,
  } as unknown as VendorQuoteAdapterInput;
}

async function authorizationFor(quoteInput: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterInput> {
  const quote = vi.fn().mockResolvedValue({ artifacts: [] } as unknown as VendorQuoteAdapterOutput);
  const rpc = vi.fn().mockResolvedValue({ data: admitted, error: null });
  const task = {
    id: envelope.task.workQueueTaskId,
    payload: {
      providerDispatchPermitId: envelope.permit.permitId,
      providerDispatchEnvelopeFingerprint: fingerprint,
    },
  };
  await quoteWithRoutedDispatchPreflight({
    supabase: { rpc } as unknown as SupabaseClient,
    config: { workerMode: "live", workerName: "ovd-673-fictiv" },
    task,
    vendorQuoteResultId: envelope.task.vendorQuoteResultId,
    claimedAt: "2026-10-10T12:04:00.000Z",
    vendor: "fictiv",
    scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "fictiv" },
    adapter: { quote },
    quoteInput,
    killSwitchReader: async (provider) => ({
      schema: "provider-kill-switch-state.v1", provider, engaged: false, globalEngaged: false,
    }),
  });
  return quote.mock.calls[0][0] as VendorQuoteAdapterInput;
}

describe("Fictiv preflight-to-adapter binding (OVD-673)", () => {
  it("produces an authorization the Fictiv adapter accepts for the exact staged bytes", async () => {
    const adapterInput = await authorizationFor(stagedInput(CAD_SHA256));
    expect(adapterInput.providerDispatchAuthorization).toMatchObject({
      provider: "fictiv",
      envelopeFingerprint: fingerprint,
    });
    expect(fictivDispatchAuthorizationDenial(adapterInput)).toBeNull();
  });

  it("is refused by the adapter when the staged bytes differ from the authorized ones", async () => {
    const adapterInput = await authorizationFor(stagedInput("a".repeat(64)));
    expect(fictivDispatchAuthorizationDenial(adapterInput)).toBe("dispatch_authorization_file_mismatch");
  });
});
