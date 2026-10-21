# Agent graph metrics

A deliberately small note for judging whether the lean agent graph (see `AGENTS.md`) is working. Count by hand or with `gh`; no tooling is required.

## Cost per accepted PR

An accepted PR is merged to `main` with current-head checks green.

```
cost per accepted PR = total agent spend in the window / accepted PRs in the window
```

- Spend includes every agent run attributed to the PR: the writer, repair rounds, the Jev screen, Sonnet and Opus reviews. Take it from the provider or session usage reports, keyed by PR number or Linear issue.
- Include spend on PRs that were abandoned or stayed draft; they are the cost of getting accepted ones. Do not drop them from the numerator.
- Report the median and the worst PR alongside the mean, and split by risk tier (Opus-reviewed vs not) to see what the extra review costs.
- Companion counts: repair rounds used per PR (budget is 2) and the share of PRs that passed CI with zero repair rounds.

## Founder interventions

An intervention is any point where Blaine must act for a PR to progress, beyond the protected-action approvals defined in `AGENTS.md`:

- answering an agent question or unblocking a stuck writer;
- editing, rerunning, or restarting something by hand;
- taking over a draft that exhausted its repair budget;
- overriding a review verdict or merging manually against a failing signal.

```
interventions per accepted PR = interventions in the window / accepted PRs in the window
```

Log each one in the PR or its Linear issue with the label `founder-intervention` and a one-line reason, so the count is `gh pr list --label founder-intervention --state all` plus the same label on issues. Protected-action approvals are counted separately, not as interventions.

## Reading the numbers

Review weekly. Falling cost and interventions per accepted PR with steady throughput means the graph is paying off; a rising share of draft-with-diagnostics PRs or infra reruns points at the preflight or runners, not the agents.
Automated weekly report: see [docs/evals-weekly-report.md](evals-weekly-report.md) (OVD-894).
