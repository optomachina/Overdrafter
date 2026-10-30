import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanFunctionEvents } from "../../../scripts/check-migration-function-collisions.mjs";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const migrationSql = read("supabase/migrations/20261030165700_ovd979u4_attempt_bound_auto_approval.sql");
const signature = "public.api_auto_approve_job_requirements(uuid)";
const body = (sql: string) => scanFunctionEvents(sql).find((event) => event.signature === signature)?.body;

describe("api_auto_approve_job_requirements U4 migration", () => {
  it("ships the reviewed draft and restores the U2/U3-era body byte for byte", () => {
    expect(migrationSql).toBe(read("docs/migration-drafts/ovd-979u4.sql"));
    expect(scanFunctionEvents(migrationSql).map((event) => event.signature)).toEqual([signature]);
    const prior = body(read("supabase/migrations/20261030162500_ovd979u2_canonical_requirement_lock_order.sql"));
    expect(prior).toBeTypeOf("string");
    expect(body(read("docs/migration-drafts/ovd-979u4.rollback.sql"))).toBe(prior);
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

  it("limits every job status update to the four pre-quote statuses", () => {
    const updates = [...migrationSql.matchAll(/update public\.jobs[\s\S]*?;/g)];
    expect(updates).toHaveLength(3);
    for (const [update] of updates) {
      expect(update).toContain("status in ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote')");
    }
  });
});
