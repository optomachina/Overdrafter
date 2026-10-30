import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanFunctionEvents } from "./check-migration-function-collisions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const migration = "20261030190000_ovd979u5_drawing_extraction_dedupe.sql";
const forward = read("docs/migration-drafts/ovd-979u5.sql");
const prior = [
  ["public.api_request_extraction(uuid)", "20260812042000_add_canonical_part_identity.sql"],
  ["public.api_claim_next_task(text)", "20261030164800_ovd979u3_extraction_attempt_identity.sql"],
];

describe("OVD-979 U5 migration artifacts", () => {
  it("ships the reviewed bytes and changes only request, claim and the settlement helper", () => {
    expect(read(`supabase/migrations/${migration}`)).toBe(forward);
    expect(scanFunctionEvents(forward).map((event) => event.signature).sort()).toEqual([
      ...prior.map(([signature]) => signature), "private.merge_pending_drawing_extraction()",
    ].sort());
  });

  it.each(prior)("restores U4-era %s bytes and has no later replacement", (signature, source) => {
    const original = scanFunctionEvents(read(`supabase/migrations/${source}`))
      .find((event) => event.signature === signature);
    const restored = scanFunctionEvents(read("docs/migration-drafts/ovd-979u5.rollback.sql"))
      .find((event) => event.signature === signature);
    expect(original?.body).toBeTypeOf("string");
    expect(restored?.body).toBe(original.body);
    const later = readdirSync(join(root, "supabase/migrations"))
      .filter((name) => name.endsWith(".sql") && name > migration)
      .filter((name) => scanFunctionEvents(read(`supabase/migrations/${name}`))
        .some((event) => event.signature === signature));
    expect(later).toEqual([]);
  });
});
