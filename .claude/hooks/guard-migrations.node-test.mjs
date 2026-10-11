/** Offline tests for the migration write guard. A fake gh stands in for GitHub. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bashWriteTargets, decide, linearKeyFromBranch, migrationWriteTargets } from "./guard-migrations.mjs";

const hook = fileURLToPath(new URL("./guard-migrations.mjs", import.meta.url));
const repo = "/repo";
const migration = `${repo}/supabase/migrations/20260101000000_x.sql`;

const edit = (file_path) => ({ tool_name: "Edit", cwd: repo, tool_input: { file_path } });
const bash = (command) => ({ tool_name: "Bash", cwd: repo, tool_input: { command } });
const labeled = (...labels) => () => ({ ok: true, number: 7, labels });
const ghFails = () => ({ ok: false, error: "gh: command not found" });

test("migration edit is blocked when the PR lacks the blaine-window label", () => {
  const result = decide(edit(migration), { env: {}, branch: "feat/OVD-123-x", viewPr: labeled("bug") });
  assert.equal(result.allow, false);
  assert.match(result.reason, /OVD-123/);
  assert.match(result.reason, /PR #7 does not have the "blaine-window" label/);
  assert.match(result.reason, /OVD_BLAINE_WINDOW=1/);
});

test("migration edit is allowed when the PR has the blaine-window label", () => {
  assert.deepEqual(decide(edit(migration), { env: {}, viewPr: labeled("blaine-window") }), { allow: true });
});

test("OVD_BLAINE_WINDOW=1 allows without consulting gh", () => {
  const viewPr = () => assert.fail("gh should not be called");
  assert.deepEqual(decide(edit(migration), { env: { OVD_BLAINE_WINDOW: "1" }, viewPr }), { allow: true });
});

test("non-migration paths are always allowed", () => {
  const viewPr = () => assert.fail("gh should not be called");
  for (const payload of [
    edit(`${repo}/src/app.ts`),
    edit(`${repo}/supabase/functions/x.ts`),
    { tool_name: "Write", cwd: repo, tool_input: { file_path: `${repo}/docs/migrations.md` } },
    bash("echo hi > supabase/seed.sql"),
  ]) {
    assert.deepEqual(decide(payload, { env: {}, viewPr }), { allow: true });
  }
});

test("relative and notebook paths resolve against cwd", () => {
  assert.equal(migrationWriteTargets(edit("supabase/migrations/a.sql")).length, 1);
  const notebook = { tool_name: "NotebookEdit", cwd: `${repo}/supabase`, tool_input: { notebook_path: "migrations/n.ipynb" } };
  assert.equal(migrationWriteTargets(notebook).length, 1);
});

test("Bash writes into migrations are detected", () => {
  for (const command of [
    "echo 'select 1;' > supabase/migrations/a.sql",
    "cat x >> supabase/migrations/a.sql",
    "echo x 2> supabase/migrations/err.log",
    "echo x | tee -a supabase/migrations/a.sql",
    "cp /tmp/a.sql supabase/migrations/",
    "mv supabase/migrations/a.sql /tmp/",
    "sed -i 's/a/b/' supabase/migrations/a.sql",
    "git mv supabase/migrations/a.sql supabase/migrations/b.sql",
    "install -m 644 a.sql supabase/migrations/a.sql",
    "rsync -a src/ supabase/migrations/",
    "touch supabase/migrations/new.sql",
    "rm -f supabase/migrations/a.sql",
    "truncate -s 0 supabase/migrations/a.sql",
    "dd if=/dev/zero of=supabase/migrations/a.sql",
    "cd supabase/migrations && touch new.sql",
    "bash -c 'echo x > supabase/migrations/a.sql'",
    `echo x > ${migration}`,
  ]) {
    const result = decide(bash(command), { env: {}, branch: "OVD-9-x", viewPr: labeled() });
    assert.equal(result.allow, false, command);
  }
});

test("reads are never blocked", () => {
  const viewPr = () => assert.fail("gh should not be called");
  for (const payload of [
    { tool_name: "Read", cwd: repo, tool_input: { file_path: migration } },
    { tool_name: "Grep", cwd: repo, tool_input: { pattern: "x", path: `${repo}/supabase/migrations` } },
    bash("cat supabase/migrations/a.sql"),
    bash("ls supabase/migrations | tail -1"),
    bash("grep -rn create supabase/migrations 2>/dev/null"),
    bash("cp supabase/migrations/a.sql /tmp/a.sql"),
    bash("sed -n 1,5p supabase/migrations/a.sql > /tmp/out 2>&1"),
    bash("git diff -- supabase/migrations"),
  ]) {
    assert.deepEqual(decide(payload, { env: {}, viewPr }), { allow: true }, JSON.stringify(payload.tool_input));
  }
});

test("fails closed when gh errors", () => {
  const result = decide(edit(migration), { env: {}, branch: "chore/no-key", viewPr: ghFails });
  assert.equal(result.allow, false);
  assert.match(result.reason, /failing closed/);
  assert.match(result.reason, /no Linear key/);
});

test("helpers parse Linear keys and ignore fd duplication", () => {
  assert.equal(linearKeyFromBranch("feature/ovd-689-numbering"), "OVD-689");
  assert.equal(linearKeyFromBranch("main"), null);
  assert.deepEqual(bashWriteTargets("make 2>&1", repo), []);
});

function fakeGh(t, script) {
  const dir = mkdtempSync(join(tmpdir(), "guard-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function runHook(payload, env) {
  const { OVD_BLAINE_WINDOW: _ignored, ...base } = process.env;
  return spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), env: { ...base, ...env }, encoding: "utf8" });
}

test("hook process exits 2 without the label and 0 with it (fake gh)", (t) => {
  const payload = { ...edit(migration), cwd: tmpdir() };
  const unlabeled = fakeGh(t, `echo '{"number":3,"labels":[{"name":"bug"}]}'`);
  const blocked = runHook(payload, { OVD_GUARD_GH_BIN: unlabeled });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /blaine-window/);

  const withLabel = fakeGh(t, `echo '{"number":3,"labels":[{"name":"blaine-window"}]}'`);
  assert.equal(runHook(payload, { OVD_GUARD_GH_BIN: withLabel }).status, 0);
});

test("hook process fails closed when gh exits non-zero or is missing", (t) => {
  const payload = { ...edit(migration), cwd: tmpdir() };
  const broken = fakeGh(t, `echo 'no pull requests found' >&2; exit 1`);
  const result = runHook(payload, { OVD_GUARD_GH_BIN: broken });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no pull requests found/);
  assert.equal(runHook(payload, { OVD_GUARD_GH_BIN: "/nonexistent/gh" }).status, 2);
  assert.equal(runHook(payload, { OVD_GUARD_GH_BIN: "/nonexistent/gh", OVD_BLAINE_WINDOW: "1" }).status, 0);
});

test("hook process allows non-migration writes and fails closed on bad input", () => {
  assert.equal(runHook(edit("/repo/src/a.ts"), { OVD_GUARD_GH_BIN: "/nonexistent/gh" }).status, 0);
  const bad = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" });
  assert.equal(bad.status, 2);
});
