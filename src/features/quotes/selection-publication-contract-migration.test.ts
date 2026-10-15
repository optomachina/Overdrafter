import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const dir = resolve(process.cwd(), "supabase/migrations");
const sql = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(resolve(dir, name), "utf8")).join("\n");
describe("selection/publication source contract repair", () => {
  it("revokes direct selection UPDATE including column grants", () => {
    expect(sql).toContain("revoke update on public.client_selections from public, anon, authenticated, service_role");
    expect(sql).toContain("revoke update (id, package_id, option_id, organization_id, selected_by, note, created_at)");
  });
  it("requires one exact publication source instead of a sorted fallback", () => {
    const start = sql.lastIndexOf("create or replace function public.insert_published_quote_option(");
    const body = sql.slice(start, sql.indexOf("$$;", start) + 3);
    expect(body).toContain("cardinality(v_source_offer_ids) <> 1");
    expect(body).toContain("v_offer.total_price_usd is distinct from v_record.total_price_usd");
    expect(body).toContain("v_offer.lead_time_business_days is distinct from v_record.lead_time_business_days");
    expect(body).toContain("result.quote_run_id = v_package.quote_run_id");
    expect(body).toContain("private.quote_offer_valid_at(v_offer.valid_until, pg_catalog.clock_timestamp())");
    expect(body).not.toContain("limit 1");
    expect(body).not.toContain("for update");
  });
});
