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

  it("is a byte copy of its reviewed draft", () => {
    const draft = readFileSync(path.join(process.cwd(), "docs/migration-drafts/ovd-979-a.sql"));
    expect(readFileSync(path.join(migrationsDir, latestMigrationFile)).equals(draft)).toBe(true);
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

  it("keeps the other fieldSources and fieldOverrides keys when it rewrites the four legacy ones", () => {
    // A fieldSources.material = 'user' is what keeps the Unknown material placeholder in place; a
    // rewrite that rebuilt the object from the four keys dropped it, so the next run replaced it.
    for (const object of ["fieldSources", "fieldOverrides"]) {
      expect(latestSql).toMatch(
        new RegExp(
          `'${object}', case\\s+when jsonb_typeof\\(v_requirement\\.spec_snapshot -> '${object}'\\) = 'object'\\s+` +
            `then v_requirement\\.spec_snapshot -> '${object}'\\s+else '\\{\\}'::jsonb\\s+end \\|\\| jsonb_build_object\\(`,
        ),
      );
    }
  });

  it("moves the editor default of an override-owned field to a newer extraction, never the column", () => {
    for (const [field, variable] of [
      ["description", "description"],
      ["partNumber", "part_number"],
      ["revision", "revision"],
      ["finish", "finish"],
    ]) {
      expect(latestSql).toContain(`elsif v_property_overrides ? '${field}' and v_extraction_newer`);
      expect(latestSql).toContain(`and not v_${variable}_review_needed and v_extracted_${variable} is not null then`);
      expect(latestSql).toContain(`jsonb_build_object('${field}', v_extracted_${variable})`);
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

  it("does not count a running drawing_attached task whose extraction is stored as pending (review r3)", () => {
    // The worker calls this function before it marks its own task completed. The 'reason'
    // comparison must be null-safe: with a plain '=' a task without a reason makes the whole
    // 'not (...)' null, which would drop every running first-extraction task from the count too.
    expect(latestSql).toMatch(
      /into v_pending_extract_tasks\s+from public\.work_queue queue\s+where queue\.job_id = p_job_id\s+and queue\.task_type = 'extract_part'\s+and queue\.status in \('queued', 'running'\)\s+and not \(\s+queue\.status = 'running'\s+and queue\.payload ->> 'reason' is not distinct from 'drawing_attached'\s+and exists \(\s+select 1\s+from public\.drawing_extractions stored\s+where stored\.part_id = queue\.part_id\s+and stored\.extractor_version not like 'worker-sim-%'\s+\)\s+\);/,
    );
    expect(latestSql).not.toMatch(/and queue\.payload ->> 'reason' = 'drawing_attached'\s+and exists/);
  });

  it("does not count a failed extract_part task that a later task of the same part replaced (review r3)", () => {
    expect(latestSql).toMatch(
      /into v_failed_extract_tasks\s+from public\.work_queue queue\s+where queue\.job_id = p_job_id\s+and queue\.task_type = 'extract_part'\s+and queue\.status = 'failed'\s+and not exists \(\s+select 1\s+from public\.work_queue later\s+where later\.job_id = p_job_id\s+and later\.part_id = queue\.part_id\s+and later\.task_type = 'extract_part'\s+and later\.status in \('queued', 'running', 'completed'\)\s+and later\.created_at > queue\.created_at\s+\);/,
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

// Part b: api_request_extraction (queue one extraction for an attached drawing) and the trusted
// reuse path that must be able to complete it. Both functions are replaced in one migration.
const requestMigrationFile = "20261020002127_ovd979_request_extraction_drawing_attached.sql";
const requestSql = readFileSync(path.join(migrationsDir, requestMigrationFile), "utf8");

function latestDefiner(functionName: string) {
  const pattern = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${functionName}\\s*\\(`, "i");
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => pattern.test(readFileSync(path.join(migrationsDir, name), "utf8")))
    .at(-1);
}

function extractFunction(sql: string, functionName: string) {
  const start = sql.indexOf(`create or replace function public.${functionName}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf("$$;", sql.indexOf("as $$", start)) + 3);
}

describe("api_request_extraction and trusted reuse latest definitions (OVD-979 part b)", () => {
  it("is the live definition of both functions: no later migration redefines either", () => {
    // If this fails, a newer migration replaced a function: point requestMigrationFile at it
    // and re-check each pin below against the new text.
    expect(latestDefiner("api_request_extraction")).toBe(requestMigrationFile);
    expect(latestDefiner("api_reuse_trusted_part_version_artifacts")).toBe(requestMigrationFile);
  });

  it("is a byte copy of its reviewed draft", () => {
    const draft = readFileSync(path.join(process.cwd(), "docs/migration-drafts/ovd-979-b.sql"));
    expect(readFileSync(path.join(migrationsDir, requestMigrationFile)).equals(draft)).toBe(true);
  });

  it("keeps SECURITY DEFINER, the pinned search_path and the ACL of api_request_extraction", () => {
    expect(requestSql).toMatch(
      /create or replace function public\.api_request_extraction\(p_job_id uuid\)\s+returns integer\s+language plpgsql\s+security definer\s+set search_path = pg_catalog, public\s+as \$\$/,
    );
    expect(requestSql).toContain("revoke execute on function public.api_request_extraction(uuid) from public, anon;");
    expect(requestSql).toContain(
      "grant execute on function public.api_request_extraction(uuid) to authenticated, service_role;",
    );
  });

  it("queues a drawing attach once: not while queued or running, and not again for a completed drawing", () => {
    expect(requestSql).toContain("and placement_extraction.extractor_version like 'worker-sim-%'");
    expect(requestSql).toContain("and done.payload ->> 'drawingFileId' = part.drawing_file_id::text");
    expect(requestSql).toMatch(/and queue\.status in \('queued', 'running'\)/);
  });

  it("keeps the worker-only check, SECURITY DEFINER, search_path and service_role-only ACL of the reuse function", () => {
    expect(requestSql).toMatch(
      /create or replace function public\.api_reuse_trusted_part_version_artifacts\(\s+p_target_part_id uuid,\s+p_source_part_id uuid,\s+p_part_version_id uuid\s+\)\s+returns jsonb\s+language plpgsql\s+security definer\s+set search_path = pg_catalog\s+as \$\$/,
    );
    expect(requestSql).toContain("if auth.role() <> 'service_role' then");
    expect(requestSql).toMatch(
      /revoke all on function public\.api_reuse_trusted_part_version_artifacts\(uuid, uuid, uuid\)\s+from public, anon, authenticated;/,
    );
    expect(requestSql).toMatch(
      /grant execute on function public\.api_reuse_trusted_part_version_artifacts\(uuid, uuid, uuid\)\s+to service_role;/,
    );
    expect(requestSql).not.toMatch(
      /grant\s+(?:execute|all)\s+on function public\.api_reuse_trusted_part_version_artifacts[^;]*\bto\s+(?:public|anon|authenticated)\b/,
    );
  });

  it("replaces only a CAD-only worker extraction of a part that has a drawing, and is otherwise verbatim", () => {
    // A part that holds the CAD-only extraction the worker wrote before its drawing existed completed
    // its reuse task with that row kept (ON CONFLICT DO NOTHING) and, with the completed-task
    // dedupe above, was never extracted from its drawing. Every other row is still kept.
    const original = extractFunction(
      readFileSync(path.join(migrationsDir, "20260812042000_add_canonical_part_identity.sql"), "utf8"),
      "api_reuse_trusted_part_version_artifacts",
    );
    const current = extractFunction(requestSql, "api_reuse_trusted_part_version_artifacts");
    expect(current).toMatch(
      /on conflict \(part_id\) do update\s+set extractor_version = excluded\.extractor_version,[\s\S]*?where v_target\.drawing_file_id is not null\s+and public\.drawing_extractions\.extractor_version like 'worker-sim-%';/,
    );
    const conflictClause = / {2}-- OVD-979 \(review r2\): a part that has a drawing[\s\S]*?like 'worker-sim-%';\n/;
    expect(current.replace(conflictClause, "  on conflict (part_id) do nothing;\n")).toBe(original);
  });
});
