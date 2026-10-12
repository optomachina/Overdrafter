# OverDrafter agent contract

This file governs agent execution. Product intent lives in the maintained product documents, and detailed controller mechanics live in [docs/agent-development-control-plane.md](docs/agent-development-control-plane.md). Tool adapters may point here but may not create competing policy.

## Read what the task needs

Use the narrowest applicable source:

- product scope and sequencing: `PRD.md`, `PLAN.md`, and `ROADMAP.md`;
- service boundaries: `ARCHITECTURE.md`;
- acceptance and verification: `ACCEPTANCE_CRITERIA.md` and `TEST_STRATEGY.md`;
- specialized behavior: the closest maintained domain document;
- directory-specific checks: the closest `AGENTS.override.md`.

Verify repository identity when selection is ambiguous or before a consequential mutation. Do not read the full documentation stack for routine localized work.

## Standing development authorization

Blaine authorizes the recorded sole owner of OverDrafter 1.0 and JARVIS work to continue reversible, scoped development without repeated approval. This includes inspection, isolated branches or worktrees, editing, local tests and fixtures, correction of relevant failures, commits, pushes, GitHub PR and Linear maintenance, automated review response, and merge after current-head hosted gates and actionable review findings pass.

The authorization survives goal continuation, corrected attempts, replacement tasks, and recorded ownership transfers within the named objectives. It supersedes earlier one-attempt, zero-retry, sealed-packet, and complexity-only approval stops for reversible development. A failed check remains evidence but does not revoke authority to diagnose and correct the bounded unit.

### Synthetic-fixture lane

