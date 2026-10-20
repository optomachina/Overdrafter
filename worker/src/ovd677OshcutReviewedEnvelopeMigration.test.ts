// @vitest-environment node

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerReviewedEnvelopeMigrationChecks } from "../test-support/reviewedEnvelopeMigration";
import { OSHCUT_DISPATCH_ENVELOPE } from "./providerDispatchEnvelope";

const PENDING_PGTAP = new URL("../../supabase/tests/pending/ovd677_oshcut_reviewed_envelope.sql.pending", import.meta.url);
const ACTIVE_PGTAP = new URL("../../supabase/tests/ovd677_oshcut_reviewed_envelope.sql", import.meta.url);

// The migration is a draft (docs/migration-drafts) pending a Blaine-approved window.
describe("OVD-677 OSH Cut reviewed dispatch envelope migration (draft)", () => {
  // Promotion moves the pgTAP out of pending/ together with the migration; this
  // check and `draft: true` below are removed in that same change.
  it("keeps the pgTAP checks pending until the migration is promoted", () => {
    expect(existsSync(PENDING_PGTAP)).toBe(true);
    expect(existsSync(ACTIVE_PGTAP)).toBe(false);
  });

  registerReviewedEnvelopeMigrationChecks({
    provider: "oshcut",
    envelope: OSHCUT_DISPATCH_ENVELOPE,
    migration: "20261015084957_ovd677_oshcut_reviewed_dispatch_envelope.sql",
    evidence: "OVD-677",
    draft: true,
    afterMigrations: [
      "20261003160000_ovd458_generic_provider_dispatch_permits.sql",
      "20261004130000_ovd628_generic_admission_nowait.sql",
      "20261011180000_ovd673_fictiv_reviewed_dispatch_envelope.sql",
      "20261011190000_ovd674_quickparts_reviewed_dispatch_envelope.sql",
      "20261011200000_ovd675_weerg_reviewed_dispatch_envelope.sql",
      "20261015074957_ovd736_revoke_anon_definer_execute.sql",
    ],
    untouchedProviders: ["xometry", "fictiv", "quickparts", "weerg"],
  });
});
