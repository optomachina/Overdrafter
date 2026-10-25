# Trust metrics (OVD-785, OVD-786, OVD-1098)

`scripts/trust-metrics.mjs` builds a versioned JSON snapshot of delivery trust
metrics and writes it to `docs/trust/snapshot-<window-end>.json`. The OVD-787
admin trust dashboard reads the lexically latest committed
`docs/trust/snapshot-YYYY-MM-DD.json`. This document defines every field.

## Running

```bash
npm run trust:metrics -- --window-end 2026-10-15 --weeks 8 --artifact-root ~/overnight/artifacts
```

| Flag | Meaning |
|---|---|
| `--window-end YYYY-MM-DD` | Required. Last UTC day in the window. |
| `--window-start YYYY-MM-DD` | First UTC day. Defaults to the Monday `--weeks - 1` weeks before the Monday of the end week. |
| `--weeks N` | Weeks in the default window (default 8). |
| `--generated-at ISO` | Value for `generatedAt`. Defaults to `<window-end>T23:59:59Z`. |
| `--repo owner/name` | GitHub repository (default `optomachina/Overdrafter`). |
| `--base BRANCH` | Only PRs merged into this branch count (default `main`). |
| `--prs-json FILE` / `--comments-json FILE` | Offline inputs used instead of `gh api`. Pass both or neither. |
| `--commits-json FILE` | Optional offline object mapping `"<reviewSha>...<qaHead>"` to a comments-only ancestor boolean. Only literal `true` keeps an ancestor review; missing entries are false. |
| `--results-jsonl FILE` | A live harness `results.jsonl` file. Repeatable. |
| `--artifact-root DIR` | Reads every `<DIR>/<runId>/results.jsonl`. A missing directory counts as zero files. |
| `--out FILE` / `--stdout` | Output path (default `docs/trust/snapshot-<window-end>.json`), or print instead. |

Without offline inputs the script reads GitHub through `gh api` and only
reads: closed PRs (`GET /repos/{repo}/pulls?state=closed`), issue comments
since 60 days before the window start (`GET /repos/{repo}/issues/comments`),
and comparisons needed for QA reviewer attribution
(`GET /repos/{repo}/compare/{reviewSha}...{qaHead}`). Offline PR/comment inputs
never fetch comparisons; without `--commits-json`, only equal SHAs are kept.
It needs an authenticated `gh` CLI. It never writes to GitHub.

**Determinism.** Output depends only on inputs and flags. `generatedAt` never
comes from the wall clock. Keys are in a fixed order and every array is sorted.
The same inputs in any order give byte-identical JSON, and a test checks this.
Re-running against live GitHub can still change the result when GitHub data
changes, for example when a late QA comment lands on a PR.

## Common definitions

- **Window.** Whole UTC days from `window.start` 00:00:00Z up to, but not
  including, the midnight after `window.end`.
- **Week.** A week starts Monday 00:00 UTC. `weekStart` is that Monday as
  `YYYY-MM-DD`. The first week can start before `window.start`. The last week
  can be partial when `window.end` is not a Sunday.
- **Merged PR.** A pull request whose `merged_at` falls in the window and
  whose base branch is `--base` (default `main`). PRs merged into stacked or
  feature branches are excluded. Offline inputs that carry no base branch are
  included.

## Fields

All paths are relative to the snapshot root.

