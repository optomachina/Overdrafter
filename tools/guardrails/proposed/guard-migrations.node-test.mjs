// Every QA probe from PR #664 plus the redesign rows, each marked as
// blocked by the hook, blocked by a deny rule in settings.json, a documented
// residual, or a pass. Deny rule rows only check that the rule exists in
// settings.json; Claude Code enforces it, this test cannot. Every round has
// at least one pass row so false positives stay visible.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide, sqlReason } from "./guard-migrations.mjs";

// Staged in tools/guardrails/proposed/ next to settings.json; applied in .claude/hooks/ below it.
const HOOK = fileURLToPath(new URL("./guard-migrations.mjs", import.meta.url));
const SETTINGS = ["./settings.json", "../settings.json"].map((p) => new URL(p, import.meta.url)).find((url) => existsSync(url));
const DENY = JSON.parse(readFileSync(SETTINGS, "utf8")).permissions.deny;
const CWD = "/repo";
const B64 = "ZWNobyB4ID4gc3VwYWJhc2UvbWlncmF0aW9ucy94LnNxbAo=";
const MIG = "/repo/supabase/migrations/x.sql";
const WORKTREE_MIG = "/repo/.claude/worktrees/w1/supabase/migrations/x.sql";

function repoRoot() {
  for (let dir = dirname(HOOK); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "tools/guardrails/proposed")) && existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}
const ROOT = repoRoot();

// A fake PR file lookup: PR 1 changes a migration, PR 2 does not, PR 3 cannot be listed, PR 5 has head abc123.
// Any PR in other/repo changes a migration, so a lookup against the wrong repository shows up.
const PR_FILES = { 1: ["src/a.ts", "supabase/migrations/20261012000000_x.sql"], 2: ["src/a.ts", "docs/supabase-migrations.md"], 5: { files: ["src/a.ts"], headSha: "abc123" } };
function fakePrFiles(target) {
  if (target.repoFlag === "other/repo" || target.owner === "other") return PR_FILES[1];
  const fromNode = target.nodeId?.replace(/^PR_/, "");
  const number = String(fromNode ?? target.number ?? (target.selector === undefined ? "2" : target.selector.split("/pull/").pop()));
  if (!(number in PR_FILES)) throw new Error("HTTP 404");
  return PR_FILES[number];
}

const HOOK_BLOCKS = "hook";
const PASSES = "pass";
const deny = (rule) => ({ deny: rule });
const residual = (why) => ({ residual: why });
const retired = (why) => ({ retired: why });
const LABEL_RETIRED = retired("the blaine-window label is retired and grants nothing");

// A package.json fixture for the npm, yarn and pnpm run rows.
const FIXTURE = mkdtempSync(join(tmpdir(), "guard-migrations-"));
writeFileSync(
  join(FIXTURE, "package.json"),
  JSON.stringify({
    scripts: {
      "db:push": "supabase db push",
      "db:reset": "supabase db reset",
      "seed:dev": "node ./scripts/seed-dev.mjs",
      "e2e:prepare": "npm run db:reset && npm run seed:dev && node ./e2e/setup-auth.mjs",
      "mig": "echo x > supabase/migrations/x.sql",
      "nested": "npm run db:push",
      "predeploy": "supabase db push",
      "deploy": "echo deployed",
      "test": "vitest run",
      "loop-a": "npm run loop-b",
      "loop-b": "npm run loop-a",
      "guard:apply": "node tools/guardrails/apply.mjs",
    },
    workspaces: ["packages/*"],
  }),
);
mkdirSync(join(FIXTURE, "packages/app"), { recursive: true });
writeFileSync(join(FIXTURE, "packages/app/package.json"), JSON.stringify({ name: "app", scripts: { "db:push": "supabase db push", safe: "echo ok" } }));
mkdirSync(join(FIXTURE, "tools/guardrails"), { recursive: true });
writeFileSync(join(FIXTURE, "merge-pr1.json"), JSON.stringify({ query: "mutation { mergePullRequest(input: {pullRequestId: \"PR_1\"}) { clientMutationId } }" }));
writeFileSync(join(FIXTURE, "merge-pr2.json"), JSON.stringify({ query: "mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }", variables: { id: "PR_2" } }));
writeFileSync(join(FIXTURE, "ref-main.json"), JSON.stringify({ ref: "refs/heads/main", sha: "abc" }));
mkdirSync(join(FIXTURE, "safe"));
writeFileSync(join(FIXTURE, "safe/package.json"), JSON.stringify({ scripts: { "db:push": "echo local only" } }));
writeFileSync(join(FIXTURE, "clean.sh"), "#!/bin/sh\necho hello\nnpm test\n");
writeFileSync(join(FIXTURE, "bad.sh"), "#!/bin/sh\necho x > supabase/migrations/x.sql\n");
writeFileSync(join(FIXTURE, "clean.patch"), "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
writeFileSync(join(FIXTURE, "mig.patch"), "--- /dev/null\n+++ b/supabase/migrations/20261012000000_x.sql\n@@ -0,0 +1 @@\n+create table t();\n");
writeFileSync(join(FIXTURE, "merge.json"), JSON.stringify({ query: "mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }" }));
writeFileSync(join(FIXTURE, "viewer.json"), JSON.stringify({ query: "query { viewer { login } }" }));
writeFileSync(join(FIXTURE, "push.sh"), "#!/usr/bin/env -S bash -e\nsupabase db push\n");
writeFileSync(join(FIXTURE, "push-noshebang.sh"), "supabase db push\n");
writeFileSync(join(FIXTURE, "push-tool"), "#!/bin/bash\nsupabase db push\n");
writeFileSync(join(FIXTURE, "clean-tool"), "#!/bin/sh\necho hello\n");
writeFileSync(join(FIXTURE, "push.py"), "#!/usr/bin/env python3\nimport subprocess\nsubprocess.run(['supabase', 'db', 'push'])\n");
writeFileSync(join(FIXTURE, "merge-pr1.graphql"), "mutation { mergePullRequest(input: {pullRequestId: \"PR_1\"}) { clientMutationId } }");
writeFileSync(join(FIXTURE, "viewer.graphql"), "query { viewer { login } }");
writeFileSync(join(FIXTURE, "tree.json"), JSON.stringify({ tree: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: "abc" }] }));
after(() => rmSync(FIXTURE, { recursive: true, force: true }));
const inFixture = (command, sub = "") => ({ tool_name: "Bash", tool_input: { command }, cwd: join(FIXTURE, sub) });
const mcp = (tool_name, tool_input) => ({ tool_name, tool_input });
const sql = (query, server = "claude_ai_Supabase") => mcp(`mcp__${server}__execute_sql`, { query });
const SUPABASE_UUID = "fb51b900-5d04-4884-9f50-844879db0029";
const VERCEL_UUID = "119d805b-7afd-4036-836e-4c808cb268e8";

