import { execFile } from "node:child_process";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  OVD373_PRODUCTION_DATABASE_USERS,
  OVD373_PRODUCTION_PROJECT_REF,
  validateDatabaseTarget,
} from "./verify-ovd373-database-target.mjs";

const execFileAsync = promisify(execFile);
const MANAGEMENT_API_ORIGIN = "https://api.supabase.com";
const KEYCHAIN_SERVICE = "Supabase CLI";
export const CREDENTIAL_TTL_SECONDS = 60 * 60;
const PROFILE_PATTERN = /^[A-Za-z0-9._-]+$/;
const ACCESS_TOKEN_PATTERN = /^sbp_[A-Za-z0-9_-]+$/;
const TEMPORARY_ROLE = "cli_login_postgres";
const TEMPORARY_STATE_VERSION = "ovd373-temporary-db-access.v1";

async function readRegularFile(filePath, label) {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  return readFile(filePath, "utf8");
}

/** Normalizes Supabase CLI's native keychain representation without logging it. */
export function normalizeKeychainToken(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const prefix = "go-keyring-base64:";
  if (!trimmed.startsWith(prefix)) return trimmed;
  return Buffer.from(trimmed.slice(prefix.length), "base64").toString("utf8").trim();
}

/** Validates the exact writable, short-lived role response needed by this runbook. */
export function validateLoginRoleResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Supabase returned an invalid temporary-role response");
  }
  if (value.role !== TEMPORARY_ROLE) {
    throw new Error("Supabase returned an unexpected temporary database role");
  }
  if (typeof value.password !== "string" || value.password.length < 16) {
    throw new Error("Supabase returned an invalid temporary database password");
  }
  if (value.ttl_seconds !== CREDENTIAL_TTL_SECONDS) {
    throw new Error("Supabase returned an unexpected temporary database credential lifetime");
  }
  return value;
}

/** Replaces only the verified permanent production username with the CLI role. */
export function buildTemporaryPoolerUrl(poolerUrl) {
  const parsed = new URL(poolerUrl.trim());
  const currentUser = decodeURIComponent(parsed.username);
  if (currentUser !== OVD373_PRODUCTION_DATABASE_USERS[0]) {
    throw new Error("Pooler URL must use the permanent project-bound role before temporary access is prepared");
  }
  parsed.username = OVD373_PRODUCTION_DATABASE_USERS[1];
  const result = parsed.toString();
  const violations = validateDatabaseTarget({
    projectRef: OVD373_PRODUCTION_PROJECT_REF,
    poolerUrl: result,
  });
  if (violations.length > 0) {
    throw new Error(`Temporary pooler URL failed verification: ${violations.join("; ")}`);
  }
  return result;
}

/** Restores only the verified temporary production username to the permanent role. */
export function restorePermanentPoolerUrl(poolerUrl) {
  const parsed = new URL(poolerUrl.trim());
  const currentUser = decodeURIComponent(parsed.username);
  if (currentUser !== OVD373_PRODUCTION_DATABASE_USERS[1]) {
    throw new Error("Pooler URL does not contain the expected temporary project-bound role");
  }
  parsed.username = OVD373_PRODUCTION_DATABASE_USERS[0];
  return parsed.toString();
}

/** Creates one libpq password entry while escaping pgpass separators. */
export function buildPgpassEntry(poolerUrl, password) {
  const parsed = new URL(poolerUrl);
  const backslash = String.fromCharCode(92);
  const escapeField = (value) => value
    .replaceAll(backslash, `${backslash}${backslash}`)
    .replaceAll(":", `${backslash}:`);
  return [
    parsed.hostname,
    parsed.port,
    parsed.pathname.slice(1),
    decodeURIComponent(parsed.username),
    password,
  ].map(escapeField).join(":") + "\n";
}

/** Returns the one process-external path approved for the ephemeral pgpass. */
export function getTemporaryPgpassPath() {
  return path.join(
    os.tmpdir(),
    `overdrafter-${OVD373_PRODUCTION_PROJECT_REF}-production.pgpass`,
  );
}

/** Returns the fixed, non-secret expiry-evidence path paired with the pgpass. */
export function getTemporaryStatePath() {
  return `${getTemporaryPgpassPath()}.state.json`;
}

function requireExpectedPgpassPath() {
  const expected = getTemporaryPgpassPath();
  if (process.env.OVD361_PRODUCTION_PGPASS_FILE !== expected) {
    throw new Error("OVD361_PRODUCTION_PGPASS_FILE does not match the fixed temporary path");
  }
  return expected;
}

