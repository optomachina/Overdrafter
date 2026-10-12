/** Offline tests for the migration write guard. A fake gh stands in for GitHub. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bashNeedsWindow,
  decide,
  expandSimpleVars,
  isHumanOptomachina,
  isLabelMutation,
  isMcpLabelSelfGrant,
  isReadOnlyAllowlisted,
  linearKeyFromBranch,
  mentionsSupabaseOrMigration,
  migrationWriteTargets,
  expandBraces,
  globMatchesMigrations,
  hasCommandSubstitution,
  pipesIntoShell,
  stripQuotes,
  substitutionTouchesSupabase,
} from "./guard-migrations.mjs";

const hook = fileURLToPath(new URL("./guard-migrations.mjs", import.meta.url));
const settings = fileURLToPath(new URL("../settings.json", import.meta.url));
const repo = "/repo";
const migration = `${repo}/supabase/migrations/20260101000000_x.sql`;
const humanActor = { login: "optomachina", type: "User" };

const edit = (file_path) => ({ tool_name: "Edit", cwd: repo, tool_input: { file_path } });
const bash = (command) => ({ tool_name: "Bash", cwd: repo, tool_input: { command } });
const mcp = (tool_name, tool_input) => ({ tool_name, cwd: repo, tool_input });
const labeled = (...labels) => () => ({
  ok: true,
  number: 7,
  labels,
  windowActor: labels.includes("blaine-window") ? humanActor : null,
});
const ghFails = () => ({ ok: false, error: "gh: command not found" });

function blocked(payload, extra = {}) {
  return decide(payload, { env: {}, viewPr: labeled(), ...extra });
}

test("migration edit is blocked when the PR lacks the blaine-window label", () => {
  const result = decide(edit(migration), { env: {}, branch: "feat/OVD-123-x", viewPr: labeled("bug") });
  assert.equal(result.allow, false);
  assert.match(result.reason, /OVD-123/);
  assert.match(result.reason, /PR #7 does not have the "blaine-window" label/);
  assert.match(result.reason, /OVD_BLAINE_WINDOW=1/);
  assert.match(result.reason, /best-effort guardrail/);
  assert.match(result.reason, /real gate stays at Blaine's merge and apply approval/);
});

test("migration edit is allowed when the PR has a human-applied blaine-window label", () => {
  assert.deepEqual(decide(edit(migration), { env: {}, viewPr: labeled("blaine-window") }), { allow: true });
});

test("OVD_BLAINE_WINDOW=1 allows without consulting gh", () => {
  const viewPr = () => assert.fail("gh should not be called");
  assert.deepEqual(decide(edit(migration), { env: { OVD_BLAINE_WINDOW: "1" }, viewPr }), { allow: true });
});

test("paths that do not mention supabase or migration stay allowed", () => {
  const viewPr = () => assert.fail("gh should not be called");
  for (const payload of [
    edit(`${repo}/src/app.ts`),
    edit(`${repo}/supabase/functions/x.ts`),
    { tool_name: "Write", cwd: repo, tool_input: { file_path: `${repo}/docs/migrations.md` } },
    bash("echo hi > src/app.ts"),
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
});

test("yarn supabase and npm run supabase are blocked", () => {
  for (const command of ["yarn supabase migration new", "npm run supabase -- migration new"]) {
    const result = blocked(bash(command));
    assert.equal(result.allow, false, command);
    assert.match(result.reason, /supabase\/migrations/, command);
    assert.equal(bashNeedsWindow(command), true, command);
  }
});

test("supabase db diff -f is blocked", () => {
  for (const command of ["supabase db diff -f x", "npx supabase db diff -f x"]) {
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("git checkout and restore --source into migrations are blocked", () => {
  for (const command of [
    "git checkout br -- supabase/migrations/x.sql",
    "git restore --source=HEAD -- supabase/migrations/x.sql",
    "git restore --source br supabase/migrations/x.sql",
  ]) {
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("git apply, git am, and patch into migrations are blocked", () => {
  for (const command of [
    "git apply supabase/migrations/x.patch",
    "git am supabase/migrations/x.patch",
    "patch supabase/migrations/x.sql < /tmp/x.patch",
  ]) {
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("tar and unzip into migrations are blocked", () => {
  for (const command of ["tar -x -C supabase/migrations -f /tmp/x.tar", "unzip -d supabase/migrations /tmp/x.zip"]) {
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("perl -e and ruby -e writes into migrations are blocked", () => {
  for (const command of [
    "perl -e 'open F, \">supabase/migrations/x.sql\"'",
    "ruby -e 'File.write(\"supabase/migrations/x.sql\", \"x\")'",
  ]) {
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("eval of a migration write is blocked", () => {
  assert.equal(blocked(bash("eval 'echo x > supabase/migrations/x.sql'")).allow, false);
});

test("variable path indirection expands before the mention check", () => {
  const command = "D=supabase/migrations; echo x > $D/x.sql";
  assert.match(expandSimpleVars(command), /supabase\/migrations\/x\.sql/);
  assert.equal(mentionsSupabaseOrMigration(command), true);
  assert.equal(blocked(bash(command)).allow, false);
});

test("a /tmp script whose text mentions supabase is blocked", () => {
  const command = "printf '%s\\n' 'echo x > supabase/migrations/x.sql' > /tmp/m.sh && bash /tmp/m.sh";
  assert.equal(blocked(bash(command)).allow, false);
});

test("curl to the labels API is blocked", () => {
  const command = "curl -X POST https://api.github.com/repos/optomachina/Overdrafter/issues/664/labels -d '{\"labels\":[\"blaine-window\"]}'";
  assert.equal(isLabelMutation(command), true);
  const result = decide(bash(command), { env: { OVD_BLAINE_WINDOW: "1" }, viewPr: () => assert.fail("gh should not be called") });
  assert.equal(result.allow, false);
  assert.match(result.reason, /blaine-window/);
});

test("$L label indirection is blocked after expansion", () => {
  const command = "L=blaine-window; gh pr edit --add-label $L";
  assert.match(expandSimpleVars(command), /blaine-window/);
  assert.equal(isLabelMutation(command), true);
  assert.equal(blocked(bash(command)).allow, false);
});

test("MCP label tools that add blaine-window are blocked", () => {
  const payload = mcp("mcp__github__add_labels", { labels: ["blaine-window"], pull_number: 664 });
  assert.equal(isMcpLabelSelfGrant(payload.tool_name, payload.tool_input), true);
  const result = decide(payload, { env: { OVD_BLAINE_WINDOW: "1" }, viewPr: () => assert.fail("gh should not be called") });
  assert.equal(result.allow, false);
  assert.match(result.reason, /blaine-window/);
});

test("MCP writes into supabase/migrations are blocked", () => {
  const payload = mcp("mcp__filesystem__write_file", { path: "supabase/migrations/x.sql", contents: "x" });
  assert.equal(blocked(payload).allow, false);
  assert.equal(migrationWriteTargets(payload).length, 1);
});

test("quoted glob cd into migrations followed by a write is blocked", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "guard-quote-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  assert.equal(stripQuotes('cd supa"base"/mig*'), "cd supabase/mig*");
  const command = 'cd supa"base"/mig*; echo x > x.sql';
  assert.equal(mentionsSupabaseOrMigration(command), true);
  assert.equal(blocked({ tool_name: "Bash", cwd: dir, tool_input: { command } }).allow, false);
});

test("write-ish globs that resolve under supabase are blocked", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "guard-glob-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  for (const command of ["touch s*/m*/x.sql", "cp /tmp/a.sql s*base/mig*/"]) {
    assert.equal(blocked({ tool_name: "Bash", cwd: dir, tool_input: { command } }).allow, false, command);
  }
});

