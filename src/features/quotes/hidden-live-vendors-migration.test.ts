import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const enumMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260514120000_add_hidden_live_quote_vendor_candidates.sql",
);
const enumMigrationSql = readFileSync(enumMigrationPath, "utf8");
const normalizedEnumSql = enumMigrationSql.toLowerCase();
const seedMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260514120100_seed_hidden_live_quote_vendor_capabilities.sql",
);
const seedMigrationSql = readFileSync(seedMigrationPath, "utf8");
const normalizedSeedSql = seedMigrationSql.toLowerCase();

const hiddenVendorNames = [
  "oshcut",
  "fabworks",
  "ponoko",
  "quickparts",
  "rapiddirect",
  "geomiq",
  "weerg",
  "protolabsnetwork",
];

describe("hidden live quote vendor candidates migration", () => {
  it("adds every requested hidden vendor to the vendor_name enum", () => {
    for (const vendor of hiddenVendorNames) {
      expect(normalizedEnumSql).toContain(`alter type public.vendor_name add value if not exists '${vendor}'`);
    }
  });

  it("seeds capability profiles without enabling client quote fan-out", () => {
    expect(normalizedSeedSql).toContain("insert into public.vendor_capability_profiles");

    for (const vendor of hiddenVendorNames) {
      expect(normalizedSeedSql).toContain(`'${vendor}'`);
    }

    expect(normalizedEnumSql).not.toContain("insert into public.vendor_capability_profiles");
    expect(normalizedSeedSql).not.toContain("insert into public.org_vendor_configs");
    expect(normalizedSeedSql).not.toContain("create or replace function public.get_enabled_client_quote_vendors");
  });
});
