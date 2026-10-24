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

  it("does not count a running drawing_attached task as pending only with evidence from its current claim (review r3, fix round 7)", () => {
    // The worker calls this function before it marks its own task completed. Fix round 7: the stored row
    // must have been written after the task was claimed, so a retry that still holds its failed attempt's
    // row is pending. The set is read before the loop, because the loop's own status updates are stamped
    // by the touch trigger and would otherwise pass for the worker's write.
    expect(latestSql).toMatch(
      /select coalesce\(array_agg\(queue\.id\), '\{\}'::uuid\[\]\)\s+into v_finishing_attach_tasks\s+from public\.work_queue queue\s+where queue\.job_id = p_job_id\s+and queue\.task_type = 'extract_part'\s+and queue\.status = 'running'\s+and queue\.payload ->> 'reason' = 'drawing_attached'\s+and exists \(\s+select 1\s+from public\.drawing_extractions stored\s+where stored\.part_id = queue\.part_id\s+and stored\.extractor_version not like 'worker-sim-%'\s+and stored\.updated_at > queue\.locked_at\s+\);/,
    );
    expect(latestSql).toMatch(
      /into v_pending_extract_tasks\s+from public\.work_queue queue\s+where queue\.job_id = p_job_id\s+and queue\.task_type = 'extract_part'\s+and queue\.status in \('queued', 'running'\)\s+and not \(queue\.id = any\(v_finishing_attach_tasks\)\);/,
    );
    const evidence = latestSql.indexOf("into v_finishing_attach_tasks");
    const loop = latestSql.indexOf("  for v_part in");
    const firstStatusUpdate = latestSql.indexOf("update public.drawing_extractions");
    expect(evidence).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(evidence);
    expect(firstStatusUpdate).toBeGreaterThan(loop);
  });

  it("does not stamp an extraction row that is older than a running attach claim of its part (fix round 7)", () => {
    // Another part's auto-approval would otherwise set the status of the retry's old row, the touch trigger
    // would stamp it, and the stamp would read as the retry's own result.
    expect(latestSql).toMatch(
      /v_extraction_before_claim := v_extraction\.id is not null and exists \(\s+select 1\s+from public\.work_queue claim\s+where claim\.job_id = p_job_id\s+and claim\.part_id = v_part\.id\s+and claim\.task_type = 'extract_part'\s+and claim\.status = 'running'\s+and claim\.payload ->> 'reason' = 'drawing_attached'\s+and claim\.locked_at >= v_extraction\.updated_at\s+\);/,
    );
    const updates = latestSql.match(/if v_extraction\.id is not null(?: and not v_extraction_before_claim)? then\s+update public\.drawing_extractions/g) ?? [];
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update).toContain("and not v_extraction_before_claim");
    }
  });

  it("locks the job row before it reads a requirement, in the documented lock order (fix round 7)", () => {
    expect(latestSql).toContain("-- LOCK ORDER (fix round 7).");
    const lock = latestSql.search(/select \*\s+into v_job\s+from public\.jobs\s+where id = p_job_id\s+for no key update;/);
    const firstRequirementRead = latestSql.indexOf("from public.approved_part_requirements\n    where part_id = v_part.id;");
    expect(lock).toBeGreaterThan(0);
    expect(firstRequirementRead).toBeGreaterThan(lock);
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

  it("queues a drawing attach once: not while queued, deferred while another task runs, not again for a completed drawing", () => {
    const request = extractFunction(requestSql, "api_request_extraction");
    expect(request).toContain("placement_extraction.extractor_version like 'worker-sim-%'");
    expect(request).toContain("and done.payload ->> 'drawingFileId' = part.drawing_file_id::text");
    expect(request).toMatch(
      /and not exists \(\s+select 1 from public\.work_queue queue\s+where queue\.part_id = part\.id\s+and queue\.task_type = 'extract_part'\s+and queue\.status = 'queued'\s+\)/,
    );
    // Fix round 7: behind a running task only when that task is not for the current drawing.
    expect(request).toMatch(
      /and \(\s+running_task\.id is null\s+or \(\s+part\.drawing_file_id is not null\s+and not exists \(\s+select 1 from public\.work_queue same_drawing\s+where same_drawing\.job_id = p_job_id\s+and same_drawing\.part_id = part\.id\s+and same_drawing\.task_type = 'extract_part'\s+and same_drawing\.status in \('running', 'completed'\)\s+and same_drawing\.payload ->> 'drawingFileId' = part\.drawing_file_id::text\s+\)\s+\)\s+\)/,
    );
  });

  it("defers a drawing attached during a running extraction and releases it when that task settles (fix round 7)", () => {
    const request = extractFunction(requestSql, "api_request_extraction");
    expect(request).toContain("jsonb_build_object('awaitingTaskId', running_task.id)");
    expect(request).toMatch(
      /case\s+when running_task\.id is null then timezone\('utc', now\(\)\)\s+else timezone\('utc', now\(\)\) \+ interval '1 hour'\s+end/,
    );
    // Lock order: the job row before api_reconcile_job_parts locks parts, then the running tasks, then
    // the insert (a settlement committing in between would otherwise miss the deferred row).
    const jobLock = request.indexOf("perform 1 from public.jobs where id = p_job_id for no key update;");
    const reconcile = request.indexOf("perform public.api_reconcile_job_parts(p_job_id);");
    const taskLock = request.search(/perform 1 from public\.work_queue running[\s\S]*?for no key update;/);
    const insert = request.indexOf("insert into public.work_queue (");
    expect(jobLock).toBeGreaterThan(request.indexOf("pg_advisory_xact_lock"));
    expect(reconcile).toBeGreaterThan(jobLock);
    expect(taskLock).toBeGreaterThan(reconcile);
    expect(insert).toBeGreaterThan(taskLock);
    expect(requestSql).toMatch(
      /create trigger release_deferred_drawing_extractions\s+after update of status on public\.work_queue\s+for each row\s+when \(\s+new\.task_type = 'extract_part'\s+and old\.status in \('queued', 'running'\)\s+and new\.status in \('completed', 'failed', 'cancelled'\)\s+\)\s+execute function private\.release_deferred_drawing_extractions\(\);/,
    );
    expect(requestSql).toMatch(
      /create or replace function private\.release_deferred_drawing_extractions\(\)\s+returns trigger\s+language plpgsql\s+security definer\s+set search_path = pg_catalog\s+as \$\$/,
    );
    expect(requestSql).toMatch(
      /and deferred\.status = 'queued'\s+and deferred\.payload ->> 'awaitingTaskId' = new\.id::text/,
    );
    expect(requestSql).toMatch(
      /revoke all on function private\.release_deferred_drawing_extractions\(\)\s+from public, anon, authenticated;/,
    );
  });

  it("rests on the claim honouring available_at and the worker settling tasks with a status update (fix round 7)", () => {
    // A deferred task is only safe if no worker can claim it early, and it is only released if every
    // settlement is an UPDATE of work_queue.status (the trigger is AFTER UPDATE OF status).
    const claim = readFileSync(path.join(migrationsDir, "20260324120000_add_api_claim_next_task.sql"), "utf8");
    expect(latestDefiner("api_claim_next_task")).toBe("20260324120000_add_api_claim_next_task.sql");
    expect(claim).toMatch(/WHERE status = 'queued'\s+AND available_at <= now\(\)/);
    const queue = readFileSync(path.join(process.cwd(), "worker/src/queue.ts"), "utf8");
    for (const [helper, status] of [
      ["markTaskCompleted", "completed"],
      ["markTaskFailed", "failed"],
      ["markTaskCancelled", "cancelled"],
    ]) {
      const start = queue.indexOf(`export async function ${helper}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = queue.slice(start, queue.indexOf("\n}\n", start));
      expect(body).toContain('.from("work_queue")');
      expect(body).toContain(`status: "${status}"`);
    }
  });

  it("retries an attach task that failed or was cancelled after the worker stored its extraction (review r6)", () => {
    // The extraction row is no longer CAD-only by then, so the CAD-only test alone never matches the
    // part again. The retry test is an alternative to it, for the same drawing only, and the
    // completed-task guard still applies to both.
    const request = extractFunction(requestSql, "api_request_extraction");
    expect(request).toMatch(
      /part\.drawing_file_id is not null\s+and \(\s+placement_extraction\.extractor_version like 'worker-sim-%'\s+(?:--[^\n]*\n\s+)*or exists \(\s+select 1 from public\.work_queue unsuccessful\s+where unsuccessful\.job_id = p_job_id\s+and unsuccessful\.part_id = part\.id\s+and unsuccessful\.task_type = 'extract_part'\s+and unsuccessful\.status in \('failed', 'cancelled'\)\s+and unsuccessful\.payload ->> 'drawingFileId' = part\.drawing_file_id::text\s+\)\s+\)\s+and not exists \(\s+select 1 from public\.work_queue done\s+where done\.job_id = p_job_id\s+and done\.part_id = part\.id\s+and done\.task_type = 'extract_part'\s+and done\.status = 'completed'\s+and done\.payload ->> 'drawingFileId' = part\.drawing_file_id::text\s+\)/,
    );
  });

  it("rests on the worker storing the extraction before the previews and the auto-approval (review r6)", () => {
    // If the worker ever stored the extraction last, a failure could no longer leave a non-CAD-only row
    // behind and the retry predicate above would be dead weight; if it moved the status change earlier,
    // re-check the retry test.
    const worker = readFileSync(path.join(process.cwd(), "worker/src/index.ts"), "utf8");
    const start = worker.indexOf("async function handleExtractTask(");
    const end = worker.indexOf("async function handleGenerateCadPreviewTask(");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = worker.slice(start, end);
    const stored = handler.indexOf('from("drawing_extractions").upsert(');
    const previews = handler.indexOf("await persistDrawingPreviewAssets(");
    const approved = handler.lastIndexOf("await autoApproveJobRequirements(");
    const completed = handler.lastIndexOf("await markTaskCompleted(");
    expect(stored).toBeGreaterThan(0);
    expect(previews).toBeGreaterThan(stored);
    expect(approved).toBeGreaterThan(previews);
    expect(completed).toBeGreaterThan(approved);
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
    // dedupe above, was never extracted from its drawing. Every other row is still kept. The
    // early returns of reviews r10 and r11 (next tests) and the claim stamp of fix round 7 are the only
    // other changes to the function body.
    const original = extractFunction(
      readFileSync(path.join(migrationsDir, "20260812042000_add_canonical_part_identity.sql"), "utf8"),
      "api_reuse_trusted_part_version_artifacts",
    );
    const current = extractFunction(requestSql, "api_reuse_trusted_part_version_artifacts");
    expect(current).toMatch(
      /on conflict \(part_id\) do update\s+set extractor_version = excluded\.extractor_version,[\s\S]*?where v_target\.drawing_file_id is not null\s+and public\.drawing_extractions\.extractor_version like 'worker-sim-%';/,
    );
    const earlyReturn = / {2}-- OVD-979 \(review r10, Codex\)[\s\S]*?\n {2}end if;\n\n/;
    const unfinishedReturn = / {2}-- OVD-979 \(review r11, Codex\)[\s\S]*?\n {2}end if;\n\n/;
    const conflictClause = / {2}-- OVD-979 \(review r2\): a part that has a drawing[\s\S]*?like 'worker-sim-%';\n/;
    const claimStamp = /\n {2}-- OVD-979 \(fix round 7, rule 11\)[\s\S]*?and v_target\.drawing_file_id is not null;\n/;
    expect(
      current
        .replace(earlyReturn, "")
        .replace(unfinishedReturn, "")
        .replace(claimStamp, "")
        .replace(conflictClause, "  on conflict (part_id) do nothing;\n"),
    ).toBe(original);
  });

  it("never copies a CAD-only source extraction onto a part that has a drawing (review r10)", () => {
    // The worker assigns the canonical version before it extracts, so a source whose attach task failed
    // before it stored anything owns a complete version and still holds the CAD-only row. Copying it over
    // the target's CAD-only row completed the target's task with no drawing data, and the completed-task
    // guard of api_request_extraction then kept it from ever being extracted. The reuse falls back to the
    // worker's independent extraction instead, and only after the source is settled (the pending checks).
    const reuse = extractFunction(requestSql, "api_reuse_trusted_part_version_artifacts");
    expect(reuse).toMatch(
      /if v_target\.drawing_file_id is not null\s+and exists \(\s+select 1 from public\.drawing_extractions extraction\s+where extraction\.part_id = v_source\.id\s+and extraction\.extractor_version like 'worker-sim-%'\s+\) then\s+return pg_catalog\.jsonb_build_object\(\s+'result', 'source_cad_only',\s+'partId', v_target\.id,\s+'partVersionId', v_version\.id,\s+'sourcePartId', v_source\.id,\s+'artifactsReady', false,\s+'extractTargetIndependently', true\s+\);\s+end if;/,
    );
    const pending = reuse.lastIndexOf("'result', 'existing_version_pending'");
    const earlyReturn = reuse.indexOf("'result', 'source_cad_only'");
    const copy = reuse.indexOf("insert into public.drawing_extractions (");
    expect(pending).toBeGreaterThan(0);
    expect(earlyReturn).toBeGreaterThan(pending);
    expect(copy).toBeGreaterThan(earlyReturn);
  });

  it("copies a source extraction only when the extract_part task that produced it completed (review r11)", () => {
    // The worker stores the extraction row before the previews and the approval, so a source whose task
    // failed or was cancelled after that point holds a drawing-derived row (not CAD-only) with possibly
    // missing previews and nothing queued or running. Copying it completed the target's task and the
    // completed-task guard of api_request_extraction then kept the target from ever being repaired. The
    // source needs a completed extract_part task that no failed or cancelled task created at or after it
    // follows; no task on record is not trusted either. Same fallback as review r10: the worker extracts
    // the target itself.
    const reuse = extractFunction(requestSql, "api_reuse_trusted_part_version_artifacts");
    expect(reuse).toMatch(
      /if not exists \(\s+select 1 from public\.work_queue finished\s+where finished\.job_id = v_source\.job_id\s+and finished\.part_id = v_source\.id\s+and finished\.task_type = 'extract_part'\s+and finished\.status = 'completed'\s+and not exists \(\s+select 1 from public\.work_queue unsuccessful\s+where unsuccessful\.job_id = v_source\.job_id\s+and unsuccessful\.part_id = v_source\.id\s+and unsuccessful\.task_type = 'extract_part'\s+and unsuccessful\.status in \('failed', 'cancelled'\)\s+and unsuccessful\.created_at >= finished\.created_at\s+\)\s+\) then\s+return pg_catalog\.jsonb_build_object\(\s+'result', 'source_extraction_unfinished',\s+'partId', v_target\.id,\s+'partVersionId', v_version\.id,\s+'sourcePartId', v_source\.id,\s+'artifactsReady', false,\s+'extractTargetIndependently', true\s+\);\s+end if;/,
    );
    // Order: after the pending checks (a source whose retry is queued or running is waited for) and the
    // CAD-only return, and before anything is copied.
    const pending = reuse.lastIndexOf("'result', 'existing_version_pending'");
    const cadOnly = reuse.indexOf("'result', 'source_cad_only'");
    const unfinished = reuse.indexOf("'result', 'source_extraction_unfinished'");
    const copy = reuse.indexOf("insert into public.drawing_extractions (");
    const previews = reuse.indexOf("insert into public.drawing_preview_assets (");
    expect(cadOnly).toBeGreaterThan(pending);
    expect(unfinished).toBeGreaterThan(cadOnly);
    expect(copy).toBeGreaterThan(unfinished);
    expect(previews).toBeGreaterThan(copy);
  });

  it("rests on a preview or approval failure ending the extract_part task as failed, after the row is stored (review r11)", () => {
    // If persistDrawingPreviewAssets were wrapped so that its errors were swallowed, or the extraction were
    // stored after the previews, a failed task would no longer be the signal that the artifacts are
    // incomplete and the check above would need another one.
    const worker = readFileSync(path.join(process.cwd(), "worker/src/index.ts"), "utf8");
    const start = worker.indexOf("async function handleExtractTask(");
    const handler = worker.slice(start, worker.indexOf("async function handleGenerateCadPreviewTask("));
    const stored = handler.indexOf('from("drawing_extractions").upsert(');
    const previews = handler.indexOf("await persistDrawingPreviewAssets(");
    expect(stored).toBeGreaterThan(0);
    expect(previews).toBeGreaterThan(stored);
    expect(handler.slice(stored, previews)).not.toContain("try {");
    // The handler rethrows to processClaimedTask, whose non-retryable path is markTaskFailed.
    expect(handler).toMatch(/\} catch \(error\) \{[\s\S]*?\n {4}throw error;\n {2}\} finally \{/);
    expect(worker).toMatch(
      /\} else \{\s+await markTaskFailed\(\s+supabase,\s+task,\s+failureEvidence\.failureMessage,/,
    );
  });

  it("rests on the worker extracting the target itself when the reuse asks for it (review r10)", () => {
    // artifactsReady false with extractTargetIndependently true must fall through to the extraction (and
    // not throw CanonicalArtifactsPendingError, which only waits for the source), and the version the
    // worker writes for a staged drawing must stay distinguishable from the CAD-only one.
    const worker = readFileSync(path.join(process.cwd(), "worker/src/index.ts"), "utf8");
    const start = worker.indexOf("async function handleExtractTask(");
    const handler = worker.slice(start, worker.indexOf("async function handleGenerateCadPreviewTask("));
    expect(handler).toMatch(
      /if \(!artifactsReady\) \{\s+if \(!extractTargetIndependently\) \{\s+throw new CanonicalArtifactsPendingError\(sourcePartId\);\s+\}\s+\} else \{/,
    );
    expect(handler.indexOf("await runDrawingExtractionForTask(")).toBeGreaterThan(handler.indexOf("} else {"));
    const shared = readFileSync(path.join(process.cwd(), "worker/src/extraction/sharedResult.ts"), "utf8");
    expect(shared).toContain('SIM_EXTRACTOR_VERSION = "worker-sim-v1"');
    expect(shared).toMatch(
      /currentExtractorVersion\(hasDrawingFile: boolean\) \{\s+return hasDrawingFile \? PDF_EXTRACTOR_VERSION : SIM_EXTRACTOR_VERSION;/,
    );
  });
});

// Fix round 7: the client save and reset take the job row lock through their shared context loader, so
// they serialize with auto-approval (lock 1 of the LOCK ORDER in 20261020002126).
describe("load_editable_project_part_context latest definition (OVD-979 fix round 7)", () => {
  it("is redefined in the OVD-979 migration and nowhere later", () => {
    expect(latestDefiner("load_editable_project_part_context")).toBe(latestMigrationFile);
  });

  it("locks the job row after the access checks and before reading the part, and is otherwise verbatim", () => {
    const original = extractFunction(
      readFileSync(path.join(migrationsDir, "20260402120000_persist_project_part_property_overrides.sql"), "utf8"),
      "load_editable_project_part_context",
    );
    const current = extractFunction(latestSql, "load_editable_project_part_context");
    const access = current.indexOf("if not public.user_can_edit_job(v_job.id) then");
    const lock = current.search(/select \*\s+into v_job\s+from public\.jobs\s+where id = p_job_id\s+for no key update;/);
    const partRead = current.indexOf("from public.parts\n  where job_id = v_job.id");
    expect(access).toBeGreaterThan(current.indexOf("perform public.require_verified_auth();"));
    expect(lock).toBeGreaterThan(access);
    expect(partRead).toBeGreaterThan(lock);
    const lockBlock = /\n {2}-- OVD-979 \(fix round 7\): lock 1 of the LOCK ORDER[\s\S]*?for no key update;\n/;
    expect(
      current
        .replace("language plpgsql\nvolatile\nsecurity definer\nset search_path = pg_catalog, public", "language plpgsql\nstable\nsecurity definer\nset search_path = public")
        .replace(lockBlock, ""),
    ).toBe(original);
  });

  it("keeps SECURITY DEFINER and restates the service_role-only ACL", () => {
    expect(latestSql).toContain(
      "revoke execute on function public.load_editable_project_part_context(uuid) from public, anon, authenticated;",
    );
    expect(latestSql).toContain("grant execute on function public.load_editable_project_part_context(uuid) to service_role;");
    expect(latestSql).not.toMatch(
      /grant execute on function public\.load_editable_project_part_context\(uuid\) to (?:public|anon|authenticated)/,
    );
  });

  it("is what the save and reset RPCs call before they read anything", () => {
    const save = readFileSync(path.join(migrationsDir, "20260408120000_add_revision_process_to_property_overrides.sql"), "utf8");
    expect(latestDefiner("api_update_client_part_request")).toBe("20260408120000_add_revision_process_to_property_overrides.sql");
    expect(latestDefiner("api_reset_client_part_property_overrides")).toBe(
      "20260408120000_add_revision_process_to_property_overrides.sql",
    );
    for (const name of ["api_reset_client_part_property_overrides", "api_update_client_part_request"]) {
      const body = extractFunction(save, name);
      const begin = body.indexOf("\nbegin\n");
      const load = body.indexOf("public.load_editable_project_part_context(p_job_id)");
      expect(load).toBeGreaterThan(begin);
      expect(body.slice(begin, load)).not.toMatch(/\bfrom public\.(?:approved_part_requirements|parts|drawing_extractions)\b/);
    }
  });
});