test("bracket globs into migrations are blocked", () => {
  assert.equal(globMatchesMigrations("[s]upabase/[m]igrations/x.sql"), true);
  assert.equal(globMatchesMigrations("s[u]pa*/mig*/x.sql"), true);
  for (const command of ["touch [s]upabase/[m]igrations/x.sql", "touch s[u]pa*/mig*/x.sql"]) {
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("brace expansion including an empty alternative is blocked", () => {
  assert.deepEqual(expandBraces("supa{base,}/migrations/x.sql"), ["supabase/migrations/x.sql", "supa/migrations/x.sql"]);
  assert.equal(blocked(bash("touch supa{base,}/migrations/x.sql")).allow, false);
});

test("piping into dash, ksh, ash, or busybox sh is blocked", () => {
  for (const command of ["echo hi | dash", "base64 -d | ksh", "cat x | ash", "echo hi | busybox sh"]) {
    assert.equal(pipesIntoShell(command), true, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("echo hi | sh stays blocked", () => {
  assert.equal(pipesIntoShell("echo hi | sh"), true);
  assert.equal(blocked(bash("echo hi | sh")).allow, false);
});

test("head tail wc less file and stat on migrations are allowed", () => {
  const viewPr = () => assert.fail("gh should not be called");
  for (const command of [
    "head supabase/migrations/x.sql",
    "tail -n 20 supabase/migrations/x.sql",
    "wc -l supabase/migrations/x.sql",
    "less supabase/migrations/x.sql",
    "file supabase/migrations/x.sql",
    "stat supabase/migrations/x.sql",
  ]) {
    assert.equal(isReadOnlyAllowlisted(command), true, command);
    assert.deepEqual(decide(bash(command), { env: {}, viewPr }), { allow: true }, command);
  }
});

test("piping into sh, bash, zsh, or eval is blocked", () => {
  for (const command of [
    "echo YmxhaW5lLXdpbmRvdw== | base64 -d | sh",
    "base64 -d | bash",
    "openssl enc -d | zsh",
    "echo hi | eval",
  ]) {
    assert.equal(pipesIntoShell(command), true, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("encoded --add-label values are blocked unless they are a safe label", () => {
  const encoded = 'gh pr edit --add-label "$(echo YmxhaW5lLXdpbmRvdw== | base64 -d)"';
  assert.equal(isLabelMutation(encoded), true);
  assert.equal(blocked(bash(encoded)).allow, false);
  assert.equal(isLabelMutation("gh pr edit --add-label bug"), false);
  assert.equal(blocked(bash("gh pr edit --add-label bug")).allow, true);
  assert.equal(isLabelMutation("gh pr edit --add-label blaine-window"), true);
});

test("mcp__github__issue_write with labels is blocked unless every label is safe", () => {
  const grant = mcp("mcp__github__issue_write", { labels: ["blaine-window"], title: "x" });
  assert.equal(isMcpLabelSelfGrant(grant.tool_name, grant.tool_input), true);
  assert.equal(blocked(grant).allow, false);
  const safe = mcp("mcp__github__issue_write", { labels: ["bug"], title: "x" });
  assert.equal(isMcpLabelSelfGrant(safe.tool_name, safe.tool_input), false);
  assert.deepEqual(blocked(safe), { allow: true });
});

test("mcp__supabase__apply_migration is treated as a write", () => {
  const payload = mcp("mcp__supabase__apply_migration", { name: "x" });
  assert.equal(migrationWriteTargets(payload).length, 1);
  assert.equal(blocked(payload).allow, false);
  assert.equal(blocked(mcp("mcp__supabase__execute_sql", { query: "select 1" })).allow, false);
});

test("git commit message text mentioning migration is allowed", () => {
  const command = "git commit -m 'docs: explain migration policy'";
  assert.equal(mentionsSupabaseOrMigration(command), false);
  assert.deepEqual(blocked(bash(command)), { allow: true });
});

test("git commit messages containing supabase or migrations are allowed", () => {
  for (const command of [
    "git commit -m 'chore: update supabase types'",
    "git commit --message 'docs: mention migrations'",
    "git commit -am 'fix supabase client'",
    "git commit -m 'rebuild supabase/migrations types'",
  ]) {
    assert.equal(mentionsSupabaseOrMigration(command), false, command);
    assert.deepEqual(blocked(bash(command)), { allow: true }, command);
  }
});

test("command substitution or process substitution alongside supabase or migration paths is blocked", () => {
  for (const command of [
    'git commit -m "$(cat supabase/migrations/x.sql)"',
    "git commit -m `cat supabase/migrations/x.sql`",
    "diff <(cat supabase/migrations/a.sql) <(echo x)",
    "echo x > $(echo supabase/migrations/x.sql)",
    "ls $(echo supabase/migrations)",
  ]) {
    assert.equal(hasCommandSubstitution(command), true, command);
    assert.equal(substitutionTouchesSupabase(command), true, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("git commit --file or -F pointing into supabase is blocked", () => {
  for (const command of [
    "git commit -F supabase/migrations/msg",
    "git commit --file supabase/migrations/msg",
    "git commit --file=supabase/migrations/msg",
  ]) {
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("git commit -F of a non-supabase file is allowed", () => {
  assert.deepEqual(blocked(bash("git commit -F /tmp/msg")), { allow: true });
  assert.deepEqual(blocked(bash('git commit -m "$(echo hi)"')), { allow: true });
});

test("find write or exec options on migrations are blocked", () => {
  for (const command of [
    "find supabase/migrations -exec rm {} ;",
    "find supabase/migrations -execdir rm {} ;",
    "find supabase/migrations -ok rm {} ;",
    "find supabase/migrations -okdir rm {} ;",
    "find supabase/migrations -delete",
    "find supabase/migrations -fprint /tmp/out",
    "find supabase/migrations -fprint0 /tmp/out",
    "find supabase/migrations -fprintf /tmp/out %p",
    "find supabase/migrations -fls /tmp/out",
  ]) {
    assert.equal(isReadOnlyAllowlisted(command), false, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("sort -o or --output on migrations is blocked", () => {
  for (const command of ["sort -o /tmp/out supabase/migrations/x.sql", "sort --output=/tmp/out supabase/migrations/x.sql"]) {
    assert.equal(isReadOnlyAllowlisted(command), false, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("sort short-flag clusters and attached -o values are treated as output", () => {
  for (const command of ["sort -osupabase/migrations/out /tmp/in", "sort -uo supabase/migrations/out /tmp/in"]) {
    assert.equal(isReadOnlyAllowlisted(command), false, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("git diff --output on migrations is blocked", () => {
  for (const command of ["git diff --output=/tmp/out -- supabase/migrations", "git diff --output /tmp/out -- supabase/migrations"]) {
    assert.equal(isReadOnlyAllowlisted(command), false, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("uniq with an output file on migrations is blocked", () => {
  const command = "uniq supabase/migrations/a.sql /tmp/out";
  assert.equal(isReadOnlyAllowlisted(command), false);
  assert.equal(blocked(bash(command)).allow, false);
});

test("uniq treats the second positional as output even when the first is '-'", () => {
  const command = "uniq - supabase/migrations/out";
  assert.equal(isReadOnlyAllowlisted(command), false);
  assert.equal(blocked(bash(command)).allow, false);
});

test("file -C on migrations is blocked", () => {
  for (const command of ["file -C supabase/migrations", "file -C -m supabase/migrations/x.sql"]) {
    assert.equal(isReadOnlyAllowlisted(command), false, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("git commit of existing migration files is allowed", () => {
  const command = "git commit -m x -- supabase/migrations/a.sql";
  assert.deepEqual(blocked(bash(command)), { allow: true });
  assert.deepEqual(blocked(bash("git commit -m 'chore: update supabase types' -- supabase/migrations/a.sql")), { allow: true });
});

test("plain diff is allowed", () => {
  const viewPr = () => assert.fail("gh should not be called");
  assert.deepEqual(decide(bash("diff a b"), { env: {}, viewPr }), { allow: true });
  assert.equal(isReadOnlyAllowlisted("diff supabase/migrations/a.sql supabase/migrations/b.sql"), true);
  assert.deepEqual(decide(bash("diff supabase/migrations/a.sql supabase/migrations/b.sql"), { env: {}, viewPr }), { allow: true });
});

test("git blame and diff on migrations are allowed", () => {
  const viewPr = () => assert.fail("gh should not be called");
  for (const command of ["git blame -- supabase/migrations/x.sql", "git diff -- supabase/migrations"]) {
    assert.equal(isReadOnlyAllowlisted(command), true, command);
    assert.deepEqual(decide(bash(command), { env: {}, viewPr }), { allow: true }, command);
  }
});

test("find -name and sort/uniq on migrations are allowed", () => {
  const viewPr = () => assert.fail("gh should not be called");
  for (const command of [
    "find supabase/migrations -name '*.sql'",
    "sort supabase/migrations/x.sql",
    "uniq supabase/migrations/x.sql",
    "cat supabase/migrations/x.sql | sort | uniq",
  ]) {
    assert.equal(isReadOnlyAllowlisted(command), true, command);
    assert.deepEqual(decide(bash(command), { env: {}, viewPr }), { allow: true }, command);
  }
});

test("piping into tcsh, csh, or fish is blocked", () => {
  for (const command of ["echo hi | tcsh", "base64 -d | csh", "cat x | fish"]) {
    assert.equal(pipesIntoShell(command), true, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("npx vitest on a migration test file is allowed", () => {
  const command = "npx vitest run src/migration.test.ts";
  assert.equal(isReadOnlyAllowlisted(command), true);
  assert.deepEqual(blocked(bash(command)), { allow: true });
});

test("accepted residuals: bare apply/patch/tar and an indirect script stay unblocked", () => {
  for (const command of ["git apply /tmp/x.patch", "git am /tmp/x.patch", "patch < /tmp/x.patch", "tar -x -f /tmp/x.tar", "unzip /tmp/x.zip", "bash /tmp/created-elsewhere.sh"]) {
    assert.deepEqual(blocked(bash(command)), { allow: true }, command);
  }
});

test("accepted residual: base64 piped into perl, python3, or node stays unblocked", () => {
  for (const command of ["echo YQ== | base64 -d | perl", "base64 -d | python3", "base64 -d | node"]) {
    assert.equal(pipesIntoShell(command), false, command);
    assert.deepEqual(blocked(bash(command)), { allow: true }, command);
  }
});

test("settings.json matches Edit/Write, Bash, and mcp__.*", () => {
  const parsed = JSON.parse(readFileSync(settings, "utf8"));
  const matchers = parsed.hooks.PreToolUse.map((entry) => entry.matcher);
  assert.deepEqual(matchers, ["Edit|Write|MultiEdit|NotebookEdit", "Bash", "mcp__.*"]);
  for (const entry of parsed.hooks.PreToolUse) {
    assert.equal(entry.hooks[0].onFailure, "block");
  }
});

test("python -c and node -e writes into migrations are blocked", () => {
  for (const command of [
    "python3 -c \"open('supabase/migrations/a.sql','w').write('x')\"",
    "python -c \"from pathlib import Path; Path('supabase/migrations/a.sql').write_text('x')\"",
    "node -e \"require('fs').writeFileSync('supabase/migrations/a.sql','x')\"",
    "node --eval \"require('fs').writeFileSync('supabase/migrations/a.sql','x')\"",
  ]) {
    assert.equal(blocked(bash(command)).allow, false, command);
  }
});

test("recursive copy onto supabase is blocked", () => {
  assert.equal(blocked(bash("cp -r tmp supabase")).allow, false);
  assert.equal(blocked(bash("mv tmp supabase")).allow, false);
  assert.equal(blocked(bash("rsync -a tmp/ supabase")).allow, false);
});

test("mixed-case Supabase/Migrations paths are blocked", () => {
  const result = blocked(edit(`${repo}/Supabase/Migrations/a.sql`));
  assert.equal(result.allow, false);
  assert.equal(blocked(bash("echo x > Supabase/Migrations/a.sql")).allow, false);
  assert.equal(blocked(bash("dd if=/dev/zero of=Supabase/Migrations/a.sql")).allow, false);
});

test("writes through a symlink into migrations are blocked", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "guard-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  symlinkSync(join(dir, "supabase", "migrations"), join(dir, "alias"));
  const viaLink = { tool_name: "Write", cwd: dir, tool_input: { file_path: join(dir, "alias", "x.sql") } };
  assert.equal(blocked(viaLink).allow, false);
  const viaBash = { tool_name: "Bash", cwd: dir, tool_input: { command: "echo x > alias/x.sql" } };
  assert.equal(blocked(viaBash).allow, false);
});

test("gh pr edit --add-label blaine-window is blocked", () => {
  for (const command of ["gh pr edit --add-label blaine-window", "gh pr edit 664 --add-label=blaine-window"]) {
    const result = decide(bash(command), { env: { OVD_BLAINE_WINDOW: "1" }, viewPr: () => assert.fail("gh should not be called") });
    assert.equal(result.allow, false, command);
    assert.match(result.reason, /blaine-window/, command);
    assert.equal(isLabelMutation(command), true, command);
  }
});

test("gh issue edit --add-label blaine-window is blocked", () => {
  const command = "gh issue edit 664 --add-label blaine-window";
  assert.equal(isLabelMutation(command), true);
  assert.equal(decide(bash(command), { env: {}, viewPr: labeled("blaine-window") }).allow, false);
});

test("gh api labels calls that add blaine-window are blocked", () => {
  for (const command of [
    "gh api repos/:owner/:repo/issues/664/labels -f name=blaine-window",
    "gh api -X POST repos/optomachina/Overdrafter/issues/664/labels --input -",
    "gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelIds: \"blaine-window\"}) { clientMutationId } }'",
  ]) {
    assert.equal(isLabelMutation(command), true, command);
    assert.equal(blocked(bash(command)).allow, false, command);
  }
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

test("app-mediated blaine-window label is not accepted even when the actor is optomachina", () => {
  assert.equal(
    isHumanOptomachina({ login: "optomachina", type: "User", performed_via_github_app: { slug: "cursor" } }),
    false,
  );
  const result = decide(edit(migration), {
    env: {},
    viewPr: () => ({
      ok: true,
      number: 7,
      labels: ["blaine-window"],
      windowActor: { login: "optomachina", type: "User", performed_via_github_app: { slug: "cursor" } },
    }),
  });
  assert.equal(result.allow, false);
  assert.match(result.reason, /not a direct human optomachina action/);
  assert.match(result.reason, /performed_via_github_app/);
});

test("missing tool_input fails closed", () => {
  const result = decide({ tool_name: "Write", cwd: repo }, { env: { OVD_BLAINE_WINDOW: "1" }, viewPr: labeled("blaine-window") });
  assert.equal(result.allow, false);
  assert.match(result.reason, /tool_input/);
  assert.equal(decide({ cwd: repo }, { env: {} }).allow, false);
  assert.equal(decide({ tool_name: "mcp__filesystem__write_file", cwd: repo }, { env: {} }).allow, false);
});

test("malformed tool_input fails closed", () => {
  for (const payload of [
    { tool_name: "Edit", cwd: repo, tool_input: null },
    { tool_name: "Bash", cwd: repo, tool_input: {} },
    { tool_name: "Write", cwd: repo, tool_input: { file_path: 1 } },
    { tool_name: "Bash", cwd: repo, tool_input: { command: ["echo"] } },
    { tool_name: "MultiEdit", cwd: repo, tool_input: { file_path: "" } },
    { tool_name: "mcp__github__add_labels", cwd: repo, tool_input: null },
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
    bash("ls supabase/migrations"),
    bash("grep -rn create supabase/migrations 2>/dev/null"),
    bash("rg create supabase/migrations"),
    bash("git diff -- supabase/migrations"),
    bash("git log -- supabase/migrations"),
    bash("git show HEAD:supabase/migrations/a.sql"),
    bash("git status -- supabase/migrations"),
    bash("supabase --version"),
    bash("npx supabase --version"),
    bash("npm run test"),
    bash("npm run verify"),
    mcp("mcp__filesystem__read_file", { path: "supabase/migrations/a.sql" }),
  ]) {
    assert.deepEqual(decide(payload, { env: {}, viewPr }), { allow: true }, JSON.stringify(payload.tool_input));
    if (payload.tool_name === "Bash") assert.equal(isReadOnlyAllowlisted(payload.tool_input.command), true);
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
  assert.equal(bashNeedsWindow("make 2>&1", repo), false);
  assert.equal(mentionsSupabaseOrMigration("echo x > docs/migrations.md"), false);
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
const appTimeline = [
  {
    event: "labeled",
    label: { name: "blaine-window" },
    actor: { login: "optomachina", type: "User" },
    performed_via_github_app: { slug: "cursor" },
  },
];

test("hook process exits 2 without the label and 0 with a human-applied label", (t) => {
  const payload = { ...edit(migration), cwd: tmpdir() };
  const unlabeled = fakeGh(t, { pr: { stdout: { number: 3, labels: [{ name: "bug" }] } } });
  const blockedRun = runHook(payload, { OVD_GUARD_GH_BIN: unlabeled });
  assert.equal(blockedRun.status, 2);
  assert.match(blockedRun.stderr, /blaine-window/);
  assert.match(blockedRun.stderr, /best-effort guardrail/);

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

test("hook process fails closed when performed_via_github_app is set", (t) => {
  const payload = { ...edit(migration), cwd: tmpdir() };
  const viaApp = fakeGh(t, {
    pr: { stdout: { number: 3, labels: [{ name: "blaine-window" }] } },
    api: { stdout: appTimeline },
  });
  const result = runHook(payload, { OVD_GUARD_GH_BIN: viaApp });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /performed_via_github_app/);
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
  assert.equal(runHook({ tool_name: "mcp__github__add_labels" }, {}).status, 2);
});
