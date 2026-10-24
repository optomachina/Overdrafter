Closes OVD-873 (parent OVD-870). https://linear.app/optomachina/issue/OVD-873

Model: opus per Release

**Scope correction (d631c950):** the workflow file has been removed from this PR. The report now runs inside `test:portable-node` (which CI already runs) through `scripts/sensitive-paths-report.node-test.mjs`. It's report mode and never fails on findings. You can also run it with `npm run sensitive-paths:report`. The removed workflow YAML is kept below as a card draft.

## OVD-873: one sensitive-path list (JSON) + shared matcher (report mode)

Parent: OVD-870.

### What changed
- **`docs/sensitive-paths.json`** is the single source of truth: `{version: 1, classes: {schema, migrations, auth, payments, provider_dispatch, secrets, infra_ci, deps}, globs: [{glob, class}]}`. It has 41 globs translated from the old AGENTS.md table. Two changes from the table: `rls` now only matches at a word boundary (`rls`, `*-rls`, `*_rls`), so `urls.ts` no longer matches, and the "schema" class gains `**/*.sql`, `supabase/config.toml` and `docs/migration-drafts/**`.
- **`scripts/lib/sensitive-paths.mjs`** is the one matcher, with no dependencies. Globs follow picomatch semantics with `{dot: true, nocase: true}`. Supported syntax is `*`, `**`, `?` and `{a,b}`; anything else is rejected. It exports `createMatcher`, `classifyPaths`, `triageRoute`, `checkAgentsParity` and `findGateLoosening`, plus a CLI:
  - `classify [--base-ref <ref>] [--json] <paths>` is what triage and shell gates call.
  - `report --changed-files-from … --base-ref HEAD^1 [--json-out]` is the CI report.
- **AGENTS.md**: the table is replaced by a human-readable list between `<!-- sensitive-paths:begin/end -->` markers, and the text now names the JSON as the source of truth.
- **`scripts/validate-agent-contract.mjs`** checks parity in both directions. A glob or class that is in the JSON but not in AGENTS.md fails, and so does the reverse. A missing JSON file or missing markers also fail.
- **Consumers.** None of them copies any globs.
  - `scripts/jev-pr-screen.mjs` raises the declared deterministic tier to `risky` when any file matches the list. It never lowers a tier, and it logs `sensitiveClasses`.
  - The triage skill (`linear-triage-router`) calls the CLI.
  - `docs/agent-log/README.md` is updated to match.
- **Gate loosening.** The report reads the JSON from the **base** checkout. The following are classified `gate_loosening`:
  - removing, narrowing or reclassifying a glob
  - deleting or breaking the JSON
  - editing the matcher or its workflow

  Adding a glob is free.

### Report mode
- No workflow file. `scripts/sensitive-paths-report.node-test.mjs` is part of `test:portable-node`. It runs the report on HEAD^1..HEAD using the base copy of the matcher when there is one, prints the result, and never fails on findings. It skips when HEAD^1 doesn't exist. It is not a required check.
- Making it required, enforcing gate_loosening and pinning picomatch are proposed on the card and not implemented.

### Tests
- `scripts/lib/sensitive-paths.test.mjs` (vitest, 18 tests):
  - The shared fixture `scripts/fixtures/sensitive-paths/paths.json` (47 paths, every class plus non-matches) gets the same classification from picomatch, the matcher, `classifyPaths`, the CLI (in-process and as a subprocess), `triageRoute` and the Jev screen's `decisionRecord`. Migration paths use a `{migrations}` placeholder that is mapped at test time.
  - The matcher agrees with picomatch `{dot, nocase}` for every glob × every path.
  - Edge cases: dotfiles, nested `**/.env`, `./` and backslash paths, case-insensitive matching. Unsupported glob syntax is rejected.
  - Parity: drift in either direction fails, as do a glob under a different class, missing markers and a missing JSON.
  - Gate loosening: narrowing (`supabase/migrations/**` → `*.sql`) is detected, adding a glob is not, removal, reclassification, deletion and invalid JSON are detected, a matcher edit is flagged and adding the matcher is not. An end-to-end run in a temp git repo shows base-JSON classification plus loosening.
- `scripts/jev-pr-screen.test.mjs`: added cases where a sensitive path raises the tier to risky (never lowers it) and the default `screen()` reads the shared JSON.
- `scripts/validate-agent-contract.node-test.mjs`: now copies the JSON into its temp repo.
- Ran: `bash scripts/preflight.sh lint` PASS, `bash scripts/preflight.sh typecheck` PASS, `npx vitest run scripts/lib/sensitive-paths.test.mjs scripts/jev-pr-screen.test.mjs` 27/27 pass, `node --test scripts/validate-agent-contract.node-test.mjs` 2/2 pass.

### Size
About 460 lines of matcher+CLI (much of it doc comments) plus 270 lines of tests is over the ~200-line guideline. The JSON, AGENTS list, matcher, parity check and loosening detection are one contract and only make sense together; fixtures and tests make up most of the rest.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Proposed card items (not in this PR)
## OVD-873 — items for Blaine's card (not implemented in this PR)

These are proposals only. Nothing below is done in this PR, and each needs Blaine's explicit OK, relayed through Grok Bot.

