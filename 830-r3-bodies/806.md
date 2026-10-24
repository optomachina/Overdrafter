## Linear issue ID
- Issue: [OVD-859](https://linear.app/overdrafter/issue/OVD-859/turn-repeated-review-findings-into-rules) (child of OVD-840). Main PR.

## Summary
Puts poteto's practice into the repo: when reviewers flag the same kind of problem twice, it should become a lint, test or CI rule.
- `docs/review-findings-to-rules.md` describes the practice and a taxonomy of 10 categories. When a category shows up in 2 distinct PRs, a Linear task labeled `finding-to-rule` gets opened. The metric is converted / opened.
- `docs/review-findings-ledger.json` is the ledger, starting empty. Each entry records `category, first_seen, second_seen, task, rule_type (lint|test|ci), status (open|converted|wontfix), converted_by`.
- `scripts/review-findings-rules.mjs` reads findings JSON and the ledger. It lists the categories seen in 2 or more PRs that the ledger doesn't track yet ("needs task") and reports the conversion rate. It makes no Linear or GitHub calls; it only outputs the tasks to open.

## Verification
- `bash scripts/preflight.sh lint`: PASS
- `bash scripts/preflight.sh typecheck`: PASS
- `npx vitest run --maxWorkers=2`: 11605 passed, 3 failed. The 3 failures are the known OVD-417 docker ones.
- New `scripts/review-findings-rules.test.mjs`: 8/8 pass

## Migration notes
- [x] No migration impact

## Rollback / risk notes
Docs and a script only. To roll back, revert the PR.
