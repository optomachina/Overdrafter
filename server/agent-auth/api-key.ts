import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OVD-831 agent API key format: `ovd_<prefix>_<secret>`.
 *
 * - prefix: 16 lowercase hex chars (8 random bytes). Not secret; stored and
 *   shown in the UI, used to find the row.
 * - secret: 43 base64url chars (32 random bytes = 256 bits). Only its sha256
 *   (hex) is stored. The plaintext key is returned once at creation.
 *
 * The database draft (docs/migration-drafts/ovd-831-agent-api-keys.sql)
 * generates production keys in the same format; `mintAgentApiKey` mirrors it
 * for the in-memory repository and tests.
 */
export const AGENT_API_KEY_SCOPES = ["quotes:read", "quotes:request"] as const;
export type AgentApiKeyScope = (typeof AGENT_API_KEY_SCOPES)[number];
export const DEFAULT_AGENT_API_KEY_SCOPES: readonly AgentApiKeyScope[] = Object.freeze(["quotes:read"]);

export const AGENT_API_KEY_DEFAULT_TTL_DAYS = 90;
export const AGENT_API_KEY_MAX_TTL_DAYS = 365;

const PREFIX_BYTES = 8;
const SECRET_BYTES = 32;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const AGENT_API_KEY_PATTERN = /^ovd_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const BEARER_PATTERN = /^Bearer[ ]+(\S+)[ ]*$/i;

export function isAgentApiKeyScope(value: unknown): value is AgentApiKeyScope {
  return typeof value === "string" && (AGENT_API_KEY_SCOPES as readonly string[]).includes(value);
}

/** Hex sha256 of the secret part, matching the database's key_hash. */
export function hashAgentApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * A parsed key. The plaintext secret is hashed here and dropped, so it never
 * travels past the parser.
 */
export interface ParsedAgentApiKey {
  readonly prefix: string;
  readonly secretHash: string;
}

export function parseAgentApiKey(value: string): ParsedAgentApiKey | null {
  const match = AGENT_API_KEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return Object.freeze({ prefix: match[1], secretHash: hashAgentApiKeySecret(match[2]) });
}

/** Reads `Authorization: Bearer <key>`. Returns null when absent or not Bearer. */
export function readBearerToken(authorizationHeader: string | null | undefined): string | null {
  if (typeof authorizationHeader !== "string" || authorizationHeader.length > 512) {
    return null;
  }
  return BEARER_PATTERN.exec(authorizationHeader)?.[1] ?? null;
}

/** Constant-time comparison of two hex sha256 digests. */
export function agentApiKeyHashesMatch(candidateHex: string, storedHex: string): boolean {
  if (!SHA256_HEX_PATTERN.test(candidateHex) || !SHA256_HEX_PATTERN.test(storedHex)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidateHex, "hex"), Buffer.from(storedHex, "hex"));
}

export interface MintedAgentApiKey {
  /** Plaintext key. Show once, never store or log. */
  readonly key: string;
  readonly prefix: string;
  readonly keyHash: string;
}

export function mintAgentApiKey(): MintedAgentApiKey {
  const prefix = randomBytes(PREFIX_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return Object.freeze({ key: `ovd_${prefix}_${secret}`, prefix, keyHash: hashAgentApiKeySecret(secret) });
}
