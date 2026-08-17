// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260817054500_accept_semantically_equivalent_quote_scopes.sql",
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("semantic quote scope migration", () => {
  it("updates only the registration and worker-preflight contracts", () => {
    expect(sql).toContain(
      "create or replace function public.api_register_quote_request_lane",
    );
    expect(sql).toContain(
      "create or replace function public.api_authorize_xometry_beta_worker_dispatch",
    );
    expect(sql).not.toContain("create or replace function private.quote_scope_fingerprint");
    expect(sql).not.toMatch(/update public\.quote_request_lanes/);
    expect(sql).not.toMatch(/update private\.xometry_beta_dispatch_permits/);
  });

  it("uses semantic JSONB equality while preserving the approved fingerprint", () => {
    expect(sql).toContain(
      "v_existing_lane.scope_snapshot is distinct from p_scope_snapshot",
    );
    expect(sql).toContain("p_scope_snapshot is distinct from v_lane.scope_snapshot");
    expect(sql).toContain(
      "v_current_candidate.scope_snapshot is distinct from p_scope_snapshot",
    );
    expect(sql).toContain(
      "v_scope_fingerprint := private.quote_scope_fingerprint(p_scope_snapshot)",
    );
    expect(sql).toContain(
      "v_current_candidate.scope_fingerprint <> v_permit.scope_fingerprint",
    );
  });

  it("retains the fail-closed authorization and identity gates", () => {
    for (const reasonCode of [
      "dispatch_task_not_running",
      "dispatch_task_identity_mismatch",
      "dispatch_permit_binding_missing",
      "dispatch_permit_identity_mismatch",
      "dispatch_lane_identity_mismatch",
      "dispatch_request_inactive",
      "dispatch_beta_authorization_revoked",
      "dispatch_automatic_access_revoked",
      "dispatch_rollout_disabled",
      "dispatch_provider_configuration_changed",
      "dispatch_staged_scope_changed",
      "dispatch_current_scope_changed",
    ]) {
      expect(sql).toContain(reasonCode);
    }

    expect(sql).toContain(
      "p_scope_snapshot #>> '{part,cad,sha256}' <> v_cad_file.trusted_content_sha256",
    );
    expect(sql).toContain(
      "p_scope_snapshot #>> '{part,drawing,sha256}' <> v_drawing_file.trusted_content_sha256",
    );
  });

  it("keeps both endpoints service-role-only", () => {
    expect(sql).toContain(
      "revoke all on function public.api_register_quote_request_lane(uuid, jsonb) from public, anon, authenticated, service_role",
    );
    expect(sql).toContain(
      "grant execute on function public.api_register_quote_request_lane(uuid, jsonb) to service_role",
    );
    expect(sql).toContain(
      "revoke all on function public.api_authorize_xometry_beta_worker_dispatch( uuid, uuid, jsonb, text, timestamptz ) from public, anon, authenticated, service_role",
    );
    expect(sql).toContain(
      "grant execute on function public.api_authorize_xometry_beta_worker_dispatch( uuid, uuid, jsonb, text, timestamptz ) to service_role",
    );
  });
});
