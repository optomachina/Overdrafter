// @vitest-environment node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeClientPartMetadata } from "./utils";

const filename = "20261101130300_ovd1011_client_part_metadata_defaults.sql";
const migration = readFileSync(`supabase/migrations/${filename}`, "utf8");
const previous = readFileSync("supabase/migrations/20261011170000_fix_no_drawing_lifecycle.sql", "utf8");
const historical = readFileSync("supabase/migrations/20260402120000_persist_project_part_property_overrides.sql", "utf8");
const rollback = readFileSync("docs/migration-drafts/ovd-1011.rollback.sql", "utf8");
const body = (sql: string) => sql.split("as $$")[1].split("$$;")[0];
const md5 = (sql: string) => createHash("md5").update(body(sql)).digest("hex");
const projectionColumns = historical.slice(
  historical.indexOf("      coalesce(requirement.spec_snapshot #> '{projectPartProperties,defaults}'"),
  historical.indexOf("      extraction.id as extraction_id"),
);
const propertyBlock = historical.slice(
  historical.indexOf("        'projectPartProperties',"),
  historical.indexOf("        'pageCount', projection.page_count"),
);

describe("OVD-1011 client reset defaults migration", () => {
  it("changes only the historical property projection in the current private body", () => {
    expect(body(migration)).toBe(body(previous)
      .replace("      extraction.id as extraction_id,", `${projectionColumns}      extraction.id as extraction_id,`)
      .replace("        'clientExtraction', jsonb_build_object(", `${propertyBlock}        'clientExtraction', jsonb_build_object(`));
    expect(body(migration).replace(projectionColumns, "").replace(propertyBlock, "")).toBe(body(previous));
    expect(migration).toContain("create or replace function private.api_list_client_part_metadata(");
    expect(migration).not.toContain("create or replace function public.");
    const newer = readdirSync("supabase/migrations").filter((name) => name > filename);
    expect(newer.filter((name) => /create or replace function (?:public|private)\.api_list_client_part_metadata/.test(
      readFileSync(`supabase/migrations/${name}`, "utf8"),
    ))).toEqual([]);
  });

  it("preserves security attributes and the private ACL in both directions", () => {
    for (const sql of [migration, rollback]) {
      expect(sql).toContain("language sql\nstable\nsecurity definer\nset search_path = public\nas $$");
      expect(sql).toContain("revoke all on function private.api_list_client_part_metadata(uuid[]) from public, anon, authenticated, service_role;");
      expect(sql).not.toMatch(/^grant /m);
      expect(sql.indexOf("set local lock_timeout = '5s';")).toBeLessThan(sql.indexOf("do $ovd1011_guard$"));
      expect(sql.indexOf("$ovd1011_guard$;")).toBeLessThan(sql.indexOf("create or replace function"));
      expect(sql).toContain("pg_catalog.md5(p.prosrc)");
      expect(sql).toContain("pg_catalog.to_regprocedure('private.api_list_client_part_metadata(uuid[])')");
      expect(sql).toContain("if v_md5 is null or v_md5 not in (");
      expect(sql).toContain("using errcode = '55000'");
    }
  });

  it("guards both directions and rolls back the prior prosrc byte for byte", () => {
    expect(md5(previous)).not.toBe(md5(migration));
    expect(migration).toContain(`'${md5(previous)}', '${md5(migration)}'`);
    expect(rollback).toContain(`'${md5(migration)}', '${md5(previous)}'`);
    expect(body(rollback)).toBe(body(previous));
  });

  it("emits the property-state keys consumed as dbDefaults by the client", () => {
    for (const key of ["defaults", "overrides", "createdAt", "updatedAt"]) {
      expect(propertyBlock).toContain(`'${key}', projection.project_property_`);
    }
    const state = {
      defaults: { description: "Extracted bracket", partNumber: "BR-1", revision: "A", material: "6061", finish: "Anodized", threads: "M6", tightestToleranceInch: 0.005, process: "CNC" },
      overrides: { material: "7075" },
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T01:00:00Z",
    };
    expect(normalizeClientPartMetadata({ partId: "part-1", jobId: "job-1", organizationId: "org-1", projectPartProperties: state })?.requirement.projectPartProperties).toEqual(state);
    expect(readFileSync("src/pages/ClientPart.tsx", "utf8")).toContain("const dbDefaults = partDetail?.part?.clientRequirement?.projectPartProperties?.defaults;");
    expect(readFileSync("src/features/quotes/use-client-part-controller.ts", "utf8")).toContain("part?.clientRequirement?.projectPartProperties?.defaults");
  });
});
