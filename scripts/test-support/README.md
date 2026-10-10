# Source-only Node/jsdom verification

This opt-in test guard keeps Node HTTP(S), native fetch, TCP/TLS connections,
and jsdom fetch/XHR/WebSocket/EventSource/beacon traffic on synthetic loopback
fixtures. Requests to other hosts fail before the transport/DNS boundary.
The guard never substitutes successful responses. Existing injected mocks remain
usable. No production application code is changed.

## Supported invocation

From the repository root, preload the guard in **every Node process** and opt
Vitest into its realm setup:

```sh
OVD_SOURCE_ONLY_TESTS=1 \
NODE_OPTIONS="--require=$PWD/scripts/test-support/source-only-network.cjs" \
npm test -- <reviewed-test-path>
```

Only run reviewed test paths whose actual transports are covered or explicitly
mocked. The full `npm run verify` includes uncovered browser/native/subprocess
lanes and is not certified safe or passing by this guard. The absolute preload
path is important when a permitted command changes working
directory for worker verification. Normal inherited `NODE_OPTIONS` covers npm,
Node subprocesses, Vitest forks, and Node worker threads. The conditional Vitest
setup runs before test modules and refuses to run when its process lacks the
preload. It installs the same guard in the later-created jsdom realm.

No aggregate pass is established by installing this guard. An unexpected remote
attempt remains a verification failure even when application code catches the
network error: Vitest's afterAll assertion fails, and the owning process's exit
handler forces a nonzero status. A run-scoped append-only local marker is inherited
by Node children and Workers, so ignoring their nonzero exits cannot make the
aggregate pass. The marker stores only the word `blocked` per violation, never
URLs/credentials. The first guarded process creates it under the OS temp directory
and sets `OVD_SOURCE_ONLY_NETWORK_MARKER` for descendants. Marker files are retained
for inspection; they are not deleted while children could still be writing. Explicit live/provider/remote integration tests
must remain blocked in this lane; add a scoped mock or obtain separate authority
for a different lane rather than weakening the guard.

## Regression checks (offline)

```sh
node --test scripts/test-support/source-only-network.node-test.cjs
node --test scripts/test-support/source-only-network-marker.node-test.cjs

OVD_SOURCE_ONLY_TESTS=1 \
NODE_OPTIONS="--require=$PWD/scripts/test-support/source-only-network.tripwire.cjs --require=$PWD/scripts/test-support/source-only-network.cjs" \
npm test -- scripts/test-support/source-only-network.test.mjs --maxWorkers=1 --no-file-parallelism
```

The second command can also use `--pool=threads`. The regression-only tripwire
loads **before** the guard under test and independently rejects all sockets
outside exact fixture hosts. Deliberately external-looking test URLs therefore
cannot create external traffic even if the guard regresses. The standalone Node
suite additionally replaces original transports with throwing spies for its
negative probes; actual-network tests bind exclusively to 127.0.0.1 and clean up
their disposable servers. Negative tests use `expectBlocked` only to distinguish
an asserted guard rejection from an unexpected application network attempt.

Coverage includes native fetch URL/Request inputs; HTTP(S) request/get overloads;
net/TLS entrypoints and ESM exports; jsdom XHR/WebSocket; injected mock restoration;
loopback hostname normalization; child/worker inheritance; actual loopback
HTTP/fetch/socket fixtures; redirects from loopback to a denied remote hostname;
and nonzero exit for application-caught, child-exit-ignored, and worker-exit-ignored denied attempts. The Vitest regression
suite is skipped when source-only mode is not requested.

To check the fail-closed setup without sending any request, run this command and
expect exit status 1 with the missing-preload error before any tests execute:

```sh
env -u NODE_OPTIONS OVD_SOURCE_ONLY_TESTS=1 \
npm test -- scripts/test-support/source-only-network.test.mjs --maxWorkers=1 --no-file-parallelism
```

## Scope and limitations

