import type { AgentApiKeyScope } from "./api-key";

/** Server view of one key row, as returned by api_service_get_agent_api_key. */
export interface AgentApiKeyRecord {
  readonly id: string;
  readonly orgId: string;
  readonly keyHash: string;
  readonly scopes: readonly AgentApiKeyScope[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export type AgentApiKeyAdmitResult =
  | "allowed"
  | "revoked"
  | "expired"
  | "creator_not_member"
  | "rate_limited_key"
  | "rate_limited_org";

export interface AgentApiKeyAdmitInput {
  readonly keyId: string;
  readonly endpoint: string;
  readonly windowSeconds: number;
  readonly perKeyLimit: number;
  readonly perOrgLimit: number;
}

export interface AgentApiKeyAdmitDecision {
  readonly allowed: boolean;
  readonly result: AgentApiKeyAdmitResult;
  readonly retryAfterSeconds: number;
}

/** Results the server may audit for a use it refused before admission. */
export type AgentApiKeyRefusalAuditResult = "invalid_secret" | "insufficient_scope" | "revoked" | "expired";

export interface AgentApiKeyRefusalInput {
  readonly keyId: string;
  readonly endpoint: string;
  readonly result: AgentApiKeyRefusalAuditResult;
}

/**
 * Persistence boundary for the verifier. No method takes key material: only
 * the public prefix and the key id cross it.
 */
export interface AgentApiKeyRepository {
  getByPrefix(prefix: string): Promise<AgentApiKeyRecord | null>;
  admitUse(input: AgentApiKeyAdmitInput): Promise<AgentApiKeyAdmitDecision>;
  recordRefusal(input: AgentApiKeyRefusalInput): Promise<void>;
}

export const AGENT_API_KEY_ADMIT_RESULTS: readonly AgentApiKeyAdmitResult[] = Object.freeze([
  "allowed",
  "revoked",
  "expired",
  "creator_not_member",
  "rate_limited_key",
  "rate_limited_org",
]);
