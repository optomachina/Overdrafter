// @vitest-environment node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

async function readMigration(suffix) {
  const matching = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith(suffix));
  expect(matching).toHaveLength(1);
  return {
    name: matching[0],
    sql: await fs.readFile(path.join(migrationsDir, matching[0]), "utf8"),
  };
}

describe("RMFG source-only identity", () => {
  it("commits the enum before a separate disabled admission seed", async () => {
    const enumMigration = await readMigration("_add_rmfg_vendor_name.sql");
    const policyMigration = await readMigration("_seed_rmfg_disabled_admission.sql");

    expect(enumMigration.name < policyMigration.name).toBe(true);
    expect(enumMigration.sql).toMatch(/alter type public\.vendor_name add value if not exists 'rmfg';/i);
    expect(enumMigration.sql).not.toMatch(/quote_provider_admission_policies/i);
    expect(policyMigration.sql).toMatch(/insert into private\.quote_provider_admission_policies/i);
    expect(policyMigration.sql).toMatch(/'rmfg'::public\.vendor_name/i);
    expect(policyMigration.sql).toMatch(/on conflict \(provider\) do nothing/i);
    expect(policyMigration.sql).not.toMatch(/\b(?:grant|create policy|alter table)\b/i);
  });
});
