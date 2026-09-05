// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260905030647_add_provider_admin_notifications.sql",
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("provider-added platform-admin notification migration", () => {
  it("keeps the append-only notification source private", () => {
    expect(sql).toContain("create table private.platform_admin_notifications");
    expect(sql).toContain("alter table private.platform_admin_notifications enable row level security");
    expect(sql).toContain("alter table private.platform_admin_notifications force row level security");
    expect(sql).toContain(
      "revoke all on table private.platform_admin_notifications from public, anon, authenticated, service_role",
    );
    expect(sql).toContain("before update or delete on private.platform_admin_notifications");
    expect(sql).toContain("platform admin notifications are append-only");
  });

  it("records only new disabled provider identities and is replay-safe", () => {
    expect(sql).toContain("after insert on private.quote_provider_admission_policies");
    expect(sql).toContain("new.admission_state <> 'disabled'");
    expect(sql).toContain("new.generic_dispatch_enabled is not false");
    expect(sql).toContain("'provider.integration_added:' || new.provider::text || ':' || new.policy_revision");
    expect(sql).toContain("on conflict (event_key) do nothing");
    expect(sql).not.toMatch(/insert into private\.platform_admin_notifications[\s\S]*select[\s\S]*from private\.quote_provider_admission_policies/);
  });

  it("exposes a bounded newest-first read only to current platform administrators", () => {
    expect(sql).toContain("create or replace function public.api_admin_list_platform_notifications");
    expect(sql).toContain("if not public.is_platform_admin() then");
    expect(sql).toContain("raise exception 'platform admin access required.'");
    expect(sql).toContain(
      "pg_catalog.least(pg_catalog.greatest(pg_catalog.coalesce(p_limit, 20), 1), 100)",
    );
    expect(sql).toContain("order by source_notification.created_at desc, source_notification.event_key desc limit v_limit");
    expect(sql).toContain(
      "revoke all on function public.api_admin_list_platform_notifications(integer) from public, anon, authenticated, service_role",
    );
    expect(sql).toContain(
      "grant execute on function public.api_admin_list_platform_notifications(integer) to authenticated",
    );
  });

  it("stores only minimal provider state and cannot grant production authority", () => {
    expect(sql).toContain("admission_state = 'disabled' and generic_dispatch_enabled is false");
    for (const forbiddenToken of [
      "credential",
      "password",
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

    for (const authoritySurface of [
      "public.work_queue",
      "quote_request_lanes",
      "xometry_beta_dispatch_permits",
      "api_authorize_xometry_beta_worker_dispatch",
    ]) {
      expect(sql).not.toContain(authoritySurface);
    }
  });
});
