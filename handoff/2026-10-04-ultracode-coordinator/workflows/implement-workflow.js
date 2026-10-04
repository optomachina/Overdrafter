export const meta = {
  name: 'implement-lane-a-units',
  description: 'Implement bounded Lane A units, one worktree and one draft PR per Linear issue; lanes in parallel, stacked units in order',
  phases: [
    { title: 'Implement', detail: 'one isolated worktree per unit' },
  ],
}

const S = '/tmp/claude-0/-home-user-Overdrafter/889b9ea6-4645-598b-9361-46519e5fc8d3/scratchpad'

const RESULT = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    status: { type: 'string', enum: ['pr-opened', 'blocked', 'failed'] },
    issue: { type: 'string' },
    branch: { type: 'string' },
    base: { type: 'string' },
    head_sha: { type: 'string' },
    pr_number: { type: 'number' },
    pr_url: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'object', properties: {
      command: { type: 'string' }, result: { type: 'string' }, evidence: { type: 'string' } }, required: ['command', 'result'] } },
    failure_first: { type: 'string', description: 'what failed before the change / under mutation, with exact output excerpt' },
    not_verified_here: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['key', 'status', 'issue', 'branch', 'checks', 'not_verified_here'],
}

function implementPrompt(u, laneCtx) {
  return `You are the sole implementer (single writer) of ONE bounded unit in optomachina/Overdrafter. You run inside an isolated git worktree created for you (your current working directory). Never edit /home/user/Overdrafter itself.
Read ${S}/ENV.md first and follow it exactly (shared Supabase lock, e2e lock, node_modules symlinks, commit/PR trailers, protected actions, no merging).
Follow AGENTS.md and docs/agent-development-control-plane.md (already in your instructions). Use TEST_STRATEGY.md verification planning: failure-first, smallest deterministic check first, then the PR-boundary gate.

UNIT ${u.key}
Linear issue: ${u.issue || 'NONE (pending: workspace issue limit)'}${u.issue_url ? ' (' + u.issue_url + ')' : ''}
Title: ${u.title}
Branch: ${u.branch}   Base: ${u.base}
Files expected: ${(u.files || []).join(', ')}
Depends on (already pushed earlier in this lane, if any): ${(u.depends_on || []).join(', ') || 'none'}
${laneCtx ? 'Earlier units in this lane produced: ' + laneCtx : ''}

FULL UNIT SPEC: read it from the JSON file ${u.spec_file} — find the unit object whose "key" is "${u.key}" (search all lanes). Its fields description, guidance, failure_first, verification and files are your binding scope and acceptance. Read it completely before starting.

PROCEDURE
${u.existing_pr ? 'EXISTING PR MODE: this unit continues existing draft PR #' + u.existing_pr + ' on branch ' + u.branch + ' (created by an earlier session). Check out origin/' + u.branch + ' (git checkout -B ' + u.branch + ' origin/' + u.branch + '), add commits on top only — never rebase, amend or force-push. Do NOT open a new PR; in step 8 instead edit the existing PR body (mcp__github__update_pull_request) to add/refresh only the sections your change affects (current head SHA, your evidence), preserving the rest. If the spec says no commit is needed unless a defect is found (evidence-only), do not commit; post your evidence as a single PR comment (with the required footer) and update Linear. Return pr_number ' + u.existing_pr + '.\n' : ''}1. git fetch origin; create your branch from the base: \`git checkout -B ${u.branch} origin/${u.base.replace(/^origin\//, '')}\`. If the base is another claude/* branch from this lane and it is missing on origin, stop with status "blocked". If origin/${u.branch} already exists (a previous attempt), check it out instead and continue from it (never force-push).
2. Set up node_modules per ENV.md.
3. ${u.issue ? 'Load Linear tools via ToolSearch (select:mcp__Linear__save_issue,mcp__Linear__save_comment,mcp__Linear__list_comments,mcp__Linear__get_issue). Move ' + u.issue + ' to "In Progress" and post ONE rolling comment (Plan / Acceptance criteria / Validation as checklists, Artifacts, Complexity report) that you will later update in place (edit the same comment; do not spam).' : 'This unit has NO Linear issue yet: the Linear workspace hit its free-plan issue limit, so the child issue could not be created (raising the limit is a purchase, which is a protected action awaiting Blaine; do not describe this as an owner decision). Do not create Linear issues and do not touch Linear. Record that fact in the PR body ("Linear issue: pending — workspace issue limit; the issue spec is preserved in the run handoff") and never write any parent OVD identifier in the branch, commits, PR title or body.'}
4. Prove the failure first (or a mutation check where the contract is already enforced) and keep the exact output excerpt.
5. Implement the smallest change that satisfies the acceptance criteria. Do not widen scope; record unrelated findings in notes instead of fixing them.
6. Run the targeted checks, then the relevant broader checks (lint/typecheck/affected vitest; pgTAP via the lock; fixture/auth e2e via the lock; worker verify if worker changed). Never call a skipped, filtered or timed-out check a pass. Things that cannot run here (Deno function tests, Windows, hosted CI) go in not_verified_here.
7. Commit with a clear message and the required trailer lines from ENV.md. Push with \`git push -u origin ${u.branch}\` (retry only on network errors).
8. Open a DRAFT PR (GitHub MCP: load via ToolSearch "select:mcp__github__create_pull_request,mcp__github__get_file_contents"), owner optomachina, repo Overdrafter, head ${u.branch}, base ${u.base.replace(/^origin\//, '')}. Title starts with "${u.pr_prefix || (u.issue + ': ')}". Mirror .github/pull_request_template.md if present (and run \`npm run validate:pr-body\` if it applies to a body file). The body names the exact head SHA, failure-first evidence, checks with commands and results, what was NOT verified here, and the end-of-body attribution lines from ENV.md. ${u.no_parent_mention ? 'IMPORTANT: never write the parent identifier ' + u.no_parent_mention + ' anywhere in branch, commits, PR title or body (a bare mention auto-closes it); reference only ' + (u.issue || 'the unit title') + '.' : ''}
9. ${u.issue ? 'Update the Linear rolling comment with the PR link, head SHA and evidence; attach the PR link to ' + u.issue + ' only (save_issue links) — never attach it to a parent issue. Leave the issue In Progress (verification follows).' : 'Skip Linear.'}
Return the structured result. If you hit a causal blocker (missing dependency, protected boundary, owner decision needed), stop and return status "blocked" with the exact blocker instead of guessing.`
}

const lanes = args.lanes || []
phase('Implement')
const results = await parallel(lanes.map((lane, li) => async () => {
  const out = []
  for (const u of lane) {
    const prev = out.filter(Boolean).map(r => `${r.key} -> ${r.branch} @ ${r.head_sha || '?'} (${r.status})`).join('; ')
    if (out.some(r => r && r.status !== 'pr-opened' && (u.depends_on || []).includes(r.key))) {
      out.push({ key: u.key, status: 'blocked', issue: u.issue, branch: u.branch, checks: [], not_verified_here: [], blocker: 'upstream unit in lane did not open a PR' })
      log(`${u.key}: skipped, upstream dependency not ready`)
      continue
    }
    const r = await agent(implementPrompt(u, prev), { label: `impl:${u.key}`, phase: 'Implement', schema: RESULT, isolation: 'worktree', effort: 'max' })
    out.push(r || { key: u.key, status: 'failed', issue: u.issue, branch: u.branch, checks: [], not_verified_here: [], blocker: 'agent returned no result' })
    log(`${u.key}: ${(r && r.status) || 'failed'} ${(r && r.pr_url) || ''}`)
  }
  return out
}))
return { results: results.flat() }
