# Review findings to rules

Source: OVD-859, under OVD-840 (pstack auto-merge). The practice comes from poteto's workshop (plan section 5).

## Practice

Review is a soft gate: reviewers and agents can forget, and a human who repeats the same review comment is doing a machine's job. Treat every repeated finding as a code smell and ask how to turn it into a lint rule, a test or a CI failure that eliminates the problem category.

The correction ladder is: architecture, then lint or test, then skill or rule, then human review. Move a finding up the ladder rather than leaving it at review.

## Rule: twice means a task

When the same finding category appears in **two distinct PRs**, open a Linear task labeled `finding-to-rule`. Repeats within one PR do not count. The task names the category, links both PRs, and proposes a rule type: `lint`, `test` or `ci`. Record it in [the ledger](review-findings-ledger.json) when opened.

Exceptions: if a rule is genuinely not feasible, close the task and set the ledger status to `wontfix` with a reason in the task. Rules touching `.github/workflows` or other sensitive paths still follow the sensitive-path rules in `AGENTS.md`.

## Category taxonomy

| Category | Typical finding |
| --- | --- |
| `type-safety` | `any`, unchecked casts, missing null handling |
| `error-handling` | swallowed errors, missing failure paths |
| `test-gap` | changed behavior with no test, missing negative case |
| `security-boundary` | service-role use in client code, missing owner or tenant checks |
| `data-access` | raw SQL outside migrations, unscoped queries |
| `architecture-boundary` | cross-layer imports between `src`, `worker` and `server` |
| `naming-style` | naming and structure that diverges from neighbouring code |
| `docs-drift` | docs or comments no longer matching the code |
| `performance` | N+1 queries, needless re-renders or loops |
| `other` | use only until a real category emerges, then add it here |

Add a category to this table and to `CATEGORIES` in `scripts/review-findings-rules.mjs` together.

## Ledger

`docs/review-findings-ledger.json` has one entry per category that has earned a task:

| Field | Meaning |
| --- | --- |
| `category` | taxonomy category (one entry per category) |
| `first_seen`, `second_seen` | the two PRs that triggered the task |
| `task` | Linear issue id, for example `OVD-900` |
| `rule_type` | `lint`, `test` or `ci` |
| `status` | `open`, `converted` or `wontfix` |
| `converted_by` | PR or commit that landed the rule; required when `converted` |

## Metric

**Conversion rate = converted / opened**, where opened is every ledger entry (including `wontfix`). Track it over time; a rate that stays low means findings are being handled by review instead of by rules.

## Script

```
node scripts/review-findings-rules.mjs --findings findings.json [--ledger docs/review-findings-ledger.json] [--json] [--fail-on-needs-task]
```

`findings.json` is an array of `{pr, reviewer, severity, category, file, title}`. The script prints each category seen in two or more distinct PRs that is not in the ledger as `needs task`, then the conversion rate. It makes no Linear or GitHub calls; a person or agent opens the task and edits the ledger.
