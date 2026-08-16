import { createHash } from "node:crypto";
import { normalizeAppSchemaDump } from "./compare-ovd372-app-schema.mjs";

export const EXPECTED_OVD373_APP_SCHEMA_SHA256 =
  "1197ed7b3794163bcfa558c464c065d6d27b2eba31d418fac054cbb3a0672552";

/**
 * Hashes an app-owned schema dump after the same narrow normalization used by
 * the OVD-372 two-database comparison.
 *
 * @param {string} contents Raw schema-only pg_dump output.
 * @returns {string} Normalized SHA-256.
 */
export function hashOvd373AppSchema(contents) {
  return createHash("sha256")
    .update(normalizeAppSchemaDump(contents))
    .digest("hex");
}

/**
 * Returns a fail-closed message when a normalized app-schema dump does not
 * match the production-qualified OVD-372 head.
 *
 * @param {string} contents Raw schema-only pg_dump output.
 * @returns {string | null} Null on an exact match; otherwise a stable message.
 */
export function verifyOvd373AppSchema(contents) {
  const actual = hashOvd373AppSchema(contents);
  if (actual === EXPECTED_OVD373_APP_SCHEMA_SHA256) {
    return null;
  }
  return `expected ${EXPECTED_OVD373_APP_SCHEMA_SHA256}, found ${actual}`;
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let contents = "";
  for await (const chunk of process.stdin) {
    contents += chunk;
  }
  return contents;
}

async function main() {
  const contents = await readStdin();
  const violation = verifyOvd373AppSchema(contents);
  if (violation) {
    console.error(`OVD-373 app-schema verification failed: ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `OVD-373 app-schema verification passed: ${EXPECTED_OVD373_APP_SCHEMA_SHA256}`,
  );
}

const isDirectExecution =
  /(?:^|[\\/])verify-ovd373-schema-fingerprint\.mjs$/.test(process.argv[1] ?? "");

if (isDirectExecution) {
  try {
    await main();
  } catch (error) {
    console.error(`OVD-373 app-schema verification stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
