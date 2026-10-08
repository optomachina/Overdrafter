export const meta = {
  name: 'restore-carried-fixers',
  description: 'Restore the carried-over #572 and #585 fixer drafts: validate each at the current head, repair evidence and text, push; then one independent reviewer per PR',
  phases: [
    { title: 'Fix', detail: 'one single-writer fixer per PR branch (Opus medium for #572 worker security, Sonnet medium for #585 e2e)' },
    { title: 'Review', detail: 'one adversarial read-only reviewer per PR after its fixer' },
  ],
}

const S = '/tmp/claude-0/-home-user-Overdrafter/b20cace5-8784-51f8-a7b4-1ed188995a77/scratchpad/run'
const H = '/home/user/Overdrafter/handoff/2026-10-04-ultracode-coordinator'

const FIX = {
  type: 'object',
  properties: {
    pr_number: { type: 'number' },
    head_sha: { type: 'string', description: 'branch head after your work (pushed or unchanged)' },
    pushed: { type: 'boolean' },
    commits: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' } },
    not_fixed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' }, class: { type: 'string', enum: ['wrong', 'already-fixed', 'owner-blocked', 'out-of-scope', 'failed'] } }, required: ['title', 'reason', 'class'] } },
    checks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' }, evidence: { type: 'string' } }, required: ['command', 'result'] } },
    not_verified_here: { type: 'array', items: { type: 'string' } },
    body_updated: { type: 'boolean' },
    comments_posted: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['pr_number', 'head_sha', 'pushed', 'fixed', 'not_fixed', 'checks', 'not_verified_here', 'body_updated'],
}

const REVIEW = {
  type: 'object',
  properties: {
    pr_number: { type: 'number' },
    head_sha: { type: 'string' },
    verdict: { type: 'string', enum: ['clean', 'blocking', 'owner-blocked-only'] },
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocking', 'owner-blocked', 'nonblocking'] },
      title: { type: 'string' }, evidence: { type: 'string' }, suggested_fix: { type: 'string' } }, required: ['severity', 'title', 'evidence'] } },
    checks_run: { type: 'array', items: { type: 'string' } },
    ci_state: { type: 'string' },
  },
  required: ['pr_number', 'head_sha', 'verdict', 'findings', 'checks_run'],
}

const COMMON = (p) => `PR #${p.pr} in optomachina/Overdrafter (branch ${p.branch} -> base ${p.base}). Linear: ${p.issue}.
Read ${S}/ENV.md first and follow it exactly (locks, node_modules rules for #564-based branches, trailers, protected actions, acceptance honesty, parent-ID policy). GitHub only via MCP tools (ToolSearch "select:mcp__github__pull_request_read,mcp__github__update_pull_request,mcp__github__add_issue_comment,mcp__github__get_file_contents"). Linear via ToolSearch "select:mcp__Linear__get_issue,mcp__Linear__list_comments,mcp__Linear__save_comment,mcp__Linear__save_issue,mcp__Linear__list_issues".
This branch is based on #564, so use the shared #564 install: \`ln -s /home/user/wt/base564/node_modules node_modules && ln -s /home/user/wt/base564/worker/node_modules worker/node_modules\` (never npm install into it).
HARD RULES: never merge; never force-push/rebase/amend; never tick a protected or unproven acceptance box; an owner-blocked item stays reported as owner-blocked (not satisfied, not waived); never write a release-parent identifier (see ENV.md list) in commits, titles or bodies; never call a skipped or not-run check a pass; every GitHub comment ends with the ENV.md footer.`

