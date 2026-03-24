import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260324000000_add_service_request_line_items.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

describe("service_request_line_items migration", () => {
  it("creates the table and the quote-request link column", () => {
    expect(normalizedSql).toContain("create table if not exists public.service_request_line_items");
    expect(normalizedSql).toContain("service_request_line_item_id uuid");
    expect(normalizedSql).toContain("references public.service_request_line_items(id) on delete set null");
  });

  it("defines the canonical service type and scope constraints", () => {
    expect(migrationSql).toContain("constraint service_request_line_items_service_type_check");
    expect(migrationSql).toContain("'manufacturing_quote'");
    expect(migrationSql).toContain("'cad_modeling'");
    expect(migrationSql).toContain("'drawing_redraft'");
    expect(migrationSql).toContain("'fea_analysis'");
    expect(migrationSql).toContain("'dfm_review'");
    expect(migrationSql).toContain("'dfa_review'");
    expect(migrationSql).toContain("'assembly_support'");
    expect(migrationSql).toContain("'sourcing_only'");
    expect(migrationSql).toContain("constraint service_request_line_items_scope_check");
    expect(migrationSql).toContain("scope in ('part', 'assembly', 'project')");
  });

  it("backfills one manufacturing line item per job and links existing quote requests", () => {
    expect(normalizedSql).toContain("insert into public.service_request_line_items");
    expect(normalizedSql).toContain("from public.quote_requests request_row");
    expect(normalizedSql).toContain("service_type = 'manufacturing_quote'");
    expect(normalizedSql).toContain("scope = 'part'");
    expect(normalizedSql).toContain("on conflict (job_id, service_type, scope) where job_id is not null do update");
    expect(normalizedSql).toContain("update public.quote_requests request_row");
    expect(normalizedSql).toContain("set service_request_line_item_id = line_item.id");
  });

  it("replaces api_request_quote and returns serviceRequestLineItemId", () => {
    expect(normalizedSql).toContain("create or replace function public.api_request_quote");
    expect(migrationSql).toContain("'serviceRequestLineItemId', v_service_request_line_item_id");
    expect(normalizedSql).toContain("public.build_manufacturing_quote_service_detail");
  });
});
