#!/usr/bin/env node
/**
 * Staging-only target guard (OVD-839). Seed, reset and staging smoke tooling
 * must call assertStagingTarget before any database command. The allowlist is
 * exactly the documented staging project (docs/runbooks/staging.md); the
 * production ref and every unknown ref are refused. No network, no DB calls.
 *
 * CLI: node scripts/staging-reset-guard.mjs <project-ref | supabase URL | postgres URL>
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

/**
 * Resolve the project ref a target names: a bare ref, an API URL
 * (https://<ref>.supabase.co), a direct DB URL (db.<ref>.supabase.co) or a
 * pooler URL (user postgres.<ref>). Every ref-shaped token in the target must
 * agree, so a URL that mentions production anywhere is refused.
 */
export function projectRefFromTarget(target) {
  if (typeof target !== "string" || target.trim() === "") {
    refuse("no target given");
  }
  const value = target.trim();
  if (PROJECT_REF_PATTERN.test(value)) return value;

  let url;
  try {
    url = new URL(value);
  } catch {
    refuse("target is neither a project ref nor a URL");
  }
  const candidates = new Set();
  const host = url.hostname.toLowerCase();
  const hostMatch = /^(?:db\.)?([a-z0-9]{20})\.supabase\.(?:co|com)$/.exec(host);
  if (hostMatch) candidates.add(hostMatch[1]);
  const userMatch = /^[a-z_]+\.([a-z0-9]{20})$/.exec(decodeURIComponent(url.username));
  if (userMatch) candidates.add(userMatch[1]);
  if (value.includes(PRODUCTION_PROJECT_REF)) candidates.add(PRODUCTION_PROJECT_REF);

  if (candidates.size === 0) refuse("cannot determine a Supabase project ref from the target URL");
  if (candidates.size > 1) refuse("target URL names more than one project ref");
  return [...candidates][0];
}

export function assertStagingTarget(target) {
  return assertStagingRef(projectRefFromTarget(target));
}

export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  if (argv.length !== 1) {
    io.error("usage: node scripts/staging-reset-guard.mjs <project-ref | supabase URL | postgres URL>");
    return 2;
  }
  try {
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
