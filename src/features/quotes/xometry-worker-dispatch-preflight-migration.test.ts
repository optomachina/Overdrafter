// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260815184740_add_xometry_worker_dispatch_preflight.sql",
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("Xometry worker dispatch preflight migration", () => {
  it("exposes the decision only to the service role", () => {
    expect(sql).toContain(
      "revoke all on function public.api_authorize_xometry_beta_worker_dispatch( uuid, uuid, jsonb, text, timestamptz ) from public, anon, authenticated, service_role",
    );
    expect(sql).toContain(
      "grant execute on function public.api_authorize_xometry_beta_worker_dispatch( uuid, uuid, jsonb, text, timestamptz ) to service_role",
    );
  });

  it("revalidates the immutable permit and exact task, result, lane, and staged scope", () => {
    expect(sql).toContain("private.xometry_beta_dispatch_permits");
    expect(sql).toContain("dispatch_permit_binding_missing");
    expect(sql).toContain("v_task.locked_by is distinct from p_expected_worker_name");
    expect(sql).toContain("v_task.locked_at is distinct from p_expected_claimed_at");
    expect(sql).toContain("dispatch_permit_identity_mismatch");
    expect(sql).toContain("dispatch_lane_identity_mismatch");
    expect(sql).toContain("private.quote_scope_fingerprint(p_scope_snapshot)");
    expect(sql).toContain("dispatch_staged_scope_changed");
    expect(sql).toContain("private.quote_lane_candidates");
    expect(sql).toContain("dispatch_current_scope_changed");
  });

  it("rechecks current beta, entitlement, rollout, and exact Xometry provider access", () => {
    expect(sql).toContain("private.resolve_founding_beta_access_state");
    expect(sql).toContain("dispatch_beta_authorization_revoked");
    expect(sql).toContain("private.resolve_organization_entitlements_at");
    expect(sql).toContain("dispatch_automatic_access_revoked");
    expect(sql).toContain("private.automatic_quote_rollout_enabled_with_lock()");
    expect(sql).toContain("dispatch_rollout_disabled");
    expect(sql).toContain("public.get_enabled_client_quote_vendors");
    expect(sql).toContain("array[v_provider]::public.vendor_name[]");
    expect(sql).toContain("dispatch_provider_configuration_changed");
  });

  it("returns only bounded authorization evidence", () => {
    expect(sql).toContain("'nonexportcontrolled', true");
    expect(sql).not.toContain("'scopesnapshot'");
    expect(sql).not.toContain("'filename'");
    expect(sql).not.toContain("'credentials'");
    expect(sql).not.toContain("'browserstate'");
  });
});
