export const meta = {
  name: 'implement-units-sequenced',
  description: 'Implement bounded units in order: one isolated worktree, one single writer per unit, failure-first evidence, one draft PR (or existing-PR commits), then one independent reviewer per unit',
  phases: [
    { title: 'Implement', detail: 'one writer per unit; model/effort per unit' },
    { title: 'Review', detail: 'one read-only adversarial reviewer per unit' },
  ],
}

const S = '/tmp/claude-0/-home-user-Overdrafter/b20cace5-8784-51f8-a7b4-1ed188995a77/scratchpad/run'

const RESULT = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    status: { type: 'string', enum: ['pr-opened', 'pr-updated', 'blocked', 'failed'] },
    issue: { type: 'string' },
    branch: { type: 'string' },
    base: { type: 'string' },
    head_sha: { type: 'string' },
    pr_number: { type: 'number' },
    pr_url: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' }, evidence: { type: 'string' } }, required: ['command', 'result'] } },
    failure_first: { type: 'string', description: 'what failed before the change / under mutation, with exact output excerpt' },
    not_verified_here: { type: 'array', items: { type: 'string' } },
    owner_blocked: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['key', 'status', 'issue', 'branch', 'checks', 'not_verified_here', 'owner_blocked'],
}

const REVIEW = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    head_sha: { type: 'string' },
    verdict: { type: 'string', enum: ['clean', 'blocking', 'owner-blocked-only'] },
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocking', 'owner-blocked', 'nonblocking'] },
      title: { type: 'string' }, evidence: { type: 'string' }, suggested_fix: { type: 'string' } }, required: ['severity', 'title', 'evidence'] } },
    checks_run: { type: 'array', items: { type: 'string' } },
    not_verified_here: { type: 'array', items: { type: 'string' } },
  },
  required: ['key', 'head_sha', 'verdict', 'findings', 'checks_run'],
}

function implementPrompt(u) {
  return `You are the sole implementer (SINGLE WRITER) of ONE bounded unit in optomachina/Overdrafter, inside an isolated git worktree (your cwd). Never edit /home/user/Overdrafter itself.
Read ${S}/ENV.md first and follow it exactly (shared DB lock, e2e lock, node_modules symlink rules, trailers, PR footer, protected actions, acceptance honesty, parent-ID policy, no merging).
Unit key: ${u.key}. Linear issue: ${u.issue}. Branch: ${u.branch}. Base: ${u.base}.
FULL UNIT SPEC: read ${u.spec_file} and find the object whose "key" is "${u.key}" (search all lanes); its description/guidance/failure_first/verification/files are binding. Also read the Linear issue ${u.issue} (ToolSearch "select:mcp__Linear__get_issue,mcp__Linear__list_comments,mcp__Linear__save_comment,mcp__Linear__save_issue") for the authoritative acceptance criteria; if the two disagree, the Linear issue wins and you note the difference.
${u.context || ''}
PROCEDURE
1. git fetch origin ${u.branch} ${u.base}. ${u.existing_branch ? 'The branch already exists on origin with prior commits: `git checkout -B ' + u.branch + ' origin/' + u.branch + '` and add commits on top only (never rebase/amend/force-push).' : 'Create it: `git checkout -B ' + u.branch + ' origin/' + u.base + '`.'} Record \`git rev-parse HEAD\` as the input revision.
2. node_modules per ENV.md (this branch is based on ${u.lockfile_family === '564' ? '#564: use /home/user/wt/base564 symlinks' : 'main: use /home/user/Overdrafter symlinks'} unless the lockfiles differ; then npm ci in your worktree with TMPDIR on /dev/shm).
3. Post or update ONE rolling Linear comment on ${u.issue} (Plan / Acceptance criteria / Validation as checklists, Artifacts, Complexity report). Edit the same comment later; never spam.
4. Prove the failure first exactly as the spec says, and keep the exact output excerpt (red run recorded).
5. Implement the smallest change that satisfies every acceptance criterion. Do not widen scope; record unrelated findings in notes.
6. Run the targeted checks, then the relevant broader checks named in the spec (locks!). Mutation checks run on scratch copies only, never committed. Never call a skipped, filtered or timed-out check a pass. Things that cannot run here (Deno, Windows, hosted CI, production) go in not_verified_here; criteria needing an owner/protected action go in owner_blocked and stay unticked.
7. Commit with clear messages and the ENV.md trailer. Push with \`git push -u origin ${u.branch}\` (retry only on network errors).
8. ${u.existing_pr ? 'Update existing draft PR #' + u.existing_pr + ' body via mcp__github__update_pull_request (keep the template sections; refresh head SHA and evidence).' : 'Open a DRAFT PR (ToolSearch "select:mcp__github__create_pull_request,mcp__github__get_file_contents"), owner optomachina, repo Overdrafter, head ' + u.branch + ', base ' + u.base + '. Title starts with "' + u.issue + ': ". Mirror .github/pull_request_template.md; the body names the exact head SHA, the failure-first evidence, every check with its command and result, what was NOT verified here, owner-blocked criteria as unticked with the reason, and ends with the attribution lines from ENV.md. Run `node scripts/validate-pr-body.mjs` against a body file if the script supports it.'}
9. Update the rolling Linear comment with the PR link, head SHA and evidence; attach the PR link to ${u.issue} only (never to a parent). Leave the issue In Progress.
Return the structured result. On a causal blocker (missing dependency, protected boundary, owner decision), stop and return status "blocked" with the exact blocker instead of guessing.`
}

