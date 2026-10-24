# OVD-517 — exact build-only approval packet

Prepared 2026-09-22 America/Phoenix (2026-09-23 UTC). This is a frozen local proposal, not permission to spend, upload, publish, deploy, or run the worker. It qualifies neither the image nor the OVD-419 production release until the proposed build and independent checks actually pass.

## Proposed approval scope

Approve only one non-overwriting upload of the exact archive below to the exact object below; one generation-pinned, 20-minute Cloud Build in `us-west1` that builds and publishes only the unique image tag below; read-only provenance and digest resolution; one digest-specific pull and one stopped, network-disabled local image inspection. No automatic retry, source substitution, alternate tag, IAM/credential repair, deployment, migration, Job execution, provider operation, or production data access. Any unknown state stops.

## Frozen source

- Repository/source: `optomachina/Overdrafter`, clean isolated worktree at full commit `7da20710b25a6a30d0f9ac59e88e00f685defc67`; repository tree `e73355333ce8165af36c29d1831f5ab571522aba`; worker tree `b9acaeae26f8cf924d9708fed0650b7fb72ad0e7`.
- Minimal archive: `worker-source.tar.gz`, 306,509 bytes, SHA-256 `378fc502865916d397c81f3ef0f34123e04cd1bd4924b64c7d489a294d1d2eb8`, MD5 base64 `NipbRTChuFyFX1+VNcmeUQ==`.
- File manifest: `source-manifest.json`, 114 Git-tracked regular files, SHA-256 `175e368362d0ba50a551ccc0b06bd206d75eff5bf8dcac6c85320ed0123af208`. It contains all six current Docker inputs: `Dockerfile`, `.dockerignore`, package and lock files, `tsconfig.json`, and `scripts/install-camoufox.mjs`; plus tsconfig-included TypeScript/JSON. It excludes tests, CAD/PDF fixtures, state, `.env`, `node_modules`, and `dist`. Selected blobs were scanned for private-key/AWS-key markers.
- Local output expectations: `expected-critical-files.json`, 107 package/dist files, SHA-256 `7d94d3e94c05c7403c21fd885c63e96e8feac01b92b3258d7df0671b61dec371`.
- Local generator: `prepare.mjs`, SHA-256 `473299e7a5d0f3f9569154763bedcfe67fd3e1e31208932b4e99d064e226f392`. The generator is retained for review, not rerun over frozen outputs.
- Local reproduction: the archive was extracted into a separate temporary directory; `npm ci --ignore-scripts --no-audit --no-fund` and `npm run build` passed; all 107 expected critical bytes/hashes matched. The current worktree's `npm --prefix worker run verify` passed. This is source reproducibility, not container qualification.

## Exact cloud inputs and destination

- Project: `overdrafter-worker-9133`; region: `us-west1`; existing Cloud Build service account: `286085665881-compute@developer.gserviceaccount.com`.
- Non-overwriting source object: `gs://overdrafter-worker-9133_cloudbuild/ovd517/build-only/20260923T003324Z-7da20710b25a/worker-source.tar.gz`. It was absent at the read-only check. Upload must use a create-only generation precondition and the archive MD5. The actual generation, size and MD5 must be read back; only then may `render-build-config.mjs` replace the deliberately invalid generation placeholder. No guessed generation.
- Build template: `cloudbuild.template.json`, SHA-256 `0435d67fde09bef956ba4f3066b51bfae3dc58dbea885321986cf025434ddff1`. One `docker build --pull --platform=linux/amd64` step, full SHA build argument and revision label, archive/manifest SHA labels, one image publication, `E2_HIGHCPU_8`, 100-GB disk, 600-second queue TTL, 1200-second build timeout, Cloud Logging only, requested verified provenance. The rendered config hash must be recorded before submit.
- Unique destination tag: `us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/overdrafter-cad-worker:ovd517-7da20710b25a-20260923t003324z`. It was absent at the read-only check. Never deploy by this tag; resolve and inspect the immutable digest.
- Build config renderer: `render-build-config.mjs`, SHA-256 `f7991c150b31155db6d63bebf16c194a5916f88f55eb69ac4ff8fe6eedcb44ea`. It rejects mismatched object name/bucket, generation, size or MD5.
- Offline image inspector: `image-inspector.cjs`, SHA-256 `d5d6267ae59746abc7f4178e593f77b4ad0ec9c55e099b41427da4ea7ee97c40`; wrapper `inspect-local-image.mjs`, SHA-256 `9919b8c0e35d695de4275d31f9f0e861f0944032986910ac2efcb35c981ec742`. The wrapper requires a single immutable registry digest, matching local image metadata and baked full SHA, then runs Node in a read-only, no-network, no-capability container with no host mounts or injected environment. It checks the complete critical-file inventory, pinned dependencies/browser executables, Camoufox/UBO metadata, required utilities, and absence of `*.mmdb` under `/app`, `/root/.cache`, and `/ms-playwright`. It never invokes the worker entrypoint or browsers.

The image is not known to exist. A successful build alone cannot check these boxes: capture build status and provenance, exact generation/source hashes, tag-to-digest resolution, registry metadata, digest pull, stopped inspection result, and the repository's `attestBuildOnly` verdict. A failed or uncertain step stops without retry.

Residual reproducibility limit: the reviewed build uses the existing `gcr.io/cloud-builders/docker:latest` builder and a version-tagged Playwright base image, not immutable upstream digests. Their resolved bytes must be treated as build-time observations in provenance and the resulting image inspection, not assumed from the source archive alone.

## Cost and retained-artifact exposure

Google's current [Cloud Build Oregon default-pool schedule](https://cloud.google.com/build/pricing-update) lists `e2-highcpu-8` at $0.0156 per build minute and SSD at $0.17 per GiB-month. The 20-minute build timeout implies about **$0.312 in machine time** plus about **$0.004 for 100 GiB of SSD for 20 minutes**, before free-tier effects. This is an estimate, not a hard billing cap: queueing, logging, Cloud Storage, network transfer, and Artifact Registry storage may add charges; the published image and source object continue to occupy storage until separately authorized cleanup. The exact image size and final cost cannot be known before build. No new infrastructure or paid retries are included.

## Local evidence and remaining gates

- `node --test inspector-test.mjs render-build-config.test.mjs`: 15/15 passed, including generation/MD5 mismatch rejection, digest-only inspection, and nested `*.mmdb` rejection.
- Build template bindings to the source archive and manifest hashes were checked. Archive listing contained no PDF/STEP/MMDB/environment/state/dependency output.
- Inspection runtime: Docker Desktop was initially stopped, then started locally; `docker --host unix:///var/run/docker.sock version` reported server 29.6.2. Recheck the daemon immediately before the later digest pull and stopped inspection. No container was run during packet preparation.
- The earlier OVD-517 packet remains the release preflight snapshot, not an execution authorization. Its five pending source migrations, Supabase-advisor WARN causality, exact private snapshot identity, global sole-owner proof, and expiring rollout/queue/execution/resource-version observations remain separate release unknowns. They do not become passing because this build package is ready.
- OVD-419 needs a separate post-build plan-only bundle, fresh pre-mutation observations, exact owner approval and single-use release authority. No release nonce was created or consumed here.

**Owner decision requested:** authorize the exact one-upload/one-build/one-digest-inspection scope above, including the bounded build cost and continuing source/image storage, or keep OVD-517 blocked. Approval for this packet does not approve any OVD-419 deployment or probe.
