import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("archived delete migration", () => {
  it("removes published quote option dependencies before deleting jobs", () => {
    const migrationPath = resolve(
      process.cwd(),
      "supabase/migrations/20260316110000_fix_archived_job_delete_for_published_parts.sql",
    );
    const sql = readFileSync(migrationPath, "utf8");
    const normalizedSql = sql.toLowerCase();

    const publishedOptionsDeleteIndex = normalizedSql.indexOf("delete from public.published_quote_options");
    const jobsDeleteIndex = normalizedSql.indexOf("delete from public.jobs");

    expect(publishedOptionsDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(jobsDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(publishedOptionsDeleteIndex).toBeLessThan(jobsDeleteIndex);
  });
});
