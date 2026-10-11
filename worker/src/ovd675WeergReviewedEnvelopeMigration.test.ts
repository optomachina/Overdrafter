// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES, WEERG_DISPATCH_ENVELOPE } from "./providerDispatchEnvelope";
import { VENDOR_TASK_RETRY_DELAYS_MS } from "./vendorTaskRetry";

const MIGRATIONS_DIR = new URL("../../supabase/migrations/", import.meta.url);
const MIGRATION = "20261011120000_ovd675_weerg_reviewed_dispatch_envelope.sql";

function statements(name: string) {
  return readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

describe("OVD-675 Weerg reviewed dispatch envelope migration", () => {
  const sql = statements(MIGRATION);

  it("records exactly the envelope revision the worker reviews in code", () => {
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES).toContainEqual({
      provider: "weerg",
      id: WEERG_DISPATCH_ENVELOPE.id,
      version: WEERG_DISPATCH_ENVELOPE.version,
      requiredAdmission: "generic_dispatch",
    });
    expect(sql).toContain("insert into private.provider_dispatch_envelope_reviews");
    expect(sql).toContain(
      `'weerg'::public.vendor_name, '${WEERG_DISPATCH_ENVELOPE.id}', ${WEERG_DISPATCH_ENVELOPE.version}, 'ovd-675', 7200`,
    );
  });

  it("keeps permits alive across a full task ahead plus the whole retry schedule", () => {
    const retryWindowMs = VENDOR_TASK_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
    expect(7200 * 1000).toBeGreaterThan(3600 * 1000 + retryWindowMs);
  });

  it("is idempotent against an existing active Weerg review", () => {
    expect(sql).toContain("where not exists");
    expect(sql).toContain("review.provider = 'weerg'::public.vendor_name");
    expect(sql).toContain("review.withdrawn_at is null");
  });

  it("never admits Weerg, enables generic dispatch, or touches rollout or other providers", () => {
    for (const forbidden of [
      "quote_provider_admission_policies",
      "generic_dispatch_enabled",
      "approved",
      "commercial_rollout_controls",
      "update ",
      "delete ",
      "xometry",
      "fictiv",
      "quickparts",
      "grant ",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("is ordered after the generic permit migrations and the reviews it parallels", () => {
    const migrations = readdirSync(MIGRATIONS_DIR).sort();
    const index = migrations.indexOf(MIGRATION);
    expect(index).toBeGreaterThan(migrations.indexOf("20261003160000_ovd458_generic_provider_dispatch_permits.sql"));
    expect(index).toBeGreaterThan(migrations.indexOf("20261004130000_ovd628_generic_admission_nowait.sql"));
    expect(index).toBeGreaterThan(migrations.indexOf("20261010120000_ovd673_fictiv_reviewed_dispatch_envelope.sql"));
    expect(index).toBeGreaterThan(migrations.indexOf("20261010130000_ovd674_quickparts_reviewed_dispatch_envelope.sql"));
    expect(index).toBe(migrations.length - 1);
  });
});
