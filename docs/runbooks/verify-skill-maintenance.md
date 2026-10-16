# Weekly verify-skill maintenance (OVD-858)

Keeps the `verify-overdrafter` feature map (`.agents/skills/verify-overdrafter/`, OVD-842) in line with the app. Each run ends with one outcome, `clean`, `changed` or `blocked`, and opens **at most one PR**.

There are two parts. Only the first is automated:

1. **Drift report (CI, read-only).** `.github/workflows/verify-skill-drift.yml` runs every Monday and on manual dispatch. It runs `scripts/verify-skill-drift.mjs` and uploads the `verify-skill-drift` artifact (`verify-skill-drift.json` and `.md`). It has `contents: read` only, no secrets, and never pushes or opens PRs. A drift result fails the run on purpose.
2. **Maintenance pass (agent).** An agent runs pstack `maintain-verification-skill`, guided by the report, and ships at most one PR.

## The drift report

```bash
node scripts/verify-skill-drift.mjs --json /tmp/drift.json --markdown /tmp/drift.md
```

Exit `0` means no drift, or the skill is absent (it prints `Status: **absent**` and does nothing). Exit `1` means drift. Exit `2` means a usage error or a malformed `drift-ignore.json`. The report compares the map to `src/App.tsx` routes, `e2e/**/*.spec.ts` and the repo paths the map cites in inline code:

| Kind | Meaning | Usual fix |
| --- | --- | --- |
| `missing-index`, `dead-index-link`, `unindexed-feature` | `features/README.md` and the feature files disagree | Fix the index |
| `stale-route`, `stale-spec`, `missing-path` | The map cites something the app no longer has | Doc drift: update the map, or report a product regression |
| `unmapped-route`, `unmapped-spec` | The app has a surface or spec the map never names | Add it to a feature file, or ignore it with a reason |

The report is deterministic and covers structure only. It cannot see behavior drift, so the skill's live pass is still required.

Intentional exclusions go in `.agents/skills/verify-overdrafter/drift-ignore.json`. Every entry needs a reason, and a trailing `*` matches a prefix:

```json
{ "routes": [{ "pattern": "/debug/*", "reason": "dev-only galleries, not a user feature" }], "specs": [], "paths": [] }
```

Gitignored runtime paths that the map cites, such as `playwright/.auth/`, count as present.

## Run procedure

1. **Get the report.** Use `gh run download --name verify-skill-drift` on the latest run, or regenerate it locally at current `origin/main`. If the status is `absent`, stop: the outcome is `clean` and there is nothing to maintain.
2. **Run `maintain-verification-skill`** on `.agents/skills/verify-overdrafter`. Use the report to seed its index-hygiene step (step 1) and its churn sweep (step 3). Every finding gets a disposition: fix the map, ignore it with a reason, or record a product gap. The source wave and the live pass still cover every feature. Drive the app through `scripts/verify.sh` (doctor first; use local mode only where Docker is available). Report anything unreachable with its prerequisite.
3. **Stay in edit scope.** Edit only the skill directory, including `drift-ignore.json`. Never edit product code. File product gaps as Linear issues; they never go in this PR.
4. **Re-run the detector** after the edits. Any drift kind that is still reported must be explained in the PR body.
5. **Choose the PR. Only a `changed` outcome ships.**

   ```bash
   gh pr list --state open --json number,headRefName,labels,isCrossRepository,state > /tmp/prs.json
   node scripts/verify-skill-drift.mjs select-pr --outcome changed --prs /tmp/prs.json
   ```

   - `create`: branch `chore/verify-skill-maintenance` from `origin/main`, then open one PR with the label `verify-skill-maintenance`.
   - `update`: check out the returned branch, rebase it onto `origin/main`, add this run's commit, and push with `--force-with-lease` to the same PR. Do not open a new one.
   - `duplicates`: close any listed PRs with a comment that points at the kept PR.
   - For `clean` or `blocked`, the decision is `none`: no branch and no PR. Report the outcome and coverage. Leave an existing open maintenance PR as it is.
6. **PR body.** Give the outcome, the features covered live and the evidence directories, the before and after drift reports, any unreachable prerequisites, product gaps with their Linear links, and the `npm run preflight` stage lines.

## Merge and rollback

`.agents/skills/**` is not one of the AGENTS.md low-risk auto-merge categories, so these PRs go through normal sized review. To roll back, `git revert` the squash commit. To stop the weekly report, disable the workflow in the Actions UI.
