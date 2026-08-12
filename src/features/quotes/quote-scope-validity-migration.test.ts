// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260812041000_add_quote_scope_validity_and_lane_eligibility.sql",
  "utf8",
).toLowerCase().replace(/\s+/g, " ");

describe("quote scope validity migration", () => {
  it("stores immutable quote-request lanes", () => {
    expect(sql).toContain("create table if not exists public.quote_request_lanes");
    expect(sql).toContain("scope_fingerprint text not null");
    expect(sql).toContain("on conflict (quote_request_id, part_id, vendor, requested_quantity) do nothing");
    expect(sql).toContain("quote lane was already registered with a different immutable scope");
  });

  it("keeps lane fingerprints service-only and registers them at disclosure time", () => {
    expect(sql).toContain("revoke all on public.quote_request_lanes from public, anon, authenticated");
    expect(sql).not.toContain("grant select on public.quote_request_lanes to authenticated");
    expect(sql).toContain("create or replace function public.api_register_quote_request_lane");
    expect(sql).toContain("to service_role");
  });

  it("keeps validity explicit without fabricating historical expiration", () => {
    expect(sql).toContain("create or replace function private.normalize_quote_offer_validity");
    expect(sql).toContain("new.valid_until := null");
    expect(sql).not.toContain("update public.vendor_quote_offers set valid_until");
    expect(sql).toContain("v_raw_duration ~ '^[1-9]\\d*$'");
  });

  it("fingerprints the disclosed requirements and trusted package hashes", () => {
    expect(sql).toContain("p_scope_snapshot ->> 'schema' <> 'quote-lane-scope.v1'");
    expect(sql).toContain("p_scope_snapshot #>> '{part,cad,sha256}' <> v_cad_file.trusted_content_sha256");
    expect(sql).toContain("p_scope_snapshot #>> '{part,drawing,sha256}' <> v_drawing_file.trusted_content_sha256");
    expect(sql).toContain("private.quote_scope_fingerprint(p_scope_snapshot)");
  });

  it("does not make internal security-definer helpers public APIs", () => {
    expect(sql).toContain("revoke all on function private.normalize_quote_offer_validity()");
    expect(sql).toContain("revoke all on function private.quote_scope_fingerprint(jsonb)");
  });
});
