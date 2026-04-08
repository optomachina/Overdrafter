import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260408193000_add_project_and_job_vendor_preferences.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

describe("vendor preference migration", () => {
  it("adds project/job preference persistence and API helpers", () => {
    expect(normalizedSql).toContain("create table if not exists public.project_vendor_preferences");
    expect(normalizedSql).toContain("create table if not exists public.job_vendor_preferences");
    expect(normalizedSql).toContain("create or replace function public.api_get_job_vendor_preferences");
    expect(normalizedSql).toContain("create or replace function public.api_set_project_vendor_preferences");
    expect(normalizedSql).toContain("create or replace function public.api_set_job_vendor_preferences");
    expect(normalizedSql).toContain("check (not (included_vendors && excluded_vendors))");
  });

  it("merges preferences into quote fan-out before api_request_quote queues vendors", () => {
    expect(normalizedSql).toContain(
      "create or replace function public.get_enabled_client_quote_vendors(\n  p_organization_id uuid,\n  p_project_id uuid,\n  p_job_id uuid",
    );
    expect(migrationSql).toContain(
      "public.get_enabled_client_quote_vendors(v_job.organization_id, v_job.project_id, v_job.id)",
    );
  });
});
