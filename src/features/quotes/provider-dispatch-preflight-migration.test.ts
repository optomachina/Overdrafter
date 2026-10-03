// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rawSql = readFileSync(
  "supabase/migrations/20261003170000_ovd459_provider_dispatch_preflight.sql",
  "utf8",
);
const sql = rawSql.toLowerCase().replace(/\s+/g, " ");
const code = rawSql.replace(/--.*$/gm, "").toLowerCase().replace(/\s+/g, " ");
const preflightBody = /create or replace function public\.api_authorize_provider_worker_dispatch\([\s\S]*?\n\$\$;/.exec(rawSql)?.[0] ?? "";
const pgTap = readFileSync("supabase/tests/provider_dispatch_preflight.sql", "utf8");
const raceTap = readFileSync("supabase/tests/provider_dispatch_preflight_concurrency.sql", "utf8");

function functionBodies(source: string): string[] {
  return source.match(/create or replace function [\s\S]*?\n\$\$;/g) ?? [];
}

describe("OVD-459 provider dispatch preflight migration", () => {
  it("defines exactly two pinned functions and grants execute to service_role only", () => {
    const bodies = functionBodies(rawSql);
    expect(bodies.length).toBe(2);
    for (const body of bodies) {
      expect(body).toContain("set search_path = pg_catalog");
      const name = /create or replace function ([a-z_.]+)\(/.exec(body)?.[1];
      expect(name).toBeTruthy();
      expect(sql).toContain(`revoke all on function ${name}(`);
    }
    expect(sql).toContain(
      "revoke all on function public.api_authorize_provider_worker_dispatch( uuid, uuid, jsonb, text, timestamptz ) from public, anon, authenticated, service_role",
    );
    expect(sql).toContain(
      "grant execute on function public.api_authorize_provider_worker_dispatch( uuid, uuid, jsonb, text, timestamptz ) to service_role",
    );
    expect(sql.match(/grant /g)?.length).toBe(1);
    expect(preflightBody).toContain("security definer");
  });

  it("returns the unchanged Xometry decision for Xometry scopes and redefines nothing legacy", () => {
    expect(preflightBody).toMatch(
      /if p_scope_snapshot ->> 'vendor' = 'xometry' then\s+return public\.api_authorize_xometry_beta_worker_dispatch\(\s+p_work_queue_task_id,\s+p_vendor_quote_result_id,\s+p_scope_snapshot,\s+p_expected_worker_name,\s+p_expected_claimed_at\s+\);/,
    );
    expect(sql).not.toContain("create or replace function public.api_authorize_xometry_beta_worker_dispatch");
    expect(sql).not.toContain("create or replace function private.revoke_provider_dispatch_permit");
    expect(sql).not.toContain("create or replace function private.resolve_provider_dispatch_permit_state");
  });

  it("is read-only and changes no table, grant on a table, or provider enablement", () => {
    expect(code).not.toMatch(/\b(insert into|delete from|alter table|create table|drop )/);
    expect(code).not.toMatch(/\bupdate (public|private)\./);
    expect(code).not.toMatch(/grant [^;]* on (table )?(public|private)\.[a-z_]+ /);
  });

  it("locks the task and permit rows so revocation serializes with the preflight", () => {
    expect(preflightBody).toMatch(/from public\.work_queue task_row\s+where task_row\.id = p_work_queue_task_id\s+for update;/);
    expect(preflightBody).toMatch(
      /from private\.provider_dispatch_permits permit_row\s+where permit_row\.id = v_permit_id_text::uuid\s+for update;/,
    );
    expect(preflightBody).not.toContain("for no key update");
    expect(preflightBody).toContain("private.resolve_provider_dispatch_permit_state(v_permit.id)");
    expect(preflightBody).toContain("pg_catalog.clock_timestamp()");
  });

  it("covers every denial and the revocation race in pgTAP", () => {
    for (const denial of new Set([...rawSql.matchAll(/provider_dispatch_authorization_denial\('([a-z_]+)'\)/g)].map((m) => m[1]))) {
      expect(pgTap).toContain(`pg_temp.denied('${denial}')`);
    }
    expect(raceTap).toContain("wait_event_type = 'Lock'");
    expect(raceTap).toContain("pg_advisory_lock(");
    expect(raceTap).toContain("'permit_revoked'");
  });
});
