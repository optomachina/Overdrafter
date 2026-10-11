/** Offline timestamp allocation only. Never writes SQL or contacts a database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_MIGRATION_BASE_REF,
  GIT_BIN,
  MissingMigrationBaseRefError,
  formatMigrationTimestamp,
  incrementMigrationTimestamp,
  latestMigrationTimestamp,
  listRefMigrationFilenames,
  main,
  migrationFilename,
  nextMigrationFilename,
  nextMigrationTimestamp,
  parseMigrationTimestamp,
} from "./migration-timestamp.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function tempDir(t, prefix = "migration-ts-") {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(chunk) { stdout += chunk; return true; } },
    stderr: { write(chunk) { stderr += chunk; return true; } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

test("nextMigrationTimestamp is deterministic with an injected clock", () => {
  const now = new Date("2026-10-12T15:04:05Z");
  const timestamp = nextMigrationTimestamp({
    now,
    localFilenames: ["20260101000000_base.sql"],
    refFilenames: ["20260101000000_base.sql"],
  });
  assert.equal(timestamp, "20261012150405");
  assert.equal(formatMigrationTimestamp(now), "20261012150405");
});

test("nextMigrationTimestamp is monotonic and collision-free versus a fake main list", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const main = ["20261011180000_ovd673_fictiv_reviewed_dispatch_envelope.sql"];
  const first = nextMigrationTimestamp({ now, localFilenames: main, refFilenames: main });
  assert.equal(first, "20261011180001");
  const second = nextMigrationTimestamp({
    now,
    localFilenames: [...main, `${first}_branch_a.sql`],
    refFilenames: main,
  });
  assert.equal(second, "20261011180002");
  assert.ok(second > first);
  assert.equal(incrementMigrationTimestamp("20261011235959"), "20261012000000");
});

test("nextMigrationFilename only returns a name", () => {
  const name = nextMigrationFilename({
    slug: "ovd689_demo",
    now: new Date("2026-10-12T00:00:00Z"),
    localFilenames: ["20261011180000_existing.sql"],
    refFilenames: ["20261011180000_existing.sql"],
  });
  assert.equal(name, "20261012000000_ovd689_demo.sql");
  assert.equal(parseMigrationTimestamp(name), "20261012000000");
  assert.equal(migrationFilename("20261012000000", "ovd689_demo"), name);
});

test("CLI prints only the filename and never writes a migration", (t) => {
  const cwd = tempDir(t);
  mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
  writeFileSync(join(cwd, "supabase/migrations/20260101000000_base.sql"), "select 1;\n");
  execFileSync(GIT_BIN, ["init", "-q"], { cwd });
  execFileSync(GIT_BIN, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "add", "."], { cwd });
  execFileSync(GIT_BIN, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base"], { cwd });
  execFileSync(GIT_BIN, ["branch", "-M", "main"], { cwd });
  execFileSync(GIT_BIN, ["update-ref", `refs/remotes/${DEFAULT_MIGRATION_BASE_REF}`, "HEAD"], { cwd });

  const io = capture();
  const code = main(["ovd689_cli"], { cwd, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0, io.stderrText);
  assert.match(io.stdoutText.trim(), /^\d{14}_ovd689_cli\.sql$/);
  assert.equal(io.stderrText, "");
  assert.deepEqual(
    readdirSync(join(cwd, "supabase/migrations")),
    ["20260101000000_base.sql"],
  );
});

test("CLI refuses a missing slug and does not write files", () => {
  const io = capture();
  assert.equal(main([], { cwd: root, stdout: io.stdout, stderr: io.stderr }), 1);
  assert.match(io.stderrText, /Usage: npm run migration:next/);
});

test("listRefMigrationFilenames fails closed when the base ref is missing", (t) => {
  const cwd = tempDir(t);
  mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
  execFileSync(GIT_BIN, ["init", "-q"], { cwd });
  assert.throws(
    () => listRefMigrationFilenames(cwd, "origin/main"),
    MissingMigrationBaseRefError,
  );
});

test("latestMigrationTimestamp ignores malformed names", () => {
  assert.equal(latestMigrationTimestamp(["notes.txt", "20261011180000_ok.sql"]), "20261011180000");
  assert.equal(latestMigrationTimestamp([]), null);
});
