# Owner prompts and instructions (2026-10-08)

Five items only you can do, in the order that shortens the path to the phone-to-STEP finish line. Each has either a copy-paste prompt for a Claude session or click-by-click steps. Everything that touches production is read-only here; the apply itself stays a separate, later step.

Rule for every prompt you paste into a coding session: the PR or commit text must never contain the release-parent identifiers (OVD-520, OVD-527, OVD-319, OVD-419, OVD-199, OVD-359, OVD-332, OVD-385). A bare mention auto-closes the parent in Linear. Lowercase file tokens such as `ovd419-...` are fine.

---

## 1. Production ledger query (read-only, about 5 minutes)

Where: Supabase dashboard for the production project, SQL editor, or `psql` against the production URL. Read-only; nothing here writes.

Run these three statements and paste all output back to me verbatim (row counts matter).

```sql
-- A. Migration ledger state (decides which packet applies)
select count(*) as rows, max(version) as max_version,
       md5(string_agg(version, ',' order by version)) as fingerprint
from supabase_migrations.schema_migrations;

-- B. Which of migrations 127-139 are already present (expected: none)
select version from supabase_migrations.schema_migrations
where version in ('20261002041305','20261002053133','20261002090339','20261002133713',
  '20261002182714','20261002182910','20261003011148','20261003150000','20261003160000',
  '20261003170000','20261004100000','20261004110000','20261004130000')
order by version;

-- C. Archive-capable roles vs the audit writer (expected: function_owner = postgres and exactly postgres, service_role, supabase_admin)
select r.rolname, r.rolsuper, r.rolbypassrls,
  pg_get_userbyid(p.proowner) as function_owner,
  p.proacl::text as current_acl,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') as executes_now
from pg_roles r
cross join pg_proc p
where p.oid = 'public.log_audit_event(uuid,text,jsonb,uuid,uuid)'::regprocedure
  and (r.rolsuper or r.rolbypassrls
       or r.oid = (select relowner from pg_class where oid = 'public.jobs'::regclass))
  and has_table_privilege(r.oid, 'public.jobs', 'DELETE')
order by r.rolname;

-- D. Callers of the audit writer (expected: 36 rows, prosecdef = t, every owner postgres, owner_can_execute = true)
select p.oid::regprocedure as caller, p.prosecdef,
  pg_get_userbyid(p.proowner) as caller_owner,
  has_function_privilege(p.proowner,
    'public.log_audit_event(uuid,text,jsonb,uuid,uuid)'::regprocedure, 'EXECUTE') as owner_can_execute
from pg_proc p
where p.prosrc ~* '(^|[^a-z_])log_audit_event\s*\('
  and p.proname <> 'log_audit_event'
order by 1;
```

What the answer decides:
- A ends at `20261003011148` (133 rows or the equivalent) and B is empty: packet v2 (migrations 134-139) applies as written. I start the OVD-635 prep lane immediately.
- A ends earlier (the 2026-10-03 handoff said about 112 rows): 127-133 are missing too and must go through the qualified database release path first. I rewrite the packet before anything else.
- C or D shows an unexpected role or a `prosecdef = f` caller: stop. Migration 134's guard would abort on it. I review it before any apply.

Paste as a reply here. Do not run anything from section 4 of the packet.

---

## 2. SonarCloud gate on #564 (about 10 minutes, UI only)

The gate is red on exactly two conditions: new reliability rating and new security rating. Those are driven only by the 24 bugs and 24 vulnerabilities. The 1,379 code smells do not affect the gate and can stay as they are.

Steps:
1. Open https://sonarcloud.io/project/issues?id=optomachina_Overdrafter&pullRequest=564&issueStatuses=OPEN,CONFIRMED&sinceLeakPeriod=true
2. Filter Type = Bug. Select all (48 total across both types; the page shows up to 100). Bulk Change, then "Resolve as False Positive" with the comment below. Repeat with Type = Vulnerability, except the 20 `javascript:S4036` (PATH lookup in CI runners): resolve those as "Accept".
3. Reload the PR dashboard; the gate should flip to Passed. Tell me when it does and I re-read the gate through the API and refresh the #564 body.

Comment to paste into the bulk change (one per group is fine):

