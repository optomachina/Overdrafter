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
  `CI` and `PR body gate`, from the default branch checkout only.
- `macmini-backstop.sh`: the hourly backstop command.

## Modes

`report` (default) logs what would be handed off and writes nothing to GitHub.
`apply` adds the `qa:ready` label, then posts the hidden marker comment
`<!-- qa-handoff sha=<head_sha> -->`. The marker is the idempotency record
(dedupe key `qa-handoff:<pr>:<head_sha>`): a duplicate event or a backstop run
finds it and does nothing, and a new head sha gets a new key. Before writing,
`apply` re-reads the PR head and the comments inside the critical section.

The workflow sets `QA_HANDOFF_MODE: report`. Switch it to `apply` in the
workflow file once report-mode output has been checked.

## Required checks

Read from `main` branch protection. The workflow's `GITHUB_TOKEN` cannot read
protection (403/404), so it falls back to the `REQUIRED_CHECKS` env (comma
separated), then to `DEFAULT_REQUIRED_CHECKS` in `gate.mjs` (`ci`,
`provider-go-live`), and logs which list it used. Update both when branch
protection changes.

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

It uses `GH_TOKEN`/`GITHUB_TOKEN` if set, else `gh auth token`. A token that can
read branch protection uses the real required set. The backstop is not inside
the workflow's concurrency group; the in-lock re-read of comments narrows, but
does not close, the window where both write a marker for the same sha.

Single PR or sha: `node scripts/qa-handoff/run.mjs --repo optomachina/Overdrafter --mode report --pr 123`.
