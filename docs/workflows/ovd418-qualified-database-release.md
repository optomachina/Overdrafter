# OVD-418 qualified database release

This runbook governs the production application of the exact four-migration
suffix qualified by OVD-417. It is production-capable tooling, not permission
to execute it. Every production window requires a separately reviewed, exact,
single-use authorization JSON whose SHA-256 is supplied out of band. Local
tests and qualification never contact a hosted target.

## Frozen release package

- Repository: `optomachina/Overdrafter`
- Production project ref: `ozuatdcakezjtevztjlr`
- OVD-417 source: `5c3b6864e63ada75561f4ff7019bde70962d6e39`
- Supabase CLI: `2.78.1`
- Database client image:
  `public.ecr.aws/supabase/postgres@sha256:a554cd5d22208934b1b282a17fd68dca8f3fa8b8bda3a59949fbdd37cd2cd144`
- Production baseline ledger: 100 rows through `20260817054500`, fingerprint
  `cbfe91f6f12e00e514b12a22f9fd65fc`
- Final ledger: 104 rows through `20260822213330`, fingerprint
  `28b8ae8752e5beb8e91505a2becfde86`

Production continuity is independently anchored by the exact 99-row OVD-373
prefix through `20260816015500` with fingerprint
`003aabeb74c993bd942f5d59b29855ac`, its original 74-row subset with
fingerprint `7aeeca99fe188de2b537f14dd9c068fa`, and migration
`20260817054500` with statement hash `6529bf2c47a30ea1fe72a710cb279246`.
The locally rehearsed OVD-417 fingerprints beginning with
`5dabebda8a0fc1a3cf697e00de64418b` and ending with
`6dd6911df342f253a303e837d8881f7a` describe a different historical
`schema_migrations.statements` representation. They remain valid local
qualification evidence but are forbidden in OVD-418 production authorization,
classification, and postconditions.

The ordered migration SHA-256 values are frozen in
`docs/release/ovd-417-four-migration-manifest.json`. The runner calls the
OVD-417 head verifier before any provider or database operation. It never uses
a linked default, history repair, seed application, dashboard SQL, or an
unqualified migration file.

## Release-state decision table

| Exact observed state | Admitted action |
| --- | --- |
| Baseline — 100 rows, `cbfe91f6f12e00e514b12a22f9fd65fc` | Apply the exact four-migration plan |
| Partial-one — 101 rows, `afd38476b7e3e36d482511dda800697b` | Resume with the exact remaining three migrations |
| Final — 104 rows, `28b8ae8752e5beb8e91505a2becfde86` | Run post-audit only |
| Partial-two, partial-three, drift, extra, duplicate, or unreadable | Stop for incident review |

An interrupted apply makes no automatic recovery assumption. Preserve the
private evidence directory and locks/credential cleanup result. A subsequent
authorized invocation re-reads the live aggregate ledger and admits only the
transition from the preaudited baseline to exact partial-one, or a preaudited
partial-one that remains exact partial-one.

## Required containment

Before a production window, separately prove and preserve:

- rollout controls remain disabled;
- billing self-service remains disabled;
- database work, quote requests, quote runs, and vendor quote results are
  quiescent;
- every captured Cloud Run Job execution is complete with a zero running count;
- the production target, TLS root, five-minute database credential, clean
  merged deploy commit, CLI, image, source, hashes, and migration heads are
  exact;
- a new mode-`0700` private evidence directory exists outside every linked
  worktree and repository root;
- the authorization, CA, billing, execution inventory, client readback, and
  advisor captures are regular non-symlink mode-`0600` files.

The lock holder serializes with the OVD-373 deployment mutex, an OVD-418
release mutex, and all four commercial rollout mutexes. The precondition and
postcondition clients also set `default_transaction_read_only=on`. The only
database mutation path is the explicit `apply` subcommand's exact
`supabase db push --db-url ... --include-all --yes` command.

The preaudit creates a private schema/application-data/ledger backup and
restores it into the pinned disposable database image without publishing a
host port. Customer rows and identifiers are allowed only inside those private
backup files. Ordinary evidence is aggregate-only, and the runner never prints
or exports customer records. Restore credentials are temporary mode-`0600`
files removed with the disposable restore container.

## Single-use authorization JSON

