import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_PATH, MIGRATION_ROOT, PRE_CHECK_PATH, SUFFIX_PATH, AUTHORIZATION_PATH, verifyOvd635LedgerManifest } from "./verify-ovd635-ledger-manifest.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let scratch;

function copyRepoSubset() {
  scratch = mkdtempSync(path.join(tmpdir(), "ovd635-"));
  const suffix = JSON.parse(readFileSync(path.join(repo, SUFFIX_PATH), "utf8"));
  const rollbacks = suffix.migrations.map((entry) => entry.rollback);
  for (const relative of [MANIFEST_PATH, PRE_CHECK_PATH, SUFFIX_PATH, AUTHORIZATION_PATH, MIGRATION_ROOT, ...rollbacks]) {
    cpSync(path.join(repo, relative), path.join(scratch, relative), { recursive: true });
  }
  return scratch;
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("OVD-635 ledger manifest", () => {
  it("matches the repository migrations and the pre-check SQL", () => {
    expect(verifyOvd635LedgerManifest(repo)).toEqual([]);
  });

  it("admits a later migration after the frozen suffix", () => {
    const root = copyRepoSubset();
    writeFileSync(path.join(root, MIGRATION_ROOT, "29991231235959_later.sql"), "select 1;\n");
    expect(verifyOvd635LedgerManifest(root)).toEqual([]);
  });

  it("rejects an edited frozen migration", () => {
    const root = copyRepoSubset();
    const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
    const target = path.join(root, MIGRATION_ROOT, manifest.migrations[10].file);
    writeFileSync(target, `${readFileSync(target, "utf8")}\n-- drift\n`);
    expect(verifyOvd635LedgerManifest(root)).toEqual([`${manifest.migrations[10].file}: sha256 drifted`]);
  });

  it("rejects a migration inserted inside the frozen prefix", () => {
    const root = copyRepoSubset();
    writeFileSync(path.join(root, MIGRATION_ROOT, "20200101000000_inserted.sql"), "select 1;\n");
    expect(verifyOvd635LedgerManifest(root)[0]).toMatch(/^position 1: expected .*, found 20200101000000_inserted\.sql$/);
  });

  it("rejects a pre-check that drops a version", () => {
    const root = copyRepoSubset();
    const sql = readFileSync(path.join(root, PRE_CHECK_PATH), "utf8");
    writeFileSync(path.join(root, PRE_CHECK_PATH), sql.replace(/^\s+\('20261016013832'\)\n/m, ""));
    expect(verifyOvd635LedgerManifest(root)).toContain("pre-check versions differ from the manifest");
  });

  it("rejects a migration inserted between the baseline and the suffix", () => {
    const root = copyRepoSubset();
    writeFileSync(path.join(root, MIGRATION_ROOT, "20261020000000_inserted.sql"), "select 1;\n");
    expect(verifyOvd635LedgerManifest(root)[0]).toMatch(/^suffix position 1: expected .*, found 20261020000000_inserted\.sql$/);
  });

  it("rejects an edited suffix rollback", () => {
    const root = copyRepoSubset();
    const suffix = JSON.parse(readFileSync(path.join(root, SUFFIX_PATH), "utf8"));
    const target = path.join(root, suffix.migrations[0].rollback);
    writeFileSync(target, `${readFileSync(target, "utf8")}\n-- drift\n`);
    expect(verifyOvd635LedgerManifest(root)).toEqual([`${suffix.migrations[0].rollback}: rollback sha256 drifted`]);
  });
});
