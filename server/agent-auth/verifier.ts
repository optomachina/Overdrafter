import {
  agentApiKeyHashesMatch,
  parseAgentApiKey,
  readBearerToken,
  type AgentApiKeyScope,
} from "./api-key";
import { redactAgentApiKeysDeep } from "./redaction";
import type {
  AgentApiKeyAdmitResult,
  AgentApiKeyRefusalAuditResult,
  AgentApiKeyRepository,
} from "./repository";

/**
 * OVD-831 agent-caller verifier, used by the S5/S6 agent routes.
 *
 * Every call reads the key row (no cache), so a revoke takes effect on the
 * next request. The database re-checks revocation and expiry under a row lock
 * when it admits the use, takes the per-key and per-org rate limits, and
 * audits the outcome.
 */
export type AgentApiKeyRefusalReason =
  | "missing"
  | "malformed"
  | "invalid_key"
  | "revoked"
  | "expired"
  | "insufficient_scope"
  | "creator_not_member"
  | "rate_limited"
  | "unavailable";

export interface AgentApiKeyPrincipal {
  readonly ok: true;
  readonly orgId: string;
  readonly keyId: string;
  readonly scopes: readonly AgentApiKeyScope[];
}

export interface AgentApiKeyRefusal {
  readonly ok: false;
  readonly reason: AgentApiKeyRefusalReason;
  readonly status: 401 | 403 | 429 | 503;
  readonly retryAfterSeconds?: number;
}

export type AgentApiKeyVerification = AgentApiKeyPrincipal | AgentApiKeyRefusal;

export interface AgentApiKeyRateLimit {
  readonly windowSeconds: number;
  readonly perKey: number;
  readonly perOrg: number;
}

export const DEFAULT_AGENT_API_KEY_RATE_LIMIT: AgentApiKeyRateLimit = Object.freeze({
  windowSeconds: 60,
  perKey: 60,
  perOrg: 300,
});

/** Structured log sink. Fields never include the header or key material. */
export interface AgentAuthLogger {
  warn(event: string, fields: Readonly<Record<string, unknown>>): void;
}

export interface VerifyAgentApiKeyOptions {
  readonly repository: AgentApiKeyRepository;
  readonly requiredScope: AgentApiKeyScope;
  /** Bare endpoint name for the audit row, e.g. "quotes.read". */
  readonly endpoint: string;
  readonly rateLimit?: AgentApiKeyRateLimit;
  readonly now?: () => Date;
  readonly logger?: AgentAuthLogger;
}

const ENDPOINT_PATTERN = /^[a-z][a-z0-9_.:/-]{0,127}$/;
// Compared against when no row has the prefix, so a miss and a wrong secret
// do the same work.
const DUMMY_KEY_HASH = "0".repeat(64);

function refuse(
  reason: AgentApiKeyRefusalReason,
  retryAfterSeconds?: number,
): AgentApiKeyRefusal {
  const status =
    reason === "insufficient_scope" ? 403
    : reason === "rate_limited" ? 429
    : reason === "unavailable" ? 503
    : 401;
  return Object.freeze(
    retryAfterSeconds === undefined ? { ok: false, reason, status } : { ok: false, reason, status, retryAfterSeconds },
  );
}

const ADMIT_REFUSALS: Readonly<Record<Exclude<AgentApiKeyAdmitResult, "allowed">, AgentApiKeyRefusalReason>> = {
  revoked: "revoked",
  expired: "expired",
  creator_not_member: "creator_not_member",
  rate_limited_key: "rate_limited",
  rate_limited_org: "rate_limited",
};

function log(logger: AgentAuthLogger | undefined, event: string, fields: Record<string, unknown>): void {
  logger?.warn(event, redactAgentApiKeysDeep(fields) as Record<string, unknown>);
}

export async function verifyAgentApiKey(
  authorizationHeader: string | null | undefined,
  options: VerifyAgentApiKeyOptions,
): Promise<AgentApiKeyVerification> {
  const { repository, requiredScope, endpoint, logger } = options;
  const rateLimit = options.rateLimit ?? DEFAULT_AGENT_API_KEY_RATE_LIMIT;
  const now = options.now ?? (() => new Date());
  if (!ENDPOINT_PATTERN.test(endpoint)) {
    throw new TypeError("verifyAgentApiKey: endpoint must be a bare endpoint name.");
  }

  if (authorizationHeader === null || authorizationHeader === undefined || authorizationHeader === "") {
    return refuse("missing");
  }
  const token = readBearerToken(authorizationHeader);
  const parsed = token === null ? null : parseAgentApiKey(token);
  if (parsed === null) {
    return refuse("malformed");
  }

  const audit = async (keyId: string, result: AgentApiKeyRefusalAuditResult): Promise<void> => {
    try {
      await repository.recordRefusal({ keyId, endpoint, result });
    } catch (error) {
      log(logger, "agent_api_key_audit_failed", { keyId, endpoint, result, error });
    }
  };

  let record;
  try {
    record = await repository.getByPrefix(parsed.prefix);
  } catch (error) {
    log(logger, "agent_api_key_lookup_failed", { keyPrefix: parsed.prefix, endpoint, error });
    return refuse("unavailable");
  }

  const matches = agentApiKeyHashesMatch(parsed.secretHash, record?.keyHash ?? DUMMY_KEY_HASH);
  if (!record || !matches) {
    if (record) {
      await audit(record.id, "invalid_secret");
    }
    log(logger, "agent_api_key_refused", { keyPrefix: parsed.prefix, endpoint, reason: "invalid_key" });
    return refuse("invalid_key");
  }
  if (record.revokedAt !== null) {
    await audit(record.id, "revoked");
    return refuse("revoked");
  }
  if (record.expiresAt.getTime() <= now().getTime()) {
    await audit(record.id, "expired");
    return refuse("expired");
  }
  if (!record.scopes.includes(requiredScope)) {
    await audit(record.id, "insufficient_scope");
    return refuse("insufficient_scope");
  }

  let decision;
  try {
    decision = await repository.admitUse({
      keyId: record.id,
      endpoint,
      windowSeconds: rateLimit.windowSeconds,
      perKeyLimit: rateLimit.perKey,
      perOrgLimit: rateLimit.perOrg,
    });
  } catch (error) {
    log(logger, "agent_api_key_admit_failed", { keyId: record.id, endpoint, error });
    return refuse("unavailable");
  }

  if (!decision.allowed || decision.result !== "allowed") {
    const reason = decision.result === "allowed" ? "unavailable" : ADMIT_REFUSALS[decision.result];
    return refuse(reason, reason === "rate_limited" ? Math.max(1, decision.retryAfterSeconds) : undefined);
  }

  return Object.freeze({ ok: true, orgId: record.orgId, keyId: record.id, scopes: Object.freeze([...record.scopes]) });
}
