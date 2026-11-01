import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Exact mode is the deploy-commit check: the window's tree holds only the
// baseline and the suffix. Open PRs may add later migrations to the live repo,
// so trim the scratch copy to that window instead of asserting the repo's count.
function trimToWindow(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
  const suffix = JSON.parse(readFileSync(path.join(root, SUFFIX_PATH), "utf8"));
  const window = new Set([...manifest.migrations, ...suffix.migrations].map((entry) => entry.file));
  for (const name of readdirSync(path.join(root, MIGRATION_ROOT))) {
    if (name.endsWith(".sql") && !window.has(name)) rmSync(path.join(root, MIGRATION_ROOT, name));
  }
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

  it("rejects a later migration in exact mode", () => {
    const root = copyRepoSubset();
    trimToWindow(root);
    expect(verifyOvd635LedgerManifest(root, { exact: true })).toEqual([]);
    writeFileSync(path.join(root, MIGRATION_ROOT, "29991231235959_later.sql"), "select 1;\n");
    expect(verifyOvd635LedgerManifest(root, { exact: true })).toEqual([
      "exact: expected 162 migrations, found 163 (29991231235959_later.sql)",
    ]);
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
    writeFileSync(path.join(root, PRE_CHECK_PATH), sql.replace(/^\s+\('20261029165751'\)\n/m, ""));
    expect(verifyOvd635LedgerManifest(root)).toContain("pre-check versions differ from the manifest");
  });

  it("rejects a migration inserted between the baseline and the suffix", () => {
    const root = copyRepoSubset();
    writeFileSync(path.join(root, MIGRATION_ROOT, "20261030000000_inserted.sql"), "select 1;\n");
    expect(verifyOvd635LedgerManifest(root)[0]).toMatch(/^suffix position 1: expected .*, found 20261030000000_inserted\.sql$/);
  });

  it("rejects an edited suffix rollback", () => {
    const root = copyRepoSubset();
    const suffix = JSON.parse(readFileSync(path.join(root, SUFFIX_PATH), "utf8"));
    const target = path.join(root, suffix.migrations[0].rollback);
    writeFileSync(target, `${readFileSync(target, "utf8")}\n-- drift\n`);
    expect(verifyOvd635LedgerManifest(root)).toEqual([`${suffix.migrations[0].rollback}: rollback sha256 drifted`]);
  });

  it("rejects an authorization template that does not pin the suffix manifest", () => {
    const root = copyRepoSubset();
    const target = path.join(root, AUTHORIZATION_PATH);
    const authorization = JSON.parse(readFileSync(target, "utf8"));
    authorization.suffixManifest.sha256 = "0".repeat(64);
    writeFileSync(target, `${JSON.stringify(authorization, null, 2)}\n`);
    expect(verifyOvd635LedgerManifest(root)).toEqual(["authorization template does not pin the suffix manifest"]);
  });

  it("rejects an authorization template whose migrations differ from the suffix manifest", () => {
    const root = copyRepoSubset();
    const target = path.join(root, AUTHORIZATION_PATH);
    const authorization = JSON.parse(readFileSync(target, "utf8"));
    authorization.migrations[0].sha256 = "0".repeat(64);
    writeFileSync(target, `${JSON.stringify(authorization, null, 2)}\n`);
    expect(verifyOvd635LedgerManifest(root)).toEqual(["authorization template migrations differ from the suffix manifest"]);
  });
});
