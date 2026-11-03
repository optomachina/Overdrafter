// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261101130200_ovd994_clear_need_by_and_threads.sql", "utf8");
const previous = readFileSync("supabase/migrations/20260408120000_add_revision_process_to_property_overrides.sql", "utf8");
const rollback = readFileSync("docs/migration-drafts/ovd-994.rollback.sql", "utf8");
function body(sql: string, name = "api_update_client_part_request") {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const open = sql.indexOf("as $$", start) + 5;
  return sql.slice(open, sql.indexOf("$$", open));
}
const md5 = (value: string) => createHash("md5").update(value).digest("hex");
describe("OVD-994 SQL guards and rollback", () => {
  it("pins the exact previous body and restores it byte for byte", () => {
    expect(migration).toContain(md5(body(previous)));
    expect(body(rollback)).toBe(body(previous));
    expect(rollback).toContain(md5(body(migration)));
    expect(rollback).toContain(md5(body(migration, "api_clear_client_part_requested_by_date")));
  });
  it("pins and restores the shared Threads resolver", () => {
    const name = "resolve_project_part_property_values";
    expect(migration).toContain(md5(body(previous, name)));
    expect(rollback).toContain(md5(body(migration, name)));
    expect(body(rollback, name)).toBe(body(previous, name));
  });
  it("keeps the executable rollback fixture byte identical", () => {
    expect(readFileSync("supabase/tests/fixtures/ovd994_rollback.inc", "utf8")).toBe(rollback);
  });
  it("does not reapprove or full-save in the narrow RPC", () => {
    const narrow = body(migration, "api_clear_client_part_requested_by_date");
    expect(narrow).not.toMatch(/approved_by\s*=|approved_at\s*=|api_update_client_part_request|part_request_updated/);
    expect(narrow).toContain("public.load_editable_project_part_context(p_job_id)");
    expect(migration).toContain("p_clear_threads boolean default false");
  });
});
