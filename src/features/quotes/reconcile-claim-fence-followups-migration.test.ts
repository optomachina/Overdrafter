import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const name = "20261101110559_reconcile_claim_fence_followups";
const originalName = "20261029165751_reconcile_claim_fence";
const read = (path: string) => readFileSync(path, "utf8");
const original = read(`supabase/migrations/${originalName}.sql`);
const forward = read(`supabase/migrations/${name}.sql`);
const rollback = read(`supabase/rollbacks/${name}.rollback.sql`);
const drain = (sql: string) => sql.slice(sql.indexOf("create function public.drain_quote_run_rollup_followups("));
const replaceDrain = (sql: string) => sql.slice(sql.indexOf("create or replace function public.drain_quote_run_rollup_followups("));
const originalDrain = drain(original).replace("create function", "create or replace function");

describe("reconcile claim fence additive follow-up contract", () => {
  it("appends a unique later migration with a reversible upgrade", () => {
    const migrations = readdirSync("supabase/migrations").filter(path => path.endsWith(".sql")).sort();
    expect(migrations.at(-1)).toBe(`${name}.sql`);
    expect(migrations.filter(path => path.startsWith(name.slice(0, 14)))).toEqual([`${name}.sql`]);
    expect(forward).toContain(`supabase/rollbacks/${name}.rollback.sql`);
    expect(forward).toContain("set local lock_timeout = '1s';");
    expect(rollback).toContain("set local lock_timeout = '1s';");
    expect(forward + rollback).not.toMatch(/\b(?:drop\s+(?:table|function\s+public\.drain_quote_run_rollup_followups)|alter\s+function\b.*\bowner)\b/i);
  });

  it("changes only drain discovery locks and their comment, and restores the original body on rollback", () => {
    const expected = originalDrain.replace(
      "  -- Unlocked ID discovery; SKIP LOCKED ownership is taken INSIDE each candidate\n"
      + "  -- so a busy job/run releases the outbox lock too, rather than retaining it.",
      "  -- Skip busy follow-ups/jobs/runs before applying the batch limit. Selection\n"
      + "  -- locks last until transaction end; later contention still defers the candidate.",
    ).replace(
      "    where f.processed_at is null order by f.id limit p_limit\n",
      "    where f.processed_at is null order by f.id limit p_limit\n    for update of f, j, r skip locked\n",
    );
    expect(replaceDrain(forward)).toBe(expected);
    expect(replaceDrain(rollback)).toBe(originalDrain);
  });

  it("pins the run's job without exposing the trigger helper or changing RPC permissions", () => {
    expect(forward).toContain("create function private.reject_quote_run_job_reassignment()\nreturns trigger language plpgsql set search_path = ''");
    expect(forward).toContain("if new.job_id is distinct from old.job_id then\n    raise exception 'Quote run job_id is immutable.';");
    expect(forward).toContain("revoke all on function private.reject_quote_run_job_reassignment()\nfrom public, anon, authenticated, service_role;");
    expect(forward).toContain("create trigger quote_runs_job_id_immutable\nbefore update on public.quote_runs\nfor each row execute function private.reject_quote_run_job_reassignment();");
    expect(rollback).toContain("drop trigger quote_runs_job_id_immutable on public.quote_runs;\ndrop function private.reject_quote_run_job_reassignment();");
    for (const sql of [forward, rollback]) {
      expect(sql).toContain("security definer set search_path = '' set lock_timeout = '1s'");
      expect(sql).toContain("revoke all on function public.drain_quote_run_rollup_followups(integer) from public, anon, authenticated;");
      expect(sql).toContain("grant execute on function public.drain_quote_run_rollup_followups(integer) to service_role;");
    }
  });

  it("registers the exact migration bytes and the required follow-up dependency inventory", () => {
    const hash = createHash("sha256").update(forward).digest("hex");
    const path = `supabase/migrations/${name}.sql`;
    const manifest = JSON.parse(read("scripts/fixtures/free-quote-ci-source.json"));
    expect(manifest.files[path]).toBe(hash);
    expect(manifest.reviewedAppendedMigrations).toContainEqual({ path, issue: "OVD-1073", sha256: hash });
    expect(read("scripts/free-quote-ci-profile.mjs")).toContain(`reviewedMigration('${path}', 'OVD-1073', '${hash}')`);
    const dependencies = JSON.parse(read("supabase/tests/fixtures/reconcile_claim_fence_followups_dependencies.json"));
    expect(dependencies.migration).toBe(name);
    expect(dependencies.functions).toContain("public.drain_quote_run_rollup_followups(integer)");
    expect(dependencies.createdByMigration).toEqual([
      "private.reject_quote_run_job_reassignment()", "quote_runs_job_id_immutable",
    ]);
  });
});
