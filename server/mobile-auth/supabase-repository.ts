import { createClient } from "@supabase/supabase-js";
import {
  MOBILE_AUTH_LIFETIMES,
  MOBILE_AUTH_LIMITS,
  MOBILE_AUTH_PKCE_METHOD,
} from "./contract";
import type {
  BrowserMobileAuthTransaction,
  MobileAuthAuditEvent,
  MobileAuthCleanupResult,
  MobileAuthRateLimitDecision,
  MobileAuthRateLimitInput,
  MobileAuthRepository,
  PreparedMobileAuthBootstrap,
} from "./repository";
import { createMobileAuthUpstreamFetch } from "./upstream-fetch";

interface RpcError {
  readonly message?: string;
}

interface MobileAuthRpcClient {
  rpc: (
    functionName: string,
    parameters: Readonly<Record<string, unknown>>,
  ) => Promise<{ data: unknown; error: RpcError | null }>;
}

interface SupabaseRepositoryDependencies {
  readonly createRpcClient?: (url: string, serviceRoleKey: string) => MobileAuthRpcClient;
}

export class MobileAuthRepositoryError extends Error {
  readonly code = "mobile_auth_service_unavailable" as const;

  constructor() {
    super("The mobile authentication persistence boundary is unavailable.");
    this.name = "MobileAuthRepositoryError";
  }
}

function createServiceRoleClient(url: string, serviceRoleKey: string): MobileAuthRpcClient {
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      fetch: createMobileAuthUpstreamFetch(),
    },
  }) as unknown as MobileAuthRpcClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new MobileAuthRepositoryError();
  }

  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== "boolean") {
    throw new MobileAuthRepositoryError();
  }

  return record[key];
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MobileAuthRepositoryError();
  }

  return value;
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MobileAuthRepositoryError();
  }

  return value;
}

function assertCandidateList(candidates: readonly string[]): void {
  if (
    candidates.length === 0 ||
    candidates.length > MOBILE_AUTH_LIMITS.retainedKeyVersions
  ) {
    throw new MobileAuthRepositoryError();
  }

  for (const candidate of candidates) {
    if (candidate.length === 0 || candidate.length > 128) {
      throw new MobileAuthRepositoryError();
    }
  }
}

async function callRpc(
  client: MobileAuthRpcClient,
  functionName: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  try {
    const result = await client.rpc(functionName, parameters);
    if (result.error) {
      throw new MobileAuthRepositoryError();
    }

    return result.data;
  } catch (error) {
    if (error instanceof MobileAuthRepositoryError) {
      throw error;
    }

    throw new MobileAuthRepositoryError();
  }
}

function decodeBrowserTransaction(
  data: unknown,
): BrowserMobileAuthTransaction | null {
  const record = readRecord(data);
  if (!readBoolean(record, "found")) {
    return null;
  }

  const pkceMethod = readString(record, "codeChallengeMethod");
  if (pkceMethod !== MOBILE_AUTH_PKCE_METHOD) {
    throw new MobileAuthRepositoryError();
  }

  return {
    transactionId: readString(record, "transactionId"),
    traceId: readString(record, "traceId"),
    rowVersion: readInteger(record, "rowVersion"),
    contractVersion: readInteger(record, "contractVersion"),
    cryptoKeyVersion: readInteger(record, "cryptoKeyVersion"),
    stateEnvelope: readString(record, "stateEnvelope"),
    pkceChallenge: readString(record, "codeChallenge"),
    pkceMethod,
    browserBindingDigest: readString(record, "browserBindingDigest"),
    csrfDigest: readString(record, "csrfDigest"),
    storageNamespace: readString(record, "ceremonyStorageKey"),
    providerCallbackPath: readString(record, "providerCallbackPath"),
    callbackOrigin: readString(record, "callbackOrigin"),
    callbackPath: readString(record, "callbackPath"),
    returnTo: readString(record, "returnTo"),
    browserExpiresAt: readString(record, "browserExpiresAt"),
  };
}

function decodePreparedBootstrap(
  data: unknown,
): PreparedMobileAuthBootstrap | null {
  const record = readRecord(data);
  if (!readBoolean(record, "found")) {
    return null;
  }

  return {
    transactionId: readString(record, "transactionId"),
    traceId: readString(record, "traceId"),
    rowVersion: readInteger(record, "rowVersion"),
    contractVersion: readInteger(record, "contractVersion"),
    cryptoKeyVersion: readInteger(record, "cryptoKeyVersion"),
    stateDigest: readString(record, "stateDigest"),
    handoffDigest: readString(record, "handoffDigest"),
    sessionEnvelope: readString(record, "sessionEnvelope"),
    verifiedUserId: readString(record, "verifiedUserId"),
    sourceSessionId: readString(record, "sourceSessionId"),
    pkceChallenge: readString(record, "codeChallenge"),
    callbackOrigin: readString(record, "callbackOrigin"),
    callbackPath: readString(record, "callbackPath"),
    returnTo: readString(record, "returnTo"),
    handoffExpiresAt: readString(record, "handoffExpiresAt"),
  };
}

/**
 * Creates the only service-role-backed persistence adapter used by the mobile
 * authentication bridge. Every RPC accepts digests or ciphertext only.
 */
