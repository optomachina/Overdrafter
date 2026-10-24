import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const enumMigration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260725100000_add_emachineshop_instant_quote_vendor.sql",
  ),
  "utf8",
).toLowerCase();

const capabilityMigration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260725100100_seed_emachineshop_vendor_capabilities.sql",
  ),
  "utf8",
).toLowerCase();

describe("eMachineShop instant quote vendor migrations", () => {
  it("registers the provider and waterjet process without enabling default fan-out", () => {
    expect(enumMigration).toContain(
      "alter type public.vendor_name add value if not exists 'emachineshop'",
    );
    expect(enumMigration).toContain(
      "alter type public.process_types add value if not exists 'waterjet_cutting'",
    );
    expect(enumMigration).not.toContain("insert into public.org_vendor_configs");
    expect(enumMigration).not.toContain("update public.org_vendor_configs");
  });

  it("seeds only documented instant-quote service families", () => {
    expect(capabilityMigration).toContain("'emachineshop'");
    for (const process of [
      "cnc_milling",
      "cnc_turning",
      "laser_cutting",
      "waterjet_cutting",
      "sheet_metal",
      "injection_molding",
      "3d_printing",
    ]) {
      expect(capabilityMigration).toContain(`'${process}'`);
    }
    expect(capabilityMigration).not.toContain("'welding'");
  });

  it("documents the operational rollback boundary", () => {
    expect(enumMigration).toContain("-- rollback:");
    expect(capabilityMigration).toContain("-- rollback:");
  });
});
