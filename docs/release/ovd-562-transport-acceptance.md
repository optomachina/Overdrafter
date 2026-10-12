# OVD-562 source transport acceptance

This is a source qualification checklist, not activation authority. It covers
the artifact transport seam in `server/engineering/native-artifact-transport.ts`
and how its registration step is bound to the admitted transfer. No worker,
paired store, hosted service, credential, existing SolidWorks instance or CAD
file is changed by this source work, and the handler opens no listener and makes
no network call. The stalled quoting and release task is independent.

This checklist was hand ported from carve 7 of the preserved checkpoint in #565
(commit `bae69fbf09a05b83bf60fd46c40985c86a83849b`). It lists only suites that
exist on `main`. Suites for later carves of #565 (first loop runtime, prepared
Jev adapter, stop workflow, durable finalization, companion output replay) are
added by those carves and are not claimed here.

## Transfer binding rules

Every transfer runs under one `TransferBudget`: a single abort signal, a
30 second deadline and a `check` that is rechecked before dispatch and after
every settlement. Registration reads draw on the same budget and never receive
a fresh deadline.

1. Authorization runs before any object read or write and again after the bytes
   are measured and again after the immutable write. A changed admission, a
   revoked token or a different scope refuses the transfer.
2. The scope handed to `putImmutableOutput` is a clone. An adapter that mutates
   its argument cannot change the scope used by the registration step.
3. The registration repository is wrapped by `transferRegistration`. Its
   `loadAdmission` result must match the admitted task, attempt, organization,
   project, fence, input snapshot, candidate snapshot and role, otherwise the
   transfer fails before Storage is read.
4. Its `registerMeasuredObject` call must carry the declared byte count and
   SHA-256 of the admitted transfer. A different count or digest is refused
   before the owner-only SQL function is called.
5. The measured stream is cut off at the declared byte count. Bytes beyond the
   declared count are refused before any write or registration.
6. Upload returns delivery status only. It never returns a verification result
   or a candidate finalization receipt.

## Repeatable source checks

Use the existing toolchain only. Record the Git HEAD, the exact command and the
direct exit code. Missing tools, skipped checks and stale evidence are not
passes.

```sh
npm run preflight
./node_modules/.bin/vitest run \
  server/engineering/native-artifact-transport.test.ts \
  server/engineering/native-artifact-runtime.test.ts \
  server/engineering/native-artifact-route.test.ts \
  server/engineering/native-artifact-mapping.test.ts \
  server/engineering/native-private-sql.test.ts \
  server/engineering/native-private-storage.test.ts \
  server/engineering/native-result-registration.test.ts \
  server/engineering/native-result-bytes.test.ts \
  server/engineering/native-result-receipt.test.ts \
  server/engineering/native-stop-transport.test.ts \
  server/engineering/native-stop-admission.test.ts
```

The tests use synthetic injected adapters, fake timers and a clock spy. They use
no real endpoint, credential, provider, database or Storage.

## What the tests prove

| Claim | Test in `native-artifact-transport.test.ts` |
| --- | --- |
| A registration admission for another organization, project, snapshot or fence is refused before Storage is read | "rejects registration admission with another %s before reading Storage" |
| A registration admission for another task or attempt is refused before Storage is read | "rejects registration admission for another %s before reading Storage" |
| A registration admission for another role is refused | "rejects registration admission for another role before reading Storage" |
| Changed stored bytes, same length or different length, never reach SQL registration | "rejects %s changed stored bytes before SQL registration" |
| An output adapter cannot mutate the admitted scope used for registration | "isolates admitted scope from mutation by the immutable output adapter" |
| A stream larger than the declared bytes is refused before write or registration | "never reads or stores more than the declared transfer budget of bytes" |
| Elapsed time is enforced at each stage, including registry reads | the existing budget tests ("keeps the transfer budget through registry %s" and the elapsed time cases) |

## Not claimed

PostgreSQL, Storage precondition support, TLS, real caller identity and Windows
remain separate authorization and evidence gates. Source and inert passes are
not native qualification. Do not apply staged SQL or provision a runtime from
this packet.
