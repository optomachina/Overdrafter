// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260812043000_add_private_part_fingerprint_analytics.sql",
  "utf8",
).toLowerCase().replace(/\s+/g, " ");

describe("private part fingerprint analytics migration", () => {
  it("keeps exact and geometry observations in the private schema", () => {
    expect(sql).toContain("private.part_fingerprint_observations");
    expect(sql).toContain("private.part_geometry_fingerprints");
    expect(sql).toContain("private.part_geometry_candidates");
    expect(sql).not.toContain("grant select on private");
  });

  it("limits geometry registration to the service worker", () => {
    expect(sql).toContain("auth.role() <> 'service_role'");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("from public, anon, authenticated");
  });

  it("keeps candidates non-blocking and separate from canonical identity", () => {
    expect(sql).toContain("status text not null default 'candidate'");
    expect(sql).not.toContain("update public.parts set part_version_id");
    expect(sql).not.toContain("api_request_quote");
  });
});
