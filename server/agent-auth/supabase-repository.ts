import { createClient } from "@supabase/supabase-js";
import { isAgentApiKeyScope, type AgentApiKeyScope } from "./api-key";
import {
  AGENT_API_KEY_ADMIT_RESULTS,
  type AgentApiKeyAdmitDecision,
  type AgentApiKeyAdmitResult,
  type AgentApiKeyRecord,
  type AgentApiKeyRepository,
} from "./repository";

interface RpcError {
  readonly message?: string;
}

export interface AgentApiKeyRpcClient {
  rpc: (
    functionName: string,
    parameters: Readonly<Record<string, unknown>>,
  ) => PromiseLike<{ data: unknown; error: RpcError | null }>;
}

/** Fixed message; the RPC error is kept as `cause` and never echoed. */
export class AgentApiKeyRepositoryError extends Error {
  readonly code = "agent_api_key_service_unavailable" as const;

  constructor(cause?: unknown) {
    super("The agent API key persistence boundary is unavailable.", { cause });
    this.name = "AgentApiKeyRepositoryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentApiKeyRepositoryError();
  }
  return value;
}

function readDate(record: Record<string, unknown>, key: string, nullable: boolean): Date | null {
  const value = record[key];
  if (value === null && nullable) {
    return null;
  }
  const date = typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new AgentApiKeyRepositoryError();
  }
  return date;
}

function readScopes(record: Record<string, unknown>): AgentApiKeyScope[] {
  const value = record.scopes;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isAgentApiKeyScope)) {
    throw new AgentApiKeyRepositoryError();
  }
  return value;
}

async function callRpc(
  client: AgentApiKeyRpcClient,
  name: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  let response;
  try {
    response = await client.rpc(name, parameters);
  } catch (error) {
    throw new AgentApiKeyRepositoryError(error);
  }
  if (response.error) {
    throw new AgentApiKeyRepositoryError(response.error);
  }
  return response.data;
}

export function parseAgentApiKeyRecord(data: unknown): AgentApiKeyRecord | null {
  if (data === null) {
    return null;
  }
  if (!isRecord(data)) {
    throw new AgentApiKeyRepositoryError();
  }
  return Object.freeze({
    id: readString(data, "id"),
    orgId: readString(data, "orgId"),
    keyHash: readString(data, "keyHash"),
    scopes: Object.freeze(readScopes(data)),
    expiresAt: readDate(data, "expiresAt", false) as Date,
    revokedAt: readDate(data, "revokedAt", true),
  });
}

export function parseAgentApiKeyAdmitDecision(data: unknown): AgentApiKeyAdmitDecision {
  if (!isRecord(data) || typeof data.allowed !== "boolean") {
    throw new AgentApiKeyRepositoryError();
  }
  const result = data.result;
  const retryAfterSeconds = data.retryAfterSeconds;
  if (
    typeof result !== "string" ||
    !(AGENT_API_KEY_ADMIT_RESULTS as readonly string[]).includes(result) ||
    typeof retryAfterSeconds !== "number" ||
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 0 ||
    data.allowed !== (result === "allowed")
  ) {
    throw new AgentApiKeyRepositoryError();
  }
  return Object.freeze({ allowed: data.allowed, result: result as AgentApiKeyAdmitResult, retryAfterSeconds });
}

export function createAgentApiKeyRepositoryFromClient(client: AgentApiKeyRpcClient): AgentApiKeyRepository {
  return {
    async getByPrefix(prefix) {
      return parseAgentApiKeyRecord(await callRpc(client, "api_service_get_agent_api_key", { p_key_prefix: prefix }));
    },
    async admitUse(input) {
      return parseAgentApiKeyAdmitDecision(
        await callRpc(client, "api_service_admit_agent_api_key_use", {
          p_key_id: input.keyId,
          p_endpoint: input.endpoint,
          p_window_seconds: input.windowSeconds,
          p_key_limit: input.perKeyLimit,
          p_org_limit: input.perOrgLimit,
        }),
      );
    },
    async recordRefusal(input) {
      await callRpc(client, "api_service_record_agent_api_key_refusal", {
        p_key_id: input.keyId,
        p_endpoint: input.endpoint,
        p_result: input.result,
      });
    },
  };
}

/** Service-role repository. Server only; the service role key never reaches a client. */
export function createSupabaseAgentApiKeyRepository(url: string, serviceRoleKey: string): AgentApiKeyRepository {
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  }) as unknown as AgentApiKeyRpcClient;
  return createAgentApiKeyRepositoryFromClient(client);
}
