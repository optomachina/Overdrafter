// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260812042000_add_canonical_part_identity_and_private_fingerprints.sql",
  "utf8",
).toLowerCase().replace(/\s+/g, " ");

describe("canonical part identity migration", () => {
  it("models an organization part, exact package versions, and placements additively", () => {
    expect(sql).toContain("create table if not exists public.canonical_parts");
    expect(sql).toContain("create table if not exists public.part_versions");
    expect(sql).toContain("add column if not exists part_version_id uuid");
    expect(sql).toContain("unique (organization_id, package_fingerprint)");
  });

  it("requires trusted worker hashes before exact package reuse", () => {
    expect(sql).toContain("trusted_content_sha256");
    expect(sql).toContain("auth.role() <> 'service_role'");
    expect(sql).toContain("version.version_state = 'complete'");
    expect(sql).toContain("'result', 'existing_version'");
    expect(sql).toContain("api_resolve_trusted_part_intake");
    expect(sql).toContain("api_reuse_trusted_part_version_artifacts");
    expect(sql).toContain("browser digests are hints only");
  });

  it("keeps cross-organization matches private and non-actionable", () => {
    expect(sql).toContain("create table if not exists private.part_fingerprint_observations");
    expect(sql).toContain("create table if not exists private.part_geometry_candidates");
    expect(sql).toContain("revoke all on private.part_fingerprint_observations, private.part_geometry_candidates from public, anon, authenticated");
    expect(sql).not.toContain("api_get_global_part");
  });

  it("stages geometry candidates without making them an intake blocker", () => {
    expect(sql).toContain("status text not null default 'candidate'");
    expect(sql).not.toContain("join private.part_geometry_candidates");
  });
});
