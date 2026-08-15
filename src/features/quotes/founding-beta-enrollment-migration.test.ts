// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260815090000_add_founding_beta_enrollment.sql",
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("Founding Beta enrollment migration", () => {
  it("keeps enrollment and policy acceptance as append-only private evidence", () => {
    expect(sql).toContain("create table private.founding_beta_enrollment_events");
    expect(sql).toContain("create table private.founding_beta_notice_acceptances");
    expect(sql).toContain("founding_beta_enrollment_events_append_only");
    expect(sql).toContain("founding_beta_notice_acceptances_append_only");
    expect(sql).toContain("raise exception 'founding beta evidence is append-only.'");
    expect(sql).toContain("unique (actor_user_id, idempotency_key)");
    expect(sql).toContain("unique (organization_id, user_id, policy_revision)");
  });

  it("exposes the four member-safe states against one canonical notice", () => {
    expect(sql).toContain("'policyrevision', 'founding-beta-2026-08-15'");
    expect(sql).toContain("'termspath', '/legal/beta-terms'");
    expect(sql).toContain("'privacypath', '/legal/privacy'");
    expect(sql).toContain("v_state := 'not_enrolled'");
    expect(sql).toContain("v_state := 'revoked'");
    expect(sql).toContain("v_state := 'notice_required'");
    expect(sql).toContain("v_state := 'eligible'");
  });

  it("requires explicit platform-admin MFA for enrollment mutations", () => {
    expect(sql).toContain("if not public.is_platform_admin() then");
    expect(sql).toContain("if not public.current_user_has_aal2() then");
    expect(sql).toContain("if p_enrolled is null then");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("idempotency key has already been used");
  });

  it("gates both the job RPC and direct inserts without changing read policies", () => {
    expect(sql).toContain("if not public.current_user_has_current_founding_beta_access(p_organization_id) then");
    expect(sql).toContain("create policy \"jobs_insert_members\"");
    expect(sql).toContain("public.current_user_has_current_founding_beta_access(organization_id)");
    expect(sql).not.toContain("drop policy if exists \"jobs_select_members\"");
  });

  it("removes historical creation overloads and preserves only authenticated execution", () => {
    expect(sql).toContain("drop function if exists public.api_create_job(uuid, text, text, text)");
    expect(sql).toContain("drop function if exists public.api_create_client_draft(text, text, uuid, text[])");
    expect(sql).toContain("revoke all on function public.api_create_job(");
    expect(sql).toContain("grant execute on function public.api_create_job(");
    expect(sql).toContain("revoke all on function public.api_create_client_draft(");
  });
});
