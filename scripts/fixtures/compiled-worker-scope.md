# Offline compiled worker scope evidence

Run from the repository root (Node 22 with type stripping and an already populated
npm cache):

```sh
node scripts/check-compiled-worker-scope.mjs \
  8d8d243513b928a59bd9d63858732dad50498f09 \
  scripts/fixtures/compiled-worker-scope.json /tmp/new-worker-scope-evidence
node --test scripts/check-compiled-worker-scope.node-test.mjs
```

The output directory must not exist. The helper exports the explicit Git revision,
uses its worker lock with `npm ci --offline --ignore-scripts`, and runs that locked
TypeScript compiler against its worker tsconfig. Missing cached dependencies fail
closed; there is no online fallback. Lifecycle scripts and the worker entrypoint
are never run. The source tree, compiled output, replay packet, and successful
manifest remain available for inspection. A failed build or comparison emits no
success manifest; use a fresh directory for a retry.

The retained packet reuses the first synthetic input in `worker/src/quoteScope.test.ts`.
It covers confirmed destination/revision with an active deadline, no active deadline
with legacy dates still present, and rejection without a confirmed destination.
Its expected results were captured from the pinned source helper, not a database.
The negative test changes the compiled confirmation revision while leaving the
package version unchanged and proves the comparison fails.

A replay packet has `sourceRevision`, `expectationKind` (`retained-source` or
`retained-sql`), provenance, and nonempty `cases` of `{name, input, expected}`.
`input` uses the JSON shape accepted by `check-sourcing-worker-scope.mjs`;
`expected` is the full `{scope: ...}` or `{error: ...}` result. To replay SQL
expectations, retain the synthetic SQL input and full SQL scope together from the
same revision's isolated SQL fixture run, including its receipt identity in
provenance. Do not relabel source-generated expectations as SQL observations.
The disposable `ovd570-minimal-rehearsal.mjs` now retains four full SQL pairs in
`ovd570-worker-scope-replay.json`. Run the existing owned synthetic fixture from
a clean committed checkout:

```sh
node scripts/ovd510-disposable-replay.mjs --ovd570-minimal-112
```

Before any Docker operation, this mode rejects dirty tracked source and exports
the complete pinned Git revision into a private read-only directory. All baseline
migrations, fixtures, tests, JS helpers and worker source execute/read from that
export. Edits to the original checkout after admission cannot affect the run.
The export is verified against Git blob IDs, inventoried by SHA-256, checked again
before acceptance, and removed after owned fixture cleanup. It is process-owned
filesystem isolation against checkout drift, not a boundary against an attacker
with the same OS identity or root. Non-OVD570 modes retain their prior behavior.

`source-manifest.json` binds every tracked exported file (a conservative superset
of executed source inputs), plus the separately hash-pinned CLI archive when that
mode is selected. Platform SQL copied from cached images is captured once in
memory and hashed; later receipt-file edits cannot change those executed bytes.
`submitted-inputs.json` records SHA-256 and byte length of each exact Docker stdin
submission, including generated SQL, without retaining raw ephemeral credentials.
Its hash and the full source manifest hash are bound into the final result.
The success receipt is published only after final snapshot verification.

Its printed `result.json` path identifies the receipt directory. Require that
result to pass with all owned resources removed, then use the sibling replay
packet with the compiled helper and the packet's exact `sourceRevision`. The
sibling `ovd570-minimal-proof.json` binds the packet SHA-256; the fixture manifest
binds pinned image IDs and baseline migration hashes. Capture provenance includes
source file hashes and a timestamp. These observations are a fresh synthetic SQL
run, separate from the earlier executor/CLI receipts at `efb1b26a`.

The four cases cover initial confirmation without an active deadline, a different
confirmed address, restored address with a new confirmation revision, and a
confirmed active deadline. Raw `sqlScopeText` is retained alongside parsed
`expected.scope`: JSON parsing normalizes numeric scale, so semantic scope equality
must not be represented as identical PostgreSQL fingerprint bytes. Existing
rehearsal authorization/scale checks remain authoritative for that distinction.
The replay helper still reports `sqlExecuted: false` because replay itself does
not contact a database; `expectationKind: retained-sql` identifies the separately
captured SQL observations.

The manifest binds the revision, packet, helper, tool versions, package/lock,
TypeScript configuration, source helper, SQL contract/fixture, and source/compiled
scope, dispatch preflight and persistence modules by SHA-256. It is an expected
artifact inventory, not a runtime dependency closure or signed attestation.
Only the pure scope module executes; the other modules are hashed, not exercised.
A future image qualification must independently collect and compare the files
inside the actual immutable image and perform its separately authorized checks.
Neither matching package versions nor this local manifest qualifies an image.
No SQL, provider, deployment, credential, or production operation is performed.
