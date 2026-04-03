import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const receivedAtMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260331000000_fix_received_at_overwrite_on_resync.sql",
);
const receivedAtMigrationSql = readFileSync(receivedAtMigrationPath, "utf8");
const normalizedReceivedAtMigrationSql = receivedAtMigrationSql.toLowerCase();

const apiRequestQuoteMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260324103000_add_org_vendor_configs_and_multi_vendor_request_quote.sql",
);
const apiRequestQuoteMigrationSql = readFileSync(apiRequestQuoteMigrationPath, "utf8");
const normalizedApiRequestQuoteMigrationSql = apiRequestQuoteMigrationSql.toLowerCase();

describe("received_at resync fix migration", () => {
  it("redefines sync_quote_request_status_for_run", () => {
    expect(normalizedReceivedAtMigrationSql).toContain(
      "create or replace function public.sync_quote_request_status_for_run",
    );
  });

  it("preserves received_at using coalesce on re-sync", () => {
    // Must use coalesce so the first-write timestamp is never overwritten
    expect(normalizedReceivedAtMigrationSql).toContain(
      "coalesce(v_request.received_at, timezone('utc', now()))",
    );
  });

  it("does not unconditionally overwrite received_at", () => {
    // The previous bug: always setting received_at = timezone('utc', now()) without coalesce
    const unconditionalOverwrite =
      /received_at\s*=\s*case\s+when\s+v_next_status\s*=\s*'received'\s+then\s+timezone\s*\(\s*'utc'\s*,\s*now\s*\(\s*\)\s*\)\s+else/;
    expect(normalizedReceivedAtMigrationSql).not.toMatch(unconditionalOverwrite);
  });

  it("still preserves canceled_at with coalesce", () => {
    expect(normalizedReceivedAtMigrationSql).toContain(
      "coalesce(v_request.canceled_at, timezone('utc', now()))",
    );
  });
});

describe("api_request_quote migration", () => {
  it("does not initialize requested service kinds from v_job in the declare block", () => {
    expect(apiRequestQuoteMigrationSql).not.toMatch(
      /v_requested_service_kinds\s+text\[\]\s*:=\s*public\.normalize_requested_service_kinds\s*\(\s*v_job\./i,
    );
  });

  it("assigns requested service kinds after loading v_job", () => {
    const selectIntoJobIdx = normalizedApiRequestQuoteMigrationSql.indexOf("into v_job");
    const assignmentIdx = normalizedApiRequestQuoteMigrationSql.indexOf(
      "v_requested_service_kinds := public.normalize_requested_service_kinds(",
    );

    expect(selectIntoJobIdx).toBeGreaterThanOrEqual(0);
    expect(assignmentIdx).toBeGreaterThan(selectIntoJobIdx);
  });
});