| Path | Type | Definition | Source |
|---|---|---|---|
| `schemaVersion` | string | Always `"trust-snapshot.v1"`. Readers must reject other values. | constant |
| `generatedAt` | string, ISO 8601 UTC, whole seconds (`YYYY-MM-DDTHH:MM:SSZ`) | Snapshot time. Comes from `--generated-at`, or `<window.end>T23:59:59Z` by default. | input flag |
| `window.start` | string `YYYY-MM-DD` | First UTC day in the window. | input flag |
| `window.end` | string `YYYY-MM-DD` | Last UTC day in the window. Matches the filename date. | input flag |
| `sources.repository` | string | GitHub `owner/name` the PR metrics came from. | input flag |
| `sources.baseBranch` | string | Base branch a merged PR must target. | input flag |
| `sources.harnessResultFiles` | integer | Number of `results.jsonl` files read. `0` means no harness data was available, so `liveQuotes` is empty. | input files |
| `merges.total` | integer | Number of merged PRs in the window. | GitHub PRs |
| `merges.perWeek[]` | array, ascending by `weekStart` | One entry for every week that overlaps the window, including weeks with zero merges. | GitHub PRs |
| `merges.perWeek[].weekStart` | string `YYYY-MM-DD` (Monday) | Start of the week. | derived |
| `merges.perWeek[].count` | integer | Merged PRs whose `merged_at` falls in that week and inside the window. | GitHub PRs |
| `qa.pass` | integer | Merged PRs whose latest QA verdict is PASS. | PR comments |
| `qa.fail` | integer | Merged PRs whose latest QA verdict is FAIL. | PR comments |
| `qa.noVerdict` | integer | Merged PRs with no QA verdict. `pass + fail + noVerdict = merges.total`. | PR comments |
| `qa.unit` | string | Always `"latest_verdict_per_merged_pr"`, the counting unit (see QA verdicts below). | constant |
| `reverts.reverts` | integer | Merged PRs that are reverts (see Reverts and rollbacks below). | GitHub PRs |
| `reverts.rollbacks` | integer | Merged PRs that are rollbacks and not reverts. | GitHub PRs |
| `timeToMerge.medianHours` | number (2 dp) or null | Median of `merged_at - created_at` in hours over all merged PRs. Null when there are none. | GitHub PRs |
| `timeToMerge.p90Hours` | number (2 dp) or null | 90th percentile of the same values. | GitHub PRs |
| `timeToMerge.perWeek[]` | array, ascending by `weekStart` | Weekly median and p90, grouped by merge week. Weeks with no merges are omitted, so a missing week means no data. | GitHub PRs |
| `timeToMerge.perWeek[].weekStart` | string `YYYY-MM-DD` (Monday) | Start of the week. | derived |
| `timeToMerge.perWeek[].medianHours` | number (2 dp) | Median hours for PRs merged that week. | GitHub PRs |
| `timeToMerge.perWeek[].p90Hours` | number (2 dp) | 90th percentile hours for PRs merged that week. | GitHub PRs |
| `liveQuotes[]` | array | One row for each distinct live harness result whose `timestamp` falls in the window. Sorted by `timestamp`, `runId`, `provider`, `requestedQuantity`. | `results.jsonl` |
| `liveQuotes[].runId` | string or null | Harness run id (`YYYYMMDDTHHMMSSZ-xxxxxxxx`). | `results.jsonl` |
| `liveQuotes[].provider` | string or null | Provider (vendor) key, for example `xometry`. | `results.jsonl` |
| `liveQuotes[].requestedQuantity` | number or null | Quantity requested from the provider. | `results.jsonl` |
| `liveQuotes[].totalPriceUsd` | number or null | Total price in USD from the first normalized offer. Null on failure. | `results.jsonl` |
| `liveQuotes[].leadTimeBusinessDays` | integer or null | Adapter-normalized lead time in business days from the first offer. Null when the provider showed none, or when the row predates OVD-785. | `results.jsonl` (optional field) |
| `liveQuotes[].estimatedDeliveryDate` | null in v1 | A delivery date stated by the provider. Always null today (see G1). It is never computed from `timestamp` or lead time. | none |
| `liveQuotes[].deliveryUnavailableReason` | string or null | Why `estimatedDeliveryDate` is null. Always `"not_captured_by_harness_v1"` in v1. | constant |
| `liveQuotes[].status` | string or null | Harness status (see the status vocabulary below). | `results.jsonl` |
| `liveQuotes[].timestamp` | string ISO 8601 UTC (ms) | When the harness recorded the row. | `results.jsonl` |
| `liveQuotes[].errorCode` | string or null | Harness error code on failure. | `results.jsonl` |
| `bots[]` | array | Builder and reviewer bot rows, sorted by bot key with `unknown` last. | PRs and issue comments |
| `bots[].bot` | string | Lowercase bot key; `unknown` means no signal or conflicting evidence. | attribution evidence |
| `bots[].prs` | integer | Merged PRs attributed to this builder. | GitHub PRs |
| `bots[].qa.pass` | integer | Builder PRs whose latest QA verdict is PASS. | PR comments |
| `bots[].qa.fail` | integer | Builder PRs whose latest QA verdict is FAIL. | PR comments |
| `bots[].qa.noVerdict` | integer | Builder PRs with no QA verdict. | PR comments |
| `bots[].qa.passRate` | number (4 dp) or null | `pass / (pass + fail)`, rounded to four decimal places; null without verdicts. | derived |
| `bots[].reverts.reverts` | integer | Builder PRs counted as reverts by the shared rules below. | GitHub PRs |
| `bots[].reverts.rollbacks` | integer | Builder PRs counted as rollbacks by the shared rules below. | GitHub PRs |
| `bots[].reviews.approved` | integer | Standard APPROVED verdict comments attributed to this reviewer. | PR comments |
| `bots[].reviews.changesRequired` | integer | Standard CHANGES REQUIRED verdict comments attributed to this reviewer. | PR comments |
| `botAttribution.attributed` | integer | Merged PRs with exactly one distinct candidate key. | attribution evidence |
| `botAttribution.noSignal` | integer | Merged PRs with no candidate keys. | attribution evidence |
| `botAttribution.conflicting` | integer | Merged PRs with multiple distinct candidate keys or invalid explicit model tokens. | attribution evidence |
| `botAttribution.bySource.label` | integer | Attributed PRs supported by a model label. | PR labels |
| `botAttribution.bySource.body` | integer | Attributed PRs supported by an explicit body model line. | PR bodies |
| `botAttribution.bySource.author` | integer | Attributed PRs supported by a GitHub App bot author. | bot author metadata |

