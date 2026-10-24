## Linear issue ID

- Issue: OVD-764 (https://linear.app/overdrafter/issue/OVD-764)
- Yes: this one test-only change covers the source acceptance criteria. Still to come after the PR: Jev screen and independent review before squash merge.
- This is the issue's main PR.
- OVD-764 is not a release-outcome parent.

## Summary

Each grouped loop of subprocess scenarios in three script contract test files is now a table driven by `it.each`. Every scenario gets its own default Vitest per-test timeout and a name that identifies it by input. Fixture temp dirs are now cleaned up per case.

## Problem

Several contract tests ran many independent subprocess scenarios inside one 5s test. These were the two adapter matrices and the partial and unsafe stable-egress tuples in deploy-cloud-run-contract, the 25 egress-install startup-status cases in verify-xometry-recovery-host, and the three admission cases plus the two CLI-version scenarios in qualify-ovd417. Under load they timed out as a group, and a failure did not say which input caused it.

## Acceptance criteria addressed

- [x] Every existing matrix scenario and assertion is kept and has its own name. Inputs, assertions, expected exit codes and expected output are unchanged.
- [x] All affected script files pass under `--maxWorkers=2` and under `npm run preflight`.
- [ ] Hosted CI green at the final head (see checks), plus Jev screen and independent review.
- [x] Fourth file (supabase-client-inference) left unchanged: it passes in isolation, so there was no evidence of a defect. Retention SQL was not touched.

## Files changed

- `scripts/deploy-cloud-run-contract.test.mjs`
- `scripts/verify-xometry-recovery-host.test.mjs`
- `scripts/qualify-ovd417-four-migration-suffix.test.mjs`

## Scope

Included: only the test files. Each loop becomes `it.each`, temp-dir cleanup moves to per-case `try/finally` or `beforeEach`/`afterEach`, and `STABLE_EGRESS_LIVE_ADAPTER_VALUES` is now a static import so the table exists when the file is collected (same values).
Not included: script or production changes, and any timeout change (global, per-file or per-case). Non-subprocess static loops, such as forbidden-token string scans, are left as they were.

## Verification

Commands run:

```bash
npx vitest run scripts/deploy-cloud-run-contract.test.mjs scripts/verify-xometry-recovery-host.test.mjs scripts/qualify-ovd417-four-migration-suffix.test.mjs --maxWorkers=2   # x3 in a row
npx eslint <3 files>
npm run preflight
```

Results:

- [x] all listed verification passed. 3 of 3 consecutive targeted runs passed (213/213 each). Preflight: lint, typecheck and tests all passed (565 files, 11110 tests).
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: the first preflight run in the fresh worktree failed in 39 worker files because `worker/node_modules` was not installed (`dotenv/config`, `openai` and `patchright` missing). After `npm ci` in `worker/`, preflight passed with no code change.

### Case count before / after

Before: 149 tests (deploy 56, verify 86, qualify 7). After: 213 tests (deploy 93, verify 110, qualify 10). The scenario count is unchanged. The difference comes only from loops that held several scenarios in one test now being one test per scenario:
- deploy: partial stable-egress tuple, 1 test became 6. Unsafe stable-egress values, 1 became 9. Quickparts and Weerg adapter matrices, 1 each became one case per adapter value, plus a small separate `it` holding the allowed-list `arrayContaining`/`toEqual` assertion that was already in the original test.
- verify: the egress-install phase test, 1 became 25 (20 allowlisted phase-to-stage mappings and 5 fallback cases).
- qualify: admission, 1 became 3. CLI version, 1 became 2 (mismatch, exact).

<details><summary>Before: case names (149)</summary>

- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract preflights bucket controls and deploys without legacy bindings or --remove-env-vars
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract matches the pinned release-tuple sandbox default and honors an explicit sandbox opt-in
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract keeps the storage-state secret binding when snapshot mode is off
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract adds the complete all-traffic Direct VPC contract for the bounded Xometry worker
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects every partial stable-egress tuple before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses a production worker deploy that omits the governed network tuple
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses to deploy when the bucket control preflight fails
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses to deploy when the bucket belongs to another project
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract does not classify a successful bucket lookup warning as the preflight failure
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract uses the uppercase cloud status before lowercase bucket-like text
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract uses the first structured cloud status when later details contain another
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses to deploy when the target project number cannot be resolved
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract keeps resource names from influencing cloud failure classification
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract classifies the standard no-active-account cloud failure
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract preserves diagnostic keywords that also appear as resource names
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract classifies the standard uppercase service-unavailable status
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses to deploy when the preflight metadata is unreadable
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) keeps Fictiv disabled by default and strips any stale Fictiv session binding
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) pins the xometry,fictiv deploy argv
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) binds the named Fictiv secret and preserves the comma-separated adapter list
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) allows the stable-egress tuple to carry Fictiv alongside Xometry
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,fictiv"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"fictiv"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,oshcut","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,fictiv,fictiv","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry, fictiv","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":",","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,,fictiv","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) leaves the Xometry-only deploy unchanged except for stripping stale Quickparts and Weerg mounts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) keeps Quickparts disabled by default with no session binding or path map
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) mounts the named Quickparts secret and points the vendor path map at it
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) keeps a single-adapter path map in gcloud's plain comma form
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the adapter values the egress contract allows
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry,quickparts"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"quickparts"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry,quickparts,quickparts","QUICKPARTS_STORAGE_STATE_SECRET_NAME":"synthetic-quickparts-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry, quickparts","QUICKPARTS_STORAGE_STATE_SECRET_NAME":"synthetic-quickparts-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry,quickparts,","QUICKPARTS_STORAGE_STATE_SECRET_NAME":"synthetic-quickparts-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry,weerg","QUICKPARTS_STORAGE_STATE_SECRET_NAME":"synthetic-quickparts-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) keeps Weerg disabled by default with no session binding or path map
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) mounts the named Weerg secret and points the vendor path map at it
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) merges Quickparts and Weerg sessions into one vendor path map
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) keeps a Quickparts-only path map byte-identical to OVD-674
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the adapter values the egress contract allows
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,weerg"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"weerg"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,quickparts,weerg","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,weerg,weerg","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry, weerg","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,weerg,","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,geomiq","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh stable-egress restriction message (OVD-727) prints the current registry-built message and lists a temporary fourth adapter
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh stable-egress restriction message (OVD-727) keeps generated shell free of bash 4 only syntax and prints the helper message in posix mode
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh stable-egress restriction message (OVD-727) uses the generated helper when a stable-egress deploy is rejected
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness parses without running a database qualification
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness fails closed on the wrong CLI version before any database command
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness forbids hosted, linked, credential, and history-repair paths structurally
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness rejects routing overrides, duplicate databases, and non-empty evidence before qualification
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness injects immediately after the first migration and refuses promotion from a one-row prefix
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness pins source, baseline, exact suffix hashes, and local backup/restore evidence
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness keeps final postconditions independent, ledger-only, and read-only
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence accepts the exact private recovery host and exclusive fixed-NAT mapping
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects malformed recovery-egress policy metadata
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects metadata and runtime that self-approve a different policy digest
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects installed recovery-egress control ownership, mode, or digest drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects an installed recovery-egress control that changes during collection
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects recovery-egress control source or runtime drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects an external address on the recovery host
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects external IPv6 and alias ranges on the recovery host
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects image drift from the retained production worker
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects an immutable worker image from a different repository
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects broad firewall sources or browser-display ports
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects recovery credentials broader than artifact read
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects public artifact repository access
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects recovery access to the snapshot bucket
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence accepts complete worker snapshot-role absence in the explicit revoked phase
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects a retained worker snapshot role in the revoked phase
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects missing snapshot-bucket controls
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects competing hosts or firewall rules on the governed network
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects a competing NAT mapping
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects an unavailable IAP tunnel service
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence preserves stable-egress failures while the host exists
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects network count drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects network drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects subnet drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects IPv4 stack drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects metadata shape drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects OS Login drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects project keys drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects serial port drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects startup script drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects instance name drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects instance zone drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects machine type drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects running state drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects IP forwarding drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects deletion protection drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects network tag drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects labels drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects accelerator drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects resource policy drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects Shielded VM drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects confidential runtime drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects automatic restart drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects preemptibility drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects provisioning model drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects preemption action drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects boot disk drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects service account drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall name drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall network drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall control drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall target drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall extra scope drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects project role drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects service-account impersonation drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects bucket policy drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects worker snapshot role drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects instance inventory drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall inventory drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI passes only the fixed production contract
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI prints only the sanitized startup status and classifies readiness
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI redacts startup transport failures and rejects untrusted status shapes
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI accepts only the allowlisted capacity-fallback zones for startup status
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI rejects recovery-host expectations outside the fallback zone allowlist
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI runs the full verifier for an allowlisted fallback zone and rejects others
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI accepts n4-standard-2 only with a hyperdisk-balanced boot disk
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI selects the machine type from the environment only from the hardware allowlist
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI fails before collection when one fixed name drifts
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI fails before collection when the trusted policy digest is missing or malformed
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI names the failing lookup and its exit code without echoing command text
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI reports an execFile timeout as timedOut=true on the egress runtime step
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI reports unparseable command output as reason=invalid-json
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI never prints stdout, stderr, messages, or command args from a failed step
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup status accepts only the exact ready status
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup status requires stable ready status in the full recovery evidence
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup status uses one fixed status-only SSH command with bounded connection controls
- `verify-xometry-recovery-host.test.mjs` :: recovery-host metadata collection reads the bounded instance, firewall, repository, and service-account surfaces
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract pulls only the pinned image and exposes the display on loopback
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract atomically records the original failing stage and exit code
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract maps only a root-owned allowlisted egress install phase into sanitized status
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract keeps every recovery block fail-fast and preserves explicit isolation gates
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract retries the worker revocation proof until a 403 and fails closed without echoing the token
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract rejects metadata-only image trust and launches only the approved digest
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract compensates resources while preserving the only pre-verification archive
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract rejects insecure or ambiguous local archive preservation targets
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract rejects a classifier payload hash mismatch before staging

