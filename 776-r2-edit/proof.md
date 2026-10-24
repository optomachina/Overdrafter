## Proof

Current head `3240eab17f01cedd3c980b54067fcc723d399dac`, from QA's pre-check (log `/workspace/qa-batch/776-r2.log`, section "R2b"; the QA PASS comment for this head is drafted but not yet posted) and Codex's re-review (APPROVED @3240eab1, https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6230022828):

- **Delta since 9489b783 is docs only:** a0789e5d and 87e954f9 touch only `docs/staging-env-wiring.md`; the origin/main merge (d7489665) is the automatic merge tree and changes no PR-touched file.
- **PG17 replay (local disposable PG17.11 only):** all 159 migrations replay deterministically. The schema dump is byte-identical across a repeated fresh apply, a fresh apply with the 7 window files single-tx, and main's 153 + the 7, and it matches the 9489b783 dump. 768+771+767+769 plus an injected error in one tx leave 0 function changes (atomic).
- **pgTAP:** no new failures versus main locally (head 83 files / 3233 tests, main 77 / 3091; every file failing at head also fails at main). CI pgTAP on real Supabase Files=82, Tests=3591, PASS (https://github.com/optomachina/Overdrafter/actions/runs/39005373647).
- **Hash match:** the free-quote fixtures pass `generate-free-quote-fixtures.mjs --check` with the hashes pinned (re-run at 3240eab1, exit 0); an earlier QA comment recomputed the sha256 of all 7 files and they match `free-quote-ci-source.json` and `free-quote-ci-profile.mjs` (https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6207086255). No migration file changed after that check except as recorded there.
- **Contract tests:** `scripts/deploy-cloud-run-contract.test.mjs` with `server-quote-expiry-migration.test.ts` passes 108/108 at 3240eab1, including the OVD-838 staging refusal test and the OVD-462 lease-on and opt-out tests.
- **CI and Sonar:** all 26 check runs completed green at 3240eab1 (one cancelled proof-check superseded by green run 39005389705); SonarCloud quality gate passed on 3240eab1. Nothing was applied anywhere except the throwaway local PG17.

Earlier evidence, kept for history: QA PASS on 9489b78349368c7a05963ad6e729a728d7e8d93a (https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6229846105), with the same three-path apply and atomicity results, contract 108/108, CI pgTAP Files=82 / Tests=3591 PASS and 21/21 non-Vercel checks green (run 38996819987).