The snapshot never contains `quoteUrl`, `providerQuoteId`, artifact paths,
comment bodies, PR bodies or human author identities; only GitHub App bot
logins reduced to a bot key can supply author attribution.

### Bot attribution

Bot keys are lowercase tokens matching `/^[a-z0-9][a-z0-9._-]*$/`.
Keys are used as written after lowercasing, with no alias mapping: `claude`
does not become `opus`. The literal `unknown` is reserved and supplies no
signal from any source.

Each merged PR collects builder candidates from three sources:

- **label:** every label matching `model:<key>` after lowercasing.
- **body:** explicit model lines, ignoring lines inside triple-backtick fenced
  code blocks. Strip `*`, backticks, `#` and `>` everywhere, leading list markers
  (`- `, `* `, `+ `), and surrounding whitespace. Strip runs of underscores
  only as paired emphasis delimiters: an opening run at line start or after
  whitespace must have an identical closing run followed by whitespace or line
  end. Underscores inside tokens and bare trailing underscores stay intact:
  `_Model: opus_` and `__model: opus__` work, `z_bot` stays `z_bot`, and
  `Model: codex_` credits `codex_` (so label `model:codex` plus body
  `Model: codex_` is conflicting). An unpaired leading `_Model: opus`
  supplies no signal because its prefix does not match. Match the prefix `/^(?:build(?:er)?\s+)?model\s*:\s*/i`,
  remove one leading `model:` (case-insensitive) so a body that restates the
  label syntax, such as `Model: model:codex`, credits `codex`, then take the
  whole next whitespace-delimited token. A second `model:` is not removed, and
  `Model: model:` leaves an empty token, which is conflicting. Remove trailing
  punctuation from the set `, ; : ) ·`; also remove a single trailing `.`
  only when the line ends immediately after it (never a run of periods).
  The whole remaining token must match the bot key pattern, case-insensitively,
  then is lowercased. Thus `Model: bot-` credits `bot-`, and `Model: opus.`
  and `Model: opus, per Release` credit `opus`. An empty or ambiguous token
  such as `codex/opus`, `codex,opus` or `opus|codex` is conflicting evidence.
  This includes an exact `model:<key>` line, `Model: opus per Release`,
  `**model:opus** · **Needs Blaine's card**`, `Build model: **opus** (source: …)`,
  and `Model: sonnet per Grok Bot triage handoff (no model label exists)`.
  Prose such as `Codex and other reviewers: pending`, `Opus review: CHANGES REQUIRED`,
  `Generated with Claude Code`, and `Co-Authored-By: Claude …` supplies no signal.
