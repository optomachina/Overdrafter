export const meta = {
  name: 'verify-lane-a-prs',
  description: 'Adversarial verification: 3 independent reviewers per round, fix blocking findings, loop until 2 consecutive clean rounds; then CI/Sonar/bot gate',
  phases: [
    { title: 'Review', detail: '3 lenses per round' },
    { title: 'Fix', detail: 'single writer per branch, merge forward to stacked branches' },
    { title: 'Gate', detail: 'CI, Sonar annotations and bot threads at the final head' },
  ],
}

const S = '/tmp/claude-0/-home-user-Overdrafter/889b9ea6-4645-598b-9361-46519e5fc8d3/scratchpad'
const MAX_FIX_ROUNDS = args.max_fix_rounds || 3
const CLEAN_NEEDED = args.clean_needed || 2

const FINDINGS = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    head_sha: { type: 'string', description: 'exact PR head SHA you reviewed' },
    verdict: { type: 'string', enum: ['clean', 'blocking'] },
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocking', 'nonblocking'] },
      title: { type: 'string' }, evidence: { type: 'string' }, suggested_fix: { type: 'string' } }, required: ['severity', 'title', 'evidence'] } },
    checks_run: { type: 'array', items: { type: 'string' } },
    ci_state: { type: 'string', description: 'per check-run conclusions at head, or pending/unknown' },
  },
  required: ['lens', 'head_sha', 'verdict', 'findings'],
}

