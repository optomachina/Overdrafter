import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260324103000_add_org_vendor_configs_and_multi_vendor_request_quote.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();
const workspaceMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260403103000_harden_client_quote_workspace_lineage.sql",
);
const workspaceMigrationSql = readFileSync(workspaceMigrationPath, "utf8");
const normalizedWorkspaceSql = workspaceMigrationSql.toLowerCase();

describe("multi-vendor request quote migration", () => {
  it("adds org vendor config persistence with the default enabled-vendor fallback helper", () => {
    expect(normalizedSql).toContain("create table if not exists public.org_vendor_configs");
    expect(normalizedSql).toContain("enabled_for_client_quote_requests boolean not null default false");
    expect(normalizedSql).toContain("primary key (organization_id, vendor)");
    expect(normalizedSql).toContain("create or replace function public.get_enabled_client_quote_vendors");
    expect(migrationSql).toContain("return array['xometry', 'fictiv', 'protolabs']::public.vendor_name[];");
  });

  it("makes pending lane costing vendor-agnostic", () => {
    expect(normalizedSql).toContain("create or replace function public.get_quote_request_pending_estimated_cost_usd");
    expect(normalizedSql).toContain("join public.quote_runs quote_run on quote_run.id = result.quote_run_id");
    expect(normalizedSql).toContain("join public.quote_requests request_row on request_row.id = quote_run.quote_request_id");
    expect(normalizedSql).not.toContain("and result.vendor = 'xometry'");
  });

  it("fixes quote-request status rollups to join through quote_runs and use vendor-neutral failure text", () => {
    expect(normalizedSql).toContain("create or replace function public.sync_quote_request_status_for_run");
    expect(normalizedSql).toContain("join public.quote_runs quote_run on quote_run.quote_request_id = request_row.id");
    expect(migrationSql).toContain("Configured vendors could not return an automated quote and need manual follow-up.");
    expect(migrationSql).toContain("Quote collection failed before a usable vendor response was received.");
    expect(migrationSql).toContain("Quote collection ended without a usable vendor response.");
  });

  it("fans api_request_quote out across enabled applicable vendors and preserves the service line-item bridge", () => {
    expect(normalizedSql).toContain("create or replace function public.api_request_quote");
    expect(normalizedSql).toContain("v_enabled_vendors := coalesce(");
    expect(normalizedSql).toContain("cross join lateral unnest(v_enabled_vendors) as enabled_vendor(vendor)");
    expect(normalizedSql).toContain("'reasoncode', 'no_enabled_vendors'");
    expect(normalizedSql).toContain("insert into public.vendor_quote_results");
    expect(normalizedSql).toContain("insert into public.work_queue");
    expect(migrationSql).toContain("'serviceRequestLineItemId', v_service_request_line_item_id");
  });

  it("hardens client quote workspace lineage and preserves legacy-compatible fallbacks", () => {
    expect(normalizedWorkspaceSql).toContain(
      "create or replace function public.api_list_client_quote_workspace",
    );
    expect(normalizedWorkspaceSql).toContain(
      "left join public.quote_requests request_row on request_row.id = run.quote_request_id",
    );
    expect(normalizedWorkspaceSql).toContain("request_row.status is distinct from 'canceled'");
    expect(normalizedWorkspaceSql).toContain("manufacturing_quote_line_items");
    expect(normalizedWorkspaceSql).toContain("line_item.service_type = 'manufacturing_quote'");
    expect(normalizedWorkspaceSql).toContain("line_item.scope = 'part'");
    expect(normalizedWorkspaceSql).toContain(
      "request_service_request_line_item_id = run.canonical_service_request_line_item_id",
    );
    expect(normalizedWorkspaceSql).toContain("run.quote_request_id is null");
    expect(normalizedWorkspaceSql).toContain("run.request_service_request_line_item_id is null");
    expect(normalizedWorkspaceSql).toContain(
      "comment on function public.build_manufacturing_quote_service_detail(uuid)",
    );
  });
});
