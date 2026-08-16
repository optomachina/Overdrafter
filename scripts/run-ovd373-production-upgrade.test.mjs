import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runner = readFileSync(
  resolve(process.cwd(), "scripts/run-ovd373-production-upgrade.sh"),
  "utf8",
);
const lockSql = readFileSync(
  resolve(process.cwd(), "scripts/hold-ovd373-production-locks.sql"),
  "utf8",
);
const repairedLedgerSql = readFileSync(
  resolve(process.cwd(), "scripts/verify-ovd373-repaired-ledger.sql"),
  "utf8",
);
const lockedCommand = readFileSync(
  resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh"),
  "utf8",
);
const runbook = readFileSync(
  resolve(process.cwd(), "docs/workflows/ovd361-production-deployment.md"),
  "utf8",
);

function indexOfRequired(fragment) {
  const index = runner.indexOf(fragment);
  expect(index, `missing runner fragment: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("OVD-373 governed production upgrade runner", () => {
  it("holds every rollout lock before repair and through postconditions", () => {
    for (const key of [
      "ovd373-production-deployment",
      "commercial-rollout:automatic_quote_collection",
      "commercial-rollout:commercial_admin_mutations",
      "commercial-rollout:order_administration",
      "commercial-rollout:promotion_codes",
    ]) {
      expect(lockSql).toContain(`hashtextextended('${key}', 0)`);
    }
    const lockRolloutGuard = lockSql.indexOf("verify-ovd373-rollout-preconditions.sql");
    const locksAcquired = lockSql.indexOf("OVD-373 deployment locks acquired.");
    expect(lockRolloutGuard).toBeGreaterThanOrEqual(0);
    expect(locksAcquired).toBeGreaterThanOrEqual(0);
    expect(lockRolloutGuard).toBeLessThan(locksAcquired);

    const lockStart = indexOfRequired("--file /workspace/scripts/hold-ovd373-production-locks.sql");
    const firstRepair = runner.indexOf(
      'supabase migration repair --db-url "$OVD373_POOLER_URL"',
      lockStart,
    );
    const push = runner.indexOf(
      'supabase db push --db-url "$OVD373_POOLER_URL" --include-all --yes',
      firstRepair,
    );
    expect(firstRepair).toBeGreaterThanOrEqual(0);
    expect(push).toBeGreaterThanOrEqual(0);
    const postconditions = indexOfRequired("verify-ovd373-production-postconditions.sql");
    const success = indexOfRequired("OVD373_UPGRADE_SUCCEEDED=1");
    expect(lockStart).toBeLessThan(firstRepair);
    expect(firstRepair).toBeLessThan(push);
    expect(push).toBeLessThan(postconditions);
    expect(postconditions).toBeLessThan(success);
  });

  it("rechecks immutable inputs and a fresh dry-run with no operator gap before push", () => {
    const repairLoop = indexOfRequired('for repair_version in "${OVD373_REPAIR_VERSIONS[@]}"; do');
    const repairedLedger = runner.indexOf(
      "run_production_sql scripts/verify-ovd373-repaired-ledger.sql",
      repairLoop,
    );
    expect(repairedLedger).toBeGreaterThan(repairLoop);
    const finalCommit = runner.indexOf('test "$(git rev-parse HEAD)"', repairedLedger);
    const finalTarget = runner.indexOf("verify-ovd373-database-target.mjs", repairedLedger);
    const finalFrozenHead = runner.indexOf("npm run verify:ovd372-head", repairedLedger);
    const finalRollout = runner.indexOf("verify-ovd373-rollout-preconditions.sql", repairedLedger);
    const finalBilling = runner.indexOf("verify-ovd373-billing-disabled.mjs", repairedLedger);
    const finalDryRun = runner.indexOf("--include-all --dry-run", repairedLedger);
    const planVerification = runner.indexOf("verify-ovd373-deployment-plan.mjs", repairedLedger);
    const realPush = runner.indexOf(
      'supabase db push --db-url "$OVD373_POOLER_URL" --include-all --yes',
      finalDryRun,
    );

    expect([
      finalCommit,
      finalTarget,
      finalFrozenHead,
      finalRollout,
      finalBilling,
      finalDryRun,
      planVerification,
      realPush,
    ]).toEqual([...[
      finalCommit,
      finalTarget,
      finalFrozenHead,
      finalRollout,
      finalBilling,
      finalDryRun,
      planVerification,
      realPush,
    ]].sort((left, right) => left - right));
    expect(finalCommit).toBeGreaterThan(repairedLedger);

    const postPlanCommit = runner.indexOf('test "$(git rev-parse HEAD)"', planVerification);
    const postPlanTarget = runner.indexOf("verify-ovd373-database-target.mjs", planVerification);
    const postPlanFrozenHead = runner.indexOf("npm run verify:ovd372-head", planVerification);
    const postPlanLedger = runner.indexOf("verify-ovd373-repaired-ledger.sql", planVerification);
    const postPlanRollout = runner.indexOf("verify-ovd373-rollout-preconditions.sql", planVerification);
    const postPlanBilling = runner.indexOf("verify-ovd373-billing-disabled.mjs", planVerification);
    const pushAdmission = runner.indexOf(
      '--admission-marker "$OVD373_PUSH_ADMISSION_MARKER"',
      planVerification,
    );

    expect([
      postPlanCommit,
      postPlanTarget,
      postPlanFrozenHead,
      postPlanLedger,
      postPlanRollout,
      postPlanBilling,
      pushAdmission,
    ]).toEqual([...[
      postPlanCommit,
      postPlanTarget,
      postPlanFrozenHead,
      postPlanLedger,
      postPlanRollout,
      postPlanBilling,
      pushAdmission,
    ]].sort((left, right) => left - right));
    expect(postPlanCommit).toBeGreaterThan(planVerification);
  });

  it("keeps database passwords out of arguments and environment values", () => {
    for (const content of [runner, runbook]) {
      expect(content).not.toContain("DATABASE_URL");
      expect(content).not.toContain("PGPASSWORD");
      expect(content).not.toContain("POSTGRES_PASSWORD=");
    }
    expect(runner).toContain("PGPASSFILE=/run/secrets/production.pgpass");
    expect(runner).toContain("OVD361_PRODUCTION_PGPASS_FILE");
    expect(runner).toContain("PGSSLMODE=verify-full");
    expect(runner).toContain("PGSSLROOTCERT=/run/secrets/production-ca.crt");
    expect(runner).toContain("OVD361_PRODUCTION_CA_FILE");
    expect(runbook).toContain("PGPASSFILE=/run/secrets/restore.pgpass");
    expect(runbook).toContain("POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password");
    expect(runbook).not.toContain("supabase db dump");
    expect(runbook).toContain("--entrypoint pg_dumpall");
    expect(runbook).toContain("--roles-only --role postgres --quote-all-identifiers");
    expect(runbook).toContain("filter-ovd373-role-dump.sh");
    expect(runbook).toContain("--entrypoint pg_dump");
    expect(runbook).toContain("PGSSLMODE=verify-full");
    expect(runbook).toContain("PGSSLROOTCERT=/run/secrets/production-ca.crt");
  });

  it("refuses to overwrite a prior qualified backup", () => {
    expect(runbook).toContain('umask 077');
    expect(runbook).toContain('Refusing to replace an existing backup path.');
    expect(runbook).not.toContain('test -d "$OVD361_BACKUP_DIR"');
  });

  it("binds every database write to the captured verified URL and disables prompts", () => {
    expect(runner).not.toContain("migration repair --linked");
    expect(runner).not.toContain("db push --linked");
    expect(runner).not.toContain("migration list --linked");
    expect(runner).toContain('migration repair --db-url "$OVD373_POOLER_URL"');
    expect(runner).toContain('db push --db-url "$OVD373_POOLER_URL"');
    expect(runner).toContain('migration list --db-url "$OVD373_POOLER_URL"');
    expect(runner).toContain('--include-all --yes');
  });

  it("classifies push admission and the exact applied prefix before repair recovery", () => {
    expect(runner).not.toContain("OVD373_PUSH_STARTED");
    expect(runner).toContain('OVD373_REPAIRS_ATTEMPTED=1');
    expect(runner).toContain('applied_output="$(list_applied_repair_versions)"');
    expect(runner).toContain('OVD373_PUSH_ADMISSION_MARKER="$OVD361_BACKUP_DIR/.ovd373-db-push-admitted"');
    expect(runner).toContain('list_applied_push_versions | node scripts/verify-ovd373-applied-prefix.mjs');
    expect(runner).toContain("'baseline:' || row_count::text");
    expect(runner).toContain("where version::text <> all");
    expect(runner).toContain("pg_catalog.md5(pg_catalog.to_json(statements)::text)");
    expect(runner).toContain('[[ "$applied_prefix" = "zero" ]]');
    expect(runner).toContain("verify-ovd373-repaired-ledger.sql");
    expect(runner).toContain("preserving repair rows for the reviewed resume path");
    expect(runner).toContain("Deployment locks were lost after push admission; refusing recovery writes.");
    expect(runner).toContain('supabase migration repair --db-url "$OVD373_POOLER_URL"');
    expect(runner).toContain("--status reverted --yes");
    expect(runner).toContain("Deployment locks are absent; refusing repair-ledger recovery writes.");
    expect(runner).toMatch(
      /run-ovd373-locked-command\.sh[\s\S]*migration repair --db-url[\s\S]*--status reverted/,
    );
    expect(runner).toContain('"${applied_repairs[$index]}"');
    expect(runner).toContain("verify-ovd372-production-preconditions.sql");
  });

  it("terminates the parent runner if the lock-holding database session exits", () => {
    expect(runner).toContain("run-ovd373-locked-command.sh");
    expect(lockedCommand).toContain('docker wait "$OVD373_LOCK_CONTAINER"');
    expect(lockedCommand).toContain('kill -TERM "$OVD373_COMMAND_PID"');
    expect(lockedCommand).toContain("lock holder exited while a guarded command was running");
  });

  it("keeps every post-push proof guarded until the success flag is set", () => {
    const push = indexOfRequired(
      'supabase db push --db-url "$OVD373_POOLER_URL" --include-all --yes',
    );
    const migrationList = runner.indexOf("run-ovd373-locked-command.sh", push + 1);
    const postconditions = runner.indexOf(
      "run_production_sql scripts/verify-ovd373-production-postconditions.sql",
      migrationList,
    );
    const schemaDump = runner.indexOf("run-ovd373-locked-command.sh", postconditions + 1);
    const schemaFingerprint = runner.indexOf(
      "run-ovd373-locked-command.sh",
      schemaDump + 1,
    );
    const billingProbe = runner.indexOf(
      "run-ovd373-locked-command.sh",
      schemaFingerprint + 1,
    );
    const finalLockCheck = runner.indexOf("require_lock_holder", billingProbe);
    const success = runner.indexOf("OVD373_UPGRADE_SUCCEEDED=1", finalLockCheck);

    expect([
      migrationList,
      postconditions,
      schemaDump,
      schemaFingerprint,
      billingProbe,
      finalLockCheck,
      success,
    ]).toEqual([...[
      migrationList,
      postconditions,
      schemaDump,
      schemaFingerprint,
      billingProbe,
      finalLockCheck,
      success,
    ]].sort((left, right) => left - right));
    expect(migrationList).toBeGreaterThan(push);
  });

  it("pins the exact repaired ledger without customer-row access", () => {
    expect(repairedLedgerSql).toContain("v_count <> 79");
    expect(repairedLedgerSql).toContain("v_head <> '20260813005020'");
    expect(repairedLedgerSql).toContain("92d2ff85964bc3a325b7a65cfe7d66d7");
    expect(repairedLedgerSql).toContain("begin read only;");
    expect(repairedLedgerSql).not.toMatch(
      /\b(from|join)\s+(auth\.users|storage\.objects|public\.(jobs|job_files|quote_requests))\b/i,
    );
  });
});
