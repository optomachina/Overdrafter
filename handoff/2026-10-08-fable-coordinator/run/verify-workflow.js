export const meta = {
  name: 'verify-prs-sequenced',
  description: 'Adversarial verification of PR lanes: sequenced lenses (acceptance, boundary, reproduce), single-writer fix rounds with merge-forward, loop until 2 clean rounds, then CI/Sonar/bot gate; owner-blocked items stay blocking for their criterion',
  phases: [
    { title: 'Review', detail: 'three lenses per round, run sequentially (2-worker budget)' },
    { title: 'Fix', detail: 'single writer per branch; merges forward into stacked branches' },
    { title: 'Gate', detail: 'CI, Sonar annotations, bot threads at the final head; no ready-for-review while owner-blocked' },
  ],
}

const S = '/tmp/claude-0/-home-user-Overdrafter/b20cace5-8784-51f8-a7b4-1ed188995a77/scratchpad/run'
const MAX_FIX_ROUNDS = args.max_fix_rounds || 2
const CLEAN_NEEDED = args.clean_needed || 2
// Model routing (coordinator policy): Opus for security/database/complex lenses, Sonnet for routine reproduction and gates.
const MODELS = args.models || { acceptance: ['opus', 'medium'], boundary: ['opus', 'high'], reproduce: ['sonnet', 'medium'], fix: ['opus', 'medium'], gate: ['sonnet', 'medium'] }

const FINDINGS = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    head_sha: { type: 'string', description: 'exact PR head SHA you reviewed' },
    verdict: { type: 'string', enum: ['clean', 'blocking', 'owner-blocked-only'] },
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocking', 'owner-blocked', 'nonblocking'] },
      title: { type: 'string' }, evidence: { type: 'string' }, suggested_fix: { type: 'string' } }, required: ['severity', 'title', 'evidence'] } },
    checks_run: { type: 'array', items: { type: 'string' } },
    not_verified_here: { type: 'array', items: { type: 'string' } },
    ci_state: { type: 'string', description: 'per check-run conclusions at head, or pending/unknown' },
  },
  required: ['lens', 'head_sha', 'verdict', 'findings', 'checks_run'],
}

const FIX = {
  type: 'object',
  properties: {
    head_sha: { type: 'string' }, pushed: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' } },
    not_fixed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' }, class: { type: 'string', enum: ['wrong', 'already-fixed', 'owner-blocked', 'out-of-scope', 'failed'] } }, required: ['title', 'reason', 'class'] } },
    merged_forward: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    body_updated: { type: 'boolean' },
  },
  required: ['head_sha', 'pushed', 'fixed', 'not_fixed'],
}

const GATE = {
  type: 'object',
  properties: {
    head_sha: { type: 'string' },
    ci: { type: 'string', enum: ['green', 'red', 'pending', 'mixed'] },
    check_runs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, conclusion: { type: 'string' } }, required: ['name', 'conclusion'] } },
    sonar: { type: 'string', description: 'quality gate + new issue count + dispositions' },
    bot_threads: { type: 'string', description: 'CodeRabbit/other bot coverage and unresolved threads' },
    blocking: { type: 'array', items: { type: 'string' } },
    owner_blocked: { type: 'array', items: { type: 'string' } },
    marked_ready: { type: 'boolean' },
    merged: { type: 'boolean' },
    merge_decision: { type: 'string', description: 'merged <sha> | not merged: <exact failing condition>' },
    summary: { type: 'string' },
  },
  required: ['head_sha', 'ci', 'blocking', 'owner_blocked', 'marked_ready', 'merged', 'merge_decision', 'summary'],
}

