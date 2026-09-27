// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260911031500_add_capability_observation_ledger.sql",
  "utf8",
).toLowerCase().replace(/\s+/g, " ");

const prohibitedStorageTokens = [
  "credential",
  "password",
  "secret",
  "api_key",
  "account_id",
  "customer_id",
  "organization_id",
  "user_id",
  "filename",
  "file_path",
  "browser_state",
  "session_state",
  "raw_payload",
  "raw_response",
  "fingerprint",
] as const;

describe("capability observation ledger migration", () => {
  it("creates only a private append-only ledger with fixed ownership and indefinite retention", () => {
    expect(sql).toContain("create table private.capability_observations");
    expect(sql).toContain("alter table private.capability_observations owner to postgres");
    expect(sql).toContain("alter sequence private.capability_observations_id_seq owner to postgres");
    expect(sql).toContain("before update or delete on private.capability_observations");
    expect(sql).toContain("before truncate on private.capability_observations");
    expect(sql).toContain("capability observations are append-only");
    expect(sql).toContain("do not drop, truncate, update, or delete retained observations");
    expect(sql).not.toMatch(/create (?:or replace )?(?:table|function) public\.[a-z0-9_]*capability_observation/);
  });

  it("stores the bounded observation and provenance contract without prohibited raw identity material", () => {
    for (const field of [
      "provider public.vendor_name",
      "capability text not null",
      "route text not null",
      "surface text not null",
      "surface_revision text not null",
      "contract_version text not null",
      "observation_state text not null",
      "observed_at timestamptz not null",
      "expires_at timestamptz not null",
      "actor_kind text not null",
      "source_kind text not null",
      "source_version text not null",
      "evidence_reference text not null",
      "idempotency_key text not null",
      "observation_revision bigint not null",
    ]) {
      expect(sql).toContain(field);
    }

    expect(sql).toContain("capability = 'provider_upload'");
    expect(sql).toContain("contract_version = 'provider-upload-capability.v1'");
    expect(sql).not.toContain("'missing',");
    expect(sql).not.toContain("'stale',");
    expect(sql).toContain("observation_state <> 'fresh'");
    expect(sql).toContain("cardinality(observed_extensions) = 0");
    expect(sql).toContain("evidence_reference ~ '^issue:ovd-[1-9][0-9]{0,9}$'");

    const tableDefinition = sql.slice(
      sql.indexOf("create table private.capability_observations"),
      sql.indexOf("alter table private.capability_observations owner to postgres"),
    );
    for (const token of prohibitedStorageTokens) {
      expect(tableDefinition).not.toContain(token);
    }
  });

  it("enforces TTL, skew, server time, uniqueness, and current-scope indexing", () => {
    expect(sql).toContain("expires_at <= observed_at + interval '26 hours'");
    expect(sql).toContain("observed_at <= inserted_at + interval '5 minutes'");
    expect(sql).toContain("new.inserted_at := pg_catalog.statement_timestamp()");
    expect(sql).toContain("unique (idempotency_key)");
    expect(sql).toContain("constraint capability_observations_scope_revision_unique unique");
    expect(sql).toContain("create index capability_observations_current_scope_idx");
    expect(sql).toContain("observed_at desc, observation_revision desc, id desc");
  });

  it("normalizes before deterministic replay locks and rejects every non-identical replay", () => {
    expect(sql).toContain("create or replace function private.record_capability_observation");
    expect(sql).toContain("select distinct pg_catalog.regexp_replace");
    expect(sql).toContain("array_agg(normalized_extension order by normalized_extension)");
    expect(sql).toContain("array_agg(normalized_mime_type order by normalized_mime_type)");
    expect(sql).toContain("least(v_idempotency_lock, v_revision_lock)");
    expect(sql).toContain("greatest(v_idempotency_lock, v_revision_lock)");
    expect(sql).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(sql).toContain("if v_existing_count = 1 and v_exact_id is not null then return v_exact_id");
    expect(sql).toContain("message = 'capability observation replay conflict.'");
    expect(sql).toContain("errcode = '23505'");
  });

  it("denies direct table, sequence, and append-function access to every application role", () => {
    expect(sql).toContain("alter table private.capability_observations enable row level security");
    expect(sql).toContain("alter table private.capability_observations force row level security");
    expect(sql).toContain("revoke all on table private.capability_observations from public, anon, authenticated, service_role");
    expect(sql).toContain("revoke all on sequence private.capability_observations_id_seq from public, anon, authenticated, service_role");
    expect(sql).toMatch(/revoke all on function private\.record_capability_observation\([\s\S]*?\) from public, anon, authenticated, service_role/);
    expect(sql).not.toContain("grant execute on function private.record_capability_observation");
    expect(sql).not.toContain("grant select on private.capability_observations");
    expect(sql).not.toMatch(/create policy[\s\S]*capability_observations/);
  });

  it("does not couple the ledger to provider calls, routing, clients, or production controls", () => {
    for (const unrelatedSurface of [
      "public.work_queue",
      "quote_request_lanes",
      "xometry_beta_dispatch_permits",
      "api_authorize_xometry_beta_worker_dispatch",
      "org_vendor_configs",
      "project_vendor_preferences",
      "job_vendor_preferences",
    ]) {
      expect(sql).not.toContain(unrelatedSurface);
    }
  });
});
