import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260402120000_persist_project_part_property_overrides.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();
const functionStart = normalizedSql.indexOf(
  "create or replace function public.load_editable_project_part_context",
);
const functionEnd = normalizedSql.indexOf("\n$$;", functionStart);
const loadEditableProjectPartContextSql = normalizedSql.slice(functionStart, functionEnd);
const resetFunctionStart = normalizedSql.indexOf(
  "create or replace function public.api_reset_client_part_property_overrides",
);
const resetFunctionEnd = normalizedSql.indexOf("\n$$;", resetFunctionStart);
const resetClientPartPropertyOverridesSql = normalizedSql.slice(resetFunctionStart, resetFunctionEnd);

describe("project part property overrides migration", () => {
  it("drops the legacy client part request RPC overload before recreating the threaded signature", () => {
    const dropIdx = migrationSql.indexOf(
      "drop function if exists public.api_update_client_part_request(",
    );
    const recreateWithThreadsIdx = migrationSql.search(
      /create or replace function public\.api_update_client_part_request\([\s\S]*?p_threads text default null/i,
    );

    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(recreateWithThreadsIdx).toBeGreaterThan(dropIdx);
  });

  it("returns null instead of -infinity for untouched part metadata timestamps", () => {
    expect(migrationSql).toContain("'updatedAt',");
    expect(migrationSql).toContain("nullif(");
    expect(migrationSql).toContain("'-infinity'::timestamptz");
  });

  it("uses shared SQL helpers so update and reset stay aligned on seeded defaults", () => {
    const count = (needle: string) => migrationSql.split(needle).length - 1;

    expect(migrationSql).toContain("create or replace function public.seed_project_part_property_defaults(");
    expect(migrationSql).toContain("create or replace function public.resolve_project_part_property_values(");
    expect(migrationSql).toContain("create or replace function public.build_project_part_property_snapshot(");
    expect(migrationSql).toContain("create or replace function public.load_editable_project_part_context(");
    expect(count("public.seed_project_part_property_defaults(")).toBeGreaterThan(1);
    expect(count("public.resolve_project_part_property_values(")).toBeGreaterThan(1);
    expect(count("public.build_project_part_property_snapshot(")).toBeGreaterThan(1);
    expect(count("public.load_editable_project_part_context(")).toBeGreaterThan(1);
  });

  it("loads editable project part context without recursively selecting from itself", () => {
    expect(normalizedSql).toContain("create or replace function public.load_editable_project_part_context");
    expect(loadEditableProjectPartContextSql).not.toContain(
      "from public.load_editable_project_part_context(p_job_id) context;",
    );
  });

  it("returns the loaded job, part, requirement, and extraction rows via return query", () => {
    expect(loadEditableProjectPartContextSql).toContain("return query");
    expect(loadEditableProjectPartContextSql).toContain("select");
    expect(loadEditableProjectPartContextSql).toContain("v_job");
    expect(loadEditableProjectPartContextSql).toContain("v_part");
    expect(loadEditableProjectPartContextSql).toContain("v_requirement");
    expect(loadEditableProjectPartContextSql).toContain("v_extraction");
  });

  it("loads reset-property context through a single record before unpacking rowtypes", () => {
    expect(resetClientPartPropertyOverridesSql).toContain(
      "create or replace function public.api_reset_client_part_property_overrides(",
    );
    expect(resetClientPartPropertyOverridesSql).toContain("v_context record;");
    expect(resetClientPartPropertyOverridesSql).toContain("select *");
    expect(resetClientPartPropertyOverridesSql).toContain("into v_context");
    expect(resetClientPartPropertyOverridesSql).toContain(
      "from public.load_editable_project_part_context(p_job_id);",
    );
    expect(resetClientPartPropertyOverridesSql).toContain("v_job := v_context.job;");
    expect(resetClientPartPropertyOverridesSql).toContain("v_part := v_context.part;");
    expect(resetClientPartPropertyOverridesSql).toContain("v_requirement := v_context.requirement;");
    expect(resetClientPartPropertyOverridesSql).toContain("v_extraction := v_context.extraction;");
  });
});
