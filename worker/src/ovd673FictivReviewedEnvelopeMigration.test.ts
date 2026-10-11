// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FICTIV_DISPATCH_ENVELOPE, REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "./providerDispatchEnvelope";
import { VENDOR_TASK_RETRY_DELAYS_MS } from "./vendorTaskRetry";

const MIGRATIONS_DIR = new URL("../../supabase/migrations/", import.meta.url);
const MIGRATION = "20261010120000_ovd673_fictiv_reviewed_dispatch_envelope.sql";

function statements(name: string) {
  return readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

describe("OVD-673 Fictiv reviewed dispatch envelope migration", () => {
  const sql = statements(MIGRATION);

  it("records exactly the envelope revision the worker reviews in code", () => {
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES).toContainEqual({
      provider: "fictiv",
      id: FICTIV_DISPATCH_ENVELOPE.id,
      version: FICTIV_DISPATCH_ENVELOPE.version,
      requiredAdmission: "generic_dispatch",
    });
    expect(sql).toContain("insert into private.provider_dispatch_envelope_reviews");
    expect(sql).toContain(
      `'fictiv'::public.vendor_name, '${FICTIV_DISPATCH_ENVELOPE.id}', ${FICTIV_DISPATCH_ENVELOPE.version}, 'ovd-673', 7200`,
    );
  });

  it("keeps permits alive across a full task ahead plus the whole retry schedule", () => {
    const retryWindowMs = VENDOR_TASK_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
    const longestTaskAheadMs = 3600 * 1000;
    expect(7200 * 1000).toBeGreaterThan(longestTaskAheadMs + retryWindowMs);
  });

  it("is idempotent against an existing active Fictiv review", () => {
    expect(sql).toContain("where not exists");
    expect(sql).toContain("review.withdrawn_at is null");
  });

  it("never admits Fictiv, enables generic dispatch, or touches rollout or other providers", () => {
    for (const forbidden of [
      "quote_provider_admission_policies",
      "generic_dispatch_enabled",
      "approved",
      "commercial_rollout_controls",
      "update ",
      "delete ",
      "xometry",
      "grant ",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("is ordered after the generic permit and preflight migrations it depends on", () => {
    const migrations = readdirSync(MIGRATIONS_DIR).sort();
    const index = migrations.indexOf(MIGRATION);
    expect(index).toBeGreaterThan(migrations.indexOf("20261003160000_ovd458_generic_provider_dispatch_permits.sql"));
    expect(index).toBeGreaterThan(migrations.indexOf("20261004130000_ovd628_generic_admission_nowait.sql"));
  });
});
