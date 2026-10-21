# Weekly evals report (OVD-894)

A local, deterministic report of merged PR throughput, first-pass CI/QA, repairs and agent spend. It uses GitHub CLI reads and optional Linear metadata; it makes no model calls and needs no paid eval service or new dependencies. The cost definition is [Cost per accepted PR](https://github.com/optomachina/Overdrafter/blob/main/docs/agent-graph-metrics.md#cost-per-accepted-pr).

## Run

Authenticate `gh` using your existing credentials, then run from the repository root:

```bash
node scripts/evals-weekly-report.mjs --repo optomachina/Overdrafter \
  --week-ending 2026-10-16 --spend-ledger /path/to/spend.jsonl \
  --linear-cache /path/to/linear.json --out evals/reports/2026-10-16.md
```

Weekly reports are committed at `evals/reports/<week-ending>.md` (for example, `evals/reports/2026-10-16.md`). The script writes the report; committing is a separate step. Omit `--out` for stdout. Omit `--repo` to discover it through `gh repo view` (fallback: `optomachina/Overdrafter`). `--week-ending` defaults to today UTC; `--now <ISO>` sets the clock for reproducible runs. The current week is seven inclusive UTC dates ending on that day; baseline is the preceding fourteen dates. `--help` lists all options. Exit status is 0 for a generated report, 2 for invalid arguments/records, and 1 for fetch or file failures. A stop-rule break is a report flag, not a fetch failure.

## Inputs and definitions

- GitHub: merged PRs targeting `main`, their comments, commits, reviews and observed head check rollup; check runs on the first commit with any non-ignored check runs determine first-pass CI, probing the first commit and at most three subsequent commits in order. Check runs are read with `filter=all`, so every re-run attempt is visible; the API default returns only the latest attempt and would hide a failure that a re-run fixed. All GitHub reads use one `execFileSync` helper, with an absolute `gh` path when available and a PATH fallback. Queries fail rather than silently truncate at 1000 PRs or 100 checks on any probed commit. The CLI buffer is 64 MiB.
- Infra/advisory contexts: `--ignore-checks <regex>` defaults to `^(Vercel|CodeRabbit)\b`, which also covers per-project status contexts such as `Vercel – overdrafter` and the `Vercel Preview Comments` check run. Matching is case-insensitive against check run `name` or status context `context`, for both head acceptance and first-pass CI. Pass `--ignore-checks ''` to disable ignoring; an invalid regex exits with usage status 2. The active pattern appears in Data sources and gaps. A commit whose only check runs are ignored, such as one pushed before CI ran that has only `Vercel Preview Comments`, is skipped when choosing the first-pass commit.
- Accepted PR: nonempty non-ignored head rollup whose latest run of every check is completed SUCCESS/NEUTRAL/SKIPPED (or StatusContext SUCCESS). The rollup lists every run on the head commit, including runs that workflow concurrency cancelled and a later run replaced, so only the newest run (by `startedAt`, then `completedAt`) of each (workflow, check name) counts; a CANCELLED run followed by a green run is accepted. A run with no timestamp (still queued or running) counts as newest, and a timestamp tie keeps the worse result. `gh` writes a missing time as `0001-01-01T00:00:00Z`, so any time before 1970 counts as missing. Failing/pending/empty rollups are merged-not-accepted and flagged. Flags show at most ten PR links followed by “and N more”, plus failing non-ignored head check names/states and PR counts. This is a post-merge observation; GitHub CLI cannot reconstruct the exact merge-time rollup. The report explicitly records this limitation.
- First-pass CI: at least one non-ignored check on the selected commit, and the first attempt of every check completed success/neutral/skipped. A re-run attempt stays in the check suite of the workflow run it re-ran, so the first attempt is the earliest run of a check (by app and check name, since the check-runs API has no workflow name) within each check suite. A failure, timeout or cancel that a re-run fixed therefore fails first-pass CI, and a check that passed first time still passes if a later re-run fails. A suite whose run of a check was cancelled and never re-ran, such as a run that workflow concurrency replaced with a new workflow run, is not a verdict when another suite ran the same check to a result other than cancelled; otherwise it fails. Probe up to four commits total, stopping at the first with any non-ignored check runs. No non-ignored checks on any probed commit means unknown.
- QA: comment lines `QA: PASS` and `QA: FAIL` are recognized. Any FAIL makes QA fail, including a failure followed by a pass. No verdict means `none` and is unknown. Only PRs with both CI and QA known enter the first-pass denominator; the numerator additionally requires passing both and zero repairs.
- Additional rows: **First-pass CI rate (CI known)** is CI-pass PRs divided by CI-known PRs; **QA verdict coverage** is PRs with a QA PASS/FAIL verdict divided by merged PRs. The existing first-pass pass rate remains unchanged. Flags warn for either baseline or current window when its joint first-pass denominator is under ten: “low sample: n=...; treat pass rate as indicative”.
- Repairs: maximum recorded `repair budget [now] used: N/2`, `repair round N` or `round-N repair`. QA FAIL or `Opus review @ sha: CHANGES REQUIRED` implies at least one repair. Counts can exceed the nominal budget if comments say so. Opus risk tier is inferred from comments starting `Opus review @` or `Opus re-review @`.
- Spend: repeat `--spend-ledger <file.jsonl>` for disjoint ledger files. Each JSONL line is `{"ts":"2026-10-12T12:00:00Z","usd":1.25,"pr":123,"issue":"OVD-123","agent":"writer","source":"usage-report"}`. Only `ts` and nonnegative finite `usd` are required; PR numbers must be positive integers. Use timezone-qualified ISO timestamps. Files are additive; duplicate records are not deduplicated. Ledger content is never written into the GitHub cache.

Every ledger line timestamped within a window enters total spend, including unattributed, abandoned and draft PR spend. Cost per accepted PR divides that total by the accepted count. Cost data comes only from the supplied spend ledger JSONL files; without a ledger the report prints `not available` and never estimates spend. With no ledger lines in the window every aggregate cost field says `not available (no spend ledger)`; with spend but no accepted PRs the ratio is undefined. Attribution for median, worst and risk-tier means uses explicit PR first, otherwise an issue ID linked to exactly one fetched PR. A merged PR's attributed spend includes its ledger lines from before the window, since work on it can start earlier, up to the window end. Missing attribution remains unknown, not zero. Attribution summaries cover merged PRs with recorded spend, including merged-not-accepted PRs. Shared issue IDs are left unattributed. Review tiers show mean attributed PR spend, rather than allocating shared overhead arbitrarily. The report also shows mean repair rounds, zero-repair share and a per-PR repair count.

## Linear and cache

Issue IDs are extracted case-insensitively from titles, branches, bodies (including an ID at the start of a line) and closing issue references. Optional `--linear-cache <json>` has shape `{"OVD-123":{"labels":["experiment"],"state":"Done"}}`. Without a loaded file or live results the report says `Linear data: not loaded`; GitHub-derived issue links still work.

Live Linear access requires **both** `--linear-live` and an existing `LINEAR_API_KEY` environment variable. One batched GraphQL query loads labels/state for all discovered IDs; results merge into `--linear-cache` when provided. Only those metadata fields are persisted. The key is used only in the HTTP authorization header, never intentionally logged or persisted; errors redact its literal value. Do not place credentials in source data, labels or output paths. No credential creation is needed.

The repository does not currently ignore `.cache/evals-weekly`, so the default cache is `${XDG_CACHE_HOME:-~/.cache}/overdrafter-evals-weekly`. Override with `--cache-dir`. List/discovery queries expire after one hour (`--cache-ttl-min 60`). Merged PR details are cached indefinitely by repository/PR/first-commit SHA (with a repository/PR lookup index), and all probed commit checks by repository/SHA, immutable per SHA (including empty results). These are treated as immutable for cheap reruns, although later comments/reviews or check reruns can change observed evidence: use `--no-cache` to refresh without reading or writing cache files. Delete only your own disposable cache files if a persistent refresh is needed. Cache files contain GitHub JSON, not credentials. A changed query shape naturally creates a new cache key.

## Register an experiment

Add an entry to `evals/experiments.json` (currently empty), or pass `--experiments <file>`:

```json
{
  "experiments": [{
    "id": "example-only",
    "title": "Example trial; replace with an actual registered experiment",
    "start": "2026-10-12",
    "match": {"prLabels": ["experiment-example"]},
    "stopRule": {"maxCostIncreasePct": 25}
  }]
}
```

Use a unique ID, title and start date; optional `end` is inclusive. An experiment is active if it has started by week end and has not ended before the current week. Before covers the fourteen days preceding start; after covers start through week end (even if the experiment ended during that week). The tool fetches enough history for all active experiments.

Optional `match` selectors are `linearLabels`, `prLabels`, `issues` arrays and `titleRegex`. Populated selector types combine with AND; values within an array combine with OR. With unmatched PRs in the after window, an additional A/B table compares matched and unmatched PRs. A/B spend includes only uniquely attributable lines for each arm: shared overhead and abandoned PR spend are excluded from these arm summaries, and remain in the full-window before/after comparison. Before/after always measures the full population, so experiment flags assess overall process cost rather than a selectively cheap cohort.

Default stop rule: after cost per accepted PR exceeds before cost by **more than 25%**, and after first-pass rate is no higher. The report prominently marks `⚠ STOP RULE BROKEN — revert or kill` in the experiment and top Flags section. `maxCostIncreasePct` overrides the threshold. Missing cost yields `cannot evaluate (no cost data)`; unknown rates also prevent evaluation. Neither is a pass. Operators decide and perform reversion separately; this tool only reads and reports.

## Limitations and verification

These are observational before/after comparisons, not causal estimates. Small samples, changing PR mix, optional/missing QA comments, incomplete ledgers and stale immutable cache entries affect results. No API can recover historical comment timing or exact merge-time checks from these reads. Status checks and comment conventions are evidence proxies; no QA or cost is invented. Missing Linear data can make label-based matching incomplete. The report links to the maintained metric definition and records query/cache counts, loaded Linear status and ledger lines used.

Offline tests use synthetic recorded-shape fixtures only:

```bash
npx vitest run scripts/evals-weekly-report.test.mjs
npx eslint scripts/evals-weekly-report.mjs scripts/evals-weekly-report.test.mjs
```
