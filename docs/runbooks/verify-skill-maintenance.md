# Weekly verify-skill maintenance (OVD-858)

Keeps the `verify-overdrafter` feature map (`.agents/skills/verify-overdrafter/`, OVD-842) in line with the app. Each run ends with one outcome, `clean`, `changed` or `blocked`, and opens **at most one PR**.

There are two parts. Only the first is automated:

1. **Drift report (CI, read-only).** `.github/workflows/verify-skill-drift.yml` runs every Monday and on manual dispatch. It runs `scripts/verify-skill-drift.mjs` and uploads the `verify-skill-drift` artifact (`verify-skill-drift.json` and `.md`). It has `contents: read` only, no secrets, and never pushes or opens PRs. A drift result fails the run on purpose.
2. **Maintenance pass (agent).** An agent runs pstack `maintain-verification-skill`, guided by the report, and ships at most one PR.

## The drift report

```bash
node scripts/verify-skill-drift.mjs --json /tmp/drift.json --markdown /tmp/drift.md
```

Exit `0` means no drift, or the skill is absent: the default skill directory or its `SKILL.md` is missing (it prints `Status: **absent**` and does nothing). A skill that exists without `features/` is drift (`missing-index`), not absent. Exit `1` means drift. Exit `2` means a usage or config error. Argument errors (an unknown flag, or a flag with no value or with another flag as its value, such as `--root --json`) write no report files. Config errors still write them with `Status: **error**` and the message: a malformed `drift-ignore.json`, a `--root` that does not exist, or a `--skill-dir` with no `SKILL.md`. An explicit path is never reported as absent. The report compares the map to `src/App.tsx` routes, `e2e/**/*.spec.ts` and the repo paths the map cites in inline code:

| Kind | Meaning | Usual fix |
| --- | --- | --- |
| `missing-index`, `dead-index-link`, `unindexed-feature` | `features/README.md` and the feature files disagree | Fix the index |
| `stale-route`, `stale-spec`, `missing-path` | The map cites something the app no longer has (paths that resolve outside the repo count as missing) | Doc drift: update the map, or report a product regression |
| `unmapped-route`, `unmapped-spec` | The app has a surface or spec the map never names | Add it to a feature file, or ignore it with a reason |

The report is deterministic and covers structure only. It cannot see behavior drift, so the skill's live pass is still required.

Intentional exclusions go in `.agents/skills/verify-overdrafter/drift-ignore.json`. Every entry needs a reason, and a trailing `*` matches a prefix. Route patterns match in normalized form, so `/parts/<id>` and `/parts/:jobId` are the same entry for both `stale-route` and `unmapped-route`:

```json
{
  "routes": [{ "pattern": "/debug/*", "reason": "dev-only galleries, not a user feature" }],
  "specs": [],
  "paths": [],
  "runtimePaths": [{ "pattern": "playwright/.auth/", "reason": "storage state written by e2e/auth.mjs" }]
}
```

A cited path that does not exist counts as present only when it is listed in `runtimePaths` and git ignores it. Other gitignored paths (`node_modules/...`, `dist/...`) are still `missing-path`. Absolute filesystem paths in inline code (`/tmp/...`, `/usr/...`) are not treated as app routes. Fenced code blocks (backtick or tilde, at any indent, including inside list items) are not scanned. An unclosed fence is scanned as plain text, so a typo cannot hide the rest of a file.

## Run procedure

