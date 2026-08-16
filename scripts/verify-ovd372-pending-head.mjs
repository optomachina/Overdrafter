import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MANIFEST_PATH = "docs/release/ovd-372-pending-head-manifest.json";
export const EXPECTED_SOURCE_COMMIT =
  "81ca41b159078c2eaca305ca042c4bf5d927890a";
export const EXPECTED_MIGRATION_ROOT = "supabase/migrations";

export const FROZEN_PENDING_HEAD_FILENAMES = Object.freeze([
  "20260330144838_align_destructive_job_auth_contract.sql",
  "20260331000000_fix_received_at_overwrite_on_resync.sql",
  "20260331000001_add_api_enqueue_debug_vendor_quote.sql",
  "20260331010000_sync_service_line_item_status_from_quote_requests.sql",
  "20260402100000_include_service_line_item_id_in_vendor_quote_queue_payload.sql",
  "20260402120000_persist_project_part_property_overrides.sql",
  "20260403103000_harden_client_quote_workspace_lineage.sql",
  "20260405103000_vendor_routing_scores.sql",
  "20260406000000_add_extraction_quality_alerts.sql",
  "20260408120000_add_revision_process_to_property_overrides.sql",
  "20260408193000_add_project_and_job_vendor_preferences.sql",
  "20260409000000_add_payments_table.sql",
  "20260514120000_add_hidden_live_quote_vendor_candidates.sql",
  "20260514120100_seed_hidden_live_quote_vendor_capabilities.sql",
  "20260725090000_add_supplier_directory_foundation.sql",
  "20260728190000_mobile_auth_bridge.sql",
  "20260731015300_add_manual_quote_admin_inbox.sql",
  "20260731015400_add_commercial_account_admin_api.sql",
  "20260815090000_add_founding_beta_enrollment.sql",
  "20260815093000_enforce_founding_beta_file_boundaries.sql",
  "20260815100000_add_xometry_beta_dispatch_permits.sql",
  "20260815184740_add_xometry_worker_dispatch_preflight.sql",
  "20260816011204_restore_drawing_preview_storage_bucket_binding.sql",
]);

export const FROZEN_RETIRED_ALIASES = Object.freeze([
  "20260726120000_add_spend_caps_and_ledger.sql",
  "20260802001500_add_commercial_rollout_controls.sql",
  "20260802011500_gate_entitlement_admin_mutations.sql",
  "20260802013500_harden_entitlement_rollout_gate.sql",
  "20260802014500_linearize_entitlement_admin_rollout_disable.sql",
  "20260802015500_gate_automatic_quotes_by_rollout_control.sql",
  "20260812003732_restore_job_vendor_preferences.sql",
]);

export const QUALIFICATION_MIGRATION_FILENAMES = Object.freeze([
  "20260816015000_restrict_extraction_quality_alert_evaluator.sql",
  "20260816015500_restore_production_first_quote_contracts.sql",
]);