</details>

<details><summary>After: case names (213)</summary>

- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract preflights bucket controls and deploys without legacy bindings or --remove-env-vars
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract matches the pinned release-tuple sandbox default and honors an explicit sandbox opt-in
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract keeps the storage-state secret binding when snapshot mode is off
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract adds the complete all-traffic Direct VPC contract for the bounded Xometry worker
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects partial stable-egress tuple {"CLOUD_RUN_NETWORK":"synthetic-network"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects partial stable-egress tuple {"CLOUD_RUN_SUBNET":"synthetic-subnet"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects partial stable-egress tuple {"CLOUD_RUN_VPC_EGRESS":"all-traffic"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects partial stable-egress tuple {"CLOUD_RUN_NETWORK":"synthetic-network","CLOUD_RUN_SUBNET":"synthetic-subnet"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects partial stable-egress tuple {"CLOUD_RUN_NETWORK":"synthetic-network","CLOUD_RUN_VPC_EGRESS":"all-traffic"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects partial stable-egress tuple {"CLOUD_RUN_SUBNET":"synthetic-subnet","CLOUD_RUN_VPC_EGRESS":"all-traffic"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"CLOUD_RUN_VPC_EGRESS":"private-ranges-only"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"CLOUD_RUN_MIN_INSTANCES":"1"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"CLOUD_RUN_MAX_INSTANCES":"2"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"WORKER_MODE":"mock"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"WORKER_LIVE_ADAPTERS":"fictiv","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"WORKER_LIVE_ADAPTERS":"fictiv,xometry","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"WORKER_LIVE_ADAPTERS":"xometry,fictiv"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"PLAYWRIGHT_CAPTURE_TRACE":"true"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract rejects unsafe stable-egress values {"CLOUD_RUN_SERVICE_ACCOUNT":""} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses a production worker deploy that omits the governed network tuple
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses to deploy when the bucket control preflight fails
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses to deploy when the bucket belongs to another project
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract does not classify a successful bucket lookup warning as the preflight failure
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract uses the uppercase cloud status before lowercase bucket-like text
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract uses the first structured cloud status when later details contain another
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses to deploy when the target project number cannot be resolved
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract keeps resource names from influencing cloud failure classification
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract classifies the standard no-active-account cloud failure
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract preserves diagnostic keywords that also appear as resource names
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract classifies the standard uppercase service-unavailable status
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh snapshot command contract refuses to deploy when the preflight metadata is unreadable
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) keeps Fictiv disabled by default and strips any stale Fictiv session binding
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) pins the xometry,fictiv deploy argv
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) binds the named Fictiv secret and preserves the comma-separated adapter list
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) allows the stable-egress tuple to carry Fictiv alongside Xometry
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,fictiv"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"fictiv"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,oshcut","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,fictiv,fictiv","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry, fictiv","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":",","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673) refuses unsafe live adapter configuration {"WORKER_LIVE_ADAPTERS":"xometry,,fictiv","FICTIV_STORAGE_STATE_SECRET_NAME":"synthetic-fictiv-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) leaves the Xometry-only deploy unchanged except for stripping stale Quickparts and Weerg mounts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) keeps Quickparts disabled by default with no session binding or path map
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) mounts the named Quickparts secret and points the vendor path map at it
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) keeps a single-adapter path map in gcloud's plain comma form
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) includes the Quickparts adapter values in the stable-egress contract
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry,quickparts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv,quickparts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry,quickparts,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv,quickparts,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: quickparts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: quickparts,xometry
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) accepts on the stable egress exactly the allowed adapter values: fictiv,quickparts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry,quickparts"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"quickparts"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry,quickparts,quickparts","QUICKPARTS_STORAGE_STATE_SECRET_NAME":"synthetic-quickparts-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry, quickparts","QUICKPARTS_STORAGE_STATE_SECRET_NAME":"synthetic-quickparts-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry,quickparts,","QUICKPARTS_STORAGE_STATE_SECRET_NAME":"synthetic-quickparts-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674) refuses unsafe Quickparts configuration {"WORKER_LIVE_ADAPTERS":"xometry,weerg","QUICKPARTS_STORAGE_STATE_SECRET_NAME":"synthetic-quickparts-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) keeps Weerg disabled by default with no session binding or path map
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) mounts the named Weerg secret and points the vendor path map at it
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) merges Quickparts and Weerg sessions into one vendor path map
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) keeps a Quickparts-only path map byte-identical to OVD-674
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) pins the stable-egress adapter values the egress contract allows
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,quickparts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv,quickparts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,quickparts,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv,quickparts,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: weerg,xometry
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,weerg,quickparts
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: xometry,weerg,fictiv
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) accepts on the stable egress exactly the allowed adapter values: quickparts,weerg
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,weerg"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"weerg"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,quickparts,weerg","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,weerg,weerg","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry, weerg","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,weerg,","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh Weerg live-adapter contract (OVD-675) refuses unsafe Weerg configuration {"WORKER_LIVE_ADAPTERS":"xometry,geomiq","WEERG_STORAGE_STATE_SECRET_NAME":"synthetic-weerg-storage-state"} before invoking gcloud
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh stable-egress restriction message (OVD-727) prints the current registry-built message and lists a temporary fourth adapter
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh stable-egress restriction message (OVD-727) keeps generated shell free of bash 4 only syntax and prints the helper message in posix mode
- `deploy-cloud-run-contract.test.mjs` :: deploy-cloud-run.sh stable-egress restriction message (OVD-727) uses the generated helper when a stable-egress deploy is rejected
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness parses without running a database qualification
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness fails closed on the wrong CLI version before any database command
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness passes the CLI version check for the exact version and fails later on the project directory
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness forbids hosted, linked, credential, and history-repair paths structurally
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness rejects 'a routing override' before qualification
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness rejects 'duplicate databases' before qualification
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness rejects 'non-empty evidence' before qualification
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness injects immediately after the first migration and refuses promotion from a one-row prefix
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness pins source, baseline, exact suffix hashes, and local backup/restore evidence
- `qualify-ovd417-four-migration-suffix.test.mjs` :: OVD-417 local qualification harness keeps final postconditions independent, ledger-only, and read-only
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence accepts the exact private recovery host and exclusive fixed-NAT mapping
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects malformed recovery-egress policy metadata
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects metadata and runtime that self-approve a different policy digest
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects installed recovery-egress control ownership, mode, or digest drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects an installed recovery-egress control that changes during collection
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects recovery-egress control source or runtime drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects an external address on the recovery host
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects external IPv6 and alias ranges on the recovery host
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects image drift from the retained production worker
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects an immutable worker image from a different repository
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects broad firewall sources or browser-display ports
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects recovery credentials broader than artifact read
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects public artifact repository access
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects recovery access to the snapshot bucket
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence accepts complete worker snapshot-role absence in the explicit revoked phase
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects a retained worker snapshot role in the revoked phase
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects missing snapshot-bucket controls
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects competing hosts or firewall rules on the governed network
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects a competing NAT mapping
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects an unavailable IAP tunnel service
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence preserves stable-egress failures while the host exists
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects network count drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects network drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects subnet drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects IPv4 stack drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects metadata shape drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects OS Login drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects project keys drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects serial port drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects startup script drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects instance name drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects instance zone drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects machine type drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects running state drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects IP forwarding drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects deletion protection drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects network tag drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects labels drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects accelerator drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects resource policy drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects Shielded VM drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects confidential runtime drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects automatic restart drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects preemptibility drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects provisioning model drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects preemption action drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects boot disk drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects service account drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall name drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall network drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall control drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall target drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall extra scope drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects project role drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects service-account impersonation drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects bucket policy drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects worker snapshot role drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects instance inventory drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host evidence rejects firewall inventory drift
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI passes only the fixed production contract
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI prints only the sanitized startup status and classifies readiness
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI redacts startup transport failures and rejects untrusted status shapes
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI accepts only the allowlisted capacity-fallback zones for startup status
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI rejects recovery-host expectations outside the fallback zone allowlist
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI runs the full verifier for an allowlisted fallback zone and rejects others
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI accepts n4-standard-2 only with a hyperdisk-balanced boot disk
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI selects the machine type from the environment only from the hardware allowlist
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI fails before collection when one fixed name drifts
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI fails before collection when the trusted policy digest is missing or malformed
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI names the failing lookup and its exit code without echoing command text
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI reports an execFile timeout as timedOut=true on the egress runtime step
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI reports unparseable command output as reason=invalid-json
- `verify-xometry-recovery-host.test.mjs` :: recovery-host CLI never prints stdout, stderr, messages, or command args from a failed step
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup status accepts only the exact ready status
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup status requires stable ready status in the full recovery evidence
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup status uses one fixed status-only SSH command with bounded connection controls
- `verify-xometry-recovery-host.test.mjs` :: recovery-host metadata collection reads the bounded instance, firewall, repository, and service-account surfaces
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract pulls only the pinned image and exposes the display on loopback
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract atomically records the original failing stage and exit code
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase resolution to stage egress-resolution
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase network-create to stage egress-network-create
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase network-contract to stage egress-network-contract
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase network-ipv6 to stage egress-network-ipv6
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase network-ipv6-verify to stage egress-network-ipv6-verify
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-policy to stage egress-verification-policy
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-network to stage egress-verification-network
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-ipv6 to stage egress-verification-ipv6
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-empty-network to stage egress-verification-empty-network
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-address-map to stage egress-verification-address-map
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-config to stage egress-verification-config
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-units to stage egress-verification-units
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-dns-config to stage egress-verification-dns-config
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-gateway-config to stage egress-verification-gateway-config
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-dns-tcp to stage egress-verification-dns-tcp
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-dns-udp to stage egress-verification-dns-udp
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-gateway-listener to stage egress-verification-gateway-listener
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-firewall to stage egress-verification-firewall
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-gateway-dns to stage egress-verification-gateway-dns
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status maps allowlisted phase verification-evidence to stage egress-verification-evidence
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status falls back to egress-install for 'untrusted phase detail'
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status falls back to egress-install for 'extra untrusted line'
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status falls back to egress-install for 'non-root owner'
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status falls back to egress-install for 'mode 640'
- `verify-xometry-recovery-host.test.mjs` :: recovery-host startup contract root-owned allowlisted egress install phase sanitized status falls back to egress-install for 'symlink marker'
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract keeps every recovery block fail-fast and preserves explicit isolation gates
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract retries the worker revocation proof until a 403 and fails closed without echoing the token
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract rejects metadata-only image trust and launches only the approved digest
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract compensates resources while preserving the only pre-verification archive
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract rejects insecure or ambiguous local archive preservation targets
- `verify-xometry-recovery-host.test.mjs` :: recovery-host runbook contract rejects a classifier payload hash mismatch before staging

