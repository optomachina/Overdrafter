# Private artifact runtime driver source contract

This is SOURCE qualification only. No database connection, live Storage write, real credential access, listener deployment or native action was performed. The synthetic Node tests bind only disposable IPv4 loopback listeners and inject fake SQL/provider responses; those tests do not qualify PostgreSQL locks or Storage behavior.

## Concrete composition

`createNativeArtifactRoute` in `server/engineering/native-artifact-route.ts` mounts exactly `/functions/v1/engineering-worker-artifact` on an existing trusted Node server. It bridges IncomingMessage byte streams into the existing artifact Request handler and streams its Response to ServerResponse. Duplicate headers, GET bodies, nonexact paths and invalid authentication fail closed. It never uses Host or forwarded headers as authority. The deploying operator must terminate HTTPS at the trusted server/proxy and preserve exact method/path/headers. The factory does not call listen.

The route supplies `createNativePrivateSql` and `createNativePrivateStorage` to the existing request-scoped `createPrivateNativeArtifactHandler`. Trusted configuration supplies an already configured dedicated owner pool, HTTPS public/Storage origins and Storage authorization. There are no environment reads, credentials discovered by default, installs, role changes, public RPC fallbacks or auto-retries. Neither an arbitrary SQL query nor a bucket/path/authorization field comes from a worker request.

The SQL driver owns an idle pool lease and READ COMMITTED transaction, requires synchronous commit, bounds all waits to at most 30 seconds, sets statement/lock timeouts, snapshots arguments, rejects nested/concurrent lease use and disables retained leases. Only an acknowledged commit permits ordinary pool release. Cancellation, lost commit acknowledgements or failed callbacks destroy the connection. They do not certify rollback. Any dispatched operation may have written; callers must reconcile explicitly, not infer that no write happened.

## Storage generation correction

The old interface comment incorrectly equated `storage.objects.version` with an HTTP ETag. That field remains a compatibility assertion in `operation.ifMatch`; the concrete driver never sends it as an If-Match header.

The reviewed primary source is Supabase Storage **v1.79.30**, commit **76b70ba80e7c171d6b534db3c65430467a82f4bd**:

- [Authenticated GET source](https://github.com/supabase/storage/blob/76b70ba80e7c171d6b534db3c65430467a82f4bd/src/http/routes/object/getObject.ts) passes `versionId` to the object lookup and renders that object's backend version.
- [REST asset renderer](https://github.com/supabase/storage/blob/76b70ba80e7c171d6b534db3c65430467a82f4bd/src/storage/renderer/asset.ts) does not forward If-Match. The [release](https://github.com/supabase/storage/releases/tag/v1.79.30) fixes that header for S3 separately.
- [Create source](https://github.com/supabase/storage/blob/76b70ba80e7c171d6b534db3c65430467a82f4bd/src/http/routes/object/createObject.ts) implements POST and `x-upsert` (true only for the exact string `true`). [Upload docs](https://supabase.com/docs/guides/storage/uploads/standard-uploads) describe create-only concurrency and existing-path failure.
- [Error codes](https://github.com/supabase/storage/blob/76b70ba80e7c171d6b534db3c65430467a82f4bd/src/internal/errors/codes.ts) define `ResourceAlreadyExists`. Only an explicit 400/409 with that JSON code is a conflict; other failures stay unknown/unavailable.

Changelog index retrieval was attempted but blocked by web content handling and sandbox proxy. The release and exact relevant source were checked. This source version is a reference, not evidence of the deployment's installed version.

GET uses `/storage/v1/object/authenticated/{bucket}/{encoded segments}?versionId={database version}` with no redirects, encoding, CDN cache fallback or alternate generation. It reads the complete bounded body, then repeats the exact object UUID/bucket/name/version/timestamp/private-bucket SQL predicate before releasing bytes. Upper artifact/result layers independently verify their admitted byte count/SHA-256. POST uses `x-upsert:false`; no update/delete/overwrite operation exists. Unknown write outcomes leave recovery to exact immutable replay.

The driver requires both `enabled:true` and `versionIdQualified:true` (route spelling `storageVersionIdQualified:true`). These are trusted deployment configuration, never a worker claim or substitutes for qualification. Without either, no SQL or Storage read/write occurs in the driver. A provider that ignores versionId cannot be qualified merely because a same-generation sample succeeds. The pinned release and stale/wrong-version negative cases below must pass before this flag is set.

## Exact runtime acceptance prerequisites

No new migration is needed for these drivers. Existing artifact mapping/registry migrations and the separately supplied trusted mapping writer must be installed by the authorized fixture/release owner. `NATIVE_STORAGE_IDENTITY_SQL` additionally needs read access to the existing `storage.objects` and private `storage.buckets` rows. Do not add service-role substitutes or grants just to make these tests pass.

The Mac PostgreSQL fixture can qualify the SQL driver independently using an existing installed pg-compatible owner pool: READ COMMITTED observed inside callback; two statements on one lease; snapshot isolation never silently substituted; commit acknowledgement; rollback/disconnect state; independent session blocking locks; statement/lock timeout; acquisition/query/commit cancellation and late completion; no connection reuse or automatic retry after unknown commit. The schema/auth/locking tests from the mapping and artifact packets remain independently necessary.

A separately authorized disposable Storage fixture must pin its exact image/release/digest and use synthetic files only. Required cases:

1. Correct private row and exact version GET returns exact bytes; nonexistent/wrong/stale version returns non-200, never silently latest.
2. A provider returning 200 after the SQL row's version/timestamp changes is rejected before bytes are released. Same SQL generation with wrong bytes is rejected by the composed handler's SHA check.
3. The authenticated endpoint rejects missing/wrong auth; public bucket rows fail the SQL check; no signed/public fallback exists.
4. Concurrent create-only POSTs to one deterministic target yield one winner and explicit conflict. The original bytes/version remain unchanged, including changed-byte replay.
5. Response loss after successful creation does not cause a second create/update; explicit replay uses the existing object and exact measured registration path.
6. Redirect, compression, partial response, over-limit body, hanging body, expired request and caller disconnect produce unavailable status and no successor operation.
7. Actual GET and PUT through the deployed HTTPS proxy preserve the exact route/header/body contract. Disabled returns 503 `transfer_disabled` with no capability calls; malformed/unauthorized input is denied; successful upload returns delivery acknowledgement only.

Default-off remains intact until those operator checks and the existing admission/independent-stop/native qualification gates are satisfied.