const FIX = {
  type: 'object',
  properties: {
    head_sha: { type: 'string' }, pushed: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' } },
    not_fixed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
    merged_forward: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
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
    marked_ready: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['head_sha', 'ci', 'blocking', 'marked_ready', 'summary'],
}

const COMMON = (p) => `PR #${p.pr_number} in optomachina/Overdrafter (branch ${p.branch} -> base ${p.base}). Unit key: ${p.key}. Linear: ${p.issue || 'none (workspace issue limit; issue pending)'}.
Unit spec (acceptance criteria are binding): read the object with "key": "${p.key}" from ${p.spec_file}.
Environment rules: read ${S}/ENV.md (DB commands under flock /tmp/ovd-supabase.lock; Playwright under flock /tmp/ovd-e2e.lock; #564-based branches run Playwright as user ubuntu; Deno function tests cannot run here). GitHub via MCP tools (ToolSearch "select:mcp__github__pull_request_read,mcp__github__get_commit"). Do NOT merge anything, do NOT touch production, credentials or providers.
${p.prior_file ? 'Earlier verification run (interrupted by an outage) recorded findings at an older head; a partial fix may have landed since. Read ' + p.prior_file + ' and re-check EVERY listed finding at the current head (still present = report it again with fresh evidence; fixed = say so in checks_run).\n' : ''}KNOWN OWNER-BLOCKED CONDITIONS (classify these as NONBLOCKING with the prefix "OWNER-BLOCKED:", never as blocking, provided the PR body discloses them truthfully): (a) no Linear child issue exists because the Linear workspace hit its free-plan issue limit and raising it is a protected purchase awaiting Blaine (a PR body that calls this an "owner decision" or otherwise misstates the cause IS a blocking false claim, fixable by editing the body); (b) CodeRabbit/Codex have not reviewed because the PR is still a draft or rate-limited (the final gate marks the PR ready to trigger them; a missing bot review is not a reviewer-round blocker); (c) anything that needs a protected action (production, credentials, providers, purchases, Workstation/SolidWorks, Sonar UI false-positive marking) or an owner decision listed in the run's open questions; (d) sonarcloud.io itself is unreachable from this container (egress 403), so per-issue Sonar text may be unreadable: a PR that says so truthfully and dispositions every issue it CAN see (GitHub check-run annotations / quality-gate summary) is fine. Real defects, false evidence claims, vacuous tests, unmet acceptance criteria that this PR can fix, red required CI, and Sonar issues readable on changed lines without a written disposition remain BLOCKING.
${p.no_parent_mention ? 'Policy: the PR title/body/commits must NOT contain ' + p.no_parent_mention + ' (a bare parent mention auto-closes Linear parents).' : ''}`

const LENSES = [
  { key: 'acceptance', text: 'LENS acceptance & correctness. Try to REFUTE the claim that this PR fully and correctly meets every acceptance criterion of its unit spec. Read the whole diff (get_diff / git diff base...head). Look for logic errors, unhandled edge cases, vacuous assertions (tests that would pass even if the behavior regressed), scope creep, mismatches with repository conventions, stale or wrong line references, and PR body claims not backed by evidence. Read-only: do not push.' },
  { key: 'boundary', text: 'LENS security, data boundaries & policy. Try to REFUTE the claim that this PR is safe and policy-compliant. Check RLS/grants/SECURITY DEFINER/search_path in any SQL, secret or PII exposure, error-message leakage, protected-action creep (production, providers, credentials), migration numbering and free-quote CI profile pins, AGENTS.md rules (one bounded issue per PR, truthful evidence, no skipped check called passed), the parent-ID mention policy, and whether the PR body/Linear claims match the code. Read-only: do not push.' },
  { key: 'reproduce', text: 'LENS independent reproduction. In your own isolated worktree, check out the exact PR head SHA and independently re-run the unit verification commands (respect the locks). Then perform at least one mutation or failure-first check: deliberately break the behavior under test in a scratch edit (never commit or push it) and confirm the new test fails; revert. Also read the PR check runs at the head (get_check_runs), Sonar annotations if retrievable (GitHub REST check-run annotations), and any bot comments/review threads. A failing required CI check at the head is blocking; pending checks are non-blocking but must be reported. Do not push.' },
]

async function verifyOne(p) {
  let clean = 0, fixRounds = 0, round = 0, reviewerFailures = 0
  const history = []
  let lastHead = p.head_sha || ''
  if (p.pending_fix_file) {
    fixRounds++
    const pre = await agent(`${COMMON(p)}\nYou are the single writer for branch ${p.branch} for fix round ${fixRounds} (a carried-over round from a verification run interrupted by an outage). In your isolated worktree: git fetch origin; git checkout -B ${p.branch} origin/${p.branch} (never rebase/amend/force-push). Read ${p.pending_fix_file}: it holds the latest reviewer findings (and any partial fix result) at an earlier head. Re-verify every BLOCKING finding at the current head first; fix each that is real and still present (if wrong or already fixed, explain in not_fixed). Apply the KNOWN OWNER-BLOCKED CONDITIONS rule above: do not try to fix those; make sure the PR body discloses them truthfully. Also apply plainly-correct nonblocking nits that touch files this PR already changes. Re-run the unit verification commands (locks!), commit with the ENV.md trailer, push. ${p.stacked_above && p.stacked_above.length ? 'Then merge-forward into ' + p.stacked_above.join(', ') + ' in order (git merge --no-ff origin/' + p.branch + '; stop and report on a judgment conflict), run quick checks, push.' : ''} Update the PR body evidence (current head SHA, checks) via mcp__github__update_pull_request. If nothing needed a code change but the body needed correction, edit the body and set pushed=false with head_sha = current head.`,
      { label: `fix:${p.key}:f${fixRounds}`, phase: 'Fix', schema: FIX, isolation: 'worktree', effort: 'max' })
    history.push({ round: 0, head: lastHead, clean: false, carried_over: true, fixed: pre ? pre.fixed : [], not_fixed: pre ? pre.not_fixed : [], new_head: pre ? pre.head_sha : null })
    if (pre && pre.head_sha) lastHead = pre.head_sha
  }
  while (clean < CLEAN_NEEDED) {
    round++
    const reviews = (await parallel(LENSES.map(l => () => agent(
      `${COMMON(p)}\nRound ${round}. ${l.text}\nOnly findings that would make a careful maintainer refuse to merge (wrong behavior, unmet acceptance, vacuous test, security/policy violation, red CI, false evidence claim) are "blocking"; style nits are "nonblocking". Default to skepticism, but every finding needs concrete evidence (file:line, command output). Previous rounds (for context; verify independently, do not assume they are right): ${JSON.stringify(history.map(h => ({ round: h.round, blocking: h.blocking, fixed: h.fixed })))}`,
      { label: `review:${p.key}:r${round}:${l.key}`, phase: 'Review', schema: FINDINGS, effort: 'max', isolation: l.key === 'reproduce' ? 'worktree' : undefined }
    )))).filter(Boolean)
    const blocking = reviews.flatMap(r => (r.findings || []).filter(f => f.severity === 'blocking').map(f => ({ lens: r.lens, ...f })))
    const nonblocking = reviews.flatMap(r => (r.findings || []).filter(f => f.severity !== 'blocking').map(f => ({ lens: r.lens, ...f })))
    lastHead = (reviews.find(r => r.head_sha) || {}).head_sha || lastHead
    if (reviews.length < 3) {
      log(`${p.key} r${round}: only ${reviews.length}/3 reviewers returned; retrying the round without counting it`)
      reviewerFailures++
      round--
      if (reviewerFailures >= 3) {
        return { key: p.key, pr_number: p.pr_number, status: 'reviewer-failure', head_sha: lastHead, rounds: round, history, open_blocking: blocking, nonblocking }
      }
      continue
    }
    if (!blocking.length && reviews.length === 3) {
      clean++
      history.push({ round, head: lastHead, clean: true, blocking: [], nonblocking: nonblocking.map(f => f.title) })
      log(`${p.key} r${round}: clean (${clean}/${CLEAN_NEEDED})`)
      continue
    }
    clean = 0
    if (fixRounds >= MAX_FIX_ROUNDS) {
      history.push({ round, head: lastHead, clean: false, blocking: blocking.map(f => f.title), stopped: 'max fix rounds' })
      log(`${p.key}: stopping after ${fixRounds} fix rounds with blocking findings`)
      return { key: p.key, pr_number: p.pr_number, status: 'needs-human', head_sha: lastHead, rounds: round, history, open_blocking: blocking, nonblocking }
    }
    fixRounds++
    const fix = await agent(`${COMMON(p)}\nYou are the single writer for branch ${p.branch} for this fix round (${fixRounds}). In your isolated worktree: git fetch origin; git checkout -B ${p.branch} origin/${p.branch} (never rebase/amend/force-push). Fix every BLOCKING finding below that is real (re-verify each first; if a finding is wrong, do not change code and explain why in not_fixed). Also apply plainly-correct nonblocking nits that touch files this PR already changes. Re-run the unit verification commands (locks!), commit with the ENV.md trailer, push. ${p.stacked_above && p.stacked_above.length ? 'Then merge-forward: for each stacked branch ' + p.stacked_above.join(', ') + ' (in order), check it out, `git merge --no-ff origin/' + p.branch + '` (resolve conflicts minimally; if a conflict needs judgment, stop and report), run that branch\'s quick checks, push.' : ''} Update the PR body evidence (current head SHA, checks) via mcp__github__update_pull_request. If a finding needs an owner decision or a protected action, do not guess; list it in not_fixed with the reason.\nBLOCKING FINDINGS: ${JSON.stringify(blocking)}\nNONBLOCKING: ${JSON.stringify(nonblocking)}`,
      { label: `fix:${p.key}:f${fixRounds}`, phase: 'Fix', schema: FIX, isolation: 'worktree', effort: 'max' })
    history.push({ round, head: lastHead, clean: false, blocking: blocking.map(f => f.title), fixed: fix ? fix.fixed : [], not_fixed: fix ? fix.not_fixed : [], new_head: fix ? fix.head_sha : null })
    if (fix && fix.head_sha) lastHead = fix.head_sha
    if (!fix || !fix.pushed) {
      log(`${p.key}: fixer made no push (${fix ? fix.not_fixed.length : 'no result'} not fixed)`)
      if (fix && fix.not_fixed.length && !fix.fixed.length) {
        return { key: p.key, pr_number: p.pr_number, status: 'needs-human', head_sha: lastHead, rounds: round, history, open_blocking: blocking, nonblocking }
      }
    }
  }
  const gate = await agent(`${COMMON(p)}\nFINAL GATE at the current PR head. (1) Fetch the PR head SHA. (2) Read all check runs at that head; if any are still queued/in progress, poll (foreground bash until-loops of <= 9 minutes per call, e.g. comparing \`git ls-remote origin ${p.branch}\` and re-calling get_check_runs between waits) for up to ~25 minutes total. (3) Read SonarCloud results: the quality-gate check and its annotations via GitHub REST (https://api.github.com/repos/optomachina/Overdrafter/check-runs/<id>/annotations — public, unauthenticated, rate-limited; use sparingly). For every new Sonar issue on lines this PR changed, decide: real defect (blocking) vs. accepted with a written reason. (4) Read PR comments, reviews and review threads (bots and humans). (5) If CI is green, there are no blocking items, and the PR is a draft, mark it ready for review so CodeRabbit runs (GitHub REST POST /repos/optomachina/Overdrafter/pulls/${p.pr_number}/ready_for_review is not available via MCP; use mcp__github__update_pull_request with draft=false). Post ONE PR comment summarizing the adversarial verification: rounds, final head SHA, checks, Sonar dispositions, what was not verifiable here (end with the required footer from ENV.md). ${p.issue ? 'Update ' + p.issue + ' rolling Linear comment and move it to "Human Review" only if CI is green and nothing is blocking (otherwise keep In Progress / set Blocked with the cause).' : ''} Do not merge.\nVerification history: ${JSON.stringify(history)}`,
    { label: `gate:${p.key}`, phase: 'Gate', schema: GATE, effort: 'max' })
  return { key: p.key, pr_number: p.pr_number, status: gate && gate.blocking && gate.blocking.length ? 'gate-blocked' : 'verified', head_sha: (gate && gate.head_sha) || lastHead, rounds: round, history, gate }
}

const lanes = args.lanes || []
const results = await parallel(lanes.map(lane => async () => {
  const out = []
  for (const p of lane) out.push(await verifyOne(p))
  return out
}))
return { results: results.flat() }
