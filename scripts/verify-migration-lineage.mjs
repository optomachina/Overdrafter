import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Production-recorded migration versions whose statement payloads were
 * independently matched to repository SQL by byte length and content hash.
 */
export const CANONICAL_PRODUCTION_LINEAGE = [
  {
    filename: "20260731010001_add_spend_caps_and_ledger.sql",
    bytes: 16_790,
    sha256: "5ed495be01cd10aacc2cf166364813b2b42a09893e9e2ef55319b7ab57559a3a",
  },
  {
    filename: "20260802020349_add_commercial_rollout_controls.sql",
    bytes: 12_854,
    sha256: "138f5dd3fb272e46bd749c20bdb63c812ffbcba273fba7e145843e37349f538d",
  },
  {
    filename: "20260802020417_gate_entitlement_admin_mutations.sql",
    bytes: 3_672,
    sha256: "e187bfe9a04b3bebabc46e2b8f7e53ff60f90c3f7d224fd4c8ecda71f8820c46",
  },
  {
    filename: "20260802020418_harden_entitlement_rollout_gate.sql",
    bytes: 2_694,
    sha256: "1adf8ec025f45818c29345c20af3bfad6691096e72a4c9990c7f26458c526c0f",
  },
  {
    filename: "20260802020433_linearize_entitlement_admin_rollout_disable.sql",
    bytes: 1_774,
    sha256: "5ca8603193ca7d362dcdd01bdecf08a485ef66e6d336d5ffa6a0fc88f462eda6",
  },
  {
    filename: "20260802031257_gate_automatic_quotes_by_rollout_control_ovd314.sql",
    bytes: 4_271,
    sha256: "d24253eeb032beb514bbf728b1345431519df36a5ba9a3f91dd7d68ab0614c18",
  },
  {
    filename: "20260812004204_restore_job_vendor_preferences.sql",
    bytes: 17_774,
    sha256: "ee2da4e2f281bdfe5e7c3ff501af530e60b1b49ab28ada59719685ef99510f74",
  },
];

export const RETIRED_LINEAGE_ALIASES = new Set([
  "20260726120000_add_spend_caps_and_ledger.sql",
  "20260802001500_add_commercial_rollout_controls.sql",
  "20260802011500_gate_entitlement_admin_mutations.sql",
  "20260802013500_harden_entitlement_rollout_gate.sql",
  "20260802014500_linearize_entitlement_admin_rollout_disable.sql",
  "20260802015500_gate_automatic_quotes_by_rollout_control.sql",
  "20260812003732_restore_job_vendor_preferences.sql",
]);

const MIGRATION_FILENAME_PATTERN = /^(\d{14})_[a-z0-9_-]+\.sql$/;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Restricts CLI verification to the repository's canonical migration folder.
 */
export function resolveCanonicalMigrationRoot(repositoryRoot, requestedRoot) {
  const canonicalRoot = path.resolve(repositoryRoot, "supabase/migrations");
  const requestedPath = path.resolve(repositoryRoot, requestedRoot);

  if (requestedPath !== canonicalRoot) {
    throw new Error(
      `Migration lineage verification is restricted to ${canonicalRoot}.`,
    );
  }

  return canonicalRoot;
}

function inspectMigrationEntry(entry, filenamesByVersion, violations) {
  if (!entry.isFile()) {
    violations.push(`${entry.name}: migration must be a regular file`);
    return;
  }

  const match = entry.name.match(MIGRATION_FILENAME_PATTERN);
  if (!match) {
    violations.push(`${entry.name}: invalid migration filename`);
    return;
  }

  const version = match[1];
  const versionFiles = filenamesByVersion.get(version) ?? [];
  versionFiles.push(entry.name);
  filenamesByVersion.set(version, versionFiles);
}

function appendDuplicateVersionViolations(filenamesByVersion, violations) {
  for (const [version, versionFiles] of filenamesByVersion) {
    if (versionFiles.length > 1) {
      violations.push(
        `${version}: duplicate migration version in ${versionFiles.join(", ")}`,
      );
    }
  }
}

function appendRetiredAliasViolations(filenames, violations) {
  for (const retiredFilename of RETIRED_LINEAGE_ALIASES) {
    if (filenames.has(retiredFilename)) {
      violations.push(`${retiredFilename}: retired migration alias is present`);
    }
  }
}

async function appendExpectedLineageViolations(
  migrationRoot,
  filenames,
  expectedLineage,
  violations,
) {
  for (const expected of expectedLineage) {
    if (!filenames.has(expected.filename)) {
      violations.push(`${expected.filename}: canonical migration is missing`);
      continue;
    }

    const contents = await readFile(path.join(migrationRoot, expected.filename));
    if (contents.byteLength !== expected.bytes) {
      violations.push(
        `${expected.filename}: expected ${expected.bytes} bytes, found ${contents.byteLength}`,
      );
    }

    const contentSha256 = sha256(contents);
    if (contentSha256 !== expected.sha256) {
      violations.push(
        `${expected.filename}: expected SHA-256 ${expected.sha256}, found ${contentSha256}`,
      );
    }
  }
}

/**
 * Checks canonical migration aliases without contacting or mutating Supabase.
 */
export async function inspectMigrationLineage(
  migrationRoot,
  expectedLineage = CANONICAL_PRODUCTION_LINEAGE,
) {
  const entries = await readdir(migrationRoot, { withFileTypes: true });
  const migrationEntries = entries
    .filter((entry) => entry.name.endsWith(".sql"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const violations = [];
  const filenames = new Set(migrationEntries.map((entry) => entry.name));
  const filenamesByVersion = new Map();

  for (const entry of migrationEntries) {
    inspectMigrationEntry(entry, filenamesByVersion, violations);
  }

  appendDuplicateVersionViolations(filenamesByVersion, violations);
  appendRetiredAliasViolations(filenames, violations);
  await appendExpectedLineageViolations(
    migrationRoot,
    filenames,
    expectedLineage,
    violations,
  );

  return violations.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const requestedRoot = process.argv[2] ?? "supabase/migrations";
  const migrationRoot = resolveCanonicalMigrationRoot(
    process.cwd(),
    requestedRoot,
  );
  const violations = await inspectMigrationLineage(migrationRoot);

  if (violations.length > 0) {
    console.error("Supabase migration-lineage verification failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Supabase migration-lineage verification passed for ${requestedRoot}.`,
  );
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  await main();
}
