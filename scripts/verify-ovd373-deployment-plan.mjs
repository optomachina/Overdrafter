import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  FROZEN_PENDING_HEAD_FILENAMES,
  QUALIFICATION_MIGRATION_FILENAMES,
} from "./verify-ovd372-pending-head.mjs";

const execFileAsync = promisify(execFile);

export const EXPECTED_PRODUCTION_PROJECT_REF = "ozuatdcakezjtevztjlr";
export const OVD372_QUALIFICATION_MERGE_COMMIT =
  "79b98a75248d704d7093a21cc1c82c52fefed454";
export const EXPECTED_REPAIR_VERSIONS = Object.freeze([
  "20260402100000",
  "20260403103000",
  "20260406000000",
  "20260408193000",
  "20260731015400",
]);

const REPAIRED_VERSIONS = new Set(EXPECTED_REPAIR_VERSIONS);
export const EXPECTED_DRY_RUN_MIGRATION_FILENAMES = Object.freeze(
  [...FROZEN_PENDING_HEAD_FILENAMES, ...QUALIFICATION_MIGRATION_FILENAMES].filter(
    (filename) => !REPAIRED_VERSIONS.has(filename.slice(0, 14)),
  ),
);

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DRY_RUN_FILENAME_PATTERN = /\b\d{14}_[a-z0-9][a-z0-9_-]*\.sql\b/g;

function addViolation(violations, message) {
  if (!violations.includes(message)) {
    violations.push(message);
  }
}

function compareOrderedNames(expected, actual, label, violations) {
  if (expected.length === actual.length && expected.every((name, index) => name === actual[index])) {
    return;
  }

  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
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

function normalizeRepairVersions(repairVersions) {
  if (!Array.isArray(repairVersions)) {
    return [];
  }
  return repairVersions;
}

/**
 * Extracts only migration filenames from captured Supabase dry-run text.
 * This parser never invokes the Supabase CLI and does not infer versions from
 * arbitrary numbers in the capture.
 *
 * @param {string} output Captured `supabase db push --linked --include-all --dry-run` output.
 * @returns {string[]} Migration filenames in the order printed by Supabase.
 */
export function parseDryRunMigrationFilenames(output) {
  if (typeof output !== "string") {
    return [];
  }
  return [...output.matchAll(DRY_RUN_FILENAME_PATTERN)].map((match) => match[0]);
}

/**
 * Validates the complete, read-only OVD-373 deployment plan.
 *
 * `ancestorVerified` must be produced by `git merge-base --is-ancestor`; the
 * verifier intentionally does not accept a caller-provided claim as proof of
 * ancestry when run from the CLI.
 *
 * @param {object} input Deployment-plan facts.
 * @returns {string[]} Stable fail-closed violation messages.
 */
export function validateDeploymentPlan(input = {}) {
  const violations = [];
  const projectRef = typeof input.projectRef === "string" ? input.projectRef.trim() : "";
  if (projectRef !== EXPECTED_PRODUCTION_PROJECT_REF) {
    addViolation(
      violations,
      `project ref: expected ${EXPECTED_PRODUCTION_PROJECT_REF}, found ${projectRef || "empty"}`,
    );
  }

  const suppliedCommit = input.currentCommit ?? input.sourceCommit;
  const currentCommit = typeof suppliedCommit === "string" ? suppliedCommit.trim() : "";
  if (!SHA_PATTERN.test(currentCommit)) {
    addViolation(violations, "source commit: current commit is not a full SHA-1");
  }
  if (currentCommit === OVD372_QUALIFICATION_MERGE_COMMIT) {
    // The qualification merge itself is an accepted deployment source.
  } else if ((input.ancestorVerified ?? input.sourceIsAncestor) !== true) {
    addViolation(
      violations,
      `source commit: ${OVD372_QUALIFICATION_MERGE_COMMIT} is not an ancestor of current main`,
    );
  }

  const actualRepairs = normalizeRepairVersions(input.repairVersions);
  compareOrderedNames(
    EXPECTED_REPAIR_VERSIONS,
    actualRepairs,
    "history repairs",
    violations,
  );

  const dryRunMigrations = Array.isArray(input.dryRunMigrations)
    ? input.dryRunMigrations
    : parseDryRunMigrationFilenames(input.dryRunOutput);
  compareOrderedNames(
    EXPECTED_DRY_RUN_MIGRATION_FILENAMES,
    dryRunMigrations,
    "dry-run migrations",
    violations,
  );

  return violations;
}

async function readRegularFile(filePath, label) {
  const stats = await lstat(filePath);
  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return readFile(filePath, "utf8");
}

async function gitOutput(repositoryRoot, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function verifyAncestor(repositoryRoot, ancestor, descendant) {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repositoryRoot,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (error) {
    if (error?.code === 1) {
      return false;
    }
    throw error;
  }
}

/**
 * Reads only local project-ref, git metadata, a repair-version list, and a
 * captured dry-run file. It never invokes Supabase or reads credentials.
 */
export async function verifyDeploymentPlan({
  repositoryRoot = process.cwd(),
  projectRefPath = path.join(repositoryRoot, "supabase/.temp/project-ref"),
  dryRunPath,
  repairVersions = [],
  currentCommit,
} = {}) {
  if (!dryRunPath) {
    throw new Error("A captured dry-run output path is required.");
  }

  const projectRef = await readRegularFile(projectRefPath, "project-ref");
  const resolvedCurrentCommit = currentCommit ?? await gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
  const ancestorVerified = await verifyAncestor(
    repositoryRoot,
    OVD372_QUALIFICATION_MERGE_COMMIT,
    resolvedCurrentCommit,
  );
  const dryRunOutput = await readRegularFile(dryRunPath, "dry-run output");

  return validateDeploymentPlan({
    projectRef,
    currentCommit: resolvedCurrentCommit,
    ancestorVerified,
    repairVersions,
    dryRunOutput,
  });
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run-file") {
      options.dryRunPath = args[++index];
    } else if (arg === "--repair-versions") {
      options.repairVersions = args[++index]?.split(",").filter(Boolean) ?? [];
    } else if (arg === "--repository-root") {
      options.repositoryRoot = path.resolve(args[++index]);
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.error(
    "Usage: node scripts/verify-ovd373-deployment-plan.mjs --dry-run-file <capture> --repair-versions <v1,v2,v3,v4,v5> [--repository-root <root>]",
  );
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printUsage();
      process.exitCode = 0;
    } else {
      const violations = await verifyDeploymentPlan(options);
      if (violations.length > 0) {
        console.error("OVD-373 deployment-plan verification failed:");
        for (const violation of violations) {
          console.error(`- ${violation}`);
        }
        process.exitCode = 1;
      } else {
        console.log("OVD-373 deployment-plan verification passed.");
      }
    }
  } catch (error) {
    console.error(`OVD-373 deployment-plan verification stopped: ${error.message}`);
    printUsage();
    process.exitCode = 1;
  }
}
