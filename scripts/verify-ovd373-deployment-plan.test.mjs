import { describe, expect, it } from "vitest";
import {
  EXPECTED_DRY_RUN_MIGRATION_FILENAMES,
  EXPECTED_PRODUCTION_PROJECT_REF,
  EXPECTED_REPAIR_VERSIONS,
  OVD372_QUALIFICATION_MERGE_COMMIT,
  parseDryRunMigrationFilenames,
  validateDeploymentPlan,
} from "./verify-ovd373-deployment-plan.mjs";

const CURRENT_MAIN_COMMIT = "ec50d63b58011b297d9324fd1eb9e6fd2e518fc8";

function dryRunOutput(filenames = EXPECTED_DRY_RUN_MIGRATION_FILENAMES) {
  return [
    "Supabase CLI preview (no changes made):",
    ...filenames.map((filename) => `Would apply ${filename}`),
  ].join("\n");
}

function validPlan(overrides = {}) {
  return {
    projectRef: EXPECTED_PRODUCTION_PROJECT_REF,
    currentCommit: CURRENT_MAIN_COMMIT,
    ancestorVerified: true,
    repairVersions: [...EXPECTED_REPAIR_VERSIONS],
    dryRunOutput: dryRunOutput(),
    ...overrides,
  };
}

describe("OVD-373 deployment-plan verifier", () => {
  it("accepts the exact project, qualified source ancestry, repairs, and dry-run", () => {
    expect(validateDeploymentPlan(validPlan())).toEqual([]);
  });

  it("parses only ordered migration filenames from captured dry-run output", () => {
    expect(
      parseDryRunMigrationFilenames(
        `Applying 20260816 migrations\n${dryRunOutput()}\n20 migrations`,
      ),
    ).toEqual(EXPECTED_DRY_RUN_MIGRATION_FILENAMES);
  });

  it("rejects the wrong production target", () => {
    const violations = validateDeploymentPlan(validPlan({ projectRef: "wrong-project" }));

    expect(violations).toContain(
      `project ref: expected ${EXPECTED_PRODUCTION_PROJECT_REF}, found wrong-project`,
    );
  });

  it("rejects a source that is not descended from the OVD-372 qualification merge", () => {
    const violations = validateDeploymentPlan(
      validPlan({
        currentCommit: "1111111111111111111111111111111111111111",
        ancestorVerified: false,
      }),
    );

    expect(violations).toContain(
      `source commit: ${OVD372_QUALIFICATION_MERGE_COMMIT} is not an ancestor of current main`,
    );
  });

  it("rejects altered, missing, extra, and reordered repair versions", () => {
    const altered = [...EXPECTED_REPAIR_VERSIONS];
    altered[0] = "20260402100001";
    const missing = EXPECTED_REPAIR_VERSIONS.slice(0, -1);
    const extra = [...EXPECTED_REPAIR_VERSIONS, "20260816015000"];
    const reordered = [...EXPECTED_REPAIR_VERSIONS].reverse();

    expect(validateDeploymentPlan(validPlan({ repairVersions: altered }))).toEqual([
      expect.stringContaining("history repairs: missing 20260402100000"),
      expect.stringContaining("history repairs: extra 20260402100001"),
    ]);
    expect(validateDeploymentPlan(validPlan({ repairVersions: missing }))).toEqual([
      expect.stringContaining("history repairs: missing 20260731015400"),
    ]);
    expect(validateDeploymentPlan(validPlan({ repairVersions: extra }))).toEqual([
      expect.stringContaining("history repairs: extra 20260816015000"),
    ]);
    expect(validateDeploymentPlan(validPlan({ repairVersions: reordered }))).toEqual([
      "history repairs: files are reordered",
    ]);
  });

  it("rejects a repair version with a valid prefix and trailing text", () => {
    const suffixed = [...EXPECTED_REPAIR_VERSIONS];
    suffixed[0] = `${suffixed[0]}oops`;

    expect(validateDeploymentPlan(validPlan({ repairVersions: suffixed }))).toEqual([
      expect.stringContaining("history repairs: missing 20260402100000"),
      expect.stringContaining("history repairs: extra 20260402100000oops"),
    ]);
  });

  it("rejects altered, missing, extra, and reordered dry-run migrations", () => {
    const altered = [...EXPECTED_DRY_RUN_MIGRATION_FILENAMES];
    altered[0] = "20260330144838_wrong_migration.sql";
    const missing = EXPECTED_DRY_RUN_MIGRATION_FILENAMES.slice(0, -1);
    const extra = [...EXPECTED_DRY_RUN_MIGRATION_FILENAMES, "20260816020000_unexpected.sql"];
    const reordered = [...EXPECTED_DRY_RUN_MIGRATION_FILENAMES].reverse();

    expect(
      validateDeploymentPlan(validPlan({ dryRunOutput: dryRunOutput(altered) })),
    ).toEqual([
      expect.stringContaining(
        "dry-run migrations: missing 20260330144838_align_destructive_job_auth_contract.sql",
      ),
      expect.stringContaining("dry-run migrations: extra 20260330144838_wrong_migration.sql"),
    ]);
    expect(
      validateDeploymentPlan(validPlan({ dryRunOutput: dryRunOutput(missing) })),
    ).toEqual([
      expect.stringContaining(
        "dry-run migrations: missing 20260816015500_restore_production_first_quote_contracts.sql",
      ),
    ]);
    expect(
      validateDeploymentPlan(validPlan({ dryRunOutput: dryRunOutput(extra) })),
    ).toEqual([
      expect.stringContaining("dry-run migrations: extra 20260816020000_unexpected.sql"),
    ]);
    expect(
      validateDeploymentPlan(validPlan({ dryRunOutput: dryRunOutput(reordered) })),
    ).toEqual(["dry-run migrations: files are reordered"]);
  });
});
