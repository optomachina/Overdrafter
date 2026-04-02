import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260402100000_include_service_line_item_id_in_vendor_quote_queue_payload.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

describe("service request line-item queue payload bridge migration", () => {
  it("documents the worker traceability reason for the payload change", () => {
    expect(migrationSql).toContain("Adding the");
    expect(migrationSql).toContain("authoritative line-item id to queued vendor payloads");
    expect(migrationSql).toContain("worker task logs");
  });

  it("writes serviceRequestLineItemId into run_vendor_quote payloads", () => {
    expect(normalizedSql).toContain("insert into public.work_queue");
    expect(migrationSql).toContain("'run_vendor_quote'");
    expect(migrationSql).toContain("'serviceRequestLineItemId', v_service_request_line_item_id");
    expect(migrationSql).toContain("'quoteRequestId', v_request_id");
    expect(migrationSql).toContain("'quoteRunId', v_quote_run_id");
  });
});
