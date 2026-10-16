import { randomUUID } from "node:crypto";
import {
  AGENT_API_KEY_DEFAULT_TTL_DAYS,
  AGENT_API_KEY_MAX_TTL_DAYS,
  DEFAULT_AGENT_API_KEY_SCOPES,
  isAgentApiKeyScope,
  mintAgentApiKey,
  type AgentApiKeyScope,
} from "./api-key";
import type {
  AgentApiKeyAdmitDecision,
  AgentApiKeyAdmitResult,
  AgentApiKeyRecord,
  AgentApiKeyRepository,
} from "./repository";

/**
 * In-memory stand-in for the OVD-831 tables and RPCs, for unit and journey
 * tests until the draft is promoted. It mirrors the draft's rules: AAL2 and
 * org membership for create/revoke, scope and expiry bounds, prefix + hash
 * storage only, idempotent revoke, per-key and per-org fixed windows, and an
 * audit list without key material.
 */
const DAY_MS = 86_400_000;

export interface InMemoryAgentApiKeyRow {
  id: string;
  orgId: string;
  createdBy: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: AgentApiKeyScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface InMemoryAgentApiKeyAuditEvent {
  readonly event: "create" | "revoke" | "use";
  readonly keyId: string;
  readonly orgId: string;
  readonly actorUserId: string | null;
  readonly endpoint: string | null;
  readonly result: string;
}

export interface AgentApiKeyActor {
  readonly userId: string;
  readonly aal: "aal1" | "aal2";
}

export interface CreatedAgentApiKey {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly AgentApiKeyScope[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** Plaintext key, returned only here. */
  readonly key: string;
}

export type ListedAgentApiKey = Omit<InMemoryAgentApiKeyRow, "keyHash">;

export class AgentApiKeyRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentApiKeyRequestError";
  }
}

export class InMemoryAgentApiKeyStore implements AgentApiKeyRepository {
  readonly audit: InMemoryAgentApiKeyAuditEvent[] = [];
  private readonly rows = new Map<string, InMemoryAgentApiKeyRow>();
  private readonly members = new Map<string, Map<string, "member" | "admin">>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  addMember(orgId: string, userId: string, role: "member" | "admin" = "member"): void {
    const org = this.members.get(orgId) ?? new Map<string, "member" | "admin">();
    org.set(userId, role);
    this.members.set(orgId, org);
  }

  removeMember(orgId: string, userId: string): void {
    this.members.get(orgId)?.delete(userId);
  }

  /** Snapshot of stored rows, for assertions that no plaintext is stored. */
  storedRows(): readonly InMemoryAgentApiKeyRow[] {
    return [...this.rows.values()].map((row) => ({ ...row, scopes: [...row.scopes] }));
  }

