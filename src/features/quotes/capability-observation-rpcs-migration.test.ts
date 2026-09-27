// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260927065514_ovd513_capability_record_resolver_rpcs.sql",
  "utf8",
).toLowerCase().replace(/\s+/g, " ");

describe("capability observation service RPC migration", () => {
  it("adds exactly two public entry points with atomic revoke-then-grant ordering", () => {
    expect(sql).toMatch(/^--[\s\S]* begin; create function public\.api_record_capability_observation\(/);
    expect(sql).toMatch(/commit;\s*$/);
    expect([...sql.matchAll(/create function public\./g)]).toHaveLength(2);
    for (const name of [
      "api_record_capability_observation",
      "api_resolve_current_capability_observation",
    ]) {
      const revoke = sql.indexOf(`revoke all on function public.${name}`);
      const grant = sql.indexOf(`grant execute on function public.${name}`);
      expect(revoke).toBeGreaterThan(0);
      expect(grant).toBeGreaterThan(revoke);
      expect(sql.slice(revoke, grant)).toContain("from public, anon, authenticated, service_role");
      expect(sql.slice(grant)).toContain("to service_role");
      expect(sql).toContain(`alter function public.${name}`);
    }
  });

  it("keeps the private ledger inaccessible while using its canonical append path", () => {
    expect(sql).toContain("perform private.record_capability_observation(");
    expect(sql).toContain("return p_observation_revision");
    expect(sql).not.toMatch(/grant (?:all|select|insert|update|delete|usage) on (?:table |sequence )?private\./);
    expect(sql).not.toContain("grant execute on function private.record_capability_observation");
    expect(sql).not.toMatch(/\b(update|delete|truncate)\s+private\.capability_observations/);
    expect(sql).toContain("never delete rows");
  });

  it("fails closed on all tied-newest semantic disagreements before expiry", () => {
    const tie = sql.indexOf("select exists ( select 1 from private.capability_observations tied");
    const expiry = sql.indexOf("elsif v_latest.expires_at <= v_now then");
    expect(tie).toBeGreaterThan(0);
    expect(expiry).toBeGreaterThan(tie);
    for (const field of [
      "contract_version", "observation_state", "observed_extensions",
      "observed_mime_types", "accept_attribute_present", "expires_at",
    ]) {
      expect(sql.slice(tie, expiry)).toContain(`tied.${field} is distinct from v_latest.${field}`);
    }
    expect(sql).toContain("v_latest.observed_at > v_now");
  });

  it("returns only bounded primitive fields and hides private identifiers", () => {
    const declaration = sql.slice(
      sql.indexOf("returns table ("),
      sql.indexOf(") language plpgsql stable security definer"),
    );
    for (const token of [
      "idempotency_key", "actor_kind", "source_kind", "source_version",
      "evidence_reference", "fingerprint", "filename", "url", "email", "id bigint",
    ]) {
      expect(declaration).not.toContain(token);
    }
    expect(declaration).toContain("observation_revision bigint");
    expect(sql).toContain("v_revision := v_latest.observation_revision");
  });
});