- This is a cooperative JavaScript test guard, **not** an OS/network-security
  sandbox. It does not change system network settings or grant new permissions.
- Literal 127/8, IPv6 ::1 and IPv4-mapped loopback are allowed. `localhost` is pinned
  to 127.0.0.1 (or ::1 with family 6), without DNS/custom lookup. Other aliases,
  private/LAN addresses, wildcard addresses and remote names are denied.
- Unix-domain sockets are allowed for local runner IPC. Loopback fixtures and
  local IPC endpoints must themselves be synthetic and not proxies to services.
- Native add-ons, direct DNS/UDP APIs, non-Node subprocesses (including Python,
  curl, Deno), real browser processes/Playwright, preconnected inherited sockets,
  and deliberately replacing/removing the guard are outside this boundary.
- A child process/worker that strips NODE_OPTIONS/the run marker or overrides
  bootstrap settings is not automatically covered; the Vitest setup detects a missing guard, but an
  unrelated child executable does not. Detached children outliving the aggregate
  also cannot be certified by the owner's earlier marker read. Audit subprocesses
  before execution; the marker does not extend the transport coverage.
- The preload must be first among application-loading preloads. Previously
  captured original transports or an earlier preload doing I/O are not covered.
- URL queries, credentials and headers are omitted from denial logs. A guard
  failure is evidence of blocked verification, never evidence of remote success.

## Subprocess surface audit

The ordinary suite includes `worker/src/recovery/browserRecovery.test.ts`, which
launches a real Chromium process. Its per-page abort route is installed after
launch and does not establish browser-process containment. Source-only setup fails
this suite before test-module execution. It similarly rejects the quote
integration/Fictiv live suites and the gcloud-help-enabled release suite
(`OVD419_VALIDATE_GCLOUD_HELP=1`). These tests are blocked/unrun, never passing;
separate reviewed isolation and authority are required to run those lanes.

Inspected fixture controls, separate from this guard's guarantees:

- `localProviderEvaluation.test.ts`: chromium.launch is a rejecting spy, asserted
  unused; provider work returns preflight outcomes from synthetic inputs.
- `camoufoxNoGeoip.test.ts`: Playwright and native Impit.fetch are explicitly
  mocked, with synthetic assets. The Node guard itself does not contain Impit.
- `deploy-cloud-run-contract.test.mjs`: bash receives a generated fake-gcloud
  executable via GCLOUD_BIN; no real provider call is intended.
- `qualify-ovd417-four-migration-suffix.test.mjs`: syntax-only checks and synthetic
  failing preflights use fixture supabase/docker/rg executables.
- `worker-package-inputs.test.mjs`: local hashing plus npm --offline,
  --ignore-scripts, --no-audit, --no-fund, a loopback registry and isolated cache.
  Its scrubbed child environment drops NODE_OPTIONS, so safety depends on those
  explicit offline controls, not this guard.
- `worker-build-version.test.mjs`: a Node child receives only a build-version
  environment and executes a source regex validator. It likewise lacks preload.
- `worker-geoip-input.test.mjs`: scrubbed-environment shell commands inspect only
  synthetic local filesystem trees.

This is not a comprehensive proof for arbitrary future shell helpers. Changes to
subprocesses, native transport libraries, browser launches or environment scrubbing
require a renewed source audit and may leave an aggregate verification blocked.

## Current validation status

The marker-enabled source passed syntax checks and the local-file-only marker
suite (3/3). An earlier revision passed 12 standalone Node transport regressions
and 5 Vitest/jsdom regressions. Subsequent guarded transport regression execution
was blocked by execution review, including its single evidence-backed retry;
those earlier results are **not** a pass for the current revision. No full
aggregate, native browser, provider, database or hosted verification was run as
part of this guard task. Do not rerun the denied probes through renamed targets or
another route. The Node/jsdom transport changes remain executable-test-blocked
until the review boundary is resolved.
