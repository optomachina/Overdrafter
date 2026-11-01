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
fail it. The `ci` aggregate does not need it. A read-only check on
2026-10-31 found that branch protection on `main` already lists `secret-scan`
as a required check. No approval for making it required is recorded in this
repo; the 2026-10-16 approval does not cover it. Switching either layer to
enforce is still a **later, separate approval**. A scanner that cannot run
(download, checksum or git error) turns the job red. Whether that red job,
under job-level `continue-on-error`, blocks the PR is not confirmed yet (see the
[workflow section](#workflow-githubworkflowssecret-scanyml)).

## Path block

```sh
npm run secrets:paths                                   # HEAD^1..HEAD, report mode
npm run secrets:paths -- --base-ref origin/main         # whole branch
npm run secrets:paths -- --base-ref origin/main --enforce --json
```

It checks the files **added, modified or type-changed** (for example a file
replaced by a symlink) on `--head-ref` (default `HEAD`) since its merge-base
with `--base-ref` (default `HEAD^1`), the same as `git diff base...head`.
Commits that land on the base after the branch point are not counted. It looks
only at that diff, so files from older history are ignored, and deleting a
sensitive file is never a finding. Renames count as an add of the new path.

Blocked basenames (case-insensitive), from `SENSITIVE_PATH_RULES`:

| Rule | Pattern |
| --- | --- |
| `pem` | `*.pem` |
| `key` | `*.key` |
| `p12` | `*.p12` |
| `id_rsa` | `id_rsa*` |
| `env` | `.env*` |
| `storage_state` | `*storage-state*.json` |

Matching is on the whole basename: `*` matches any character, including a
line feed, so `a<LF>.pem` is still `pem`.

**Control characters fail closed.** Any checked path that contains a control
character (line feed, carriage return, tab, any other C0 or C1 control) or a
Unicode line or paragraph separator is blocked with rule `control_char`,
whatever its name, plus any glob rule it also matches. Paths come from
`git diff -z`, so git never quotes or alters them first. The human report
prints these characters as `\uXXXX`, so a name cannot start a line of its own
(for example a fake `secret-paths: OK`, or a closing code fence in the step
summary). Deleting such a file is not a finding.

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
  mode, outside `ci`) and the exact gitleaks arguments. It also runs each
  step's `run:` block under `bash -e`, as GitHub does, with a stub `gitleaks`
  and stub `curl`: clean, findings and crash cases each write a step summary
  and exit as described below.
- One stub in that suite runs the same `git log -p -U0 <log-opts>` that
  gitleaks v8.30.1 runs, on a repo built to hide content from it: a root
  `* -diff`, a nested `secret.txt binary`, a file with a NUL byte, a conflict
  resolution and an edit made inside a clean merge. Plain `git log -p` shows
  none of the five; the scan step reports all five.

Neither suite runs the real gitleaks binary. These real-binary checks are
**follow-ups**, due before the job is made enforcing (branch protection
already lists it as required; see the top of this file):

- gitleaks catches a synthetic AWS access key, Stripe secret key, JWT and PEM
  private key added in a PR range.
- The redacted JSON report and the job log contain none of those values.
- A head-side `.gitleaksignore` is never loaded, and a line carrying
  `gitleaks:allow` is still reported.
- A `-diff` attribute and a NUL-byte file are still reported, and so are a
  conflict resolution and an edit inside a merge. For the merge cases this
  also checks gitleaks' diff parser (`go-gitdiff` v0.9.1) on `remerge` output;
  see the parser detail at the end of "What the scan still does not see".
- The base `.gitleaks.toml` loads. No run has used it yet, because the base of
  this PR has none.

## gitleaks config and gate_loosening

`.gitleaks.toml` extends the gitleaks default rules (`[extend] useDefault = true`)
and adds no allowlist entries of its own. gitleaks rejects an `[[allowlists]]`
table with no checks in it, so there is no table yet. A commented template
shows the shape of an entry.

`useDefault` also brings the default config's **global allowlist**, so some
paths are never scanned. Examples: any path containing `gitleaks.toml`;
image, font, Office, PDF, `.bin`, `.dll` and `.exe` files; lockfiles
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` and others);
`node_modules/`, some `vendor/` trees and Python virtualenv `lib/` trees. It
also drops matched values such as `true`, `null` or a bare `${VAR}`.

Every allowlist exception goes in `.gitleaks.toml`, one narrowly scoped entry
each, with a description naming the approving card. gitleaks also skips any
finding whose fingerprint is listed in a `.gitleaksignore` file. **Any edit to
`.gitleaks.toml` or `.gitleaksignore`, in any directory** (add, modify or
delete), is **gate_loosening**: it needs a Grok Bot countersign plus Blaine's
card. The path block reports them as `gate_loosening: { detected, reasons[],
requires }` (the same shape as `check-rls-deny-coverage`), with
`requires: ["grokbot_countersign", "blaine_card"]`. Reason kinds are
`gitleaks_config_changed`, `gitleaksignore_lines_added` (a fingerprint line the
base does not have; only the count is reported) and `gitleaksignore_changed`
(any other edit, including a delete). They are report-only and never change
`ok` or the exit code.

**Release ruling (exemptions).** Inline `gitleaks:allow` is forbidden and never
honoured. The only fingerprint exemptions are the lines of the **base branch's
root `.gitleaksignore`**; any line a PR adds there is flagged as
`gitleaksignore_lines_added` and takes effect only after it merges with the
countersign and card.

### What a PR cannot use to hide its own content

Each of these comes with the PR, and none of them changes what the scan sees:

- **The PR's `.gitleaks.toml` and path block.** Both are read from the
  **base** commit.
- **A head-side `.gitleaksignore`.** The job deletes the checked-out copy and
  passes `--gitleaks-ignore-path` pointing to the base commit's root
  `.gitleaksignore`, copied to `$RUNNER_TEMP` (an empty file when the base has
  none).
- **Inline `gitleaks:allow` comments.** gitleaks normally skips any finding
  whose line carries one. The scan passes `--ignore-gitleaks-allow` (defined
  in `cmd/root.go` and checked in `detect/detect.go` in v8.30.1), so such a
  line is still reported. Every exception lives in `.gitleaks.toml`.
- **`.gitattributes` and binary content.** gitleaks reads
  `git log -p -U0 <log-opts>` and skips every file that git prints as
  `Binary files ... differ`. On `pull_request` the work tree is the PR merge
  commit, so a PR could add `* -diff` (or `secret.txt binary`) and git would
  print every file as binary. A NUL byte in a file's first 8,000 bytes does
  the same with no attributes at all. The scan closes both:
  - `GIT_ATTR_SOURCE` is git's empty tree, so git reads no `.gitattributes`
    from the checkout or its index, at any depth. A PR's `-diff`, `binary`, or
    diff or merge driver has no effect. This needs git 2.40 or later; an
    older git ignores the variable, and `--text` below still covers both
    cases.
  - `--log-opts` starts with `--text --no-textconv`: git prints every file as
    text, including NUL-byte files, and no conversion filter rewrites it.
- **Merge commits.** Plain `git log -p` prints no diff for a merge, so content
  that appears only in a merge (a conflict resolution, or an edit made during
  a clean merge) was not scanned. The first live runs on PR #825 showed it:
  "4 commits scanned" for a range of 5 that includes a merge. `--log-opts`
  now adds `--diff-merges=remerge`: for each two-parent merge, git re-runs the
  merge itself and shows how the recorded result differs from it. A clean
  merge adds nothing; a resolution or an edit shows up as added lines.

### What the scan still does not see

- **Octopus merges** (three or more parents). git does not re-merge them; it
  prints `Skipping remerge-diff for octopus merges` into the log, and their
  merge-only content is not scanned. The path block still diffs trees, so it
  sees a sensitive path added there.
- **Text in other encodings.** `--text` shows UTF-16 or similar content as
  raw bytes, so a key stored as UTF-16 does not match the rules.
- **Archive contents.** gitleaks only opens archives with
  `--max-archive-depth` above 0, and the job leaves it at 0. With `--text` an
  archive's compressed bytes are scanned as text, which finds nothing inside.
- **Paths on the default global allowlist** (see above).
- **Commit messages.** gitleaks scans file content, not messages.
- **The workflow file itself.** On `pull_request` GitHub runs the PR's own copy
  of `.github/workflows/secret-scan.yml`, so a PR that edits it controls its
  own scan. Base copies protect the config and the path block, not this file.
  Making the job enforcing needs a ruleset, required workflow or CODEOWNERS
  rule on top.

One parser detail for the real-binary follow-up: for a file that had a merge
conflict, git adds a `remerge CONFLICT ...` line to the diff header. Reading
`go-gitdiff` v0.9.1 (the parser gitleaks uses), that line ends the git header,
and the hunk is then read through the plain `--- a/f` / `+++ b/f` lines. The
added lines are still scanned, but such a finding's file may show as `b/f`.
The real-binary check should confirm this.

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
  downloads it over HTTPS only (`curl --proto '=https' --tlsv1.2`, which
  also covers redirects) and checks it with `sha256sum -c` before extracting
  anything.
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
- gitleaks scans the PR's commits only (`base..head`, which in `git log`
  means commits on head that are not on base) with `--redact` and
  `--ignore-gitleaks-allow`. `--log-opts` is
  `--text --no-textconv --diff-merges=remerge base..head`, and the process
  runs with `GIT_ATTR_SOURCE` set to git's empty tree (see "What a PR cannot
  use to hide its own content"). The only artifact is the redacted JSON
  report, kept for 7 days.
- The path block diffs head against `merge-base(base, head)`, so base commits
  after the branch point are not counted.
- The job has `continue-on-error: true` and is not in the `ci` aggregate's
  `needs`. Branch protection on `main` lists it as a required check (read-only
  check, 2026-10-31; no approval recorded, see the top of this file).

Step behaviour. GitHub runs each `run:` block as `bash -e`. Every exit code
that matters is captured with `|| rc=$?`, so in each case below `-e` does not
stop a step before it writes its step summary.

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
  `Line` fields, even if redaction failed. Control characters in a file name
  are printed as `\uXXXX`, so the name cannot start a line of its own. For
  gitleaks' own log and report, `--redact` masks those values, and `-v` is not
  passed, so the log holds only the summary lines.
- PR-controlled text (path names, scanner output) is printed between
  `::stop-commands::` markers, so it cannot issue workflow commands.
- A step that fails (exit 1) turns the job red, but continue-on-error keeps the
  run green. gitleaks still runs when the path block step fails. Branch
  protection lists `secret-scan` as required (read-only check, 2026-10-31).
  Findings are reported and never fail the job. A scanner crash (a gitleaks
  download, checksum or start failure, or a git error) turns the job red, but
  whether a red job under continue-on-error blocks a merge depends on the
  reported check conclusion. No run has had a failed step yet (the last 100
  runs all concluded `success`), so this is not confirmed. Confirm it on a
  live run before relying on either answer.

### Later, separate approval (not covered by the 2026-10-16 approval)

After the report week, each of these needs its own Blaine approval:

- Drop `continue-on-error`, and pass `--enforce` to the path block.
- Add `secret-scan` to the required checks. A read-only check on 2026-10-31
  shows branch protection on `main` already lists it. A required check must
  also report on `merge_group` (see `scripts/merge-queue-workflows.test.mjs`
  and `docs/runbooks/merge-queue.md`), so the workflow now triggers on
  `merge_group` and runs the real scan there (never a no op) on
  `merge_group.base_sha..merge_group.head_sha`.
- Before either: run the real-binary checks listed under "Test coverage and
  follow-ups", and decide what to do about each item under "What the scan
  still does not see".
