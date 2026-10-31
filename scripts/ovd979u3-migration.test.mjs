import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanFunctionEvents } from "./check-migration-function-collisions.mjs";
import { rollbackSql } from "./ovd979-rollback.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const migration = "20261030164800_ovd979u3_extraction_attempt_identity.sql";
const forward = read(`supabase/migrations/${migration}`);
const rollback = rollbackSql(migration);
const signature = "public.api_claim_next_task(text)";

describe("OVD-979 U3 migration artifacts", () => {
  it("only replaces the claim function", () => {
    expect(scanFunctionEvents(forward).map((event) => event.signature)).toEqual([signature]);
  });

  it("rollback restores the prior claim body byte for byte without dropping provenance", () => {
    const prior = scanFunctionEvents(read("supabase/migrations/20260324120000_add_api_claim_next_task.sql"))[0];
    const restored = scanFunctionEvents(rollback)[0];
    expect(restored.signature).toBe(signature);
    expect(restored.body).toBe(prior.body);
    expect(rollback).not.toMatch(/\bdrop\s+column\b/i);
  });

  it("rollback pins pg_catalog first and keeps the service_role-only ACL", () => {
    expect(rollback).toMatch(/^SET search_path = pg_catalog, public, pg_temp$/m);
    expect(rollback).toContain("REVOKE ALL ON FUNCTION public.api_claim_next_task(text) FROM PUBLIC, anon, authenticated;");
    expect(rollback).toContain("GRANT EXECUTE ON FUNCTION public.api_claim_next_task(text) TO service_role;");
  });
});
