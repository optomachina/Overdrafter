# Spend ledger (OVD-923)

`scripts/spend-ledger.mjs` collects Token Watcher usage, calculates weekly dollars
per merged PR for Evaluator, and exports input for `evals-weekly-report.mjs`
(PR #835). No service calls occur during collection or export. Live PR lookup
uses `gh`; offline reporting uses `--prs-json`.

## Token Watcher input

Supply JSONL, one object per pool, UTC calendar day, and source. Required fields:

| Field | Contract |
| --- | --- |
| schema | Exactly `token-watcher-usage.v1` |
| pool | `codex`, `claude`, `cursor`, or `jev` |
| period | Real UTC date `YYYY-MM-DD` |
| source | Nonempty string, copied up to 64 characters |
| tokens | Optional null, nonnegative safe integer, or object with nonnegative safe integer values; informational only |
| dollars | Optional finite nonnegative metered dollars |
| subscriptionShare | Optional fraction in [0,1] of the monthly subscription consumed that day |
| subscriptionUsd | Positive finite monthly price supplied by Token Watcher, required with share |
| pr | Optional positive safe integer |
| issue | Optional case-sensitive `OVD-` followed by digits |
| bot, model | Optional strings, copied up to 64 characters; bot becomes ledger agent |

Exactly one valuation may be supplied: `dollars`, or `subscriptionShare` together
with `subscriptionUsd`. Both is an error. Null/absent dollars and share means
unvalued, even if tokens exist. Subscription dollars equal share times monthly
price: included usage is never assumed free. Tokens are never converted to dollars.
No prices are built in. Fixtures under `scripts/fixtures/spend-ledger/` are entirely
synthetic and are not usage or pricing evidence.

Unknown fields are ignored and never copied. Token object values must be numeric;
keys are sorted. Only the documented ledger fields propagate. Do not put secrets
in source, bot, model, issue or token field names: whitelisting is not redaction
of these explicitly accepted fields. Diagnostics never echo input records or gh
stderr. Invalid usage/JSONL identifies file and line.

## Collection and storage

```sh
npm run spend:ledger -- collect --input /local/usage.jsonl
npm run spend:ledger -- collect --input /local/a.jsonl --input /local/b.jsonl --ledger /local/ledger.jsonl --dry-run
```

The default ledger is `evals/spend-ledger/ledger.jsonl` under the Git repository
root (`git rev-parse --show-toplevel`, falling back to the script's parent directory).
Explicit paths resolve against the working directory. Real default-location JSONL
ledgers are gitignored because this repository is public. Keep custom ledger and
export paths outside the repository or explicitly ignored.

Each line has schema `spend-ledger.v1`, timestamp `period + T00:00:00Z`, period,
pool, usd, valuation (`metered`, `subscription-share`, `unvalued`), tokens (null
when absent), and source. Subscription-valued lines also retain subscriptionShare
and subscriptionUsd. Optional pr, issue, agent and model retain attribution.
Unvalued lines deliberately contain `usd: null`; they establish coverage without
pretending unknown usage costs zero.

The merge key is pool, period, truncated source, pr, issue. Duplicate keys in one
input file are errors at the second occurrence. Across input files, later input
wins; incoming keys replace stored keys. Distinct sources remain separate and
are added, so Token Watcher must avoid reporting the same consumption twice.
The output sorts by period, pool, source, numeric pr, issue and uses stable field
ordering. Recollecting identical input is byte-identical. Writes use a temporary
file and atomic rename; dry run prints record/valued/unvalued counts without writing.
Stored ledgers are revalidated when read. Multiple reporting ledgers merge by the
same key, with later files winning; ledgerLines counts loaded lines before merging.

## Weekly report

```sh
npm run spend:ledger -- weekly --from 2026-10-05 --to 2026-10-11 --prs-json scripts/fixtures/spend-ledger/prs.json --attribution scripts/fixtures/spend-ledger/attribution.json --ledger /local/ledger.jsonl
npm run spend:ledger -- weekly --from 2026-10-05 --to 2026-10-11 --repo optomachina/Overdrafter --format md
```

`--ledger` is repeatable. `--from` and `--to` are inclusive UTC dates.
`--min-sample` defaults to 5; `--generated-at` defaults to the end of `to`
(`T23:59:59Z`), never the wall clock. Live lookup requests merged PRs on main,
with an inclusive merged-date search and a 1000-result limit. Reaching the limit
fails rather than silently reporting truncated data; supply a complete local file.
Local PR input is the gh JSON array with number, title, mergedAt, labels,
headRefName, body and author; REST `merged_at` is also accepted. Duplicate numbers
and invalid merge timestamps fail. Only merge dates inside the window count.

Attribution accepts `pr-pool-attribution.v1` with a `prs` map (see the fixture),
or a shorthand map like `{"100":"codex"}`. Entries may supply pool, source,
and/or bot. This is the adapter boundary for PR #841 trust snapshot botAttribution
and OVD-919 substitution logs; neither is fetched automatically. Source metadata
is not a signal. Supported bot mappings:

| Bot | Pool |
| --- | --- |
| codex, chatgpt, chatgpt-codex-connector | codex |
| claude, claude-code, opus, sonnet | claude |
| cursor, grok, cursor-agent | cursor |
| jev | jev |

Bot mapping ignores case. Labels `model:opus` and `model:sonnet` also normalize
to claude; explicit pool values remain restricted to real pools and unknown. Labels `model:<pool>` and `pool:<pool>` supply signals.
All signals must agree: file versus label disagreement, or two different pools,
means unknown with `conflicting`. An explicit unknown remains unknown (and cannot
be upgraded by a label). No signals means unknown with `no_signal`; a consistent
signal has `explicit` status. Authors, branch names and model names never imply
build pools. Unknown PRs count in overall merges, but no pool's denominator.

Every overlapping ISO Monday/Sunday week appears, including empty weeks. Bounds
are full-week dates; daysInWindow counts only the clipped window. 2026-12-28
through 2027-01-03 is 2026-W53. Spend follows usage period; merges follow mergedAt.
Every pool's whole spend stays in the numerator, including abandoned work,
reviews and overhead. Per-pool dollars/PR divides that spend by PRs that pool
built. Reviews performed by one pool on another pool's PR are not reallocated.
See [Cost per accepted PR](agent-graph-metrics.md#cost-per-accepted-pr).

## JSON output and edge cases

The deterministic `spend-per-pr.v1` object contains generatedAt, window, minSample,
pools, sources (`ledgerFiles`, `ledgerLines`, `prSource`, `attributionLoaded`), weeks,
totals, prs and notes. Weeks contain week, weekStart, weekEnd and the same summary
shape as totals: daysInWindow, pools, overall, attributedUsd and prs. Arrays of PRs
sort numerically; pools retain codex, claude, cursor, jev order.

Pool summaries contain pool, usd, mergedPRs, usdPerMergedPR, status, flags,
coverage, recordsValued, recordsUnvalued, daysWithData, daysWithValuedData and
missingDays (dates). Coverage is complete only when every clipped day has a valued
record and no record is unvalued; partial otherwise when any record exists;
missing when no record exists. Partial coverage adds partial and lowerBound true.
Usd is null without valued data, including all-unvalued coverage. Zero is valid
only when actual valued records sum to zero. Ratios round half-up to cents;
spend totals retain unrounded arithmetic.

Pool status is unknown if usd is null, otherwise no-merges for zero merges,
low-sample for a positive count below minSample, then partial for partial
coverage, otherwise ok; flags list every condition. Ratios are null
for unknown spend or no merges. Overall uses totalUsd, all mergedPRs,
unattributedPRs, missingPools, partialPools and the same ratio fields. Any incomplete
pool adds lowerBound true and a partial flag. Overall status precedence is unknown,
no-merges, low-sample, partial, ok; flags preserve all applicable conditions.
Totals aggregate original records and merges across the window, not rounded ratios.

Direct spend matches an explicit pr first, or an issue mentioned case-insensitively
in title, branch or body of exactly one supplied merged PR. Shared issues remain
unattributed, including when another supplied PR is outside the window. Only PRs
merged inside the window receive direct spend. Per-week attributedUsd counts
eligible direct spend incurred that week even when its PR merged in another week.
Weekly prs lists merges that week and their directly associated spend incurred
that week; top-level/totals prs aggregate the whole window. Each entry contains
number, pool, attributionStatus and attributedUsd (null without valued direct
records). Pool-level spend always remains in overall and pool totals.

Markdown emits one table per week (one row per pool plus an all-pools row with
merged and unattributed PR counts and coverage gaps) with unknown, n/a (no merges), and
`≥ $x (partial)` rather than inventing zero for missing data. Evaluator should
consume JSON for calculations and retain coverage, flags and caveats in prose.

## Evals compatibility and CLI exits

```sh
npm run spend:ledger -- export-evals --ledger /local/ledger.jsonl --out /local/evals.jsonl
```

PR #835's reader requires finite nonnegative usd, so do not feed it the canonical
ledger containing null usd. Export writes only valued lines with ts, usd, optional
pr/issue/agent, source and pool; stderr reports skipped unvalued lines. Without
`--out`, JSONL goes to stdout. Evals consumes this export; Evaluator consumes the
weekly JSON. Export removes model/tokens/subscription metadata.
Every exported line also carries `exportUnvaluedRecords`, the integer count of
excluded unvalued records, and `exportComplete`, true only when that count is zero.
No header or trailer is emitted. When all records are unvalued, nothing is
written (stdout stays empty and `--out` creates or changes no file, so an empty
file can never be read as a $0 export) and the CLI exits 3 with
`No valued records to export; N unvalued` on stderr. An empty ledger still exits
0 with empty output.

Both gh and git are resolved only from `/usr/bin`, `/bin`, `/usr/local/bin`, and
`/opt/homebrew/bin`. Their environment contains only PATH set to `/usr/bin:/bin`
and HOME from the operating system home directory. GH_TOKEN-only authentication
is not passed through; use gh's stored login or `--prs-json`. Missing gh produces
a usage error suggesting `--prs-json`; missing git uses the repository-root fallback.

`--help` exits 0. Success exits 0, usage/validation errors exit 2, file or gh
failures exit 1. `main(args, deps)` supports stdout, stderr, runGh, cwd and repoRoot
injection, plus resolveBin and execFile injection; tests use disposable directories and never contact gh or the network.

## Open questions for Token Watcher

- Which stable sources own each pool/day, and how will overlapping sources be deduplicated?
- Can each source supply metered dollars or monthly subscription share and price,
  including Cursor included usage? What precision and monthly reset/timezone apply?
- How are revised reports, refunds, credits and unavailable days represented?
  Negative amounts are currently rejected; missing valuation is explicitly unknown.
- Can PR/issue, bot and model be supplied reliably, and how will substitution
  logs and trust snapshots be normalized into the attribution map?
- How will subscription allocations across days avoid double counting or exceeding
  the monthly plan? This collector validates each share, not monthly sum policy.
