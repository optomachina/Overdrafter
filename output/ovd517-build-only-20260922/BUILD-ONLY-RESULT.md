# OVD-517 — approved build-only result

Observed 2026-09-23 00:39–00:48 UTC. The owner's exact build-only approval was used once. No deployment, database migration, Cloud Run Job execution, provider operation, credential change, or production worker change was performed.

## Source and build

- Full clean-source commit: `7da20710b25a6a30d0f9ac59e88e00f685defc67`. Frozen source archive SHA-256: `378fc502865916d397c81f3ef0f34123e04cd1bd4924b64c7d489a294d1d2eb8`; manifest SHA-256: `175e368362d0ba50a551ccc0b06bd206d75eff5bf8dcac6c85320ed0123af208`.
- One create-only upload succeeded to `gs://overdrafter-worker-9133_cloudbuild/ovd517/build-only/20260923T003324Z-7da20710b25a/worker-source.tar.gz#1790123963918659`. Server metadata returned size 306,509 bytes and MD5 `NipbRTChuFyFX1+VNcmeUQ==`. Generation-pinned readback SHA-256 matched the frozen archive.
- Rendered Cloud Build config SHA-256: `881e283902a93562f1d83d807ff06772673c95ee2207f60d0f199f5aeae8e864`; it bound only generation `1790123963918659`.
- Exactly one build was submitted: `4123f15f-8248-4e9e-8a91-f88714e0ae4e`, `us-west1`, start `2026-09-23T00:40:51.722005245Z`, finish `2026-09-23T00:44:52.161568Z`, status `SUCCESS`. Its one Docker build step also reported `SUCCESS`; there was no deploy step. The build result reported digest `sha256:197e36e9aabfff75ed169df0c0853d0194ce316400f30af8acd49029e5133b0e`.
- Cloud Build source provenance resolved the exact uploaded object generation and reported its SHA-256. Artifact Registry's provenance independently named that same generation/archive SHA and the resulting digest. One registry tag entry resolved `ovd517-7da20710b25a-20260923t003324z` to that digest. The digest, not the tag, is the qualified candidate.
- The digest-specific local pull succeeded. Image labels independently matched the full source SHA, archive SHA and manifest SHA.

## Stopped offline inspection

- Exact image: `us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/overdrafter-cad-worker@sha256:197e36e9aabfff75ed169df0c0853d0194ce316400f30af8acd49029e5133b0e`.
- Inspector SHA-256: `d5d6267ae59746abc7f4178e593f77b4ad0ec9c55e099b41427da4ea7ee97c40`; wrapper SHA-256: `9919b8c0e35d695de4275d31f9f0e861f0944032986910ac2efcb35c981ec742`.
- One container inspection ran with `--network=none`, read-only filesystem, no mounts, no capabilities, and Node as the substituted entrypoint. Container identity: `ovd517-inspect-1a9d3220-b702-4da8-8737-851aefc300aa`; it exited and is absent from `docker ps -a`.
- Verdict `passed`: Linux/AMD64, baked full `WORKER_BUILD_VERSION`, 107/107 critical package/dist file hashes, 105/105 dist files, pinned dependency/browser assets, Camoufox and UBO metadata, required utilities, and no `*.mmdb` in the scanned image trees. Worker and browsers were not launched.
- The repository's `attestBuildOnly` returned `build-attested` for [the exact bundle](build-only-bundle.json), whose SHA-256 is `110216a288c633c07903b317f2f7e7a7f562e2c12b42c8b38e8eb848bc6e8592`. The first local invocation passed an object instead of the required JSON string and raised a type error; a corrected local, read-only invocation passed. There was no second cloud build or second image inspection.

## Boundary

This result qualifies source-to-image evidence only. The earlier preflight snapshot is not a current pre-mutation verdict. The five pending source migrations, Supabase advisor WARN causality, exact private snapshot binding, global sole-owner proof, and all expiring rollout/queue/execution/resource-version conditions remain release gates. OVD-419 needs a separate plan-only bundle, fresh live observations, exact owner authorization and rollback readiness before any production mutation or no-upload probe. The approved build-only authority is consumed and grants no retry or deployment.