1. **Make `sensitive-paths-report` a required check / add it to the `ci` aggregate.**
   Proposed: once OVD-844 consumes the classification, remove `continue-on-error: true` from the "Report sensitive paths" step in `.github/workflows/sensitive-paths-report.yml`, add a failing exit for parity errors and invalid JSON, and add `sensitive-paths-report` to branch protection's required checks (or to the `ci` aggregate's `needs`). Until then it stays report only.

2. **Enforce gate_loosening.** Proposed: when the report's `gate_loosening.detected` is true (a glob was removed, narrowed or reclassified, the JSON was deleted or broken, or the matcher or workflow was edited), the merge gate requires a Grok Bot countersign on top of Blaine's card. Today this only shows up as a GATE LOOSENING line in the job summary and in the JSON artifact.

3. **Pin picomatch as a direct devDependency (optional).** The tests use `picomatch` 2.3.1 as the semantic reference, but it is only present transitively in `node_modules`. The matcher stays dependency-free either way, because gates run the base copy without `npm install`. Proposed: add `"picomatch": "^2.3.1"` to `devDependencies` so the reference cannot vanish when the lockfile changes. This is a new dependency, so it needs the card.

4. **Guardrail activation.** `tools/guardrails/apply.mjs` is not activated or changed. If the guardrails should consume `scripts/lib/sensitive-paths.mjs`, that wiring needs its own card.

Local checks: preflight lint and typecheck pass; vitest passes apart from the 3 known OVD-417 docker-only failures.


5. **Add the dedicated `sensitive-paths-report` workflow (new workflow file, card).** It was removed from this PR. The proposed YAML:

<details><summary>.github/workflows/sensitive-paths-report.yml (card draft)</summary>

```yaml
name: Sensitive paths report

# OVD-873. Classifies the PR's changed files against docs/sensitive-paths.json
# (the single sensitive-path list) through scripts/lib/sensitive-paths.mjs,
# checks the AGENTS.md list mirrors the JSON, and detects gate loosening.
#
# Report mode: the step has continue-on-error and the job is not part of the
# `ci` aggregate or branch protection, so it never blocks a merge. It stays
# report only until OVD-844 consumes the classification; making it required is
# a separate branch protection change on Blaine's card.
#
# Like security-definer-lint.yml, the matcher runs from the base copy (HEAD^1)
# and classifies with the base commit's JSON, so a PR cannot edit either to
# hide itself. When the base has no copy yet (the PR that introduces the
# matcher), the head copy runs and the head JSON is used.
#
# Gate loosening (Release Plan §6): removing, narrowing or reclassifying a glob,
# deleting or breaking the JSON, and any edit to the matcher or this workflow
# are classified gate_loosening, which needs a Grok Bot countersign on top of
# Blaine's card. Adding a glob is free. It appears in the gate_loosening field
# of the JSON artifact and as a GATE LOOSENING line in the job summary.

on:
  pull_request:
    types:
      - opened
      - reopened
      - synchronize
  merge_group:
    types:
      - checks_requested

concurrency:
  group: sensitive-paths-report-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  sensitive-paths-report:
    name: sensitive-paths-report
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: Merge queue no op
        if: github.event_name == 'merge_group'
        run: echo "merge_group run, sensitive-paths-report ran on the pull_request run."

      # pull_request checks out the merge commit of the PR head into the
      # current base tip, so HEAD^1 is the base as merged.
      - name: Checkout
        if: github.event_name == 'pull_request'
        uses: actions/checkout@v5
        with:
          fetch-depth: 2

      - name: Setup Node.js
        if: github.event_name == 'pull_request'
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Prepare matcher from base
        if: github.event_name == 'pull_request'
        run: |
          set -euo pipefail
          gate="$RUNNER_TEMP/gate"
          mkdir -p "$gate/scripts/lib"
          file=scripts/lib/sensitive-paths.mjs
          if git cat-file -e "HEAD^1:$file" 2>/dev/null; then
            git show "HEAD^1:$file" > "$gate/$file"
            echo "Matcher taken from: base"
          else
            cp "$file" "$gate/$file"
            echo "Matcher taken from: head"
          fi

      - name: Report sensitive paths (report mode)
        if: github.event_name == 'pull_request'
        continue-on-error: true
        run: |
          set -euo pipefail
          # --no-renames keeps a rename source as a deletion plus an addition.
          git diff --name-status --no-renames HEAD^1 HEAD > "$RUNNER_TEMP/changed-files.txt"
          node "$RUNNER_TEMP/gate/scripts/lib/sensitive-paths.mjs" report \
            --changed-files-from "$RUNNER_TEMP/changed-files.txt" \
            --base-ref HEAD^1 \
            --json-out "$RUNNER_TEMP/sensitive-paths-report.json" \
            | tee "$RUNNER_TEMP/sensitive-paths-report.txt"
          {
            echo '## Sensitive paths (report mode)'
            if grep -q '^GATE LOOSENING:' "$RUNNER_TEMP/sensitive-paths-report.txt"; then
              echo
              echo "> **GATE LOOSENING: needs Grok Bot countersign + Blaine's card** (classification \`gate_loosening\`, report only)"
              echo
            fi
            echo '```'
            cat "$RUNNER_TEMP/sensitive-paths-report.txt"
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Upload report
        if: github.event_name == 'pull_request' && always()
        uses: actions/upload-artifact@v4
        with:
          name: sensitive-paths-report
          path: ${{ runner.temp }}/sensitive-paths-report.json
          if-no-files-found: ignore
          retention-days: 14
```

</details>
