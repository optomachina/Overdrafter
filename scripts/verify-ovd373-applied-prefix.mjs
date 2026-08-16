import { fileURLToPath } from "node:url";
import { EXPECTED_DRY_RUN_MIGRATION_FILENAMES } from "./verify-ovd373-deployment-plan.mjs";

export const EXPECTED_PUSH_MIGRATION_VERSIONS = Object.freeze(
  EXPECTED_DRY_RUN_MIGRATION_FILENAMES.map((filename) => filename.slice(0, 14)),
);

export const EXPECTED_REPAIRED_LEDGER_HEADER =
  "baseline:79:92d2ff85964bc3a325b7a65cfe7d66d7";

/**
 * Classifies the migration versions committed after the OVD-373 push was admitted.
 * Only an exact ordered prefix is accepted; every other shape is an incident state.
 *
 * @param {unknown} input Newline-delimited migration versions or an array of versions.
 * @returns {{ kind: "zero" } | { kind: "prefix", versions: string[] } | { kind: "invalid" }}
 */
export function classifyAppliedMigrationPrefix(input) {
  let versions = [];
  if (Array.isArray(input)) {
    versions = input;
  } else if (typeof input === "string") {
    versions = input.split(/\r?\n/).filter(Boolean);
  }
  if (versions.length === 0) {
    return { kind: "zero" };
  }
  if (
    versions.length <= EXPECTED_PUSH_MIGRATION_VERSIONS.length
    && versions.every((version, index) => version === EXPECTED_PUSH_MIGRATION_VERSIONS[index])
  ) {
    return { kind: "prefix", versions };
  }
  return { kind: "invalid" };
}

/**
 * Verifies that every non-push ledger row still matches the qualified repaired
 * ledger before classifying the exact applied push prefix.
 *
 * @param {unknown} input Baseline header followed by newline-delimited push versions.
 * @returns {{ kind: "zero" } | { kind: "prefix", versions: string[] } | { kind: "invalid" }}
 */
export function verifyAppliedMigrationLedger(input) {
  if (typeof input !== "string") {
    return { kind: "invalid" };
  }
  const [header, ...versions] = input.split(/\r?\n/).filter(Boolean);
  if (header !== EXPECTED_REPAIRED_LEDGER_HEADER) {
    return { kind: "invalid" };
  }
  return classifyAppliedMigrationPrefix(versions);
}

async function main() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const classification = verifyAppliedMigrationLedger(input);
  if (classification.kind === "invalid") {
    throw new Error("OVD-373 applied migrations are not an exact reviewed prefix.");
  }
  if (classification.kind === "zero") {
    process.stdout.write("zero\n");
    return;
  }
  process.stdout.write(`prefix:${classification.versions.join(",")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "OVD-373 prefix verification failed.");
    process.exitCode = 1;
  });
}
