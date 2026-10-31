import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanFunctionEvents } from "../../../scripts/check-migration-function-collisions.mjs";
import { rollbackSql } from "../../../scripts/ovd979-rollback.mjs";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const migrationSql = read("supabase/migrations/20261031034800_ovd979u4_attempt_bound_auto_approval.sql");
const signature = "public.api_auto_approve_job_requirements(uuid)";
const reuseSignature = "public.api_reuse_trusted_part_version_artifacts(uuid,uuid,uuid)";
const body = (sql: string, name = signature) => scanFunctionEvents(sql).find((event) => event.signature === name)?.body;

describe("api_auto_approve_job_requirements U4 migration", () => {
  it("replaces auto approval and trusted reuse, and its generated rollback restores the U2-era bodies byte for byte", () => {
    expect(scanFunctionEvents(migrationSql).map((event) => event.signature)).toEqual([signature, reuseSignature]);
    const u2 = read("supabase/migrations/20261030162500_ovd979u2_canonical_requirement_lock_order.sql");
    const rollback = rollbackSql("20261031034800_ovd979u4_attempt_bound_auto_approval.sql");
    for (const name of [signature, reuseSignature]) {
      expect(body(u2, name)).toBeTypeOf("string");
      expect(body(rollback, name)).toBe(body(u2, name));
    }
    expect(rollback).toMatch(/^set search_path = pg_catalog, public$/m);
  });

  it("keeps U2's FOR NO KEY UPDATE strength on every prelock (docs/ovd979-lock-order.md)", () => {
    expect(migrationSql).not.toMatch(/\bfor update\b/i);
    expect(body(migrationSql)).toMatch(/order by id for no key update;/);
    expect(body(migrationSql)).toMatch(/for no key update of requirement;/);
    expect(body(migrationSql)).toMatch(/for no key update of extraction;/);
  });

  it("stamps reused extractions with the target's running attempt and otherwise keeps U2's reuse body", () => {
    const reuse = body(migrationSql, reuseSignature) ?? "";
    expect(reuse).toContain("and queue.status = 'running'\n    and queue.attempt_id is not null");
    expect(reuse).toContain("v_target.id, extraction.organization_id, v_target_attempt_id,");
    const u2Reuse = body(read("supabase/migrations/20261030162500_ovd979u2_canonical_requirement_lock_order.sql"), reuseSignature) ?? "";
    const stampFree = reuse
      .replace(/\n {2}v_target_attempt_id uuid;/, "")
      .replace(/ {2}-- The copy is this attempt's result[\s\S]*?limit 1;\n\n/, "")
      .replace("part_id, organization_id, source_attempt_id, extractor_version", "part_id, organization_id, extractor_version")
      .replace("extraction.organization_id, v_target_attempt_id, extraction.extractor_version", "extraction.organization_id, extraction.extractor_version");
    expect(stampFree).toBe(u2Reuse);
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
    const matches = [...migrationSql.matchAll(/source_attempt_id = queue\.attempt_id/g)];
    expect(gates).toHaveLength(2);
    expect(matches).toHaveLength(gates.length);
    expect(migrationSql.split("and not (queue.payload ? 'pendingDrawingFileId')")).toHaveLength(gates.length + 1);
  });

  it("limits every job status update to the four pre-quote statuses", () => {
    const updates = [...migrationSql.matchAll(/update public\.jobs[\s\S]*?;/g)];
    expect(updates).toHaveLength(3);
    for (const [update] of updates) {
      expect(update).toContain("status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote')");
    }
  });
});
