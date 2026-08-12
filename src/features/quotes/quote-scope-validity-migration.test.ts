// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260812041000_add_quote_scope_validity_and_lane_eligibility.sql",
  "utf8",
).toLowerCase().replace(/\s+/g, " ");

describe("quote scope validity migration", () => {
  it("stores immutable lanes and never exposes scope fingerprints in the public projection", () => {
    expect(sql).toContain("create table if not exists public.quote_request_lanes");
    expect(sql).toContain("scope_fingerprint text not null");
    const projection = sql.slice(
      sql.indexOf("create or replace function public.api_get_quote_lane_eligibility"),
      sql.indexOf("create or replace function private.request_scoped_automatic_quote_impl"),
    );
    expect(projection).not.toContain("'scopefingerprint'");
  });

  it("keeps validity explicit and makes unknown validity subject to cooldown", () => {
    expect(sql).toContain("same_scope_cooldown_minutes integer not null default 1440");
    expect(sql).toContain("and offer.valid_until is not null");
    expect(sql).toContain("and offer.valid_until >= p_at");
    expect(sql).toContain("offer.provenance_status in ('trusted_adapter', 'manual_verified')");
  });

  it("queues only requestable lanes and ignores the client force-retry flag", () => {
    expect(sql).toContain("where lane.state = 'requestable'");
    expect(sql).toContain("select public.api_request_quote_scoped(p_job_id, null)");
    expect(sql).not.toContain("or coalesce(p_force_retry");
  });

  it("protects invalidation with billing-admin MFA and append-only audit", () => {
    expect(sql).toContain("perform private.require_commercial_admin_mutation('billing_admin')");
    expect(sql).toContain("commercial.quote_offer.invalidate");
    expect(sql).toContain("a reason is required to invalidate a quote offer");
  });
});

