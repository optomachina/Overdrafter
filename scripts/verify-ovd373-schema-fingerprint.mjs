import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAppSchemaDump } from "./compare-ovd372-app-schema.mjs";

export const EXPECTED_OVD373_APP_SCHEMA_SHA256 =
  "fee2fd099b1237e90059fb44c1e2ca42d63343677bada9a75a16a6f8a38791e8";

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

async function main(schemaPath) {
  if (!schemaPath) {
    throw new Error(
      "Usage: node scripts/verify-ovd373-schema-fingerprint.mjs <schema-dump.sql>",
    );
  }

  const resolvedPath = path.resolve(schemaPath);
  const stats = await lstat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Schema dump must be a regular file: ${resolvedPath}`);
  }

  const contents = await readFile(resolvedPath, "utf8");
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

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  try {
    await main(process.argv[2]);
  } catch (error) {
    console.error(`OVD-373 app-schema verification stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
