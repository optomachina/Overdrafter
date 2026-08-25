import { describe, expect, it } from "vitest";
import { EXPECTED_DRY_RUN_MIGRATION_FILENAMES, parseDryRunMigrationFilenames, validateDeploymentPlan } from "./verify-ovd417-deployment-plan.mjs";

function capture(filenames = EXPECTED_DRY_RUN_MIGRATION_FILENAMES) {
  return ["DRY RUN: migrations will not be pushed.", "Would push these migrations:", ...filenames.map((filename) => ` • \u001b[1m${filename}\u001b[0m`), "Finished supabase db push."].join("\n");
}
function plan(overrides = {}) { return { repairVersions: [], seedVersions: [], extraMigrationCount: 0, dryRunOutput: capture(), ...overrides }; }

describe("OVD-417 deployment-plan verifier", () => {
  it("accepts exactly the four reviewed migrations and no repairs, seeds, or extras", () => {
    expect(validateDeploymentPlan(plan())).toEqual([]);
  });
  it("parses only ordered filenames under the exact dry-run header", () => {
    expect(parseDryRunMigrationFilenames(`ignored 20260817133902\n${capture()}\nignored`)).toEqual(EXPECTED_DRY_RUN_MIGRATION_FILENAMES);
    expect(parseDryRunMigrationFilenames(` • ${EXPECTED_DRY_RUN_MIGRATION_FILENAMES[0]}`)).toEqual([]);
  });
  it("rejects missing, extra, and reordered capture entries", () => {
    expect(validateDeploymentPlan(plan({ dryRunOutput: capture(EXPECTED_DRY_RUN_MIGRATION_FILENAMES.slice(0, -1)) }))).toEqual([expect.stringContaining("dry-run migrations: missing")]);
    expect(validateDeploymentPlan(plan({ dryRunOutput: capture([...EXPECTED_DRY_RUN_MIGRATION_FILENAMES, "20260822213331_extra.sql"]) }))).toEqual([expect.stringContaining("dry-run migrations: extra")]);
    expect(validateDeploymentPlan(plan({ dryRunOutput: capture([...EXPECTED_DRY_RUN_MIGRATION_FILENAMES].reverse()) }))).toEqual(["dry-run migrations: files are reordered"]);
  });
  it("rejects every repair, seed, and extra migration claim", () => {
    expect(validateDeploymentPlan(plan({ repairVersions: ["20260817054500"], seedVersions: ["seed"], extraMigrationCount: 1 }))).toEqual(["history repairs: expected none", "seed migrations: expected none", "extra migrations: expected 0"]);
  });
});
