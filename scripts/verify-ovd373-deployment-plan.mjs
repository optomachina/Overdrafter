import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

export const EXPECTED_DRY_RUN_MIGRATION_FILENAMES = Object.freeze([
  "20260330144838_align_destructive_job_auth_contract.sql",
  "20260331000000_fix_received_at_overwrite_on_resync.sql",
  "20260331000001_add_api_enqueue_debug_vendor_quote.sql",
  "20260331010000_sync_service_line_item_status_from_quote_requests.sql",
  "20260402120000_persist_project_part_property_overrides.sql",
  "20260405103000_vendor_routing_scores.sql",
  "20260408120000_add_revision_process_to_property_overrides.sql",
  "20260409000000_add_payments_table.sql",
  "20260514120000_add_hidden_live_quote_vendor_candidates.sql",
  "20260514120100_seed_hidden_live_quote_vendor_capabilities.sql",
  "20260725090000_add_supplier_directory_foundation.sql",
  "20260728190000_mobile_auth_bridge.sql",
  "20260731015300_add_manual_quote_admin_inbox.sql",
  "20260815090000_add_founding_beta_enrollment.sql",
  "20260815093000_enforce_founding_beta_file_boundaries.sql",
  "20260815100000_add_xometry_beta_dispatch_permits.sql",
  "20260815184740_add_xometry_worker_dispatch_preflight.sql",
  "20260816011204_restore_drawing_preview_storage_bucket_binding.sql",
  "20260816015000_restrict_extraction_quality_alert_evaluator.sql",
  "20260816015500_restore_production_first_quote_contracts.sql",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;
const DRY_RUN_HEADER = "Would push these migrations:";
const DRY_RUN_MIGRATION_LINE_PATTERN = /^ • (\d{14}_[a-z0-9][a-z0-9_-]*\.sql)$/;

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
  const filenames = [];
  let inMigrationSection = false;
  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.replace(ANSI_ESCAPE_PATTERN, "");
    if (!inMigrationSection) {
      if (line === DRY_RUN_HEADER) {
        inMigrationSection = true;
      }
      continue;
    }

    const match = line.match(DRY_RUN_MIGRATION_LINE_PATTERN);
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
