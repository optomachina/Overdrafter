# Synthetic release rehearsal source

This runner is the OVD-658 source implementation for OVD-635. Its default command
only reads public source files and prints a plan. Source and fake-process tests do
not establish SQL, platform bootstrap, migration, concurrency or recovery proof.
Actual execution requires separately supplied cached prerequisites and an exact,
expiring controller admission. Hash equality does not grant runtime permission.

The data candidate is `bbd78c05e726ce55f4fff1e4fd5fdec7bdd33f3b`: **139** migrations
and **174** closed-profile inputs. Runner source has its own revision/admission;
its checkout need not equal the historical candidate. The profile JSON SHA-256 is
`58404b1a4747e141df1a18e4615b5e52027815d3bc1a5e288e61eef2bb440713`.
No owner ledger, production endpoint, private baseline or customer record is used.

## Public bundle and default plan

Use a canonical absolute bundle directory containing the exact profile at
`scripts/fixtures/free-quote-ci-source.json`, every relative path in its `files`
map, and `synthetic-baseline.json`:

```json
{"schema":"overdrafter.synthetic-baseline-ordinals.v1","ordinals":[1,2,3]}
```

The abbreviated array above is illustrative, not executable: the admitted array
is exactly the integers **1 through 128 inclusive, followed by 134**. It must be
written in full. Other recipes and ledger-shaped inputs are rejected. This is a
new synthetic fixture recipe, not an approximation of the private 112-row ledger.
It is non-prefix because 134 is present while 129–133 are absent; fault129 remains
pending. All files must be regular, canonical, non-symlink paths with matching
hashes. Extra/missing manifest entries or changed bytes fail closed.

```sh
node scripts/release-rehearsal/run.mjs --bundle /absolute/public-bundle
```

No adapter is imported or constructed by this default command. The printed plan
has `runtime:not_run`; it does not write an evidence directory. It binds the exact
canonical, baseline and absent order plus plan/profile hashes.

### Why this synthetic baseline is proposed

Migration134, `20261003150000_ovd536_restrict_audit_event_writer.sql`, checks and
changes privileges on the existing `public.log_audit_event(uuid,text,jsonb,uuid,uuid)`.
That SECURITY DEFINER helper is defined by migration2
`20260303101500_curated_cnc_quote_platform.sql`; its referenced `public.jobs` and
roles precede128. Static inspection of129–139 found helper calls in131 and138,
with no later helper replacement or grant contradicting134. Thus134 can be
proposed after128 without importing the private owner snapshot. This is dependency
reasoning only: its explicit guards or authentic platform state can still reject
it. An actual baseline failure is retained as failure; the runner never fabricates
ledger rows or claims the non-prefix case passed without applying this recipe.

## Execution input and admission

[fixture-preparation.md](fixture-preparation.md) specifies cached tools, immutable
image identity, authentic68auth/56storage SQL, clean environment, session and
resource ownership. The runner acquires nothing. In addition to the public bundle,
execution needs:

- `platform-manifest.json`, with SHA-256
  `5513f6b047d5519bc8b381803b3caf483070180b88b24b486a9c1f1486315a78`;
  exact platform files at `platform/auth/<name>` and `platform/storage/<name>`.
- Exact `scripts/free-quote-ci-profile.mjs`, SHA-256
  `3e91b9e2dc4ff47c0531a0a3c54b5f8e41cb6b5458f08b68824fc8f5565c89c6`.
- The five original race helper modules listed by `RACE_HELPER_PINS` in `run.mjs`.
  These independently pinned executable helpers are outside the unchanged174-file
  data closure. Their hashes and the race profile are also checked by the adapter
  and race bridge before importing the copied helpers.
- `runtime.json` containing the adapter's `tools`, `image`, `session`,
  `parentDirectory`, and `admission`, plus the runner admission below. It cannot
  override sourceFiles, plan, catalog, platform or races. No URL/env/shell input is
  exposed. CLI2.78.1 is checksum-bound and actually checked inside the cached image;
  absence or ABI failure blocks the run.

The `runnerAdmission` object has schema
`overdrafter.release-rehearsal-runner-admission.v1`, `sourceCommit` equal to the
candidate, exact `planSha256`, `profileSha256`, `recovery:"synthetic-rebuild-v1"`,
and a future ISO `expiresAt`. Its `files` array contains `{path,sha256}` for exactly
`adapter.mjs`, `catalog.sql`, `core.mjs`, `races.mjs`, `run.mjs`, in that order,
hashing the actual colocated files. Its `helperFiles` array contains the five
`{path,sha256}` entries from `RACE_HELPER_PINS`, sorted by path. The controller
retains the runner Git revision separately from the data candidate and approves
these exact bytes. Runtime module admission is checked before importing the
adapter; source modules and receipt checks are not a security sandbox.

The fresh evidence directory must be inside a canonical caller-owned mode0700
parent. The runner writes mode0600 `report.json`; the adapter retains its own
private command/resource evidence under its admitted parentDirectory.

```sh
node scripts/release-rehearsal/run.mjs --bundle /absolute/public-bundle \
  --execute --evidence /absolute/private-parent/new-run
```

