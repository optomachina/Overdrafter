# OVD-520 activation packet (DRAFT, unit U10 / OVD-744)

**Status: DRAFT. This page executes nothing and grants no protected action.** It lists what must be done, in what order, and which steps need Blaine's exact yes. Nothing here has been applied, deployed, provisioned or enabled. No secret, key, token, connection string or environment value appears here, and none may be added.

Source of the unit: `docs/plans/jarvis-path-to-520.md` (unit U10). It is complete only when its dependencies are real: U3 (window 2 packet, merged as #716), U6 (deterministic adapter, #700), U7 (admin flagged `/engineering`, #704) and U8 (trusted host launcher, **not built**: OVD-742 is Backlog and no launcher file exists on main). Until U8 and decision D1 land, sections 4 to 6 describe intent, not a runnable procedure.

## 1. How to read this packet

Every step that changes a hosted system, a credential, a flag or a Windows host is labelled:

> **PROTECTED: needs Blaine's exact yes.** Blaine names the action, the target and the moment in chat. A yes for one step is not a yes for the next, and not a yes for a retry.

The labels are numbered `PA-1` to `PA-14` and collected in section 9. Read-only inspection by the lead is not protected, but reading production through `DB_URL` needs the connection string from Blaine, so the go or no go queries are labelled too.

## 2. Pointers, not copies

* **Apply order and reverse order for the Jarvis chain:** `docs/release/window-2/README.md`, sections "Apply order (forward)" and "Reverse order". That page is the one authoritative list. This packet does not restate or reorder it.
* **Pins:** `docs/release/window-2/manifest.json` pins base, every staged file by sha256, the OVD-558 prechange and postchange catalog digests, and the slots. U3 manifest pins are never edited in the window.
* **Expected inventory diff per step:** `docs/release/window-2/ovd602-expected/`.
* **Rehearsal evidence:** `docs/release/window-2/rehearsal/` (synthetic fixture only, not hosted).
* **Read only go or no go digest:** `docs/release/window-2/ovd558-catalog-digest.sql`.
* **Window 2 portable checks:** `node --test scripts/window2-packet.node-test.mjs`.
* **Companion lifecycle:** `docs/release/ovd-562-companion-lifecycle.md`, `scripts/native/worker-companion/README.md`.
* **Runtime composition and Storage:** `docs/release/native-first-loop-runtime.md`, `docs/release/native-private-runtime-drivers.md`, `docs/release/native-storage-qualification.md`.
* **Finalization and key:** `docs/release/ovd-561-finalization-contract.md`.

## 3. Stale pin warning (must be resolved before any window)

The window 2 packet is pinned to `main` at `26b0b76e` with **148** migrations, equal to the production ledger at that time. `supabase/migrations/` on current main holds **153** files. The five newer ones are `20261012212325_ovd462_provider_session_lease.sql`, `20261013043000_ovd723_export_control_upload_block.sql`, `20261013043100_ovd722_provider_kill_switch.sql`, `20261014191541_ovd414_xometry_admission_read.sql` and `20261015074957_ovd736_revoke_anon_definer_execute.sql`.

The window 2 README states that any migration applied before the OVD-558 forward changes the catalog it pins, and the forward then refuses (before any write). It also requires the ledger check to print `148|`. If production has since received any of these five (the Oct 15 window record is the open PR #776, not merged), the pins and go or no go items in the window 2 README no longer describe production. Required before scheduling:

1. Read-only: establish which of the five are applied in production, then re-run the digest and ledger checks of the window 2 README. **PA-1 (production read).**
2. If they differ, re-pin through the reviewed generator in a PR (the README forbids editing pins in the window). That is a separate reviewed change and is not done by this draft.

## 4. Sequence overview

| Phase | What | Gate |
| --- | --- | --- |
| A | Repo prerequisites: U8 launcher (OVD-742), packet re-pin if needed (section 3), D1/D3/D5 decided | Merge gates under `AGENTS.md`; D1 is Blaine's |
| B | Migration window 2, Jarvis section only | Go or no go in the window 2 README, Blaine's yes per step |
| C | Provisioning: private bucket, signing key, owner pool, Storage qualification | Each item protected |
| D | Edge function flags and hosted build flag | Each flip protected |
| E | Companion pairing on the Windows host | Protected |
| F | The one 7 mm run (U11), then the evidence record (U12) | Protected; real native execution |
| R | Rollback, at any phase | Reverse order below |

## 5. Phase B: migration window 2 (Jarvis section)

Follow `docs/release/window-2/README.md` exactly. In summary only, to show where Blaine's yes sits:

* Go or no go reads (ledger count, OVD-602 inventory, OVD-558 catalog digest, worker stopped): **PA-1, production read through `DB_URL`.** The worker gateway, task and stop flags must be off and no companion connected before and during the window.
* Local dump and restore check, as in window 1 (output stays on Blaine's machine, outside the repo): **PA-2, production dump (customer data).**
* Each of the 9 forward steps, one file at a time, as `postgres`, followed by the OVD-602 diff against the matching `ovd602-expected/` file: **PA-3, one exact yes per step.** A pass is `COMMIT` with no `ERROR` and a diff that matches exactly. Any other output stops the window.
* Storage stalls while the OVD-558 and OVD-560 reverses run (see the window 2 README); schedule inside a low traffic window.
* The Jarvis section runs first. Slots W2-S1 to W2-S3 (quoting work) run after it and are not part of this packet. If any Jarvis statement fails, only the Jarvis steps already applied are reversed, strictly in the reverse order of the window 2 README.

Not allowed: `supabase db push`, `supabase migration repair`, editing a pin or preflight, raising a `lock_timeout`, adding `--single-transaction`.

## 6. Phase C: provisioning (all hosted or credential work is protected)

Nothing below exists yet. U8 does not exist, so the exact launcher interface is not final; the requirements come from `docs/release/native-first-loop-runtime.md`.

| Item | Requirement | Label |
| --- | --- | --- |
| Private output bucket | One fixed private bucket in the hosted project for the seven result objects. The bucket is chosen by the trusted side, never by a worker request. Name is decided at provisioning (D1). Public buckets fail the runtime's SQL check. | **PA-4: PROTECTED, create hosted Storage bucket** |
| Receipt signing key | The private key table is empty by default; only the database owner can insert a key or call finalization. Real key provisioning is "separate protected work" per the finalization contract. The key is generated and held by the operator, never committed, logged or pasted into chat. The OVD-561 reverse refuses while the pending table exists because its envelopes are signed with this key, so key retirement order matters for rollback. | **PA-5: PROTECTED, insert signing key into hosted database** |
| Owner database pool | A dedicated owner pool credential for the trusted host, supplied through operator configuration only. No service-role substitute and no grants added to make tests pass. | **PA-6: PROTECTED, create or issue a hosted database credential** |
| Storage authorization | Authorization the host uses against Storage, from operator configuration. | **PA-7: PROTECTED, issue or use a hosted Storage credential** |
| Storage version qualification | `storageVersionIdQualified` stays false until the pinned hosted provider passes the capability tests in `docs/release/native-storage-qualification.md`. It has never run against the hosted provider. A source test or a manually set flag is not qualification. Output is `NOT_QUALIFIED` until real evidence exists. | **PA-8: PROTECTED, tests against the hosted provider (creates and reads objects)** |
| HTTPS termination and mount | Mount `artifactRoute` at `/functions/v1/engineering-worker-artifact` behind HTTPS. Expose `prepareInputs`, `admitResult`, `finalize` and `replay` only to the operator, never as worker or public RPCs. Listener location is decision D1. No new paid infrastructure (OVD-520 out of scope). | **PA-9: PROTECTED, opening a network listener reachable from the Windows host** |

## 7. Phase D: flags (default off; each flip is a protected action)

All five default to off. Flag changes in the hosted project are protected even though the functions are engineering only. Turn on only what the run needs, in this order, and turn off again after the run.

| Setting | Where it is read | Notes |
| --- | --- | --- |
| `ENGINEERING_INTERPRETATION_ENABLED` | `supabase/functions/engineering-interpretation/index.ts` | Deterministic "set depth to N mm" adapter (D2 already taken, OVD-739). Anything else returns unsupported. |
| `ENGINEERING_WORKER_GATEWAY_ENABLED` | `supabase/functions/engineering-worker/index.ts` | Must be off for the whole of window 2. |
| `ENGINEERING_WORKER_TASK_ENABLED` | `supabase/functions/engineering-worker-task/index.ts` | Must be off for the whole of window 2. |
| `ENGINEERING_WORKER_STOP_ENABLED` | `supabase/functions/engineering-worker-stop/index.ts` | Also needs the executor URL and token below. Must be off for the whole of window 2. |
| `ENGINEERING_STOP_EXECUTOR_URL`, `ENGINEERING_STOP_EXECUTOR_TOKEN` | same stop function | The token is a credential. It is set only by the operator in the hosted secret store. |
| Hosted build admin flag for `/engineering` | `src/App.tsx`, `src/lib/engineering-workbench-access.ts` (U7, #704) | Server side allowlist check, off by default, lazy loaded. Enabling it in a hosted build is a deploy of the production app bundle. |

* **PA-10: PROTECTED, set or change any of the edge function flags, executor URL or token in the hosted project.** One yes per flip.
* **PA-11: PROTECTED, enable the hosted `/engineering` admin flag or deploy a build that enables it.** U7 touches permission gating and the production bundle; confirm the flag-off check (quote routes and main bundle unchanged) at the deployed revision first.
* Deploying edge function code that contains the interpretation adapter is a hosted deploy and is covered by **PA-10** as well.

## 8. Phase E and F: companion pairing, the run, and rollback

### Companion pairing (Windows host)

Per `scripts/native/worker-companion/README.md`: the single-use pairing code is read into a SecureString, never placed in a command line, environment variable, transcript or log; later starts reuse the same worker and gateway; an existing credential cannot be replaced by another code. The owner then enables the session; the fixed companion must be unchanged.

* **PA-12: PROTECTED, issue the pairing code and connect the companion to the hosted gateway.** Blaine supplies or approves the code himself.

### The run (U11) and evidence (U12)

Windows Desktop 5.1 x64, SolidWorks 2022 SP5, store, stop observer and companion get a fresh exact-source qualification, then one request ("set the existing synthetic baseline part to 7 mm") from the phone, with a short recording. No customer files, no automatic CAD retry, no splicing of retained 5 to 8 mm run with the retained 7 mm export (`docs/jarvis-bounded-restart.md`).

* **PA-13: PROTECTED, start real native SolidWorks execution** (`run-task.ps1`, authorized per run), and the explicit output replay to `artifactRoute`.
* **PA-14: PROTECTED, owner `finalize` against the hosted database** (and any `replay`). One exact yes each.
* Record the evidence in `docs/release/ovd-520-run-evidence.md` (U12 / OVD-745). The file does not exist yet. Label every artifact as simulation, replay or real native execution. Do not mark the OVD-520 acceptance boxes until that file exists and the run is on record.

### Rollback

* **Flags first:** turn the five flags and the hosted `/engineering` flag off (PA-10, PA-11). This alone stops all Jarvis traffic. Stop the companion and disconnect it from the gateway.
* **Host:** stop the trusted host listener; revoke the owner pool credential, Storage authorization and executor token the operator issued (each a protected action, same labels as issuing them).
* **Database:** reverse exactly the steps applied, last applied first, using the Reverse order table in `docs/release/window-2/README.md`. Each reverse refuses and changes nothing if its history is not empty: never delete history to make a reverse pass. Reverse the Jarvis steps before any later migration is reversed or applied against it; after the next ordinary migration lands, the OVD-558 reverse refuses permanently by design (window 2 README, decision 3). **PA-3 applies to each reverse.**
* **Key and bucket:** retire the signing key only after the OVD-561 pending table and the finalizations are gone, because the pending envelopes are signed with it. Delete the bucket only when empty and with a separate yes.
* Retained evidence (failed attempts, registered objects) is kept as evidence, not cleaned up on rollback.

## 9. Protected action register

| Label | Action | Where |
| --- | --- | --- |
| PA-1 | Read production (ledger count, OVD-602 inventory, OVD-558 digest) through `DB_URL` | section 3, 5 |
| PA-2 | Production dump and restore drill | section 5 |
| PA-3 | Apply each window 2 forward step, and each reverse step | section 5, 8 |
| PA-4 | Create the private output bucket | section 6 |
| PA-5 | Insert the receipt signing key into the hosted database | section 6 |
| PA-6 | Create or issue the owner database pool credential | section 6 |
| PA-7 | Issue or use the Storage authorization credential | section 6 |
| PA-8 | Run Storage version qualification against the hosted provider | section 6 |
| PA-9 | Open the HTTPS listener for `artifactRoute` | section 6 |
| PA-10 | Set or change edge function flags, executor URL or token; deploy edge function code | section 7 |
| PA-11 | Enable the hosted `/engineering` admin flag or deploy a build enabling it | section 7 |
| PA-12 | Issue the pairing code and connect the companion | section 8 |
| PA-13 | Start real native execution and the output replay | section 8 |
| PA-14 | Owner `finalize` (and `replay`) in the hosted database | section 8 |

Also needing Blaine under `AGENTS.md`, outside this packet: any merge touching the sensitive path list (U7 permission gating, U6 `dispatch` path name, U8 credentials).

## 10. Open decisions

Taken from `docs/plans/jarvis-path-to-520.md`. D2 and D4 are not repeated: D2 was taken (deterministic adapter, OVD-739, #700) and D4 depends on the U3 rehearsal, which merged as #716.

| ID | Decision | Recommended default | Why |
| --- | --- | --- | --- |
| D1 | Where the trusted host runs, and approval to provision its owner pool, signing key and Storage authorization (U8) | **Blaine's owner Mac**, HTTPS terminated through an operator-chosen route that adds no paid infrastructure. The Windows workstation runs only the paired companion and CAD. | Keeps the owner pool credential and signing key off the machine that executes CAD and produces the untrusted output bytes. Provisioning itself stays PA-4 to PA-9, each with its own yes. |
| D3 | Event row on finalization (OVD-511 criterion 3 says "event history") | **Accept `native_finalizations` plus task state as the event record for OVD-511**, record that amendment on OVD-511, and file a 1.1 follow up for an `engineering_events` row. Verified: `ovd-561-finalization-forward.sql`, `ovd561-pending-forward.sql` and the 561 proof contain no `engineering_events` write. | Adding the write changes pinned, rehearsed window 2 SQL (new hashes, new rehearsal, a re-pin PR) and delays the window; the atomicity the criterion protects is already proven by the 561 proof. |
| D5 | Window 2 timing | **Single window 2, Jarvis section first, no separate Jarvis only window.** Date set by Blaine; propose deciding it with at least four working days before November 13 for U11, after the section 3 drift check. Its stated gate OVD-206 is now Done in Linear, so the gate in the plan no longer blocks. | The fallback in the plan is the stated week of grace for flag on, not a Jarvis only window. The drift in section 3 is the real timing risk now, not OVD-206. |

## 11. What this draft does not claim

* No acceptance box of OVD-520 is met by this page. The connected run has not happened and `docs/release/ovd-520-run-evidence.md` does not exist.
* It does not prove the Jarvis chain applies to current production; section 3 shows the pins are stale against main's 153 migrations.
* The U8 launcher is absent, so Phase C and D mounting steps are requirements, not a procedure.
