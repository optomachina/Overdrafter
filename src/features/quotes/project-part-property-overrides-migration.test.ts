import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260402120000_persist_project_part_property_overrides.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("project part property overrides migration", () => {
  it("drops the legacy client part request RPC overload before recreating the threaded signature", () => {
    expect(migrationSql).toContain("drop function if exists public.api_update_client_part_request(");
    expect(migrationSql).toContain("p_threads text default null");
  });

  it("returns null instead of -infinity for untouched part metadata timestamps", () => {
    expect(migrationSql).toContain("'updatedAt',");
    expect(migrationSql).toContain("nullif(");
    expect(migrationSql).toContain("'-infinity'::timestamptz");
  });
});
