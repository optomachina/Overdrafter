import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanFunctionEvents } from "./check-migration-function-collisions.mjs";
import { rollbackSql } from "./ovd979-rollback.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const migration = "20261030190000_ovd979u5_drawing_extraction_dedupe.sql";
const forward = read(`supabase/migrations/${migration}`);
const rollback = rollbackSql(migration);
const prior = [
  ["public.api_request_extraction(uuid)", "20261030162500_ovd979u2_canonical_requirement_lock_order.sql"],
  ["public.api_claim_next_task(text)", "20261030164800_ovd979u3_extraction_attempt_identity.sql"],
];

describe("OVD-979 U5 migration artifacts", () => {
  it("changes only request, claim and the settlement helper", () => {
    expect(scanFunctionEvents(forward).map((event) => event.signature).sort()).toEqual([
      ...prior.map(([signature]) => signature), "private.merge_pending_drawing_extraction()",
    ].sort());
  });

  it.each(prior)("rollback restores %s bytes from %s, with no later replacement", (signature, source) => {
    const original = scanFunctionEvents(read(`supabase/migrations/${source}`))
      .findLast((event) => event.signature === signature);
    const restored = scanFunctionEvents(rollback).find((event) => event.signature === signature);
    expect(original?.body).toBeTypeOf("string");
    expect(restored?.body).toBe(original.body);
    expect(rollback).toContain(`-- ${signature} from ${source}`);
    const later = readdirSync(join(root, "supabase/migrations"))
      .filter((name) => name.endsWith(".sql") && name > migration)
      .filter((name) => scanFunctionEvents(read(`supabase/migrations/${name}`))
        .some((event) => event.signature === signature));
    expect(later).toEqual([]);
  });

  it("rollback drops the trigger, helper and index, and never a column", () => {
    expect(rollback).toContain("drop trigger if exists merge_pending_drawing_extraction on public.work_queue;");
    expect(rollback).toContain("drop function if exists private.merge_pending_drawing_extraction();");
    expect(rollback).toContain("drop index if exists public.work_queue_one_active_extract_per_part;");
    expect(rollback).not.toMatch(/\bdrop\s+column\b/i);
  });

  it("applies without a wrapping transaction: no top-level LOCK TABLE", () => {
    const outsideBodies = forward.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(outsideBodies).not.toMatch(/\block\s+table\b/i);
    expect(forward).toMatch(/DO \$\$\s*BEGIN\s*LOCK TABLE public\.work_queue IN SHARE ROW EXCLUSIVE MODE;/);
  });

  it("keeps running attempts identifiable and the settlement helper an invoker", () => {
    const request = forward.slice(forward.indexOf("FUNCTION public.api_request_extraction"), forward.indexOf("FUNCTION private.merge_pending_drawing_extraction"));
    expect(request).not.toMatch(/attempt_id\s*=\s*NULL/i);
    expect(request).not.toMatch(/\bFOR UPDATE\b/);
    const helper = forward.slice(forward.indexOf("FUNCTION private.merge_pending_drawing_extraction"), forward.indexOf("CREATE OR REPLACE TRIGGER"));
    expect(helper).toContain("SECURITY INVOKER");
    expect(helper).not.toContain("SECURITY DEFINER");
    expect(helper).toContain("AND NOT (NEW.payload ? 'pendingDrawingFileId')");
  });
});
