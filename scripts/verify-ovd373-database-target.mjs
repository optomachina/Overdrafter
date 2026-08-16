import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const OVD373_PRODUCTION_PROJECT_REF = "ozuatdcakezjtevztjlr";
const POOLER_HOST_PATTERN = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;

function addViolation(violations, message) {
  if (!violations.includes(message)) {
    violations.push(message);
  }
}

/**
 * Validates that the linked project identity and credential-free pooler route
 * describe the one production project authorized by OVD-373.
 *
 * @param {{projectRef?: unknown, poolerUrl?: unknown}} input Linked CLI values.
 * @returns {string[]} Stable fail-closed validation messages.
 */
export function validateDatabaseTarget(input = {}) {
  const violations = [];
  const projectRef = typeof input.projectRef === "string" ? input.projectRef.trim() : "";
  if (projectRef !== OVD373_PRODUCTION_PROJECT_REF) {
    addViolation(
      violations,
      `project ref: expected ${OVD373_PRODUCTION_PROJECT_REF}, found ${projectRef || "empty"}`,
    );
  }

  const rawPoolerUrl = typeof input.poolerUrl === "string" ? input.poolerUrl.trim() : "";
  let poolerUrl;
  try {
    poolerUrl = new URL(rawPoolerUrl);
  } catch {
    addViolation(violations, "pooler URL: expected a valid credential-free URL");
    return violations;
  }

  if (poolerUrl.protocol !== "postgresql:") {
    addViolation(violations, "pooler URL: protocol must be postgresql");
  }
  if (poolerUrl.password) {
    addViolation(violations, "pooler URL: password must not be embedded");
  }
  if (poolerUrl.search || poolerUrl.hash) {
    addViolation(violations, "pooler URL: query and fragment are forbidden");
  }
  if (!POOLER_HOST_PATTERN.test(poolerUrl.hostname)) {
    addViolation(violations, "pooler URL: host is not an approved Supabase pooler");
  }
  if (poolerUrl.port !== "5432") {
    addViolation(violations, "pooler URL: port must be 5432");
  }
  if (poolerUrl.pathname !== "/postgres") {
    addViolation(violations, "pooler URL: database must be postgres");
  }
  if (decodeURIComponent(poolerUrl.username) !== `postgres.${OVD373_PRODUCTION_PROJECT_REF}`) {
    addViolation(violations, "pooler URL: username does not bind the production project ref");
  }

  return violations;
}

async function readLinkedFile(repositoryRoot, relativePath, label) {
  const filePath = path.join(repositoryRoot, relativePath);
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  return readFile(filePath, "utf8");
}

/**
 * Reads only the fixed Supabase CLI link artifacts below the current checkout.
 * It never accepts a caller-selected path and never reads a credential.
 *
 * @returns {Promise<string[]>} Stable fail-closed validation messages.
 */
export async function verifyLinkedDatabaseTarget() {
  const repositoryRoot = process.cwd();
  const [projectRef, poolerUrl] = await Promise.all([
    readLinkedFile(repositoryRoot, "supabase/.temp/project-ref", "project-ref"),
    readLinkedFile(repositoryRoot, "supabase/.temp/pooler-url", "pooler URL"),
  ]);
  return validateDatabaseTarget({ projectRef, poolerUrl });
}

async function main() {
  const violations = await verifyLinkedDatabaseTarget();
  if (violations.length > 0) {
    console.error("OVD-373 database-target verification failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("OVD-373 database-target verification passed.");
}

const isDirectExecution =
  /(?:^|[\\/])verify-ovd373-database-target\.mjs$/.test(process.argv[1] ?? "");

if (isDirectExecution) {
  try {
    await main();
  } catch (error) {
    console.error(`OVD-373 database-target verification stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
