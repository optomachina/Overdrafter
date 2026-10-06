// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/20261004130000_ovd628_generic_admission_nowait.sql";
const baselinePath = "supabase/migrations/20261003160000_ovd458_generic_provider_dispatch_permits.sql";
const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const baselineSql = readFileSync(baselinePath, "utf8");
const sql = rawSql.toLowerCase().replace(/\s+/g, " ");
const code = rawSql.replace(/--.*$/gm, "").toLowerCase().replace(/\s+/g, " ");
const raceTap = readFileSync("supabase/tests/provider_dispatch_admission_serialization.sql", "utf8");

const helperLine = "  perform private.lock_provider_dispatch_scope_rows(p_job_id, p_provider);\n";
const freshResolverCall =
  "  v_scope := private.resolve_provider_dispatch_scope(p_job_id, p_provider, p_declared_model_units);\n  if p_expected_scope_fingerprint is null";
const requestFunction =
  /create or replace function public\.api_request_provider_dispatch\([\s\S]*?\n\$\$;\n\nrevoke all on function public\.api_request_provider_dispatch\([\s\S]*?\) from public, anon, authenticated, service_role;\ngrant execute on function public\.api_request_provider_dispatch\([\s\S]*?\) to authenticated;\n/;
const resolverFunction =
  /create or replace function private\.resolve_provider_dispatch_scope\([\s\S]*?\n\$\$;\n\nrevoke all on function private\.resolve_provider_dispatch_scope\(uuid, public\.vendor_name, text\)\n {2}from public, anon, authenticated, service_role;\n/;
const helperBody =
  /create or replace function private\.lock_provider_dispatch_scope_rows\([\s\S]*?\n\$\$;/.exec(rawSql)?.[0] ?? "";

// The three blocks of the 20261003160000 resolver that the restatement drops.
const removedScopeLocks =
  / {2}-- Hold every row the scope is validated and built from[\s\S]*? {2}order by file_row\.id\n {2}for share;\n/;
const removedPolicyLock =
  "  -- Hold the registry row and the active reviewed envelope until commit so the\n  -- rollback switch cannot change underneath an in-flight permit.\n  perform 1\n  from private.quote_provider_admission_policies policy\n  where policy.provider = p_provider\n  for share;\n";
const reviewLockBefore = "    and review.withdrawn_at is null\n  for share;\n";
const reviewLockAfter = "    and review.withdrawn_at is null;\n";

function extract(pattern: RegExp, source: string): string {
  return pattern.exec(source)?.[0] ?? "";
}

describe("OVD-628 generic admission fail-fast row locks", () => {
  it("defines the helper as a pinned security definer returning void", () => {
    expect(rawSql).not.toBe("");
    expect(helperBody).toContain("security definer");
    expect(helperBody).toContain("set search_path = pg_catalog");
    expect(helperBody).toContain("returns void");
    expect(helperBody).toContain("p_job_id uuid,\n  p_provider public.vendor_name\n)");
  });

  it("locks the #580 set plus the provider rows at sufficient strength, all NOWAIT", () => {
    const positions = [
      /perform 1 from public\.jobs job_row where job_row\.id = p_job_id for no key update nowait;/,
      /perform 1 from public\.parts part where part\.job_id = p_job_id order by part\.id for share nowait;/,
      /from public\.approved_part_requirements requirement\s+where requirement\.part_id in \(select part\.id from public\.parts part where part\.job_id = p_job_id\)\s+order by requirement\.part_id\s+for share nowait;/,
      /from public\.job_files file_row\s+where file_row\.id in \(\s+select part\.cad_file_id from public\.parts part where part\.job_id = p_job_id\s+union\s+select part\.drawing_file_id from public\.parts part where part\.job_id = p_job_id\s+\)\s+order by file_row\.id\s+for share nowait;/,
      /from public\.service_request_line_items line_item\s+where line_item\.job_id = p_job_id\s+and line_item\.service_type = 'manufacturing_quote'\s+and line_item\.scope = 'part'\s+for no key update nowait;/,
      /from public\.projects project_row\s+where project_row\.id = \(select job_row\.project_id from public\.jobs job_row where job_row\.id = p_job_id\)\s+for key share nowait;/,
      /from private\.quote_provider_admission_policies policy\s+where policy\.provider = p_provider\s+for share nowait;/,
      /from private\.provider_dispatch_envelope_reviews review\s+where review\.provider = p_provider\s+and review\.withdrawn_at is null\s+for share nowait;/,
    ].map((pattern) => helperBody.search(pattern));
    expect(positions[0]).toBeGreaterThan(0);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1]);
    }
    expect(helperBody.match(/for no key update nowait;/g)).toHaveLength(2);
    expect(helperBody.match(/for share nowait;/g)).toHaveLength(5);
    expect(helperBody.match(/for key share nowait;/g)).toHaveLength(1);
    expect(helperBody.match(/\bfor (no key update|share|key share)\b/g)).toHaveLength(8);
    expect(helperBody.match(/\bnowait\b/g)).toHaveLength(8);
    expect(helperBody).not.toMatch(/for share;|for key share;|for no key update;|skip locked/);
    expect(helperBody).not.toMatch(/for update/);
    // As on the legacy path, the organization and auth.users FK parents are not
    // locked (admin-only residual; no auth.users privilege dependency).
    expect(helperBody).not.toMatch(/public\.organizations/);
    expect(helperBody).not.toMatch(/auth\.users/);
    expect(helperBody).not.toMatch(/auth\.uid\(\)/);
  });

  it("maps only lock_not_available (55P03) to the named P0001 provider_dispatch_job_busy denial", () => {
    expect(helperBody).toMatch(
      /for share nowait;\nexception\n {2}when lock_not_available then\n {4}raise exception using errcode = 'P0001', message = 'provider_dispatch_job_busy';\nend;\n\$\$;$/,
    );
    expect(helperBody.match(/\bexception\b/g)?.length).toBe(2);
    expect(helperBody).not.toMatch(/when others|sqlstate/);
    expect(helperBody).not.toMatch(/lock_timeout|statement_timeout|set_config/);
  });

  it("restates the request byte-for-byte with one helper call on the fresh path after the replay block", () => {
    const baseline = extract(requestFunction, baselineSql);
    const candidate = extract(requestFunction, rawSql);
    expect(baseline).not.toBe("");
    expect(candidate).not.toBe("");
    expect(baseline.split(freshResolverCall)).toHaveLength(2);
    // The fresh-path resolver call directly follows the replay block, which
    // returns the deduplicated result, so a replay never reaches the locks.
    expect(baseline.slice(0, baseline.indexOf(freshResolverCall))).toMatch(
      /select permit\.\* into v_existing[\s\S]*?'status', 'queued'\n {4}\);\n {2}end if;\n\n$/,
    );
    const expected = baseline.replace(freshResolverCall, `${helperLine}${freshResolverCall}`);
    expect(candidate).toBe(expected);
    expect(candidate.split("lock_provider_dispatch_scope_rows")).toHaveLength(2);
    expect(candidate.replace(helperLine, "")).toBe(baseline);
    expect(candidate.indexOf(helperLine)).toBeGreaterThan(candidate.lastIndexOf("'deduplicated', true"));
    expect(candidate.indexOf(helperLine)).toBeGreaterThan(candidate.indexOf("'xometry-beta-approval:'"));
  });

  it("restates the resolver byte-for-byte without any row lock", () => {
    const baseline = extract(resolverFunction, baselineSql);
    const candidate = extract(resolverFunction, rawSql);
    expect(baseline).not.toBe("");
    expect(candidate).not.toBe("");
    expect(baseline.match(removedScopeLocks)?.[0].match(/for share;/g)).toHaveLength(4);
    expect(baseline.split(removedPolicyLock)).toHaveLength(2);
    expect(baseline.split(reviewLockBefore)).toHaveLength(2);
    const expected = baseline
      .replace(removedScopeLocks, "")
      .replace(removedPolicyLock, "")
      .replace(reviewLockBefore, reviewLockAfter);
    expect(candidate).toBe(expected);
    expect(candidate).not.toMatch(/\bfor (update|no key update|share|key share)\b/);
    expect(candidate).toContain("security definer\nset search_path = pg_catalog\n");
  });

  it("revokes the helper from every API role and grants it to none", () => {
    expect(sql).toContain(
      "revoke all on function private.lock_provider_dispatch_scope_rows(uuid, public.vendor_name) from public, anon, authenticated, service_role;",
    );
    expect(code).not.toMatch(/grant [^;]*lock_provider_dispatch_scope_rows/);
    expect(code.match(/grant /g)?.length).toBe(1);
  });

  it("leaves the preview, the legacy path, the impl and every table untouched", () => {
    expect(sql).not.toContain("function public.api_get_provider_dispatch_scope");
    expect(sql).not.toContain("function public.api_request_xometry_beta_dispatch");
    expect(sql).not.toContain("function private.request_scoped_automatic_quote_impl");
    expect(sql).not.toContain("function public.api_authorize_provider_worker_dispatch");
    expect(code.match(/create or replace function /g)?.length).toBe(3);
    // Outside the three function bodies the migration only revokes and grants.
    const outside = rawSql
      .replace(/create or replace function [\s\S]*?\n\$\$;/g, "")
      .replace(/--.*$/gm, "")
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(outside).not.toMatch(/\b(insert into|delete from|update|alter|create|drop|truncate|comment on)\b/);
    expect(outside.match(/\b(revoke|grant) /g)?.length).toBe(4);
  });

  it("proves fail-fast edit-first, request-first, the reversed-order writers, deletes, cancel, line-item strength and replay", () => {
    for (const marker of [
      "wait_event_type = 'Lock'",
      "pg_blocking_pids(",
      "pg_advisory_lock(",
      "set statement_timeout = ''10s''",
      "dblink_is_busy(",
      "public.api_request_provider_dispatch(",
      "public.api_register_trusted_file_hash(",
      "public.api_reset_client_part_property_overrides(",
      "public.api_cancel_quote_request(",
      "public.api_delete_project(",
      "public.api_delete_archived_jobs(",
      "public.api_get_provider_dispatch_scope(",
      "'finished true none'",
      "'line-item-share'",
      "'finished P0001 provider_dispatch_job_busy'",
      "'P0001 provider_dispatch_job_busy'",
      "('40P01', '57014')",
      "provider_dispatch_special_requirements_not_supported",
      "provider_dispatch_provider_applicability_required",
      "provider_dispatch_manufacturing_quote_only",
      "provider_dispatch_drawing_not_admitted",
      "provider_dispatch_trusted_cad_required",
    ]) {
      expect(raceTap).toContain(marker);
    }
    expect(raceTap).toMatch(/select plan\(\d+\);/);
  });
});
