// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rawSql = readFileSync(
  "supabase/migrations/20261003160000_ovd458_generic_provider_dispatch_permits.sql",
  "utf8",
);
const sql = rawSql.toLowerCase().replace(/\s+/g, " ");
const pgTap = readFileSync("supabase/tests/provider_dispatch_permits.sql", "utf8");
const fixture = JSON.parse(
  readFileSync("test-fixtures/provider-dispatch-envelope/v1.json", "utf8"),
) as { golden: { canonical: string; fingerprint: string } };

function functionBodies(source: string): string[] {
  return source.match(/create or replace function [\s\S]*?\n\$\$;/g) ?? [];
}

describe("OVD-458 generic provider dispatch permit migration", () => {
  it("keeps permit, revocation, and review evidence private, forced-RLS, and append-only", () => {
    for (const table of [
      "private.provider_dispatch_permits",
      "private.provider_dispatch_permit_revocations",
      "private.provider_dispatch_envelope_reviews",
    ]) {
      expect(sql).toContain(`create table ${table} (`);
      expect(sql).toContain(`alter table ${table} force row level security`);
      expect(sql).toContain(`revoke all on ${table} from public, anon, authenticated, service_role`);
    }
    expect(sql).toContain("provider_dispatch_permits_append_only before update or delete");
    expect(sql).toContain("provider_dispatch_permit_revocations_append_only before update or delete");
    expect(sql).toContain("reviewed provider dispatch envelopes can only be withdrawn");
  });

  it("self-verifies the stored canonical envelope and fingerprint", () => {
    expect(sql).toContain("check ( canonical_envelope = private.build_provider_dispatch_envelope(");
    expect(sql).toContain("expires_at )::text )");
    expect(sql).toContain("check (canonical_envelope = envelope::text)");
    expect(sql).toContain(
      "envelope_fingerprint = pg_catalog.encode( pg_catalog.sha256(pg_catalog.convert_to(canonical_envelope, 'utf8')), 'hex' )",
    );
    expect(sql).toContain("check (session_binding_id = 'lease:' || id::text)");
    expect(sql).toContain("check (provider <> 'xometry'::public.vendor_name)");
  });

  it("builds source and outbound files in canonical cad-then-drawing order", () => {
    expect(sql).toContain("(1, 'cad', p_cad_file_id, p_cad_sha256), (2, 'drawing', p_drawing_file_id, p_drawing_sha256)");
    expect(sql.match(/order by file\.ordinal/g)?.length).toBe(2);
    expect(sql).toContain("'derivation', 'identity'");
  });

  it("pins search_path and revokes default execute on every function", () => {
    const bodies = functionBodies(rawSql);
    expect(bodies.length).toBe(8);
    for (const body of bodies) {
      expect(body).toContain("set search_path = pg_catalog");
      const name = /create or replace function ([a-z_.]+)\(/.exec(body)?.[1];
      expect(name).toBeTruthy();
      expect(sql).toContain(`revoke all on function ${name}(`);
    }
    expect(sql).toContain(
      "grant execute on function public.api_get_provider_dispatch_scope(uuid, public.vendor_name, text) to authenticated",
    );
    expect(sql).toContain("grant execute on function private.revoke_provider_dispatch_permit(uuid, text) to service_role");
    expect(sql).not.toMatch(/grant execute on function [^;]* to (public|anon)\b/);
    expect(sql).not.toMatch(/grant [^;]* on private\.provider_dispatch/);
  });

  it("keeps Xometry on the unchanged specialized transaction", () => {
    expect(sql).toContain("return public.api_request_xometry_beta_dispatch(");
    expect(sql).toContain("return private.resolve_xometry_beta_dispatch_scope(p_job_id, p_declared_model_units)");
    expect(sql).not.toContain("create or replace function public.api_request_xometry_beta_dispatch");
    expect(sql).not.toContain("create or replace function private.resolve_xometry_beta_dispatch_scope");
    expect(sql).not.toContain("alter table private.xometry_beta_dispatch_permits");
    expect(sql).toContain(
      "create trigger xometry_beta_dispatch_permits_cross_path_approval before insert on private.xometry_beta_dispatch_permits",
    );
  });

  it("requires generic admission and a reviewed envelope and seeds neither", () => {
    expect(sql).toContain("v_admission.generically_dispatchable is not true");
    expect(sql).toContain("provider_dispatch_provider_envelope_unknown");
    expect(sql).not.toMatch(/insert into private\.provider_dispatch_envelope_reviews/);
    expect(sql).not.toMatch(/update private\.quote_provider_admission_policies/);
    expect(sql).toContain("v_access ->> 'source' is distinct from 'commercial_entitlement'");
  });

  it("serializes approval references with the legacy Xometry lock key", () => {
    expect(sql).toContain("'quote-lane-submit:' || p_job_id::text");
    expect(sql).toContain("'xometry-beta-approval:' || v_job.organization_id::text || ':' || p_approval_reference::text");
    expect(sql).toContain("provider_dispatch_approval_reference_reused");
  });

  it("proves SQL canonical parity against the shared OVD-457 golden", () => {
    expect(pgTap).toContain(`'${fixture.golden.canonical}'`);
    expect(pgTap).toContain(`'${fixture.golden.fingerprint}'`);
  });
});
