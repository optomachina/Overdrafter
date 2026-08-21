// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_APPLICABLE_VENDORS, MANUAL_IMPORT_VENDORS } from "./utils";
import { getVendorDisplayName } from "./vendor-colors";

const enumMigration = readFileSync(
  "supabase/migrations/20260821223849_add_emachineshop_manual_vendor.sql",
  "utf8",
).toLowerCase();
const configurationMigration = readFileSync(
  "supabase/migrations/20260821223851_configure_emachineshop_manual_vendor.sql",
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("eMachineShop manual vendor registration", () => {
  it("registers eMachineShop as a default manual source", () => {
    expect(enumMigration).toContain(
      "alter type public.vendor_name add value if not exists 'emachineshop'",
    );
    expect(DEFAULT_APPLICABLE_VENDORS).toContain("emachineshop");
    expect(MANUAL_IMPORT_VENDORS).toContain("emachineshop");
    expect(getVendorDisplayName("emachineshop")).toBe("eMachineShop");
    expect(configurationMigration).not.toContain("get_enabled_client_quote_vendors");
    expect(configurationMigration).toContain(
      "new.requested_vendors := array['emachineshop']::public.vendor_name[]",
    );
    expect(configurationMigration).toContain(
      "alter column requested_vendors drop default",
    );
    expect(configurationMigration).toContain(
      "manual quote requests must name exactly one vendor",
    );
    expect(configurationMigration).toContain(
      "when p_quote_mode = 'manual'::public.quote_request_mode",
    );
    expect(configurationMigration).toContain("enforce_manual_quote_result_vendor");
    expect(configurationMigration).toContain("align_manual_quote_request_audit_vendors");
    expect(configurationMigration).toContain(
      "elsif new.requested_vendors is null then new.requested_vendors := array['xometry']::public.vendor_name[]",
    );
    expect(configurationMigration).not.toContain("update public.audit_events event_row");
  });

  it("keeps automation disabled while preserving conservative recommendation data", () => {
    expect(configurationMigration).toContain(
      "'emachineshop'::public.vendor_name, 'disabled', false",
    );
    expect(configurationMigration).toContain(
      "array['cnc_milling', 'cnc_turning']::public.process_types[]",
    );
    expect(configurationMigration).toContain("array['aluminum']::text[]");
    expect(configurationMigration).not.toContain("insert into public.org_vendor_configs");
    expect(configurationMigration).not.toContain("worker_live_adapters");
    expect(configurationMigration).not.toContain("generic_dispatch_enabled, true");
  });
});
