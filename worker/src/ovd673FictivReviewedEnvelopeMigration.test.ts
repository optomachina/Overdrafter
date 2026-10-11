// @vitest-environment node

import { describe } from "vitest";
import { registerReviewedEnvelopeMigrationChecks } from "../test-support/reviewedEnvelopeMigration";
import { FICTIV_DISPATCH_ENVELOPE } from "./providerDispatchEnvelope";

describe("OVD-673 Fictiv reviewed dispatch envelope migration", () => {
  registerReviewedEnvelopeMigrationChecks({
    provider: "fictiv",
    envelope: FICTIV_DISPATCH_ENVELOPE,
    migration: "20261011180000_ovd673_fictiv_reviewed_dispatch_envelope.sql",
    evidence: "OVD-673",
    afterMigrations: [
      "20261003160000_ovd458_generic_provider_dispatch_permits.sql",
      "20261004130000_ovd628_generic_admission_nowait.sql",
    ],
    untouchedProviders: ["xometry"],
  });
});
