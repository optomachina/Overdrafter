# Disposable Storage / HTTPS qualification probe

This adds source, not runtime acceptance. No runtime was inventoried, provisioned or contacted in this work. No credentials were inspected or created. The runner never installs, pulls, starts containers, changes TLS/global trust, changes grants, changes a deployment flag, or deletes/overwrites objects. It does not expand the repository two-container fixture contract. An ordinary full Supabase stack cannot silently replace that contract.

`qualifyNativeStorage` in `scripts/native-storage-qualification.ts` is an owner-embedded Node 24 TypeScript runner. Default `execute` is false: validates public admission metadata, returns all checks NOT_RUN, and never even reads the capabilities property. No application env files or environment credentials are loaded.

## Exact required inputs

The existing fixture owner must supply a `StorageFixtureAdmission` with its recorded owner and UUID, expiry within 30 minutes, exact HTTPS `127.0.0.1:<port>` origin, credential-free `postgresql://127.0.0.1:<port>/` attestation, existing `jarvis-fixture-*` private bucket, pinned Storage `sha256:` image digest, exact 40-character source commit, one or two exact container IDs, one internal-network ID, and the three true synthetic/exclusivity/private-bucket attestations. Credentials do not belong in this JSON or receipt. Admission is an owner attestation, not an independently measured inventory claim.

Explicit execution additionally needs existing, separately admitted ephemeral Storage authorization, a `PrivateArtifactSql` capability bound by that owner to the declared disposable database, and `persistCheckpoint(receipt)` which durably records/flushes a receipt before acknowledging it. The runner cannot inspect where a JavaScript SQL capability connects; that binding remains an owner prerequisite, never inferred from the attestation. This task does not authorize obtaining or creating these capabilities.

HTTPS must already exist within the admitted fixture. The certificate must validate for IP 127.0.0.1 using the normal trust chain or an explicitly supplied existing `existingCaPem`. Direct Node HTTPS uses `rejectUnauthorized:true`, no DNS destination, no redirect following, no proxy/env discovery and no global trust modification. An HTTP-only fixture is insufficient. This runner does not generate a certificate/key or add a third proxy container.

Plan example, after building admission JSON from the already admitted owner's public receipt:

```sh
node --experimental-strip-types --input-type=module -e '
import { readFileSync } from "node:fs";
import { qualifyNativeStorage } from "./scripts/native-storage-qualification.ts";
console.log(JSON.stringify(await qualifyNativeStorage({ admission: JSON.parse(readFileSync(process.argv[1], "utf8")) }), null, 2));
' /absolute/path/to/admission.json
```

The fixture owner's existing runner calls the same function with `execute:true` and the admitted capabilities, persists the final receipt, and performs its established cleanup. There is intentionally no CLI flag that discovers credentials, loads an arbitrary connection string or silently provisions missing runtime. CI must integrate this call inside that owner runner; the harness alone is not a self-provisioning hosted workflow.

## Implemented real probes (unrun here)

1. Real read-only SQL confirms the exact private bucket and absence of the two new random target names.
2. Two real create-only POSTs race on one new synthetic name: exactly one 2xx and one 400/409 with `ResourceAlreadyExists` are required. Requests use `x-upsert:false`.
3. SQL obtains the actual Storage UUID/version/timestamp; exact-version HTTPS GET must return the exact synthetic SHA-256.
4. Missing and deliberately invalid auth, a nonexistent random version and a version belonging to another newly created object must receive explicit 400/401/403/404 rejection. Redirects, 5xx and outages cannot pass these cases.
5. Changed-byte replay must conflict; metadata and original bytes must remain unchanged.
6. Only after those raw provider checks pass, a scoped test instance of the actual product driver exercises exact read and create-conflict behavior. Its local capability flag is not deployment qualification and changes no product setting.

Request timeout is 10 seconds, complete response cap 16 MB, total run deadline at most two minutes or admission expiry. Read-only SQL and checkpoint promises are independently bounded even if their capability ignores cancellation. The existing SQL owner remains responsible for terminating/reaping noncooperative queries; this harness makes no connection-cleanup claim.

Each receipt retains the complete public admission (owner, bucket, origins, container/network IDs and expiry) so recovery is bound to exact declared resources. `runtimeIdentity:OWNER_ATTESTED_UNVERIFIED` separates supplied identity from measured runtime proof. `admissionShape:PASS` means input validation only.

The receipt always says `overall:NOT_QUALIFIED`. Stale versions after an actual generation change, concurrent generation changes during a GET, response-loss replay, redirect/compression/partial/timeout injection, and the complete engineering artifact HTTPS route remain `NOT_RUN`. No unimplemented case is simulated into a provider pass. These gaps still prevent promoting the deployed `storageVersionIdQualified` flag based only on this receipt. Full upload registration/admission and native qualification are independent.

## Ownership, results and cleanup

Every prospective name is appended to `attemptedObjects` and a durable checkpoint must acknowledge before its first POST. Names use the admitted fixture UUID plus a fresh random UUID; the preflight collision check never deletes an existing row. HTTP/SQL errors are redacted and stop subsequent probes. Unknown POST outcomes retain `OWNER_CLEANUP_REQUIRED`; no automatic retry occurs. Creation responses are never registration acknowledgements.

The harness performs no DELETE, UPDATE, bucket creation or resource teardown. The fixture owner reconciles every checkpointed target and removes only its proven owned resources using its existing lifecycle. Crash recovery uses the durable pre-POST receipt, not the final in-memory return. `OWNER_CLEANUP_REQUIRED` is neither successful cleanup nor proof an object exists. Failed ownership or runtime admission must not be repaired by widening grants or using production endpoints.

## Source checks

```sh
npx --no-install vitest run --config scripts/native-storage-qualification-vitest.config.mjs
npx --no-install tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --lib es2023,dom,dom.iterable scripts/native-storage-qualification.ts scripts/native-storage-qualification.test.ts
```

These are inert guardrail regressions; no provider/TLS/SQL runtime pass is claimed. Provider API behavior follows the existing pinned [driver contract](native-private-runtime-drivers.md), checked against [Storage v1.79.30 GET source](https://github.com/supabase/storage/blob/76b70ba80e7c171d6b534db3c65430467a82f4bd/src/http/routes/object/getObject.ts). The Supabase changelog markdown fetch was rejected by tool content handling; no repeated download was attempted.
