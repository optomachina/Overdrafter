// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260815100000_add_xometry_beta_dispatch_permits.sql",
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("Xometry beta dispatch permit migration", () => {
  it("keeps permit evidence private, append-only, and free of raw disclosure payloads", () => {
    expect(sql).toContain("create table private.xometry_beta_dispatch_permits");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("xometry_beta_dispatch_permits_append_only");
    expect(sql).toContain("revoke all on private.xometry_beta_dispatch_permits from public, anon, authenticated, service_role");
    expect(sql).not.toContain("scope_snapshot jsonb");
    expect(sql).not.toContain("raw_payload jsonb");
  });

  it("binds exact Xometry scope, declared units, current notice, and three affirmations", () => {
    expect(sql).toContain("v_effective_vendors <> array['xometry']::public.vendor_name[]");
    expect(sql).toContain("p_expected_scope_fingerprint <> v_scope ->> 'scopefingerprint'");
    expect(sql).toContain("p_policy_revision <> v_scope ->> 'policyrevision'");
    expect(sql).toContain("declared_model_units in ('inch', 'millimeter')");
    expect(sql).toContain("p_authority_to_share is not true");
    expect(sql).toContain("p_non_export_controlled is not true");
    expect(sql).toContain("p_quote_only is not true");
    expect(sql).toContain("v_cad.trusted_content_sha256 is null");
    expect(sql).toContain("v_drawing.trusted_content_sha256 is null");
  });

  it("serializes against enrollment revocation and the existing lane transaction", () => {
    expect(sql).toContain("pg_advisory_xact_lock_shared");
    expect(sql).toContain("'founding-beta:' || v_job.organization_id::text");
    expect(sql).toContain("'quote-lane-submit:' || p_job_id::text");
    expect(sql).toContain("'xometry-beta-approval:'");
    expect(sql).toContain("private.request_scoped_automatic_quote_impl");
    expect(sql).toContain("xometrybetadispatchpermitid");
  });

  it("closes every legacy authenticated automatic-request bypass", () => {
    expect(sql).toContain("create or replace function public.api_request_quote_scoped");
    expect(sql).toContain("create or replace function public.api_request_quote(");
    expect(sql).toContain("create or replace function public.api_request_quotes(");
    expect(sql.match(/dispatch_confirmation_required/g)?.length).toBeGreaterThanOrEqual(1);
    expect(sql.match(/private.xometry_beta_confirmation_required/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain("create or replace function public.api_enqueue_debug_vendor_quote");
    expect(sql).toContain("debug vendor enqueue is unavailable during the controlled founding beta");
  });
});
