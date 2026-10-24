Closes OVD-872 (parent OVD-870). https://linear.app/optomachina/issue/OVD-872

Model: opus per Release

**The `secret-scan` job now ships, in report mode.** Blaine approved it on 2026-10-16: "secret scanning tool is approved". That covers the pinned gitleaks v8.30.1 binary and the new report-mode `.github/workflows/secret-scan.yml` with `continue-on-error`. The job is **not** a required check, and the `ci` aggregate does not need it. **Making it required or enforcing is a later, separate approval** that this one does not cover.

## What changed
- **`.github/workflows/secret-scan.yml` (new, report mode):**
  - Trigger and access: `pull_request` only. Top-level `permissions: contents: read`, and no secrets are referenced. Actions are pinned by commit SHA. Checkout uses `persist-credentials: false`.
  - Inputs: every `${{ }}` value reaches the shell through `env:`. `.gitleaks.toml` and the path block are the **base** copies, never the PR's. A head-side `.gitleaksignore` is never used: the root copy is deleted and gitleaks gets `--gitleaks-ignore-path` pointing at an empty file.
  - Scan: gitleaks runs on the PR's commits only (`base..head`) with `--redact`.
  - Download: `curl --proto '=https' --tlsv1.2 -sSfL`, then `sha256sum -c` before extracting.
- **Round 2: a PR can no longer hide its own content from the scan.** Each fix only tightens the scan, so the report-mode approval covers it.
  - **`--ignore-gitleaks-allow`.** gitleaks v8.30.1 defines it (`cmd/root.go:85`, checked at `detect/detect.go:510`). An inline `gitleaks:allow` comment no longer suppresses a finding. The earlier docs claim that no such flag exists was wrong.
  - **`.gitattributes` and NUL bytes.** On `pull_request` the work tree is the PR merge commit. So a PR adding `* -diff` or `x binary`, or a file with a NUL byte, made git print `Binary files ... differ`, and gitleaks skipped that file unread. Two fixes:
    - gitleaks now runs with `GIT_ATTR_SOURCE` set to git's empty tree, so no in-tree attributes are read at any depth.
    - `--log-opts` now starts with `--text --no-textconv`. gitleaks splits log-opts on spaces and appends them to `git log -p -U0` (`sources/git.go:75-91`).
  - **Merge-only content.** Plain `git log -p` prints nothing for a merge. `--diff-merges=remerge` now shows what each two-parent merge changed against git's own re-merge: conflict resolutions and edits made inside a merge. A clean merge adds nothing.
  - **Path block newline bypass.** `globToRegExp` had no dotAll, so `a<LF>.pem` matched nothing. Two fixes:
    - Globs now use the `s` flag.
    - Any checked path with a control character (LF, CR, tab, other C0/C1) or U+2028/U+2029 is blocked as `control_char`. The human report escapes it as `\uXXXX`, so a name cannot fake a `secret-paths: OK` line.
    - Type changes (`T`) are now checked as well.
  - **Finding list:** control characters in a gitleaks finding's file name are escaped too.
  - **SonarCloud `githubactions:S6506` / code-scanning #262:** fixed by the curl flags above. `String.raw` (S7780) is used for the glob escape. `evaluateChanges` is split into two helpers (S3776).
- **`bash -e` safety:** GitHub runs `run:` blocks as `bash -e`. Every step captures its exit code (`|| rc=$?`) and writes a step summary before it exits. The one exception is the install step, which writes a summary only on failure.
  - Findings, blocked paths and gate_loosening exit 0. Findings also raise a `::warning` annotation.
  - A scanner that cannot run exits 1: gitleaks error, panic or no report, a failed download or checksum, a crashed path block, or a bad base/head SHA. That turns the job red, but it never blocks a merge.
  - gitleaks uses `--exit-code 3`, so findings can be told apart from its own errors. A result counts only when the exit code and the report agree.
  - PR-controlled text is printed inside `::stop-commands::` markers. The finding list shows rule, file, line and commit only.
- **Bootstrap:** this PR's own run has no base config or path block. It uses gitleaks default rules and reports the path block as `Skipped`, still without using the PR's copies. So the round-2 path-block and scan changes take effect on later PRs.
- **`scripts/check-secret-paths.mjs`:** the main guard compares real paths. A copy run through a symlinked dir (macOS `/var/folders`) used to print nothing and exit 0.
- **Tests:**
  - `scripts/secret-scan-workflow.test.mjs` (32 tests) pins the approved shape and the exact gitleaks arguments, including `GIT_ATTR_SOURCE`. It runs every `run:` block under `bash -e` with a stub gitleaks and curl: clean, findings, panic, fatal, silent and mismatch, plus checksum mismatch and failed download. Each case checks the summary and the exit code.
  - New in that suite: a stub that runs the same `git log` gitleaks runs, on a repo that hides five synthetic keys: a root `* -diff`, a nested `secret.txt binary`, a NUL-byte file, a conflict resolution and an edit inside a clean merge. Plain `git log -p` shows none of the five, and the scan step reports all five.
  - `scripts/check-secret-paths.test.mjs` (66 tests) adds dotAll matching, control-character detection and escaping, LF/CR/tab names through `git diff -z`, a deleted control-char name, and a `T` type change.
