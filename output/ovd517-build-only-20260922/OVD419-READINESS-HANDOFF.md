# OVD-419 — read-only readiness handoff after OVD-517 build

Captured 2026-09-23 01:18–01:20 UTC. No OVD-419 production mutation, provider probe, release nonce, migration application, credential change, or cleanup occurred. The owner's OVD-517 build-only approval was consumed by the one build and inspection recorded in [BUILD-ONLY-RESULT.md](BUILD-ONLY-RESULT.md); it is not an OVD-419 authorization.

## Proven now

- Source `7da20710b25a6a30d0f9ac59e88e00f685defc67` maps to immutable worker image `us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/overdrafter-cad-worker@sha256:197e36e9aabfff75ed169df0c0853d0194ce316400f30af8acd49029e5133b0e`. The one Cloud Build succeeded, source generation and hashes matched, stopped network-disabled inspection passed, and `attestBuildOnly` returned `build-attested`.
- The exact `build-only-bundle.json` passed `node scripts/run-ovd419-final-digest-release.mjs --plan-stdin`: eight plan-only promotion phases, followed by two sequential one-task, zero-retry, no-upload probe placeholders. This CLI never deploys or runs a probe.
- The 00:49–00:52 UTC read-only preflight observed disabled rollout, empty active queues, 20 completed historical/zero active executions, stable snapshot metadata, stable egress, and Job/Service parity on rollback digest `sha256:3dd67a3ce58817417d94da3b580c1eb99cdfdf9aa9d9ed2317c535ad69bf0daf`. Every dynamic observation expires before a protected operation.
- Production migration ledger ended at `20260905233435`; all OVD-418 suffix migrations were present. Five September 10 source migrations remained pending. Four are engineering-control-plane migrations documented as separately authorized for production activation; the fifth changes the commercial entitlement-revocation audit function. No `worker/src` reference to their new engineering objects or audit helper was found. This suggests they are not part of the OVD-408 worker's immediate schema dependency, **but is not approval to skip or apply them**. The OVD-419 migration-first requirement must be bound to an explicit reviewed database head.

## Production HOLD — newly reconciled source gap

- The retained OVD-419 canonical worktree is `/Users/blainewilson/.codex/worktrees/1fb4/Overdrafter`, branch `codex/ovd-419-acquisition-inventory`, HEAD `d8c6e6def57b720657a0cba1aa8b0887667c7caf`. It has 14 commits unique to that branch relative to the qualified `7da20710…` main and 34 commits from main not on the branch; its untracked `output/` evidence must be preserved.
- Its [offline acquisition workflow](../../../../1fb4/Overdrafter/docs/workflows/ovd419-offline-acquisition.md) explicitly says the complete finite B reader and C private writer/integration remain incomplete and labels production `HOLD`. The branch's pure TEST_ONLY validators deny transport, full-acquisition and private-binding readiness. The current OVD-419 Linear rolling comment still names an older HEAD and incomplete B2/B3/C work; it is historical, not proof this gap closed.
- Consequently the qualified `7da20710…` image is a valid build-only candidate **for that source**, not evidence that the final OVD-419 release controller is ready. The live artifact binding requires the controller's exact Git HEAD to equal the qualified source commit. Finishing and merging the retained source work will change that full SHA even if worker/Docker inputs are unchanged; it therefore requires a new clean source archive, full-SHA image publication, digest inspection and separate build-only approval before release. Do not reuse the `7da20710…` record for a later controller HEAD.

## Other unresolved release gates

- Current Supabase security/performance advisors still return WARN findings, including executable security-definer functions and multiple permissive policies. OVD-418's final rolling comment says its August 25 postaudit found no release-caused WARN/ERROR; the exact private baseline captures were not available in this handoff. Current WARN causality and any later migration contribution remain unproved, so no clean release-quality claim is made.
- Exact private snapshot identity was not retained in this public packet; its generation/metageneration/etag must be captured and bound privately at admission.
- Global sole-owner proof across hosts and nondefault lock locations is incomplete. The OVD-419 branch has a historical owner task; ownership and retained artifacts must be reconciled before any source integration.
- No short-lived release authorization exists for Job replacement, Service replacement, or either no-upload probe. The user's “Approved, continue” is not an exact production-resource/probe authorization. The build-only approval cannot be reused.

## Smallest safe sequence

1. Establish one current owner for the retained OVD-419 branch and reconcile its 14 unique commits, untracked evidence and 34 main-only commits without reset, deletion or blind cherry-pick.
2. Decompose the remaining High-complexity source work before editing:
   - **B3 finite reader/opaque handoff:** prove attributable, complete and settled cloud/SQL reads within the existing one-use deadline; bind selected Job, Service, Execution, snapshot, principal, secret and IAM projections; keep production readiness false on missing, stale, inconsistent or over-budget evidence. Test accepted and adversarial TEST_ONLY inputs without provider or production mutation.
   - **C private writer/integration:** persist only the exact accepted private binding and sanitized public verdict; prove atomic one-use behavior, restart/interruption recovery, private file ownership, and no secret or raw-identity leak. Integrate only after B3 acceptance, with targeted plus full gates and independent review.
   Complete each unit under the repository's High-complexity decomposition/override rule, then reconcile with current main and merge through normal PR gates. The old source-merge override does not automatically authorize this new unit.
3. Explicitly disposition the five pending migrations against the exact worker release schema; compare current advisor findings with retained OVD-418 accepted captures. Do not apply unrelated migrations merely to match main.
4. Requalify the final merged source/image relationship if its build inputs change, then rerun plan-only validation and collect fresh complete preflight, exact private snapshot and sole-owner evidence.
5. Only then prepare an exact, short-lived OVD-419 production authorization packet for Job-first/Service-second replacement and two separately gated probes, with rollback and no-retry conditions. No release action is admitted by this handoff.
