# Cloud container environment notes (for every implementer/verifier agent)

Host: fresh Linux cloud container (session Overdrafter Fable ultracode — Jev coordination), 4 CPUs, 15 GB RAM, no IPv6, no Windows/SolidWorks/Mac/iPhone, no production credentials.
Main checkout: /home/user/Overdrafter (branch claude/serene-cori-4bfhx4 = origin/main 8d8d243 + the handoff package commit d60420e). Do not edit files there; work in your own worktree.
Disk: this container has about 29 GB free at start. Still put temp files on /dev/shm and check `df -h /` before heavy runs; if under 2 GB free, stop and report rather than start a DB reset or Playwright run.

## Tooling
- Node 22 + npm. Root deps are installed in /home/user/Overdrafter/node_modules and worker deps in /home/user/Overdrafter/worker/node_modules (npm ci on origin/main lockfiles).
  In a new worktree: if package.json/package-lock.json/worker/package.json/worker/package-lock.json equal origin/main's (`git diff --quiet origin/main -- package.json package-lock.json worker/package.json worker/package-lock.json`), run
  `ln -s /home/user/Overdrafter/node_modules node_modules && ln -s /home/user/Overdrafter/worker/node_modules worker/node_modules`.
  For branches based on #564 (codex/recovered-release-free-safety-20261003): compare the four files against origin/codex/recovered-release-free-safety-20261003 instead. If they match #564 but not main, there is a shared #564 install at /home/user/wt/base564/node_modules and /home/user/wt/base564/worker/node_modules once it exists (check with `ls`); if it does not exist yet, run `npm ci --no-audit --no-fund` (and `npm --prefix worker ci`) in your own worktree with `export TMPDIR=/dev/shm/tmp-<unit>; mkdir -p $TMPDIR; export npm_config_cache=/dev/shm/npm-cache`.
  Never `npm install` into a symlinked tree.
