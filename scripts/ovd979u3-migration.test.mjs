import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanFunctionEvents } from "./check-migration-function-collisions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
// U6 retired the draft with a one-line SUPERSEDED header; the rest is the promoted bytes.
const draft = read("docs/migration-drafts/ovd-979u3.sql").replace(/^-- SUPERSEDED:[^\n]*\n/, "");
const signature = "public.api_claim_next_task(text)";

describe("OVD-979 U3 migration artifacts", () => {
  it("ships the reviewed draft bytes and only replaces the claim function", () => {
    expect(read("supabase/migrations/20261030164800_ovd979u3_extraction_attempt_identity.sql")).toBe(draft);
    expect(scanFunctionEvents(draft).map((event) => event.signature)).toEqual([signature]);
  });

  it("restores the prior claim body byte for byte without dropping provenance", () => {
    const prior = scanFunctionEvents(read("supabase/migrations/20260324120000_add_api_claim_next_task.sql"))[0];
    const rollback = read("docs/migration-drafts/ovd-979u3.rollback.sql");
    const restored = scanFunctionEvents(rollback)[0];
    expect(restored.signature).toBe(signature);
    expect(restored.body).toBe(prior.body);
    expect(rollback).not.toMatch(/\bdrop\s+column\b/i);
  });
});