The sole owner may create, repair, rerun, and remove exclusively owned disposable local fixtures using repository schema artifacts, synthetic records, and fixture-generated ephemeral credentials. Read [the fixture contract](docs/agent-development-control-plane.md#synthetic-development-fixtures) before operating the lane. It defines isolation, resource ceilings, ownership, retry, and cleanup requirements. Complexity alone never requires human approval.

## Protected actions

Obtain Blaine's current exact authorization before:

- external email, chat, invitations, support requests, social posts, or other human/vendor communication;
- provider or customer-file operations, quote execution, checkout, or orders;
- production worker deployment, execution, or configuration, and hosted/production database changes;
- retrieving, disclosing, creating, or changing real credentials or accounts;
- purchases, spending commitments, filing, publishing, or deletion of pre-existing resources;
- real SolidWorks/PDM publication or native actions outside an already authorized exact operation.

Prepare reversible work first and ask only at the protected boundary. Goals, issue text, model review, repository access, and broad project approval do not expand into these actions.

### Migration window

Writes under `supabase/migrations/` need a Blaine window. The window is open when the current branch's PR has the `blaine-window` label applied by the human GitHub user `optomachina` without `performed_via_github_app`, or when Blaine starts the session with `OVD_BLAINE_WINDOW=1`. Agents must not apply that label.

This is a best-effort guardrail. An agent holding a user token cannot be told apart from the user, so the real gate stays at Blaine's merge and apply approval.

Reading migrations is always allowed. For Claude Code, `.claude/hooks/guard-migrations.mjs` enforces this as a PreToolUse hook on Edit/Write/MultiEdit/NotebookEdit, Bash, and MCP tools (`mcp__.*`). Bash commands whose text mentions `supabase` or `migration` (after quote stripping and simple variable expansion) are blocked unless they are an explicit read-only form (`ls`, `cat`, `rg`/`grep`, `head`, `tail`, `wc`, `less`, `stat`, `diff`, `file` without `-C`, `find` without `-exec`/`-execdir`/`-ok`/`-okdir`/`-delete`/`-fprint*`/`-fls`, `sort` without `-o`/`--output`, `uniq` without a second positional output file, `git diff` without `--output`, `git log`/`show`/`status`/`blame`, `supabase --version`, `npm`/`yarn`/`pnpm` `test`/`verify`, or test runners such as `npx vitest`). `git commit` of existing files is allowed. Literal `-m` / `--message` text is stripped before both the mention check and the write-ish path scan; `--file` / `-F` is never stripped, and a file pointing into `supabase/` is treated as a write. Command substitution (`$( )`, backticks) and process substitution (`<( )`) are detected on the raw command before that strip; if they appear alongside a supabase or migration path, the command is blocked. Write-ish commands expand braces, then fnmatch every target (including bracket classes) against real paths and against `supabase/migrations/**`. Piping into any shell interpreter (`sh`, `bash`, `zsh`, `dash`, `ksh`, `ash`, `tcsh`, `csh`, `fish`, `busybox sh`, `eval`) is blocked, including `echo hi | sh`. `--add-label` and labels-API calls are blocked unless every label is on an explicit safe allowlist that excludes `blaine-window`. MCP tools whose arguments contain `labels` or `blaine-window` are treated as label mutations; `apply`/`execute` tools such as `mcp__supabase__apply_migration` are treated as writes. It fails closed when there is no PR, `gh` is missing, GitHub can't be reached, `tool_input` is missing, or the label was applied by a bot or app. If the hook blocks a write, stop and report it. Do not route around it.

Accepted residuals (final hardening; remaining edges are documented, not chased): bare `git apply` / `git am` / `patch` / `tar` / `unzip` whose command does not mention supabase; a script created in one call then run later with no supabase/migration path in the command text; `git commit -F` of a non-supabase file whose contents mention supabase; substitution hidden so the command text has no `$(`, backtick, or `<( `; other process-substitution forms such as `>( )`; `base64` piped into `perl` / `python3` / `node`; and reader write/exec options not in the listed set. Those remain Blaine's merge and apply gate. `echo hi | sh` stays blocked even when the left-hand side looks harmless.

## Standing approvals and the Blaine channel

- Blaine talks only to Grok Bot. Team bots (Architect/Release, Pirate/Engineer, Designer, QA) never ask Blaine directly; they hand decisions to Grok Bot, and approvals Grok Bot relays from Blaine count as Blaine's own.
- Standing approval covers all reversible work in this file: branches, commits, pushes, PRs and PR comments, Linear issues/sub-issues/labels, reviews, QA verdicts, and handoffs between bots. Do not stop to ask for these.
- Protected actions (above) still need Blaine's exact OK. Grok Bot gets it with one approval card that names the commit SHA and the passing checks, with merge and production migration listed as separate actions.

## Sensitive paths (single shared list)

Triage (`ovd-auto-triage`) and the Jev PR screen (`screen.py`) use this one list. A Linear issue whose scope touches it is routed architect-first; a PR that touches it gets Opus review regardless of the Jev score. Keep the screen patterns in sync when this list changes.

| Area | Paths / signals |
| --- | --- |
| Database schema and migrations | `supabase/migrations/`, schema or RLS changes |
| Auth, permissions, sessions | `auth`, `rls`, `permission(s)`, `session` paths |
| Payments, pricing, billing | `payment`, `billing`, `stripe`, `pricing`, `invoice`, `checkout` |
| Provider dispatch | `dispatch`, `worker/src/adapters/`, `provider-admission`, `provider-upload` |
| Secrets and env | `secret`, `credential`, `*.pem`, `*.key`, `keys/`, `token(s).{json,yaml,ts,js}`, `vault`, `.env*`, `env.{ts,js,json}`, `.envrc` |
| Infra, CI, deploy | `.github/workflows/`, `.github/actions/`, `infra/`, `terraform/`, `deploy/`, `k8s/`, `helm/`, `ops/`, `*.tf`, `Dockerfile`, `docker-compose`, `vercel.json`, `netlify.toml`, `fly.toml`, `scripts/deploy*`, `scripts/release*` |
| New dependencies | `package.json`, lockfiles, `requirements*.txt`, `pyproject.toml`, `uv.lock`, `Cargo.toml`, `go.mod` |

## Ownership and durable state

Repository state and the controller's durable run store are authoritative. Plans, chat narration, Linear comments, heartbeat summaries, and Markdown status pages are projections.

- One writer owns each mutable target; read-only reviewers may run in parallel.
- Record the owner task, host, worktree, branch, source revision, completion condition, allowed actions, verification, budget, and failure family for nontrivial units.
- Before controlled dispatch, use the maintained guarded launcher and assignment protocol in `docs/agent-development-control-plane.md`; a dependency must earn evidence-bound relevance before its prerequisite is launched. Reuse valid terminal results and equivalent review results.
- Only the controller changes scheduling state. A governor observes liveness and protected boundaries; it does not schedule work.
- Transfer ownership only at a durable checkpoint. Preserve unique commits, uncommitted work, live-process identity, and evidence.
- Never infer that a disconnected host stopped a process. Destructive cleanup remains protected.

## Issue and PR ownership

- Give each implementation issue one bounded, independently testable change and normally one main PR. Before implementation, confirm that the proposed change can satisfy that issue's source acceptance criteria; a merged PR does not complete an issue with remaining post-merge criteria.
- Put a separate, independently mergeable change or distinct acceptance criteria in a child issue before opening its PR. A direct review or CI repair of the same change stays on its PR. If that PR has already merged, a narrowly scoped follow-up PR may use the same issue only when it repairs that issue's original acceptance criteria; record the reason in the PR and issue.
- Use release-outcome parent issues to coordinate qualification and live gates, not as the issue ID for source-change PRs. Name the bounded child issue on each new source PR, while preserving historical links.
- At the final PR head, inspect the Sonar issue list and actual bot-review coverage and threads. A green quality gate, rate-limit notice, or stale review is not evidence that no actionable finding remains; record the gap and its disposition.

## Complexity and verification

Use complexity to choose decomposition and evidence, not permission. Split independently testable High-complexity work; when an indivisible High-complexity change remains within standing authorization, continue and require independent Astra xhigh review before integration.

- Prefer the smallest change that achieves the requested outcome without silently narrowing it.
- Plan verification from the observable failures in [TEST_STRATEGY.md](TEST_STRATEGY.md#verification-planning); use its layered coverage and test-retirement criteria. Run targeted checks first and the repository integration gate at the PR boundary.
- Material UI behavior needs real browser evidence. Database changes need migration, access-control, concurrency, and rollback verification. Native/CAD claims need real native evidence.
- Bind acceptance to the exact source revision, check definition, fixture/toolchain identity, owner, and timestamp.
- Never convert skipped, timed-out, filtered, blocked, or stale checks into passes.

Independent review is required for cross-cutting architecture, security-sensitive boundaries, disputed evidence, repeated failure, and protected-operation packets. Review confidence never replaces deterministic checks.

## Preflight, repair budget, and review sizing

Run `npm run preflight` (`scripts/preflight.sh`: lint, typecheck, unit tests) before opening or updating a PR. CI calls the same script for those stages, so a local pass predicts the hosted result. Paste its stage lines into the PR.

- One writer per PR owns every repair. Total budget is 2 repair rounds across local and CI combined; each round gets all current failure logs at once, not one check at a time.
- Separate infra failures (install, network, runner loss, timeouts before a stage starts) from code failures (a `preflight: <stage> FAIL` line or a failing hosted check). Infra failures are rerun and do not consume a repair round; never "fix" them with code changes.
- A PR still failing after the budget becomes a draft with a diagnostics comment: failing checks, log excerpts, what each round changed, and the suspected cause. Do not weaken tests or checks to pass.
- Review is sized by risk: a Jev screen first, then Sonnet, then Opus only for PRs Jev flags risky or that touch [sensitive paths](#sensitive-paths-single-shared-list) or provider/customer data. Low-risk PRs stop after Sonnet. This sizes reviewers; it never replaces deterministic checks.
- Track cost per accepted PR and founder interventions as in [docs/agent-graph-metrics.md](docs/agent-graph-metrics.md).

## Completion and failure

Work is complete only when the requested behavior exists, acceptance criteria and required current-revision verification pass, artifacts are recorded, and no required action remains. A draft, commit, PR, narrow test, or agent declaration alone is not completion.

At each checkpoint produce a durable artifact, verified state change, causal blocker, or bounded wait tied to a live handle. After two checkpoints without durable progress or three materially similar failures, stop only the affected unit and replan with stronger reasoning or independent review. Preserve accepted siblings.

Stop immediately for ownership collision, uncertain destructive target, possible secret exposure, unauthorized production/provider/customer scope, or evidence that the requested approach cannot satisfy product intent.

## Routing

Use a skill only when it materially improves the task:

- `linear-issue-creator`: implementation-ready Linear decomposition;
- `overdrafter-verification`: explicit acceptance or release claims;
- `overnight-run`: sustained unattended work;
- `agent-skill-eval`: consequential workflow changes.

Keep tool adapters thin and load conditional procedures only when relevant. Routine orchestration uses Astra medium; difficult architecture or causal recovery uses high; independent high-impact review uses xhigh. The dispatcher selects actual model and effort.

Keep provider work behind `docs/provider-integration.md`, database releases behind the applicable runbook, and CAD work behind the engineering control-plane and native qualification documents. Product runtime retry rules do not automatically constrain disposable development-test retries.