</details>

### Slowest 5 (after, --maxWorkers=2; default budget 5000 ms)

| ms | case |
|---|---|
| 560 | qualify-ovd417 :: rejects 'duplicate databases' before qualification |
| 325 | verify-xometry-recovery-host :: keeps every recovery block fail-fast and preserves explicit isolation gates |
| 286 | qualify-ovd417 :: rejects 'a routing override' before qualification |
| 194 | deploy-cloud-run-contract :: Quickparts (OVD-674) keeps a single-adapter path map in gcloud's plain comma form |
| 191 | deploy-cloud-run-contract :: Quickparts (OVD-674) accepts on the stable egress exactly the allowed adapter values: xometry,fictiv,quickparts,weerg |

The slowest case before was a grouped test at about 1326 ms.

### Mutation check (one broken assertion per file, run once and then reverted)

Result: 3 failed and 210 passed. Each file had only its mutated case fail:
- deploy: `rejects partial stable-egress tuple {"CLOUD_RUN_VPC_EGRESS":"all-traffic"} before invoking gcloud`
- verify: `maps allowlisted phase verification-dns-udp to stage egress-verification-dns-MUTATED`
- qualify: `rejects 'duplicate databases' before qualification`

### Temp-dir check (isolated TMPDIR)

- Before (origin/main): 93 dirs leaked per run (90 `overdrafter-deploy-contract-*`, 3 `overdrafter-stable-egress-*`).
- After, including the forced-failure mutation run: **0 dirs** left.
- 2 empty `tmp.*` *files* are still left by an existing inline bash snippet (`counter="$(mktemp)"`) in an approved-image test that this PR does not touch. Changing it would change test inputs, so it is out of scope.

## Review findings and coverage

- Final PR head SHA: efaad23
- Sonar issue findings: pending on this head.
- CodeRabbit: pending.
- Codex and other reviewers: pending.
- [ ] Inspected findings and threads on the final head.

## Tests

The three test files were updated. No new tests were added; the existing scenarios were split into separate cases.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

Risk is low because only tests changed. Rollback is a revert of this commit.

## Documentation

- [ ] Docs updated
- [x] No doc updates needed

## Follow-up items

- [ ] Optional: clean up the `mktemp` counter file in the approved-image bash snippet.
