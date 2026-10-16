# Migration immutability (OVD-871)

> **Scope (Blaine, 2026-10-16):** OVD-871 here covers migration immutability **only**. The design's
> prod-push scan (flagging `supabase db push`, `--linked`, `--db-url`, `supabase migration up`,
> `db reset --linked` and the prod project ref in runnable files) was cut from this PR and needs a
> follow-up issue.
>
> **Known gap until the card's ci.yml job lands:** the node:test wrapper runs from the PR head, so a PR
> could drop it from `test:portable-node` by editing `package.json` and `scripts/test-lane-contract.test.mjs`
> together, and that would not be reported as gate_loosening.

Applied migrations are history, so `supabase/migrations/` is append-only.
`scripts/check-migration-immutability.mjs` checks every PR from
`npm run test:portable-node`, which CI already runs (report mode). A dedicated
`migration-immutability` CI job is drafted for a card (see "CI" below).

## Rules

The checker compares the base (`HEAD^1`) with the head (`HEAD`) using
`git diff --raw -C100% --find-copies-harder` under `supabase/migrations/`.

- Only git status `A` (added) passes.
- `M` (modified), `D` (deleted), `R` (renamed), `C` (copied) and `T` (type
  change) are violations. That includes a rename that keeps the bytes (`R100`),
  an exact copy of an existing migration, and a mode-only change (for example
  `chmod +x`, reported as `mode_changed`). A rename with edits shows up as a
  delete plus an add; the delete is the violation.
- Each added file must be named `<14-digit timestamp>_<name>.sql` directly
  under `supabase/migrations/` (`invalid_name` otherwise).
- Each added file's timestamp must sort strictly after the newest timestamp at
  the base (`backdated` otherwise), and two added files cannot share one
  (`duplicate_timestamp`). If `main` gains a newer migration while a PR is open,
  the PR has to rename its file with a later timestamp.

To change what an applied migration does, add a new, later migration.

## Override: `migration-edit-approved`

The label waives the violations only when all of these hold, per the PR
timeline API (`GET /repos/{owner}/{repo}/issues/{n}/timeline`):

- the label's most recent `labeled` / `unlabeled` event is `labeled`;
- that event's actor is Blaine (GitHub login `optomachina`, the checker's
  `DEFAULT_APPROVER`, `--approver` to override in tests);
- it was created after the current head was pushed. The push time is the later
  of the `pull_request` event's `updated_at` (set when the head was pushed, and
  kept on re-runs) and any `head_ref_force_pushed` / `head_ref_restored` event.

A new push voids the label: Blaine removes and re-applies it, then re-runs the
job. A label from anyone else, or one applied before the latest push, is
ignored.

A waiver keeps the findings in the report (prefixed `WAIVED`), sets `ok` to
true and is reported as `gate_loosening` (`override_used`).

### Timestamps

Every timestamp the decision reads goes through one parser,
`parseGitHubTimestamp`: the push time (`--head-pushed-at`), and the
`created_at` of each `head_ref_force_pushed` / `head_ref_restored` event and of
each `labeled` / `unlabeled` event for `migration-edit-approved`. It accepts
only a full ISO-8601 UTC timestamp in the form GitHub sends,
`2026-10-10T09:00:00Z` or `2026-10-10T09:00:00.123Z`, and only when it
round-trips: Date's own ISO form of the parsed instant must equal the input
(fraction padded to milliseconds). Anything else is unusable. That covers
numbers, `null`, objects and arrays; a date with no time, no seconds or no `Z`;
an offset; `"1"`, `"2026"` or `"Oct 10"`; an expanded `+002026-…` year;
`2026-02-30` or `24:00:00` (which `Date.parse` would roll over); and a fraction
finer than a millisecond. `Date.parse` alone accepts several of these as real
dates, so a malformed event used to be ordered as if it were genuine.

### Fail closed

There is no override (status `unavailable`):

- outside `pull_request` runs, or when the timeline cannot be fetched;
- when the push time is unusable;
- when a `head_ref_force_pushed` / `head_ref_restored` event has an unusable
  `created_at` (the push time would be unknown);
- when a `labeled` / `unlabeled` event for `migration-edit-approved` has an
  unusable `created_at` (it cannot be ordered against the other label events,
  so a removal or a relabel by someone else could be hidden).

Events for other labels and other event kinds are not read, so their
timestamps do not matter.

## gate_loosening

Report only: it never changes `ok` or the exit code. It needs a Grok Bot
countersign on top of Blaine's card. Reasons:

- `override_used`: the label waived findings.
- `checker_changed` / `checker_removed`: the script or its node:test wrapper
  (`scripts/check-migration-immutability.node-test.mjs`) is edited or deleted.
- `ci_job_changed` / `ci_job_removed`: the `migration-immutability` job or a
  workflow line naming it changed or is gone.

## CI

### Today: `npm run test:portable-node`

`scripts/check-migration-immutability.node-test.mjs` is part of
`test:portable-node`, which the CI `test` job runs with full history. It
compares `HEAD^1` with `HEAD` (on a `pull_request` merge commit, `HEAD^1` is
the base), copies the checker from `HEAD^1` into a temp directory and runs that
copy, so a PR's edits to the checker take effect only after merge (and are
reported as `checker_changed`). When the base has no copy yet, the head copy
runs. Because it runs from that temp copy, the checker must import only Node
built-ins (`node:*`); a relative import would not resolve there. When `HEAD^1` does not exist (shallow clone, root
commit) the test is skipped.

Report mode: the report is printed as node:test diagnostics and findings never
fail the test; only a checker that cannot run does. There is no PR timeline
here, so the `migration-edit-approved` override is never applied (`unavailable`).
Locally `HEAD^1` is just the parent commit; use `npm run
migrations:immutability` to compare a branch with `origin/main`.

### Card item: `migration-immutability` job in `ci.yml`

The dedicated job is not in `.github/workflows/ci.yml`; adding it is a card
item for Blaine (workflow edits need Blaine's card before merge). The proposed
job is `scripts/fixtures/migration-immutability/ci-job.draft.yml`, and the
vitest suite runs its step script so the draft stays working. It checks out the merge
commit with `fetch-depth: 2`, runs the base copy of the checker the same way,
fetches the PR timeline with `gh api` so the override can apply, uploads the
JSON report (`ovd871.migration-immutability.v1`) as the
`migration-immutability` artifact and writes the human report to the step
summary. It has `continue-on-error: true`, does not pass `--enforce` and is not
in the `ci` aggregate. Once it lands, the node:test wrapper can be dropped.
Enforcing it (adding it to `ci` and to required checks) is a separate step that
needs Blaine.

## Local use

```sh
npm run migrations:immutability
node scripts/check-migration-immutability.mjs --base-ref origin/main --head-ref HEAD
node scripts/check-migration-immutability.mjs --base-ref origin/main --head-ref HEAD --json --enforce
```
