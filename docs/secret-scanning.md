# Secret scanning (OVD-872)

Two layers keep secrets out of the repo:

1. **Path block** (`scripts/check-secret-paths.mjs`, in repo, no dependencies).
   It rejects files whose path says "secret", whatever their contents.
2. **Content scan** (gitleaks, using `.gitleaks.toml`). It finds secret-shaped
   values in any file. gitleaks is a new dependency, so the binary and the
   workflow that runs it are Blaine's card items. The full draft is in
   [CARD DRAFT](#card-draft-githubworkflowssecret-scanyml) below.

Both run in **report mode** for one week: findings are printed and nothing
fails. Making either a required check goes in the Blaine queue.

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

`SENSITIVE_PATH_RULES` is the one list. It moves to OVD-873's
`docs/sensitive-paths.json` once that lands (PR #818).

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
(vitest).

### Test coverage and card follow-ups

The tests in this PR cover the **path block only**. Their fixtures hold
synthetic AWS, Stripe, JWT and PEM values, but only to prove the checker never
prints file contents; nothing in this PR runs gitleaks. These gitleaks content
tests need the gitleaks binary, which is the card dependency, so they are
**card follow-ups**:

- gitleaks catches a synthetic AWS access key, Stripe secret key, JWT and PEM
  private key added in a PR range.
- The redacted JSON report and the job log contain none of those values.
- A head-side `.gitleaksignore` or inline `gitleaks:allow` (see below) does or
  does not suppress a finding, matching what the card decides.

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

The draft workflow closes the two file-based bypasses:

- It reads `.gitleaks.toml` and the path-block script from the **base** commit.
- It never uses the head copy of `.gitleaksignore`: it deletes the checked-out
  copy and passes `--gitleaks-ignore-path` pointing to an empty file in
  `$RUNNER_TEMP`.

**Known gap, for the card to decide:** gitleaks skips any line carrying an
inline `gitleaks:allow` comment, and that comment arrives with the PR's own
content. There is no gitleaks flag to turn it off. So a PR **can** still hide a
secret from the content scan this way, and the path block does not look at
file contents. Options for the card: grep the PR's added lines for
`gitleaks:allow` and report each one as gate_loosening, or accept the gap and
rely on review. Until the card decides, do not read the scan as proof that a PR
cannot loosen it.

## Optional pre-commit hook (docs only)

This is not installed automatically, and nothing in the repo turns it on. To
use it locally, install gitleaks yourself (verify the checksum as in the card
draft) and add `.git/hooks/pre-commit`:

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

## CARD DRAFT: `.github/workflows/secret-scan.yml`

**Not in this PR.** This needs Blaine's card for two reasons: it adds the
gitleaks dependency, and it adds a workflow. Paste this into the card or the
PR body as is.

- gitleaks **v8.30.1** (latest release on 2026-10-16), `linux_x64` tarball.
- SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`,
  from the official release checksums file
  `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt`.
  It was checked against a `sha256sum` of the downloaded tarball.
- Actions are pinned by full commit SHA: `actions/checkout` v5.1.0 and
  `actions/upload-artifact` v4.6.2.
- Trigger is `pull_request` only (never `pull_request_target`), with
  `permissions: contents: read` and no secrets.
- gitleaks scans the PR range only (`--log-opts base..head`, which in
  `git log` means commits on head that are not on base) with `--redact`.
  The only artifact is the redacted JSON report.
- The path block diffs head against `merge-base(base, head)`, so base commits
  after the branch point are not counted.
- The config is the base copy, and the head's `.gitleaksignore` is never used
  (the checked-out copy is deleted and `--gitleaks-ignore-path` points to an
  empty file). Inline `gitleaks:allow` is still honoured; see the known gap
  above.
- `continue-on-error: true` for the one-week report period.

```yaml
# OVD-872: secret scanning (report mode). Edits to this file, .gitleaks.toml
# or .gitleaksignore are gate_loosening: Grok Bot countersign plus Blaine's card.
name: secret-scan

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: secret-scan-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  secret-scan:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # Report mode for one week; making this required is a Blaine queue item.
    continue-on-error: true
    env:
      GITLEAKS_VERSION: "8.30.1"
      # From gitleaks_8.30.1_checksums.txt on the official GitHub release.
      GITLEAKS_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
      BASE_SHA: ${{ github.event.pull_request.base.sha }}
      HEAD_SHA: ${{ github.event.pull_request.head.sha }}
    steps:
      - name: Checkout (full history for the base..head range)
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Install gitleaks (pinned version and SHA-256)
        run: |
          set -euo pipefail
          tarball="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
          curl -sSfL -o "$RUNNER_TEMP/$tarball" \
            "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${tarball}"
          echo "${GITLEAKS_SHA256}  $RUNNER_TEMP/$tarball" | sha256sum -c -
          mkdir -p "$RUNNER_TEMP/gitleaks"
          tar -xzf "$RUNNER_TEMP/$tarball" -C "$RUNNER_TEMP/gitleaks" gitleaks
          "$RUNNER_TEMP/gitleaks/gitleaks" version

      - name: Load base copies of the config and path block
        # The PR's own .gitleaks.toml, .gitleaksignore and path block are not
        # used. Inline gitleaks:allow comments are a known gap (see docs).
        run: |
          set -euo pipefail
          git show "${BASE_SHA}:.gitleaks.toml" > "$RUNNER_TEMP/gitleaks.toml"
          git show "${BASE_SHA}:scripts/check-secret-paths.mjs" > "$RUNNER_TEMP/check-secret-paths.mjs"
          # Never honour a head-side fingerprint ignore list: use an empty one,
          # and drop the checked-out root copy in case gitleaks also reads it
          # from the source directory.
          : > "$RUNNER_TEMP/gitleaksignore-empty"
          rm -f .gitleaksignore

      - name: Secret path block (report mode)
        run: node "$RUNNER_TEMP/check-secret-paths.mjs" --base-ref "$BASE_SHA" --head-ref "$HEAD_SHA"

      - name: gitleaks (PR diff only, redacted)
        run: |
          "$RUNNER_TEMP/gitleaks/gitleaks" git \
            --no-banner \
            --redact \
            --config "$RUNNER_TEMP/gitleaks.toml" \
            --gitleaks-ignore-path "$RUNNER_TEMP/gitleaksignore-empty" \
            --log-opts="${BASE_SHA}..${HEAD_SHA}" \
            --report-format json \
            --report-path "$RUNNER_TEMP/gitleaks-report.json" \
            --exit-code 1

      - name: Upload redacted gitleaks report
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: gitleaks-report-redacted
          path: ${{ runner.temp }}/gitleaks-report.json
          if-no-files-found: ignore
          retention-days: 7
```

Notes for the card:

- `--redact` masks `Secret`, `Match` and `Line` in the report and in the log,
  and `-v` is not passed, so the log shows only the summary. Only the redacted
  report is uploaded.
- The workflow reads base copies of the config and script, so the first PR that
  adds this workflow must merge after this PR. Until then the `git show` step
  has nothing to read.
- Verify on the pinned version that `--gitleaks-ignore-path` plus deleting the
  root `.gitleaksignore` means no head-side ignore file is loaded, including
  any nested copy (the path block reports nested copies as gate_loosening
  either way).
- Decide the inline `gitleaks:allow` gap, and add the gitleaks content tests
  listed under "Test coverage and card follow-ups".
- After the report week, Blaine's queue: drop `continue-on-error`, pass
  `--enforce` to the path block, and add `secret-scan` to the required checks.
