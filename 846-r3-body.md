<!-- CURSOR_AGENT_PR_BODY_BEGIN -->
## Linear issue ID

- Issue: OVD-934
- This one bounded change satisfies the named issue's source acceptance criteria. No post-merge criteria remain.
- This is the issue's main PR.
- Confirmed: OVD-934 is not a release-outcome parent.

## Summary

Use GitHub commit status markers to deduplicate Jev PR screens across all callers and hosts.

## Problem

Fixes OVD-934

**Root cause (per Architect's design review):** PR #743 was screened twice by `screen.py` (not the `.mjs`) on the box, 6 seconds apart (Oct 17 03:02:48Z and 03:02:54Z). The original PR #846 added a cache only to `scripts/jev-pr-screen.mjs`, which would not have prevented the duplicate since both calls went through `screen.py`. Additionally, a per-machine file cache cannot work across the box and Mac mini review paths.

**Solution:** Use GitHub commit status as a shared marker, visible to all callers on all hosts. The marker is keyed by `(full 40-hex SHA, screener_id, question_set_hash, model)`.


## Acceptance criteria addressed

- [x] Screening the same PR at the same head SHA twice reads the GitHub marker first and skips the Jev call on the second screen (test "screens once per head SHA")
- [x] Marker works across hosts: it is a commit status on the SHA, read with `gh api` from any host with optomachina auth
- [x] Tests cover a marker hit, a miss on a new model, a miss on a changed question set, and a hit that cannot lower the tier
- [x] Reading is fail-safe: re-screens on anything missing, malformed, mismatched, untrusted, or on an API error
- [x] Writing fails open: a write failure is warned about and never fails the screen
- [x] SHA validation: only 40-hex SHAs that equal the PR's current head SHA on GitHub read or write a marker
- [x] PR validation: PR <= 0 is logged as null and never touches a marker

## Files changed

- `scripts/lib/jev-screen-marker.mjs`: **NEW**. `readMarker()`, `writeMarker()`, `readPrHeadSha()`, `hashQuestions()`, and `GITHUB_MARKER_IO`
- `scripts/jev-pr-screen.mjs`: marker lookup with a head-SHA check, fail-safe read, fail-open write, injectable marker I/O, bounded worker pool
- `scripts/jev-pr-screen.test.mjs`: marker tests against an in-memory GitHub (no `gh` calls)
- `docs/sensitive-paths.json`, `AGENTS.md`, `scripts/lib/sensitive-paths.test.mjs`: `scripts/lib/jev-screen-marker*` is listed as infra_ci (Architect finding 3)
- `docs/agent-log/README.md`: documents the marker dedupe
- `.gitignore`, `docs/agent-log/jev-decisions.jsonl`: the log moves out of the repository (first commit)

## Scope

**Included:**
- GitHub commit status marker (context `jev-screen`, state `success`) as the shared dedupe mechanism
- Key: `(full 40-hex SHA, screener_id, question_set_hash, model)`. The question-set hash covers every nested field (canonical JSON with keys sorted at every level)
- A marker is used only when `pr` is a real PR number and `sha` equals that PR's current head SHA (`gh api repos/optomachina/Overdrafter/pulls/<n> --jq .head.sha`)
- Only accepted (confident) Jev answers are written, with their confidence and incident probability
- On a hit the stored answer is replayed at its stored confidence, and the final tier is max(local path tier, Jev tier, marker tier)
- `gh` resolved once from `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin` (never PATH) and run with that fixed PATH
- Injectable marker I/O: `screen(prs, { marker: { read, write, headSha } })`
- CLI `--caller` flag; log fields `latency_ms` (null on hits), `marker_hit`, `marker_tier`, `caller`, `screener`

**Not included:**
- A pending claim. It was removed: overlapping screens both call Jev, which costs at most one extra call
- Retiring `screen.py` on the box and Mac mini (see Follow-up below)
- A local file cache

## Design: GitHub commit status marker

- **Context**: `jev-screen`, state `success` only
- **Description**: `v1 tier=<final> jev=<jev tier> c=<confidence> p=<incident|na> model=<model> q=<hash> screener=mjs` (at most 140 characters). Confidence is rounded down and incident probability up, so a replay is never more lenient
- **Read**: `gh api repos/optomachina/Overdrafter/commits/<sha>/statuses?per_page=100&page=N` for N = 1, 2, ... until a page has fewer than 100 statuses, parsed as JSON. More than 50 pages, an oversized page, or any failing page is a miss. A marker counts only if it is a `success` status from `optomachina` whose description has each field exactly once and nothing else (8-hex `q`, `c` and `p` in 0..1 with at most 3 decimals, known tiers) and whose model, question hash and screener match. If several match, the highest tier wins, then the newest. Anything else is a miss, and the PR is screened again
- **Write**: after an accepted Jev answer at the PR's head SHA. A failure is a warning
- **Hit**: no Jev call; `latency_ms` is null, and the record keeps the stored confidence and `marker_tier`

## Follow-up: retire screen.py

Per Architect's design review, both #743 duplicate screens came from `screen.py`, not the repo `.mjs`. This PR makes `scripts/jev-pr-screen.mjs` the canonical screener with marker support.

### Concrete retirement steps

**On the box** (paths from design review):
1. **Locate the three `screen.py` copies:**
   - `/workspace/jev-pr-screen/screen.py` (md5 d9851c98…)
   - `/workspace/claude-jobs-staging/screen.py` (md5 394a69cc…)
   - Determine which is actively used by review routines
   
2. **Update review routine callers:**
   - Identify which agent(s) or routines invoke `screen.py` (design review couldn't determine from box artifacts; needs server-side Temporal history or agent store query)
   - Repoint those invocations to: `NODE_USE_ENV_PROXY=1 node /workspace/scripts/jev-pr-screen.mjs --base-ref origin/main --caller <routine-name> <input.json>`
   - Test with one PR before full cutover

3. **Verify Engineer's pre-PR screen:**
   - Engineer profile (`/home/box/agent-data/agents/616e1921-5c4d-498f-be69-5ad7dd76fc13/profile.json`) states it uses `scripts/jev-pr-screen.mjs`, but #743 evidence shows it called `screen.py`
   - Reconcile the profile vs. actual behavior
   - Ensure consistent use of repo `.mjs`

4. **After cutover:**
   - Archive or remove the three `screen.py` copies
   - Document the migration in `docs/agent-log/README.md`

**On the Mac mini** (from design review):
1. **Current path:** `~/work/claude-jobs/run.sh:14` runs:
   ```bash
   [ -n "$PACKET_PR" ] && python3 ~/work/claude-jobs/packet.py "$PACKET_PR" ...
   ```
   
2. **`packet.py` invocation:** Line 106-107:
   ```python
   import screen
   return screen.screen(pr_obj, use_jev=...)
   ```

3. **Retirement options:**
   
   **Option A: Repoint packet.py to call the repo .mjs**
   - Update `packet.py` lines 106-107 to shell out to the repo screener:
     ```python
     import subprocess, json, tempfile
     with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
         json.dump([pr_obj], f)
         input_path = f.name
     result = subprocess.run(
         ['node', '/workspace/scripts/jev-pr-screen.mjs', '--base-ref', 'origin/main', '--caller', 'mini-packet', input_path],
         capture_output=True, text=True, env={**os.environ, 'NODE_USE_ENV_PROXY': '1'}
     )
     # Parse result from JSONL log or stdout
     ```
   - Preserve existing `packet.py` error handling and result format
   
   **Option B: Retire the mini review path entirely**
   - If the box review path has fully replaced it (design review noted mini log has no Oct 17 rows, last activity Oct 16)
   - Disable `run.sh`'s packet invocation
   - Document the retirement
   
   **Mac-local changes not made in this PR** per instructions. Document the above for the person with mini access.

4. **After cutover:**
   - Remove or archive `~/work/claude-jobs/screen.py` (md5 c465731a…)
   - Logs will continue writing to `~/work/claude-jobs/jev-decisions.jsonl` (now shared schema)

### Marker `screener=mjs` field
Until `screen.py` is fully retired, both screeners may run. The marker key includes `screener=mjs`, so `screen.py` screens (if they ever adopt the marker protocol) won't reuse `.mjs` markers and vice versa. This prevents cross-contamination during the transition.


## Architect fixes (CHANGES_REQUIRED at `7b5da307`)

Fixed in `9bd44c60`, then `origin/main` (`953666ce`) merged in as `8bab4a7c` (a merge commit, no conflicts):
1. **[high] Truncated status list:** `readMarker` now pages through every commit status and picks the strongest valid marker (highest tier, then the newest). A failing, oversized or endless page list is a miss. Tests: a risky marker on page 2 (the Architect's repro), on page 3 of 250, exactly 100 statuses (reads the empty page 2), a failing later page, and `screen()` scoring risky with no Jev call when the risky marker is on page 2.
2. **[medium] Duplicate or malformed fields:** a duplicate key (including the Architect's `tier=low jev=low` append), an unknown key, a bare or `a=b=c` token, a `q` that is not 8 lowercase hex, a non-numeric or out-of-range `c`/`p`, an unknown tier, a wrong version, a missing field or an over-long description rejects the whole marker, which is a miss. A status whose `url` names another commit is ignored, and a bad SHA argument is `invalid_sha` with no call. `writeMarker` refuses a question hash the reader would reject.
3. **[low] Sensitive path:** `scripts/lib/jev-screen-marker*` is infra_ci in `docs/sensitive-paths.json` and the AGENTS.md mirror; `sensitive-paths.test.mjs` pins it in the control-glob list and classifies `scripts/lib/jev-screen-marker.mjs` as infra_ci.

## Verification

Commands run on the box in a fresh worktree at the final head `8bab4a7c` (after the merge of `origin/main`), Oct 17, 2026, about 9:22 AM MST (Node v20.19.2, vitest 3.2.4). Only the targeted files were run, not the full suite, to keep memory use modest:

```bash
GH_DEBUG=api npx vitest run scripts/jev-pr-screen.test.mjs scripts/jev-client.test.mjs scripts/jev-agent-decisions-eval.test.mjs scripts/lib/sensitive-paths.test.mjs scripts/validate-pr-body.test.mjs
npx eslint scripts/lib/jev-screen-marker.mjs scripts/jev-pr-screen.test.mjs scripts/lib/sensitive-paths.test.mjs scripts/jev-pr-screen.mjs
node scripts/validate-agent-contract.mjs
node --test scripts/validate-agent-contract.node-test.mjs
node scripts/validate-pr-body.mjs <body> --changed-files-from <files> --diff-from <diff> --base-ref origin/main --head-ref HEAD
```

Results:

- [x] vitest: 5 files, **198/198 tests passed** (`jev-pr-screen.test.mjs` 47, `jev-client.test.mjs` 38, `jev-agent-decisions-eval.test.mjs` 25, `lib/sensitive-paths.test.mjs` 30, `validate-pr-body.test.mjs` 58)
- [x] No real `gh` request: the run had `GH_DEBUG=api`, which makes `gh` print every request it sends; the output contains **0** `Request to` lines. The test file also removes `gh` credentials and points `GH_HOST` at `gh-guard.invalid`, so a stray `gh` could not reach GitHub
- [x] eslint: no findings
- [x] agent-contract: valid; `validate-agent-contract.node-test.mjs`: 3 passed, 0 failed
- [x] validate-pr-body: passed

## Proof

Final head: `8bab4a7cc81233eb563efe36ae3de43d5ff73876`. Times are America/Phoenix (MST), Oct 17, 2026.

1. Local vitest at `8bab4a7c`: **Test Files 5 passed, Tests 198 passed**, including `jev-pr-screen.test.mjs` 47/47 (40 before, plus 7 for the Architect fixes). eslint is clean (see Verification).
2. No test calls GitHub: the same run had `GH_DEBUG=api` set, so any `gh` request would have been printed; there were **0**. All marker reads and writes go through the in-memory GitHub (`run` and `marker` seams).
3. Hosted CI at `8bab4a7c`: all 23 checks passed on the first attempt, with no manual re-runs.
   - `ci`: success, 9:38 AM MST, https://github.com/optomachina/Overdrafter/actions/runs/39049150329/job/117447240848
   - `test`: success, 9:38 AM MST, https://github.com/optomachina/Overdrafter/actions/runs/39049150329/job/117444242475. The log shows `✓ scripts/jev-pr-screen.test.mjs (47 tests)` and Test Files 626 passed, 2 skipped
   - lint, typecheck, build, browser-test, verify, verify (run journeys at head), verify-worker, proof-check, provider-go-live, secret-scan, security-definer-lint, rls-deny-coverage and migration-immutability also passed
4. SonarCloud analyzed commit `8bab4a7c` at 9:22 AM MST (SonarCloud check: https://github.com/optomachina/Overdrafter/runs/117444452320):
   - `https://sonarcloud.io/api/qualitygates/project_status?projectKey=optomachina_Overdrafter&pullRequest=846` → **`"status":"OK"`**: new_reliability_rating 1, new_security_rating 1, new_maintainability_rating 1, new_duplicated_lines_density 0.0, new_security_hotspots_reviewed 100.0
   - `https://sonarcloud.io/api/issues/search?componentKeys=optomachina_Overdrafter&pullRequest=846&resolved=false` → **`total: 0`**. Nothing was marked Safe or won't fix, and there is no NOSONAR
5. Earlier marker I/O evidence from `98486ade` (read-only): the fixed read against real commit `45db32ac` returned `{"found":false,"reason":"no_marker"}`, and `readPrHeadSha(846)` returned the real head SHA, both through `/usr/local/bin/gh` with the fixed PATH. The read URL now adds `&page=N`; it was not re-run live for this round.

## Review findings and coverage

- Final PR head SHA: **`8bab4a7cc81233eb563efe36ae3de43d5ff73876`** (new commits and a merge of `origin/main` only; no rebase, amend or force-push)
- SonarCloud on `45db32ac`: quality gate failed (new_reliability_rating=4, new_security_rating=2). S4036 (×4), S2871, S6959, S3776, S3358 and S9382 (×2) are fixed in code. The gate was **OK** with 0 open issues on `7b5da307` and is OK on the final head `8bab4a7c` (Proof 4)
- Architect pre-check at `4509dcc1` (must-fix list 1-7): all seven are addressed in `98486ade`. Architect's Codex review at `98486ade` was APPROVE. Its non-blocking notes 2 (warn on decision-log write failure) and 3 (forgery wording) are addressed in `097d9c0a` and in this body
- QA at `097d9c0a`: both causes (AC2 new-SHA re-screen test; AC1 `cache_hit`/`head_sha`/`tokens` row fields) are fixed in `7b5da307` (tests listed under Tests)
- Architect's Codex review at `7b5da307`: CHANGES_REQUIRED (findings 1 high, 2 medium, 3 low). All three are fixed in `9bd44c60` (see Architect fixes)
- Hosted CI on `8bab4a7c`: all checks passed (Proof 3). SonarCloud gate OK with 0 open issues (Proof 4). CodeRabbit skipped the review because the PR is a draft
- [ ] Inspected findings and threads on the final head; actionable current-change findings are resolved or have evidence-backed dispositions.

## Tests

Rewritten or added in `scripts/jev-pr-screen.test.mjs` (the marker tests use an in-memory GitHub through the `run` and `marker` seams):
- Hashing covers nested fields and is independent of key order (the old hash was always `0801abcf`)
- Marker description build and parse, including rejection of bad tiers and probabilities
- `gh` resolution from the trusted directories only
- `readMarker`: trusted hit; ignores untrusted creators, pending, other contexts, other model, question hash or screener, and garbage; highest tier wins; misses on API error and bad JSON; reads raw JSON with no `--jq`
- `writeMarker`: posts `state=success` and fails open; rejects invalid input
- `readPrHeadSha`
- `screen()`: second screen at the same head is a hit with no Jev call, stored confidence replayed (not 1.0); model change misses; question change misses; a hit never lowers the tier (marker tier floor, local path tier, stricter confidence floor, unknown tier counts as risky); uncertain and failed answers write no marker; a failed write keeps the result; a SHA that is not the PR head, an unknown head, PR 0 or a short SHA never use a marker; a throwing reader is a miss
- `mapBounded` concurrency limit and order
- New-head re-screen: a marker on the old SHA, the head moves, Jev is called again and one new marker lands on the new SHA
- Row shape: `cache_hit`, `head_sha`, `tokens` (from Jev `usage`, null on a hit or without usage), the `marker_hit`/`sha` aliases, and `replay()` reading either name
- Pagination: every page is read (risky marker on page 2 and on page 3 of 250; exactly 100 statuses reads page 2; failing, oversized and endless pages miss); `screen()` stays risky with no Jev call when the risky marker is on page 2; on a tier tie the newest marker wins
- Strict parsing: duplicate keys (including an appended `tier=low jev=low`), bad `q` format, non-numeric or out-of-range `c` and `p`, unknown tiers, wrong version, missing fields and extra junk are rejected, and a rejected marker is a miss in `readMarker` and in `screen()`; a bad SHA and a status for another commit are rejected
- Removed: the 45db32ac "model change" test, which made live `gh` calls and did not change the model

## Migration notes

- [x] No migration impact

**Log location:** `~/work/claude-jobs/jev-decisions.jsonl`, outside the repository.

**Schema changes:** adds `head_sha`, `cache_hit`, `tokens`, `latency_ms` (was `latencyMs`), `marker_tier`, `caller` (null if not set) and `screener`. `sha` and `marker_hit` are kept as duplicate aliases of `head_sha` and `cache_hit`. `replay()` still reads old rows, accepts either name, and for a cache-hit row it keeps the marker tier as a floor.

## Rollback / risk notes

**What could go wrong:**
- GitHub API rate limits or timeouts: the read is a miss and the PR is screened again
- Anyone holding optomachina's gh token can post a low `jev-screen` marker that skips a fresh Jev call. That can suppress a Jev raise, but the tier never goes below the path tier
- A green `jev-screen` status can be misread as "Jev passed"; any future "all checks green" helper should exclude `jev-screen`

**Rollback:** revert the PR's commits. Old statuses stay on GitHub, are non-required and harmless, and the screener goes back to calling Jev every time.

## Documentation

- [x] Docs updated

Updated `docs/agent-log/README.md` to document:
- Marker-based dedupe via GitHub commit status
- Key components (SHA, screener, questions, model)
- Fail-safe read, fail-open write semantics
- New log fields: `latency_ms` (null on hits), `marker_hit`, `caller`, `screener`

## Follow-up items

Per "Follow-up: retire screen.py" section above, coordinate with box/mini admins to:
- [ ] Identify and repoint box review routine(s) that invoke `screen.py`
- [ ] Verify Engineer's pre-PR screen consistently uses repo `.mjs`
- [ ] Update Mac mini's `packet.py` to call repo `.mjs`, or retire the mini review path
- [ ] Remove/archive the three `screen.py` copies after cutover
- [ ] Document the retirement in `docs/agent-log/README.md`

- [ ] Exclude `jev-screen` from the OVD-845 verifier's `readiness.checks` and any "all checks green" helper

---

Built-by: Jev

**Note:** This PR edits `scripts/jev-pr-screen*`, which is a sensitive path in the `infra_ci` class. Per AGENTS.md, this requires Opus review and Blaine's approval card before merge.
<!-- CURSOR_AGENT_PR_BODY_END -->

<div><a href="https://cursor.com/agents/bc-93cd2358-04de-5959-9bfa-db789724ffeb?cursor_ref=pr_footer&cursor_cta=open_in_web"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/open-in-web-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/open-in-web-light.png"><img alt="Open in Web" width="114" height="28" src="https://cursor.com/assets/images/open-in-web-dark.png"></picture></a>&nbsp;<a href="https://cursor.com/background-agent?bcId=bc-93cd2358-04de-5959-9bfa-db789724ffeb&cursor_ref=pr_footer&cursor_cta=open_in_cursor"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/open-in-cursor-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/open-in-cursor-light.png"><img alt="Open in Cursor" width="131" height="28" src="https://cursor.com/assets/images/open-in-cursor-dark.png"></picture></a>&nbsp;</div>







