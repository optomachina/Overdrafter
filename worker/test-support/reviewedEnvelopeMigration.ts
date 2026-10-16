import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "../src/providerDispatchEnvelope.js";
import { VENDOR_TASK_RETRY_DELAYS_MS } from "../src/vendorTaskRetry.js";

const MIGRATIONS_DIR = new URL("../../supabase/migrations/", import.meta.url);
const DRAFTS_DIR = new URL("../../docs/migration-drafts/", import.meta.url);

export type ReviewedEnvelopeMigrationSpec = {
  provider: string;
  envelope: { id: string; version: number };
  migration: string;
  evidence: string;
  afterMigrations: readonly string[];
  untouchedProviders: readonly string[];
  /**
   * The migration is a draft in docs/migration-drafts awaiting a Blaine-approved
   * window. It must not be in supabase/migrations yet.
   */
  draft?: boolean;
};

function statements(name: string, dir: URL) {
  return readFileSync(new URL(name, dir), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Shared proofs for a reviewed-envelope migration. Specs are data, not copied
 * `it` bodies, so stacked provider PRs do not reintroduce the same 60-line
 * clone that Sonar rejects on new code.
 */
export function registerReviewedEnvelopeMigrationChecks(spec: ReviewedEnvelopeMigrationSpec) {
  const sql = statements(spec.migration, spec.draft ? DRAFTS_DIR : MIGRATIONS_DIR);
  const evidence = spec.evidence.toLowerCase();

  it("records exactly the envelope revision the worker reviews in code", () => {
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES).toContainEqual({
      provider: spec.provider,
      id: spec.envelope.id,
      version: spec.envelope.version,
      requiredAdmission: "generic_dispatch",
    });
    expect(sql).toContain("insert into private.provider_dispatch_envelope_reviews");
    expect(sql).toContain(
      `'${spec.provider}'::public.vendor_name, '${spec.envelope.id}', ${spec.envelope.version}, '${evidence}', 7200`,
    );
  });

  it("keeps permits alive across a full task ahead plus the whole retry schedule", () => {
    const retryWindowMs = VENDOR_TASK_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
    expect(7200 * 1000).toBeGreaterThan(3600 * 1000 + retryWindowMs);
  });

  it("is idempotent against an existing active review for this provider", () => {
    expect(sql).toContain("where not exists");
    expect(sql).toContain(`review.provider = '${spec.provider}'::public.vendor_name`);
    expect(sql).toContain("review.withdrawn_at is null");
  });

  it("never admits the provider, enables generic dispatch, or touches rollout or other providers", () => {
    for (const forbidden of [
      "quote_provider_admission_policies",
      "generic_dispatch_enabled",
      "approved",
      "commercial_rollout_controls",
      "update ",
      "delete ",
      "grant ",
      ...spec.untouchedProviders,
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("is ordered after the generic permit migrations and any earlier review it depends on", () => {
    const applied = readdirSync(MIGRATIONS_DIR);
    if (spec.draft) {
      expect(applied).not.toContain(spec.migration);
    }
    const migrations = (spec.draft ? [...applied, spec.migration] : applied).sort();
    const index = migrations.indexOf(spec.migration);
    expect(index).toBeGreaterThan(-1);
    for (const earlier of spec.afterMigrations) {
      expect(index).toBeGreaterThan(migrations.indexOf(earlier));
    }
  });
}
