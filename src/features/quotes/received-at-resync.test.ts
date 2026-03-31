import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260331000000_fix_received_at_overwrite_on_resync.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

describe("received_at resync fix migration", () => {
  it("redefines sync_quote_request_status_for_run", () => {
    expect(normalizedSql).toContain(
      "create or replace function public.sync_quote_request_status_for_run",
    );
  });

  it("preserves received_at using coalesce on re-sync", () => {
    // Must use coalesce so the first-write timestamp is never overwritten
    expect(normalizedSql).toContain(
      "coalesce(v_request.received_at, timezone('utc', now()))",
    );
  });

  it("does not unconditionally overwrite received_at", () => {
    // The previous bug: always setting received_at = timezone('utc', now()) without coalesce
    const unconditionalOverwrite =
      /received_at\s*=\s*case\s+when\s+v_next_status\s*=\s*'received'\s+then\s+timezone\s*\(\s*'utc'\s*,\s*now\s*\(\s*\)\s*\)\s+else/;
    expect(normalizedSql).not.toMatch(unconditionalOverwrite);
  });

  it("still preserves canceled_at with coalesce", () => {
    expect(normalizedSql).toContain(
      "coalesce(v_request.canceled_at, timezone('utc', now()))",
    );
  });
});