const units = args.units || []
const results = []
for (const u of units) {
  phase('Implement')
  const r = await agent(implementPrompt(u), { label: `impl:${u.key}`, phase: 'Implement', schema: RESULT, isolation: 'worktree', model: u.model || 'opus', effort: u.effort || 'medium' })
  log(`${u.key}: ${(r && r.status) || 'failed'} ${(r && r.pr_url) || ''}`)
  if (!r || r.status === 'blocked' || r.status === 'failed') { results.push({ key: u.key, impl: r, review: null }); continue }
  phase('Review')
  const rev = await agent(`READ-ONLY adversarial reviewer (do not push, do not comment on GitHub or Linear). Read ${S}/ENV.md. Unit ${u.key} (${u.issue}) on PR #${r.pr_number || u.existing_pr} branch ${u.branch} at head ${r.head_sha}; spec in ${u.spec_file} (key "${u.key}") and Linear issue ${u.issue}. The implementer claims: checks=${JSON.stringify(r.checks)}; failure_first=${JSON.stringify(r.failure_first)}; not_verified_here=${JSON.stringify(r.not_verified_here)}; owner_blocked=${JSON.stringify(r.owner_blocked)}.
Try to REFUTE, with file:line and command evidence: (1) every acceptance criterion ticked in the PR body is actually met at this head; (2) the tests are non-vacuous (re-run the key failure-first or mutation check yourself in your own worktree, with the locks, on a scratch copy; never commit); (3) SQL safety for any migration (byte-for-byte copy claims, SECURITY DEFINER, search_path, grants restated, migration numbering, profile pins); (4) the PR body matches the head (SHA, files, no release-parent identifiers, session link, owner-blocked items unticked); (5) policy: one bounded issue, no scope creep. Severity: blocking (real defect, false claim, vacuous test, unmet fixable criterion), owner-blocked (needs protected action/owner decision; stays a blocker for its criterion), nonblocking.`,
    { label: `review:${u.key}`, phase: 'Review', schema: REVIEW, isolation: 'worktree', model: u.review_model || 'opus', effort: u.review_effort || 'high' })
  log(`${u.key}: review ${(rev && rev.verdict) || 'none'}`)
  results.push({ key: u.key, impl: r, review: rev })
}
return { results }
