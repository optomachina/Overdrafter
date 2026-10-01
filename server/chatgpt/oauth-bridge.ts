import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChatGptReadDependencies } from "./tools";
import type { OverdrafterConnection } from "./supabase-reader";

const uuid = z.string().uuid().toLowerCase();
const grantSchema = z.object({
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuer: z.string().url(),
  audience: z.string().url(),
  subject: uuid,
  organizationId: uuid,
  connectionId: uuid,
  revision: z.string().min(1).max(128),
  scopes: z.array(z.string()).max(20),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
  revoked: z.boolean(),
});

/** Server-held outer MCP grant; never claims decoded from an unverified JWT. */
export type ChatGptGrant = z.infer<typeof grantSchema>;

/** Hashes an opaque bearer for lookup; callers must never log or persist the raw bearer. */
export function chatGptTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerDigest(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  // Reject cookies, query tokens, multiple credentials and ambiguous whitespace.
  const match = /^Bearer ([A-Za-z0-9._~+/-]{32,4096}={0,2})$/i.exec(authorization);
  return match ? chatGptTokenDigest(match[1]) : null;
}

function validGrant(raw: unknown, digest: string, issuer: string, audience: string, now: number): ChatGptGrant | null {
  const parsed = grantSchema.safeParse(raw);
  if (!parsed.success || !Number.isFinite(now)) return null;
  const grant = parsed.data;
  if (grant.tokenDigest !== digest || grant.revoked || grant.issuer !== issuer || grant.audience !== audience ||
      grant.issuedAtMs > now || grant.expiresAtMs <= now || grant.expiresAtMs <= grant.issuedAtMs ||
      !grant.scopes.includes("overdrafter:read")) return null;
  return grant;
}

/**
 * Disabled-by-default resource-server bridge for opaque, server-held OAuth grants.
 * No token issuance, login, persistence, provider registration or network is added.
 * Production stores must validate session revocation and update revision whenever
 * any grant binding changes. Each HTTP request gets independent reader state.
 */
export function createChatGptOAuthAuthorizer(options: {
  issuer: string;
  audience: string;
  isEnabled?: () => boolean;
  now?: () => number;
  lookupGrant: (digest: string) => Promise<unknown>;
  /** Return null for revoked/deleted sessions; never return user-supplied linkage. */
  resolveConnection: (connectionId: string) => Promise<OverdrafterConnection | null>;
  createReader: (connection: OverdrafterConnection) => ChatGptReadDependencies;
}): (request: Request) => Promise<ChatGptReadDependencies | null> {
  const issuer = new URL(options.issuer);
  const audience = new URL(options.audience);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash || issuer.search ||
      audience.username || audience.password || audience.hash || audience.search ||
      (audience.protocol !== "https:" && !(audience.protocol === "http:" && audience.hostname === "127.0.0.1"))) {
    throw new Error("OAuth issuer/resource configuration is invalid.");
  }
  const enabled = () => options.isEnabled?.() === true;
  const now = options.now ?? Date.now;
  const lookup = async (digest: string) => {
    if (!enabled()) return null;
    return validGrant(await options.lookupGrant(digest), digest, options.issuer, options.audience, now());
  };
  return async (request) => {
    try {
      if (!enabled() || request.url !== options.audience) return null;
      const digest = bearerDigest(request);
      if (!digest) return null;
      const grant = await lookup(digest);
      if (!grant) return null;
      const connection = await options.resolveConnection(grant.connectionId);
      if (!connection || connection.userId.toLowerCase() !== grant.subject ||
          connection.organizationId.toLowerCase() !== grant.organizationId ||
          !connection.scopes.includes("overdrafter:read") || !connection.accessToken) return null;
      const reader = options.createReader({ ...connection, scopes: ["overdrafter:read"] });
      // Recheck before both principal resolution and data reads. This does not
      // establish an atomic DB snapshot; production race qualification is separate.
      const isCurrent = async () => {
        const current = await lookup(digest);
        if (current === null || JSON.stringify(current) !== JSON.stringify(grant)) return false;
        const activeConnection = await options.resolveConnection(grant.connectionId);
        return activeConnection !== null &&
          activeConnection.userId.toLowerCase() === grant.subject &&
          activeConnection.organizationId.toLowerCase() === grant.organizationId &&
          activeConnection.accessToken === connection.accessToken &&
          activeConnection.scopes.includes("overdrafter:read");
      };
      return {
        isEnabled: () => enabled() && reader.isEnabled(),
        resolvePrincipal: async () => {
          if (!await isCurrent()) return null;
          const principal = await reader.resolvePrincipal();
          if (principal?.userId.toLowerCase() !== grant.subject ||
              principal.organizationId.toLowerCase() !== grant.organizationId) return null;
          return principal;
        },
        readAuthorizedJob: async (principal, jobId) => {
          if (principal.userId.toLowerCase() !== grant.subject ||
              principal.organizationId.toLowerCase() !== grant.organizationId || !await isCurrent()) return null;
          return reader.readAuthorizedJob(principal, jobId);
        },
      };
    } catch {
      // Missing, expired, malformed and failed lookups are deliberately indistinct.
      return null;
    }
  };
}
