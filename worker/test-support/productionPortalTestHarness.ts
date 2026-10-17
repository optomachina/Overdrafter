import type { SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import { quoteWithRoutedDispatchPreflight } from "../src/dispatchRouting.js";
import { sha256File } from "../src/liveEvaluationFiles.js";
import {
  canonicalizeProviderDispatchEnvelope,
  fingerprintProviderDispatchEnvelope,
} from "../src/providerDispatchEnvelope.js";
import type { ProviderDispatchEnvelope } from "../src/providerDispatchTypes.js";
import type { VendorName, VendorQuoteAdapterInput, VendorQuoteAdapterOutput, WorkerConfig } from "../src/types.js";
import { providerDispatchReservation } from "./providerDispatchReservation.js";

/**
 * Shared scaffolding for production-portal adapter tests. Each provider test
 * used to restate these bodies, which Sonar reports as new-code duplication
 * on every stacked provider PR.
 */

const STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });

/** A live config for one provider whose session lookups are observable. */
export function observedLiveConfig(vendor: VendorName) {
  const sessionRead = vi.fn(() => ({ [vendor]: STORAGE_STATE }));
  const config = {
    workerMode: "live",
    workerLiveAdapters: [vendor],
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

/**
 * Stages synthetic CAD bytes in a fresh temp dir recorded in `tempDirs`, so
 * the caller's afterEach can remove it.
 */
export function productionCadStager(vendor: VendorName, tempDirs: string[]) {
  return async function stagedCad(name = "part.step", bytes = `synthetic ${vendor} cad bytes`) {
    // realpath: the kernel refuses symlinked path components (macOS /var -> /private/var).
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${vendor}-production-`)));
    tempDirs.push(dir);
    const localPath = path.join(dir, name);
    await fs.writeFile(localPath, bytes);
    return {
      originalName: name,
      localPath,
      storageBucket: "job-files",
      storagePath: `cad/${name}`,
      trustedContentSha256: await sha256File(localPath),
    };
  };
}

export type AdmittedDecisionCase = {
  vendor: VendorName;
  envelope: ProviderDispatchEnvelope;
  input: VendorQuoteAdapterInput;
  /** Database clock for the decision; the task is claimed one minute earlier. */
  now: string;
  claimedAt: string;
  reviewedAt: string;
  permissionBasis: string;
  supportedProcesses: string[];
  acceptedFileExtensions: string[];
};

/**
 * Proves a database-admitted decision for `vendor` reaches the adapter: the
 * routed preflight accepts the RPC result and calls `quote` exactly once.
 */
export async function expectAdmittedDecisionReachesAdapter(testCase: AdmittedDecisionCase) {
  const { vendor, envelope } = testCase;
  const fingerprint = fingerprintProviderDispatchEnvelope(envelope);
  const admitted = {
    schema: "provider-dispatch-authorization.v1",
    authorized: true,
    permitId: envelope.permit.permitId,
    provider: vendor,
    envelopeFingerprint: fingerprint,
    canonicalEnvelope: canonicalizeProviderDispatchEnvelope(envelope),
    expiresAt: envelope.expiresAt,
    sessionBindingId: envelope.sessionBindingId,
    evidence: {
      now: testCase.now,
      permitState: "active",
      admission: {
        policy_present: true, provider_admitted: true, generically_dispatchable: true,
        provider: vendor, admission_state: "approved",
        policy_revision: envelope.admission.policyRevision,
        evidence_reference: envelope.admission.evidenceReference,
        permission_basis: testCase.permissionBasis,
        supported_processes: testCase.supportedProcesses, accepted_file_extensions: testCase.acceptedFileExtensions,
        session_owner: "overdrafter_managed", reviewed_at: testCase.reviewedAt,
        expires_at: null, reason_code: "provider_approved",
      },
      rollout: { capability: "automatic_quote_collection", enabled: true, revision: envelope.rollout.revision },
    },
  };
  const quote = vi.fn().mockResolvedValue({ artifacts: [] } as unknown as VendorQuoteAdapterOutput);
  await expect(quoteWithRoutedDispatchPreflight({
    supabase: { rpc: vi.fn().mockResolvedValue({ data: admitted, error: null }) } as unknown as SupabaseClient,
    config: { workerMode: "live", workerName: "worker-1" },
    task: {
      id: envelope.task.workQueueTaskId,
      payload: { providerDispatchPermitId: envelope.permit.permitId, providerDispatchEnvelopeFingerprint: fingerprint },
    },
    vendorQuoteResultId: envelope.task.vendorQuoteResultId,
    claimedAt: testCase.claimedAt,
    vendor,
    scopeSnapshot: { schema: "quote-lane-scope.v1", vendor },
    adapter: { quote },
    quoteInput: testCase.input,
    reserveDispatch: async (provider) => providerDispatchReservation(provider),
    killSwitchReader: async (provider) => ({
      schema: "provider-kill-switch-state.v1", provider, engaged: false, globalEngaged: false,
    }),
  })).resolves.toEqual({ artifacts: [] });
  expect(quote).toHaveBeenCalledTimes(1);
}