async function readAccessToken() {
  const profile = process.env.OVD373_SUPABASE_PROFILE ?? "supabase";
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error("OVD373_SUPABASE_PROFILE contains unsupported characters");
  }
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    profile,
    "-w",
  ], { encoding: "utf8", maxBuffer: 16_384 });
  const token = normalizeKeychainToken(stdout);
  if (!ACCESS_TOKEN_PATTERN.test(token)) {
    throw new Error("Supabase CLI keychain token is missing or malformed");
  }
  return token;
}

export async function requestManagementApi(method, accessToken, body, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${MANAGEMENT_API_ORIGIN}/v1/projects/${OVD373_PRODUCTION_PROJECT_REF}/cli/login-role`,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const expectedStatus = method === "POST" ? 201 : 200;
  if (response.status !== expectedStatus) {
    throw new Error(`Supabase temporary database access request failed with status ${response.status}`);
  }
  const payload = await response.json();
  if (method === "DELETE") {
    if (payload?.message !== "ok") {
      throw new Error("Supabase temporary database revocation returned an unexpected response");
    }
    return undefined;
  }
  return payload;
}

async function replacePoolerUrl(poolerPath, nextUrl) {
  const temporaryPath = `${poolerPath}.ovd373-${process.pid}`;
  await writeFile(temporaryPath, `${nextUrl.trim()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, poolerPath);
}

function buildTemporaryState(now) {
  return {
    version: TEMPORARY_STATE_VERSION,
    projectRef: OVD373_PRODUCTION_PROJECT_REF,
    role: TEMPORARY_ROLE,
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CREDENTIAL_TTL_SECONDS * 1000).toISOString(),
  };
}

/** Validates the local non-secret lifetime evidence and returns seconds remaining. */
export function validateTemporaryState(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Temporary database access state is invalid");
  }
  if (value.version !== TEMPORARY_STATE_VERSION
    || value.projectRef !== OVD373_PRODUCTION_PROJECT_REF
    || value.role !== TEMPORARY_ROLE) {
    throw new Error("Temporary database access state does not match the production contract");
  }
  const grantedAt = Date.parse(value.grantedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(grantedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt - grantedAt !== CREDENTIAL_TTL_SECONDS * 1000
    || grantedAt > now + 5_000) {
    throw new Error("Temporary database access lifetime evidence is invalid");
  }
  return Math.floor((expiresAt - now) / 1000);
}

function getAccessPaths() {
  return {
    pgpassPath: requireExpectedPgpassPath(),
    statePath: getTemporaryStatePath(),
    poolerPath: path.resolve(process.cwd(), "supabase/.temp/pooler-url"),
    projectRefPath: path.resolve(process.cwd(), "supabase/.temp/project-ref"),
  };
}

