import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260714032603_fix_client_drawing_preview_storage_path.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8").toLowerCase();

describe("drawing preview storage policy migration", () => {
  it("matches preview metadata against the storage object path", () => {
    expect(migrationSql).toContain("asset.storage_path = objects.name");
    expect(migrationSql).not.toMatch(/asset\.storage_path\s*=\s*name\b/);
  });

  it("requires preview metadata to match the storage object bucket", () => {
    expect(migrationSql).toContain("asset.storage_bucket = objects.bucket_id");
    expect(migrationSql).not.toMatch(/asset\.storage_bucket\s*=\s*bucket_id\b/);
  });

  it("preserves authenticated job access checks", () => {
    expect(migrationSql).toContain("to authenticated");
    expect(migrationSql).toContain("public.user_can_access_job(part.job_id)");
  });
});
