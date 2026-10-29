# Pre-push checks and CI reruns

Before every push, from the checkout run:

```sh
bash scripts/pre-push.sh --body /path/to/pr-body.md
```

The body path is required. There is no skip flag. The script runs all preflight
stages, then the hosted PR-body gate using the merge-base of origin/main and
HEAD and the base copies of its validator and detector. Keep origin/main current
before checking. Local TypeScript resolves from the checkout's node_modules.
The full body validator also runs, with failures reported as warnings only.
Optionally pass `--verdict /path/to/comment.md` to validate every fenced
`overdrafter-verdict` block and require each SHA to match HEAD.

Each check reports one named pre-push result. Exit 0 means all required checks
passed, 1 means at least one failed, and 2 means invalid usage. A failure does
not prevent later checks from reporting their results.

Use only this path for CI reruns:

```sh
node scripts/ci-rerun-once.mjs --pr 936 --sha <full-head-sha> --caller engineer
```

The repository defaults to optomachina/Overdrafter; `--repo owner/repo` overrides
it. The script verifies the PR head, refuses if any run for that SHA has attempt
2 or higher, and requires every failed run to show infrastructure failure in
its failed-job log. It reruns failed jobs once per failed run. Cancelled runs
are excluded. Code failures must be repaired with a new commit.

Infrastructure failure is read from the failed-job log after stripping the
`job<TAB>step<TAB>timestamp` prefix on each line, because the seven fractional
digits of a timestamp can contain "429". Only two kinds of line count: a runner
annotation (the runner lost communication with the server, or received a
shutdown signal), and an error line (a GitHub `##[error]` annotation, or a
failing tool's own `error`, `npm error`, `fatal` or `curl` line) that reports
a 429, an exceeded rate limit, a `toomanyrequests` registry reply or an
unexpected EOF. Test names and test output never count. A `preflight: <stage>
FAIL` line or a rejected PR body in the same log marks a code failure and
wins over any infrastructure line. An unrecognised failure is refused as
`not-infra`, so a human decides.

The script resolves gh only from fixed system directories unless GH_BIN names an absolute path to an existing executable file owned by the current user or root and not writable by group or others; invalid overrides fail closed.

GitHub's attempt counters share the cap across hosts and sequential processes;
there is no local marker. This is not an atomic lock against simultaneous
requests before GitHub updates a counter. Coordinate one caller per PR.
A capped rerun leaves the check failing. Refusals exit 3 and never change check
conclusions. Usage errors exit 2; accepted reruns exit 0. CLI/data errors fail
closed. A truncated run listing also fails closed.

Each decision appends JSON containing ts, sha, pr, runs, caller, decision and
reason to `/workspace/ci-rerun-once.jsonl`, or `--log <path>`. If logging is
unavailable, the script emits a stderr note. No check statuses are rewritten.

Part B is not built yet: the optional ci.yml run_attempt summary step requires
card C1. It must not introduce job-level `if:` or `continue-on-error`. Box watcher
and builder prompt wiring are outside PR-A1.

## Supabase image registry

`supabase/setup-cli` v1.6.0 unconditionally exports
`SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io` to `GITHUB_ENV` for CLI >= 1.28.0, so
`supabase start` pulls from ghcr.io and can fail with `toomanyrequests`. Every
workflow therefore runs a "Pull Supabase images from public ECR" step right after
setup-cli that writes `SUPABASE_INTERNAL_IMAGE_REGISTRY=public.ecr.aws` to
`GITHUB_ENV`; the later write wins. public.ecr.aws is the CLI's own default
registry (`internal/utils/docker.go` `GetRegistry`, v2.78.1), so keep that step
next to any new or bumped setup-cli step until the action stops overriding it.
