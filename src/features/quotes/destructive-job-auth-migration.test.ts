import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260330144838_align_destructive_job_auth_contract.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

describe("destructive job auth migration", () => {
  it("adds a dedicated destructive job authorization helper", () => {
    expect(normalizedSql).toContain("create or replace function public.user_can_destructively_edit_job");
    expect(normalizedSql).toContain("job.created_by = auth.uid()");
    expect(normalizedSql).toContain("membership.role = 'internal_admin'");
    expect(normalizedSql).toContain("public.user_can_edit_project(job.project_id)");
    expect(normalizedSql).toContain("from public.project_jobs project_job");
  });

  it("switches archive, unarchive, and delete rpc authorization to the destructive helper", () => {
    expect(normalizedSql).toContain("if not public.user_can_destructively_edit_job(v_job.id) then");
    expect(normalizedSql).toContain("create or replace function public.api_archive_job");
    expect(normalizedSql).toContain("create or replace function public.api_unarchive_job");
    expect(normalizedSql).toContain("create or replace function public.api_delete_archived_jobs");
    expect(normalizedSql).toContain("public.user_can_destructively_edit_job(job.id)");
  });
});