- **author:** a GitHub App bot identified by `user.type === "Bot"`, an author
  login ending in `[bot]`, or `author.is_bot === true`. Both `user.login` and
  `author.login` input shapes are supported. Lowercase the login and remove
  a trailing `[bot]`; retain it only if it matches the key pattern. Human
  author logins never supply evidence and are discarded by normalization.
  The live fetch keeps author metadata only when `user.type === "Bot"`.

Exactly one distinct key means `attributed`; its sorted, distinct `sources`
record all agreeing sources. Zero keys means `no_signal` with no sources.
Multiple distinct keys or an invalid explicit model token mean `conflicting`,
with all contributing sources (including `body` for an invalid token), even
when a label or author supplies a valid key. An ambiguous explicit model line
prevents attribution from any source.
Both unattributable cases go to `unknown`, never guessed. A label cannot
outvote a body or author. `botAttribution` counts these three outcomes;
`bySource` counts only attributed PRs, once per agreeing source, so one PR
can count toward multiple sources.

Review comments count toward the **reviewer**, independently of the builder.
The first non-empty line, after applying the same markdown stripping rules and
trimming, must match this case-insensitive format:

```text
^(\S+)\s+(review|re-review)\s*@\s*([0-9a-f]{7,40})\s*:\s*(approved|changes required)\b
```

The whole whitespace-delimited reviewer token must match
`/^[a-z][a-z0-9._-]*$/i` and cannot be `unknown`; partial or ambiguous
tokens are rejected. Internal and bare trailing underscores remain intact, so
`z_bot review @ deadbeef: APPROVED` credits `z_bot` and
`z_bot_ review @ deadbeef: APPROVED` credits `z_bot_`. The parser lowercases
the bot, round and SHA and returns verdict `approved` or `changes_required`.
`Codex review @ 1a2b3c4d: APPROVED` and
`**Opus re-review @ deadbeef: CHANGES REQUIRED**` count.
`Opus review: CHANGES REQUIRED @ 7717135c` is non-standard and returns null.
Every verdict comment counts, deduplicated by nonzero comment id, only when
its PR is in the merged set and its timestamp is before the window's end.
As with QA, comments before the window start can count. Review bodies and
inline review comments are not read.

A row exists for each builder with a merged PR or reviewer with a counted
verdict. Rows use code-unit order by bot key, with `unknown` always last.
Review-only rows have zero PRs and null QA pass rate. No merged PRs and no
review verdicts gives `bots: []` and all-zero `botAttribution`; merged PRs
with no attribution give one `unknown` row. QA and revert calculations use
the same rules as the overall metrics. Across rows, PR counts sum to
`merges.total`, QA pass/fail/noVerdict counts sum to the overall QA counts,
and revert/rollback counts sum to the overall revert/rollback counts.
`attributed + noSignal + conflicting = merges.total`.

This is additive within `trust-snapshot.v1`: `botAttribution` is appended
after `bots`. The committed `snapshot-2026-10-15.json` predates OVD-786 and
has `bots: []` and no `botAttribution`. Treat a missing `botAttribution` as
"not computed", rather than zero attribution.

### QA verdicts

A QA verdict is an issue comment on the PR whose **first non-empty line**
matches, ignoring case and markdown emphasis (`* _ \` # >`):

```
^(final-head |final |T<n> final )?QA:? (PASS|FAIL)\b
```

For example `QA: PASS on 31e99417`, `**QA: FAIL** on db45840`,
`Final-head QA PASS at 1c3253a`, and `T5 final QA PASS at 9d67da3`. A first line
that contains `follow-up` is not a verdict, because engineers post replies
such as `QA FAIL follow-up on head …`. `PARTIAL` and other words are ignored.

