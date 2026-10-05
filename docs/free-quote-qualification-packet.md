# Portable free-quote SQL qualification inputs

These inputs are authored and source-reviewed, not executed PostgreSQL evidence.
The application migration tree is the 133-file combined restored-original plus free-workflow reconstruction. The restored original130 migration files are byte-preserved; the reviewed free
meter, free access and lifecycle repair add three. Qualification files do not
change that application tree. Original tree f4384896 and partial e5f38df remain
preserved separately; original commit/history were not recovered.
The CI profile now replays 139 files: the 133-file contract tree plus six
reviewed appends, the OVD-536 audit-writer grant migration, the OVD-458
generic provider dispatch permit migration, the OVD-459 service-role
provider preflight migration, the OVD-598 legacy Xometry admission
row-lock migration, the OVD-601 empty job-file upload rejection migration, and the
OVD-628 generic admission row-lock migration. Each append is pinned by path,
issue, and SHA-256 in `scripts/free-quote-ci-profile.mjs` and the source
manifest. Candidate and free suites run after all 139 migrations. Baseline126
and the atomicity probe after migration132 and before migration133 are unchanged.

## Scope and source boundaries

- Public main 8d8d243 contains an unchanged 126-migration prefix of this candidate.
  Before/after fixtures compare that public-main source boundary with 133.
- The actual recorded live ledger contains 112 matching identities but is NOT a
  sorted prefix. Twenty-one candidate files are absent. Matching names/versions is
  not proof of deployed SQL byte identity. Fresh-full-head qualification is not
  production-upgrade qualification.
- The hash-verified archived worker receipt is
  f723dbd7fab38d24944bae70f989c31cabaab450a122d5fc6512ba8cdfafef5a.
  Worker fixtures use its exact old scope construction and compact column
  inventory with synthetic values, service_role and no user subject.
- Expected old-scope and publication incompatibilities are asserted and reported,
  not transformed into compatibility claims. Never weaken current safety rules
  or substitute a verified user to manufacture worker publication success.

## Standalone SQL inputs

Run `node scripts/generate-free-quote-fixtures.mjs --check` before packaging.
Three committed expanded fixtures inline only exact repository fixture includes
and preserve every assertion. They can be sent unchanged on psql stdin, without
host-relative includes, downloads, mounts or production records.

The native runner must enforce exact input hashes, clean committed source,
complete passing TAP, no skips/TODOs, bounded sessions and owned cleanup. Run the
13-assertion lifecycle atomicity probe strictly after migration132 and before133.
It catches only the expected deliberate P0001 after all DDL, then proves all five
new objects disappeared and no policy/admission was created. Earlier SQL errors
fail the assertion. It does not mistake a failed psql exit for proof of rollback.

The worker compatibility suites run at their declared baseline/candidate stages.
The publication control files have intentionally different expectations and must
not both run on the same schema stage. See worker-compatibility/README.md.

## Independent actors

The actor package is `supabase/fixtures/free_quote_lifecycle_races/races.json`.
Keep its order. A once-only raceSetupSql creates wholly synthetic fixtures. All
suites and races share one exclusively owned database; the fixed policy limit2
is never rewritten. Capacity cases use a real filler reservation; release-only
cases run next and two consumed-success cases run last.

Every contender and final verification emits complete TAP. Wait-before-release
cases require live backend-PID blocking proof on the actual relevant lock.
Complete-before-release cases require an independent lock probe blocked by that
same coordinator while the contenders finish, plus passing probe output after
release. Fixed sleeps alone do not prove overlap. No dblink or auth/password
workaround is used.

The eighteen-case source package expects eighteen receipts, two consumed, sixteen
released, zero holds, and thirty-six unchanged attempted-spend rows. This is an
expected result, not an observed one. The finer cross-held-result/cancellation
interleave, invisible internal scan timing, real network-loss behavior and
PostgREST embedding remain separate gaps; see the actor README.

## Runtime portability

SQL is host-independent. The previously reviewed cached Mac PostgreSQL17.6 image
and its authentic 68-auth/56-storage migration hashes are provenance only. A cloud
or CI executor must independently verify its actual engine, native platform
bootstrap/roles, extensions, isolation, session semantics and cleanup. Do not use
hand-made substitute auth/storage schemas or alter existing host/network/security
settings. No customer CAD, secrets, live provider/model calls, hosted database or
paid resource is needed.

A rootless official Debian PostgreSQL17.11 preparation demonstrated binary and
initdb capability but its server Unix socket was denied by that cloud sandbox.
No SELECT or application SQL ran there; the denied route was stopped. That event
is not equivalent to the cached-container qualification and cannot be counted
as a database pass.