// Round 12 rows, one per line: "<verdict> [<kind>] [(<note>)] | <payload>". The verdict is pass, block, deny (the note
// is the rule, checked to exist) or residual (the note says why). The kind is fixture or fixture:<subdir> (run in the
// package.json fixture), sql (execute_sql), or an edit tool name (the payload is the file path); without one the payload
// is a Bash command run from /repo. In payloads ⏎ stands for a newline, $FIXTURE for the fixture directory and $\{ for
// a dollar brace. Lines starting with # are section notes. A text table keeps hundreds of similar rows readable.
const ROUND_12 = String.raw`
# Round 12: the final bounded repair round. Every fix has a block row and every false positive fix an allow row.
# 1a. Readers outside the old READERS list pass on protected paths; their writing modes and interpreters still block.
pass | sed -n 1,80p supabase/migrations/x.sql
pass | sed -n '/create table/,/;/p' supabase/migrations/x.sql
pass | awk '{print $1}' supabase/migrations/x.sql
pass | awk -F, 'NR > 1 {print $2}' supabase/migrations/x.csv
pass | jq . supabase/migrations/x.json
pass | cut -c1-40 supabase/migrations/x.sql
pass | xxd supabase/migrations/x.sql
pass | xxd -l 64 supabase/migrations/x.sql
pass | tail -n 20 supabase/migrations/x.sql
pass | sha256sum supabase/migrations/x.sql
pass | shasum -a 256 supabase/migrations/x.sql
pass | sha1sum supabase/migrations/*.sql
pass | cmp supabase/migrations/x.sql /tmp/y.sql
pass | stat supabase/migrations/x.sql
block | sed -i s/a/b/ supabase/migrations/x.sql
block | sed -ni s/a/b/p supabase/migrations/x.sql
block | sed --in-place=.bak s/a/b/ supabase/migrations/x.sql
block | sed -n 'w supabase/migrations/y.sql' /tmp/x.sql
block | sed 's/a/b/w supabase/migrations/y.sql' /tmp/x.sql
block | sed -f /tmp/x.sed supabase/migrations/x.sql
block | awk -i inplace '{print}' supabase/migrations/x.sql
block | awk '{print > "supabase/migrations/y.sql"}' /tmp/x
block | awk '{system("touch x")}' supabase/migrations/x.sql
block | xxd -r /tmp/x.hex supabase/migrations/x.sql
block | node scripts/x.mjs supabase/migrations/x.sql
block | python3 scripts/x.py .claude/settings.json
pass | node scripts/x.mjs docs/x.md
# 1b. Only a redirect whose target is protected (or generated or unresolved in a command naming a protected path) is a write.
pass | ls supabase/migrations 2>/dev/null | tail
pass | grep -rn "security definer" supabase/migrations 2>/dev/null
pass | cat supabase/migrations/x.sql > /tmp/x.sql
pass | find supabase/migrations -name '*.sql' > /tmp/list.txt
pass | cat .claude/settings.json 2>/dev/null
pass | cat > /tmp/review.md <<'EOF'⏎Review notes for supabase/migrations/x.sql⏎EOF
pass | printf '%s\n' supabase/migrations/x.sql >> docs/notes.md
block | ls supabase/migrations > supabase/migrations/list.txt
block | cat supabase/migrations/x.sql > "$OUT"
pass | cat docs/x.md > "$OUT"
block | cat > /tmp/w.sh <<'EOF'⏎echo x > supabase/migrations/x.sql⏎EOF
# 1c. git global options are normalized before the subcommand is checked.
pass | git -C /tmp/wt log -- supabase/migrations
pass | git -C /tmp/wt diff origin/main -- supabase/migrations
pass | git -C /tmp/wt show origin/main:supabase/migrations/x.sql
pass | git --no-pager diff -- supabase/migrations
pass | git -C /tmp/wt commit -m "note supabase/migrations/x.sql"
pass | git -c core.quotepath=off --literal-pathspecs log -- supabase/migrations
block | git -C . restore --source=HEAD~5 -- .
block | git -c x=y checkout main -- .
block | git --no-pager apply /tmp/missing.patch
block | git -C supabase checkout main -- migrations
block | git --git-dir=.git --work-tree=. checkout main -- .
block | git -c core.hooksPath=.claude/hooks commit -m x
# 1d. A substitution or variable blocks only as the target of a write.
pass | node scripts/x.mjs "$(ls supabase/migrations | tail -1)"
pass | actual="$(shasum -a 256 "supabase/migrations/$\{OVD417_FILES[$index]}" | awk '{print $1}')"
block | cp /tmp/x.sql "$(echo supabase/migrations)"
block | touch "$(echo supabase/migrations/x.sql)"
block | sed -i s/a/b/ "$(ls supabase/migrations/*.sql | tail -1)"
block | echo x | tee "$(echo supabase/migrations/x.sql)"
# 2. Package.json scripts through every runner form; npm reads directory flags anywhere before --.
block fixture:safe | npm run db:push --prefix ..
block fixture:safe | npm run db:push --prefix=..
pass fixture:safe | npm run db:push -- --prefix ..
block fixture | node --run db:push
pass fixture | node --run test
block fixture | npx npm run db:push
block fixture | npm exec -- npm run db:push
block fixture | bun run db:push
block fixture | bun db:push
pass fixture | bun test
block fixture | pnpm run db:push
block fixture | yarn run db:push
block fixture | yarn db:push --cwd safe
block fixture | npm -w app run db:push
block fixture | npm -w packages/app run db:push
block fixture | npm run db:push -w app
pass fixture:safe | npm --workspaces run db:push
block fixture | npm --workspaces run db:push
block fixture | pnpm --filter app run db:push
block fixture | yarn workspace app db:push
pass fixture | npm -w app run safe
block fixture | npm -w nope run safe
block fixture | npx turbo run db:push
block fixture | npx some-unknown-runner db:push
block fixture | npx concurrently 'npm run db:push' 'npm test'
pass fixture | npx prettier --check src
pass fixture | npx some-unknown-runner test
# 3. Self protection, attached option values, and copy sources landing on protected paths.
deny (Edit(/tools/guardrails/proposed/**)) | Edit /repo/tools/guardrails/proposed/guard-migrations.mjs
block Edit | /repo/tools/guardrails/proposed/guard-migrations.mjs
deny (Edit(/tools/guardrails/apply.mjs)) | Write /repo/tools/guardrails/apply.mjs
block Write | /repo/tools/guardrails/apply.mjs
pass Edit | /repo/tools/other/x.mjs
block | echo x > tools/guardrails/apply.mjs
block | cp /tmp/x.mjs tools/guardrails/proposed/guard-migrations.mjs
block | sed -i s/2/0/ tools/guardrails/proposed/guard-migrations.mjs
block | rm -rf tools/guardrails
block fixture | rm -rf tools
pass fixture | mkdir -p src/tools
pass | cat tools/guardrails/apply.mjs
pass | node --test tools/guardrails/proposed/guard-migrations.node-test.mjs
pass | node --test scripts/a.node-test.mjs tools/guardrails/proposed/guard-migrations.node-test.mjs
block | cp -t.claude/hooks /tmp/guard-migrations.mjs
block | cp -tsupabase/migrations /tmp/x.sql
block | cp -rt supabase/migrations /tmp/x.sql
block | cp --target-directory=.claude/hooks /tmp/x.mjs
block | install -m644 -t.claude/hooks /tmp/x.mjs
block | rsync -a --backup-dir=supabase/migrations /tmp/x/ /tmp/y/
block | cp -r /tmp/clone/supabase .
block | rsync -a /tmp/stage/ ./
block | cp -r /tmp/evil/.claude/ .
block | cp -r /tmp/stage/. .
block | cp -r /tmp/stage/* .
block | rsync -a /tmp/clone/supabase ./
pass | cp -t /tmp/out supabase/migrations/x.sql
pass | cp -r /tmp/clone/src .
pass | rsync -a /tmp/stage/ /tmp/out/
pass | cp -r /tmp/clone/supabase /tmp/out/
# 5. Merge bypasses: gh repo flags anywhere, GraphQL bodies, pushes and ref writes to main, the merges API.
block | gh -R o/r pr merge 1
block | gh pr -R o/r merge 1
block | gh pr --repo=o/r merge 1
block | gh -Ro/r pr merge 1 --squash
pass | gh -R o/r pr merge 2 --squash
block | gh -R other/repo pr merge 2
block | curl -X POST https://api.github.com/graphql -d @$FIXTURE/merge-pr1.json
pass | curl https://api.github.com/graphql --data-binary @$FIXTURE/merge-pr2.json
block | curl -X POST https://api.github.com/graphql -d @/tmp/does-not-exist.json
block | curl -X POST https://api.github.com/graphql --json '{"query":"mutation { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }"}'
pass | curl -X POST https://api.github.com/graphql -d @$FIXTURE/viewer.json
block | gh api graphql -f query='mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }' -f id=PR_1
pass | gh api graphql -f query='mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }' -f id=PR_2
block | gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }'
block | git push origin HEAD:main
block | git push origin x:refs/heads/main
block | git push upstream +feature:main
block | git push origin :main
block | git push origin main
block | git push --all origin
block | git -C /tmp/wt push origin HEAD:main
pass | git push -u origin chore/guardrail-staged
pass | git push origin HEAD:refs/heads/feature/main-fix
block | gh api -X POST repos/o/r/merges -f base=main -f head=x
block | gh api repos/o/r/merges -f base=feature -f head=x
block | gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc
block | gh api -X POST repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc
block | gh api -X POST repos/o/r/git/refs --input $FIXTURE/ref-main.json
block | gh api -X POST repos/o/r/git/refs --input /tmp/does-not-exist.json
block | curl -X PATCH https://api.github.com/repos/o/r/git/refs/heads/main -d '{"sha":"abc"}'
pass | gh api -X POST repos/o/r/git/refs -f ref=refs/heads/feature -f sha=abc
pass | gh api repos/o/r/git/refs/heads/main
# 6. Postgres client options are normalized; a target that is not provably loopback fails closed.
block | psql -hdb.x.supabase.co -c 'delete from t'
block | psql -dpostgres://u@db.x.supabase.co/postgres -c 'delete from t'
block | psql --dbname=postgres://u@db.x.supabase.co/postgres -c 'delete from t'
block | psql --host=db.x.supabase.co -c 'delete from t'
block | psql 'hostaddr=10.0.0.1 dbname=x' -c 'delete from t'
block | psql 'host=localhost hostaddr=10.0.0.1' -c 'delete from t'
block | psql 'postgres://u@localhost/x?host=db.x.supabase.co' -c 'delete from t'
block | psql 'postgres://u@localhost/x?hostaddr=10.0.0.1' -c 'delete from t'
block | psql 'service=prod' -c 'delete from t'
block | PGSERVICE=prod psql -c 'delete from t'
block | psql -hdb.x.supabase.co -c 'select 1' -c'delete from t'
block | psql -hdb.x.supabase.co -Atc 'delete from t'
block | psql -hdb.x.supabase.co -fx.sql
block | pgbench -h db.x.supabase.co -i postgres
block | pgbench postgres://u@db.x.supabase.co/postgres
block | docker run --rm --entrypoint psql img postgres://u@db.x.supabase.co/postgres
block | docker run --rm -i --entrypoint=psql img "$DATABASE_URL" -c 'drop table t'
block | docker run --rm -e PGHOST=db.x.supabase.co img psql -c 'drop table t'
block | docker exec -i ctr psql -h db.x.supabase.co -c 'delete from t'
block | docker compose exec db psql -h db.x.supabase.co -c 'delete from t'
pass | psql -h localhost -c 'select 1' -c'delete from t'
pass | psql 'postgres://postgres@[::1]:54322/postgres' -c 'drop table t'
pass | psql -h 127.0.0.2 -c 'drop table t'
pass | psql -hdb.x.supabase.co -Atc 'select count(*) from jobs'
pass | pgbench -h localhost -c 10 postgres
pass | docker exec -i supabase_db_overdrafter psql -U postgres -c 'drop table t'
pass | docker run --rm --entrypoint pg_dump img postgres://u@db.x.supabase.co/postgres
# 7. supabase CLI against a hosted target: read allow list only; --local forms pass.
block | supabase db push --linked
block | supabase db query --linked 'delete from t'
block | supabase migration repair --status applied 1 --linked
block | supabase migration repair --status applied 1
block | supabase migration down --linked
block | supabase seed buckets --linked
block | supabase test db --db-url "$DATABASE_URL"
block | supabase storage rm ss:///bucket/x
block | supabase postgres-config update --config x=1
block | supabase branches pause b
block | supabase db schema declarative sync
pass | supabase migration list --linked
pass | supabase db diff --linked
pass | supabase db lint --linked
pass | supabase inspect db locks --linked
pass | supabase projects list
pass | supabase branches list
pass | supabase secrets list --project-ref abc
pass | supabase gen types typescript --project-id abc
pass | supabase migration repair --local --status applied 1
pass | supabase db push --local
pass | supabase db push --db-url postgres://postgres@127.0.0.1:54322/postgres
pass | supabase migration up --local
pass | supabase functions serve
# 8. HTTP methods normalized; unresolved SUPABASE variables fail closed; loopback includes [::1] and 127.0.0.0/8.
block | curl --json='{}' https://abc.supabase.co/rest/v1/jobs
block | curl --json @/tmp/x.json https://abc.supabase.co/rest/v1/jobs
block | curl --request=DELETE https://abc.supabase.co/rest/v1/jobs
block | curl -XDELETE https://abc.supabase.co/rest/v1/jobs
block | curl --data-raw '{}' https://abc.supabase.co/rest/v1/jobs
block | curl -dx=1 https://abc.supabase.co/rest/v1/jobs
block | curl -T x.json https://abc.supabase.co/storage/v1/object/b/x
block | curl -X POST "$MY_SUPABASE_ENDPOINT/x"
block | curl -X POST "$\{NEXT_PUBLIC_SUPABASE_URL}/functions/v1/x"
pass | curl -X POST http://[::1]:54321/rest/v1/jobs -d '{}'
pass | curl -X POST http://127.0.0.5:54321/rest/v1/jobs -d '{}'
pass | curl -X POST http://localhost:54321/rest/v1/jobs -d '{}'
pass | SUPABASE_URL=http://127.0.0.1:54321; curl -X POST "$SUPABASE_URL/rest/v1/jobs" -d '{}'
pass | curl -G -d select=id https://abc.supabase.co/rest/v1/jobs
pass | curl -I https://abc.supabase.co/rest/v1/jobs
# 9. execute_sql: U& escapes, pgmq, dblink and the known write function list fail closed.
block sql | select U&'\0064rop'
block sql | select * from U&"\0074able"
block sql | select pgmq.send('q', '{}')
block sql | select "pgmq"."delete"('q', 1)
block sql | select pgmq.read('q', 30, 1)
block sql | select * from dblink('host=x', 'delete from t') as t(x int)
block sql | select pg_stat_reset()
block sql | select pg_try_advisory_lock(1)
block sql | select net.http_post('https://x', '{}')
block sql | select cron.alter_job(1, schedule := '* * * * *')
pass sql | select msg_id from pgmq.q_jobs limit 5
pass sql | select 'U&' as label
residual sql (a user defined function with side effects is not inspected) | select my_function_that_writes()
# 10. Bash deny rules as defense in depth; Blaine still runs these himself.
deny (Bash(supabase db push:*)) | supabase db push
deny (Bash(npx supabase db push:*)) | npx supabase db push
deny (Bash(npm run db:push:*)) | npm run db:push
# 13. Residuals that stay visible.
residual (a symlink made earlier hides the target) | echo x > m/x.sql
residual (a path generated from file contents at run time is not known) | touch "$(cat /tmp/name)"
residual (git reset, stash, merge, pull and clean move many files at once and are not inspected) | git reset --hard origin/main
residual (a push of the current branch is not resolved, so a checked out main is not seen) | git push origin HEAD
residual (a gh alias made before the guard is not expanded) | gh m 1
residual (env -C changes directory without a cd the hook can follow) | env -C supabase/migrations touch x.sql
residual (an interpreter script file is not inspected) | node /tmp/w.js
`;

