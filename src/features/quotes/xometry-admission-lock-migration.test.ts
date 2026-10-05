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

const helperLine = "    perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);";
const guardedHelper = `  if v_existing.id is null then\n${helperLine}\n  end if;\n`;
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

  it("locks the job and its line item FOR NO KEY UPDATE, the scope reads FOR SHARE and the FK parents FOR KEY SHARE, all NOWAIT", () => {
    const job = helperBody.search(
      /perform 1 from public\.jobs job_row where job_row\.id = p_job_id for no key update nowait;/,
    );
    const parts = helperBody.search(
      /perform 1 from public\.parts part where part\.job_id = p_job_id order by part\.id for share nowait;/,
    );
    const requirements = helperBody.search(
      /from public\.approved_part_requirements requirement\s+where requirement\.part_id in \(select part\.id from public\.parts part where part\.job_id = p_job_id\)\s+order by requirement\.part_id\s+for share nowait;/,
    );
    const files = helperBody.search(
      /from public\.job_files file_row\s+where file_row\.id in \(\s+select part\.cad_file_id from public\.parts part where part\.job_id = p_job_id\s+union\s+select part\.drawing_file_id from public\.parts part where part\.job_id = p_job_id\s+\)\s+order by file_row\.id\s+for share nowait;/,
    );
    const lineItem = helperBody.search(
      /from public\.service_request_line_items line_item\s+where line_item\.job_id = p_job_id\s+and line_item\.service_type = 'manufacturing_quote'\s+and line_item\.scope = 'part'\s+for no key update nowait;/,
    );
    const organization = helperBody.search(
      /from public\.organizations organization_row\s+where organization_row\.id = \(select job_row\.organization_id from public\.jobs job_row where job_row\.id = p_job_id\)\s+for key share nowait;/,
    );
    const project = helperBody.search(
      /from public\.projects project_row\s+where project_row\.id = \(select job_row\.project_id from public\.jobs job_row where job_row\.id = p_job_id\)\s+for key share nowait;/,
    );
    const user = helperBody.search(
      /perform 1 from auth\.users user_row where user_row\.id = auth\.uid\(\) for key share nowait;/,
    );
    expect(job).toBeGreaterThan(0);
    expect(parts).toBeGreaterThan(job);
    expect(requirements).toBeGreaterThan(parts);
    expect(files).toBeGreaterThan(requirements);
    expect(lineItem).toBeGreaterThan(files);
    expect(organization).toBeGreaterThan(lineItem);
    expect(project).toBeGreaterThan(organization);
    expect(user).toBeGreaterThan(project);
    expect(helperBody.match(/for no key update nowait;/g)).toHaveLength(2);
    expect(helperBody.match(/for share nowait;/g)).toHaveLength(3);
    expect(helperBody.match(/for key share nowait;/g)).toHaveLength(3);
    expect(helperBody.match(/\bfor (no key update|share|key share)\b/g)).toHaveLength(8);
    expect(helperBody.match(/\bnowait\b/g)).toHaveLength(8);
    expect(helperBody).not.toMatch(/for share;|for key share;|for no key update;|skip locked/);
    expect(helperBody).not.toMatch(/for update/);
  });

  it("maps only lock_not_available (55P03) to the named P0001 xometry_beta_job_busy denial", () => {
    expect(helperBody).toMatch(
      /for key share nowait;\nexception\n {2}when lock_not_available then\n {4}raise exception using errcode = 'P0001', message = 'xometry_beta_job_busy';\nend;\n\$\$;$/,
    );
    expect(helperBody.match(/\bexception\b/g)?.length).toBe(2);
    expect(helperBody).not.toMatch(/when others|sqlstate/);
    expect(helperBody).not.toMatch(/lock_timeout|statement_timeout|set_config/);
  });

  it("restates the request byte-for-byte with one guarded helper call after the replay lookup", () => {
    const baseline = extractRequest(baselineSql);
    const candidate = extractRequest(rawSql);
    expect(baseline).not.toBe("");
    expect(candidate).not.toBe("");
    const anchor = "  v_scope := private.resolve_xometry_beta_dispatch_scope_with_access(";
    expect(baseline.split(anchor)).toHaveLength(2);
    // The guard sits right after the first approval-reference reuse check, so
    // an exact replay of a committed permit never reaches the row locks.
    expect(baseline.slice(0, baseline.indexOf(anchor))).toMatch(
      /select permit\.\* into v_existing[\s\S]*?\) then raise exception 'xometry_beta_approval_reference_reused'; end if;\n$/,
    );
    const expected = baseline.replace(anchor, `${guardedHelper}${anchor}`);
    expect(candidate).toBe(expected);
    expect(candidate.split("lock_xometry_beta_dispatch_scope_rows")).toHaveLength(2);
    expect(candidate.replace(guardedHelper, "")).toBe(baseline);
    expect(candidate.indexOf(guardedHelper)).toBeGreaterThan(candidate.indexOf("select permit.* into v_existing"));
    expect(candidate.indexOf(guardedHelper)).toBeGreaterThan(candidate.indexOf("'xometry-beta-approval:'"));
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

  it("proves fail-fast edit-first, request-first, the reversed-order writers and the mixed-path check", () => {
    for (const marker of [
      "wait_event_type = 'Lock'",
      "pg_blocking_pids(",
      "pg_advisory_lock(",
      "set statement_timeout = ''10s''",
      "'ovd598_req'",
      "'ovd598_editor'",
      "'ovd598_driver'",
      "'ovd598_worker'",
      "'ovd598_resetter'",
      "dblink_is_busy(",
      "public.api_register_trusted_file_hash(",
      "public.api_reset_client_part_property_overrides(",
      "public.api_cancel_quote_request(",
      "public.api_delete_project(",
      "'finished true none'",
      "for share', pg_temp.ovd598_id('job', 19)",
      "'finished P0001 xometry_beta_job_busy'",
      "'P0001 xometry_beta_job_busy'",
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
