import {
  createProviderSessionLeaseManager,
  deriveProviderAccountRef,
  deriveProviderSessionBindingRef,
  ProviderSessionOutcomeError,
  type ProviderSessionLeaseManager,
  type ProviderSessionReportableOutcome,
} from "./providerSessionLease.js";
import {
  createProviderSessionLeaseRpcStore,
  type ProviderSessionLeaseRpcClient,
} from "./providerSessionLeaseRpcStore.js";
import type { ProviderExecutionTerminalOutcome } from "./providerExecutionSeam.js";
import type { ProviderTaskLeasePort } from "./providerTaskPipeline.js";

/**
 * OVD-381: connects the OVD-462 lease manager to the OVD-464 generic provider
 * route. Built only when `WORKER_PROVIDER_SESSION_LEASE=on`; with the setting
 * off the pipeline keeps its unleased identity and this module is unused.
 *
 * Each provider has one storage-state slot per deployment today, so the
 * account material is the fixed slot label and every worker replica that
 * shares the namespace key derives the same binding for a provider. The
 * namespace key never leaves this closure; only the opaque `acct_`/`sb_`
 * references derived from it reach the lease store.
 */

/** Smallest namespace key `deriveProviderAccountRef` accepts. */
export const PROVIDER_SESSION_NAMESPACE_KEY_MIN_BYTES = 32;
const SLOT = "default";

const LEASE_OUTCOMES: Readonly<Record<ProviderExecutionTerminalOutcome, ProviderSessionReportableOutcome>> = {
  login_required: "login_required",
  challenge_required: "challenge_required",
  blocked: "provider_blocked",
  banned: "account_banned",
};

/** Decodes a hex or base64 namespace key; returns null unless it is at least 32 bytes. */
export function parseProviderSessionNamespaceKey(raw: string | null | undefined): Uint8Array | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    bytes = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    bytes = Buffer.from(value, "base64");
  } else {
    return null;
  }
  return bytes.byteLength >= PROVIDER_SESSION_NAMESPACE_KEY_MIN_BYTES ? new Uint8Array(bytes) : null;
}

export function createProviderTaskLeasePort(input: {
  manager: Pick<ProviderSessionLeaseManager, "runWithLease">;
  namespaceKey: Uint8Array | null;
}): ProviderTaskLeasePort {
  const { manager, namespaceKey } = input;
  return {
    // Without a usable key there is no identity, and the pipeline stops with
    // session_identity_unavailable before any adapter call.
    identity(provider, environment) {
      if (!namespaceKey) return null;
      const accountRef = deriveProviderAccountRef(namespaceKey, provider, SLOT);
      const sessionBindingRef = deriveProviderSessionBindingRef(namespaceKey, { provider, accountRef, environment }, SLOT);
      return { provider, accountRef, environment, sessionBindingRef };
    },
    runWithLease: (request, operation) => manager.runWithLease(request, operation),
    toLeaseError: (outcome) => new ProviderSessionOutcomeError(LEASE_OUTCOMES[outcome]),
  };
}

/** Production wiring: the RPC lease store on the worker's service-role client. */
export function createSupabaseProviderTaskLeasePort(
  client: ProviderSessionLeaseRpcClient,
  namespaceKey: Uint8Array | null,
): ProviderTaskLeasePort {
  const manager = createProviderSessionLeaseManager({ store: createProviderSessionLeaseRpcStore(client) });
  return createProviderTaskLeasePort({ manager, namespaceKey });
}
