import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260331010000_sync_service_line_item_status_from_quote_requests.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

describe("service request line-item status bridge migration", () => {
  it("defines a helper that recalculates line-item status from the latest linked quote request", () => {
    expect(normalizedSql).toContain("create or replace function public.sync_service_request_line_item_status(");
    expect(normalizedSql).toContain("from public.quote_requests request_row");
    expect(normalizedSql).toContain("where request_row.service_request_line_item_id = p_service_request_line_item_id");
    expect(normalizedSql).toContain("order by request_row.created_at desc, request_row.id desc");
  });

  it("syncs line-item status when quote requests are inserted or updated", () => {
    expect(normalizedSql).toContain(
      "create or replace function public.sync_service_request_line_item_status_from_quote_request()",
    );
    expect(normalizedSql).toContain(
      "create trigger sync_service_request_line_item_status_on_quote_request",
    );
    expect(normalizedSql).toContain("after insert or update of status, service_request_line_item_id, created_at");
  });

  it("backfills existing line-item statuses from the latest linked quote request", () => {
    expect(normalizedSql).toContain("with latest_request_status as (");
    expect(normalizedSql).toContain("update public.service_request_line_items line_item");
    expect(normalizedSql).toContain("status = coalesce(latest_request_status.latest_status, 'open')");
  });

  it("documents the rollback path explicitly", () => {
    expect(migrationSql).toContain("Rollback path: drop the trigger/function added here");
  });
});
