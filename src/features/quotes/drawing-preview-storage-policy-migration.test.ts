import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const historicalMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260714032603_fix_client_drawing_preview_storage_path.sql",
);
const forwardMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260816011204_restore_drawing_preview_storage_bucket_binding.sql",
);
const historicalMigration = readFileSync(historicalMigrationPath);
const forwardMigrationSql = readFileSync(
  forwardMigrationPath,
  "utf8",
).toLowerCase();

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

describe("drawing preview storage policy migration", () => {
  it("preserves the historical migration payload recorded by the repository", () => {
    expect(historicalMigration.byteLength).toBe(518);
    expect(createHash("sha256").update(historicalMigration).digest("hex")).toBe(
      "e315920a65ba1cb0337838494fce3165d19e1f6082cb1ede1658efc255a070d0",
    );
  });

  it("recreates only the authenticated drawing preview read policy", () => {
    const expectedSql = `
      drop policy if exists "quote_artifacts_storage_read_drawing_previews"
      on storage.objects;

      create policy "quote_artifacts_storage_read_drawing_previews"
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'quote-artifacts'
        and exists (
          select 1
          from public.drawing_preview_assets asset
          join public.parts part on part.id = asset.part_id
          where asset.storage_path = objects.name
            and asset.storage_bucket = objects.bucket_id
            and public.user_can_access_job(part.job_id)
        )
      );
    `;

    expect(normalizeSql(forwardMigrationSql)).toBe(normalizeSql(expectedSql));
  });

  it("matches preview metadata against the storage object path", () => {
    expect(forwardMigrationSql).toContain("asset.storage_path = objects.name");
    expect(forwardMigrationSql).not.toMatch(/asset\.storage_path\s*=\s*name\b/);
  });

  it("requires preview metadata to match the storage object bucket", () => {
    expect(forwardMigrationSql).toContain("bucket_id = 'quote-artifacts'");
    expect(forwardMigrationSql).toContain(
      "asset.storage_bucket = objects.bucket_id",
    );
    expect(forwardMigrationSql).not.toMatch(
      /asset\.storage_bucket\s*=\s*bucket_id\b/,
    );
  });

  it("preserves authenticated job access checks", () => {
    expect(forwardMigrationSql).toContain(
      "public.user_can_access_job(part.job_id)",
    );
  });
});
