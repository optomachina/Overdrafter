// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260817133902_add_quote_provider_admission_registry.sql",
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

const currentProviders = [
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
  "partsbadger",
  "fastdms",
  "devzmanufacturing",
  "infraredlaboratories",
  "oshcut",
  "fabworks",
  "ponoko",
  "quickparts",
  "rapiddirect",
  "geomiq",
  "weerg",
  "protolabsnetwork",
] as const;

describe("quote provider admission registry migration", () => {
  it("keeps the policy and audit history private, default-off, and inaccessible to clients", () => {
    expect(sql).toContain("create table private.quote_provider_admission_policies");
    expect(sql).toContain("create table private.quote_provider_admission_policy_history");
    expect(sql).toContain("admission_state text not null default 'disabled'");
    expect(sql).toContain("generic_dispatch_enabled boolean not null default false");
    expect(sql).toContain("alter table private.quote_provider_admission_policies enable row level security");
    expect(sql).toContain("alter table private.quote_provider_admission_policies force row level security");
    expect(sql).toContain("alter table private.quote_provider_admission_policy_history enable row level security");
    expect(sql).toContain("alter table private.quote_provider_admission_policy_history force row level security");
    expect(sql).toContain("revoke all on table private.quote_provider_admission_policies from public, anon, authenticated, service_role");
    expect(sql).toContain("revoke all on table private.quote_provider_admission_policy_history from public, anon, authenticated, service_role");
    expect(sql).not.toMatch(/create policy[\s\S]*quote_provider_admission/);
  });

  it("seeds one explicit disabled-or-controlled policy for every current provider", () => {
    for (const provider of currentProviders) {
      expect(sql).toContain(`'${provider}'::public.vendor_name`);
    }

    expect(sql).toContain("'xometry'::public.vendor_name, 'controlled_beta_only', false");
    expect(sql.match(/'disabled', false/g)?.length).toBeGreaterThanOrEqual(
      currentProviders.length - 1,
    );
  });

  it("requires complete reviewed metadata before a policy can be admitted", () => {
    expect(sql).toContain("check (admission_state in ('disabled', 'evidence_required', 'controlled_beta_only', 'approved'))");
    expect(sql).toContain("policy_revision text not null");
    expect(sql).toContain("evidence_reference text");
    expect(sql).toContain("permission_basis text");
    expect(sql).toContain("supported_processes public.process_types[]");
    expect(sql).toContain("accepted_file_extensions text[]");
    expect(sql).toContain("session_owner text");
    expect(sql).toContain("reviewed_by uuid");
    expect(sql).toContain("reviewed_at timestamptz");
    expect(sql).toContain("admission_state not in ('controlled_beta_only', 'approved')");
    expect(sql).toContain("evidence_reference is not null");
    expect(sql).toContain("permission_basis is not null");
    expect(sql).toContain("cardinality(supported_processes) > 0");
    expect(sql).toContain("cardinality(accepted_file_extensions) > 0");
    expect(sql).toContain("session_owner is not null");
    expect(sql).toContain("reviewed_by is not null");
    expect(sql).toContain("reviewed_at is not null");
    expect(sql).toContain("admission_state <> 'approved' or reviewed_by is not null");
  });

  it("provides a service-role-only text resolver that fails closed for unknown or incomplete policies", () => {
    expect(sql).toContain(
      "create or replace function private.resolve_quote_provider_admission_policy(p_provider text)",
    );
    expect(sql).toContain("p_provider is null or pg_catalog.btrim(p_provider) = ''");
    expect(sql).toContain("return query select false, false");
    expect(sql).toContain("where policy.provider::text = pg_catalog.btrim(p_provider)");
    expect(sql).toContain("policy.admission_state in ('controlled_beta_only', 'approved')");
    expect(sql).toContain("and v_complete and not v_expired");
    expect(sql).toContain("policy.generic_dispatch_enabled is true");
    expect(sql).toContain(
      "revoke all on function private.resolve_quote_provider_admission_policy(text) from public, anon, authenticated, service_role",
    );
    expect(sql).toContain(
      "grant execute on function private.resolve_quote_provider_admission_policy(text) to service_role",
    );
    expect(sql).not.toContain("create or replace function public.api_");
  });

  it("does not store secrets or disclosure material and does not alter existing routing or Xometry controls", () => {
    expect(sql).toContain("evidence_reference ~ '^ovd-[1-9][0-9]{0,9}$'");
    expect(sql).toContain("permission_basis in (");
    expect(sql).toContain("admission_state <> 'approved' or permission_basis in (");
    expect(sql).toContain("provider = 'xometry'::public.vendor_name and admission_state = 'controlled_beta_only'");
    expect(sql).not.toContain("customer_managed_account");
    expect(sql).toContain("change_reason in (");
    expect(sql).toContain("constraint quote_provider_history_revision_unique unique (provider, policy_revision)");

    for (const forbiddenToken of [
      "credential",
      "password",
      "secret",
      "api_key",
      "account_id",
      "customer_file",
      "file_path",
      "raw_response",
      "raw_payload",
      "session_state",
      "browser_state",
      "cookie",
    ]) {
      expect(sql).not.toContain(forbiddenToken);
    }

    for (const unrelatedSurface of [
      "org_vendor_configs",
      "project_vendor_preferences",
      "job_vendor_preferences",
      "public.work_queue",
      "quote_request_lanes",
      "xometry_beta_dispatch_permits",
      "api_authorize_xometry_beta_worker_dispatch",
    ]) {
      expect(sql).not.toContain(unrelatedSurface);
    }
  });
});