export const PRODUCTION_HISTORY_RECONCILIATIONS = Object.freeze([
  "20260402100000",
  "20260403103000",
  "20260406000000",
  "20260408193000",
  "20260731015400",
]);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function addViolation(violations, violation) {
  if (!violations.includes(violation)) {
    violations.push(violation);
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

export function validateManifestShape(manifest) {
  const violations = [];
  if (manifest?.schemaVersion !== 1) {
    addViolation(violations, "manifest: unsupported schema version");
  }
  if (manifest?.sourceCommit !== EXPECTED_SOURCE_COMMIT) {
    addViolation(violations, "manifest: source commit does not match the frozen OVD-372 commit");
  }
  if (manifest?.migrationRoot !== EXPECTED_MIGRATION_ROOT) {
    addViolation(violations, "manifest: migration root does not match the canonical root");
  }

  const pendingHead = Array.isArray(manifest?.pendingHead) ? manifest.pendingHead : [];
  const pendingNames = pendingHead.map((entry) => entry?.filename);
  compareOrderedNames(
    FROZEN_PENDING_HEAD_FILENAMES,
    pendingNames,
    "manifest pending-head",
    violations,
  );
  if (pendingHead.length !== FROZEN_PENDING_HEAD_FILENAMES.length) {
    addViolation(violations, "manifest pending-head: expected exactly 23 entries");
  }

  const qualificationMigrations = Array.isArray(manifest?.qualificationMigrations)
    ? manifest.qualificationMigrations
    : [];
  compareOrderedNames(
    QUALIFICATION_MIGRATION_FILENAMES,
    qualificationMigrations.map((entry) => entry?.filename),
    "manifest qualification migrations",
    violations,
  );

  const retiredAliases = Array.isArray(manifest?.retiredAliases)
    ? manifest.retiredAliases
    : [];
  compareOrderedNames(
    FROZEN_RETIRED_ALIASES,
    retiredAliases,
    "manifest retired aliases",
    violations,
  );

  const productionHistoryReconciliations = Array.isArray(
    manifest?.productionHistoryReconciliations,
  )
    ? manifest.productionHistoryReconciliations
    : [];
  compareOrderedNames(
    PRODUCTION_HISTORY_RECONCILIATIONS,
    productionHistoryReconciliations,
    "manifest production history reconciliations",
    violations,
  );

  for (const entry of [...pendingHead, ...qualificationMigrations]) {
    if (!entry || typeof entry.filename !== "string") {
      addViolation(violations, "manifest pending-head: every entry needs a filename");
      continue;
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      addViolation(violations, `${entry.filename}: manifest byte length is invalid`);
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      addViolation(violations, `${entry.filename}: manifest SHA-256 is invalid`);
    }
  }

  return violations;
}

async function listMigrationEntries(migrationRoot) {
  const entries = await readdir(migrationRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name.endsWith(".sql"))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Verifies the files named by a pending-head manifest without any provider call.
 * `sourceMigrationFilenames` may be supplied by the CLI to freeze the complete
 * migration tree from the pinned source commit; tests can omit it for a small
 * temporary fixture containing only pending-head files.
 */
export async function inspectPendingHead(
  migrationRoot,
  manifest,
  { sourceMigrationFilenames } = {},
) {
  const violations = validateManifestShape(manifest);
  const migrationEntries = await listMigrationEntries(migrationRoot);
  const actualNames = migrationEntries.map((entry) => entry.name);

  if (sourceMigrationFilenames) {
    compareOrderedNames(
      sourceMigrationFilenames,
      actualNames,
      "migration directory",
      violations,
    );
  }

  const retiredAliases = new Set(FROZEN_RETIRED_ALIASES);
  for (const name of actualNames) {
    if (retiredAliases.has(name)) {
      addViolation(violations, `${name}: retired migration alias is present`);
    }
  }

  const pendingHead = Array.isArray(manifest?.pendingHead) ? manifest.pendingHead : [];
  const qualificationMigrations = Array.isArray(manifest?.qualificationMigrations)
    ? manifest.qualificationMigrations
    : [];
  for (const expected of [...pendingHead, ...qualificationMigrations]) {
    if (!expected || typeof expected.filename !== "string") {
      continue;
    }
    const filePath = path.join(migrationRoot, expected.filename);
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        addViolation(violations, `${expected.filename}: migration is missing`);
        continue;
      }
      throw error;
    }

    if (!stats.isFile()) {
      addViolation(violations, `${expected.filename}: migration must be a regular file`);
      continue;
    }

    const contents = await readFile(filePath);
    if (contents.byteLength !== expected.bytes) {
      addViolation(
        violations,
        `${expected.filename}: expected ${expected.bytes} bytes, found ${contents.byteLength}`,
      );
    }
    const contentHash = sha256(contents);
    if (contentHash !== expected.sha256) {
      addViolation(
        violations,
        `${expected.filename}: expected SHA-256 ${expected.sha256}, found ${contentHash}`,
      );
    }
  }

  return violations.sort((left, right) => left.localeCompare(right));
}

async function runGit(repositoryRoot, args) {
  const result = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function readSourceMigrationFilenames(repositoryRoot, sourceCommit) {
  const output = await runGit(repositoryRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    sourceCommit,
    "--",
    EXPECTED_MIGRATION_ROOT,
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((filename) => filename.slice(`${EXPECTED_MIGRATION_ROOT}/`.length))
    .sort((left, right) => left.localeCompare(right));
}

async function readSourceBlob(repositoryRoot, sourceCommit, filename) {
  const result = await execFileAsync(
    "git",
    ["show", `${sourceCommit}:${EXPECTED_MIGRATION_ROOT}/${filename}`],
    {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
    },
  );
  return result.stdout;
}

async function verifyManifestAgainstSourceCommit(repositoryRoot, manifest, violations) {
  for (const expected of manifest.pendingHead) {
    try {
      const sourceContents = await readSourceBlob(
        repositoryRoot,
        EXPECTED_SOURCE_COMMIT,
        expected.filename,
      );
      const sourceBytes = sourceContents.byteLength;
      const sourceHash = sha256(sourceContents);
      if (sourceBytes !== expected.bytes || sourceHash !== expected.sha256) {
        addViolation(
          violations,
          `${expected.filename}: manifest does not match the pinned source commit`,
        );
      }
    } catch {
      addViolation(
        violations,
        `${expected.filename}: migration is absent from the pinned source commit`,
      );
    }
  }
}

export async function verifyPendingHead({
  repositoryRoot = process.cwd(),
  manifestPath = path.resolve(repositoryRoot, MANIFEST_PATH),
  migrationRoot = path.resolve(repositoryRoot, EXPECTED_MIGRATION_ROOT),
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const violations = validateManifestShape(manifest);
  const head = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  try {
    await runGit(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      EXPECTED_SOURCE_COMMIT,
      head,
    ]);
  } catch {
    addViolation(
      violations,
      `repository HEAD ${head} does not descend from frozen source commit ${EXPECTED_SOURCE_COMMIT}`,
    );
  }

  const sourceMigrationFilenames = await readSourceMigrationFilenames(
    repositoryRoot,
    EXPECTED_SOURCE_COMMIT,
  );
  const qualifiedMigrationFilenames = [
    ...sourceMigrationFilenames,
    ...QUALIFICATION_MIGRATION_FILENAMES,
  ].sort((left, right) => left.localeCompare(right));
  violations.push(
    ...(await inspectPendingHead(migrationRoot, manifest, {
      sourceMigrationFilenames: qualifiedMigrationFilenames,
    })),
  );
  await verifyManifestAgainstSourceCommit(repositoryRoot, manifest, violations);

  return [...new Set(violations)].sort((left, right) => left.localeCompare(right));
}

async function main() {
  const violations = await verifyPendingHead();
  if (violations.length > 0) {
    console.error("OVD-372 pending-head verification failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("OVD-372 pending-head verification passed.");
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  await main();
}
