# QA handoff (OVD-865)

Hands a PR to QA once per head sha, when the PR is open, not a draft, targets
`main`, and every required check on its current head passed (success, skipped
or neutral; anything pending, failed or missing blocks).

- `gate.mjs`: pure decision logic (`evaluateGate`, `decide`, `markerFor`,
  `hasMarker`, `dedupeKey`). No IO.
- `run.mjs`: GitHub API wrapper and CLI, shared by the workflow and the
  backstop. Re-reads all state through the API; the event's head sha and PR
  number are lookup keys only.
- `.github/workflows/qa-handoff.yml`: runs on `workflow_run` completed for
  `CI` and `PR body gate`, from the default branch checkout only, and only when
  the triggering run's event was `pull_request`. No run step fetches or checks
  out PR refs.
- `PR body gate` also runs on `ready_for_review`. The gate skips drafts, and CI
  does not re-run when a draft is marked ready, so without this trigger a PR
  that went green as a draft would never emit a `workflow_run` after leaving
  draft (until the hourly backstop).
- `macmini-backstop.sh`: the hourly backstop command.

## Modes

`report` (default) logs what would be handed off and writes nothing to GitHub.
`apply` adds the `qa:ready` label, then posts the hidden marker comment
`<!-- qa-handoff sha=<head_sha> -->`. The marker is the idempotency record
(dedupe key `qa-handoff:<pr>:<head_sha>`): a duplicate event or a backstop run
finds it and does nothing, and a new head sha gets a new key. Before writing,
`apply` re-reads the PR head and the comments inside the critical section.

Only markers written by a trusted author count; a marker pasted by anyone else
is ignored. The trusted set is `github-actions[bot]` plus the comma separated
logins in `QA_HANDOFF_TRUSTED_MARKER_AUTHORS` (the backstop adds its own
`gh api user` login).

After writing the marker, `apply` re-lists the comments and, if more than one
trusted marker exists for the sha, deletes every one above the lowest comment
id. Both racing writers pick the same survivor; a 404 on delete means the other
writer got there first.

The workflow sets `QA_HANDOFF_MODE: report`. Switch it to `apply` in the
workflow file once report-mode output has been checked.

## Required checks

Read in order, using the first source that returns a non-empty list:

1. `GET /repos/{repo}/branches/main`, `protection.required_status_checks`
   (`contexts` and `checks`).
2. `GET /repos/{repo}/branches/main/protection/required_status_checks` (needs
   admin scope; `GITHUB_TOKEN` usually gets 403/404).
3. The `REQUIRED_CHECKS` env (comma separated).
4. `DEFAULT_REQUIRED_CHECKS` in `gate.mjs` (`ci`, `provider-go-live`).

The log names the source used. A 403/404 moves to the next source; any other
API error fails the run. Update 3 and 4 when branch protection changes.

A required check run counts only if it comes from GitHub Actions
(`app.slug == "github-actions"`) when the run names its app, so another app
cannot satisfy `ci` with a same-named check run. Commit statuses are matched by
context as before.

## Mac mini backstop

Run hourly from a checkout of `main` (not a PR branch), report mode until the
workflow moves to apply:

```bash
cd ~/Overdrafter && git pull --ff-only origin main && scripts/qa-handoff/macmini-backstop.sh report
```

For example, as a crontab entry:

```cron
0 * * * * cd ~/Overdrafter && git pull --ff-only origin main && scripts/qa-handoff/macmini-backstop.sh report >> ~/Library/Logs/qa-handoff.log 2>&1
```

It uses `GH_TOKEN`/`GITHUB_TOKEN` if set, else `gh auth token`, and appends the
`gh api user --jq .login` login to `QA_HANDOFF_TRUSTED_MARKER_AUTHORS` so its
own markers count. The backstop is not inside the workflow's concurrency group;
when both write a marker for the same sha, the post-write dedupe removes the
higher-id one.

Single PR or sha: `node scripts/qa-handoff/run.mjs --repo optomachina/Overdrafter --mode report --pr 123`.
