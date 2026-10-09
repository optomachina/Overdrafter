# Cached platform SQL extraction (OVD-659)

This source-preparation command copies authentic platform SQL from **already cached,
immutable images** into a new private bundle. It never starts an image, pulls,
creates a network, runs SQL or modifies an existing release bundle. A successful
extraction establishes byte provenance, not platform or release qualification.

The fixed release candidate is `bbd78c05e726ce55f4fff1e4fd5fdec7bdd33f3b`, retaining
139 migrations and174 profile inputs. This child stacks on PR627
`2ba2839186dbadc6301d7ad84fd267d40f2cfb4c` without changing its twelve files.
Platform-manifest SHA-256 is
`5513f6b047d5519bc8b381803b3caf483070180b88b24b486a9c1f1486315a78`:
68 auth and56 storage forward SQL files. No authentic SQL bodies are fabricated
or included in the tests.

## Plan and execution

Import/default plan performs no subprocess or directory/resource creation:

```sh
node scripts/release-rehearsal/extract-platform.mjs --manifest /absolute/platform-manifest.json
```

A later **separately admitted** cached execution uses:

```sh
node scripts/release-rehearsal/extract-platform.mjs \
  --manifest /absolute/platform-manifest.json \
  --config /absolute/extraction-config.json --execute
```

Missing/invalid input fails before resource creation. No runtime is authorized by
this document. Current public-image metadata attempts failed DNS resolution;
immutable image identities/sizes, authentic archive format and SQL sizes remain
unverified. This command has no network/acquisition fallback. Never change a tag,
route, credential, image or limit to make preflight pass.

The fixed image provenance and copy locations are:

| Kind | Provenance selector | Fixed source directory |
| --- | --- | --- |
| auth | public.ecr.aws/supabase/gotrue:v2.187.0 | /usr/local/etc/auth/migrations |
| storage | public.ecr.aws/supabase/storage-api:v1.41.8 | /app/migrations/tenant |

Runtime uses only cached `sha256:` image IDs and exact repository `@sha256:`
digests. Selectors are descriptive, never resolved or pulled by this module.
Entrypoint/cmd pins are arrays of strings or null, matching image metadata exactly.
They are inspected, never executed.

## Config and controller binding

JSON requires precisely these fields (the notation below shows the object shape,
not an executable config with guessed identities):

```js
{
  schema: 'overdrafter.platform-extraction-config.v1',
  tools: { docker: { path, sha256 }, socket },
  images: {
    auth: { id, digest, entrypoint, cmd },
    storage: { id, digest, entrypoint, cmd }
  },
  parentDirectory,
  lease: { path, sha256 },
  admission: {
    schema: 'overdrafter.platform-extraction-admission.v1',
    qualification: 'authentic-platform-source-only',
    candidateCommit, baseRunnerCommit, extractorCommit, extractorSha256,
    configBindingSha256, platformManifestSha256, leaseSha256, expiresAt
  }
}
```

`socket` is an absolute local Unix socket filesystem path, not a URL. The absolute
regular Docker binary is hash-bound and rehashed before each command. Source
bytes, socket inode and lease identity are revalidated too. The controller binds
`extractorCommit` to the exact reviewed commit/tree; the module verifies its own
`extractorSha256` but cannot prove Git ancestry from a supplied commit string.

Exported `configBinding(config)` hashes canonical sorted-key JSON of
schema/tools/images/parentDirectory/lease, excluding admission. Arrays retain
order. Admission binds that hash, the manifest, lease and extractor bytes.
`candidateCommit` and `baseRunnerCommit` must equal the fixed commits above.

The controller's owner-only regular lease file has exactly:

```js
{
  schema: 'overdrafter.local-fixture-exclusive-lease.v1',
  ownerUnit: 'extraction659runtime', host: 'saved-cloud-20261008',
  socket, token, expiresAt, exclusive: true
}
```

`token` is32 lowercase hex characters. Hash the raw lease file bytes. Both
expiration times must be in the future. Expiry/abort prevents new work/publication;
cleanup may continue only for positively owned resources inside the original
fixed deadline. Identity drift blocks cleanup and requires controller reconciliation.

The lease is coordination evidence, **not a security capability or daemon lock**.
The sole controller must hold the shared fixture lane and prevent concurrent
fixture dispatch, including PR627 runtimes which do not use this new lease.
Preflight rejects **any existing container** using ID-only inventory, without
inspecting its config. Network conflicts use fixed ovd591/ovd658/ovd659 owner-label
filters and ID-only output. Images and owned containers use explicit projected
inspect templates; no `Config.Env` or complete inspect object is requested or saved.
Uncontrolled concurrent Docker clients make real admission unsuitable.

## Ownership, deadline and output contract

Auth then storage use at most one exclusively owned never-started container at a
time and zero created networks. Create uses `--pull=never`, immutable image ID,
unique persisted name/nonce labels, network none, DNS127.0.0.1,1CPU/512MiB/64PIDs,
read-only rootfs, all capabilities dropped, no-new-privileges and restart no.
No host ports/namespaces, mounts/tmpfs/anonymous volumes/devices/privileged options
are allowed. Owned inspect requires created/not-running/never-started state and
matching caps, labels, ID and image. Removal is `docker rm FULL_OWNED_ID` without
force or stop, followed by observed absence before starting storage.

