// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/20261010230000_ovd679_member_sourcing_destination.sql";
const sql = readFileSync(migrationPath, "utf8").toLowerCase().replace(/\s+/g, " ");

describe("OVD-679 member sourcing destination migration", () => {
  it("keeps the confirmation RPC contract and history write while admitting members", () => {
    const confirm = sql.slice(
      sql.indexOf("create or replace function public.api_confirm_sourcing_destination("),
      sql.indexOf("revoke all on function public.api_update_organization_addresses"),
    );
    expect(confirm).toContain("returns bigint");
    expect(confirm).toContain("set search_path = pg_catalog");
    expect(confirm.match(/public\.user_can_access_org\(p_organization_id\)/g)).toHaveLength(2);
    expect(confirm).not.toContain("is_org_admin");
    expect(confirm).toContain("insert into private.sourcing_destination_history");
    expect(confirm).toContain("values (p_organization_id, 'confirmed', v_address, auth.uid())");
  });

  it("bounds member address edits to address columns without a broad update policy", () => {
    expect(sql).not.toContain("create policy");
    expect(sql).not.toContain("is_org_member");
    expect(sql).toContain("raise exception 'organization_address_invalid'");
    expect(sql).not.toMatch(/set (name|slug|company_name|logo_url|phone) =/);
    expect(sql).toContain(
      "revoke all on function public.api_update_organization_addresses(uuid, jsonb) from public, anon, service_role",
    );
  });

  it("names a missing confirmed destination before the shared candidate lookup", () => {
    const check = sql.indexOf("raise exception 'xometry_beta_confirmed_sourcing_address_required'");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(sql.indexOf("select candidate.* into v_candidate"));
    expect(sql).toContain(
      "revoke all on function private.resolve_xometry_beta_dispatch_scope_with_access(uuid, text, uuid) from public, anon, authenticated, service_role",
    );
  });

  it("keeps the permit-aware quote access seam from the free confirmed quote migration", () => {
    expect(sql).toContain(
      "create or replace function private.resolve_xometry_beta_dispatch_scope_with_access( p_job_id uuid, p_declared_model_units text, p_existing_permit_id uuid )",
    );
    expect(sql).toContain("private.resolve_quote_access_for_permit(p_job_id, auth.uid(), p_existing_permit_id)");
    expect(sql).not.toContain("require_automatic_quote_access");
    // The two-argument wrapper keeps delegating to the permit-aware seam.
    expect(sql).not.toContain("function private.resolve_xometry_beta_dispatch_scope(");
  });

  it("is the only migration that redefines the member confirmation boundary after OVD-570", () => {
    const later = readdirSync("supabase/migrations")
      .filter((name) => name > "20260926225000_confirm_sourcing_intent.sql")
      .filter((name) =>
        readFileSync(`supabase/migrations/${name}`, "utf8").includes("function public.api_confirm_sourcing_destination("),
      );
    expect(later).toEqual(["20261010230000_ovd679_member_sourcing_destination.sql"]);
  });
});
