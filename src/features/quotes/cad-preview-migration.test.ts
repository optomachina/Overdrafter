import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const schemaMigration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260805015950_add_persistent_cad_preview_assets.sql",
  ),
  "utf8",
).toLowerCase();
const backfillMigration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260805020050_enqueue_existing_cad_previews.sql",
  ),
  "utf8",
).toLowerCase();
const sketchDefaultMigration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260805022836_default_cad_previews_to_sketch.sql",
  ),
  "utf8",
).toLowerCase();

describe("persistent CAD preview migrations", () => {
  it("ties one renderer-versioned display-style asset to the current part and CAD file", () => {
    expect(schemaMigration).toContain("create table if not exists public.cad_preview_assets");
    expect(schemaMigration).toContain("source_cad_file_id uuid not null references public.job_files(id)");
    expect(schemaMigration).toContain("unique (part_id, display_style, view_orientation)");
    expect(schemaMigration).toContain("alter table public.cad_preview_assets enable row level security");
    expect(schemaMigration).toContain("grant select on table public.cad_preview_assets to authenticated");
  });

  it("authorizes matching storage objects through accessible part ownership", () => {
    expect(schemaMigration).toContain("quote_artifacts_storage_read_cad_previews");
    expect(schemaMigration).toContain("asset.storage_path = objects.name");
    expect(schemaMigration).toContain("asset.storage_bucket = objects.bucket_id");
    expect(schemaMigration).toContain("public.user_can_access_job(part.job_id)");
  });

  it("queues one dedicated backfill task for each eligible STEP-backed part", () => {
    expect(backfillMigration).toContain("'generate_cad_preview'");
    expect(backfillMigration).toContain("join public.job_files cad_file on cad_file.id = part.cad_file_id");
    expect(backfillMigration).toContain("lower(cad_file.original_name) ~ '\\.(step|stp)$'");
    expect(backfillMigration).toContain("queue.status in ('queued', 'running')");
  });

  it("adds sketch without removing hidden-lines-removed and makes sketch the default", () => {
    expect(sketchDefaultMigration).toContain("display_style in ('hidden_lines_removed', 'sketch')");
    expect(sketchDefaultMigration).toContain("alter column display_style set default 'sketch'");
    expect(sketchDefaultMigration).toContain("asset.display_style <> 'hidden_lines_removed'");
    expect(sketchDefaultMigration).toContain("'cad_preview_sketch_backfill'");
  });
});