1. **Get the report.** Use `gh run download --name verify-skill-drift` on the latest run, or regenerate it locally at current `origin/main`. If the status is `absent` (no skill directory or no `SKILL.md`), stop: the outcome is `clean` and there is nothing to maintain. If the skill exists but `features/` is missing, the report shows `missing-index` drift; treat it as drift and continue. If the status is `error`, fix the config error first.
2. **Run `maintain-verification-skill`** on `.agents/skills/verify-overdrafter`. Use the report to seed its index-hygiene step (step 1) and its churn sweep (step 3). Every finding gets a disposition: fix the map, ignore it with a reason, or record a product gap. The source wave and the live pass still cover every feature. Drive the app through `scripts/verify.sh` (doctor first; use local mode only where Docker is available). Report anything unreachable with its prerequisite.
3. **Stay in edit scope.** Edit only the skill directory, including `drift-ignore.json`. Never edit product code. File product gaps as Linear issues; they never go in this PR.
4. **Re-run the detector** after the edits. Any drift kind that is still reported must be explained in the PR body.
5. **Choose the PR. Only a `changed` outcome ships.**

   ```bash
   (
     D="$(mktemp -d)" || { echo "mktemp failed; not deciding" >&2; exit 1; }
     trap 'rm -rf "$D"' EXIT
     FIELDS=number,headRefName,labels,isCrossRepository,state
     gh pr list --state open --head chore/verify-skill-maintenance --limit 1000 --json "$FIELDS" > "$D/head.json" ||
       { echo "gh pr list --head failed; not deciding" >&2; exit 1; }
     gh pr list --state open --label verify-skill-maintenance --limit 1000 --json "$FIELDS" > "$D/label.json" ||
       { echo "gh pr list --label failed; not deciding" >&2; exit 1; }
     jq -e -s 'length == 1 and (.[0] | type == "array")' "$D/head.json" > /dev/null ||
       { echo "the --head query did not print one JSON array; not deciding" >&2; exit 1; }
     jq -e -s 'length == 1 and (.[0] | type == "array")' "$D/label.json" > /dev/null ||
       { echo "the --label query did not print one JSON array; not deciding" >&2; exit 1; }
     jq -s 'add' "$D/head.json" "$D/label.json" > "$D/prs.json" ||
       { echo "could not combine the two queries; not deciding" >&2; exit 1; }
     node scripts/verify-skill-drift.mjs select-pr --outcome changed --prs "$D/prs.json"
   )
   ```

   Run the block as one unit. It never relies on `set -e`, because bash switches that off for a command on the left of `||` or `&&`, in an `if` condition and in a `!` pipeline. Every step checks its own exit status and ends the block with `exit 1`, so the block fails the same way when it runs alone, after `||`, inside `if` or after `&&`. The `( ... )` keeps that `exit` from closing your shell. Each query runs on its own, so a failed `gh` call stops the block before anything is decided. Never treat a failed or empty-output query as "no PR". The `jq -e` checks stop the block unless each query printed exactly one JSON array (not `null`, not an object, not nothing). The block ends with `select-pr`, whose exit status is the block's, and `select-pr` exits `2` on rows without an integer `number` and a string `headRefName`. Query by head branch and label with `--limit 1000`, never the default 30-PR page, or the maintenance PR can drop out of the list and a second one gets opened. `--prs` is required (`select-pr` exits `2` without it), and a PR returned by both queries counts once.

   Only an open same-repo PR whose head is `chore/verify-skill-maintenance` is the maintenance PR. The label alone never makes a PR ours.

   - `create`: branch `chore/verify-skill-maintenance` from `origin/main`, then open one PR with the label `verify-skill-maintenance`.
   - `update`: the branch is always `chore/verify-skill-maintenance`. Check it out, rebase it onto `origin/main`, add this run's commit, and push with `--force-with-lease` to the same PR. Do not open a new one. Never rebase or push any other branch.
   - `duplicates`: other open same-repo PRs on `chore/verify-skill-maintenance`. Close them with a comment that points at the kept PR.
   - `foreign`: PRs that carry the label or the branch name but are on another branch or a fork. List them in the report and the PR body. Do not check out, rebase, push, close, relabel or comment on them.
   - For `clean` or `blocked`, the decision is `none`: no branch and no PR. Report the outcome and coverage. Leave an existing open maintenance PR as it is.
6. **PR body.** Give the outcome, the features covered live and the evidence directories, the before and after drift reports, any unreachable prerequisites, product gaps with their Linear links, and the `npm run preflight` stage lines.

## Merge and rollback

`.agents/skills/**` is not one of the AGENTS.md low-risk auto-merge categories, so these PRs go through normal sized review. To roll back, `git revert` the squash commit. To stop the weekly report, disable the workflow in the Actions UI.
