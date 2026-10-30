import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanFunctionEvents } from "./check-migration-function-collisions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const forward = read("supabase/migrations/20261030162500_ovd979u2_canonical_requirement_lock_order.sql");
const rollback = scanFunctionEvents(read("docs/migration-drafts/ovd-979u2.rollback.sql"));
const prior = [
  ["public.api_approve_job_requirements(uuid,jsonb)", "20260316170500_preserve_raw_extraction_and_quote_overrides.sql"],
  ["public.api_auto_approve_job_requirements(uuid)", "20260317013000_fix_auto_approve_stale_auto_refresh.sql"],
  ["public.api_reset_client_part_property_overrides(uuid,text[])", "20260408120000_add_revision_process_to_property_overrides.sql"],
  ["public.api_reuse_trusted_part_version_artifacts(uuid,uuid,uuid)", "20260812042000_add_canonical_part_identity.sql"],
];

describe("OVD-979 U2 migration artifacts", () => {
  it("replaces exactly the four reviewed functions", () => {
    expect(scanFunctionEvents(forward).map((event) => event.signature).sort()).toEqual(prior.map(([signature]) => signature).sort());
  });

  it.each(prior)("restores %s prosrc byte for byte", (signature, migration) => {
    const original = scanFunctionEvents(read(`supabase/migrations/${migration}`))
      .find((event) => event.signature === signature);
    const restored = rollback.find((event) => event.signature === signature);
    expect(original?.body).toBeTypeOf("string");
    expect(restored?.body).toBe(original.body);
  });
});