const COMMON = (p) => `PR #${p.pr_number} in optomachina/Overdrafter (branch ${p.branch} -> base ${p.base}). Unit key: ${p.key}. Linear: ${p.issue || 'none yet (child issue pending creation by the coordinator; do not create issues)'}.
Unit spec (acceptance criteria are binding): read the object with "key": "${p.key}" from ${p.spec_file}.
Environment rules: read ${S}/ENV.md and follow it exactly (shared DB lock, e2e lock, replay lock /tmp/ovd-replay.lock for scripts/ovd510-disposable-replay.mjs, node_modules symlink rules, Deno unavailable, trailers, footer). GitHub via MCP tools (ToolSearch "select:mcp__github__pull_request_read,mcp__github__get_commit,mcp__github__update_pull_request,mcp__github__add_issue_comment"). Do NOT merge anything, do NOT touch production, credentials or providers.
${p.prior_file ? 'An earlier verification run recorded findings at an older head in ' + p.prior_file + '. Re-check EVERY listed finding at the current head (still present = report it again with fresh evidence; fixed = say so in checks_run).\n' : ''}SEVERITY RULES: "blocking" = a real defect, false evidence claim, vacuous test, unmet acceptance criterion this PR can satisfy, red required CI, policy violation, or a Sonar issue readable on changed lines without a written disposition. "owner-blocked" = the criterion is unmet because it needs a protected action or an owner decision (production, credentials, providers, purchases, Workstation/SolidWorks, Sonar UI false-positive marking, a merge-time squash decision) or a bot review that has not run; it stays a blocker for ITS criterion and must be reported as such, never as satisfied, never waived; a PR body that misstates the cause (e.g. calls a plan limit an "owner decision") is a blocking false claim. "nonblocking" = style or optional improvements.
${p.no_parent_mention ? 'Policy: the PR title/body/commits must NOT contain ' + p.no_parent_mention + ' (a bare parent mention auto-closes Linear parents).' : ''}
${p.context ? 'COORDINATOR CONTEXT: ' + p.context : ''}`

const LENSES = [
  { key: 'acceptance', text: 'LENS acceptance & correctness. Try to REFUTE the claim that this PR fully and correctly meets every acceptance criterion of its unit spec. Read the whole diff (get_diff / git diff base...head). Look for logic errors, unhandled edge cases, vacuous assertions (tests that would pass even if the behavior regressed), scope creep, mismatches with repository conventions, stale or wrong line references, ticked boxes without proof, and PR body claims not backed by evidence. Read-only: do not push, do not comment.' },
  { key: 'boundary', text: 'LENS security, data boundaries & policy. Try to REFUTE the claim that this PR is safe and policy-compliant. Check RLS/grants/SECURITY DEFINER/search_path in any SQL, role or catalog side effects, secret or PII exposure, error-message leakage, protected-action creep (production, providers, credentials), migration numbering and free-quote CI profile pins, AGENTS.md rules (one bounded issue per PR, truthful evidence, no skipped check called passed), the parent-ID mention policy, and whether the PR body/Linear claims match the code. Read-only: do not push, do not comment.' },
  { key: 'reproduce', text: 'LENS independent reproduction. In your own isolated worktree, check out the exact PR head SHA (git fetch origin <branch>; git checkout <sha>) and independently re-run the unit verification commands (respect the locks; the disposable replay runner needs /tmp/ovd-replay.lock and must not run alongside Playwright or npm run verify). Then perform at least one mutation or failure-first check: deliberately break the behavior under test in a scratch edit (never commit or push it) and confirm the check fails; revert. Read the PR check runs at the head (get_check_runs), Sonar annotations if retrievable, and bot comments/review threads. A failing required CI check at the head is blocking; pending checks are reported. Anything you could not run here goes in not_verified_here with the reason. Do not push, do not comment.' },
]

