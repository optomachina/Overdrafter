# Secret scanning (OVD-872)

Two layers keep secrets out of the repo:

1. **Path block** (`scripts/check-secret-paths.mjs`, in repo, no dependencies).
   It rejects files whose path says "secret", whatever their contents.
2. **Content scan** (gitleaks, using `.gitleaks.toml`). It finds secret-shaped
   values in any file.

Both run on every pull request in the `secret-scan` job,
[`.github/workflows/secret-scan.yml`](#workflow-githubworkflowssecret-scanyml).
Blaine approved the pinned gitleaks v8.30.1 binary and this report-mode
workflow on 2026-10-16: "secret scanning tool is approved".

The job runs in **report mode** for one week: findings are printed and never
fail it. It is not a required check, and the `ci` aggregate does not need it.
Making it required, or switching either layer to enforce, is a **later,
separate approval**; this approval does not cover it.

## Path block

```sh
npm run secrets:paths                                   # HEAD^1..HEAD, report mode
npm run secrets:paths -- --base-ref origin/main         # whole branch
npm run secrets:paths -- --base-ref origin/main --enforce --json
```

It checks the files **added or modified** on `--head-ref` (default `HEAD`)
since its merge-base with `--base-ref` (default `HEAD^1`), the same as
`git diff base...head`. Commits that land on the base after the branch point
are not counted. It looks only at that diff, so files from older history are
ignored, and deleting a sensitive file is never a finding. Renames count as an
add of the new path.

Blocked basenames (case-insensitive), from `SENSITIVE_PATH_RULES`:

| Rule | Pattern |
| --- | --- |
| `pem` | `*.pem` |
| `key` | `*.key` |
| `p12` | `*.p12` |
| `id_rsa` | `id_rsa*` |
| `env` | `.env*` |
| `storage_state` | `*storage-state*.json` |

Allowed exceptions:

- `.env.example`, which holds placeholders only.
- `.envrc`, but only when every line is blank, a comment, or a bare
  `source`, `source_env` or `dotenv` of a file (for example `dotenv .env.local`).
  Arguments may not contain shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`,
  `(`, `)`, `<`, `>`, `=`), so an `.envrc` cannot set a value or run a command.
  Values belong in the git-ignored file it loads.

`SENSITIVE_PATH_RULES` is the one list. OVD-873's `docs/sensitive-paths.json`
landed in PR #818; moving this list onto it is a follow-up, so keep the two in
sync until then.

Output has paths, rule ids and reasons only. The checker reads file contents
only to evaluate `.envrc`, and it never prints them. Git is called as
`/usr/bin/git` with an argument array, and nothing touches the network.

Exit codes: `0` in report mode (always) or when clean; `1` with `--enforce`
and findings; `2` for a usage error, or a missing ref or no merge-base with
`--enforce`. In report mode, a missing ref or no merge-base prints `skipped`
and exits 0.

`npm run test:portable-node` runs `scripts/check-secret-paths.node-test.mjs`.
That test runs the checker on `HEAD^1..HEAD` in report mode, never fails on
findings, and skips when there is no `HEAD^1` (shallow or single-commit
checkouts). The behaviour itself is covered by `scripts/check-secret-paths.test.mjs`
(vitest). On pull requests the `secret-scan` job runs the **base** copy of the
checker on the PR range (see below).

### Test coverage and follow-ups

- `scripts/check-secret-paths.test.mjs` covers the path block. Its fixtures
  hold synthetic AWS, Stripe, JWT and PEM values, built at runtime, to prove
  the checker never prints file contents.
- `scripts/secret-scan-workflow.test.mjs` covers the workflow. It pins the
  approved shape (triggers, permissions, SHA pins, the gitleaks hash, report
  mode, outside `ci`). It also runs each step's `run:` block under `bash -e`,
  as GitHub does, with a stub `gitleaks` and stub `curl`: clean, findings and
  crash cases each write a step summary and exit as described below.

Neither suite runs the real gitleaks binary. The first live run is the
`secret-scan` job on this PR. These real-binary checks are **follow-ups**,
due before the job is made required:

- gitleaks catches a synthetic AWS access key, Stripe secret key, JWT and PEM
  private key added in a PR range.
- The redacted JSON report and the job log contain none of those values.
- A head-side `.gitleaksignore` is never loaded, and inline `gitleaks:allow`
  (see below) behaves the way the decision on that gap says.

## gitleaks config and gate_loosening

`.gitleaks.toml` extends the gitleaks default rules (`[extend] useDefault = true`)
and has an empty allowlist. gitleaks rejects an `[[allowlists]]` table with no
checks in it, so the empty allowlist is "no entries". A commented template shows
the shape of an entry.

Every allowlist exception goes in `.gitleaks.toml`, one narrowly scoped entry
each, with a description naming the approving card. gitleaks also skips any
finding whose fingerprint is listed in a `.gitleaksignore` file. **Any edit to
`.gitleaks.toml` or `.gitleaksignore`, in any directory** (add, modify or
delete), is **gate_loosening**: it needs a Grok Bot countersign plus Blaine's
card. The path block reports these as `gate_loosening` entries with
`requires: ["grokbot_countersign", "blaine_card"]`. They are report-only and
never change `ok` or the exit code.

The workflow closes the two file-based bypasses:

- It reads `.gitleaks.toml` and the path-block script from the **base** commit.
- It never uses the head copy of `.gitleaksignore`: it deletes the checked-out
  copy and passes `--gitleaks-ignore-path` pointing to an empty file in
  `$RUNNER_TEMP`.

**Known gap, still open:** gitleaks skips any line carrying an inline
`gitleaks:allow` comment, and that comment arrives with the PR's own content.
There is no gitleaks flag to turn it off. So a PR **can** still hide a secret
from the content scan this way, and the path block does not look at file
contents. Options: grep the PR's added lines for `gitleaks:allow` and report
each one as gate_loosening, or accept the gap and rely on review. Decide this
before the job is made required. Until then, do not read the scan as proof that
a PR cannot loosen it.

**Known gap, still open: merge commits.** gitleaks reads the range with
`git log -p`, which prints no diff for a merge commit. So content that appears
only in a merge's conflict resolution is most likely not scanned. The first
live run on PR #825 points this way: it reported 3 commits scanned for a range
of 4, and the fourth is a merge. The path block diffs trees, so it still sees a
sensitive path added in a merge. Confirm this on the pinned version, and
decide how to cover it (for example, a second gitleaks pass over the
`merge-base..head` diff) before the job is made required.

## Optional pre-commit hook (docs only)

This is not installed automatically, and nothing in the repo turns it on. To
use it locally, install gitleaks yourself (verify the checksum as the workflow
does) and add `.git/hooks/pre-commit`:

```sh
#!/bin/sh
# Scan staged changes only; --redact keeps matched values out of the terminal.
exec gitleaks git --pre-commit --staged --redact --no-banner --config .gitleaks.toml
```

Then run `chmod +x .git/hooks/pre-commit`. The path block works on commits,
not on the index, so run it before you push:

```sh
npm run secrets:paths -- --base-ref origin/main --enforce
```

## Workflow: `.github/workflows/secret-scan.yml`

**Ships in report mode.** Blaine's approval on 2026-10-16 ("secret scanning
tool is approved") covers two things: the pinned gitleaks binary and this
report-mode workflow with `continue-on-error`. It does not cover making the
job required or enforcing.

Pinned inputs. Each was re-verified on 2026-10-16 before use:

- gitleaks **v8.30.1** (the latest release), `linux_x64` tarball, SHA-256
  `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`. That is the
  `linux_x64` line of the official
  `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt`,
  and it matches the asset digest GitHub reports for the release. The job
  checks it with `sha256sum -c` before extracting anything.
- Actions are pinned by full commit SHA, and each tag ref resolves to that
  commit: `actions/checkout` v5.1.0 (`fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`)
  and `actions/upload-artifact` v4.6.2 (`ea165f8d65b6e75b540449e92b4886f43607fa02`).

Shape:

- Trigger is `pull_request` only (never `pull_request_target`). Top-level
  `permissions: contents: read`, no secrets and no token. Checkout uses
  `persist-credentials: false`.
- Every `${{ }}` value reaches the shell through `env:` (`BASE_SHA`,
  `HEAD_SHA`), never inside a `run:` block. The step checks that both are full
  commit SHAs present in the checkout before reading anything, because an
  empty `BASE_SHA` would turn `"$BASE_SHA:.gitleaks.toml"` into the PR's
  index copy.
- The config and the path-block script are the **base** copies (`git show
  "$BASE_SHA:..."`), never the PR's. When the base has no `.gitleaks.toml`
  yet, gitleaks runs its default rules (`[extend] useDefault = true`). When the
  base has no path block yet, that step reports `Skipped` and exits 0. Both
  hold for the PR that adds this workflow.
- gitleaks scans the PR's commits only (`--log-opts base..head`, which in `git
  log` means commits on head that are not on base) with `--redact`. The only
  artifact is the redacted JSON report, kept for 7 days.
- The path block diffs head against `merge-base(base, head)`, so base commits
  after the branch point are not counted.
- The job has `continue-on-error: true`, is not a required check, and is not
  in the `ci` aggregate's `needs`.

Step behaviour. GitHub runs each `run:` block as `bash -e`. Every exit code
that matters is captured with `|| rc=$?`, so `-e` never stops a step before it
writes its step summary.

| Case | Summary | Step exit |
| --- | --- | --- |
| gitleaks finds nothing | "No secrets found" | 0 |
| gitleaks findings | count, then rule, file, line and commit per finding, plus a `::warning` annotation | 0 (report mode) |
| gitleaks error, panic, no report, or exit code and report disagree | `ERROR` plus the redacted log | 1 |
| gitleaks download, checksum or start fails | `ERROR` | 1 |
| Blocked paths or gate_loosening | the checker's report, flagged | 0 (report mode) |
| Path block crashes or prints no result | `ERROR` plus its output | 1 |
| Missing or unknown base/head SHA | `ERROR` | 1 |

- gitleaks is called with `--exit-code 3`, so findings can be told apart from
  gitleaks' own errors (exit 1) and Go panics (exit 2). A result counts as clean
  or as findings only when the exit code and the report agree.
- The step's own finding list never prints a finding's `Secret`, `Match` or
  `Line` fields, even if redaction failed. For gitleaks' own log and report,
  `--redact` masks those values, and `-v` is not passed, so the log holds only
  the summary lines.
- PR-controlled text (path names, scanner output) is printed between
  `::stop-commands::` markers, so it cannot issue workflow commands.
- A step that fails (exit 1) turns the job red, but continue-on-error keeps the
  run green, and nothing requires the job, so it never blocks a merge. gitleaks
  still runs when the path block step fails.

### Later, separate approval (not covered by the 2026-10-16 approval)

After the report week, each of these needs its own Blaine approval:

- Drop `continue-on-error`, and pass `--enforce` to the path block.
- Add `secret-scan` to the required checks. A required check must also report
  on `merge_group` (see `scripts/merge-queue-workflows.test.mjs` and
  `docs/runbooks/merge-queue.md`), so that change adds a `merge_group` no-op
  trigger. Today the workflow deliberately has none.
- Before either: decide the inline `gitleaks:allow` and merge-commit gaps, and
  add the real-binary checks listed under "Test coverage and follow-ups".