**Counting unit.** For each merged PR, only the latest verdict counts: the
verdict comment with the greatest `created_at`, with ties broken by comment id,
created before the window's end. A later FAIL supersedes an earlier PASS, and
the other way round. Verdicts on PRs that are not merged in the window are
ignored. Comments from any author count. Only issue comments are read, not
review bodies or review comments.

### QA reviewer families and builders (OVD-1098)

`qaFamilies` is an additive, report-only section in `trust-snapshot.v1`.
Existing fields and attribution rules are unchanged. A missing section in an
older snapshot means it was not computed.

| Path | Type | Definition |
|---|---|---|
| `qaFamilies.perPr[]` | array | One row for every merged PR in the window, sorted by `prNumber`. |
| `qaFamilies.perPr[].prNumber` | integer | Merged PR number. |
| `qaFamilies.perPr[].qaHead` | string or null | SHA from the latest QA verdict's first line (`on <sha>` or `at <sha>`, optionally `head` before the SHA). When absent, uses the PR's `headRefOid` or `head.sha`. Null without a verdict or a known judged head. |
| `qaFamilies.perPr[].reviewers` | array or `"none"` | Kept model reviews as `{family, model, sha, verdict}`. `"none"` means the PR had a QA verdict but no kept model review; `[]` means no QA verdict. |
| `qaFamilies.perPr[].builder` | string | Non-unknown `attributePullRequest` bot; otherwise the model named by PR-body `Built-by:` lines (`model=model:<x>` tokens, else a known model name; must be unanimous) or else the first `Model:` line; otherwise the lowercased pool token from a case-insensitive `Built on <pool>` line; otherwise `"unknown"`. |
| `qaFamilies.summary.qaJudged` | integer | Merged PRs with a QA verdict, including those without a known head. Equals `qa.pass + qa.fail`. |
| `qaFamilies.summary.reviewersNone` | integer | QA-judged PRs with no kept model review. |
| `qaFamilies.summary.prs` | integer | All merged PRs in the window. Equals `merges.total`. |
| `qaFamilies.summary.builderUnknown` | integer | Merged PRs whose builder remains `"unknown"`. |

An Architect model review must start with this first line (a full, lowercase
40-character hexadecimal SHA). The line may end with `: VERDICT` and/or
qualifiers such as `(round 2)`; the verdict is the uppercase word in that
suffix, or a later `VERDICT: <word>` line (which wins). Short SHAs, other
header shapes, and headers with no verdict are rejected:

```text
Architect review (<model>) @ <sha>[ qualifiers][: VERDICT]
```

The model is preserved in the row; the verdict is lowercased. Family mapping
ignores case: `opus` and `sonnet` map to `claude`; `codex`, `gpt`, and `gpt-*`
map to `openai`; `grok` maps to `xai`. `git`, `git delta`, and other model names
are not model reviews. Duplicate review tuples are collapsed and the array is
sorted by family, model, SHA, then verdict. Review comments must have a valid
timestamp before the window end; comments before the window start can count.

A review is kept only if its SHA equals `qaHead`, or comparison evidence proves
it is an ancestor with only comment or blank lines changed. Online comparisons
must have status `ahead` or `identical`. Every changed file must have a complete
text patch containing only changed comment/blank lines. Supported comment forms
are `//`, `#`, `--`, `/* ... */`, and `<!-- ... -->`; block context is tracked
separately on each patch side. Missing/binary/truncated patches, file renames,
and comparisons at GitHub's 300-file cap are rejected conservatively. Equal SHAs
need no comparison. Abbreviated QA SHAs are preserved as recorded; they are not
matched to full review SHAs by prefix. Offline ancestry comes exclusively from
`--commits-json`; absent entries are false.

### Reverts and rollbacks

Each merged PR is counted at most once, and the revert rules are checked first.

