// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/20261004120000_ovd628_trusted_hash_lock_order.sql";
const baselinePath = "supabase/migrations/20260812042000_add_canonical_part_identity.sql";
const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const baselineSql = readFileSync(baselinePath, "utf8");
const code = rawSql.replace(/--.*$/gm, "").toLowerCase().replace(/\s+/g, " ");
const raceTap = readFileSync("supabase/tests/trusted_file_hash_lock_order.sql", "utf8");

const lockBlock = [
  "  perform 1",
  "  from public.parts part",
  "  where part.id in (",
  "    select referencing.id",
  "    from public.parts referencing",
  "    join public.job_files file",
  "      on file.id = referencing.cad_file_id or file.id = referencing.drawing_file_id",
  "    where file.id = p_job_file_id",
  "      or file.blob_id = (",
  "        select target.blob_id from public.job_files target where target.id = p_job_file_id",
  "      )",
  "  )",
  "  order by part.id",
  "  for update;",
].join("\n");

const rpcStatement =
  /create or replace function public\.api_register_trusted_file_hash\([\s\S]*?\n\$\$;\n\nrevoke all on function public\.api_register_trusted_file_hash\(uuid, text\)\nfrom public, anon, authenticated;\ngrant execute on function public\.api_register_trusted_file_hash\(uuid, text\)\nto service_role;\n/;

function extractRpc(source: string): string {
  return rpcStatement.exec(source)?.[0] ?? "";
}

describe("OVD-628 trusted-hash RPC lock order", () => {
  it("restates the RPC byte-for-byte with one parts lock block before the job_files lock", () => {
    const baseline = extractRpc(baselineSql);
    const candidate = extractRpc(rawSql);
    expect(rawSql).not.toBe("");
    expect(baseline).not.toBe("");
    expect(candidate).not.toBe("");
    const anchor = "\n\n  select file.* into v_file\n";
    expect(baseline.split(anchor)).toHaveLength(2);
    // The block follows the role and hash-format checks.
    expect(baseline.slice(0, baseline.indexOf(anchor))).toMatch(
      /raise exception 'A valid SHA-256 hash is required\.';\n {2}end if;$/,
    );
    const expected = baseline.replace(anchor, `\n\n${lockBlock}${anchor}`);
    expect(candidate).toBe(expected);
    expect(candidate.split(lockBlock)).toHaveLength(2);
    expect(candidate.replace(`\n\n${lockBlock}`, "")).toBe(baseline);
  });

  it("keeps the security definer setting, search_path and the revoke/grant lines", () => {
    const candidate = extractRpc(rawSql);
    expect(candidate).toContain("returns void\nlanguage plpgsql\nsecurity definer\nset search_path = pg_catalog\nas $$");
    expect(candidate).toContain(
      "revoke all on function public.api_register_trusted_file_hash(uuid, text)\nfrom public, anon, authenticated;",
    );
    expect(candidate).toContain("grant execute on function public.api_register_trusted_file_hash(uuid, text)\nto service_role;");
    expect(code.match(/\bgrant /g)).toHaveLength(1);
    expect(code.match(/\brevoke /g)).toHaveLength(1);
  });

  it("locks parts with the assignment loop's predicate, before any job_files lock or update", () => {
    const candidate = extractRpc(rawSql);
    const block = candidate.indexOf(lockBlock);
    expect(block).toBeGreaterThan(candidate.indexOf("if v_hash !~ '^[0-9a-f]{64}$' then"));
    expect(block).toBeLessThan(candidate.indexOf("select file.* into v_file"));
    expect(block).toBeLessThan(candidate.indexOf("update public.job_files"));
    expect(block).toBeLessThan(candidate.indexOf("perform private.assign_canonical_part_version(v_part_id);"));
    // The loop covers the same parts, so the assignment re-takes held locks.
    expect(candidate).toContain(
      "    join public.job_files file\n      on file.id = part.cad_file_id or file.id = part.drawing_file_id\n    where file.id = v_file.id\n      or (v_file.blob_id is not null and file.blob_id = v_file.blob_id)\n",
    );
    expect(candidate.match(/for update;/g)).toHaveLength(2);
    expect(candidate).not.toMatch(/for (no key update|share|key share)/);
  });

  it("redefines only the RPC and leaves every other object untouched", () => {
    expect(code.match(/create or replace function /g)).toHaveLength(1);
    expect(code).not.toContain("private.assign_canonical_part_version(p_part_id");
    expect(code).not.toContain("function private.lock_xometry_beta_dispatch_scope_rows");
    const outside = rawSql
      .replace(/create or replace function [\s\S]*?\n\$\$;/g, "")
      .replace(/--.*$/gm, "")
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(outside).not.toMatch(/\b(insert into|delete from|update|alter|create|drop|truncate|comment on)\b/);
    expect(outside.match(/\b(revoke|grant) /g)).toHaveLength(2);
  });

  it("proves the worker-first and request-first races with real lock waits", () => {
    for (const marker of [
      "wait_event_type = 'Lock'",
      "pg_blocking_pids(",
      "set statement_timeout = ''10s''",
      "'ovd628_req'",
      "'ovd628_worker'",
      "'ovd628_driver'",
      "public.api_register_trusted_file_hash(p_job_file_id, p_content_sha256)",
      "public.api_request_xometry_beta_dispatch(",
      "public.api_request_provider_dispatch(",
      "'R1 legacy'",
      "'R2 generic'",
      "'R3 legacy'",
      "'R3 generic'",
      "neither saw 40P01",
    ]) {
      expect(raceTap).toContain(marker);
    }
    expect(raceTap).toMatch(/select plan\(\d+\);/);
  });
});
