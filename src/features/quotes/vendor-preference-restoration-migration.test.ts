import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260812003732_restore_job_vendor_preferences.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

describe("vendor preference restoration migration", () => {
  it("restores RLS-protected project and job preference storage", () => {
    expect(normalizedSql).toContain(
      "create table if not exists public.project_vendor_preferences",
    );
    expect(normalizedSql).toContain(
      "create table if not exists public.job_vendor_preferences",
    );
    expect(normalizedSql).toContain(
      "alter table public.project_vendor_preferences enable row level security",
    );
    expect(normalizedSql).toContain(
      "alter table public.job_vendor_preferences enable row level security",
    );
    expect(normalizedSql).toContain(
      "using (public.user_can_access_project(project_id))",
    );
    expect(normalizedSql).toContain(
      "using (public.user_can_access_job(job_id))",
    );
  });

  it("restores the authenticated vendor preference API", () => {
    expect(normalizedSql).toContain(
      "create or replace function public.api_get_job_vendor_preferences",
    );
    expect(normalizedSql).toContain(
      "create or replace function public.api_set_project_vendor_preferences",
    );
    expect(normalizedSql).toContain(
      "create or replace function public.api_set_job_vendor_preferences",
    );
    expect(normalizedSql).toContain("perform public.require_verified_auth()");
    expect(normalizedSql).toContain("public.user_can_edit_project(v_project.id)");
    expect(normalizedSql).toContain("public.user_can_edit_job(v_job.id)");
  });

  it("preserves current entitlement gates while applying vendor scope to fan-out", () => {
    expect(normalizedSql).not.toContain(
      "create or replace function public.api_request_quote",
    );
    expect(normalizedSql).toContain(
      "private.request_automatic_quote_impl(uuid, boolean)",
    );
    expect(migrationSql).toContain(
      "public.get_enabled_client_quote_vendors(v_job.organization_id, v_job.project_id, v_job.id)",
    );
    expect(normalizedSql).toContain(
      "does not delegate to the guarded automatic implementation",
    );
  });

  it("keeps privileged functions on an immutable search path", () => {
    expect(normalizedSql).not.toContain("set search_path = public");
    expect(normalizedSql.match(/set search_path = pg_catalog/g)?.length).toBeGreaterThanOrEqual(6);
  });
});
