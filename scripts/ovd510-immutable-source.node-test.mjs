import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { withImmutableSource } from "./ovd510-immutable-source.mjs";

const scripts = fileURLToPath(new URL(".", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ovd510-source-test-"));
  mkdirSync(join(root, "scripts"));
  for (const name of readdirSync(scripts).filter((name) => name.endsWith(".mjs"))) {
    writeFileSync(join(root, "scripts", name), readFileSync(join(scripts, name)));
  }
  writeFileSync(join(root, "fixture.sql"), "select 1;\n");
  writeFileSync(join(root, "scripts/read-fixture.mjs"), `import { readFileSync } from 'node:fs';
    export const query = () => readFileSync(new URL('../fixture.sql', import.meta.url), 'utf8');`);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"], { cwd: root });
  return root;
}

test("dirty source is rejected before even the first Docker operation", () => {
  const root = fixture();
  const hook = join(root, "intercept.mjs");
  const marker = join(root, "docker-was-called");
  try {
    writeFileSync(join(root, "scripts/ovd510-catalog-sql.mjs"), "export const catalogSql = 'select 999';\n");
    writeFileSync(hook, `import cp from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = cp.spawnSync;
      cp.spawnSync = (command, ...args) => {
        if (String(command).endsWith('/docker')) {
          writeFileSync(${JSON.stringify(marker)}, 'called');
          return { status: 1, stderr: 'fixture intercepted; no Docker executed' };
        }
        return original(command, ...args);
      };
      syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--import", hook, "scripts/ovd510-disposable-replay.mjs", "--ovd570-minimal-112"], {
      cwd: root, encoding: "utf8", timeout: 20_000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false, "mutable SQL source reached Docker before source admission");
    assert.match(result.stderr, /immutable_source_requires_clean_checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("later checkout edits cannot alter exported SQL or imported helpers; inventory binds both", async () => {
  const repositoryRoot = fixture();
  let exported;
  try {
    await withImmutableSource(repositoryRoot, async ({ root, sourceManifest, verifySource }) => {
      exported = root;
      const expectedSql = readFileSync(join(root, "fixture.sql"));
      const expectedHelper = readFileSync(join(root, "scripts/read-fixture.mjs"));
      writeFileSync(join(repositoryRoot, "fixture.sql"), "select 999;\n");
      writeFileSync(join(repositoryRoot, "scripts/read-fixture.mjs"), "export const query = () => 'select 999';\n");
      const { query } = await import(pathToFileURL(join(root, "scripts/read-fixture.mjs")).href);
      assert.equal(query(), "select 1;\n");
      for (const [path, bytes] of [["fixture.sql", expectedSql], ["scripts/read-fixture.mjs", expectedHelper]]) {
        assert.equal(sourceManifest.files[path], createHash("sha256").update(bytes).digest("hex"));
        assert.equal(lstatSync(join(root, path)).mode & 0o222, 0);
      }
      assert.ok(sourceManifest.files["scripts/ovd510-catalog-sql.mjs"]);
      assert.ok(sourceManifest.files["scripts/ovd570-minimal-rehearsal.mjs"]);
      verifySource();
    });
    assert.equal(existsSync(exported), false);
    assert.equal(readFileSync(join(repositoryRoot, "fixture.sql"), "utf8"), "select 999;\n");
  } finally { rmSync(repositoryRoot, { recursive: true, force: true }); }
});

test("explicit tampering with the private export is rejected before acceptance and cleaned up", async () => {
  const repositoryRoot = fixture();
  let exported;
  try {
    await assert.rejects(withImmutableSource(repositoryRoot, async ({ root }) => {
      exported = root;
      chmodSync(join(root, "fixture.sql"), 0o600);
      writeFileSync(join(root, "fixture.sql"), "select 999;\n");
    }), /immutable_source_changed:fixture.sql/);
    assert.equal(existsSync(exported), false);
  } finally { rmSync(repositoryRoot, { recursive: true, force: true }); }
});
