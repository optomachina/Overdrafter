## Linear issue ID

- Issue: OVD-785 (OVD-780A), child of OVD-780.
- This change meets OVD-785's acceptance criteria: the script, the schema v1 snapshot, the metric docs, fixture tests for each metric and a determinism test. Still open, and owned by other issues: OVD-786 adds per-bot attribution (`bots` is `[]` here), and G1 delivery date (see below).
- This is the main PR for OVD-785. OVD-785 is not a release-outcome parent.

## Summary

Adds `scripts/trust-metrics.mjs` (`npm run trust:metrics`). It reads merged PRs, labels, reverts and QA verdict comments through read-only `gh api` calls, plus any OVD-779 harness `results.jsonl` files. It writes a deterministic `docs/trust/snapshot-<date>.json` (`schemaVersion: "trust-snapshot.v1"`). The first snapshot (`snapshot-2026-10-15.json`, window 2026-08-24 to 2026-10-15) is committed, and every field is defined in `docs/trust-metrics.md`. The schema follows the field names the OVD-787 dashboard spec proposed.

## Problem

The trust dashboard (OVD-780 and OVD-787) needs versioned, reproducible metrics it can render without making any DB or API calls.

## Acceptance criteria addressed

- [x] The script reads GitHub PRs, labels, reverts and QA verdicts, plus harness results.jsonl, and writes `docs/trust/snapshot-<date>.json` (schema v1).
- [x] Metrics covered: merges per week, QA pass/fail, reverts and rollbacks, median and p90 time to merge, and live quote rows (provider, qty, price, lead time).
- [x] Every metric is defined in `docs/trust-metrics.md`.
- [x] Fixture unit tests for each metric, plus a determinism test (shuffled inputs give identical JSON, and two CLI runs write byte-identical files).

## Snapshot schema (trust-snapshot.v1)

`schemaVersion`, `generatedAt` (comes from `--generated-at` or `<window.end>T23:59:59Z`, never the wall clock), `window{start,end}`, `sources{repository,baseBranch,harnessResultFiles}`, `merges{total,perWeek[{weekStart,count}]}` (weeks start Monday UTC), `qa{pass,fail,noVerdict,unit}` (unit is `latest_verdict_per_merged_pr`), `reverts{reverts,rollbacks}`, `timeToMerge{medianHours,p90Hours,perWeek[{weekStart,medianHours,p90Hours}]}`, `liveQuotes[{runId,provider,requestedQuantity,totalPriceUsd,leadTimeBusinessDays,estimatedDeliveryDate,deliveryUnavailableReason,status,timestamp,errorCode}]`, `bots[]` (filled in by OVD-786). `quoteUrl` and `providerQuoteId` are never emitted.

## G1: lead time and delivery date

- The harness already had the adapter's first-offer `leadTimeBusinessDays` when it writes results. `results.jsonl` now records it as an optional field, still under `live-harness-run-artifacts.v1`. Older rows that lack it read as null. The script passes it through.
- No provider-stated delivery date is captured. The only date-like adapter field, `shipReceiveBy`, is free text with no year and is null for most adapters. So `estimatedDeliveryDate` is always `null`, with `deliveryUnavailableReason: "not_captured_by_harness_v1"`. It is never derived from `timestamp` or lead time.

## Files changed

- `scripts/trust-metrics.mjs`, `scripts/trust-metrics.test.mjs`, `scripts/fixtures/trust-metrics/*`
- `docs/trust/snapshot-2026-10-15.json`, `docs/trust-metrics.md`
- `package.json` (adds `trust:metrics`)
- `worker/src/tools/liveHarnessArtifacts.ts` and its test, `worker/src/tools/vendorWorkflowSmoke.ts` (the optional lead time field)

## Scope

Included: the script, the snapshot, the docs, and the optional harness lead time field. Not included: the dashboard UI (OVD-787), per-bot attribution (OVD-786), and capturing a provider-stated delivery date. No Supabase, SQL, migration or prod changes.

## Verification

```bash
npm run preflight
npx vitest run --maxWorkers=2 scripts/trust-metrics.test.mjs
cd worker && npx vitest run --maxWorkers=2 src/tools/liveHarnessArtifacts.test.ts
```

Results:

- [x] lint PASS, typecheck PASS. Tests: 11312 passed, 3 failed. All 3 failures are in `scripts/qualify-ovd417-four-migration-suffix.test.mjs`, which only runs under Docker; this is a known baseline failure.
- [x] unrelated baseline failures are described above

## Proof

Test: scripts/trust-metrics.test.mjs
Test: worker/src/tools/liveHarnessArtifacts.test.ts
Command: npx vitest run --maxWorkers=2 scripts/trust-metrics.test.mjs
```text
Test Files  1 passed (1)
     Tests  23 passed (23)
```
Command: cd worker && npx vitest run --maxWorkers=2 src/tools/liveHarnessArtifacts.test.ts
```text
Test Files  1 passed (1)
     Tests  19 passed (19)
```
Command: node scripts/trust-metrics.mjs --window-end 2026-10-15 --prs-json scripts/fixtures/trust-metrics/prs.json --comments-json scripts/fixtures/trust-metrics/comments.json --results-jsonl scripts/fixtures/trust-metrics/results.jsonl --stdout | sha256sum   (run twice)
```text
0ca86a626e357082351bdb0269ad8661cfbb845b2357388bb8f3acc5cddc99ad  -
0ca86a626e357082351bdb0269ad8661cfbb845b2357388bb8f3acc5cddc99ad  -
```

## Review findings and coverage

- Final PR head SHA: fd02be03db754e1d86c5ef0a218276730a382fab
- Sonar issue findings: pending on this head.
- CodeRabbit: pending on this head.
- Codex and other reviewers: pending on this head.
- [ ] Inspected findings and threads on the final head.

## Tests

- New: `scripts/trust-metrics.test.mjs` has 23 tests. Each metric gets at least one; the rest cover determinism, quote URL stripping, and confirming that offline runs make no network calls.
- Updated: `liveHarnessArtifacts.test.ts` covers the optional `leadTimeBusinessDays` field, including null and invalid values.


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added a command-line tool to generate consistent trust-metrics snapshots, including weekly merge counts, QA verdicts, reverts and rollbacks, merge times, and quote results.
  * Snapshots now capture quote lead times when available.
* **Documentation**
  * Added guidance on snapshot options, metrics, data sources, and known coverage limits.
* **Bug Fixes**
  * Invalid or missing quote lead times are recorded as unavailable.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->