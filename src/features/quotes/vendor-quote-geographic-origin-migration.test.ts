import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260822213330_add_vendor_quote_offer_geographic_origin.sql",
  ),
  "utf8",
).toLowerCase();

describe("vendor quote geographic origin migration", () => {
  it("adds an unknown-by-default constrained origin separate from sourcing", () => {
    expect(migrationSql).toContain("add column if not exists geographic_origin text");
    expect(migrationSql).toContain("set geographic_origin = default");
    expect(migrationSql).toContain("alter column geographic_origin set default 'unknown'");
    expect(migrationSql).toContain("alter column geographic_origin set not null");
    expect(migrationSql).toContain("geographic_origin in ('domestic', 'foreign', 'unknown')");
    expect(migrationSql).not.toContain("set geographic_origin = sourcing");
  });

  it("reconciles current and stale offer rows in one service-role transaction", () => {
    expect(migrationSql).toContain("function public.reconcile_vendor_quote_offers(");
    expect(migrationSql).toContain("on conflict (vendor_quote_result_id, offer_key) do update");
    expect(migrationSql).toContain("delete from public.vendor_quote_offers as existing");
    expect(migrationSql).toContain("grant execute on function public.reconcile_vendor_quote_offers(uuid, jsonb, jsonb)");
    expect(migrationSql).toContain("update public.vendor_quote_results");
    expect(migrationSql).toContain("to service_role");
    expect(migrationSql).not.toContain("invalidated_at = excluded.invalidated_at");
  });
});
