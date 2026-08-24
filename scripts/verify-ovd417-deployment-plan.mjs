import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_DRY_RUN_MIGRATION_FILENAMES = Object.freeze([
  "20260817133902_add_quote_provider_admission_registry.sql",
  "20260821223849_add_emachineshop_manual_vendor.sql",
  "20260821223851_configure_emachineshop_manual_vendor.sql",
  "20260822213330_add_vendor_quote_offer_geographic_origin.sql",
]);

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;
const HEADER = "Would push these migrations:";
const MIGRATION_LINE = /^ • (\d{14}_[a-z0-9][a-z0-9_-]*\.sql)$/;

function addViolation(violations, message) {
  if (!violations.includes(message)) {
    violations.push(message);
  }
}

function compareOrderedNames(expected, actual, label, violations) {
  if (expected.length === actual.length && expected.every((value, index) => value === actual[index])) {
    return;
  }
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  if (missing.length > 0) {
    addViolation(violations, `${label}: missing ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    addViolation(violations, `${label}: extra ${extra.join(", ")}`);
  }
  if (missing.length === 0 && extra.length === 0) {
    addViolation(violations, `${label}: files are reordered`);
  }
}

/** Extracts only the exact filenames printed under Supabase's dry-run header. */
export function parseDryRunMigrationFilenames(output) {
  if (typeof output !== "string") {
    return [];
  }
  const filenames = [];
  let inSection = false;
  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.replace(ANSI_ESCAPE_PATTERN, "");
    if (!inSection) {
      if (line === HEADER) {
        inSection = true;
      }
      continue;
    }
    const match = MIGRATION_LINE.exec(line);
    if (match) {
      filenames.push(match[1]);
      continue;
    }
    if (line === "") {
      continue;
    }
    break;
  }
  return filenames;
}

/**
 * Validates only a captured OVD-417 dry-run. Repairs, seed operations, and
 * any non-package migration are rejected; this module never invokes Supabase.
 */
export function validateDeploymentPlan(input = {}) {
  const violations = [];
  const repairs = Array.isArray(input.repairVersions) ? input.repairVersions : [];
  const seeds = Array.isArray(input.seedVersions) ? input.seedVersions : [];
  if (repairs.length !== 0) {
    addViolation(violations, "history repairs: expected none");
  }
  if (seeds.length !== 0) {
    addViolation(violations, "seed migrations: expected none");
  }
  if (input.extraMigrationCount !== 0) {
    addViolation(violations, "extra migrations: expected 0");
  }
  const migrations = Array.isArray(input.dryRunMigrations) ? input.dryRunMigrations : parseDryRunMigrationFilenames(input.dryRunOutput);
  compareOrderedNames(EXPECTED_DRY_RUN_MIGRATION_FILENAMES, migrations, "dry-run migrations", violations);
  return violations;
}

async function readRegularFile(filePath) {
  const stats = await lstat(filePath);
  if (!stats.isFile()) {
    throw new Error(`dry-run output must be a regular file: ${filePath}`);
  }
  return readFile(filePath, "utf8");
}

/** Reads a local capture only; no network, provider CLI, or credentials are used. */
export async function verifyDeploymentPlan({ dryRunPath, repairVersions = [], seedVersions = [], extraMigrationCount = 0 } = {}) {
  if (!dryRunPath) {
    throw new Error("A captured dry-run output path is required.");
  }
  return validateDeploymentPlan({ dryRunOutput: await readRegularFile(dryRunPath), repairVersions, seedVersions, extraMigrationCount });
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }

    const value = args[index + 1];
    if (arg === "--dry-run-file") {
      options.dryRunPath = path.resolve(value);
    } else if (arg === "--repair-versions") {
      options.repairVersions = value?.split(",").filter(Boolean) ?? [];
    } else if (arg === "--seed-versions") {
      options.seedVersions = value?.split(",").filter(Boolean) ?? [];
    } else if (arg === "--extra-migration-count") {
      options.extraMigrationCount = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }
  return options;
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (direct) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.error("Usage: node scripts/verify-ovd417-deployment-plan.mjs --dry-run-file <capture> [--repair-versions <none>] [--seed-versions <none>] [--extra-migration-count 0]");
    else {
      const violations = await verifyDeploymentPlan(options);
      if (violations.length) { console.error("OVD-417 deployment-plan verification failed:"); violations.forEach((violation) => console.error(`- ${violation}`)); process.exitCode = 1; }
      else console.log("OVD-417 deployment-plan verification passed.");
    }
  } catch (error) { console.error(`OVD-417 deployment-plan verification stopped: ${error.message}`); process.exitCode = 1; }
}
