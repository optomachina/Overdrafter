// @vitest-environment node

import { describe } from "vitest";
import { registerReviewedEnvelopeMigrationChecks } from "../test-support/reviewedEnvelopeMigration";
import { QUICKPARTS_DISPATCH_ENVELOPE } from "./providerDispatchEnvelope";

describe("OVD-674 Quickparts reviewed dispatch envelope migration", () => {
  registerReviewedEnvelopeMigrationChecks({
    provider: "quickparts",
    envelope: QUICKPARTS_DISPATCH_ENVELOPE,
    migration: "20261011190000_ovd674_quickparts_reviewed_dispatch_envelope.sql",
    evidence: "OVD-674",
    afterMigrations: [
      "20261003160000_ovd458_generic_provider_dispatch_permits.sql",
      "20261004130000_ovd628_generic_admission_nowait.sql",
      "20261010100000_ovd631_fix_archived_job_delete_canonical_blob_constraint.sql",
      "20261011180000_ovd673_fictiv_reviewed_dispatch_envelope.sql",
    ],
    untouchedProviders: ["xometry", "fictiv"],
  });
});
