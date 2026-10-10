import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const directory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(resolve(directory, name), "utf8")).join("\n");
function latestFunction(name: string) {
  const start = migrations.toLowerCase().lastIndexOf(`create or replace function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = migrations.indexOf("$$;", migrations.indexOf("as $$", start));
  return migrations.slice(start, end + 3);
}
describe("authoritative quote selection expiry migration", () => {
  it.each(["api_set_job_selected_vendor_quote_offer", "api_select_quote_option"])("checks %s expiry after locks with server wall time", (name) => {
    const sql = latestFunction(`public.${name}`);
    expect(sql).toContain("private.quote_offer_valid_at(v_offer.valid_until, pg_catalog.clock_timestamp())");
    expect(sql.indexOf("for share of offer")).toBeLessThan(sql.indexOf("private.quote_offer_valid_at"));
    expect(sql.indexOf("for update")).toBeLessThan(sql.indexOf("private.quote_offer_valid_at"));
    expect(sql).toContain("v_offer.invalidated_at is not null");
  });
  it("binds published choices to the exact source offer and package execution", () => {
    const sql = latestFunction("public.api_select_quote_option");
    expect(sql).toContain("offer.id = v_option.source_vendor_quote_offer_id");
    expect(sql).toContain("result.id = v_option.source_vendor_quote_id");
    expect(sql).toContain("result.quote_run_id = v_package.quote_run_id");
    expect(sql).toContain("part.job_id = v_package.job_id");
    expect(sql).toContain("public.user_can_access_package(v_package.id)");
    expect(sql.indexOf("private.quote_offer_valid_at")).toBeLessThan(sql.indexOf("insert into public.client_selections"));
  });
  it("closes direct API write bypasses while preserving unrelated job edits", () => {
    expect(migrations).toContain("revoke insert on public.client_selections from public, anon, authenticated, service_role");
    const sql = latestFunction("private.guard_direct_job_offer_selection");
    expect(sql).toContain("security invoker");
    expect(sql).toContain("current_user in ('anon', 'authenticated', 'service_role')");
    expect(sql).toContain("tg_op = 'INSERT'");
    expect(sql).toContain("new.selected_vendor_quote_offer_id is distinct from old.selected_vendor_quote_offer_id");
    expect(migrations).toContain("before insert or update of selected_vendor_quote_offer_id on public.jobs");
  });
  it("keeps null validity and inclusive equality explicit in a private predicate", () => {
    const sql = latestFunction("private.quote_offer_valid_at");
    expect(sql).toContain("p_at is not null");
    expect(sql).toContain("p_valid_until is null or p_valid_until >= p_at");
    expect(migrations).toContain("revoke all on function private.quote_offer_valid_at(timestamptz, timestamptz)");
  });
});
