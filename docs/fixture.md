# Fixture

Last updated: October 11, 2026

Fixture is the provider onboarding generator (OVD-687). One command covers
each of the three stages in [the provider integration lifecycle](provider-integration.md):

```bash
npm run fixture:onboard -- <key> --stage=envelope|live|admit [--url <https-url>] [--issue OVD-<n>] [--dry-run]
```

Fixture only writes files and runs `provider:sync`. It does not contact a
provider, read or create a credential, apply SQL, enable an adapter, deploy, or
admit anything. All
output is disabled and non-authoritative until a human reviews it and takes
the protected actions in `AGENTS.md`.

## Guarantees

- **Deterministic.** Output depends only on the checked-in tree, the key, and
  the options. Fixture never reads the clock or the network. Synthetic UUIDs
  are derived from the provider key, so fixtures for two providers never
  collide.
- **Idempotent.** Fixture never overwrites an existing file. On a rerun, a
  file with identical content is reported as `unchanged`, and a file a human
  has edited is reported as `kept` and left alone. The appended
  `worker/.env.example` block is keyed by a marker line and added at most once.
  An existing provider-registry entry is never changed, and `provider:sync`
  runs only when the envelope stage changed something. Re-running a stage is a
  no-op.
- **Fail-closed.** Each stage refuses to run before its prerequisite stage. It
  also refuses symlinked target directories and non-regular target files.
- **Dry run.** `--dry-run` reports the plan and writes nothing.

The JSON result lists `created`, `appended`, `unchanged`, and `kept` paths.

## Stage 1: `--stage=envelope`

`npm run provider:add -- --url <url>` is an alias of
`fixture:onboard --stage=envelope --url <url>`. The stage writes the same
files as the existing scaffolder: the manifest, plus the two disabled
review-only SQL stubs when the key is new.

It then adds the key's entry to
[the live-adapter registry](provider-integration.md#live-adapter-registry)
with `withDefaultRegistryEntry` (`liveAdapter: false`, `sessionSecrets: []`,
`egress: "none"`) and runs `provider:sync`, so `provider:check` passes. An
existing registry entry is never changed. The JSON result adds
`registryEntry` (`added` or `unchanged`) and `synced` (the regenerated
outputs, empty when nothing changed).

With a key and no `--url`, the stage requires the manifest; it only adds a
missing registry entry. If the key and `--url` disagree, it refuses. An
invalid registry refuses before any file is written.

## Stage 2: `--stage=live`

Requires all of the following:

- the manifest exists;
- the manifest has an evidence-backed CAD file envelope (`files.status = supported`);
- the key is in the worker's `LIVE_AUTOMATION_VENDORS`, which means the reviewed enum change has landed.

| Output | Purpose |
| --- | --- |
| `test-fixtures/provider-dispatch-envelope/<key>-v1.json` | Synthetic `provider-dispatch-envelope.v1` for `<key>-quote-envelope.v1`: one CAD file, no drawing |
| `worker/src/adapters/<key>DispatchAuthorization.ts` | `<KEY>_DISPATCH_ENVELOPE`, bound to the shared `providerDispatchAuthorizationDenial` |
| `worker/src/adapters/<key>ProductionPortal.ts` | Production portal definition on the provider portal kernel: `productionDispatch` declared, eligibility `unavailable` before any session read, no offers, placeholder routes, selectors, and locators |
| `worker/test-support/<key>DispatchFixture.ts` | Envelope and authorization builders built on `providerDispatchFixture` |
| `worker/src/adapters/<key>ProductionPortal.test.ts` | Default-deny suite built on `productionPortalDefaultDeny`. It also proves that an authorized dispatch stops before launch |
| `worker/src/adapters/<key>ProductionPortal.browser.test.ts` | `localPortalBrowserFixture` cases, in `describe.skip` until the locators are reviewed |
| `worker/.env.example` (appended) | Comment-only session-secret entry (`QUOTE_VENDOR_STORAGE_STATE_PATHS`, `<KEY>_STORAGE_STATE_SECRET_NAME`) with no value |
| `docs/workflows/<key>-live-readiness.md` | Readiness doc listing the remaining manual steps |

The live stage deliberately leaves these untouched:

- `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`;
- the adapter registry in `worker/src/adapters/index.ts`;
- the provider's entry in `provider-integrations/provider-registry.v1.json`.

Each of those changes stays a reviewed edit. To list the adapter for a live
deploy, make one reviewed edit to its registry entry (`liveAdapter`,
session-secret names, and `egress`), then run `npm run provider:sync`. Do not
hand-edit `runtimeSecrets.ts`, `deploy-cloud-run.sh`, or egress settings; they
read the registry's generated projections. Never edit generated files
(`worker/src/generated/providerRegistry.ts`,
`worker/scripts/generated/provider-secrets.sh`, or the provider catalogs);
`provider:check` fails on drift.

Once a provider's envelope is in `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`,
`provider:check` runs its `<key>ProductionPortal.test.ts` with vitest and fails
unless every test the shared `productionPortalDefaultDeny` registrar registers
is reported as passed (not skipped, todo, or missing). It also validates every
readiness doc path that exists: HTML comments are ignored, and each required
section needs real content ("None." is accepted for known gaps and inputs).

## Stage 3: `--stage=admit`

Requires the live stage's envelope fixture and authorization binding. Fixture writes the following
under `provider-integrations/<key>/admit/`:

- `<timestamp>_<key>_reviewed_dispatch_envelope.sql.review`: review-only SQL
  for the `private.provider_dispatch_envelope_reviews` row. It is named for the
  migration it would become.
- `<key>_admission_revision.sql.review`: the approved admission revision
  (`admission_state = 'approved'`, `generic_dispatch_enabled = true`). Admission
  is an operator action, never a migration. `<...>` placeholders keep the file
  from running as-is.
- `rollout-runbook.md`: the rollout block, covering the reviewed envelope,
  admission, the `automatic_quote_collection` rollout, organization
  enablement, the worker adapter and secret, the certification run, and
  rollback.

Nothing is written to `supabase/migrations`. The timestamp is the next free
one: one hour after the latest of the applied migrations and other providers'
pending `admit` review files. Once a review file exists, its timestamp is
reused, so a rerun stays a no-op after new migrations land. Re-check the
timestamp before moving the file into a migration. `--issue OVD-<n>` sets the
evidence reference. The default is `OVD-687`.

## Verification

```bash
npm test -- scripts/fixture-onboard.test.mjs scripts/provider-add.test.mjs
npm run provider:check
```

Running the live-stage output for a real key through `typecheck:worker`,
ESLint, and its generated tests is a quick end-to-end check. Delete the
output afterwards unless that provider's onboarding PR is meant to carry it.
