#!/usr/bin/env node
/**
 * Staging-only target guard (OVD-839). Seed, reset and staging smoke tooling
 * must call assertStagingConnectionEnv and assertStagingTarget before any
 * database command. The allowlist is exactly the documented staging project
 * (docs/runbooks/staging.md); the production ref and every unknown ref are
 * refused. No network, no DB calls.
 *
 * CLI: node scripts/staging-reset-guard.mjs <project-ref | postgres URL>
 * Exit codes: 0 staging target accepted, 1 refused, 2 usage error.
 */
import { pathToFileURL } from "node:url";

export const STAGING_PROJECT_REF = "ldmambwtksfvqdufhaam";
export const PRODUCTION_PROJECT_REF = "ozuatdcakezjtevztjlr";
export const STAGING_REF_ALLOWLIST = Object.freeze([STAGING_PROJECT_REF]);

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export class StagingTargetRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "StagingTargetRefusedError";
  }
}

function refuse(message) {
  throw new StagingTargetRefusedError(`staging guard: ${message}; refusing to run.`);
}

export function assertStagingRef(ref) {
  if (typeof ref !== "string" || !PROJECT_REF_PATTERN.test(ref)) {
    refuse("target is not a Supabase project ref");
  }
  if (ref === PRODUCTION_PROJECT_REF) {
    refuse(`target ${ref} is the production project`);
  }
  if (!STAGING_REF_ALLOWLIST.includes(ref)) {
    refuse(`target ${ref} is not the documented staging project ${STAGING_PROJECT_REF}`);
  }
  return ref;
}

// Strict allowlist for connection URLs. The decision is one anchored regex
// over the whole string, never URL() parsing: Node's URL parser and libpq
// disagree on the host when "#" or "?" precedes the last "@"
// (postgresql://db.<staging>.supabase.co#@evil.example.com/postgres), so any
// denylist built on URL() is bypassable.
//
// Hosts: the staging direct host, or the us-west-1 Supavisor pooler host this
// org uses (aws-1-us-west-1.pooler.supabase.com; see
// scripts/manage-ovd373-temporary-db-access.test.mjs line 29 and
// docs/workflows/ovd361-production-deployment.md). The direct host takes user
// "postgres"; the pooler takes "postgres.<staging ref>". The password must be
// unreserved characters or %XX escapes, so a raw @ # ? / : (or anything else
// that could move the authority boundary) is refused. The only query allowed
// is a single sslmode=require|verify-full.
export const STAGING_DIRECT_HOST = "db.ldmambwtksfvqdufhaam.supabase.co";
export const STAGING_POOLER_HOST = "aws-1-us-west-1.pooler.supabase.com";
export const STAGING_CONNECTION_URL_PATTERN =
  /^postgres(?:ql)?:\/\/(?:postgres:(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+@db\.ldmambwtksfvqdufhaam\.supabase\.co|postgres\.ldmambwtksfvqdufhaam:(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+@aws-1-us-west-1\.pooler\.supabase\.com):(?:5432|6543)\/postgres(?:\?sslmode=(?:require|verify-full))?$/;

/**
 * libpq environment variables that could redirect or re-credential a
 * connection behind the validated URL (PGHOSTADDR in particular is used to
 * connect even when the URL names a host). Callers pass the connection only as
 * the validated URL, with none of these set.
 */
export const REFUSED_CONNECTION_ENV_VARS = Object.freeze([
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGPASSFILE",
]);

export function assertStagingConnectionEnv(env = process.env) {
  for (const name of REFUSED_CONNECTION_ENV_VARS) {
    if (env[name] !== undefined) {
      refuse(`${name} is set in the environment; pass the connection only as the validated URL`);
    }
  }
}

/**
 * Resolve the project ref a target names: a bare ref, or a postgres URL that
 * matches the staging allowlist exactly. Everything else (API URLs, key=value
 * DSNs, multi-host, IPv6, extra query parameters, fragments, other ports or
 * users) is refused. Messages never include the URL, so a password is never
 * echoed.
 */
export function projectRefFromTarget(target) {
  if (typeof target !== "string" || target.trim() === "") {
    refuse("no target given");
  }
  const value = target.trim();
  if (PROJECT_REF_PATTERN.test(value)) return value;

  // Match the untrimmed target: the caller connects with exactly this string.
  if (STAGING_CONNECTION_URL_PATTERN.test(target)) return STAGING_PROJECT_REF;
  if (target.includes(PRODUCTION_PROJECT_REF)) refuse("target connection URL names the production project");
  refuse("target connection URL does not match the staging allowlist");
}

export function assertStagingTarget(target) {
  return assertStagingRef(projectRefFromTarget(target));
}

export function main(
  argv = process.argv.slice(2),
  io = { log: console.log, error: console.error },
  env = process.env,
) {
  if (argv.length !== 1) {
    io.error("usage: node scripts/staging-reset-guard.mjs <project-ref | postgres URL>");
    return 2;
  }
  try {
    assertStagingConnectionEnv(env);
    const ref = assertStagingTarget(argv[0]);
    io.log(`staging guard: target ${ref} is the documented staging project.`);
    return 0;
  } catch (error) {
    if (!(error instanceof StagingTargetRefusedError)) throw error;
    io.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
