<!-- DRAFT — NOT POSTED. Held: no review exists at this head; CI (test, browser-test, verify) still pending; Sonar gate failing; CodeRabbit rate-limited (no real review). Do not post until a passing review at the same head + CI/Sonar/CodeRabbit are settled, and re-pin the SHA right before posting. -->
QA: FAIL on dc145bfb09774bdb33e6993e1bd52e37f073d3d8
SonarCloud quality gate ERROR on this SHA: new_security_rating = B (needs A), from 2 open S4036 vulnerabilities ("PATH variable only contains fixed, unwriteable directories") at scripts/spend-ledger.mjs:41 (`execFileSync("git", …)`) and :102 (`execFileSync("gh", …)`). Hotspots 0; the other 11 new issues are code smells.
Behaviour ACs that this PR claims all re-ran green in a fresh worktree: 33/33 vitest, typecheck, full lint, and probes a–g (below). Linear OVD-923 AC2 (CI pass rate, interventions, Opus share), AC3 and AC4 are declared out of scope for this slice (body says "Partly"). AC1's #841/OVD-919 consumption is only an adapter boundary (no adapter yet).
CI run 39013914097: build, lint, typecheck and the SQL, extraction, egress and migration jobs pass; `test` and `browser-test` were pending at 00:41 MST. Run 39013914078 `verify (run journeys at head)` passes; proof-check run 39013914081 passes. Vercel failed on a rate limit (infra, not a product failure). CodeRabbit is "success" only because it was rate limited, so no review happened.
Proof re-run: `npx vitest run scripts/spend-ledger.test.mjs` (33/33) + `npm run typecheck` + `npm run lint` + `node 845-probes.mjs` + `npm run spend:ledger -- collect|weekly|export-evals` on fixtures, at dc145bfb09774bdb33e6993e1bd52e37f073d3d8 (worktree wt845, HEAD verified).

| AC (PR-claimed / Linear) | Result | Evidence at dc145bfb |
| --- | --- | --- |
| Collector from documented `token-watcher-usage.v1` input (AC1) | met | 15 validation tests; `collect` on fixtures gives 4 records (3 valued, 1 unvalued); re-running it is idempotent (same output) |
| Subscription usage valued at share × plan price, never free (AC2 part) | met | 0.25×$200 gives usd 50; (50+1.255)/2 gives $25.63; 0.07×$100 gives 7; overall 58.255/3 gives $19.42 |
| Unknown or missing spend never $0 | met | missing, null dollars and null share all give usd null / `unvalued`. Unknown pool, or a plan price that is missing or 0, is rejected. The markdown has no `$0.00`; the all-pools row shows `≥ … (partial)` and names the missing pools; an all-unvalued window gives totalUsd null / `unknown` |
| PR to pool attribution, unknown never guessed (AC1) | met for model:/pool: labels and the explicit map | conflicting or no signal gives `unknown`. #841 `trust-snapshot.v1` is rejected as `--attribution` (exit 2, "invalid PR number") because its botAttribution only holds aggregate counts. An absent attribution file is tolerated |
| Weekly $/merged PR per pool and overall, ISO week | met | spend-per-pr.v1 JSON/md on fixtures; no-merges, partial and low-sample flags present |
| #835-compatible export | met | the 3 exported lines pass #835 `loadLedger` @76c5c038 (ts, usd, pr, issue; agent and source are documented there, pool is ignored) |
| Read-only gh, argv array | met | a stub gh logged `pr list --repo … --state merged --base main --search merged:F..T --limit 1000 --json …`. A `--from` with metacharacters is rejected before gh is called; a `--repo` with metacharacters is passed as one argv element and not executed |
| No secrets read or printed | met | 0 process.env/TOKEN/API_KEY references. Secrets planted in gh stderr, the env and input files were not echoed; extra fields are whitelisted out |
| Real ledgers gitignored, fixtures synthetic | met | `git check-ignore` matches .gitignore:63. A default `collect` leaves git status clean. The fixtures all have source "synthetic" |
| `spend:ledger` script end-to-end | met | collect, weekly md+json and export-evals all exit 0 |
| Linear AC2 rest, AC3, AC4 | not in this PR | declared as follow-ups owned by Evaluator |

families: builder=unknown reviewers=none cross_family=false qa_catch_after_review=false
