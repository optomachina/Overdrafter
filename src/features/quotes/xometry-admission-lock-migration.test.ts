// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/20261004100000_ovd598_serialize_legacy_xometry_admission.sql";
const baselinePath = "supabase/migrations/20261002182910_free_confirmed_quote_access.sql";
const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const baselineSql = readFileSync(baselinePath, "utf8");
const sql = rawSql.toLowerCase().replace(/\s+/g, " ");
const code = rawSql.replace(/--.*$/gm, "").toLowerCase().replace(/\s+/g, " ");
const raceTap = readFileSync("supabase/tests/xometry_beta_dispatch_admission_serialization.sql", "utf8");

const helperLine = "  perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);";
const requestFunction =
  /create or replace function public\.api_request_xometry_beta_dispatch\([\s\S]*?\n\$\$;\n\nrevoke all on function public\.api_request_xometry_beta_dispatch\([\s\S]*?\) from public, anon, authenticated, service_role;\ngrant execute on function public\.api_request_xometry_beta_dispatch\([\s\S]*?\) to authenticated;\n/;
const helperBody =
  /create or replace function private\.lock_xometry_beta_dispatch_scope_rows\(p_job_id uuid\)[\s\S]*?\n\$\$;/.exec(rawSql)?.[0] ?? "";

function extractRequest(source: string): string {
  return requestFunction.exec(source)?.[0] ?? "";
}

describe("OVD-598 legacy Xometry admission row locks", () => {
  it("defines the helper as a pinned security definer returning void", () => {
    expect(rawSql).not.toBe("");
    expect(helperBody).toContain("security definer");
    expect(helperBody).toContain("set search_path = pg_catalog");
    expect(helperBody).toContain("returns void");
  });

  it("takes FOR SHARE on the job, parts, approved requirements, then CAD/drawing files", () => {
    const job = helperBody.search(/perform 1 from public\.jobs job_row where job_row\.id = p_job_id for share;/);
    const parts = helperBody.search(
      /perform 1 from public\.parts part where part\.job_id = p_job_id order by part\.id for share;/,
    );
    const requirements = helperBody.search(
      /from public\.approved_part_requirements requirement\s+where requirement\.part_id in \(select part\.id from public\.parts part where part\.job_id = p_job_id\)\s+order by requirement\.part_id\s+for share;/,
    );
    const files = helperBody.search(
      /from public\.job_files file_row\s+where file_row\.id in \(\s+select part\.cad_file_id from public\.parts part where part\.job_id = p_job_id\s+union\s+select part\.drawing_file_id from public\.parts part where part\.job_id = p_job_id\s+\)\s+order by file_row\.id\s+for share;/,
    );
    expect(job).toBeGreaterThan(0);
    expect(parts).toBeGreaterThan(job);
    expect(requirements).toBeGreaterThan(parts);
    expect(files).toBeGreaterThan(requirements);
    expect(helperBody.match(/for share;/g)?.length).toBe(4);
    expect(helperBody).not.toMatch(/for (no key )?update|for key share/);
  });

  it("restates the request byte-for-byte with one helper line after the approval lock", () => {
    const baseline = extractRequest(baselineSql);
    const candidate = extractRequest(rawSql);
    expect(baseline).not.toBe("");
    expect(candidate).not.toBe("");
    const anchor = "\n\n  select permit.* into v_existing";
    expect(baseline.split(anchor)).toHaveLength(2);
    expect(baseline.slice(0, baseline.indexOf(anchor))).toMatch(/'xometry-beta-approval:'[\s\S]*?\n {2}\);$/);
    const expected = baseline.replace(anchor, `\n${helperLine}${anchor}`);
    expect(candidate).toBe(expected);
    expect(candidate.split(helperLine)).toHaveLength(2);
    expect(candidate.replace(`${helperLine}\n`, "")).toBe(baseline);
  });

  it("revokes the helper from every API role and grants it to none", () => {
    expect(sql).toContain(
      "revoke all on function private.lock_xometry_beta_dispatch_scope_rows(uuid) from public, anon, authenticated, service_role;",
    );
    expect(code).not.toMatch(/grant [^;]*lock_xometry_beta_dispatch_scope_rows/);
    expect(code.match(/grant /g)?.length).toBe(1);
  });

  it("leaves the preview, the resolver and every table untouched", () => {
    expect(sql).not.toContain("function public.api_get_xometry_beta_dispatch_scope");
    expect(sql).not.toContain("function private.resolve_xometry_beta_dispatch_scope");
    expect(sql).not.toContain("function private.request_scoped_automatic_quote_impl");
    expect(sql).not.toContain("function public.api_request_provider_dispatch");
    expect(code.match(/create or replace function /g)?.length).toBe(2);
    // Outside the two function bodies the migration only revokes and grants.
    const outside = rawSql
      .replace(/create or replace function [\s\S]*?\n\$\$;/g, "")
      .replace(/--.*$/gm, "")
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(outside).not.toMatch(/\b(insert into|delete from|update|alter|create|drop|truncate|comment on)\b/);
    expect(outside.match(/\b(revoke|grant) /g)?.length).toBe(3);
  });

  it("proves both race orders and the mixed-path deadlock check with real lock waits", () => {
    for (const marker of [
      "wait_event_type = 'Lock'",
      "pg_blocking_pids(",
      "pg_advisory_lock(",
      "set statement_timeout = ''10s''",
      "'ovd598_req'",
      "'ovd598_editor'",
      "'ovd598_driver'",
      "public.api_request_provider_dispatch(",
      "xometry_beta_special_delivery_date_not_supported",
      "xometry_beta_xometry_applicability_required",
      "xometry_beta_manufacturing_quote_only",
      "xometry_beta_compatible_drawing_required",
      "xometry_beta_trusted_step_required",
    ]) {
      expect(raceTap).toContain(marker);
    }
    expect(raceTap).toMatch(/select plan\(\d+\);/);
  });
});