Create the authorization outside every Git checkout, set mode `0600`, replace
`<merged-deploy-sha>` with the final reviewed 40-character merge SHA, and do
not add keys. Exact ordered migration filenames and hashes must match the
verifier. Only schema version 2 with the production continuity and state table
below is admissible. Schema version 1 and every authorization containing the
OVD-417 local-rehearsal fingerprints are invalid.

```json
{
  "schemaVersion": 2,
  "issue": "OVD-418",
  "repository": "optomachina/Overdrafter",
  "projectRef": "ozuatdcakezjtevztjlr",
  "deployCommit": "<merged-deploy-sha>",
  "sourceCommit": "5c3b6864e63ada75561f4ff7019bde70962d6e39",
  "supabaseCliVersion": "2.78.1",
  "productionLedger": {
    "continuity": {
      "ovd373Prefix": { "count": 99, "head": "20260816015500", "fingerprint": "003aabeb74c993bd942f5d59b29855ac" },
      "ovd373OriginalSubset": { "count": 74, "fingerprint": "7aeeca99fe188de2b537f14dd9c068fa" },
      "row100": { "version": "20260817054500", "statementHash": "6529bf2c47a30ea1fe72a710cb279246" }
    },
    "states": [
      { "name": "baseline", "packagePrefixLength": 0, "count": 100, "head": "20260817054500", "fingerprint": "cbfe91f6f12e00e514b12a22f9fd65fc" },
      { "name": "partial-one", "packagePrefixLength": 1, "count": 101, "head": "20260817133902", "fingerprint": "afd38476b7e3e36d482511dda800697b" },
      { "name": "partial-two", "packagePrefixLength": 2, "count": 102, "head": "20260821223849", "fingerprint": "426163fe8a2018efdcb2f68d2313cd5c" },
      { "name": "partial-three", "packagePrefixLength": 3, "count": 103, "head": "20260821223851", "fingerprint": "890880853621b1fb13672ccb53ac4848" },
      { "name": "final", "packagePrefixLength": 4, "count": 104, "head": "20260822213330", "fingerprint": "28b8ae8752e5beb8e91505a2becfde86" }
    ]
  },
  "migrations": [
    { "version": "20260817133902", "filename": "20260817133902_add_quote_provider_admission_registry.sql", "sha256": "331ee2d9282142ab7134f179a9b7d8b93ce64027ad6d909c0a183a2874a64d2b", "statementHash": "a677a4b306432cd85c225d98636c94ff" },
    { "version": "20260821223849", "filename": "20260821223849_add_emachineshop_manual_vendor.sql", "sha256": "0e2981089cf0a0d32de2c5a147cc59603269e27be37eb59a4574e677a4aae0f0", "statementHash": "81623dd84a77346330a2d19bf7ebaef7" },
    { "version": "20260821223851", "filename": "20260821223851_configure_emachineshop_manual_vendor.sql", "sha256": "18130f708bff981e7eb8ce5100baa0031ed89904c89918f47a9cc6ce94c8ec09", "statementHash": "0672fc05ac550161f3d8e38456733dd2" },
    { "version": "20260822213330", "filename": "20260822213330_add_vendor_quote_offer_geographic_origin.sql", "sha256": "65acdfaff16524eda49f15544989662b52c9dba44e4fd18ba538ca2052d1dc86", "statementHash": "0106d03b4a0f9df99d670294d7c3d405" }
  ],
  "commands": {
    "preaudit": "bash scripts/run-ovd418-production-release.sh preaudit",
    "apply": "bash scripts/run-ovd418-production-release.sh apply",
    "postaudit": "bash scripts/run-ovd418-production-release.sh postaudit"
  },
  "recovery": { "baseline": "apply", "partialOne": "resume", "final": "postaudit", "other": "incident-review" },
  "evidenceBoundary": {
    "customerRows": "private-backup-only",
    "customerIdentifiers": "private-backup-only",
    "secrets": "private-only",
    "aggregateCounts": "private-only"
  },
  "singleUse": true
}
```

The first preaudit atomically writes `<authorization-file>.used`. Apply and
post-audit require that marker, the same authorization hash, deploy commit,
and evidence directory. Never delete or replace the marker to reuse an
authorization. The failed preaudit consumed its authorization even though no
migration was applied. After that failure, or any later preaudit stop after
consumption, prepare and approve a fresh schema-version-2 authorization with a
new exact file hash after incident review. Never revise, replace, or reuse the
old authorization or its marker.

