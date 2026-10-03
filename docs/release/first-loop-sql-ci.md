# First-loop SQL CI source integration

This is a separate, default-off source preparation route. It does not modify the release owner's PR564, start a platform, install a runtime, apply SQL, grant authority, create credentials, or contact a database. The manually dispatched `Jarvis SQL source packet` workflow runs only when `prepare=true`. It uses an Ubuntu runner's existing Python and Git, generates the exact fixture, and uploads a source artifact. No provider extraction job is involved. No workflow has been dispatched for this change.

## Artifact and canonical migration preparation

```sh
python3 scripts/prepare-first-loop-sql-ci.test.py
python3 scripts/prepare-first-loop-sql-ci.py --output /tmp/jarvis-sql-source
```

The destination must not exist. The builder compares every input byte with reviewed commit `f4f0a087f041078244bbb28e081fe96d6418d036`; drift fails before copying. It includes every maintained application migration from that revision, the exact staged sources, reader source and generator, observer JSON, and complete fixture fragments. `manifest.json` binds every packaged file by SHA-256 and byte count and records all execution verdicts as `unrun`. A preparation error leaves its partial directory for diagnosis; do not consume it without a manifest. Choose a new destination for a corrected attempt.

The exact reviewed generated fixture is 44,294 bytes, SHA-256 `f2909462eaf02d28b3fbd268e95fc6c384a19c3b80e265611b882eea5116a75d`. Its synthetic filesystem strings are lowercase `C:\fixture\input` and `C:\fixture\candidate`, both volume serials `0000000000000001`, with file IDs of 32 `1`s and 32 `2`s respectively. The earlier general documentation example uses different strings and produces a different digest; the builder uses the reviewed bytes.

For an owner-controlled runner with **already installed** Supabase CLI 2.78.1:

```sh
python3 scripts/prepare-first-loop-sql-ci.py --canonical --output /tmp/jarvis-sql-canonical
```

The optional path checks the version, discovers `migration new --help`, and calls `supabase migration new` for eight distinct stubs inside the newly owned artifact directory. Each gets its exact staged SQL bytes. The CLI supplies timestamps; no timestamp is invented. No historical migration is changed. These stubs are review artifacts, **not a deployable migration chain**. Do not drop them into the release migration directory or run `db reset`/`migration up` over them. They preserve explicit transactions and distinct runner requirements; the maintained phase-aware adapter below supplies the source integration, while actual fixture qualification remains unrun.

| Order | Purpose | Required runner |
| --- | --- | --- |
| 0 | OVD558 verifier authority, pinned catalog and existing runner preflight | `supabase_admin`, superuser |
| 1 | OVD560 seven-role result registry | `postgres` |
| 2 | OVD561 finalization schema | `postgres` |
| 3 | Pending finalization durable replay envelope | `postgres` |
| 4 | OVD575 observer idempotent replay replacement | `postgres` owner |
| 5 | Immutable input/output mapping tables | `postgres` owner |
| 6 | Trusted preclaim input and poststop output mapping writers | `postgres` owner |
| 7 | Independently admitted result filesystem binding | `postgres` owner |

Pending finalization is needed by the composed runtime; this first-loop SQL fixture does not exercise finalization or pending replay. It creates no receipt key.

## Exact execution prerequisite and acceptance

OVD558's pinned catalog and runner checks must remain byte-identical. Its historical authority qualification baseline and subsequent compatibility phase are specified in `ovd-561-finalization-contract.md`; the complete current migrations are packaged for diagnosis, **not evidence that applying OVD558 after all current migrations can succeed**. OVD558 also resets role. A combined migration or a single assumed runner cannot satisfy the chain. A catalog mismatch, `ovd558_runner_or_object_preflight_mismatch`, or missing pre-authorized role transition is a blocked prerequisite, never a reason to patch the hash or add grants.

The maintained adapter described below now provides the phase-aware source path over the existing exclusively owned cached-image fixture: exact historical baseline bootstrap, unchanged OVD558 authority proof under its admitted runner, maintained compatibility expansion to complete current schema, then remaining reviewed stages under their admitted identities. That source path has inert regression evidence; no compatible runtime has been observed or executed in this task. The existing broad CI `supabase start` route is not silently substituted: it can pull images, create more resources than this task's fixture cap, and does not establish the pinned OVD558 catalog.

Once the maintained lifecycle and its existing identities are admitted for actual execution, the owner must:

1. Verify the artifact manifest and retain source revision, fixture resource/image IDs, run ID, tool versions and timestamps. Admit no network database target, credentials, schema stubs or pre-existing resource deletion.
2. Retain each stage's exact SQL hash, actual `current_user`, exit code, complete output, and unchanged preflight result. SQL invocations use `psql -X -v ON_ERROR_STOP=1`; CLI 2.78.1 has no `db query`. Enforce the owner's overall 30-minute runner ceiling in addition to SQL statement/lock bounds.
3. Confirm the fixture's existing `postgres` identity can `SET ROLE ovd575_observer_validator` and `ovd576_stop_validator` without adding membership. Missing access yields a separate failed access receipt.
4. Execute `first-loop.sql`. Require real claim `claimed`, checked stop `process_stopped` with `awaiting_result` and result eligibility, three mapped input IDs, seven mapped and registered output roles, reader positive and negative checks, diagnostic `first_loop_fixture_ids`, complete passing pgTAP output and final rollback. Any exception, `not ok`, bailout, missing TAP plan, truncation or deadline fails; exit zero alone is insufficient.
5. Independently confirm rollback removed all synthetic `50100000-0000-4000-8000-*` rows and `mapping-synthetic` bucket and that fixture lifecycle cleanup removed only its owned resources. Preserve access, SQL runtime, rollback, resource cleanup and transport receipts separately. A source artifact never supplies these receipts.

Storage object bytes/HTTPS, concurrency, finalization/cumulative successor, PowerShell and native CAD remain separate acceptance tasks. Source/generator passes qualify none of them.

Official CLI reference: https://supabase.com/docs/reference/cli/supabase-migration-new . The changelog index was unavailable during source review; no new CLI behavior is assumed, and runtime command help remains mandatory.

## Maintained local adapter (source prepared; runtime unrun)

The optional `--first-loop-packet=/absolute/packet` hook now runs the exact fixture
inside `ovd561_seed`, after unchanged historical OVD558/560/561 authority phases,
current-source compatibility suffix, verifier allowlist and finalization behavior.
The existing fixture owner still owns bootstrap, admitted identities, bounded
resources and cleanup. It does not attach to a workstation or production database.
The adapter adds no grants, credentials or authority pins. Preparation now retains
the unchanged f4f0a08 runner under `source/`, while `control-source/` separately
binds the current maintained runner, clone hook, adapter and offline baseline.

The frozen baseline list is recovered from the exact historical GitHub tree
`d285c1cf097e196ec5a08453eaad7882a53e69dd` at commit
`000d82a323d887414eb86f1dfe7d105c0b5a776c`. Every Git blob and the complete ordered
SHA-256 manifest must match the **existing** reviewed migration-manifest pin.
No historical local Git object, inferred date cutoff or regenerated pin is used.
OVD558's actual runner and catalog checks are unchanged.

Source-only checks (no runtime discovery):

```sh
node --test scripts/first-loop-local-sql.node-test.mjs
python3 scripts/prepare-first-loop-sql-ci.test.py
python3 scripts/prepare-first-loop-sql-ci.py --output /tmp/jarvis-sql-source
```

For the separately admitted maintained fixture lifecycle only, the exact proposed
invocation is:

```sh
node scripts/ovd510-disposable-replay.mjs \
  --docker-executable=/absolute/path/to/existing/docker \
  --durable-migration --ovd561 --reviewed-authority-baseline \
  --first-loop-packet=/tmp/jarvis-sql-source
```

This command **operates the whole existing disposable fixture lifecycle**, not
just a read-only adapter. It creates the runner's ephemeral fixture resources and
fixture credential; it must not be run under a source-only/no-credential task.
No command was run here. Missing cached pinned images or existing role transition
access fails; do not pull, install, grant or change security to make it pass.
Linux CI can supply its already admitted absolute Docker executable. No GitHub
job starts this runtime automatically.

`first-loop-events.json` retains ordered intent/outcome events with source/fixture
IDs, exact original and executed SQL digests, timestamps, actual identity marker,
exit code and bounded complete output. Parent manifest/resources files bind image,
container/network IDs and source revision. Unknown response or overflow stops the
phase without replay; parent resource cleanup remains the recovery boundary.
Access is checked before staged application. Full fixture execution requires one
complete numbered passing TAP plan (no TODO/skip/bailout) and the actual unaligned
JSON diagnostic, followed by an independent full-row digest snapshot comparison
for all ordinary public/engineering_private/storage/auth relations. A TAP failure still
collects the rollback snapshot; transport loss/deadline does not claim rollback.
The fixture owner's `result.json.cleanup` remains a separate required verdict.
No SQL runtime, Storage object bytes, HTTPS, Windows or CAD qualification follows
from these source tests.