export function createSupabaseMobileAuthRepository(
  url: string,
  serviceRoleKey: string,
  dependencies: SupabaseRepositoryDependencies = {},
): MobileAuthRepository {
  const createRpcClient = dependencies.createRpcClient ?? createServiceRoleClient;
  const client = createRpcClient(url, serviceRoleKey);

  return {
    async createTransaction(input) {
      const data = await callRpc(client, "api_mobile_auth_create_transaction", {
        p_transaction_id: input.transactionId,
        p_trace_id: input.traceId,
        p_contract_version: input.contractVersion,
        p_crypto_key_version: input.cryptoKeyVersion,
        p_state_digest: input.stateDigest,
        p_state_envelope: input.stateEnvelope,
        p_code_challenge: input.pkceChallenge,
        p_browser_binding_digest: input.browserBindingDigest,
        p_csrf_digest: input.csrfDigest,
        p_ceremony_storage_key: input.storageNamespace,
        p_provider_callback_path: input.providerCallbackPath,
        p_callback_origin: input.callbackOrigin,
        p_callback_path: input.callbackPath,
        p_return_to: input.returnTo,
      });
      return readBoolean(readRecord(data), "created");
    },

    async findBrowserTransaction(transactionId, browserBindingDigestCandidates) {
      assertCandidateList(browserBindingDigestCandidates);

      const data = await callRpc(client, "api_mobile_auth_get_browser_transaction", {
        p_transaction_id: transactionId,
        p_browser_binding_digests: browserBindingDigestCandidates,
      });
      return decodeBrowserTransaction(data);
    },

    async claimCompletion(input) {
      const data = await callRpc(client, "api_mobile_auth_claim_completion", {
        p_transaction_id: input.transactionId,
        p_expected_version: input.expectedRowVersion,
        p_browser_binding_digest: input.browserBindingDigest,
        p_csrf_digest: input.csrfDigest,
        p_crypto_key_version: input.cryptoKeyVersion,
      });
      const record = readRecord(data);
      if (!readBoolean(record, "claimed")) {
        return null;
      }

      return readInteger(record, "rowVersion");
    },

    async completeTransaction(input) {
      const data = await callRpc(client, "api_mobile_auth_complete_transaction", {
        p_transaction_id: input.transactionId,
        p_expected_version: input.expectedRowVersion,
        p_browser_binding_digest: input.browserBindingDigest,
        p_csrf_digest: input.csrfDigest,
        p_crypto_key_version: input.cryptoKeyVersion,
        p_handoff_digest: input.handoffDigest,
        p_session_envelope: input.sessionEnvelope,
        p_verified_user_id: input.verifiedUserId,
        p_source_session_id: input.sourceSessionId,
        p_handoff_expires_at: input.handoffExpiresAt,
      });
      return readBoolean(readRecord(data), "completed");
    },

    async prepareBootstrap(input) {
      assertCandidateList(input.handoffDigestCandidates);
      assertCandidateList(input.stateDigestCandidates);

      const data = await callRpc(client, "api_mobile_auth_prepare_bootstrap", {
        p_handoff_digests: input.handoffDigestCandidates,
        p_state_digests: input.stateDigestCandidates,
        p_code_challenge: input.pkceChallenge,
        p_callback_origin: input.callbackOrigin,
        p_callback_path: input.callbackPath,
      });
      return decodePreparedBootstrap(data);
    },

    async consumeTransaction(input) {
      const data = await callRpc(client, "api_mobile_auth_consume_transaction", {
        p_transaction_id: input.transactionId,
        p_expected_version: input.expectedRowVersion,
        p_handoff_digest: input.handoffDigest,
        p_state_digest: input.stateDigest,
        p_code_challenge: input.pkceChallenge,
        p_callback_origin: input.callbackOrigin,
        p_callback_path: input.callbackPath,
        p_verified_user_id: input.verifiedUserId,
        p_source_session_id: input.sourceSessionId,
      });
      return readBoolean(readRecord(data), "consumed");
    },

    async terminateTransaction(transactionId, expectedRowVersion, status, failureCode) {
      const data = await callRpc(client, "api_mobile_auth_terminate_transaction", {
        p_transaction_id: transactionId,
        p_expected_version: expectedRowVersion,
        p_target_status: status,
        p_failure_code: failureCode,
      });
      return readBoolean(readRecord(data), "terminated");
    },

    async takeRateLimit(input: MobileAuthRateLimitInput): Promise<MobileAuthRateLimitDecision> {
      const data = await callRpc(client, "api_mobile_auth_take_rate_limit", {
        p_scope: input.scope,
        p_key_version: input.keyVersion,
        p_key_digest: input.keyDigest,
        p_window_seconds: input.windowSeconds,
        p_limit: input.limit,
      });
      const record = readRecord(data);
      return {
        allowed: readBoolean(record, "allowed"),
        count: readInteger(record, "attemptCount"),
        retryAfterSeconds: readInteger(record, "retryAfterSeconds"),
      };
    },

    async recordAuditEvent(event: MobileAuthAuditEvent) {
      await callRpc(client, "api_mobile_auth_log_audit_event", {
        p_trace_id: event.traceId,
        p_event_type: event.eventType,
        p_contract_version: event.contractVersion,
        p_environment: event.environment,
        p_failure_code: event.failureCode ?? null,
        p_duration_bucket: event.durationBucket ?? null,
        p_app_version: event.appVersion ?? null,
        p_os_version: event.osVersion ?? null,
      });
    },

    async cleanup(batchSize): Promise<MobileAuthCleanupResult> {
      const data = await callRpc(client, "api_mobile_auth_cleanup", {
        p_batch_size: batchSize,
        p_terminal_retention_seconds: MOBILE_AUTH_LIFETIMES.terminalRowSeconds,
      });
      const record = readRecord(data);
      return {
        expiredTransactions: readInteger(record, "expiredTransactions"),
        deletedTransactions: readInteger(record, "prunedTransactions"),
        deletedRateLimits: readInteger(record, "prunedRateLimitCounters"),
        deletedAuditEvents: readInteger(record, "prunedAuditEvents"),
      };
    },
  };
}
