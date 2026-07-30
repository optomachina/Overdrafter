import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260725090000_add_supplier_directory_foundation.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.toLowerCase();

const directoryTables = [
  "supplier_companies",
  "supplier_sources",
  "supplier_source_records",
  "supplier_company_aliases",
  "supplier_facilities",
  "supplier_capabilities",
  "supplier_certifications",
  "supplier_facility_capability_claims",
  "supplier_facility_certification_claims",
  "supplier_verification_events",
];

describe("supplier directory foundation migration", () => {
  it("creates normalized company, facility, evidence, claim, and verification tables", () => {
    for (const table of directoryTables) {
      expect(normalizedSql).toContain(`create table public.${table}`);
    }
  });

  it("keeps company identity separate from physical facilities", () => {
    expect(normalizedSql).toContain(
      "supplier_company_id uuid not null references public.supplier_companies(id)",
    );
    expect(normalizedSql).toContain("latitude numeric(9, 6)");
    expect(normalizedSql).toContain("longitude numeric(9, 6)");
    expect(normalizedSql).toContain("commercial_availability");
  });

  it("preserves dated source evidence and deterministic import identity", () => {
    expect(normalizedSql).toContain("effective_date date");
    expect(normalizedSql).toContain("content_sha256 text");
    expect(normalizedSql).toContain("record_sha256 text not null");
    expect(normalizedSql).toContain("raw_record jsonb not null");
    expect(normalizedSql).toContain("unique (source_id, record_sha256)");
  });

  it("models capability and certification claims with verification state", () => {
    expect(normalizedSql).toContain(
      "verification_status text not null default 'unverified'",
    );
    expect(normalizedSql).toContain(
      "source_record_id uuid references public.supplier_source_records(id)",
    );
    expect(normalizedSql).toContain("observed_at date");
    expect(normalizedSql).toContain("effective_from date");
    expect(normalizedSql).toContain("effective_to date");
  });

  it("requires each verification event to target exactly one entity", () => {
    expect(normalizedSql).toContain("num_nonnulls(");
    expect(normalizedSql).toContain("capability_claim_id");
    expect(normalizedSql).toContain("certification_claim_id");
    expect(normalizedSql).toContain(") = 1");
  });

  it("distinguishes customer suggestions without opening canonical client writes", () => {
    expect(normalizedSql).toContain("'customer_suggested'");
    expect(normalizedSql).toContain(
      "suggested_by uuid references auth.users(id) on delete set null",
    );

    for (const table of directoryTables) {
      expect(normalizedSql).toContain(
        `alter table public.${table} enable row level security`,
      );
    }

    expect(normalizedSql).not.toContain("customer_suggested_insert");
    expect(normalizedSql).not.toContain("to anon");
  });

  it("uses internal-only policies for canonical records and claims", () => {
    expect(normalizedSql).toContain("supplier_companies_internal_access");
    expect(normalizedSql).toContain("supplier_facilities_internal_access");
    expect(normalizedSql).toContain(
      "supplier_facility_capability_claims_internal_access",
    );
    expect(normalizedSql).toContain(
      "supplier_verification_events_internal_access",
    );
    expect(normalizedSql).toContain("public.is_internal_user_any_org()");
  });

  it("does not change instant quote vendor contracts", () => {
    expect(normalizedSql).not.toContain("alter type public.vendor_name");
    expect(normalizedSql).not.toContain("insert into public.vendor_capability_profiles");
    expect(normalizedSql).not.toContain("alter table public.quote_runs");
    expect(normalizedSql).not.toContain("alter table public.vendor_quote_results");
  });

  it("documents the rollback boundary", () => {
    expect(normalizedSql).toContain("-- rollback:");
    expect(normalizedSql).toContain("drop these tables in reverse dependency order");
  });
});