  createKey(
    actor: AgentApiKeyActor,
    input: { orgId: string; name: string; scopes?: readonly string[]; expiresAt?: Date },
  ): CreatedAgentApiKey {
    if (actor.aal !== "aal2") throw new AgentApiKeyRequestError("aal2_required");
    if (!this.isMember(input.orgId, actor.userId)) throw new AgentApiKeyRequestError("organization_access_required");
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100) throw new AgentApiKeyRequestError("invalid_name");
    const requested = input.scopes ?? DEFAULT_AGENT_API_KEY_SCOPES;
    if (requested.length === 0 || !requested.every(isAgentApiKeyScope)) {
      throw new AgentApiKeyRequestError("invalid_scopes");
    }
    const scopes = [...new Set(requested as readonly AgentApiKeyScope[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const createdAt = this.now();
    const expiresAt = input.expiresAt ?? new Date(createdAt.getTime() + AGENT_API_KEY_DEFAULT_TTL_DAYS * DAY_MS);
    if (
      expiresAt.getTime() <= createdAt.getTime() ||
      expiresAt.getTime() > createdAt.getTime() + AGENT_API_KEY_MAX_TTL_DAYS * DAY_MS
    ) {
      throw new AgentApiKeyRequestError("invalid_expiry");
    }
    const minted = mintAgentApiKey();
    const row: InMemoryAgentApiKeyRow = {
      id: randomUUID(),
      orgId: input.orgId,
      createdBy: actor.userId,
      name,
      keyPrefix: minted.prefix,
      keyHash: minted.keyHash,
      scopes,
      createdAt,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    };
    this.rows.set(row.id, row);
    this.audit.push({ event: "create", keyId: row.id, orgId: row.orgId, actorUserId: actor.userId, endpoint: null, result: "created" });
    return Object.freeze({
      id: row.id,
      orgId: row.orgId,
      name,
      keyPrefix: row.keyPrefix,
      scopes: Object.freeze([...scopes]),
      createdAt,
      expiresAt,
      key: minted.key,
    });
  }

  listKeys(actor: AgentApiKeyActor, orgId: string): ListedAgentApiKey[] {
    if (!this.isMember(orgId, actor.userId)) return [];
    return [...this.rows.values()]
      .filter((row) => row.orgId === orgId)
      .map(({ keyHash: _omitted, ...rest }) => ({ ...rest, scopes: [...rest.scopes] }));
  }

  revokeKey(actor: AgentApiKeyActor, keyId: string): { revokedAt: Date; alreadyRevoked: boolean } {
    if (actor.aal !== "aal2") throw new AgentApiKeyRequestError("aal2_required");
    const row = this.rows.get(keyId);
    const role = row ? this.members.get(row.orgId)?.get(actor.userId) : undefined;
    if (!row || role === undefined || !(row.createdBy === actor.userId || role === "admin")) {
      throw new AgentApiKeyRequestError("key_not_found");
    }
    if (row.revokedAt !== null) return { revokedAt: row.revokedAt, alreadyRevoked: true };
    row.revokedAt = this.now();
    this.audit.push({ event: "revoke", keyId, orgId: row.orgId, actorUserId: actor.userId, endpoint: null, result: "revoked" });
    return { revokedAt: row.revokedAt, alreadyRevoked: false };
  }

  async getByPrefix(prefix: string): Promise<AgentApiKeyRecord | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.keyPrefix === prefix);
    if (!row) return null;
    return Object.freeze({
      id: row.id,
      orgId: row.orgId,
      keyHash: row.keyHash,
      scopes: Object.freeze([...row.scopes]),
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    });
  }

  async admitUse(input: {
    keyId: string;
    endpoint: string;
    windowSeconds: number;
    perKeyLimit: number;
    perOrgLimit: number;
  }): Promise<AgentApiKeyAdmitDecision> {
    const row = this.rows.get(input.keyId);
    if (!row) throw new AgentApiKeyRequestError("key_not_found");
    const now = this.now();
    let result: AgentApiKeyAdmitResult;
    let retryAfterSeconds = 0;
    if (row.revokedAt !== null) result = "revoked";
    else if (row.expiresAt.getTime() <= now.getTime()) result = "expired";
    else if (!this.isMember(row.orgId, row.createdBy)) result = "creator_not_member";
    else {
      const windowMs = input.windowSeconds * 1000;
      const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
      const orgCount = this.bump(`org:${row.orgId}:${windowStart}:${input.windowSeconds}`, input.perOrgLimit);
      const keyCount = this.bump(`key:${row.id}:${windowStart}:${input.windowSeconds}`, input.perKeyLimit);
      if (keyCount > input.perKeyLimit) result = "rate_limited_key";
      else if (orgCount > input.perOrgLimit) result = "rate_limited_org";
      else {
        result = "allowed";
        row.lastUsedAt = now;
      }
      if (result !== "allowed") {
        retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now.getTime()) / 1000));
      }
    }
    this.audit.push({ event: "use", keyId: row.id, orgId: row.orgId, actorUserId: null, endpoint: input.endpoint, result });
    return Object.freeze({ allowed: result === "allowed", result, retryAfterSeconds });
  }

  async recordRefusal(input: { keyId: string; endpoint: string; result: string }): Promise<void> {
    const row = this.rows.get(input.keyId);
    if (!row) throw new AgentApiKeyRequestError("key_not_found");
    this.audit.push({ event: "use", keyId: row.id, orgId: row.orgId, actorUserId: null, endpoint: input.endpoint, result: input.result });
  }

  private isMember(orgId: string, userId: string): boolean {
    return this.members.get(orgId)?.has(userId) ?? false;
  }

  private bump(key: string, limit: number): number {
    const next = Math.min((this.counters.get(key) ?? 0) + 1, limit + 1);
    this.counters.set(key, next);
    return next;
  }
}