## Environment and commands

The governed OVD-373 temporary-access helper fixes the pgpass path. Obtain it
locally before the window with
`node scripts/manage-ovd373-temporary-db-access.mjs path`; do not place a
password in an environment variable or URL. Set these paths without printing
their contents:

```bash
export OVD418_AUTHORIZATION_FILE=/private/ovd418-authorization.json
export OVD418_AUTHORIZATION_SHA256=<exact-sha256>
export OVD418_DEPLOY_COMMIT=<merged-deploy-sha>
export OVD418_EVIDENCE_DIR=/private/ovd418-release-evidence
export OVD361_PRODUCTION_PGPASS_FILE=<governed-fixed-path>
export OVD361_PRODUCTION_CA_FILE=/private/production-ca.crt
export OVD418_BILLING_DISABLED_ENV_FILE=/private/billing-disabled.env
export OVD418_CLOUD_RUN_INVENTORY_FILE=/private/cloud-run-executions.json
export OVD418_CLIENT_READBACK_FILE=/private/client-readback.json
export OVD418_SECURITY_ADVISOR_FILE=/private/security-advisor.json
export OVD418_PERFORMANCE_ADVISOR_FILE=/private/performance-advisor.json
```

The Cloud Run inventory and advisor files are private, pre-captured inputs;
the database runner does not invoke cloud CLIs. Every capture names the exact
project, has a parseable `capturedAt` no more than ten minutes old, and uses a
normalized `findings` or `executions` array. The Cloud Run capture is fixed to
project `overdrafter-worker-9133`, region `us-west1`, and Job
`overdrafter-xometry-auth-probe`; every listed execution must be complete with
zero running instances. The client readback similarly includes `capturedAt`
and is an exact zero-row `GET` schema-cache proof for
`vendor_quote_offers.geographic_origin` and the provider-capability fields,
not a customer-data query.

Normalize those captures to these shapes before hashing/authorization. The
timestamp examples are placeholders, not reusable evidence:

```json
{
  "project": "overdrafter-worker-9133",
  "region": "us-west1",
  "job": "overdrafter-xometry-auth-probe",
  "capturedAt": "2026-08-24T00:00:00.000Z",
  "executions": [
    { "metadata": { "name": "<private-execution-name>" }, "status": { "completionTime": "<timestamp>", "runningCount": 0 } }
  ]
}
```

```json
{
  "projectRef": "ozuatdcakezjtevztjlr",
  "capturedAt": "2026-08-24T00:00:00.000Z",
  "method": "GET",
  "queries": [
    { "resource": "vendor_quote_offers", "select": "geographic_origin", "limit": 0, "status": 200 },
    { "resource": "vendor_capability_profiles", "select": "vendor_name,process_types,materials,domestic_us", "limit": 0, "status": 200 }
  ]
}
```

Each advisor capture uses
`{"projectRef":"ozuatdcakezjtevztjlr","capturedAt":"<timestamp>","findings":[]}`;
retain the actual normalized findings array privately for review.

Run each separately authorized phase from the exact clean merged commit:

```bash
bash scripts/run-ovd418-production-release.sh preaudit
bash scripts/run-ovd418-production-release.sh apply
bash scripts/run-ovd418-production-release.sh postaudit
```

Preaudit holds all locks while it verifies quiescence, captures and restores
the private backup, classifies the ledger, and records two byte-identical exact
dry-runs for any apply path. Apply rechecks every mutable boundary, repeats two
byte-identical exact dry-runs immediately before the push, proves the final
ledger, and verifies that the offer total did not change and every preexisting
offer was initialized to `unknown`. Post-audit is read-only: it verifies the
OVD-379, OVD-199, and OVD-408 catalog/ACL contracts, zero-row client readback,
advisor evidence hashes, final schema with comments, quiescence, and unchanged
offer aggregates. It creates no synthetic row and invokes no reconciliation or
other mutating RPC.

Failed apply and post-audit invocations retain numbered mode-`0700` attempt
directories. A retry never overwrites their evidence. Exact baseline and
partial-one may continue through a new attempt; an exact final state is
verified and routed to post-audit. Any other ledger state remains an incident.

OVD-206 promotion remains blocked until this runbook completes, the private
evidence has been reviewed, and its own dependency and authorization gates are
satisfied.