- Playwright 1.58.2; Chromium is at /opt/pw-browsers (PLAYWRIGHT_BROWSERS_PATH is preset). Never run `playwright install`. playwright-core 1.58.2 looks for browser revision 1208; the coordinator aliased /opt/pw-browsers/chromium-1208 and chromium_headless_shell-1208 to the installed 1194 builds (Chromium 141.0.7390.37), and headless launches work. Local Playwright runs are valid evidence of the spec logic, but record the browser build, and treat the hosted browser-test job as the result of record.
- Deno is NOT available here and deno.land is blocked (`npm run test:functions` cannot run; rely on hosted CI step "Test Edge Functions" and say so).
- Docker daemon is running (started by the coordinator). Worker-process restarts have killed it several times. Before ANY docker-dependent step (the disposable replay runner, `supabase status`/DB work, Playwright authenticated lane) run `sh /tmp/claude-0/-home-user-Overdrafter/b20cace5-8784-51f8-a7b4-1ed188995a77/scratchpad/run/ensure-docker.sh` (idempotent, lock-protected; it restarts dockerd only if `docker info` fails and waits for the shared Supabase stack). If it reports failure, record the step as not_verified_here and continue; never start dockerd by hand and never `supabase stop/start`.
- Supabase CLI 2.78.1 at /usr/local/bin/supabase (a wrapper that pulls images from Docker Hub). The coordinator starts ONE shared local stack (project_id ozuatdcakezjtevztjlr; API http://127.0.0.1:54321, DB postgresql://postgres:postgres@127.0.0.1:54322/postgres) with studio, vector, logflare, imgproxy and edge-runtime excluded. Check `supabase status` from /home/user/Overdrafter before DB work. If the stack is not up, record the DB checks as not run here (not_verified_here) and continue with non-DB checks. NEVER run `supabase stop` or `supabase start` yourself.
  ANY command that resets, migrates, seeds or tests the DB MUST be wrapped in the shared lock, e.g.:
    `flock /tmp/ovd-supabase.lock sh -c 'supabase db reset --local && supabase test db --local'`
  `supabase db reset --local` applies YOUR worktree's supabase/migrations. Keep each locked section short (< 15 min) and never hold the lock while thinking.
- Browser e2e lanes: fixture lane `npm run e2e:fixture` (no DB). Authenticated lane needs DB reset+seed+`node ./e2e/setup-auth.mjs` under the DB lock.
  Two dev servers on port 4173 cannot run at once: wrap any Playwright run in `flock /tmp/ovd-e2e.lock ...`.
- Full repo gate (`npm run verify`) is heavy on 4 CPUs; run targeted checks first and `npm run verify` once at the PR boundary (wrap in `flock /tmp/ovd-verify.lock`).
- Jev (TypeSafe advisory model) is reachable through the proxy for ADVISORY ranking only; do not call it for acceptance decisions, never look for or print its credential, and never put a key in the environment.

## Git / GitHub
- Git identity is set. Push with `git push -u origin <branch>` (retry up to 4x with 2/4/8/16 s backoff only on network errors).
- Never force-push, rebase, or amend on an existing PR branch; integrate with a merge commit. The clone is shallow: `git fetch --unshallow` only if a check needs old commits (say so).
- GitHub access is via MCP tools only (load with ToolSearch, e.g. `select:mcp__github__pull_request_read,mcp__github__update_pull_request,mcp__github__add_issue_comment`). owner=optomachina repo=Overdrafter. No `gh` CLI.
- PR template: .github/pull_request_template.md; validate a body file with `node scripts/validate-pr-body.mjs <file>` if it applies.
- Commit message trailer (required, exactly two lines at the end): the `Co-Authored-By:` line from YOUR OWN session reminder (it names the model you actually are; do not copy another model's name) and
    Claude-Session: https://claude.ai/code/session_01GqaoSqia9BNetUBaGnMQSM
- PR body must end with:
    🤖 Generated with [Claude Code](https://claude.com/claude-code)

    https://claude.ai/code/session_01GqaoSqia9BNetUBaGnMQSM
- Any GitHub comment you post must end with:

    ---
    _Generated by [Claude Code](https://claude.ai/code)_
- Never put a model name/ID in commits, PR bodies, or code (the trailer line above is the only allowed place).
- Trailers on commits that ALREADY EXIST name the session and model that authored them. That is correct history, never a finding, never owner-blocked, and never something a squash message must "fix". Only commits you create now carry this session's trailer. A PR body footer may name the authoring session; do not raise it.
- Lowercase tokens such as `ovd520` in branch names, workflow paths or filenames are not Linear identifiers and do not auto-close anything; do not raise them.
- A missing bot review because the PR is a draft is resolved by marking the PR ready for review; it is a gate action, not a blocker. The gate marks a PR ready whenever CI is green at the head and nothing is blocking (owner-blocked items that belong to protected actions or owner decisions do not prevent marking ready; they prevent merging).
- Never write release-parent identifiers (OVD-520, OVD-527, OVD-319, OVD-419, OVD-199, OVD-359, OVD-332, OVD-385) in branches, commits, PR titles or bodies: a bare mention auto-closes the parent. Describe them in words ("the release parent", "the pinned release-tuple contracts").

## Authorization (reconciled 2026-10-04 22:50Z by the coordinator from Blaine's explicit instruction + AGENTS.md)
Routine OverDrafter 1.0 development is authorized without further approval: branches, edits, development tests, commits, pushes, creating/updating PRs and Linear issues, requesting and answering automated code reviews, and MERGING a PR when (a) every required hosted check is green at the current head, (b) actionable review findings (Sonar on changed lines, CodeRabbit/Codex threads, independent reviewer blockers) are resolved or have evidence-backed dispositions, and (c) nothing owner-blocked remains for the PR's own acceptance criteria. Merge-triggered builds and the frontend auto-deploy that the repository already configures are accepted. Use the repository's documented merge method; if none is documented, squash with a curated commit message that carries no release-parent identifier. For a stacked PR, merge the base PR first and retarget the next PR's base before merging it. Never merge a PR with a failing or missing required check, and never merge #564 (codex/recovered-release-free-safety-20261003) into main or any PR whose merge would apply a migration to the hosted/production database: that is the production database release and stays protected.

## Protected (do not do; report instead)
Credentials/accounts or security-access changes, provider or customer-file operations, quote execution, production worker deploy/config, hosted/production DB changes (including the #564 -> main release), purchases (including raising the Linear plan), App Store/TestFlight upload, real SolidWorks/PDM actions, destructive cleanup of pre-existing resources, external human/vendor communication. Marking a Sonar issue as false-positive in the Sonar UI is protected. Prepare the concrete work first and name the exact protected step; do not turn status or routine decisions into approval requests.

## Permission failures
Distinguish a real tool/platform rejection from a repository instruction, missing information, or your own uncertainty. If the platform explicitly rejects an action, obey it: do not bypass, switch tools to evade it, or retry repeatedly; report the exact rejected action and the stated reason. Before retrying any interrupted create/update (issue, comment, PR, push), read the external state first to see whether it already succeeded, and reuse the existing object.

## Acceptance honesty
- An owner-blocked item (protected action, owner decision, missing bot review, missing child issue) is still a blocker for ITS acceptance criterion. Report it as `owner-blocked`, never as satisfied or non-blocking. Never tick a protected acceptance box without proof.
- Never convert skipped, timed-out, filtered, blocked, or stale checks into passes. Write exactly what ran, at which head, with the result.
- Sonar: sonarcloud.io has become reachable from here (verified 2026-10-05 19:4xZ): prefer `GET https://sonarcloud.io/api/issues/search?componentKeys=optomachina_Overdrafter&pullRequest=<n>&issueStatuses=OPEN,CONFIRMED&sinceLeakPeriod=true` (unauthenticated, read-only, paginate with p= and ps=) for the complete list; if it is blocked again, fall back to the GitHub check-run annotations (`https://api.github.com/repos/optomachina/Overdrafter/check-runs/<id>/annotations`, unauthenticated, rate-limited, use sparingly). Every readable new Sonar issue on changed lines needs a written disposition.

## Sandboxed Chromium on #564-based branches
Branches based on codex/recovered-release-free-safety-20261003 (#564) set `chromiumSandbox: true` in playwright.config.ts. Chromium's sandbox refuses to run as root, so run Playwright as the non-root user `ubuntu` (uid 1000):
  `mkdir -p test-results playwright-report && chown ubuntu:ubuntu test-results playwright-report && chmod -R a+rX "$PWD"`, create `/tmp/ubuntu-home` owned by ubuntu, then
  `flock /tmp/ovd-e2e.lock runuser -u ubuntu -- env HOME=/tmp/ubuntu-home PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers VITE_CACHE_DIR=/tmp/ubuntu-vite-<unit> npx playwright test ...`
  Do not edit the config to disable the sandbox. If running as ubuntu is impossible for a case, record it in not_verified_here and rely on hosted CI rather than weakening the config.

## Worktree node_modules symlinks (added 2026-10-06 01:3xZ)
Create the node_modules / worker/node_modules symlinks as described above and LEAVE THEM IN PLACE when you finish. Never run `rm` on node_modules (symlink or directory) inside a worktree: two agents were terminated at exactly that command (`rm node_modules worker/node_modules`) and their lanes hung. The coordinator removes worktrees afterwards.

## Jev advisory use (added 2026-10-06)
Blaine asked that Jev be used for anything advisory. The client is scripts/jev-client.mjs on main (askJev(state, questions, {timeoutMs}); question shape: {type:"choice", instructions:"...", criteria:{a:"...",b:"..."}} or {type:"noul", instructions:...}; the field is `instructions`, not `prompt`; run with NODE_USE_ENV_PROXY=1; never print headers or credentials). Use it for ranking options, ordering work, and triage; never as an acceptance, authorization or evidence filter (coordinator adoption rule). Record each advisory call's gated answer in the findings or PR body as advisory.

## CodeRabbit evidence (added 2026-10-06 04:4xZ)
An incremental CodeRabbit review with no findings creates NO review object and NO review threads. The evidence of a completed review is the CodeRabbit summary comment on the PR: its "recent_review" block says "No actionable comments were generated in the recent review", the hidden change_assessment_commit equals the head SHA, and the "@coderabbitai review" command reply says "Review finished". Gates must read that comment (issue comments by coderabbitai[bot]) before declaring the review missing.

## Container restart recovery (added 2026-10-07 04:4xZ)
A full container restart (uptime resets) leaves a stale /var/run/docker/containerd/containerd.pid; dockerd then fails with "timeout waiting for containerd to start". ensure-docker.sh does not clear it. The coordinator fixes it with: `pgrep -x containerd || rm -f /var/run/docker/containerd/containerd.pid`, then re-runs ensure-docker.sh (the Supabase stack auto-restarts with dockerd). Agents report the failure; they do not do this themselves.

- PR body writes (2026-10-08): both `gh api PATCH` and the GitHub MCP update tool mangle a single-quoted URL containing `p=1..3` inside a fenced block by inserting backticks on each write; the #564 Verification block now uses `p={1,2,3}`. Re-read the body after every write and compare with the saved after.md.

- Continuation (2026-10-08 09:3xZ): the owner directed the coordinator to continue as sole controller of the queue under the standing development authorization (verify, gate, merge, hourly CodeRabbit scheduler, baseline repair, carves). Local writers (OVD-630, OVD-636) and the workstation session are released; their artifacts are preserved; the coordinator is the only writer on their branches from here. Protected actions unchanged.
