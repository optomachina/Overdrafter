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

Every workflow that starts Supabase uses
`.github/actions/supabase-image-cache` after setup-cli. The action overrides
setup-cli v1.6.0's registry setting through `GITHUB_ENV`, selecting
`docker.io` without credentials. The checked-in source is the upstream
CLI 2.78.1 `pkg/config/templates/Dockerfile`, retained at
`.github/actions/supabase-image-cache/cli-2.78.1-images.txt`.

There are three groups: `full` warms the 13 default stack images (pooler is
disabled by default); `db` warms only Postgres and shares a small entry across
all draft workflows; `tools` warms `postgres:17` for pg_dump/psql and
`supabase/pg_prove` for pgTAP. The helper supports excluded service names for
future callers. Update the source fixture and `CLI_VERSION` together with any
CLI bump. The Node contract test checks the complete upstream image definition embedded
in the actual pinned binary and compares its reported service versions using
`SUPABASE_CACHE_CLI`; CI runs both comparisons.
The start commands remain unchanged, so an omitted/new image is pulled normally.

Before restore, the helper resolves each reference's Linux platform manifest
and config digest with `docker manifest inspect -v`. The key includes the CLI version and is
`supabase-images-v2-cli-<CLI version>-<runner OS>-<architecture>-<SHA256>`, hashing the sorted
reference, manifest digest and config digest records. There are no tag-only
keys or restore prefixes. A resolution failure disables restore and save for
that group, then attempts normal pulls. No partially resolved cache is saved.

On a hit, `docker load` restores a gzip-compressed Docker archive. The helper
compares content-addressed image IDs to the registry's config digests before
assigning the exact tag the CLI expects; cached receipts are never trusted.
An unexpected tag is removed before fallback, and failure to remove it stops
the action. On a miss or corrupt archive, missing images are pulled by resolved
digest with the existing bounded throttle/backoff policy, verified, and tagged.
Manifest resolution tries Docker Hub, GHCR, then public ECR. Pulls try the
resolved source first, followed by the other registries at the same digest;
a mismatched or missing mirror manifest cannot be substituted.
Only a miss with every image verified can save a new archive. Cache-service,
archive-save and pull failures leave the regular Supabase start command's
pull/retry path available. Archives contain image IDs rather than mutable tags;
gzip and the separate database/tools groups limit duplicate storage within
GitHub's repository cache quota. Cache eviction is safe and costs a cold pull.

To bust all image entries, increment the `supabase-images-v2` prefix in
`.github/actions/supabase-image-cache/cache.mjs`. A changed image digest automatically gets a
new key. Removing a specific Actions cache entry also causes a cold rebuild;
a corrupt exact hit falls back to pulls but is not overwritten in place.
Fork PRs can restore and verify images but cannot save caches. This cache uses
no secrets or extra token permissions.