async function cleanupFailedGrant({
  error,
  accessToken,
  requestApi,
  pgpassCreated,
  stateCreated,
  pgpassPath,
  statePath,
  rmImpl,
}) {
  const cleanupErrors = [];
  try {
    await requestApi("DELETE", accessToken);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  for (const [wasCreated, cleanupPath] of [
    [pgpassCreated, pgpassPath],
    [stateCreated, statePath],
  ]) {
    if (!wasCreated) continue;
    try {
      await rmImpl(cleanupPath, { force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [error, ...cleanupErrors],
      "Temporary database access preparation failed and cleanup was incomplete",
    );
  }
  throw error;
}

export async function grant({
  paths = getAccessPaths(),
  accessToken: suppliedAccessToken,
  requestApi = requestManagementApi,
  now = Date.now(),
  writeFileImpl = writeFile,
  rmImpl = rm,
  replacePoolerUrlImpl = replacePoolerUrl,
} = {}) {
  const { pgpassPath, statePath, poolerPath, projectRefPath } = paths;
  const [projectRef, currentPoolerUrl] = await Promise.all([
    readRegularFile(projectRefPath, "project-ref"),
    readRegularFile(poolerPath, "pooler URL"),
  ]);
  const currentViolations = validateDatabaseTarget(
    { projectRef, poolerUrl: currentPoolerUrl },
    [OVD373_PRODUCTION_DATABASE_USERS[0]],
  );
  if (currentViolations.length > 0) {
    throw new Error(`Current database target failed verification: ${currentViolations.join("; ")}`);
  }
  const temporaryPoolerUrl = buildTemporaryPoolerUrl(currentPoolerUrl);
  const accessToken = suppliedAccessToken ?? await readAccessToken();
  let response;
  let pgpassCreated = false;
  let stateCreated = false;
  const grantedAt = now;
  try {
    response = validateLoginRoleResponse(
      await requestApi("POST", accessToken, { read_only: false }),
    );
    await writeFileImpl(pgpassPath, buildPgpassEntry(temporaryPoolerUrl, response.password), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    pgpassCreated = true;
    await writeFileImpl(statePath, `${JSON.stringify(buildTemporaryState(grantedAt))}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    stateCreated = true;
    await replacePoolerUrlImpl(poolerPath, temporaryPoolerUrl);
  } catch (error) {
    return cleanupFailedGrant({
      error,
      accessToken,
      requestApi,
      pgpassCreated,
      stateCreated,
      pgpassPath,
      statePath,
      rmImpl,
    });
  }
  if (!response) throw new Error("Supabase temporary database credential was not created");
  console.log(`OVD-373 temporary database access prepared for ${CREDENTIAL_TTL_SECONDS} seconds.`);
}

export async function revoke({
  paths = getAccessPaths(),
  accessToken: suppliedAccessToken,
  requestApi = requestManagementApi,
} = {}) {
  const { pgpassPath, statePath, poolerPath } = paths;
  const accessToken = suppliedAccessToken ?? await readAccessToken();
  await requestApi("DELETE", accessToken);
  const currentPoolerUrl = await readRegularFile(poolerPath, "pooler URL");
  const temporaryViolations = validateDatabaseTarget({
    projectRef: OVD373_PRODUCTION_PROJECT_REF,
    poolerUrl: currentPoolerUrl,
  }, OVD373_PRODUCTION_DATABASE_USERS);
  if (temporaryViolations.length > 0) {
    throw new Error(
      `Server credential was revoked, but local target cleanup stopped: ${temporaryViolations.join("; ")}`,
    );
  }
  if (decodeURIComponent(new URL(currentPoolerUrl.trim()).username)
    === OVD373_PRODUCTION_DATABASE_USERS[1]) {
    await replacePoolerUrl(poolerPath, restorePermanentPoolerUrl(currentPoolerUrl));
  }
  for (const [cleanupPath, label] of [
    [pgpassPath, "Production pgpass cleanup target"],
    [statePath, "Temporary access state cleanup target"],
  ]) {
    try {
      const stats = await lstat(cleanupPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`${label} must be a regular, non-symlink file`);
      }
      await rm(cleanupPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  console.log("OVD-373 temporary database access revoked and local credential removed.");
}

export async function assertRemaining(minimumSeconds, { paths = getAccessPaths(), now = Date.now() } = {}) {
  if (!Number.isInteger(minimumSeconds) || minimumSeconds < 1 || minimumSeconds > CREDENTIAL_TTL_SECONDS) {
    throw new Error("Required remaining lifetime must be an integer within the one-hour credential window");
  }
  const { pgpassPath, statePath, poolerPath, projectRefPath } = paths;
  const [projectRef, poolerUrl, stateContents] = await Promise.all([
    readRegularFile(projectRefPath, "project-ref"),
    readRegularFile(poolerPath, "pooler URL"),
    readRegularFile(statePath, "temporary access state"),
    readRegularFile(pgpassPath, "production pgpass"),
  ]);
  const violations = validateDatabaseTarget(
    { projectRef, poolerUrl },
    [OVD373_PRODUCTION_DATABASE_USERS[1]],
  );
  if (violations.length > 0) {
    throw new Error(`Temporary database target failed verification: ${violations.join("; ")}`);
  }
  const remainingSeconds = validateTemporaryState(JSON.parse(stateContents), now);
  if (remainingSeconds < minimumSeconds) {
    throw new Error(`Temporary database credential has only ${remainingSeconds} seconds remaining`);
  }
  console.log(`OVD-373 temporary database access has at least ${minimumSeconds} seconds remaining.`);
}

async function main() {
  const action = process.argv[2];
  if (action === "path") {
    console.log(getTemporaryPgpassPath());
    return;
  }
  if (action === "grant") return grant();
  if (action === "revoke") return revoke();
  if (action === "assert-remaining") return assertRemaining(Number(process.argv[3]));
  throw new Error(
    "Usage: node scripts/manage-ovd373-temporary-db-access.mjs <path|grant|revoke|assert-remaining seconds>",
  );
}

const isDirectExecution =
  /(?:^|[\\/])manage-ovd373-temporary-db-access\.mjs$/.test(process.argv[1] ?? "");

if (isDirectExecution) {
  try {
    await main();
  } catch (error) {
    console.error(`OVD-373 temporary database access stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
