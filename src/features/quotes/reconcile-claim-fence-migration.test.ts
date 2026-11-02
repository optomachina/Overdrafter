import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const name = "20261029165751_reconcile_claim_fence";
const read = (p: string) => readFileSync(p, "utf8");
const forward = read(`supabase/migrations/${name}.sql`);
const rollback = read(`supabase/rollbacks/${name}.rollback.sql`);

describe("S1.1b migration recovery contract", () => {
  it("keeps one forward migration and an explicit data-preserving down path", () => {
    expect(readdirSync("supabase/migrations").filter(p => p.startsWith("20261029165751")))
      .toEqual([`${name}.sql`]);
    expect(forward).toContain(`supabase/rollbacks/${name}.rollback.sql`);
    expect(rollback).not.toMatch(/\bdrop\s+table\b/i);
    expect(rollback).toContain("drop function public.drain_quote_run_rollup_followups(integer);");
    expect(rollback).toContain("drop function private.aggregate_quote_run_status(public.vendor_status[]);");
    expect(rollback).toContain("drop function public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb);");
    expect(rollback).toContain("drop function private.vendor_quote_acceptance_request_ids(uuid);");
    expect(rollback).toContain("drop function private.apply_vendor_quote_result_offers(uuid,jsonb,jsonb);");
    expect(rollback).toContain("drop trigger vendor_quote_acceptance_receipts_append_only on private.vendor_quote_acceptance_receipts;");
    expect(rollback).toContain("drop function private.reject_vendor_quote_acceptance_receipt_mutation();");
    expect(forward).toContain("create table if not exists private.vendor_quote_acceptance_receipts");
    expect(forward).toContain("create table if not exists private.quote_run_rollup_followups");
  });

  it("requires a fixed empty search path on every function and bounds RPC lock waits", () => {
    expect(forward.match(/set search_path = ''/g)).toHaveLength(6);
    expect(forward.match(/set lock_timeout = '1s'/g)).toHaveLength(2);
    expect(forward).toContain("set local lock_timeout = '1s';");
  });
});
