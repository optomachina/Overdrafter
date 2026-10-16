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

It also reports every **added line**, in any file, that contains an inline
`gitleaks:allow` comment, as a finding with rule `inline_allow` (see
[Exemption policy](#exemption-policy)). Only `file:line` is printed, never the
line. A marker that was already on the base is not reported.

`SENSITIVE_PATH_RULES` is the one list. It moves to OVD-873's
`docs/sensitive-paths.json` once that lands (PR #818).

Output has paths, line numbers, rule ids and reasons only. The checker reads
file contents only to evaluate `.envrc` and to look for the inline allow
marker in added lines, and it never prints them. Git is called as
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

`scripts/check-secret-paths.test.mjs` covers the path block, the
`.gitleaksignore` gate_loosening report (including a line added to an existing
file), and the `inline_allow` finding. Fixtures hold synthetic AWS, Stripe, JWT
and PEM values, built at runtime, to prove the checker never prints file
contents.

One test runs the **real** gitleaks: a synthetic AWS key on a line carrying an
inline `gitleaks:allow` is still reported with `--ignore-gitleaks-allow` (exit
1, redacted output), and is hidden without it (the control). gitleaks is not a
dependency, so the test runs only when a binary is already available
(`GITLEAKS_BIN=/path/to/gitleaks`, or `gitleaks` on `PATH`) and is skipped with
that reason otherwise.

Card follow-ups, once the workflow lands:

- gitleaks catches a synthetic AWS access key, Stripe secret key, JWT and PEM
  private key added in a PR range.
- The redacted JSON report and the job log contain none of those values.

## gitleaks config and gate_loosening

`.gitleaks.toml` extends the gitleaks default rules (`[extend] useDefault = true`)
and has an empty allowlist. gitleaks rejects an `[[allowlists]]` table with no
checks in it, so the empty allowlist is "no entries". It stays empty:
exemptions go in `.gitleaksignore` (see [Exemption policy](#exemption-policy)).

**Any edit to
`.gitleaks.toml` or `.gitleaksignore`, in any directory** (add, modify or
delete), is **gate_loosening**: it needs a Grok Bot countersign plus Blaine's
card. The path block reports these as `gate_loosening` entries with
`requires: ["grokbot_countersign", "blaine_card"]`. They are report-only and
never change `ok` or the exit code.

### Exemption policy

**The only exemption is a fingerprint in `.gitleaksignore`, read from the base
checkout.** A PR cannot exempt its own content:

- **Inline `gitleaks:allow` is forbidden.** Every gitleaks run passes
  `--ignore-gitleaks-allow`, so the comment has no effect and the finding is
  still reported. The path block also reports each added marker as an
  `inline_allow` finding (`file:line` only).
- **`.gitleaksignore` is read from the base commit only.** The draft workflow
  writes `git show <base>:.gitleaksignore` (or an empty file when the base has
  none) to `$RUNNER_TEMP` and passes it as `--gitleaks-ignore-path`. It also
  deletes the checked-out root copy, because gitleaks always loads
  `<source>/.gitleaksignore` as well. Adding, editing or deleting a
  `.gitleaksignore` line is gate_loosening, so a new fingerprint takes effect
  only after a countersigned PR adding it has merged.
- **`.gitleaks.toml` is read from the base commit only**, as is the path-block
  script. Its allowlist stays empty and is not an exemption route; any edit
  is gate_loosening.

Source for the flag and the ignore-file loading (gitleaks **v8.30.1**, checked
against the release source and `gitleaks git --help` from the pinned binary):

- `cmd/root.go` line 85 defines the persistent flag:
  `rootCmd.PersistentFlags().BoolP("ignore-gitleaks-allow", "", false, "ignore gitleaks:allow comments")`.
  <https://github.com/gitleaks/gitleaks/blob/v8.30.1/cmd/root.go#L85>
- `detect/detect.go` line 510 skips a finding only when
  `!d.IgnoreGitleaksAllow && strings.Contains(finding.Line, gitleaksAllowSignature)`,
  where `gitleaksAllowSignature = "gitleaks:allow"` (line 28).
  <https://github.com/gitleaks/gitleaks/blob/v8.30.1/detect/detect.go#L510>
- There is no config-file equivalent: `config.ViperConfig` (`config/config.go`)
  has no such key, so `.gitleaks.toml` only carries a comment pointing here.
- `cmd/root.go` lines 300 to 321 load `.gitleaksignore` from
  `--gitleaks-ignore-path` (a file, or `<dir>/.gitleaksignore`) and from
  `<source>/.gitleaksignore`, and from nowhere else, so nested copies are never
  read.

## Optional pre-commit hook (docs only)

This is not installed automatically, and nothing in the repo turns it on. To
use it locally, install gitleaks yourself (verify the checksum as in the card
draft) and add `.git/hooks/pre-commit`:

```sh
#!/bin/sh
# Scan staged changes only; --redact keeps matched values out of the terminal.
exec gitleaks git --pre-commit --staged --redact --no-banner --ignore-gitleaks-allow --config .gitleaks.toml
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
- `--ignore-gitleaks-allow` is passed, so inline `gitleaks:allow` comments
  never suppress a finding (see [Exemption policy](#exemption-policy)).
- The config is the base copy. The only ignore list is the base copy of
  `.gitleaksignore` (or an empty file when the base has none), passed as
  `--gitleaks-ignore-path`; the checked-out copy is deleted.
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

      - name: Load base copies of the config, ignore list and path block
        # The PR's own .gitleaks.toml, .gitleaksignore and path block are not
        # used. The base .gitleaksignore is the only exemption.
        run: |
          set -euo pipefail
          git show "${BASE_SHA}:.gitleaks.toml" > "$RUNNER_TEMP/gitleaks.toml"
          git show "${BASE_SHA}:scripts/check-secret-paths.mjs" > "$RUNNER_TEMP/check-secret-paths.mjs"
          if git cat-file -e "${BASE_SHA}:.gitleaksignore" 2>/dev/null; then
            git show "${BASE_SHA}:.gitleaksignore" > "$RUNNER_TEMP/gitleaksignore-base"
          else
            : > "$RUNNER_TEMP/gitleaksignore-base"
          fi
          # gitleaks always loads <source>/.gitleaksignore too (cmd/root.go),
          # so drop the head copy from the checkout.
          rm -f .gitleaksignore

      - name: Secret path block (report mode)
        run: node "$RUNNER_TEMP/check-secret-paths.mjs" --base-ref "$BASE_SHA" --head-ref "$HEAD_SHA"

      - name: gitleaks (PR diff only, redacted)
        run: |
          "$RUNNER_TEMP/gitleaks/gitleaks" git \
            --no-banner \
            --redact \
            --config "$RUNNER_TEMP/gitleaks.toml" \
            --ignore-gitleaks-allow \
            --gitleaks-ignore-path "$RUNNER_TEMP/gitleaksignore-base" \
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
- Add the gitleaks content tests listed under "Test coverage and card
  follow-ups".
- After the report week, Blaine's queue: drop `continue-on-error`, pass
  `--enforce` to the path block, and add `secret-scan` to the required checks.