async function verifyOne(p) {
  let clean = 0, fixRounds = 0, round = 0, reviewerFailures = 0
  const history = []
  let lastHead = p.head_sha || ''
  while (clean < CLEAN_NEEDED) {
    round++
    const reviews = []
    for (const l of LENSES) {
      const r = await agent(
        `${COMMON(p)}\nRound ${round}. ${l.text}\nEvery finding needs concrete evidence (file:line, command output). Previous rounds (context only; verify independently): ${JSON.stringify(history.map(h => ({ round: h.round, blocking: h.blocking, owner_blocked: h.owner_blocked, fixed: h.fixed })))}`,
        { label: `review:${p.key}:r${round}:${l.key}`, phase: 'Review', schema: FINDINGS, model: MODELS[l.key][0], effort: MODELS[l.key][1], isolation: l.key === 'reproduce' ? 'worktree' : undefined })
      if (r) reviews.push(r)
    }
    const blocking = reviews.flatMap(r => (r.findings || []).filter(f => f.severity === 'blocking').map(f => ({ lens: r.lens, ...f })))
    const ownerBlocked = reviews.flatMap(r => (r.findings || []).filter(f => f.severity === 'owner-blocked').map(f => ({ lens: r.lens, ...f })))
    const nonblocking = reviews.flatMap(r => (r.findings || []).filter(f => f.severity === 'nonblocking').map(f => ({ lens: r.lens, ...f })))
    lastHead = (reviews.find(r => r.head_sha) || {}).head_sha || lastHead
    if (reviews.length < 3) {
      log(`${p.key} r${round}: only ${reviews.length}/3 reviewers returned; retrying the round without counting it`)
      reviewerFailures++
      round--
      if (reviewerFailures >= 2) return { key: p.key, pr_number: p.pr_number, status: 'reviewer-failure', head_sha: lastHead, rounds: round, history, open_blocking: blocking, owner_blocked: ownerBlocked, nonblocking }
      continue
    }
    if (!blocking.length) {
      clean++
      history.push({ round, head: lastHead, clean: true, blocking: [], owner_blocked: ownerBlocked.map(f => f.title), nonblocking: nonblocking.map(f => f.title) })
      log(`${p.key} r${round}: no fixable blockers (${clean}/${CLEAN_NEEDED}); owner-blocked: ${ownerBlocked.length}`)
      continue
    }
    clean = 0
    if (fixRounds >= MAX_FIX_ROUNDS) {
      history.push({ round, head: lastHead, clean: false, blocking: blocking.map(f => f.title), owner_blocked: ownerBlocked.map(f => f.title), stopped: 'max fix rounds' })
      log(`${p.key}: stopping after ${fixRounds} fix rounds with blocking findings`)
      return { key: p.key, pr_number: p.pr_number, status: 'needs-human', head_sha: lastHead, rounds: round, history, open_blocking: blocking, owner_blocked: ownerBlocked, nonblocking }
    }
    fixRounds++
    const fix = await agent(`${COMMON(p)}\nYou are the SINGLE WRITER for branch ${p.branch} for fix round ${fixRounds}. In your isolated worktree: git fetch origin; git checkout -B ${p.branch} origin/${p.branch} (never rebase/amend/force-push). Fix every BLOCKING finding below that is real (re-verify each first; if a finding is wrong, do not change code and explain why in not_fixed with class "wrong"). Owner-blocked findings: do not try to satisfy them; make sure the PR body reports each truthfully as owner-blocked (that is a text fix you must make). Also apply plainly-correct nonblocking nits that touch files this PR already changes. Re-run the unit verification commands (locks!), commit with the ENV.md trailer, push. ${p.stacked_above && p.stacked_above.length ? 'Then merge-forward: for each stacked branch ' + p.stacked_above.join(', ') + ' (in order), check it out from origin, `git merge --no-ff origin/' + p.branch + '` (resolve conflicts minimally; if a conflict needs judgment, stop and report), run that branch\'s quick checks, push.' : ''} Update the PR body evidence (current head SHA, checks) via mcp__github__update_pull_request.\nBLOCKING FINDINGS: ${JSON.stringify(blocking)}\nOWNER-BLOCKED: ${JSON.stringify(ownerBlocked)}\nNONBLOCKING: ${JSON.stringify(nonblocking)}`,
      { label: `fix:${p.key}:f${fixRounds}`, phase: 'Fix', schema: FIX, isolation: 'worktree', model: MODELS.fix[0], effort: MODELS.fix[1] })
    history.push({ round, head: lastHead, clean: false, blocking: blocking.map(f => f.title), owner_blocked: ownerBlocked.map(f => f.title), fixed: fix ? fix.fixed : [], not_fixed: fix ? fix.not_fixed : [], new_head: fix ? fix.head_sha : null })
    if (fix && fix.head_sha) lastHead = fix.head_sha
    if (!fix || (!fix.pushed && !fix.body_updated)) {
      log(`${p.key}: fixer made no change (${fix ? fix.not_fixed.length : 'no result'} not fixed)`)
      if (fix && fix.not_fixed.length && !fix.fixed.length) return { key: p.key, pr_number: p.pr_number, status: 'needs-human', head_sha: lastHead, rounds: round, history, open_blocking: blocking, owner_blocked: ownerBlocked, nonblocking }
    }
  }
  const lastOwnerBlocked = (history[history.length - 1] || {}).owner_blocked || []
  const gate = await agent(`${COMMON(p)}\nFINAL GATE at the current PR head. (1) Fetch the PR head SHA. (2) Read all check runs at that head; if any are queued/in progress, wait with foreground bash until-loops of <= 8 minutes per call for up to ~25 minutes total (one watcher; do not spam API calls). (3) Read Sonar results via the quality-gate check and its annotations (GitHub REST check-runs/<id>/annotations, unauthenticated, sparingly). For every new Sonar issue on lines this PR changed: real defect (blocking) or accepted with a written reason. (4) Read PR comments, reviews and review threads. (5) Owner-blocked items carried from review: ${JSON.stringify(lastOwnerBlocked)}. If CI is green and nothing is blocking and the PR is a draft, mark it ready for review (mcp__github__update_pull_request draft=false) so CodeRabbit runs; owner-blocked items (protected actions, owner decisions, existing-commit trailers, a missing bot review) never prevent marking ready, they only prevent merging. Then post one "@coderabbitai review" comment (with the footer) and record its reply. Post ONE PR comment summarizing the adversarial verification (rounds, final head SHA, checks, Sonar dispositions, owner-blocked items, what was not verifiable here; end with the ENV.md footer). ${p.issue ? 'Update the ' + p.issue + ' rolling Linear comment (edit in place). Move it to "Human Review" only if CI is green, nothing is blocking and nothing is owner-blocked; otherwise keep it In Progress and state the owner-blocked items.' : ''} (6) MERGE DECISION per the ENV.md Authorization section: ${p.no_merge ? 'DO NOT MERGE this PR in this gate: ' + p.no_merge + ' Instead record the merge-readiness verdict (what would remain before merge) in the PR comment and the Linear rolling comment, and move the Linear issue to Human Review only if everything else is green and nothing is owner-blocked.' : ''} if the PR is ready (not draft), every required check is green at this head, CodeRabbit has actually reviewed this head with no unresolved actionable thread, Sonar is dispositioned, nothing is blocking or owner-blocked, and the PR is not a migration-to-main or the #564 release, then merge it with mcp__github__merge_pull_request using the repository's documented method (squash with a curated message free of release-parent identifiers if undocumented), then: delete nothing, retarget any stacked child PR's base (${p.stacked_above && p.stacked_above.length ? p.stacked_above.join(', ') : 'none'}) to this PR's base with mcp__github__update_pull_request, move the Linear issue to Done only if no post-merge criterion remains (else leave Human Review with the remaining criterion named). If any condition fails, do not merge and say exactly which one. Marking ready-for-review to trigger CodeRabbit and then waiting for its review (poll the PR reviews at most every 5 minutes for up to 20 minutes) is part of this gate.\nVerification history: ${JSON.stringify(history)}`,
    { label: `gate:${p.key}`, phase: 'Gate', schema: GATE, model: MODELS.gate[0], effort: MODELS.gate[1] })
  const status = !gate ? 'gate-failed' : gate.blocking.length ? 'gate-blocked' : gate.owner_blocked.length ? 'verified-owner-blocked' : gate.merged ? 'merged' : 'verified'
  return { key: p.key, pr_number: p.pr_number, status, head_sha: (gate && gate.head_sha) || lastHead, rounds: round, history, gate }
}

const lanes = args.lanes || []
const results = []
for (const lane of lanes) {
  for (const p of lane) {
    log(`verify ${p.key} (#${p.pr_number})`)
    const r = await verifyOne(p)
    results.push(r)
    log(`${p.key}: ${r.status} @ ${r.head_sha}`)
    if (p.stop_lane_on_fail && (r.status === 'needs-human' || r.status === 'gate-blocked' || r.status === 'reviewer-failure')) { log(`lane stopped after ${p.key}`); break }
  }
}
return { results }