- **Merges of `origin/main`:** the latest picks up #809 (no overlap). The `test:portable-node` lane and its contract test keep every suite from both sides.
- `docs/secret-scanning.md` now describes:
  - what a PR cannot use to hide content, and what the scan still does not see;
  - the default global allowlist that `useDefault` brings in;
  - what still needs a separate approval.

## Not done, on purpose
- **`.gitattributes` edits are not reported as gate_loosening.** The scan no longer reads any in-tree attributes, so such an edit cannot loosen it. Reporting it would make every ordinary `.gitattributes` change need a countersign.
- **Workflow-file edits are not reported by the checker either.** The docs now state the limit: on `pull_request`, a PR runs its own copy of this workflow, so enforcement will need a ruleset, a required workflow or CODEOWNERS.

## Pinned inputs (re-verified 2026-10-16)
- gitleaks **v8.30.1** `linux_x64`, SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`. It matches the `linux_x64` line of the official `gitleaks_8.30.1_checksums.txt` and the release asset digest GitHub reports. The job runs `sha256sum -c` before it extracts anything.
- `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` (v5.1.0) and `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (v4.6.2). Each tag ref resolves to that commit (lightweight tags).
- The round-2 flags were checked against the v8.30.1 source (tag commit `83d9cd68`), which I read through the GitHub API. The binary was not downloaded or run.

## Unchanged from earlier rounds
- The path block flags `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `.env*` and `*storage-state*.json`. `.env.example` is allowed. `.envrc` is allowed only when it does nothing but `source`/`dotenv` files.
- Any edit to `.gitleaks.toml` or any `.gitleaksignore` is reported as `gate_loosening` (Grok Bot countersign plus Blaine's card). It runs as `npm run secrets:paths` and inside `test:portable-node`.
- `.gitleaks.toml` extends the default rules and adds no allowlist entries of its own. `useDefault` still brings gitleaks' global path allowlist, which the docs now list.
- No new npm dependencies, and nothing under `supabase/migrations/`.

## Later, separate approval (not covered)
- Drop `continue-on-error`, pass `--enforce` to the path block, and add `secret-scan` to the required checks. A required check also needs a `merge_group` no-op trigger; this workflow deliberately has none.
- Before that:
  - Run the real-binary checks:
    - AWS, Stripe, JWT and PEM keys are caught, and the redacted report holds no values.
    - A `gitleaks:allow` line, a `-diff` attribute, a NUL-byte file and merge-only content are each reported.
    - The base `.gitleaks.toml` loads.
    - From reading go-gitdiff v0.9.1, a conflicted file's remerge hunk is still scanned, but its file may show as `b/<path>`. The real-binary run should confirm this.
  - Decide the gaps that remain (documented): octopus merges (git skips remerge for them), keys in UTF-16 or other encodings, archive contents, paths on the default global allowlist, and the PR's own copy of the workflow file.

## Verification
- `bash scripts/preflight.sh lint`: PASS. `bash scripts/preflight.sh typecheck`: PASS (on the merged head).
- `npx vitest run scripts/check-secret-paths.test.mjs scripts/secret-scan-workflow.test.mjs scripts/test-lane-contract.test.mjs`: 117/117 on the merged head. With `merge-queue-workflows` and `lib/sensitive-paths` added: 160/160 before the merge.
- `node --test scripts/check-secret-paths.node-test.mjs`: 1/1. `npm run test:portable-node`: 1704 pass, 0 fail, 2 skipped.
- Mutation checks: each of these mutations fails at least one test:
  - in the scan step, dropping `--text`, `--diff-merges=remerge`, `--ignore-gitleaks-allow`, `GIT_ATTR_SOURCE`, the curl `--proto`/`--tlsv1.2` flags or the finding-list escaping;
  - in the path block, dropping dotAll, the control-character check, the path escaping or `T`.
- Earlier mutation checks still hold: removing an `rc` capture, breaking the install `&&` chain, or restoring the old main guard.
- Live runs on `09d0122b` and `e44b848b`: `secret-scan` passed with the default-rules fallback, and the path block was skipped as expected for this bootstrap PR. Each range included a merge, and gitleaks scanned one commit fewer than the range held, which is the merge gap fixed above. The run on the new head is pending.
- The workflow YAML parses cleanly with `yaml` (strict, unique keys), and all four `run:` blocks pass `bash -n`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
