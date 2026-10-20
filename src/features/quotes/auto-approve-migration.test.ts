import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260317013000_fix_auto_approve_stale_auto_refresh.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

// OVD-979 replaced this definition in 20261020002126 (see the second describe block).
// The 20260317013000 file is immutable history; it is pinned here as the baseline text.
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

// OVD-979 replaced the definition above in 20261020002126. The 20260317013000 file is
// immutable history and is no longer the live definition, so the checks below pin the
// text of the latest one.
const latestMigrationFile = "20261020002126_ovd979_auto_approve_keep_user_corrections.sql";
const migrationsDir = path.join(process.cwd(), "supabase/migrations");
const latestSql = readFileSync(path.join(migrationsDir, latestMigrationFile), "utf8");

describe("api_auto_approve_job_requirements latest definition (OVD-979)", () => {
  it("is the live definition: no later migration redefines the function", () => {
    const definers = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) =>
        /create\s+(?:or\s+replace\s+)?function\s+public\.api_auto_approve_job_requirements\s*\(/i.test(
          readFileSync(path.join(migrationsDir, name), "utf8"),
        ),
      );
    // If this fails, a newer migration replaced the function: point latestMigrationFile at it
    // and re-check each pin below against the new text.
    expect(definers.at(-1)).toBe(latestMigrationFile);
  });

  it("keeps SECURITY DEFINER, a pinned search_path and the service_role-only ACL", () => {
    expect(latestSql).toMatch(/security definer\s+set search_path = pg_catalog, public\s+as \$\$/);
    expect(latestSql).toContain("revoke execute on function public.api_auto_approve_job_requirements(uuid) from public;");
    expect(latestSql).toContain(
      "revoke execute on function public.api_auto_approve_job_requirements(uuid) from anon, authenticated;",
    );
    expect(latestSql).toContain(
      "grant execute on function public.api_auto_approve_job_requirements(uuid) to service_role;",
    );
    expect(latestSql).not.toMatch(
      /grant execute on function public\.api_auto_approve_job_requirements\(uuid\) to (?:public|anon|authenticated)/,
    );
  });

  it("treats a client property override as user-owned, next to the legacy field provenance", () => {
    for (const field of ["description", "partNumber", "revision", "finish"]) {
      expect(latestSql).toContain(`v_property_overrides ? '${field}'`);
    }
    expect(latestSql).toContain("v_description_source <> 'auto' or v_property_overrides ? 'description'");
    expect(latestSql).toContain("#> '{projectPartProperties,overrides}'");
  });

  it("refreshes a field from a newer extraction only when it is not user-owned", () => {
    for (const field of ["description", "part_number", "revision", "finish"]) {
      expect(latestSql).toContain(
        `v_${field}_refresh := not v_${field}_user_owned and v_extraction_newer and not v_${field}_review_needed;`,
      );
      expect(latestSql).toContain(`when v_${field}_refresh then`);
      // The pre-OVD-979 test, which read the legacy provenance alone, must not come back.
      expect(latestSql).not.toMatch(new RegExp(`when v_${field}_source = 'auto' and v_extraction_newer`));
    }
  });

  it("does not make a refreshed value sticky: legacy fieldSources and fieldOverrides are written as before", () => {
    for (const [key, variable] of [
      ["description", "description"],
      ["partNumber", "part_number"],
      ["revision", "revision"],
      ["finish", "finish"],
    ]) {
      // fieldSources keeps the legacy provenance value; fieldOverrides keeps its boolean.
      expect(latestSql).toMatch(new RegExp(`'${key}', v_${variable}_source\\s*[,)]`));
      expect(latestSql).toContain(`'${key}', v_${variable}_source <> 'auto'`);
    }
  });

  it("moves the editor defaults with a refreshed field and replaces the Unknown material placeholder", () => {
    expect(latestSql).toContain("jsonb_set(v_spec_snapshot, '{projectPartProperties,defaults}', v_property_defaults)");
    expect(latestSql).toContain(
      "v_material_placeholder_replaced := trim(coalesce(v_requirement.material, '')) = 'Unknown material'",
    );
    expect(latestSql).toContain("and not (v_property_overrides ? 'material')");
    expect(latestSql).toContain("case when v_material_placeholder_replaced then null");
  });

  it("keeps tolerance at the requirement value for a part with a drawing_attached extraction", () => {
    expect(latestSql).toContain("queue.payload ->> 'reason' = 'drawing_attached'");
    expect(latestSql).toMatch(
      /when v_drawing_attached then v_requirement\.tightest_tolerance_inch\s+else coalesce\(\s+v_requirement\.tightest_tolerance_inch,/,
    );
  });

  it("never moves a job that is quoting or later when the extraction rollup runs", () => {
    const guard = "and status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote');";
    expect(latestSql.split(guard).length - 1).toBe(3);
    for (const target of ["extracting", "needs_spec_review", "ready_to_quote"]) {
      expect(latestSql).toMatch(new RegExp(`set status = '${target}'\\s+where id = p_job_id\\s+and status in \\(`));
    }
  });
});
