# Storage version probe plan

This is source, not runtime acceptance. No Storage, database, credential or
deployment was contacted, inventoried or created in this work, and the script
cannot do so. `scripts/native-storage-qualification.ts` only builds and prints
the exact steps an operator runs later, by hand, against the hosted Storage
project behind the native first loop. Tests build plans from synthetic admissions
and never call a hosted service.

The plan exists because `storageVersionIdQualified` (see
[runtime drivers](native-private-runtime-drivers.md)) must stay false until the
actual provider proves it honors `versionId`. A printed plan, a source test or a
manually set flag is not that proof.

## Inputs

The operator writes an admission JSON with exactly these fields:

| Field | Rule |
| --- | --- |
| `owner` | operator label, letters, digits, `_` or `-` |
| `probeId` | a fresh UUID for this probe; it names the two synthetic objects |
| `storageOrigin` | `https://` origin only, no credentials, path, query or fragment |
| `bucket` | the existing private output bucket |
| `sourceSha` | the exact 40 character commit the plan was printed from |
| `syntheticOnly`, `existingPrivateBucket` | both `true` |

Any other field is refused, so a bearer or key pasted into the JSON never reaches
the printout. The script reads the admission from stdin and opens no file path
itself. The bearer appears only as a placeholder; the operator types it at
run time and records no copy in the plan or results.

```sh
node --experimental-strip-types scripts/native-storage-qualification.ts < admission.json
node --experimental-strip-types scripts/native-storage-qualification.ts --json < admission.json
```

## Steps in the plan

Stop at the first failed step. Every SQL statement is a read.

1. `privateBucket`: the bucket exists and is not public.
2. `emptyOwnedTarget`: neither synthetic object name exists yet. Nothing is overwritten or removed.
3. `createOnlyRace`: two concurrent `POST`s with `x-upsert: false` to one name give one 2xx and one 400 or 409 `ResourceAlreadyExists`.
4. `metadataReference`: read the object row from the private bucket and record its version as V1.
5. `exactVersionHttps`: authenticated `GET ...?versionId=V1` returns 200 and the printed SHA-256.
6. `missingAuthDenied`, `wrongAuthDenied`, `wrongVersionDenied`: each returns an explicit 400, 401, 403 or 404. A 200, redirect, 5xx or timeout fails.
7. `crossObjectVersionDenied`: create the second object, read its version V2, and a `GET` of the first object with V2 is denied.
8. `changedByteReplayPreservesOriginal`: a changed byte `POST` conflicts, the row is unchanged and V1 still returns the original bytes.

These match the request shapes in `server/engineering/native-private-storage.ts`
(`POST /storage/v1/object/...` with `x-upsert: false`, and
`GET /storage/v1/object/authenticated/...?versionId=`).

## Not covered

The plan lists these as `notCovered` and the result stays `NOT_QUALIFIED`:
stale version after a real generation change, a generation change during a read,
response loss replay, redirect, compression, partial and timeout injection, the
product driver reads through the trusted host, and the full artifact HTTPS route.
They need the trusted host launcher (unit U8 in
[the Jarvis plan](../plans/jarvis-path-to-520.md)) and are not simulated into a pass.

## Cleanup

The plan names the two objects it creates. After recording results, the operator
removes only those two from the bucket through the established lifecycle. The plan
has no delete, update or bucket change of its own.

## Source checks

```sh
npx --no-install vitest run --config scripts/native-storage-qualification-vitest.config.mjs
```

The same suite also runs in the default `npm test`, and the script is typechecked
by `tsconfig.node.json`. Running the plan against hosted Storage is a protected
action and needs Blaine's yes.
