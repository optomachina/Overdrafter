/** Offline tests for the migration write guard. A fake gh stands in for GitHub. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bashWriteTargets,
  decide,
  isHumanOptomachina,
  isLabelSelfGrant,
  isSupabaseMigrationNew,
  linearKeyFromBranch,
  migrationWriteTargets,
  unwrapLaunchers,
} from "./guard-migrations.mjs";

const hook = fileURLToPath(new URL("./guard-migrations.mjs", import.meta.url));
const repo = "/repo";
const migration = `${repo}/supabase/migrations/20260101000000_x.sql`;
const humanActor = { login: "optomachina", type: "User" };

const edit = (file_path) => ({ tool_name: "Edit", cwd: repo, tool_input: { file_path } });
const bash = (command) => ({ tool_name: "Bash", cwd: repo, tool_input: { command } });
const labeled = (...labels) => () => ({
  ok: true,
  number: 7,
  labels,
  windowActor: labels.includes("blaine-window") ? humanActor : null,
});
const ghFails = () => ({ ok: false, error: "gh: command not found" });

test("migration edit is blocked when the PR lacks the blaine-window label", () => {
  const result = decide(edit(migration), { env: {}, branch: "feat/OVD-123-x", viewPr: labeled("bug") });
  assert.equal(result.allow, false);
  assert.match(result.reason, /OVD-123/);
  assert.match(result.reason, /PR #7 does not have the "blaine-window" label/);
  assert.match(result.reason, /OVD_BLAINE_WINDOW=1/);
});

test("migration edit is allowed when the PR has a human-applied blaine-window label", () => {
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

test("supabase migration new is blocked bare or through npx/pnpm", () => {
  for (const command of [
    "supabase migration new foo",
    "npx supabase migration new foo",
    "npx --yes supabase migration new foo",
    "pnpm exec supabase migration new foo",
    "pnpm dlx supabase migration new foo",
    "pnpm supabase migration new foo",
  ]) {
    const result = decide(bash(command), { env: {}, viewPr: labeled() });
    assert.equal(result.allow, false, command);
    assert.match(result.reason, /supabase\/migrations/, command);
  }
  assert.equal(isSupabaseMigrationNew(unwrapLaunchers(["npx", "--yes", "supabase", "migration", "new", "foo"])), true);
});

test("python -c and node -e writes into migrations are blocked", () => {
  for (const command of [
    "python3 -c \"open('supabase/migrations/a.sql','w').write('x')\"",
    "python -c \"from pathlib import Path; Path('supabase/migrations/a.sql').write_text('x')\"",
    "node -e \"require('fs').writeFileSync('supabase/migrations/a.sql','x')\"",
    "node --eval \"require('fs').writeFileSync('supabase/migrations/a.sql','x')\"",
  ]) {
    assert.equal(decide(bash(command), { env: {}, viewPr: labeled() }).allow, false, command);
  }
  const read = bash("python3 -c \"print(open('supabase/migrations/a.sql').read())\"");
  assert.deepEqual(decide(read, { env: {}, viewPr: () => assert.fail("gh should not be called") }), { allow: true });
});

test("recursive copy onto supabase is blocked", () => {
  assert.equal(decide(bash("cp -r tmp supabase"), { env: {}, viewPr: labeled() }).allow, false);
  assert.equal(decide(bash("mv tmp supabase"), { env: {}, viewPr: labeled() }).allow, false);
  assert.equal(decide(bash("rsync -a tmp/ supabase"), { env: {}, viewPr: labeled() }).allow, false);
});

test("mixed-case Supabase/Migrations paths are blocked", () => {
  const result = decide(edit(`${repo}/Supabase/Migrations/a.sql`), { env: {}, viewPr: labeled() });
  assert.equal(result.allow, false);
  assert.equal(decide(bash("echo x > Supabase/Migrations/a.sql"), { env: {}, viewPr: labeled() }).allow, false);
  assert.equal(decide(bash("dd if=/dev/zero of=Supabase/Migrations/a.sql"), { env: {}, viewPr: labeled() }).allow, false);
});

test("writes through a symlink into migrations are blocked", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "guard-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  symlinkSync(join(dir, "supabase", "migrations"), join(dir, "alias"));
  const viaLink = { tool_name: "Write", cwd: dir, tool_input: { file_path: join(dir, "alias", "x.sql") } };
  assert.equal(decide(viaLink, { env: {}, viewPr: labeled() }).allow, false);
  const viaBash = { tool_name: "Bash", cwd: dir, tool_input: { command: "echo x > alias/x.sql" } };
  assert.equal(decide(viaBash, { env: {}, viewPr: labeled() }).allow, false);
});

test("gh pr edit --add-label blaine-window is blocked", () => {
  for (const command of ["gh pr edit --add-label blaine-window", "gh pr edit 664 --add-label=blaine-window"]) {
    const result = decide(bash(command), { env: { OVD_BLAINE_WINDOW: "1" }, viewPr: () => assert.fail("gh should not be called") });
    assert.equal(result.allow, false, command);
    assert.match(result.reason, /blaine-window/, command);
    assert.equal(isLabelSelfGrant(command), true, command);
  }
});

test("gh issue edit --add-label blaine-window is blocked", () => {
  const command = "gh issue edit 664 --add-label blaine-window";
  assert.equal(isLabelSelfGrant(command), true);
  assert.equal(decide(bash(command), { env: {}, viewPr: labeled("blaine-window") }).allow, false);
});

test("gh api labels calls that add blaine-window are blocked", () => {
  for (const command of [
    "gh api repos/:owner/:repo/issues/664/labels -f name=blaine-window",
    "gh api -X POST repos/optomachina/Overdrafter/issues/664/labels --input -",
    "gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelIds: \"blaine-window\"}) { clientMutationId } }'",
  ]) {
    assert.equal(isLabelSelfGrant(command), true, command);
    assert.equal(decide(bash(command), { env: {}, viewPr: labeled() }).allow, false, command);
  }
  assert.equal(isLabelSelfGrant("gh api repos/:owner/:repo/issues/664/labels"), false);
  assert.equal(isLabelSelfGrant("gh pr view --json labels"), false);
});

test("blaine-window is accepted only when applied by human optomachina", () => {
  assert.equal(isHumanOptomachina(humanActor), true);
  assert.deepEqual(
    decide(edit(migration), {
      env: {},
      viewPr: () => ({ ok: true, number: 7, labels: ["blaine-window"], windowActor: humanActor }),
    }),
    { allow: true },
  );
});

test("bot-applied blaine-window label is not accepted", () => {
  const result = decide(edit(migration), {
    env: {},
    viewPr: () => ({ ok: true, number: 7, labels: ["blaine-window"], windowActor: { login: "cursor[bot]", type: "Bot" } }),
  });
  assert.equal(result.allow, false);
  assert.match(result.reason, /optomachina/);
  assert.match(result.reason, /cursor\[bot\]/);
});

test("app-applied blaine-window label is not accepted", () => {
  const result = decide(edit(migration), {
    env: {},
    viewPr: () => ({ ok: true, number: 7, labels: ["blaine-window"], windowActor: { login: "optomachina", type: "Bot" } }),
  });
  assert.equal(result.allow, false);
  assert.match(result.reason, /not applied by the human user/);
});

test("missing tool_input fails closed", () => {
  const result = decide({ tool_name: "Write", cwd: repo }, { env: { OVD_BLAINE_WINDOW: "1" }, viewPr: labeled("blaine-window") });
  assert.equal(result.allow, false);
  assert.match(result.reason, /tool_input/);
  assert.equal(decide({ cwd: repo }, { env: {} }).allow, false);
});

test("malformed tool_input fails closed", () => {
  for (const payload of [
    { tool_name: "Edit", cwd: repo, tool_input: null },
    { tool_name: "Bash", cwd: repo, tool_input: {} },
    { tool_name: "Write", cwd: repo, tool_input: { file_path: 1 } },
    { tool_name: "Bash", cwd: repo, tool_input: { command: ["echo"] } },
    { tool_name: "MultiEdit", cwd: repo, tool_input: { file_path: "" } },
  ]) {
    assert.equal(decide(payload, { env: {}, viewPr: labeled("blaine-window") }).allow, false, JSON.stringify(payload.tool_input));
  }
});

test("reads are never blocked", () => {
  const viewPr = () => assert.fail("gh should not be called");
  for (const payload of [
    { tool_name: "Read", cwd: repo, tool_input: { file_path: migration } },
    { tool_name: "Grep", cwd: repo, tool_input: { pattern: "x", path: `${repo}/supabase/migrations` } },
    { tool_name: "Read", cwd: repo },
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

function fakeGh(t, spec) {
  const dir = mkdtempSync(join(tmpdir(), "guard-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const bin = join(dir, "gh");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const spec = require(${JSON.stringify(specPath)});
const args = process.argv.slice(2);
const key = args[0] === "pr" ? "pr" : args[0] === "api" ? "api" : "other";
const handler = spec[key];
if (!handler) {
  process.stderr.write("unexpected " + args.join(" "));
  process.exit(1);
}
if (handler.stderr) process.stderr.write(handler.stderr);
if (handler.stdout != null) process.stdout.write(typeof handler.stdout === "string" ? handler.stdout : JSON.stringify(handler.stdout));
process.exit(handler.status ?? 0);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function runHook(payload, env) {
  const { OVD_BLAINE_WINDOW: _ignored, ...base } = process.env;
  const input = payload === undefined ? "not json" : JSON.stringify(payload);
  return spawnSync(process.execPath, [hook], { input, env: { ...base, ...env }, encoding: "utf8" });
}

const humanTimeline = [
  { event: "labeled", label: { name: "blaine-window" }, actor: { login: "optomachina", type: "User" } },
];
const botTimeline = [
  { event: "labeled", label: { name: "blaine-window" }, actor: { login: "cursor[bot]", type: "Bot" } },
];

test("hook process exits 2 without the label and 0 with a human-applied label", (t) => {
  const payload = { ...edit(migration), cwd: tmpdir() };
  const unlabeled = fakeGh(t, { pr: { stdout: { number: 3, labels: [{ name: "bug" }] } } });
  const blocked = runHook(payload, { OVD_GUARD_GH_BIN: unlabeled });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /blaine-window/);

  const withLabel = fakeGh(t, {
    pr: { stdout: { number: 3, labels: [{ name: "blaine-window" }] } },
    api: { stdout: humanTimeline },
  });
  assert.equal(runHook(payload, { OVD_GUARD_GH_BIN: withLabel }).status, 0);
});

test("hook process fails closed when the label was applied by a bot", (t) => {
  const payload = { ...edit(migration), cwd: tmpdir() };
  const bot = fakeGh(t, {
    pr: { stdout: { number: 3, labels: [{ name: "blaine-window" }] } },
    api: { stdout: botTimeline },
  });
  const result = runHook(payload, { OVD_GUARD_GH_BIN: bot });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /optomachina/);
});

test("hook process fails closed when gh exits non-zero or is missing", (t) => {
  const payload = { ...edit(migration), cwd: tmpdir() };
  const broken = fakeGh(t, { pr: { stderr: "no pull requests found", status: 1 } });
  const result = runHook(payload, { OVD_GUARD_GH_BIN: broken });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no pull requests found/);
  assert.equal(runHook(payload, { OVD_GUARD_GH_BIN: "/nonexistent/gh" }).status, 2);
  assert.equal(runHook(payload, { OVD_GUARD_GH_BIN: "/nonexistent/gh", OVD_BLAINE_WINDOW: "1" }).status, 0);
});

test("hook process allows non-migration writes and fails closed on bad input", () => {
  assert.equal(runHook(edit("/repo/src/a.ts"), { OVD_GUARD_GH_BIN: "/nonexistent/gh" }).status, 0);
  assert.equal(runHook(undefined, {}).status, 2);
  assert.equal(runHook({ tool_name: "Write" }, {}).status, 2);
  assert.equal(runHook({ tool_name: "Bash", tool_input: {} }, {}).status, 2);
});
