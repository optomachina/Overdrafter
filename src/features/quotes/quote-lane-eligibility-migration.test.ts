// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260812044000_enforce_quote_lane_eligibility.sql",
  "utf8",
).toLowerCase().replace(/\s+/g, " ");

describe("quote lane eligibility migration", () => {
  it("derives the four public lane states from immutable scopes", () => {
    expect(sql).toContain("then 'active'");
    expect(sql).toContain("then 'valid_quote'");
    expect(sql).toContain("then 'cooldown'");
    expect(sql).toContain("else 'requestable'");
    expect(sql).toContain("lane.scope_fingerprint = candidate.scope_fingerprint");
  });

  it("requires a trusted selectable unexpired offer", () => {
    expect(sql).toContain("offer.provenance_status in ('trusted_adapter', 'manual_verified')");
    expect(sql).toContain("offer.total_price_usd is not null or offer.unit_price_usd is not null");
    expect(sql).toContain("offer.valid_until >= p_at");
    expect(sql).toContain("offer.invalidated_at is null");
  });

  it("uses an organization-wide configurable same-scope cooldown", () => {
    expect(sql).toContain("same_scope_cooldown_minutes integer not null default 1440");
    expect(sql).toContain("lane.organization_id = candidate.organization_id");
    expect(sql).toContain("lane.vendor = candidate.vendor");
    expect(sql).toContain("lane.cooldown_released_at is null");
  });

  it("serializes submissions and queues only requestable lanes", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("where lane.state = 'requestable'");
    expect(sql).toContain("from pg_temp.requestable_quote_lanes lane");
    expect(sql).not.toContain("if v_job.status in ('internal_review', 'published'");
  });

  it("preserves entitlement and rollout gates while ignoring force retry", () => {
    expect(sql).toContain("private.resolve_organization_entitlements_at");
    expect(sql).toContain("private.automatic_quote_rollout_enabled_with_lock()");
    expect(sql).not.toContain("if p_force_retry");
    expect(sql).toContain("request_scoped_automatic_quote_impl(p_job_id, null)");
  });
});