// Last round rows: the blocking findings from the independent review and the cross review, each with its allow rows.
const ROUND_13 = String.raw`
# 1. A generated file name inside a protected directory is still a write there; a word that is only a substitution stays a residual.
block | cat > supabase/migrations/$(date -u +%Y%m%d%H%M%S)_add_x.sql <<'EOF'⏎create table t();⏎EOF
block | cp /tmp/x.sql supabase/migrations/$(date +%Y%m%d%H%M%S)_x.sql
block | touch "supabase/migrations/$(date +%s)_x.sql"
block | mv /tmp/x.sql "supabase/migrations/$(date -u +%Y%m%d%H%M%S)_x.sql"
block | cp /tmp/e.mjs .claude/hooks/$(echo guard-migrations).mjs
block | echo x > "$(git rev-parse --show-toplevel)/supabase/migrations/x.sql"
pass | cp /tmp/x.sql "supabase/functions/$(date +%s)_x.ts"
pass | ls "$(git rev-parse --show-toplevel)/supabase/migrations"
pass | echo "$(date +%s)" > /tmp/stamp
# 2. A script run by path is read when its #! line names a shell, or it has no #! line and a shell name; a missing .sh fails closed.
block | $FIXTURE/push.sh
block | $FIXTURE/push-noshebang.sh
block | $FIXTURE/push-tool
block | chmod +x /tmp/p.sh && /tmp/p.sh
block fixture | ./push.sh
block fixture | ./bad.sh
pass fixture | ./clean.sh
pass | $FIXTURE/clean-tool
pass | ./node_modules/.bin/vitest run
residual (a script whose #! line names an interpreter other than a shell is not inspected) | $FIXTURE/push.py
# 3. curl: --url and --url=, bundled short options, and each --next transfer on its own.
block | curl --url=https://abc.supabase.co/rest/v1/jobs --json={}
block | curl --url https://abc.supabase.co/rest/v1/jobs -d '{}'
block | curl -sX DELETE https://abc.supabase.co/rest/v1/jobs
block | curl -sSLX PATCH https://abc.supabase.co/rest/v1/jobs -d '{}'
block | curl -sX PUT https://api.github.com/repos/o/r/pulls/1/merge
block | curl -I https://example.com --next --json={} https://abc.supabase.co/rest/v1/jobs
block | curl https://example.com -: -X DELETE https://abc.supabase.co/rest/v1/jobs
pass | curl -sX PUT https://api.github.com/repos/o/r/pulls/2/merge
pass | curl -sSL https://abc.supabase.co/rest/v1/jobs
pass | curl -X POST https://example.com -d x --next https://abc.supabase.co/rest/v1/jobs
pass | curl -sI https://abc.supabase.co/rest/v1/jobs
# 4. Attached -c text is checked; an option cluster such as -ce takes the next argument as the text.
block | bash -c'curl --json={} https://abc.supabase.co/rest/v1/jobs'
block | sh -c'supabase db push'
block | zsh -ce 'supabase db push'
block | dash -ec 'echo x > supabase/migrations/x.sql'
block | bash -o pipefail -c 'supabase db push'
block | sh -c 'echo x > "$1"' _ supabase/migrations/x.sql
pass | sh -ce 'git diff -- supabase/migrations'
pass | bash -c 'cat supabase/migrations/x.sql'
pass | bash -o pipefail -c 'git status'
# 5. supabase db diff with an attached -f.
block | supabase db diff -fx
block | supabase db diff --file=x
pass | supabase db diff
# 6. Agents never run the installer, by any route.
block | env -u CLAUDECODE node tools/guardrails/apply.mjs
block | node --import tsx tools/guardrails/apply.mjs
block | CLAUDECODE= node ./tools/guardrails/apply.mjs
block | cd tools/guardrails && node apply.mjs
block | ./tools/guardrails/apply.mjs
block | npx node tools/guardrails/apply.mjs
block fixture | npm run guard:apply
pass | cat tools/guardrails/apply.mjs
pass | node --test tools/guardrails/proposed/guard-migrations.node-test.mjs
# 7. git push to heads/main.
block | git push origin HEAD:heads/main
block | git push origin HEAD:refs/heads/main
pass | git push origin HEAD:heads/feature
# 8. gh api -F and --field values read from a file.
block | gh api graphql -F query=@$FIXTURE/merge-pr1.graphql
block | gh api graphql --field query=@$FIXTURE/merge-pr1.graphql
block | gh api graphql -F query=@/tmp/missing.graphql
pass | gh api graphql -F query=@$FIXTURE/viewer.graphql
pass | gh api graphql -f query=@literal-text
# 9. Reads that must pass after apply; their writing forms still block.
pass | psql -h 127.0.0.1 -p 54322 -U postgres -f supabase/migrations/x.sql
pass | npx eslint tools/guardrails
pass | npx prettier --check supabase/migrations
pass | sort supabase/migrations/x.sql -o /tmp/y
pass | sh -ce 'git diff -- supabase/migrations'
pass | git -c alias.review='diff -- supabase/migrations' review
block | psql -h 127.0.0.1 -o supabase/migrations/x.sql -c 'select 1'
block | npx eslint --fix tools/guardrails
block | npx prettier --write supabase/migrations
block | sort -o supabase/migrations/x.sql /tmp/a
block | git -c alias.p='push origin HEAD:main' p
block | git -c alias.p='!supabase db push' p
block | git -c alias.w='checkout main -- supabase/migrations' w
pass | git -c alias.l='!git log --oneline' l
# 10. Residuals that stay visible.
residual (inline interpreter code that builds a path by concatenation is not resolved) | node -e "require('fs').writeFileSync('supabase/'+'migrations/x.sql','')"
residual (inline interpreter code that builds a path by concatenation is not resolved) | python3 -c "import os; open(os.path.join('supabase','migrations','x.sql'),'w')"
residual (inline interpreter code that calls fetch or urllib is not inspected) | node -e "fetch('https://abc.supabase.co/rest/v1/jobs',{method:'POST',body:'{}'})"
residual (inline interpreter code that calls fetch or urllib is not inspected) | python3 -c "import urllib.request as u; u.urlopen(u.Request('https://abc.supabase.co/rest/v1/jobs', data=b'{}'))"
residual (a push refspec set in git config is not read) | git config remote.origin.push HEAD:main && git push
residual sql (Supabase shipped functions that write are not on the side effect list) | select realtime.send('{}'::jsonb, 'e', 't', false)
residual sql (Supabase shipped functions that write are not on the side effect list) | select pgsodium.create_key()
residual (env -C and env --chdir change directory without a cd the hook can follow) | env --chdir=supabase/migrations touch x.sql
residual (env -C and env --chdir change directory without a cd the hook can follow) | env -C supabase/migrations touch x.sql
residual fixture (after a cd to a generated or unresolved directory, a script run by a relative path is read from the directory before that cd) | cd "$OTHER" && ./clean.sh
`;

function tableRows(round, table) {
  return table.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#")).map((line) => {
    const at = line.indexOf(" | ");
    const head = /^(pass|block|deny|residual)(?: ([\w:]+))?(?: \((.*)\))?$/.exec(line.slice(0, at));
    if (at < 0 || !head) throw new Error(`malformed round ${String(round)} row: ${line}`);
    const [, verdict, kind = "", note] = head;
    const text = line.slice(at + 3).replaceAll("⏎", "\n").replaceAll("$FIXTURE", FIXTURE).replaceAll("$\\{", "${");
    let probe = text;
    if (kind.startsWith("fixture")) probe = inFixture(text, kind.split(":")[1] ?? "");
    else if (kind === "sql") probe = sql(text);
    else if (EDIT_TOOL_NAMES.has(kind)) probe = { tool_name: kind, tool_input: { file_path: text } };
    const expected = { pass: PASSES, block: HOOK_BLOCKS, deny: deny(note), residual: residual(note) }[verdict];
    return [round, probe, expected];
  });
}
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit"]);

