/** Offline lineage messages only. Never applies or rewrites migrations. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectMigrationLineage } from "./verify-migration-lineage.mjs";

async function makeMigrationRoot() {
  const root = await mkdtemp(join(tmpdir(), "ovd689-lineage-"));
  const migrationRoot = join(root, "migrations");
  await mkdir(migrationRoot);
  return migrationRoot;
}

test("lineage fails on duplicate timestamps and names both files plus the next free timestamp", async () => {
  const migrationRoot = await makeMigrationRoot();
  await writeFile(join(migrationRoot, "20261011180000_first.sql"), "select 1;\n");
  await writeFile(join(migrationRoot, "20261011180000_second.sql"), "select 2;\n");
  const now = new Date("2026-10-12T00:00:00Z");
  const violations = await inspectMigrationLineage(migrationRoot, [], { now });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /20261011180000: duplicate migration version in 20261011180000_first\.sql, 20261011180000_second\.sql/);
  assert.match(violations[0], /next free timestamp is 20261012000000/);
});

test("lineage fails on a malformed name and reports the next free timestamp", async () => {
  const migrationRoot = await makeMigrationRoot();
  await writeFile(join(migrationRoot, "not-a-migration.sql"), "select 1;\n");
  await writeFile(join(migrationRoot, "20261011180000_ok.sql"), "select 1;\n");
  const now = new Date("2026-10-12T00:00:00Z");
  const violations = await inspectMigrationLineage(migrationRoot, [], { now });
  assert.ok(violations.some((violation) => (
    violation.includes("not-a-migration.sql: invalid migration filename")
    && violation.includes("next free timestamp is 20261012000000")
  )));
});

test("lineage fails when a new migration sorts before the merge-base head", async () => {
  const migrationRoot = await makeMigrationRoot();
  await writeFile(join(migrationRoot, "20261011170000_old.sql"), "select 1;\n");
  await writeFile(join(migrationRoot, "20261011180000_main.sql"), "select 1;\n");
  const now = new Date("2026-10-12T00:00:00Z");
  const violations = await inspectMigrationLineage(migrationRoot, [], {
    now,
    baseFilenames: ["20261011180000_main.sql"],
  });
  assert.ok(violations.some((violation) => (
    violation.includes("20261011170000_old.sql sorts before merge-base head 20261011180000_main.sql")
    && violation.includes("next free timestamp is 20261012000000")
  )));
});