SIGINT/SIGTERM abort active owned commands/races, then run bounded owned cleanup.
Ownership mismatch or unconfirmed removal is failure. SIGKILL/host loss cannot
promise cleanup: retain resource IDs and reconcile through the owner contract.

## Separate observations and replay phases

Each target is a separate fresh cluster, including roles and default privileges.
At most two owned database containers coexist. SQL apply uses actual Supabase CLI
`db push --include-all`; every batch first admits its exact dry-run pending list.
The staged directory always contains the full local history needed for that
batch, including already-applied baseline files. An absent-only directory cannot
represent this CLI operation. The report preserves staged hashes, expected order,
actual dry-run/apply receipts and ledger snapshots. Sorted ledger rows establish
membership, not chronology; the separate invocations establish intended ordering.

1. **R1:** one canonical full139 batch on one target; baseline129-files then full139
   with the ten absent files pending on another. Compare named catalog/role/ACL
   semantics independently from actual CLI `version/name/ordered-statements` rows.
   Migration byte hashes are never substituted for recorded statements. These
   targets receive no pgTAP/race fixture mutations.
2. **R2 reference:** independently apply the same baseline then uninterrupted absent
   sequence and freeze its full observations plus source/plan/admission binding.
3. **R2 faults:** each fresh target receives the same baseline, then a copied
   migration129 with one exact deliberate P0001 marker before the file, inside its
   explicit transaction before terminal COMMIT, or after COMMIT before the CLI's
   history insertion. The original139 files stay unchanged. Require the exact
   error marker/SQLSTATE, an observed integer exit code1–255 with explicit null
   signal and transport-failure fields, and fresh-connection ledger/catalog
   observations. Unconfirmed, signalled or failed transport exits cannot pass a
   fault boundary even when the expected diagnostic arrived before termination. The post-COMMIT case must
   expose `private.capability_runtime_revisions` without its ledger row; before/
   in-file cases must preserve the pre-file catalog. Ledger-only classification
   never authorizes retry.
4. **Synthetic rebuild recovery:** freeze/hash failed observations; preserve the
   failed target. Remove and verify absence of the reference target before creating
   a fresh rebuild beside the failed target. Rehash originals, replay the same
   baseline/full sequence and compare actual ledger statements and named catalog
   against the immutable independent reference. Never retry, repair or replay the
   dirty target:129 starts with unconditional CREATE TABLE. A rebuild failure ends
   the sequence without retry. This proves only a separately executed synthetic
   rebuild when runtime evidence exists, not in-place fix-forward, historical
   restoration or production recovery.
5. **Closed profile:** use a separate canonical target. Install pgTAP before126;
   run the four baseline suites after126; lifecycle-atomicity after132 and before
   133; apply133 as a contract boundary without inventing a test there; finish139,
   candidate precheck, four candidate suites, three expanded free-quote TAP suites,
   and the exact18 independent-session races in one batch. Stage checks cannot be
   replayed blindly at final head. SQL exit0 alone is insufficient: TAP must have a
   positive complete plan and sequential passing assertions. Scalar/JSON setup rows
   from the pinned SQL may interleave with TAP; malformed TAP, failed assertions,
   bailouts and actual `# SKIP`/`# TODO` directives are rejected. Description words
   such as `SKIP LOCKED` are ordinary assertion text. Psql transport/exit success
   remains a separate prerequisite and is never inferred from TAP output.

Race acceptance checks all18 named results, source/manifest hashes, distinct
observed session PID/backend-start identities, actual blocking observations,
framed TAP output, normal exits, observer-confirmed absence and the fixture
owner's final backend inventory after observer exit. Serial SQL or elapsed delays
cannot satisfy it. Psql-measured session identity and source-inferred CLI identity
remain distinct: `directCliSessionObserved:false`. Archived worker compatibility
also remains separately unqualified; neither synthetic SQL success nor source
checks substitute for that proof.

## Catalog and verification limits

`catalog.sql` runs in a read-only transaction. It extracts named schemas/types,
roles/memberships, relation definitions/column grants/indexes/triggers/sequences,
function overload definitions/owners/grants, policies and default privileges.
ACLs preserve null versus explicit empty, named grantor/grantee/PUBLIC, privilege
and grant option. Role passwords and application rows are excluded; generated
OIDs are not cross-cluster identities. CLI ledger rows are a separate observation.
Core rejects duplicate named identities and incomplete declared category coverage.
This is a bounded semantic extractor, not an exhaustive PostgreSQL catalog audit
or proof of runtime schema correctness from its SQL text alone.

```sh
node --test scripts/release-rehearsal/*.node-test.mjs
```

These tests use invented inputs and fake owned processes only. Injected runner
transports always produce `mock-only` qualification even when all gates pass;
there is no JSON/CLI test override. Real-source plan smoke and mock receipts must
be retained separately from future executed database evidence. Until prerequisites,
actual stage SQL/races, boundary observations and cleanup succeed, R1/R2/profile
runtime qualification remains unperformed or blocked, never borrowed from CI or
another source revision.
