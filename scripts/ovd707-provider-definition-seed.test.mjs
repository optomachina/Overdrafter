// @vitest-environment node

// OVD-707: the providers-as-data seed draft is generated from the provider
// registry and manifests. Pin it so a registry change cannot leave the seed
// silently stale before the draft is promoted. Decided (Q4): only the
// liveAdapter: true entries are seeded, as approved, never active.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const SEED_ROW = /\('([a-z][a-z0-9]{1,49})', '((?:[^']|'')*)', '(portal|api|email|manual)', '([A-Z]{3})', array\[([^\]]*)\]::text\[\], (null|'[A-Z][A-Z0-9_]*'),\s*'((?:[^']|'')*)'::jsonb\)/g;

function parseSeedRows(sql) {
  return [...sql.matchAll(SEED_ROW)].map(([, slug, displayName, kind, currency, hosts, credentialRef, admission]) => ({
    slug,
    displayName: displayName.replaceAll("''", "'"),
    kind,
    currency,
    hosts: [...hosts.matchAll(/'([^']+)'/g)].map((match) => match[1]),
    credentialRef: credentialRef === "null" ? null : credentialRef.slice(1, -1),
    admission: JSON.parse(admission.replaceAll("''", "'")),
  }));
}

function expectedKind(adapterKind) {
  if (adapterKind === "api") return "api";
  return adapterKind.endsWith("_portal") ? "portal" : "manual";
}

describe("OVD-707 provider definition seed draft", () => {
  const registry = JSON.parse(read("provider-integrations/provider-registry.v1.json"));
  const seedSql = read("docs/migration-drafts/ovd-707-b-seed.sql");
  const rows = parseSeedRows(seedSql);
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const liveEntries = registry.providers.filter((entry) => entry.liveAdapter === true);

  it("seeds exactly the liveAdapter: true registry providers, once each", () => {
    expect(liveEntries.length).toBeGreaterThan(0);
    expect(rows.length).toBe(bySlug.size);
    expect([...bySlug.keys()].sort()).toEqual(liveEntries.map((entry) => entry.key).sort());
    expect(bySlug.has("xometry")).toBe(true);
    for (const row of rows) {
      expect(row.admission.liveAdapter).toBe(true);
    }
  });

  it("keeps default-off OSH Cut out of the approved seed and pending expectations", () => {
    expect(bySlug.has("oshcut")).toBe(false);
    expect(seedSql).not.toContain("OSHCUT_STORAGE_STATE");
    const pending = read("supabase/tests/pending/ovd707_b_lifecycle.sql.pending");
    expect(pending).toContain("array['fictiv', 'quickparts', 'weerg', 'xometry']");
  });

  it("copies each registry entry verbatim as the admission object", () => {
    for (const entry of liveEntries) {
      expect(bySlug.get(entry.key)?.admission).toEqual(entry);
    }
  });

  it("seeds approved without a dry run, never active", () => {
    expect(seedSql).toMatch(/set status = 'approved',/);
    expect(seedSql).not.toMatch(/status = 'active'/);
    expect(seedSql).not.toMatch(/dry_run_passed_version\s*=/);
  });

  it("takes name, kind and host allowlist from the manifest, and a secret name only", () => {
    for (const entry of liveEntries) {
      const manifest = JSON.parse(read(`provider-integrations/${entry.key}/manifest.v1.json`));
      const row = bySlug.get(entry.key);
      expect(row.displayName).toBe(manifest.displayName);
      expect(row.kind).toBe(expectedKind(manifest.integration.adapterKind));
      expect(row.hosts).toEqual([...manifest.official.domains].sort());
      expect(row.credentialRef).toBe(entry.sessionSecrets[0]?.secretNameEnv ?? null);
      if (row.credentialRef !== null) {
        expect(row.credentialRef).toMatch(/^[A-Z][A-Z0-9_]{0,100}_SECRET_NAME$/);
      }
    }
  });

  it("stays a draft: nothing for OVD-707 lives in supabase/migrations", () => {
    const migrations = fs.readdirSync(path.join(root, "supabase/migrations"));
    for (const name of migrations) {
      expect(read(`supabase/migrations/${name}`)).not.toMatch(/provider_definitions|provider_audit_log/);
    }
  });
});
