import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanFunctionEvents } from "../../../scripts/check-migration-function-collisions.mjs";
import { rollbackSql } from "../../../scripts/ovd979-rollback.mjs";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const migrationSql = read("supabase/migrations/20261101120100_ovd979u4_attempt_bound_auto_approval.sql");
const signature = "public.api_auto_approve_job_requirements(uuid)";
const body = (sql: string, name = signature) => scanFunctionEvents(sql).find((event) => event.signature === name)?.body;

const saveSignature = "public.api_save_drawing_extraction_for_attempt(uuid,uuid,jsonb)";
const attemptReuseSignature = "public.api_reuse_trusted_part_version_artifacts_for_attempt(uuid,uuid,uuid,uuid)";

describe("api_auto_approve_job_requirements U4 migration", () => {
  it("replaces auto approval, adds the attempt-fenced writes, and its generated rollback restores U2 exactly", () => {
    expect(scanFunctionEvents(migrationSql).map((event) => event.signature)).toEqual([signature, saveSignature, attemptReuseSignature]);
    const u2 = read("supabase/migrations/20261031034700_ovd979u2_canonical_requirement_lock_order.sql");
    const rollback = rollbackSql("20261101120100_ovd979u4_attempt_bound_auto_approval.sql");
    expect(body(u2)).toBeTypeOf("string");
    expect(body(rollback)).toBe(body(u2));
    // U2's trusted reuse is not redefined: the archived worker keeps its exact identity.
    expect(scanFunctionEvents(rollback).map((event) => event.signature)).toEqual([saveSignature, attemptReuseSignature, signature]);
    expect(rollback).toContain(`drop function if exists ${saveSignature};`);
    expect(rollback).toContain(`drop function if exists ${attemptReuseSignature};`);
    expect(rollback).toMatch(/^set search_path = pg_catalog, public$/m);
  });

  it("keeps U2's FOR NO KEY UPDATE strength on every prelock (docs/ovd979-lock-order.md)", () => {
    expect(migrationSql).not.toMatch(/\bfor update\b/i);
    expect(body(migrationSql)).toMatch(/order by id for no key update;/);
    expect(body(migrationSql)).toMatch(/for no key update of requirement;/);
    expect(body(migrationSql)).toMatch(/for no key update of extraction;/);
  });

  it.each([saveSignature, attemptReuseSignature])("%s writes first, then fences on the running attempt FOR SHARE", (name) => {
    const fenced = body(migrationSql, name) ?? "";
    const write = Math.max(fenced.indexOf("insert into public.drawing_extractions"), fenced.indexOf("update public.drawing_extractions"));
    const fence = fenced.indexOf("for share of queue;");
    expect(write).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(write);
    expect(fenced).toContain("and queue.status = 'running'");
    expect(fenced).toMatch(/and queue\.attempt_id is not distinct from p_(expected_)?attempt_id\n/);
    // The superseded branch raises inside the inner block, which rolls its writes back.
    expect(fenced).toContain("raise exception using errcode = 'OV979'");
    expect(fenced).toContain("when sqlstate 'OV979' then");
    expect(fenced).toContain("if auth.role() <> 'service_role' then");
    expect(migrationSql).toContain(`revoke all on function ${name.split(",").join(", ")} from public, anon, authenticated;`);
    expect(migrationSql).toContain(`grant execute on function ${name.split(",").join(", ")} to service_role;`);
  });

  it("stamps a reused copy with the caller's attempt only when it is that same copy", () => {
    const reuse = body(migrationSql, attemptReuseSignature) ?? "";
    expect(reuse).toContain("v_result := public.api_reuse_trusted_part_version_artifacts(\n      p_target_part_id, p_source_part_id, p_part_version_id\n    );");
    expect(reuse).toContain("set source_attempt_id = p_expected_attempt_id");
    expect(reuse).toContain("and target.extractor_version = source.extractor_version\n        and target.extraction = source.extraction;");
    expect(reuse).toContain("'attemptSuperseded', true");
    expect(reuse).not.toContain("order by queue.id");
  });

  it("derives the saved row's part and organization from the task, never from the payload", () => {
    const save = body(migrationSql, saveSignature) ?? "";
    expect(save).toContain("part.id, part.organization_id, p_attempt_id, v_row.extractor_version");
    expect(save).toContain("where queue.id = p_task_id\n    and queue.task_type = 'extract_part';");
  });

  it.each(["description", "partNumber", "revision", "finish"])("honors both ownership systems for %s", (field) => {
    expect(migrationSql).toContain(`v_requirement.spec_snapshot #>> '{fieldSources,${field}}'`);
    expect(migrationSql).toContain(`or v_property_overrides ? '${field}'`);
    expect(migrationSql).toContain(`jsonb_build_object('${field}', v_extracted_`);
  });

  it("uses current attempts for pending evidence without a timestamp exemption or ID cache", () => {
    expect(migrationSql).toContain("stored.source_attempt_id = queue.attempt_id");
    expect(migrationSql).toContain("v_extraction.source_attempt_id = queue.attempt_id");
    expect(migrationSql).toContain("queue.attempt_id is not null");
    expect(migrationSql).toContain("queue.status = 'running'");
    expect(migrationSql).not.toContain("locked_at");
    expect(migrationSql).not.toContain("v_finishing");
  });

  it("accepts attempt evidence only from running rows with a non-null attempt_id", () => {
    // Only the worker retry path clears attempt_id, so a queued row may still carry a matching id.
    const gates = [...migrationSql.matchAll(/and not \(\s*queue\.status = 'running'\s*and queue\.attempt_id is not null\s*and /g)];
    // The deploy-order guard runs before the functions and is not an approval gate.
    const functionsSql = migrationSql.slice(migrationSql.indexOf("create or replace function"));
    const matches = [...functionsSql.matchAll(/source_attempt_id = queue\.attempt_id/g)];
    expect(gates).toHaveLength(2);
    expect(matches).toHaveLength(gates.length);
    expect(migrationSql.split("and not (queue.payload ? 'pendingDrawingFileId')")).toHaveLength(gates.length + 1);
  });

  it("refuses to apply before the source_attempt_id worker, and pgTAP runs the guard verbatim", () => {
    const guard = /do \$ovd979u4_worker_guard\$[\s\S]*?\$ovd979u4_worker_guard\$(?=;)/.exec(migrationSql)?.[0] ?? "";
    expect(guard).not.toBe("");
    expect(migrationSql.indexOf(guard)).toBeLessThan(migrationSql.indexOf("create or replace function"));
    expect(guard).toContain("raise exception 'OVD-979 U4 requires the worker that writes drawing_extractions.source_attempt_id'");
    // Positive evidence: any extract_part history without a stamped completion refuses.
    expect(guard).toContain("if v_has_history and (v_last_stamped is null or v_last_unstamped > v_last_stamped) then");
    expect(guard).toContain("extraction.source_attempt_id = queue.attempt_id as stamped");
    expect(read("supabase/tests/ovd979u4_worker_guard.sql")).toContain(`$guard$${guard}$guard$`);
  });

  it("limits every job status update to the four pre-quote statuses", () => {
    const updates = [...migrationSql.matchAll(/update public\.jobs[\s\S]*?;/g)];
    expect(updates).toHaveLength(3);
    for (const [update] of updates) {
      expect(update).toContain("status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote')");
    }
  });
});
