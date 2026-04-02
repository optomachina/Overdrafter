import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260403103000_harden_client_quote_workspace_lineage.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

describe("client quote workspace lineage migration", () => {
  it("replaces api_list_client_quote_workspace and preserves canceled-run filtering", () => {
    expect(normalizedSql).toContain("create or replace function public.api_list_client_quote_workspace");
    expect(normalizedSql).toContain("left join public.quote_requests request_row on request_row.id = run.quote_request_id");
    expect(normalizedSql).toContain("request_row.status is distinct from 'canceled'");
  });

  it("anchors quote runs to manufacturing line-item lineage while keeping legacy fallbacks", () => {
    expect(normalizedSql).toContain("manufacturing_quote_line_items");
    expect(normalizedSql).toContain("line_item.service_type = 'manufacturing_quote'");
    expect(normalizedSql).toContain("line_item.scope = 'part'");
    expect(normalizedSql).toContain("request_service_request_line_item_id = run.canonical_service_request_line_item_id");
    expect(normalizedSql).toContain("run.quote_request_id is null");
    expect(normalizedSql).toContain("run.request_service_request_line_item_id is null");
  });

  it("documents the build_manufacturing_quote_service_detail json contract", () => {
    expect(normalizedSql).toContain("comment on function public.build_manufacturing_quote_service_detail(uuid)");
    expect(migrationSql).toContain("requestBridge");
    expect(migrationSql).toContain("requestedQuoteQuantities");
    expect(migrationSql).toContain("requestedByDate");
  });
});
