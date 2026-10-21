# CI usage

Repository: `optomachina/Overdrafter`. Window: 2026-10-10 through 2026-10-16 (UTC, both days inclusive).
Source: read-only `gh api` workflow runs. Each UTC day is requested on its own so the 1000-run list cap does not drop the rest of a busy week.
A run is attributed through `pull_requests[]`. A run listed on more than one pull request counts in full on each. Runs with an empty list are unattributed.
GitHub leaves `pull_requests` empty on most `pull_request` runs in this repository, including a direct GET of the run. Those runs stay in the unattributed row.
Minutes are wall-clock sums of job `started_at`..`completed_at`, not billable minutes. Billable time for this public repository reads 0.
The workflow table counts each run once. The pull-request table can count a shared run more than once.

| PR | Workflow runs | Jobs | Wall-clock minutes |
| --- | ---: | ---: | ---: |
| #743 | 29 | 128 | 307.6 |
| #776 | 11 | 44 | 91.7 |
| #799 | 14 | 58 | 121.8 |
| #803 | 6 | 28 | 65.4 |
| #813 | 22 | 69 | 148.6 |
| #817 | 8 | 30 | 71.0 |
| #819 | 8 | 30 | 76.9 |
| #824 | 12 | 45 | 112.7 |
| unattributed | 1708 | 10774 | 24255.4 |

## Workflows

| Workflow | Path | Runs | Jobs | Wall-clock minutes |
| --- | --- | ---: | ---: | ---: |
| CI | `.github/workflows/ci.yml` | 878 | 10264 | 24756.5 |
| Companion artifact protocol | `.github/workflows/companion-artifact.yml` | 2 | 2 | 0.5 |
| Companion four-suite Windows qualification | `.github/workflows/companion-inert-qualified.yml` | 10 | 10 | 18.6 |
| Companion task protocol | `.github/workflows/companion-task.yml` | 15 | 15 | 25.3 |
| Ephemeral DB | `.github/workflows/ephemeral-db.yml` | 2 | 2 | 4.7 |
| Independent stop observer | `.github/workflows/stop-observer.yml` | 14 | 14 | 31.7 |
| OVD-707 draft pgTAP (ephemeral CI database) | `.github/workflows/ovd707-pending-pgtap.yml` | 5 | 5 | 8.4 |
| OVD-766 draft pgTAP (ephemeral CI database) | `.github/workflows/ovd766-pending-pgtap.yml` | 26 | 26 | 45.6 |
| OVD-797 draft pgTAP (ephemeral CI database) | `.github/workflows/ovd797-pending-pgtap.yml` | 3 | 3 | 5.0 |
| OVD-829 draft pgTAP (ephemeral CI database) | `.github/workflows/ovd829-pending-pgtap.yml` | 4 | 4 | 7.2 |
| OVD-831 draft pgTAP (ephemeral CI database) | `.github/workflows/ovd831-pending-pgtap.yml` | 3 | 3 | 5.1 |
| PR body gate | `.github/workflows/pr-body-gate.yml` | 506 | 506 | 102.8 |
| Proof check | `.github/workflows/proof-check.yml` | 175 | 175 | 34.4 |
| SECURITY DEFINER lint | `.github/workflows/security-definer-lint.yml` | 50 | 50 | 9.7 |
| Sensitive class | `.github/workflows/sensitive-class.yml` | 12 | 12 | 2.5 |
| Sensitive paths report | `.github/workflows/sensitive-paths-report.yml` | 1 | 1 | 0.3 |
| Staged native SQL proofs | `.github/workflows/native-sql-proofs.yml` | 108 | 108 | 191.8 |
| Verify | `.github/workflows/verify.yml` | 4 | 6 | 1.0 |

