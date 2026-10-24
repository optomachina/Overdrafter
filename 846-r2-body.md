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
- **Read**: `gh api repos/optomachina/Overdrafter/commits/<sha>/statuses?per_page=100`, parsed as JSON. A marker counts only if it is a `success` status from `optomachina` with a well-formed description and matching model, question hash and screener. If several match, the highest tier wins. Anything else is a miss, and the PR is screened again
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


## Verification

Commands run on the box at head `7b5da307`, Oct 17, 2026, about 3:21 AM MST (Node v20.19.2, vitest 3.2.4). Only the targeted files were run, not the full suite, because box memory is tight:

```bash
npx vitest run scripts/jev-pr-screen.test.mjs scripts/jev-client.test.mjs scripts/jev-agent-decisions-eval.test.mjs scripts/lib/sensitive-paths.test.mjs
npx eslint scripts/jev-pr-screen.mjs scripts/jev-pr-screen.test.mjs scripts/lib/jev-screen-marker.mjs
node scripts/validate-pr-body.mjs <body> --changed-files-from <files> --diff-from <diff> --base-ref origin/main --head-ref HEAD
```

Results:

- [x] vitest: 4 files, **133/133 tests passed** (`jev-pr-screen.test.mjs` 40, `jev-client.test.mjs` 38, `jev-agent-decisions-eval.test.mjs` 25, `lib/sensitive-paths.test.mjs` 30)
- [x] eslint: no findings
- [x] validate-pr-body: passed
- `node --test scripts/jev-pr-screen.test.mjs` does not apply: the file imports `vitest`. CI runs it through `npm test` (`vitest run`)

## Proof

Final head: `7b5da3078ac64b12287a97ed1cdf6dd61bcf13fd`. Times are America/Phoenix (MST), Oct 17, 2026.

**QA fixes in `7b5da307`** (QA at `097d9c0a` found two real causes):
- **AC2, re-screen on a new head SHA:** new test "screens again and writes a new marker when the PR head moves to a new SHA". A marker exists for the old SHA and the PR head moves to a new SHA. The screen calls Jev again and writes exactly one new marker, on the new SHA, and leaves the old SHA's marker untouched. The next screen at the new head is a cache hit. It uses the in-memory GitHub, with no real `gh` calls.
- **AC1 / fix item 3, row shape:** decision-log rows now carry:
  - `cache_hit` (bool) and `head_sha`, with `marker_hit` and `sha` kept as duplicate aliases.
  - `tokens`: `{ input_tokens, output_tokens }` from the Jev response's `usage`, or null on a cache hit or when there is no usage. Never estimated.

  New tests cover the exact row key set, the aliases, `tokens` on a miss, on a hit and with missing or unusable usage, and `replay()` reading either name. `docs/agent-log/README.md` describes the fields.

1. Local vitest at `7b5da307`: **Test Files 4 passed, Tests 133 passed**, including `jev-pr-screen.test.mjs` 40/40. eslint is clean (see Verification).
2. No test calls GitHub: `jev-pr-screen.test.mjs` (40/40) was run at `7b5da307` with a preload that logs every `child_process` call to a `gh` binary, loaded in all 11 vitest processes. It logged **zero** `gh` calls.
3. Hosted CI at `7b5da307`: all 23 checks passed, with no manual re-runs.
   - `ci`: success, 3:33 AM MST, https://github.com/optomachina/Overdrafter/actions/runs/39024588330/job/117375125041
   - `test`: success, 3:32 AM MST, https://github.com/optomachina/Overdrafter/actions/runs/39024588330/job/117373128662. The log shows `✓ scripts/jev-pr-screen.test.mjs (40 tests)` and Test Files 626 passed, 2 skipped
   - lint, typecheck, build, browser-test, verify, verify (run journeys at head), proof-check, provider-go-live, secret-scan and security-definer-lint also passed
4. SonarCloud at `7b5da307` (analysis of commit `7b5da307` at 3:21 AM MST; the SonarCloud Code Analysis check passed at 3:24 AM MST, https://github.com/optomachina/Overdrafter/runs/117373481582). Rechecked at 3:33 AM MST:
   - `https://sonarcloud.io/api/qualitygates/project_status?projectKey=optomachina_Overdrafter&pullRequest=846` → **`"status":"OK"`**: new_reliability_rating 1, new_security_rating 1, new_maintainability_rating 1, new_duplicated_lines_density 0.0, new_security_hotspots_reviewed 100.0
   - `https://sonarcloud.io/api/issues/search?componentKeys=optomachina_Overdrafter&pullRequest=846&resolved=false` → **`total: 0`**. Nothing was marked Safe or won't fix, and there is no NOSONAR
5. Marker I/O evidence from `98486ade`; `scripts/lib/jev-screen-marker.mjs` is unchanged since. The old `--jq` filter failed against real commit `45db32ac` (read-only): `expected an object but got: array`, exit 1. The fixed read returned `{"found":false,"reason":"no_marker"}` (not `api_error`), and `readPrHeadSha(846)` returned the real head SHA, both through `/usr/local/bin/gh` with the fixed PATH. No status was posted.

## Review findings and coverage

- Final PR head SHA: **`7b5da3078ac64b12287a97ed1cdf6dd61bcf13fd`** (6 commits; new commits only, no rebase or force-push)
- SonarCloud on `45db32ac`: quality gate failed (new_reliability_rating=4, new_security_rating=2). S4036 (×4), S2871, S6959, S3776, S3358 and S9382 (×2) are fixed in code. On `7b5da307` the gate is **OK** with 0 open issues (Proof 4)
- Architect pre-check at `4509dcc1` (must-fix list 1-7): all seven are addressed in `98486ade`. Architect's Codex review at `98486ade` was APPROVE. Its non-blocking notes 2 (warn on decision-log write failure) and 3 (forgery wording) are addressed in `097d9c0a` and in this body
- QA at `097d9c0a`: both causes (AC2 new-SHA re-screen test; AC1 `cache_hit`/`head_sha`/`tokens` row fields) are fixed in `7b5da307` (see Proof)
- Hosted CI on `7b5da307`: all checks passed (Proof 3). CodeRabbit skipped the review because the PR is a draft
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






