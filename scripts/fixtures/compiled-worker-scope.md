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
The existing SQL runner currently retains equality/authorization results rather
than these full replay pairs; capturing that packet is separate follow-up work.

The manifest binds the revision, packet, helper, tool versions, package/lock,
TypeScript configuration, source helper, SQL contract/fixture, and source/compiled
scope, dispatch preflight and persistence modules by SHA-256. It is an expected
artifact inventory, not a runtime dependency closure or signed attestation.
Only the pure scope module executes; the other modules are hashed, not exercised.
A future image qualification must independently collect and compare the files
inside the actual immutable image and perform its separately authorized checks.
Neither matching package versions nor this local manifest qualifies an image.
No SQL, provider, deployment, credential, or production operation is performed.
