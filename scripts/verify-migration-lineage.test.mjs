import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectMigrationLineage,
  RETIRED_LINEAGE_ALIASES,
} from "./verify-migration-lineage.mjs";

async function makeMigrationRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "overdrafter-migrations-"));
  const migrationRoot = path.join(root, "migrations");
  await mkdir(migrationRoot);
  return migrationRoot;
}

describe("Supabase migration lineage", () => {
  it("accepts an exact canonical statement payload", async () => {
    const migrationRoot = await makeMigrationRoot();
    const contents = Buffer.from("select 1;\n");
    const expected = {
      filename: "20260816000000_example.sql",
      bytes: contents.byteLength,
      sha256: "4a45092ccf992ea92250053a80b931b787924ba61648f420555511b84f10ab6c",
    };
    await writeFile(path.join(migrationRoot, expected.filename), contents);

    expect(await inspectMigrationLineage(migrationRoot, [expected])).toEqual([]);
  });

  it("rejects a canonical filename with different bytes", async () => {
    const migrationRoot = await makeMigrationRoot();
    const expected = {
      filename: "20260816000000_example.sql",
      bytes: 10,
      sha256: "4a45092ccf992ea92250053a80b931b787924ba61648f420555511b84f10ab6c",
    };
    await writeFile(path.join(migrationRoot, expected.filename), "select 2;\n");

    const violations = await inspectMigrationLineage(migrationRoot, [expected]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("expected SHA-256");
  });

  it("rejects a retired timestamp alias", async () => {
    const migrationRoot = await makeMigrationRoot();
    const retiredFilename = [...RETIRED_LINEAGE_ALIASES][0];
    await writeFile(path.join(migrationRoot, retiredFilename), "select 1;\n");

    const violations = await inspectMigrationLineage(migrationRoot, []);

    expect(violations).toContain(
      `${retiredFilename}: retired migration alias is present`,
    );
  });

  it("rejects duplicate migration versions", async () => {
    const migrationRoot = await makeMigrationRoot();
    await writeFile(
      path.join(migrationRoot, "20260816000000_first.sql"),
      "select 1;\n",
    );
    await writeFile(
      path.join(migrationRoot, "20260816000000_second.sql"),
      "select 2;\n",
    );

    const violations = await inspectMigrationLineage(migrationRoot, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("duplicate migration version");
  });

  it("accepts the repository's legacy UUID-style migration name", async () => {
    const migrationRoot = await makeMigrationRoot();
    await writeFile(
      path.join(
        migrationRoot,
        "20251106035356_483321a4-d45c-47bd-bdae-71625fcdec1a.sql",
      ),
      "select 1;\n",
    );

    expect(await inspectMigrationLineage(migrationRoot, [])).toEqual([]);
  });

  it("fails closed on a migration symlink", async () => {
    const migrationRoot = await makeMigrationRoot();
    const target = path.join(migrationRoot, "target.txt");
    await writeFile(target, "select 1;\n");
    await symlink(target, path.join(migrationRoot, "20260816000000_link.sql"));

    const violations = await inspectMigrationLineage(migrationRoot, []);

    expect(violations).toEqual([
      "20260816000000_link.sql: migration must be a regular file",
    ]);
  });
});