const UNITS = [
  {
    pr: 572, key: 'U572', branch: 'fix/OVD-593-worker-browser-hardening', base: 'codex/recovered-release-free-safety-20261003', issue: 'OVD-593 (children OVD-610 Cloud Run smoke + sandbox flip, OVD-611 screenshot/trace masking)',
    model: 'opus', effort: 'medium',
    patch: `${H}/wip/patches/wf_3d51ac3f-711-10.patch`, prior: `${S}/findings/prior2-U572.json`,
    specific: `CONTEXT: the predecessor's round-1 review found 15 blocking findings at head a659e9b (deduped in the prior file). A fixer agent was killed mid-work; its partial, UNVALIDATED 8-file draft is the patch above (it applies cleanly to a659e9b: README/Dockerfile notes, deploy-script TODO rewording to OVD-610, chromiumLaunchOptions test rewrite, redaction of absolute-URL attribute values, a probe launch test). Treat the draft as a proposal: apply it, then judge each hunk against the findings and the code; drop or rewrite anything you cannot justify.
MATERIAL CONTRADICTIONS TO REPAIR (text + evidence, never by faking): (1) the PR body ticks AC1 (non-root sandbox on by default + deploy script no longer turns it off) while deploy-cloud-run.sh:35 still defaults PLAYWRIGHT_DISABLE_SANDBOX to true; untick AC1 and label it open/protected (OVD-610). (2) the body cites stale head 20007361 evidence; replace with evidence at the head you push. (3) the "Independent review record, round 1" PR comment claims fixes (body rewritten, AC1 unticked, identifier removed, session link added) that never happened: post ONE correcting comment that states exactly which dispositions were false and what is now true (do not edit history or delete comments). (4) the release-parent identifier appears 4x in the body: remove it from the body; commit c01722e also carries it and CANNOT be rewritten here, so disclose that in the body's Review findings section as an owner decision at merge time (curated squash message). (5) CodeRabbit never reviewed (rate-limited): post a single "@coderabbitai review" comment at the final head and record the outcome truthfully; if it is still rate-limited, say so as owner-blocked. (6) The child issues now exist (OVD-610, OVD-611): link them in the body and in the OVD-593 rolling Linear comment (edit the existing rolling comment; do not spam). Then re-check every remaining blocking finding in the prior file at the current head and fix the real ones in code.
VALIDATION: npx vitest run (worker tests touched: worker/src/chromiumLaunchOptions.test.ts, worker/src/adapters/providerEvidenceRedaction.test.ts, worker/src/tools/probeXometryProfileAuth.test.ts, scripts/deploy-cloud-run-contract.test.mjs) via the root vitest config; then \`npm --prefix worker run verify\` if it exists (check package.json) else worker lint+typecheck+tests; then \`npm run lint && npm run typecheck\`. Record exact results. Deno/Cloud Run/hosted CI are not_verified_here.`,
  },
  {
    pr: 585, key: 'QUOTE-DECISION-FIXTURE-E2E', branch: 'claude/quote-comparison-fixture-e2e', base: 'codex/recovered-release-free-safety-20261003', issue: 'OVD-617 (child issue created 22:40Z; the PR title already names it; the PR body must name it too and post/update one rolling Linear comment on it)',
    model: 'sonnet', effort: 'medium',
    patch: `${S}/wip-585-after-fixer.patch`, prior: `${S}/findings/prior2-QUOTE-DECISION-FIXTURE-E2E.json`,
    specific: `CONTEXT: the predecessor's round-1 review found 2 blocking findings at head 722fca9: check (h) misses order buttons (its regex is too narrow, so the assertion is vacuous), and check (e) skips the "Pending" selected-offer summary case. A fixer's partial, UNVALIDATED 3-file draft is the patch above (it applies cleanly to 722fca9): it widens the (h) pattern with a positive control, adds an (e) test that uses test.fail() to pin a product defect, and fixes comments. Treat the draft as a proposal. Scrutinize the test.fail() use: it must not hide a regression of the steps before it and must document the defect truthfully; if a cleaner approach exists (e.g. a test that asserts the CURRENT observable behavior and names it as a defect, or a separate skipped-with-reason case), prefer what a careful maintainer would accept. The unit spec is in ${S}/specs/unit-QUOTE-DECISION-FIXTURE-E2E.json (acceptance criteria binding).
VALIDATION: run the touched vitest file; then run the fixture-lane Playwright spec e2e/quote-comparison.spec.ts as user ubuntu per ENV.md (this branch sets chromiumSandbox true), under /tmp/ovd-e2e.lock, at 1440x900 and 390x844 as the spec defines; then a mutation check for (h): temporarily add a visible "Place your order" button to the panel in a scratch edit, confirm (h) fails, revert. Record exact outputs. Then \`npm run lint && npx tsc --noEmit -p tsconfig.app.json\` on the changed files. Update the PR body (head SHA, evidence, the (e) defect disclosure, Linear "issue pending" wording must say the child issue is pending creation by the coordinator, never "owner decision").`,
  },
]

