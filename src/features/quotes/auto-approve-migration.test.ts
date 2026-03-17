import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260317013000_fix_auto_approve_stale_auto_refresh.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("api_auto_approve_job_requirements migration", () => {
  it("treats missing field provenance as auto-managed", () => {
    expect(migrationSql).toContain("v_requirement.spec_snapshot #>> '{fieldSources,description}'");
    expect(migrationSql).toContain("v_requirement.spec_snapshot #>> '{fieldSources,partNumber}'");
    expect(migrationSql).toContain("v_requirement.spec_snapshot #>> '{fieldSources,revision}'");
    expect(migrationSql).toContain("v_requirement.spec_snapshot #>> '{fieldSources,finish}'");
    expect(migrationSql.match(/'auto'/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(migrationSql).not.toContain("case when v_requirement.id is null then 'auto' else 'user' end");
  });

  it("only refreshes auto-managed fields from newer extraction data", () => {
    expect(migrationSql).toContain("v_extraction_newer boolean := false;");
    expect(migrationSql).toContain("v_extraction_newer := v_extraction.id is not null and (");
    expect(migrationSql).toMatch(
      /when v_description_source = 'auto' and v_extraction_newer and not v_description_review_needed then/,
    );
    expect(migrationSql).toMatch(
      /when v_part_number_source = 'auto' and v_extraction_newer and not v_part_number_review_needed then/,
    );
    expect(migrationSql).toMatch(
      /when v_revision_source = 'auto' and v_extraction_newer and not v_revision_review_needed then/,
    );
    expect(migrationSql).toMatch(
      /when v_finish_source = 'auto' and v_extraction_newer and not v_finish_review_needed then/,
    );
  });
});
