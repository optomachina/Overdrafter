/**
 * OVD-849 target guard. Pure functions, no I/O: every job that applies SQL asks
 * this module first whether the target is allowed.
 *
 * - "local" and "ephemeral" (the runner's own Docker stack) are always allowed.
 * - The production ref is refused, even if someone adds it to the allowlist.
 * - Any other remote ref is refused unless it is in ALLOWED_REMOTE_REFS. The list
 *   is empty until OVD-836 provisions a staging project; adding a ref there is a
 *   reviewed code change, never an environment variable or a secret.
 *
 * supabase/config.toml's project_id names local containers only. It happens to
 * equal the production ref, so callers must pass the remote ref they are about to
 * connect to, never config.toml's project_id.
 */

export const PRODUCTION_PROJECT_REF = "ozuatdcakezjtevztjlr";
export const LOCAL_TARGETS = Object.freeze(["local", "ephemeral"]);
// OVD-836: the staging project ref goes here once it exists.
export const ALLOWED_REMOTE_REFS = Object.freeze([]);

const PROJECT_REF_PATTERN = /^[a-z]{20}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class TargetRefusedError extends Error {
  constructor(message, ref) {
    super(message);
    this.name = "TargetRefusedError";
    this.ref = ref;
  }
}

/** Returns { kind: "local" | "remote", ref } or throws TargetRefusedError. */
export function assertAllowedTarget(ref, { allowlist = ALLOWED_REMOTE_REFS } = {}) {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new TargetRefusedError("Supabase target ref is required", ref);
  }
  const normalized = ref.trim().toLowerCase();
  if (normalized === PRODUCTION_PROJECT_REF) {
    throw new TargetRefusedError(`refusing the production project ${PRODUCTION_PROJECT_REF}`, ref);
  }
  if (LOCAL_TARGETS.includes(normalized)) return { kind: "local", ref: normalized };
  if (!PROJECT_REF_PATTERN.test(normalized)) {
    throw new TargetRefusedError(`not a Supabase project ref: ${JSON.stringify(ref)}`, ref);
  }
  if (!allowlist.includes(normalized)) {
    throw new TargetRefusedError(`project ref ${normalized} is not in the allowlist`, ref);
  }
  return { kind: "remote", ref: normalized };
}

/** Throws unless the Postgres URL points at a loopback host (the runner's own stack). */
export function assertLocalDatabaseUrl(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new TargetRefusedError("database URL is not a valid URL", undefined);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new TargetRefusedError(`database URL must use postgres://, got ${url.protocol}`, undefined);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TargetRefusedError(`database host ${url.hostname} is not loopback; only the local stack is allowed`, undefined);
  }
  if (url.href.includes(PRODUCTION_PROJECT_REF)) {
    throw new TargetRefusedError(`database URL names the production project ${PRODUCTION_PROJECT_REF}`, undefined);
  }
  return url;
}