phase('Fix')
const results = await parallel(UNITS.map(u => async () => {
  const fix = await agent(`${COMMON(u)}
You are the SINGLE WRITER for branch ${u.branch}. Work only in your isolated worktree: \`git fetch origin ${u.branch} ${u.base}\`; \`git checkout -B ${u.branch} origin/${u.branch}\`. Current head must be verified with \`git rev-parse HEAD\` and compared with the PR head from GitHub.
STEP 1 (resumable): first read the external state. Compare \`git rev-parse HEAD\` with the recorded pre-fix head (${u.pr === 572 ? 'a659e9b98ba71e1a57453d51c7fa1d33244bbaf6' : '722fca926eb56b012592d470a8a14b6c8162e5e3'}). If origin already carries newer commits from an earlier interrupted fixer attempt (for #572: 39d20b1, 83ebdda, 09e2735, 7fd1b9a and 8a839a3 are pushed and contain the draft's code changes plus a relative-URL redaction follow-up; head is 8a839a3), DO NOT reapply the patch; read those commits (\`git log -p <old>..HEAD\`), treat them as the applied draft, and continue from the next unfinished step (validation, body rewrite, comments, Linear). Otherwise \`git apply --3way ${u.patch}\`. Before any create/update on GitHub or Linear (comment, body edit, CodeRabbit request), read the current PR comments/body first so an interrupted earlier attempt is not duplicated. Read the prior findings: ${u.prior}.
STEP 2: ${u.specific}
STEP 3: commit (small, descriptive commits; ENV.md trailer), push with \`git push -u origin ${u.branch}\`. Update the PR body against the final head via mcp__github__update_pull_request (keep the template sections; run \`node scripts/validate-pr-body.mjs\` on a body file if the script accepts one). Owner-blocked items go in the body under Review findings as "owner-blocked: <what>, <why>"; never as satisfied.
Return the structured result with exact commands and results. If something needs an owner decision or a protected action, do not guess: list it under not_fixed with class owner-blocked.`,
    { label: `fix:${u.key}`, phase: 'Fix', schema: FIX, isolation: 'worktree', model: u.model, effort: u.effort })
  log(`${u.key}: fixer ${fix ? (fix.pushed ? 'pushed ' + fix.head_sha : 'no push') : 'returned nothing'}`)
  if (!fix) return { key: u.key, fix: null, review: null }
  const review = await agent(`${COMMON(u)}
LENS adversarial acceptance + security review (READ-ONLY, do not push, do not comment on GitHub). Head to review: ${fix.head_sha} (verify it is the PR head). A fixer just pushed changes claiming: fixed=${JSON.stringify(fix.fixed)}; not_fixed=${JSON.stringify(fix.not_fixed)}; checks=${JSON.stringify(fix.checks)}. Try to REFUTE: (1) that every prior blocking finding in ${u.prior} is now resolved or truthfully reported as owner-blocked; (2) that the PR body matches the head exactly (SHAs, files changed, ticked boxes with proof, no release-parent identifiers, session link present); (3) that the new/changed tests are non-vacuous (would fail if the behavior regressed), by reading them and, where cheap, running the touched vitest files in your worktree (symlink #564 node_modules per the rule above); (4) for #572, that the redaction regex change is safe (no catastrophic backtracking, no over-redaction of non-URL values) and that the chromium launcher allowlist test cannot pass with a new unsandboxed launcher; for #585, that the (h) assertion is now non-vacuous and that the (e) expected-failure cannot mask an earlier-step regression. Any real defect, false claim, vacuous test, or ticked-without-proof box is 'blocking'. Items that need an owner/protected action are 'owner-blocked'. Give file:line evidence.`,
    { label: `review:${u.key}`, phase: 'Review', schema: REVIEW, model: 'opus', effort: 'medium' })
  log(`${u.key}: review ${review ? review.verdict : 'returned nothing'}`)
  return { key: u.key, fix, review }
}))
return { results }