- **Revert:** the title starts with `Revert` (GitHub's `Revert "…"`), or the
  head branch matches `revert-<n>-…` (GitHub's revert button), or the PR has
  the label `revert`.
- **Rollback:** the title starts with `Rollback`, `Roll back` or `Roll-back`,
  optionally after a ticket prefix such as `OVD-123: `, or the PR has the
  label `rollback`. Titles that only mention the word, such as
  `Preserve rollback-unverified cause`, do not count.

Commits pushed straight to `main` without a PR, deploy rollbacks done outside
GitHub (Vercel, Cloud Run), and reverts done inside a larger PR are not
detected.

### Percentile method

Percentiles use linear interpolation between the closest ranks (Hyndman-Fan
type 7, the same as Excel `PERCENTILE.INC` and numpy's default). The values
are sorted ascending as `x[0..n-1]`. Then `h = (n - 1) * p`, and the result is
`x[floor(h)] + (h - floor(h)) * (x[floor(h)+1] - x[floor(h)])`. The median is
`p = 0.5` and p90 is `p = 0.9`. A single value is its own median and p90.
Results are rounded to 2 decimal places. Time to merge is measured from PR
creation, so time spent as a draft is included. PRs whose `merged_at` is
earlier than `created_at` are skipped.

### Live harness status vocabulary (G6)

`liveQuotes[].status` is the adapter `VendorStatus` the OVD-779 harness wrote
(`worker/src/types.ts`), or `null` when the adapter run failed. In that case
`errorCode` holds the failure code.

| Value | Meaning | Success |
|---|---|---|
| `instant_quote_received` | The provider returned an instant price. | yes |
| `official_quote_received` | The provider returned an official quote. | yes |
| `manual_review_pending` | The provider needs manual review before pricing. | no |
| `manual_vendor_followup` | An operator must follow up with the provider. | no |
| `queued`, `running` | Not finished (not expected in harness rows). | no |
| `failed`, `stale` | Provider-reported failure or expired result. | no |
| `null` | The adapter run threw an error; see `errorCode`. | no |

The script exports the success values as `HARNESS_SUCCESS_STATUSES`. A row can
be plotted only when its status is a success value and `totalPriceUsd` is
finite and greater than 0. Consumers apply this rule; the script does not
filter rows on it.

## Known gaps (G1 to G8)

| Gap | Status |
|---|---|
| G1: lead time and delivery date | **Partly resolved.** Since OVD-785 the harness writes an optional `leadTimeBusinessDays` to `results.jsonl`. This is the adapter-normalized first-offer value the harness already held on the smoke row. It is still `live-harness-run-artifacts.v1`, and older rows without the field read as null. The script passes it through. There is no delivery date: the only date-like adapter field, `shipReceiveBy`, is free text with no year (for example `Nov 6`) and is null for most adapters. So `estimatedDeliveryDate` is always null, with `deliveryUnavailableReason: "not_captured_by_harness_v1"`. It is never derived from `timestamp` or from lead time. The OVD-787 scatter X axis stays blocked until a provider-stated date is captured. |
| G2: weekly time-to-merge series | Resolved: `timeToMerge.perWeek`. |
| G3: weekly merge buckets | Resolved: `merges.perWeek`, weeks start Monday UTC, zero weeks included. |
| G4: `generatedAt` and `window` | Resolved: both come from inputs, never the wall clock. |
| G5: QA counts and unit | Resolved: `qa.pass`, `qa.fail`, `qa.noVerdict`, and `qa.unit = latest_verdict_per_merged_pr`. OVD-786 also resolves per-bot QA counts and pass rate with the same latest-verdict rule. |
| G6: harness status vocabulary | Documented above. Success values are `instant_quote_received` and `official_quote_received`. |
| G7: per-bot rollbacks and time to merge | Per-bot reverts and rollbacks resolved by OVD-786. Per-bot time to merge remains out of scope. |
| G8: `quoteUrl` and `providerQuoteId` | Resolved: never copied into the snapshot, and a test checks this. |

Other limits:

- `results.jsonl` stays on the operator's machine (OVD-779) and is deleted
  after 14 days. Live quotes only appear when the snapshot is generated on a
  machine that holds recent runs. The committed `snapshot-2026-10-15.json`
  was generated where none existed, so `liveQuotes` is `[]` and
  `sources.harnessResultFiles` is `0`.
- QA coverage is low: most merged PRs have no verdict comment, and
  `qa.noVerdict` makes that visible.