// [QA round, probe (Bash command or { tool_name, tool_input }), expectation]
const PROBES = [
  [1, { tool_name: "Write", tool_input: { file_path: MIG } }, deny("Edit(/supabase/migrations/**)")],
  [1, { tool_name: "Edit", tool_input: { file_path: "./supabase/migrations/x.sql" } }, deny("Edit(/supabase/migrations/**)")],
  [1, { tool_name: "MultiEdit", tool_input: { file_path: "../repo/supabase/migrations/x.sql" } }, deny("Edit(/supabase/migrations/**)")],
  [1, { tool_name: "NotebookEdit", tool_input: { notebook_path: MIG } }, deny("Edit(/supabase/migrations/**)")],
  [1, "echo x > supabase/migrations/x.sql", HOOK_BLOCKS],
  [1, "echo x >> supabase/migrations/x.sql", HOOK_BLOCKS],
  [1, "cat <<'EOF' > supabase/migrations/x.sql\ncreate table t();\nEOF", HOOK_BLOCKS],
  [1, "echo x | tee supabase/migrations/x.sql", HOOK_BLOCKS],
  [1, "cp /tmp/x.sql supabase/migrations/", HOOK_BLOCKS],
  [1, "mv /tmp/x.sql ./supabase/migrations/x.sql", HOOK_BLOCKS],
  [1, "sed -i s/a/b/ supabase/migrations/x.sql", HOOK_BLOCKS],
  [1, "git mv a.sql supabase/migrations/a.sql", HOOK_BLOCKS],
  [1, "cd supabase/migrations && echo x > x.sql", HOOK_BLOCKS],
  [1, "echo x > /repo/supabase/migrations/x.sql", HOOK_BLOCKS],
  [1, "echo x > ../repo/supabase/migrations/x.sql", HOOK_BLOCKS],
  [1, "echo x > Supabase/Migrations/x.sql", HOOK_BLOCKS],
  [1, "npx supabase migration new x", HOOK_BLOCKS],
  [1, "supabase migration new x", HOOK_BLOCKS],
  [1, "python3 -c \"open('supabase/migrations/x.sql','w')\"", HOOK_BLOCKS],
  [1, "node -e \"require('fs').writeFileSync('supabase/migrations/x.sql','')\"", HOOK_BLOCKS],
  [1, "cp -r /tmp/tree supabase", HOOK_BLOCKS],
  [1, "ln -s supabase/migrations m", HOOK_BLOCKS],
  [1, "echo x > m/x.sql", residual("a symlink made earlier hides the target")],
  [1, "gh pr edit --add-label blaine-window", LABEL_RETIRED],
  [1, "cp /tmp/index.ts supabase/functions/x/index.ts", PASSES],
  [1, "ls -la supabase", PASSES],
  [2, "yarn supabase migration new x", HOOK_BLOCKS],
  [2, "npm run supabase -- migration new x", HOOK_BLOCKS],
  [2, "supabase db diff -f x", HOOK_BLOCKS],
  [2, "supabase db push", HOOK_BLOCKS],
  [2, "supabase migration up", PASSES],
  [2, "supabase migration up --linked", HOOK_BLOCKS],
  [2, "git checkout br -- supabase/migrations/x.sql", HOOK_BLOCKS],
  [2, "git restore --source=main supabase/migrations/x.sql", HOOK_BLOCKS],
  [2, "git apply x.patch", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  [2, "git am x.mbox", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  [2, "patch -p1 < x.patch", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  [2, "tar -xf a.tar -C supabase/migrations", HOOK_BLOCKS],
  [2, "tar -xf a.tar", residual("archive contents are not inspected")],
  [2, "unzip a.zip -d supabase/migrations", HOOK_BLOCKS],
  [2, "perl -e 'open F, \">supabase/migrations/x.sql\"'", HOOK_BLOCKS],
  [2, "ruby -e 'File.write(\"supabase/migrations/x.sql\", \"\")'", HOOK_BLOCKS],
  [2, "eval 'echo x > supabase/migrations/x.sql'", HOOK_BLOCKS],
  [2, "D=supabase/migrations; echo x > $D/x.sql", HOOK_BLOCKS],
  [2, "echo 'echo x > supabase/migrations/x.sql' > /tmp/w.sh", HOOK_BLOCKS],
  [2, "sh /tmp/w.sh", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  [2, "curl -X POST https://api.github.com/repos/o/r/issues/664/labels -d '{\"labels\":[\"blaine-window\"]}'", LABEL_RETIRED],
  [2, "L=blaine-window; gh pr edit --add-label $L", LABEL_RETIRED],
  [2, "git show br:supabase/migrations/x.sql", PASSES],
  [2, { tool_name: "mcp__github__issue_write", tool_input: { method: "update", issue_number: 664, labels: ["blaine-window"] } }, LABEL_RETIRED],
  [3, "cd supa\"base\"/mig*; echo x > x.sql", HOOK_BLOCKS],
  [3, "touch s*/m*/x.sql", HOOK_BLOCKS],
  [3, `echo ${B64} | base64 -d | sh`, HOOK_BLOCKS],
  [3, `gh pr edit 664 --add-label "$(echo YmxhaW5lLXdpbmRvdw== | base64 -d)"`, LABEL_RETIRED],
  [3, { tool_name: "mcp__supabase__apply_migration", tool_input: { name: "x", query: "create table t()" } }, deny("mcp__supabase__apply_migration")],
  [3, { tool_name: "mcp__Supabase__apply_migration", tool_input: { name: "x", query: "create table t()" } }, deny("mcp__Supabase__apply_migration")],
  [3, "git commit -m 'docs: explain migration policy'", PASSES],
  [3, "npx vitest run src/migration.test.ts", PASSES],
  [4, "touch supabase/migr?tions/x.sql", HOOK_BLOCKS],
  [4, "touch supabase/{migrations,x}/a.sql", HOOK_BLOCKS],
  [4, "echo supabase/migrations/x.sql | xargs touch", HOOK_BLOCKS],
  [4, "sh <<EOF\necho x > supabase/migrations/x.sql\nEOF", HOOK_BLOCKS],
  [4, "bash <<'EOF'\necho x > supabase/migrations/x.sql\nEOF", HOOK_BLOCKS],
  [4, "echo hi | zsh", HOOK_BLOCKS],
  [4, "python3 - <<'EOF'\nopen('supabase/migrations/x.sql', 'w')\nEOF", HOOK_BLOCKS],
  [4, { tool_name: "mcp__github__push_files", tool_input: { files: [{ path: "supabase/migrations/x.sql", content: "" }] } }, HOOK_BLOCKS],
  [4, { tool_name: "mcp__github__create_or_update_file", tool_input: { path: "supabase/migrations/x.sql", content: "" } }, HOOK_BLOCKS],
  [4, { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "drop table t" } }, HOOK_BLOCKS],
  [4, "touch [s]upabase/[m]igrations/x.sql", HOOK_BLOCKS],
  [4, "touch s[u]pa*/mig*/x.sql", HOOK_BLOCKS],
  [4, "touch supa{base,}/migrations/x.sql", HOOK_BLOCKS],
  [4, `echo ${B64} | base64 -d | dash`, HOOK_BLOCKS],
  [4, "git commit -m 'fix supabase migration naming docs'", PASSES],
  [4, "head -5 supabase/migrations/a.sql", PASSES],
  [4, "wc -l supabase/migrations/*.sql", PASSES],
  [4, "echo hi | sh", HOOK_BLOCKS],
  [4, "bash < /tmp/w.sh", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  [4, "source /tmp/w.sh", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  [4, ". /tmp/w.sh", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  [4, "cat /tmp/w.py | python3", residual("plain text piped into a non shell interpreter is not inspected")],
  [4, "node < /tmp/w.js", residual("an interpreter reading a script file is not inspected")],
  [5, "git commit -m 'fix supabase client retry'", PASSES],
  [5, 'git commit -m "chore: update supabase types"', PASSES],
  [5, "git blame supabase/migrations/a.sql", PASSES],
  [5, "diff supabase/migrations/a.sql /tmp/b.sql", PASSES],
  [5, "find supabase/migrations -name '*.sql'", PASSES],
  [5, "sort supabase/migrations/a.sql", PASSES],
  [5, "cat supabase/migrations/a.sql | sort | uniq", PASSES],
  [5, "less +'!touch x' supabase/migrations/a.sql", HOOK_BLOCKS],
  [5, "echo hi | tcsh", HOOK_BLOCKS],
  [5, "echo hi | csh", HOOK_BLOCKS],
  [5, "echo hi | fish", HOOK_BLOCKS],
  [6, 'git commit -m "$(touch supabase/migrations/a.sql)"', HOOK_BLOCKS],
  [6, "git commit -m `touch supabase/migrations/a.sql`", HOOK_BLOCKS],
  [6, "git commit -m x --file=supabase/migrations/a.sql", HOOK_BLOCKS],
  [6, 'git commit -m x -m "$(cp a supabase/migrations/)"', HOOK_BLOCKS],
  [6, "find supabase/migrations -exec rm {} \\;", HOOK_BLOCKS],
  [6, "find supabase/migrations -execdir rm {} \\;", HOOK_BLOCKS],
  [6, "find supabase/migrations -ok rm {} \\;", HOOK_BLOCKS],
  [6, "find supabase/migrations -delete", HOOK_BLOCKS],
  [6, "find . -fprint supabase/migrations/x", HOOK_BLOCKS],
  [6, "find . -fprintf supabase/migrations/x %p", HOOK_BLOCKS],
  [6, "find . -fls supabase/migrations/x", HOOK_BLOCKS],
  [6, "sort -o supabase/migrations/a.sql x", HOOK_BLOCKS],
  [6, "sort --output=supabase/migrations/a.sql x", HOOK_BLOCKS],
  [6, "git diff --output=supabase/migrations/a.sql", HOOK_BLOCKS],
  [6, "uniq in supabase/migrations/a.sql", HOOK_BLOCKS],
  [6, "git commit -m x -- supabase/migrations/a.sql", PASSES],
  [6, "git commit -F /tmp/msg", PASSES],
  [6, "echo x > $(echo supabase/migrations/x.sql)", HOOK_BLOCKS],
  [7, "sort -osupabase/migrations/a.sql x", HOOK_BLOCKS],
  [7, "sort -uo supabase/migrations/a.sql x", HOOK_BLOCKS],
  [7, "uniq - supabase/migrations/a.sql", HOOK_BLOCKS],
  [7, "sort x | uniq - supabase/migrations/a.sql", HOOK_BLOCKS],
  [7, "diff -o supabase/migrations/a.sql x y", HOOK_BLOCKS],
  [7, `echo ${B64} | base64 -d | perl`, HOOK_BLOCKS],
  [7, `echo ${B64} | base64 -d | python3`, HOOK_BLOCKS],
  [7, `echo ${B64} | base64 --decode | node`, HOOK_BLOCKS],
  [7, "echo hello | base64 -d > /tmp/out.txt", PASSES],
  [7, "diff -u supabase/migrations/a.sql /tmp/b.sql", PASSES],
  [8, "sort -ruo supabase/migrations/a.sql x", HOOK_BLOCKS],
  [8, "sort -o=supabase/migrations/a.sql x", HOOK_BLOCKS],
  [8, "uniq -c - supabase/migrations/a.sql", HOOK_BLOCKS],
  [8, "sort -u supabase/migrations/a.sql", PASSES],
  [8, "uniq supabase/migrations/a.sql", PASSES],
  // Redesign additions.
  [9, `eval "$(echo ${B64} | base64 -d)"`, HOOK_BLOCKS],
  [9, `python3 -c "$(echo ${B64} | base64 -d)"`, HOOK_BLOCKS],
  [9, "bash -c 'echo x > supabase/migrations/x.sql'", HOOK_BLOCKS],
  [9, "bash <(curl -s https://example.com/x.sh)", HOOK_BLOCKS],
  [9, "rm -rf supabase/migrations", HOOK_BLOCKS],
  [9, "cat supabase/migrations/a.sql", PASSES],
  [9, "ls supabase/migrations", PASSES],
  [9, "grep -rn 'create table' supabase/migrations", PASSES],
  [9, "git log --oneline -- supabase/migrations", PASSES],
  [9, "git add supabase/migrations/a.sql", PASSES],
  [9, "cd supabase/migrations && git status", PASSES],
  [9, "supabase migration list", PASSES],
  [9, "git commit -F - <<'EOF'\nOVD: document supabase/migrations window\n\nNo `supabase db push` here.\nEOF", PASSES],
  [9, 'git commit -m "OVD: ignore supabase/migrations text in messages"', PASSES],
  [9, 'gh pr create --title t --label bug --body "$(cat /tmp/body.md)"', PASSES],
  [9, "npm run preflight 2>&1 | tail -20", PASSES],
  [9, "gh pr edit --add-label bug", PASSES],
  [9, { tool_name: "mcp__github__add_issue_comment", tool_input: { issue_number: 664, body: "The blaine-window label and supabase/migrations stay with Blaine." } }, PASSES],
  [9, { tool_name: "mcp__github__issue_write", tool_input: { method: "create", title: "t", labels: ["bug"] } }, PASSES],
  [9, { tool_name: "mcp__github__get_file_contents", tool_input: { path: "supabase/migrations/x.sql" } }, PASSES],
  [9, { tool_name: "Read", tool_input: { file_path: MIG } }, PASSES],
  // Round 10: the six blockers from the review of PR #691.
  // Blocker 1: every Supabase server name, server agnostic suffix check, read only execute_sql.
  [10, mcp("mcp__claude_ai_Supabase__apply_migration", { name: "x", query: "create table t()" }), deny("mcp__*__apply_migration")],
  [10, mcp("mcp__claude_ai_Supabase__apply_migration", { name: "x", query: "create table t()" }), HOOK_BLOCKS],
  [10, mcp("mcp__plugin_supabase_supabase__apply_migration", { name: "x", query: "select 1" }), HOOK_BLOCKS],
  [10, mcp(`mcp__${SUPABASE_UUID}__apply_migration`, { name: "x", query: "select 1" }), HOOK_BLOCKS],
  [10, mcp("mcp__renamed_db__apply_migration", { name: "x", query: "select 1" }), HOOK_BLOCKS],
  [10, mcp("mcp__claude_ai_Supabase__create_branch", { project_id: "p", name: "b" }), deny("mcp__*upabase*__create_branch")],
  [10, mcp("mcp__claude_ai_Supabase__create_branch", { project_id: "p", name: "b" }), HOOK_BLOCKS],
  [10, mcp(`mcp__${SUPABASE_UUID}__create_branch`, { project_id: "p", name: "b" }), HOOK_BLOCKS],
  [10, mcp("mcp__renamed_db__create_project", { organization_id: "o", name: "p" }), HOOK_BLOCKS],
  [10, mcp("mcp__renamed_db__pause_project", { project_id: "p" }), HOOK_BLOCKS],
  [10, mcp("mcp__renamed_db__merge_branch", { branch_id: "b" }), HOOK_BLOCKS],
  [10, mcp("mcp__plugin_supabase_supabase__deploy_edge_function", { project_id: "p", name: "f" }), HOOK_BLOCKS],
  [10, mcp("mcp__claude_ai_Supabase__create_edge_function_secret", { project_id: "p" }), HOOK_BLOCKS],
  [10, mcp("mcp__github__create_branch", { owner: "o", repo: "r", branch: "b" }), PASSES],
  [10, mcp("mcp__github__delete_file", { owner: "o", repo: "r", path: "src/a.ts" }), PASSES],
  [10, mcp(`mcp__${VERCEL_UUID}__create_project`, { name: "site", teamId: "t" }), PASSES],
  [10, mcp(`mcp__${VERCEL_UUID}__pause_project`, { projectId: "p", teamId: "t" }), PASSES],
  [10, mcp("mcp__claude_ai_Supabase__list_tables", { project_id: "p" }), PASSES],
  [10, sql("select id, status from jobs where status = 'queued' limit 5"), PASSES],
  [10, sql("SELECT count(*) FROM parts;"), PASSES],
  [10, sql("with q as (select * from jobs) select count(*) from q"), PASSES],
  [10, sql("explain select * from jobs", SUPABASE_UUID), PASSES],
  [10, sql("show search_path", "supabase"), PASSES],
  [10, sql("table jobs", "Supabase"), PASSES],
  [10, sql("-- drop table jobs\nselect 'delete; update' as note, \"update\" from t /* insert */"), PASSES],
  [10, sql("select updated_at, created_by from jobs"), PASSES],
  [10, sql("select $$drop table t$$ as text"), PASSES],
  [10, sql("drop table jobs"), HOOK_BLOCKS],
  [10, sql("select 1; drop table jobs"), HOOK_BLOCKS],
  [10, sql("select 1;; "), HOOK_BLOCKS],
  [10, sql("insert into jobs values (1)"), HOOK_BLOCKS],
  [10, sql("update jobs set status = 'x'"), HOOK_BLOCKS],
  [10, sql("delete from jobs", SUPABASE_UUID), HOOK_BLOCKS],
  [10, sql("with d as (delete from jobs returning *) select * from d"), HOOK_BLOCKS],
  [10, sql("with u as (update jobs set x = 1 returning *) select 1"), HOOK_BLOCKS],
  [10, sql("explain analyze select * from jobs"), HOOK_BLOCKS],
  [10, sql("explain (analyze, buffers) select 1"), HOOK_BLOCKS],
  [10, sql("select * into jobs_copy from jobs"), HOOK_BLOCKS],
  [10, sql("select nextval('jobs_id_seq')"), HOOK_BLOCKS],
  [10, sql("select set_config('role', 'postgres', false)"), HOOK_BLOCKS],
  [10, sql("select pg_terminate_backend(123)"), HOOK_BLOCKS],
  [10, sql("set role postgres"), HOOK_BLOCKS],
  [10, sql("do $$ begin perform 1; end $$"), HOOK_BLOCKS],
  [10, sql("comment on table jobs is 'x'"), HOOK_BLOCKS],
  [10, sql("security label on table jobs is 'x'"), HOOK_BLOCKS],
  [10, sql("create table t (id int)"), HOOK_BLOCKS],
  [10, sql("alter table jobs add column x int"), HOOK_BLOCKS],
  [10, sql("grant all on jobs to anon"), HOOK_BLOCKS],
  [10, sql("truncate jobs"), HOOK_BLOCKS],
  [10, sql("copy jobs to stdout"), HOOK_BLOCKS],
  [10, sql("call refresh_things()"), HOOK_BLOCKS],
  [10, sql("refresh materialized view v"), HOOK_BLOCKS],
  [10, sql("vacuum jobs"), HOOK_BLOCKS],
  [10, sql("lock table jobs"), HOOK_BLOCKS],
  [10, sql("merge into jobs using src on true when matched then delete"), HOOK_BLOCKS],
  [10, sql("select 'unterminated"), HOOK_BLOCKS],
  [10, sql(""), HOOK_BLOCKS],
  [10, mcp("mcp__claude_ai_Supabase__execute_sql", { project_id: "p" }), HOOK_BLOCKS],
  [10, sql("select my_function_that_writes()"), residual("a user defined function with side effects is not inspected")],
  // Blocker 2: worktree paths for every file edit tool.
  [10, { tool_name: "Write", tool_input: { file_path: WORKTREE_MIG } }, deny("Edit(//**/supabase/migrations/**)")],
  [10, { tool_name: "Write", tool_input: { file_path: WORKTREE_MIG } }, HOOK_BLOCKS],
  [10, { tool_name: "Edit", tool_input: { file_path: WORKTREE_MIG } }, HOOK_BLOCKS],
  [10, { tool_name: "MultiEdit", tool_input: { file_path: WORKTREE_MIG } }, HOOK_BLOCKS],
  [10, { tool_name: "NotebookEdit", tool_input: { notebook_path: WORKTREE_MIG } }, HOOK_BLOCKS],
  [10, { tool_name: "Write", tool_input: { file_path: MIG } }, HOOK_BLOCKS],
  [10, { tool_name: "Edit", tool_input: { file_path: "supabase/migrations/x.sql" } }, HOOK_BLOCKS],
  [10, { tool_name: "Edit", tool_input: { file_path: "/home/u/other/Supabase/Migrations/x.sql" } }, HOOK_BLOCKS],
  [10, { tool_name: "Edit", tool_input: { file_path: "/repo/src/lib/supabase/client.ts" } }, PASSES],
  [10, { tool_name: "Write", tool_input: { file_path: "/repo/docs/supabase-migrations.md" } }, PASSES],
  [10, { tool_name: "Edit", tool_input: { file_path: "/repo/supabase/functions/x/index.ts" } }, PASSES],
  // Blocker 3: merges and auto merges block only when the PR changes supabase/migrations/ (fake lookup: PR 1 does, PR 2 does not, PR 3 fails).
  [10, mcp("mcp__github__merge_pull_request", { owner: "o", repo: "r", pullNumber: 1 }), HOOK_BLOCKS],
  [10, mcp("mcp__github__merge_pull_request", { owner: "o", repo: "r", pullNumber: 2 }), PASSES],
  [10, mcp("mcp__github__merge_pull_request", { owner: "o", repo: "r", pullNumber: 3 }), HOOK_BLOCKS],
  [10, mcp("mcp__github__merge_pull_request", { owner: "o", repo: "r" }), HOOK_BLOCKS],
  [10, mcp("mcp__github__enable_pr_auto_merge", { owner: "o", repo: "r", pullNumber: 1 }), HOOK_BLOCKS],
  [10, mcp("mcp__github__enable_pr_auto_merge", { owner: "o", repo: "r", pullNumber: 2 }), PASSES],
  [10, mcp("mcp__github__enable_pr_auto_merge", { owner: "o", repo: "r", pullNumber: 3 }), HOOK_BLOCKS],
  [10, mcp("mcp__github__disable_pr_auto_merge", { owner: "o", repo: "r", pullNumber: 1 }), PASSES],
  [10, mcp("mcp__claude_ai_GitHub__merge_pull_request", { owner: "o", repo: "r", pull_number: 1 }), HOOK_BLOCKS],
  [10, "gh pr merge 1 --squash", HOOK_BLOCKS],
  [10, "gh pr merge 2 --squash --delete-branch", PASSES],
  [10, "gh pr merge 3", HOOK_BLOCKS],
  [10, "gh pr merge --auto --squash 1", HOOK_BLOCKS],
  [10, "gh pr merge --auto --squash 2", PASSES],
  [10, "gh pr merge -m 1", HOOK_BLOCKS],
  [10, "gh pr merge -s -t 'squash title' -b 'body text' 1", HOOK_BLOCKS],
  [10, "gh pr merge https://github.com/o/r/pull/1 --admin", HOOK_BLOCKS],
  [10, "gh pr merge", PASSES],
  [10, "gh pr merge --disable-auto 1", PASSES],
  [10, "gh api -X PUT repos/o/r/pulls/1/merge", HOOK_BLOCKS],
  [10, "gh api -X PUT repos/o/r/pulls/2/merge -f merge_method=squash", PASSES],
  [10, "gh api --method PUT /repos/{owner}/{repo}/pulls/1/merge -f merge_method=squash", HOOK_BLOCKS],
  [10, "gh api repos/o/r/pulls/1/merge -f merge_method=squash", HOOK_BLOCKS],
  [10, "gh api -XPUT repos/o/r/pulls/3/merge", HOOK_BLOCKS],
  [10, "gh api -X PUT repos/o/r/pulls/1/auto_merge", HOOK_BLOCKS],
  [10, "gh api repos/o/r/pulls/1/merge", PASSES],
  [10, "gh api -X PUT repos/o/r/pulls/1/ccr/auto_merge", HOOK_BLOCKS],
  [10, "gh api -X PUT /repos/{owner}/{repo}/pulls/2/ccr/auto_merge", PASSES],
  [10, "gh api -X DELETE repos/o/r/pulls/1/ccr/auto_merge", PASSES],
  [10, "curl -X PUT https://api.github.com/repos/o/r/pulls/1/ccr/auto_merge", HOOK_BLOCKS],
  [10, "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"X\"}) { clientMutationId } }'", HOOK_BLOCKS],
  [10, "gh api graphql -f query='query { viewer { login } }'", PASSES],
  [10, "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/1/merge", HOOK_BLOCKS],
  [10, "gh api graphql --input /tmp/merge.json", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  // Blocker 4: package.json scripts are resolved and checked; local only commands pass.
  [10, inFixture("npm run db:push"), HOOK_BLOCKS],
  [10, inFixture("npm run-script db:push"), HOOK_BLOCKS],
  [10, inFixture("yarn db:push"), HOOK_BLOCKS],
  [10, inFixture("yarn run db:push"), HOOK_BLOCKS],
  [10, inFixture("pnpm db:push"), HOOK_BLOCKS],
  [10, inFixture("pnpm run db:push"), HOOK_BLOCKS],
  [10, inFixture("npm run nested"), HOOK_BLOCKS],
  [10, inFixture("npm run mig"), HOOK_BLOCKS],
  [10, inFixture("npm run deploy"), HOOK_BLOCKS],
  [10, inFixture("cd scripts && npm run db:push"), HOOK_BLOCKS],
  [10, inFixture("npm run db:reset"), PASSES],
  [10, inFixture("npm run e2e:prepare"), PASSES],
  [10, inFixture("npm test"), PASSES],
  [10, inFixture("npm run unknown-script"), PASSES],
  [10, "npx supabase db push", HOOK_BLOCKS],
  [10, "pnpm dlx supabase db push", HOOK_BLOCKS],
  [10, "supabase db pull", HOOK_BLOCKS],
  [10, "supabase db reset --linked", HOOK_BLOCKS],
  [10, "supabase db reset --db-url postgres://u@h/db", HOOK_BLOCKS],
  [10, "supabase functions deploy engineering-worker", HOOK_BLOCKS],
  [10, "supabase secrets set X=1", HOOK_BLOCKS],
  [10, "supabase db reset", PASSES],
  [10, "npx supabase db reset", PASSES],
  [10, "supabase start", PASSES],
  // Blocker 5: false positives.
  [10, 'gh pr create --title "OVD: fix" --body "Touches supabase/migrations/x.sql only in prose"', PASSES],
  [10, "gh pr comment 691 -b 'superseded; see supabase/migrations/ policy'", PASSES],
  [10, "gh issue create -t 'supabase/migrations cleanup' -b x", PASSES],
  [10, "gh pr review 1 --comment --body=supabase/migrations/x.sql", PASSES],
  [10, "gh release create v1 --notes 'supabase/migrations changed'", PASSES],
  [10, "gh pr edit 1 --title 'Move supabase/migrations docs'", PASSES],
  [10, "npx supabase --version", PASSES],
  [10, "npx supabase gen types typescript --local", PASSES],
  [10, "npx supabase status", PASSES],
  [10, "gh search code supabase", PASSES],
  [10, "echo *", PASSES],
  [10, "gh api -X PUT repos/o/r/contents/supabase/migrations/x.sql -f content=eA==", HOOK_BLOCKS],
  [10, "rm -rf supabase", HOOK_BLOCKS],
  // The $( heredoc parse edge case: a ) inside the heredoc body no longer ends the substitution.
  [10, "git commit -m \"$(cat <<'EOF'\nOVD: list\n\n1) first item\n2) second item\nEOF\n)\"", PASSES],
  [10, "echo \"$(cat <<'EOF'\n1) item\nEOF\n)\" > supabase/migrations/x.sql", HOOK_BLOCKS],
  [10, "echo \"$(cat <<'EOF'\n1) item\nEOF\n)\" && touch supabase/migrations/x.sql", HOOK_BLOCKS],
  // Residuals added in round 10.
  [10, "env -C supabase/migrations touch x.sql", residual("env -C changes directory without a cd the hook can follow")],
  [10, "gh api repos/o/r/git/trees --input /tmp/tree.json", HOOK_BLOCKS], // residual closed in round 11: an unreadable file fails closed
  [10, "gh api -X PUT repos/o/r/pulls/1/merge --input /tmp/body.json", HOOK_BLOCKS],
  // Round 11: the lead's review of 05f5644 and the Codex bypass hypotheses, each probed before fixing.
  // Scripts resolve from --prefix, -C, --dir and --cwd; a repeated (directory, script) pair is checked once.
  [11, inFixture("npm run db:push", "safe"), PASSES],
  [11, inFixture("npm --prefix .. run db:push", "safe"), HOOK_BLOCKS],
  [11, inFixture("npm --prefix=.. run db:push", "safe"), HOOK_BLOCKS],
  [11, inFixture(`pnpm -C ${FIXTURE} db:push`, "safe"), HOOK_BLOCKS],
  [11, inFixture("pnpm --dir .. run db:push", "safe"), HOOK_BLOCKS],
  [11, inFixture("yarn --cwd .. db:push", "safe"), HOOK_BLOCKS],
  [11, inFixture("npm --prefix safe run db:push"), PASSES],
  [11, inFixture("npm run loop-a"), PASSES],
  // PR text, review comments and reads of migration paths pass on the REST and MCP routes; content writes block.
  [11, "gh api repos/o/r/issues/5/comments -f body='see supabase/migrations/x.sql'", PASSES],
  [11, "gh api repos/o/r/pulls/5/comments -f path=supabase/migrations/x.sql -f body=nit -f commit_id=abc -F line=3", PASSES],
  [11, "gh api -X PATCH repos/o/r/pulls/5 -f body='mentions supabase/migrations and .claude/hooks'", PASSES],
  [11, "gh api repos/o/r/contents/supabase/migrations", PASSES],
  [11, "gh api -X DELETE repos/o/r/contents/supabase/migrations/x.sql -f sha=abc -f message=x", HOOK_BLOCKS],
  [11, "gh api -X PUT repos/o/r/contents/.claude/settings.json -f content=e30=", HOOK_BLOCKS],
  [11, "gh api repos/o/r/git/trees -f 'tree[][path]=supabase/migrations/x.sql' -f 'tree[][mode]=100644'", HOOK_BLOCKS],
  [11, `gh api repos/o/r/git/trees --input ${FIXTURE}/tree.json`, PASSES],
  [11, mcp("mcp__github__add_comment_to_pending_review", { owner: "o", repo: "r", pullNumber: 5, path: "supabase/migrations/x.sql", body: "nit", subjectType: "LINE", line: 3 }), PASSES],
  [11, mcp("mcp__github__add_reply_to_pull_request_comment", { owner: "o", repo: "r", pullNumber: 5, commentId: 1, body: "supabase/migrations/x.sql is fine" }), PASSES],
  [11, mcp("mcp__github__delete_file", { owner: "o", repo: "r", path: "supabase/migrations/x.sql", message: "x", branch: "b" }), HOOK_BLOCKS],
  [11, mcp("mcp__github__create_or_update_file", { owner: "o", repo: "r", path: ".claude/hooks/guard-migrations.mjs", content: "", message: "x", branch: "b" }), HOOK_BLOCKS],
  // Codex CRITICAL: the guard files themselves.
  [11, { tool_name: "Write", tool_input: { file_path: "/repo/.claude/hooks/guard-migrations.mjs" } }, deny("Edit(/.claude/hooks/**)")],
  [11, { tool_name: "Write", tool_input: { file_path: "/repo/.claude/hooks/guard-migrations.mjs" } }, HOOK_BLOCKS],
  [11, { tool_name: "Edit", tool_input: { file_path: "/repo/.claude/settings.json" } }, deny("Edit(/.claude/settings.json)")],
  [11, { tool_name: "Edit", tool_input: { file_path: "/repo/.claude/settings.json" } }, HOOK_BLOCKS],
  [11, { tool_name: "Write", tool_input: { file_path: "/repo/.claude/settings.local.json" } }, HOOK_BLOCKS],
  [11, { tool_name: "Edit", tool_input: { file_path: "/repo/.claude/agents/implementer.md" } }, PASSES],
  [11, "printf 'process.exit(0)' > .claude/hooks/guard-migrations.mjs", HOOK_BLOCKS],
  [11, "echo '{}' > .claude/settings.json", HOOK_BLOCKS],
  [11, "cp /tmp/h.mjs .claude/hooks/guard-migrations.mjs", HOOK_BLOCKS],
  [11, "mv /tmp/s.json .claude/settings.local.json", HOOK_BLOCKS],
  [11, "sed -i s/2/0/ .claude/hooks/guard-migrations.mjs", HOOK_BLOCKS],
  [11, "echo '{\"disableAllHooks\":true}' | tee ~/.claude/settings.json", HOOK_BLOCKS],
  [11, "rm -rf .claude", HOOK_BLOCKS],
  [11, "git checkout main -- .claude/hooks", HOOK_BLOCKS],
  [11, "python3 -c \"open('.claude/settings.json','w')\"", HOOK_BLOCKS],
  [11, "cat .claude/settings.json", PASSES],
  [11, "node --test .claude/hooks/guard-migrations.node-test.mjs", PASSES],
  [11, "node tools/guardrails/apply.mjs", HOOK_BLOCKS], // closed in the last round: agents never run the installer, by any route
  // Codex HIGH: Postgres clients against hosts that are not local, and HTTP writes to Supabase APIs.
  [11, "psql \"$DATABASE_URL\" -c 'CREATE TABLE t (id int)'", HOOK_BLOCKS],
  [11, "psql \"$DATABASE_URL\" -c 'select count(*) from jobs'", PASSES],
  [11, "psql postgres://u:p@db.abc.supabase.co:5432/postgres -f x.sql", HOOK_BLOCKS],
  [11, "psql -h db.abc.supabase.co -U postgres", HOOK_BLOCKS],
  [11, "PGHOST=db.abc.supabase.co psql -c 'delete from t'", HOOK_BLOCKS],
  [11, "pg_restore -d postgres://u@db.abc.supabase.co/postgres dump.sql", HOOK_BLOCKS],
  [11, "psql -h localhost -U postgres -c 'drop table t'", PASSES],
  [11, "psql postgres://postgres@127.0.0.1:54322/postgres -f seed.sql", PASSES],
  [11, "pg_dump \"$DATABASE_URL\" --schema-only", PASSES],
  [11, "curl -X POST \"$SUPABASE_URL/rest/v1/jobs\" -H \"apikey: $KEY\" -d '{}'", HOOK_BLOCKS],
  [11, "curl -X PATCH 'https://abc.supabase.co/rest/v1/jobs?id=eq.1' -d '{}'", HOOK_BLOCKS],
  [11, "curl -d @x.json https://abc.supabase.co/rest/v1/rpc/fn", HOOK_BLOCKS],
  [11, "http PATCH https://abc.supabase.co/rest/v1/jobs id=1", HOOK_BLOCKS],
  [11, "curl \"$SUPABASE_URL/rest/v1/jobs?select=id\" -H \"apikey: $KEY\"", PASSES],
  [11, "curl -X POST http://127.0.0.1:54321/rest/v1/jobs -d '{}'", PASSES],
  [11, "curl -X POST https://example.com/api -d x", PASSES],
  // Codex HIGH: git writes whose pathspec could cover supabase/migrations, and patches that name it.
  [11, "git restore --source=HEAD~3 -- .", HOOK_BLOCKS],
  [11, "git checkout main -- .", HOOK_BLOCKS],
  [11, "git checkout .", HOOK_BLOCKS],
  [11, "cd supabase && git checkout main -- .", HOOK_BLOCKS],
  [11, "git checkout main -- ':/'", HOOK_BLOCKS],
  [11, `git apply ${FIXTURE}/mig.patch`, HOOK_BLOCKS],
  [11, `patch -p1 < ${FIXTURE}/mig.patch`, HOOK_BLOCKS],
  [11, "git restore src/a.ts", PASSES],
  [11, "git checkout main", PASSES],
  [11, "git checkout -b feature/x", PASSES],
  [11, "git checkout main -- src/a.ts", PASSES],
  [11, `git apply ${FIXTURE}/clean.patch`, PASSES],
  [11, "git apply --check /tmp/nope.patch", PASSES],
  [11, "git am --abort", PASSES],
  [11, `patch -p1 < ${FIXTURE}/clean.patch`, PASSES],
  [11, "git reset --hard origin/main", residual("git reset, stash, merge, pull and clean move many files at once and are not inspected")],
  // Codex HIGH: merge evidence bound to the right repository and head.
  [11, "GH_REPO=other/repo gh pr merge 2", HOOK_BLOCKS],
  [11, "export GH_REPO=other/repo; gh pr merge 2 --squash", HOOK_BLOCKS],
  [11, "gh pr merge 2 -R other/repo", HOOK_BLOCKS],
  [11, "GH_REPO=other/repo gh api -X PUT repos/{owner}/{repo}/pulls/2/merge", HOOK_BLOCKS],
  [11, "gh pr merge 5 --squash --match-head-commit abc123", PASSES],
  [11, "gh pr merge 5 --squash --match-head-commit def456", HOOK_BLOCKS],
  [11, mcp("mcp__github__merge_pull_request", { owner: "o", repo: "r", pullNumber: 5, sha: "abc123" }), PASSES],
  [11, mcp("mcp__github__merge_pull_request", { owner: "o", repo: "r", pullNumber: 5, sha: "def456" }), HOOK_BLOCKS],
  [11, "gh pr merge 5 --squash", residual("without a named head SHA, a push between the file check and the merge is not seen")],
  [11, "gh api -X PUT repos/o/r/pulls/1/merge/", HOOK_BLOCKS],
  [11, mcp("mcp__ecb491b0-f98d-43cc-984c-f68b506a5353__merge_diff", { urlOrId: "https://github.com/o/r/pull/1" }), HOOK_BLOCKS],
  [11, mcp("mcp__Linear__merge_diff", { urlOrId: "https://github.com/o/r/pull/1" }), HOOK_BLOCKS],
  [11, mcp("mcp__Linear__merge_diff", { urlOrId: "https://github.com/o/r/pull/2" }), PASSES],
  [11, mcp("mcp__Linear__merge_diff", { urlOrId: "DIFF-123" }), HOOK_BLOCKS],
  [11, "gh alias set m 'pr merge'", HOOK_BLOCKS],
  [11, "gh alias list", PASSES],
  [11, "gh m 1", residual("a gh alias made before the guard is not expanded")],
  [11, `gh api graphql --input ${FIXTURE}/merge.json`, HOOK_BLOCKS],
  [11, `gh api graphql --input ${FIXTURE}/viewer.json`, PASSES],
  // Codex HIGH, document or fix: assignment order, ANSI C quoting, scripts run by a shell, npx and npm exec forms, quoted SQL names.
  [11, 'D=supabase/migrations; echo x > "$D/x.sql"; D=/tmp', HOOK_BLOCKS],
  [11, 'D=/tmp; echo x > "$D/x.sql"; D=supabase/migrations', PASSES],
  [11, "echo x > $'\\x73upabase/migrations/x.sql'", HOOK_BLOCKS],
  [11, "touch $'supabase\\x2fmigrations/x.sql'", HOOK_BLOCKS],
  [11, "echo $'line one\\nline two'", PASSES],
  [11, `bash ${FIXTURE}/clean.sh`, PASSES],
  [11, `bash ${FIXTURE}/bad.sh`, HOOK_BLOCKS],
  [11, `source ${FIXTURE}/bad.sh`, HOOK_BLOCKS],
  [11, `sh < ${FIXTURE}/bad.sh`, HOOK_BLOCKS],
  [11, "bash scripts/does-not-exist.sh", HOOK_BLOCKS],
  [11, "npx -c 'supabase db push'", HOOK_BLOCKS],
  [11, "npm exec -c 'supabase db push'", HOOK_BLOCKS],
  [11, "npx -p supabase supabase db push", HOOK_BLOCKS],
  [11, "npx -p supabase db push", HOOK_BLOCKS],
  [11, "npx -c 'supabase status'", PASSES],
  [11, sql("select \"setval\"('s', 1)"), HOOK_BLOCKS],
  [11, sql("select \"pg_terminate_backend\"(1)"), HOOK_BLOCKS],
  [11, sql("select pg_catalog.\"setval\"('s', 1)"), HOOK_BLOCKS],
  [11, sql("select graphql.resolve('mutation { deleteFromJobsCollection { affectedCount } }')"), HOOK_BLOCKS],
  [11, sql("select vault.create_secret('x')"), HOOK_BLOCKS],
  [11, sql("select \"update\", \"setval\" from t"), PASSES],
  [11, "echo x > m/x.sql", residual("a symlink made earlier hides the target")],
  [11, 'touch "$(cat /tmp/name)"', residual("a path generated from file contents at run time is not known")],
  [11, "npm -w worker run db:push", HOOK_BLOCKS], // residual closed in round 12: a workspace that cannot be resolved fails closed
  // False positives from the review.
  [11, "supabase migration list --linked", PASSES],
  [11, "supabase db dump --linked -f /tmp/schema.sql", PASSES],
  [11, "supabase db push --linked --dry-run", HOOK_BLOCKS],
  [11, "printf '%s\\n' supabase/migrations/x.sql", PASSES],
  [11, "echo supabase/migrations/x.sql", PASSES],
  [11, "cp supabase/migrations/x.sql /tmp/", PASSES],
  [11, "cp -r supabase /tmp/backup", PASSES],
  [11, "touch supabase/migrations/../../docs/x.md", PASSES],
  [11, "touch supabase/migrations/../migrations/x.sql", HOOK_BLOCKS],
  [11, "echo 'echo x > supabase/migrations/x.sql' > /tmp/w.sh", HOOK_BLOCKS],
  ...tableRows(12, ROUND_12),
  ...tableRows(13, ROUND_13),
];

const payloadOf = (probe) => (typeof probe === "string" ? { tool_name: "Bash", tool_input: { command: probe }, cwd: CWD } : { cwd: CWD, ...probe });
const check = (probe) => decide(payloadOf(probe), { prFiles: fakePrFiles });
const ruleMatches = (rule, tool) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(tool);

for (const [round, probe, expected] of PROBES) {
  const label = typeof probe === "string" ? probe : `${probe.tool_name} ${JSON.stringify(probe.tool_input)}`;
  let kind = expected;
  if (expected.deny) kind = "deny rule exists";
  else if (expected.residual) kind = "residual";
  else if (expected.retired) kind = "pass, label retired";
  test(`round ${String(round)} [${String(kind)}] ${label}`, () => {
    if (expected.deny) {
      assert.ok(DENY.includes(expected.deny), `settings.json should deny ${expected.deny}`);
      if (probe.tool_name?.startsWith("mcp__")) assert.ok(ruleMatches(expected.deny, probe.tool_name), `${expected.deny} should match ${probe.tool_name}`);
      return;
    }
    const reason = check(probe);
    if (expected === HOOK_BLOCKS) assert.ok(reason, "hook should block");
    else if (expected === PASSES) assert.equal(reason, null);
    else if (expected.retired) assert.equal(reason, null, expected.retired);
    else assert.equal(reason, null, `documented residual (${expected.residual}) should stay visible here`);
  });
}

const SUPABASE_SERVERS = ["Supabase", "supabase", "claude_ai_Supabase", "plugin_supabase_supabase", SUPABASE_UUID];
const HOSTED_WRITES = ["apply_migration", "merge_branch", "reset_branch", "rebase_branch", "create_branch", "delete_branch", "restore_project", "pause_project", "create_project", "deploy_edge_function", "create_edge_function_secret"];

test("every hosted Supabase write tool is denied under each known server name and blocked by the hook under any", () => {
  for (const server of SUPABASE_SERVERS) {
    for (const tool of HOSTED_WRITES) {
      const name = `mcp__${server}__${tool}`;
      assert.ok(DENY.some((rule) => ruleMatches(rule, name)), `deny rule for ${name}`);
      assert.ok(check(mcp(name, { project_id: "p" })), `hook blocks ${name}`);
    }
  }
  assert.ok(DENY.includes("mcp__*__apply_migration"));
});

test("no deny rule matches GitHub, Vercel, execute_sql or merge tools; the hook decides those", () => {
  const allowed = [
    "mcp__github__create_branch", "mcp__github__merge_pull_request", "mcp__github__enable_pr_auto_merge", "mcp__github__delete_file",
    `mcp__${VERCEL_UUID}__create_project`, `mcp__${VERCEL_UUID}__pause_project`, `mcp__${VERCEL_UUID}__create_deployment`,
    ...SUPABASE_SERVERS.map((server) => `mcp__${server}__execute_sql`), ...SUPABASE_SERVERS.map((server) => `mcp__${server}__list_tables`),
  ];
  for (const tool of allowed) assert.deepEqual(DENY.filter((rule) => ruleMatches(rule, tool)), [], tool);
});

test("enable_pr_auto_merge and merge_pull_request ask the lookup for the PR they name", () => {
  const seen = [];
  const prFiles = (target) => {
    seen.push(target);
    return ["src/a.ts"];
  };
  assert.equal(decide({ tool_name: "mcp__github__enable_pr_auto_merge", tool_input: { owner: "o", repo: "r", pullNumber: 7 } }, { prFiles }), null);
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "gh pr merge -R o/r 8 --auto" }, cwd: CWD }, { prFiles }), null);
  assert.deepEqual(seen, [{ owner: "o", repo: "r", number: 7, sha: undefined }, { selector: "8", repoFlag: "o/r", sha: undefined }]);
  const failing = () => {
    throw new Error("gh timed out");
  };
  assert.match(decide({ tool_name: "mcp__github__enable_pr_auto_merge", tool_input: { owner: "o", repo: "r", pullNumber: 7 } }, { prFiles: failing }), /gh timed out.*failing closed/);
});

test("sqlReason names the offending word", () => {
  assert.match(sqlReason("select 1; select 2"), /single statement/);
  assert.match(sqlReason("with d as (delete from t returning *) select 1"), /"delete"/);
  assert.equal(sqlReason("select 1;"), null);
});

// The real scripts as of this PR and the verdict each should get. Only listed names are asserted, so a script added
// later cannot turn CI red on an unrelated PR; unlisted scripts are reported as a warning in the test output.
const REAL_SCRIPTS = {
  "package.json": {
    block: ["db:push", "qualify:ovd417"],
    pass: [
      "dev", "dev:login", "build", "build:sample-plate", "serve:sample-plate", "build:dev", "db:start", "db:reset", "db:types", "seed:dev",
      "generate:favicon", "provider:add", "fixture:onboard", "provider:sync", "provider:check", "provider:permissions", "preflight", "lint",
      "typecheck", "typecheck:worker", "preview", "e2e", "e2e:fixture", "e2e:authenticated", "e2e:quote-confirmation", "e2e:ui", "e2e:prepare",
      "test", "test:functions", "test:integration:quote", "test:live:fictiv", "test:watch", "test:coverage", "validate:pr-body", "migration:next",
      "verify:migration-lineage", "verify:ovd372-head", "verify:ovd417-head", "compare:ovd372-schema", "verify:public-assets",
      "verify:removed-public-assets", "verify:xometry-egress", "verify:xometry-recovery-host", "render:pr-body", "verify:worker", "verify",
      "test:engineering-inbox", "test:engineering-queue", "test:engineering-worker-sessions", "test:engineering-native-ownership",
      "demo:engineering-evidence", "test:agent-control-plane", "test:portable-node", "stripe:catalog"
    ],
  },
  "worker/package.json": {
    block: [],
    pass: [
      "build", "dev", "start", "start:prod", "typecheck", "check", "canary:capability", "verify", "auth:xometry", "probe:xometry-auth",
      "export:xometry-profile", "auth:fictiv", "auth:vendor", "sweep:fictiv-quantity", "eval:gate", "sweep:xometry-quantity", "eval:live-provider",
      "smoke:vendor-workflow", "validate:openclaw-gate", "cleanup:dmrifles-demo", "extract:smoke", "import:dmrifles-quotes", "import:quotes",
      "install:browsers", "install:camoufox", "extract:eval", "compare:browser-recovery"
    ],
  },
};

test("the listed real root and worker scripts get their expected verdicts; unlisted scripts only warn", { skip: ROOT ? false : "repo root not found" }, (t) => {
  const run = (command) => decide({ tool_name: "Bash", tool_input: { command }, cwd: ROOT }, { prFiles: fakePrFiles });
  for (const [file, expected] of Object.entries(REAL_SCRIPTS)) {
    const prefix = file === "package.json" ? "" : `--prefix ${dirname(file)} `;
    const scripts = JSON.parse(readFileSync(join(ROOT, file), "utf8")).scripts ?? {};
    const listed = new Set([...expected.block, ...expected.pass]);
    for (const name of listed) {
      if (!Object.hasOwn(scripts, name)) {
        t.diagnostic(`warning: ${file} no longer has the listed script ${name}`);
        continue;
      }
      const reason = run(`npm ${prefix}run ${name}`);
      if (expected.block.includes(name)) assert.ok(reason, `npm ${prefix}run ${name} should block`);
      else assert.equal(reason, null, `npm ${prefix}run ${name} should pass`);
    }
    for (const name of Object.keys(scripts).filter((n) => !listed.has(n))) {
      const verdict = run(`npm ${prefix}run ${name}`) ? "blocks" : "passes";
      t.diagnostic(`warning: ${file} script ${name} is not listed in REAL_SCRIPTS (today it ${verdict}); add it to the list`);
    }
  }
});

test("qualify:ovd417 stays blocked because it runs supabase db push --db-url (and supabase test db and psql) against env var URLs the hook cannot see", { skip: ROOT ? false : "repo root not found" }, () => {
  const reasons = decide({ tool_name: "Bash", tool_input: { command: "npm run qualify:ovd417" }, cwd: ROOT }, { prFiles: fakePrFiles, collect: true });
  assert.ok(reasons.some((r) => /supabase db push targets a hosted project/.test(r)), reasons.join("\n"));
  // The other reasons are real too: supabase test db and psql run against the same unresolved URLs, and the script writes
  // and removes an injected failure file under a temporary project's supabase/migrations/.
  const real = /supabase (db push|test db) targets a hosted project|psql against a host that cannot be resolved|^rm would write to supabase\/migrations|^redirects output into supabase\/migrations/;
  for (const reason of reasons) assert.match(reason, real);
  // The round 12 false positives are gone: readers with redirects, generated arguments, keywords and assignment builtins.
  for (const reason of reasons) assert.doesNotMatch(reason, /writes a file whose text|generated path|^(readonly|local|\[\[|!|shasum|cmp|awk|node) /);
});

test("real scripts run by path are read: the production upgrade blocks, the Symphony scripts pass", { skip: ROOT ? false : "repo root not found" }, () => {
  const run = (command) => decide({ tool_name: "Bash", tool_input: { command }, cwd: ROOT }, { prFiles: fakePrFiles });
  assert.ok(run("./scripts/run-ovd373-production-upgrade.sh"), "./scripts/run-ovd373-production-upgrade.sh should block");
  assert.ok(run("bash scripts/run-ovd373-production-upgrade.sh"), "bash scripts/run-ovd373-production-upgrade.sh should block");
  assert.equal(run("./scripts/symphony-preflight.sh"), null);
  assert.equal(run("./scripts/symphony-ensure-branch.sh ovd-1-x"), null);
});

const driftSkip = () => {
  if (process.env.OVD_GUARDRAIL_APPLYING) return "apply.mjs is installing the proposed copy";
  return ROOT && existsSync(join(ROOT, ".claude/hooks/guard-migrations.mjs")) ? false : "guardrail not applied";
};
test("after apply, .claude/hooks and settings.json match the proposed copy", { skip: driftSkip() }, () => {
  for (const file of ["guard-migrations.mjs", "guard-migrations.node-test.mjs"]) {
    const applied = readFileSync(join(ROOT, ".claude/hooks", file), "utf8");
    const staged = readFileSync(join(ROOT, "tools/guardrails/proposed", file), "utf8");
    assert.equal(applied, staged, `.claude/hooks/${file} differs from tools/guardrails/proposed/${file}; edit the proposed copy and rerun apply.mjs`);
  }
  const applied = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
  const staged = JSON.parse(readFileSync(join(ROOT, "tools/guardrails/proposed/settings.json"), "utf8"));
  for (const rule of staged.permissions.deny) assert.ok(applied.permissions?.deny?.includes(rule), `.claude/settings.json is missing ${rule}`);
  for (const entry of staged.hooks.PreToolUse) {
    const expected = JSON.stringify(entry).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{\\{NODE\\}\\}", '/[^"\\\\]+').replace("\\{\\{HOOK\\}\\}", join(ROOT, ".claude/hooks/guard-migrations.mjs"));
    assert.ok(applied.hooks?.PreToolUse?.some((e) => new RegExp(`^${expected}$`).test(JSON.stringify(e))), `.claude/settings.json is missing the ${entry.matcher} hook as apply.mjs writes it`);
  }
});

test("the hook process exits 2 on block, 0 on pass, and fails closed without tool_input", () => {
  const run = (stdin) => spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8" });
  assert.equal(run(JSON.stringify(payloadOf("ls"))).status, 0);
  const blocked = run(JSON.stringify(payloadOf("echo x > supabase/migrations/x.sql")));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /best effort/);
  assert.equal(run(JSON.stringify({ tool_name: "Bash" })).status, 2);
  assert.equal(run("not json").status, 2);
  assert.equal(run("").status, 2);
});

test("the staged hook command clears NODE_OPTIONS and exits 2 when the hook is missing or crashes", () => {
  // The staged template, also when this test runs from the applied copy in .claude/hooks.
  const staged = ROOT ? join(ROOT, "tools/guardrails/proposed/settings.json") : SETTINGS;
  const settings = JSON.parse(readFileSync(staged, "utf8"));
  for (const entry of settings.hooks.PreToolUse) {
    for (const hook of entry.hooks) {
      assert.match(hook.command, /^\/usr\/bin\/env -u NODE_OPTIONS -u NODE_PATH "\{\{NODE\}\}" "\{\{HOOK\}\}" \|\| exit 2$/);
      assert.equal(hook.onFailure, "block");
    }
  }
  const command = (hook) => settings.hooks.PreToolUse[0].hooks[0].command.replace("{{NODE}}", process.execPath).replace("{{HOOK}}", hook);
  const sh = (cmd, input, env = {}) => spawnSync("/bin/sh", ["-c", cmd], { input, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(sh(command(HOOK), JSON.stringify(payloadOf("ls"))).status, 0);
  assert.equal(sh(command(HOOK), JSON.stringify(payloadOf("echo x > supabase/migrations/x.sql"))).status, 2);
  assert.equal(sh(command("/nonexistent/guard-migrations.mjs"), JSON.stringify(payloadOf("ls"))).status, 2);
  assert.equal(sh(command(HOOK), JSON.stringify(payloadOf("ls")), { NODE_OPTIONS: "--require /nonexistent/preload.cjs" }).status, 0);
});