- S2871 (17): default sorts of string identifier arrays; code-unit order is deterministic and locale-independent, which the canonical hashing and comparisons need.
- S6544 (2): `if (this.pendingGate)` checks whether a held Promise exists; it does not test the Promise value.
- S4822 (2): the try guards a synchronous `cancel()` throw on a locked or errored stream; `.catch` covers only the async rejection.
- S905 (3): docs/qa files are bare `async (page) => {}` expressions for Playwright `run-code`; documentation, not shipped code.
- S8705 (2): `container` is validated against `/^ovd591-[a-z0-9-]+$/` before `execFileSync` with no shell; CI-only runners.
- S5443 (2): one passes the caller's TMPDIR through to a child env; the other is a literal socket path in a negative test asserting the offline tripwire throws.
- S4036 (20, Accept): CI and local qualification runners that use the runner's PATH; no production path runs them.

Full file:line list is in the #564 body, section "Sonar at f9348a2", group (b), and matches what the API returns today.

---

## 3. CodeRabbit decision for #564 (one line from you)

CodeRabbit skips #564 at 418 files (100-file plan limit). Three options; my recommendation is the first.

- "Accept per-PR evidence": every change on the branch was reviewed by CodeRabbit in its own PR (#566, #571, #568, #572, #573, #574, #597, #603), so an integration review would re-read the same diff. I record the decision in the #564 body and the merge waits only on the database readback.
- "Split": I open review-only PRs of at most 100 files each against the integration branch, request CodeRabbit on each, and close them after. Costs about 5 CodeRabbit hours at the free rate.
- "Raise the plan": a purchase; not something I can do.

Reply with one of the three phrases.

---

## 4. X1 test-runtime on the workstation (about 5 minutes of your attention)

Session: `workstation-fizzy-candle` (session_01Arrb2Hh45KQcEPJXM26MBy). It ran 10 of 11 inert suites at 91bfa3c with zero native calls; `worker-companion test-runtime` was skipped because the workstation permission check denied it twice. My message to that session was itself denied, so it needs you to paste this there and approve the one permission prompt it raises:

```
Run the one remaining X1 inert suite, worker-companion test-runtime, at the exact source commit 91bfa3c4bdb46d9efd16adc1a36140ea092dcc68 using the same detached worktree and runner you used on 2026-10-05 ($root2 = C:\Users\blain\AppData\Local\Temp\ovd520-x1-91bfa3c-202610051206, run-x1.ps1, VS2022 Roslyn csc, runtime-profile.json SHA-256 0955b4466bcb5d14cf625f48ff09169bdeb1589bae6aa1d474b2bdeaa85da06a). Constraints unchanged: inert only, zero native calls, do not touch the two retained SLDWORKS.exe processes or any open SolidWorks document, no other checkout. I approve the permission prompt for this suite. Write the wrapper receipt beside the others under $root2\receipts, update summary.json and manifest.sha256, and report: exit code, duration, pass/fail, receipt SHA-256, nativeCalls, SLDWORKS before/after, and the new summary.json SHA-256. Do nothing else.
```

If the activation commit changes because of the #565 decision, the whole X1 run repeats; otherwise this closes section B of the readiness packet.

---

## 5. OVD-630 and OVD-636 from your local session

Both are test-flake fixes whose cloud launches were classifier-denied. Run each as its own local Claude Code session in your clone (not the cloud). Open a draft PR; I verify (red-first evidence, mutation, two clean rounds, CodeRabbit) and merge.

### OVD-630 prompt (base main)

```
Branch claude/ovd630-client-shell-tablet-fixture from origin/main. Linear OVD-630. e2e/client-shell.spec.ts fails intermittently in the hosted browser-test fixture lane and passes on re-run, on PRs touching no src/ or e2e/ file: :187 "keeps the part evidence and quote comparison in a stable tablet hierarchy @fixture" times out at line 193 waiting for getByRole('button', { name: /^(US-only sourcing|All sourcing)$/ }) within 5000 ms (run 37375862187); :256 (tablet/desktop CAD-preview checks) and :162 "uses one desktop workspace without a detached inspector" (times out at line 167 waiting for [data-workspace-scroll="primary"] to be visible; run 37523123939, job 112473295369) fail the same way. Treat all three together: the race is in the client shell's first render in the fixture lane, not the tablet layout alone.

Red first: reproduce at least one 5 s timeout on the unmodified spec under load (nice/taskset CPU constraint or a SIGSTOP/SIGCONT stall harness around the Playwright worker: freeze the process group 150-300 ms every 350-500 ms); record command and output. Identify which render or data dependency the toggle and the primary scroll container wait on (viewport change, lazy sourcing toggle, mock-backed quote comparison render). Make the spec deterministic by waiting on that state or a stable readiness marker. Do not widen timeouts blindly; keep assertion strength; no test.fixme or skip. If the component itself has a first-render race, fix it in the smallest bounded change and cover it.

Green: npx playwright test e2e/client-shell.spec.ts --repeat-each=10 passes under the same load; a mutation that removes the readiness wait fails again (record it). Then npm run lint, npm run typecheck, npm run verify.

Open a DRAFT PR on main titled "OVD-630: stabilize the client-shell fixture first render" with the repository PR template: root cause, red-first evidence with commands, green evidence, mutation, hosted run ids once CI finishes. Do not write the release-parent identifiers (OVD-520, OVD-527, OVD-319, OVD-419, OVD-199, OVD-359, OVD-332, OVD-385) anywhere. Push and stop; the coordinator verifies and merges.
```

### OVD-636 prompt (base: the release integration branch)

```
Branch claude/ovd636-browser-recovery-test-robustness from origin/codex/recovered-release-free-safety-20261003 (the #564 integration branch; worker/src/recovery/browserRecovery.test.ts exists only there). Linear OVD-636, child of OVD-633. Install worker dependencies from that branch's lockfile.

Hosted failures under full-suite load: "applies only the declared value and stops after two actions" timed out at 5000 ms; "selects an existing option without sending option values" expected true, received false; earlier PR bodies (#568, #571, #592) record the same file timing out. Hypothesis to confirm by reproduction: the "bounded recovery with observed Chromium DOM" tests use the default 5 s per-test timeout while each runs real-Chromium recovery attempts; worker/src/recovery/browserRecovery.ts enforces a production 5 s attempt deadline and 1 s fill/select/inputValue timeouts, so under load the attempt is cancelled by its own deadline and returns false.

Red first: reproduce at least one failure under load with a SIGSTOP/SIGCONT stall harness (freeze the vitest process group 150-300 ms every 350-500 ms) or an injected event-loop stall; record command and output. chromiumSandbox is true in this file: keep it; run as your normal non-root user.

Fix the TESTS: await observable state instead of fixed timers, raise per-test timeouts only on the real-browser paths, serialize the real-browser files if they contend for the runner. Only if required, add an injectable clock/deadline seam to browserRecovery.ts that defaults to the production values, with a test proving the defaults are unchanged. Never skip, quarantine or weaken the DOM-redaction and bounded-action assertions; never raise the production deadline. Copy the evidence pattern of PR #599 (worker/src/adapters/xometry.test.ts, deferred-based sequencing).

Green: 20 consecutive passes of npx vitest run worker/src/recovery/browserRecovery.test.ts under the same load; mutations: reintroduce the fixed timer -> fails; drop the awaited state check -> fails; (if a seam was added) change a production default -> the defaults test fails. Then npm --prefix worker run verify, npm run lint, npm run typecheck.

Open a DRAFT PR with base codex/recovered-release-free-safety-20261003 titled "OVD-636: make browserRecovery tests robust under hosted load", template body with root cause and all evidence, stating that merge goes into the integration branch and that the production apply is protected. One PR CI run plus at most one re-run; no empty-commit re-triggers. Do not write the release-parent identifiers (OVD-520, OVD-527, OVD-319, OVD-419, OVD-199, OVD-359, OVD-332, OVD-385) anywhere. Push and stop; the coordinator verifies and merges.
```

Alternative if you would rather I run them from the cloud: commit this to `.claude/settings.json` on main and tell me; I relaunch both lanes.

```json
{"permissions":{"allow":["Bash","Workflow","mcp__claude-code-remote__send_message","mcp__claude-code-remote__create_session","mcp__claude-code-remote__list_events","mcp__claude-code-remote__get_session"]}}
```

---

## 6. #565 decision (one line from you)

#565 is the 97-file Jarvis checkpoint draft on an old main (8d8d243), never CI-validated remotely. Recommendation, which Jev's advisory agreed with: keep #565 as the preservation reference and carve bounded PRs onto current main in dependency order, drivers and artifact mapping/route first; close #565 when the last carve lands. Reply "carve" and I queue the first carve behind #605. Reply "park" and it stays untouched until after the release.

---

## What happens after each reply

| Your reply | My next action |
|---|---|
| Ledger paste | OVD-635 prep lane within minutes; packet rewritten if 127-133 are missing |
| "Gate green" | Re-read the gate via API, refresh #564 body and readiness comment |
| CodeRabbit phrase | Record in #564; or open the review slices |
| X1 report | Copy receipts into the readiness packet, close section B |
| OVD-630 / OVD-636 draft PRs | Verify lanes, merge on two clean rounds |
| "carve" | First #565 carve lane behind #605 |
