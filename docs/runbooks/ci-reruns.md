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