Intended ownership is fsynced before create. A failed/malformed/ambiguous create
is never retried or adopted as successful extraction. A timed-out client does
not prove daemon cancellation. Even if a late positively owned container is
removed, the operation stays failed with `creation_unconfirmed` and the exclusive
lease retained. One transient absent inventory cannot clear that state. Foreign,
started or ownership-drifted resources are never forced/stopped/removed.

There is one30minute absolute monotonic deadline, with work ending60seconds before
it and a single shared cleanup reserve. Commands have a maximum30seconds including
2seconds termination/close reserve. Repeated phase/cleanup calls do not reset it.
At most64 Docker commands are allowed. Synchronous filesystem operations are
checked between steps but **cannot be hard-preempted** by a JavaScript timer;
a hung filesystem can exceed wall-clock bounds. A kill or timeout never establishes
completed cleanup. The controller must retain this operational limit explicitly.

The only copy shape is `docker --host unix:///... cp OWNED_ID:FIXED_DIRECTORY -`.
Raw stdout is capped binary memory, never an unbounded host directory copy.
Limits:32MiB per archive/64MiB aggregate,4MiB per member,32MiB aggregate selected SQL,
1MiB metadata stdout/call,256KiB stderr/call,16MiB aggregate nonarchive streams,
2MiB state/receipt,1024 headers/512 ordinary entries per archive. Partial/truncated
streams, abnormal exits, signals and unknown exit states fail even when received
bytes look valid. Inspect/error streams are represented by byte counts/hashes;
incidental raw errors or full inspect data are not persisted.

Only after all124 raw hashes and both cleanups pass, the extractor writes a
private staging tree and atomically renames it to a new `runDirectory/bundle`:

```text
bundle/
  platform-manifest.json
  extraction-receipt.json
  platform/auth/<68 exact names>
  platform/storage/<56 exact names>
```

The bundle is an input artifact for later controller composition, not a mutation
of an existing candidate or runtime bundle. Files use exclusive creation,
O_NOFOLLOW,0600 mode, byte/inode checks and fsync; directories use0700. Parent/root
inode and lease are revalidated during publication. Partial staging is retained
as failed evidence and never reported as a completed bundle. A rename followed by
fsync/state failure is `publication_unconfirmed`, with `intendedBundle` retained
for reconciliation and `publishedBundle:null`. Do not overwrite or rerun into it.

Required parent/ancestors must be trusted and owner-only where specified. Linux
path checks are **not** an openat/renameat2 no-replace capability boundary against
hostile same-UID/root actors. Symlinks/hardlinks and observed replacement fail;
TOCTOU remains possible against such an actor. Do not claim race-proof publication
or weaken filesystem permissions. This saved environment's `/tmp` is uid65534;
the current trusted-ancestor check rejects that ancestry. Tests use new private
directories beneath the owned checkout, not relaxed production checks.

## Tar subset and source proof

The parser validates complete512-byte headers, unsigned checksums, bounded octal
sizes, zero padding and two zero end blocks. It supports POSIX ustar/basic GNU
ustar ordinary files and a single root directory. Names must remain under the
fixed migrations/tenant root with direct children only. Absolute/drive/backslash,
control/NUL/dotdot paths, duplicate entries, nested directories and nonregular
objects are rejected. No archive instruction ever writes a host path.

Local PAX `x` records support only path/mtime/atime/ctime. Record decimal lengths
are exact UTF-8 byte lengths, keys unique, path validated, timestamps bounded and
discarded. Each header body<=64KiB,32records; total PAX bodies<=256KiB/archive;
values<=4KiB, paths<=512bytes. Global headers, links, GNU longname/longlink, sparse
entries, size/uid/gid/linkpath overrides, xattrs/unknown PAX keys, consecutive or
unconsumed PAX headers and unsupported formats fail. Actual Docker output may
contain an unsupported legitimate extension; retain that blocked result for exact
review, rather than silently relax the subset.

Auth selects /^\d+_.+\.up\.sql$/ lexically; storage selects /^\d+-.+\.sql$/ by
numeric ordinal. The complete selected names/order must equal the pinned manifest;
extra/missing/duplicate ordinals and raw SHA drift fail. Auxiliary ordinary files
are bounded and ignored for publication; they are not admitted migrations. SQL
bytes are never decoded or newline-normalized for hashing.

## Source verification versus runtime

Run source/mock tests under the shared fixture test lock:

```sh
flock /tmp/overdrafter-execution-tests.lock \
  node --test scripts/release-rehearsal/extract-platform.node-test.mjs
```

Tests synthesize tar/SQL bytes, exercise fake command traces and temporary owned
filesystem operations, and use only inert Node children for binary transport.
They never invoke Docker, Supabase CLI, SQL or the network. The test factory
requires explicit fake transport/clock/manifest; its results are permanently
`fake-transport-only` and JSON/CLI cannot select it. `executeBinary` is exported
for focused inert transport tests; production command construction is internal.

Two independent exact-source reviews, including Astra xhigh for this resource
boundary, precede publication. Actual Claude review remains pending. Image/cache
and archive compatibility, real extraction/cleanup, actual CLI-session evidence,
R1/R2 and historical restoration remain unrun. None is established by passing
source/mock tests or this document.
