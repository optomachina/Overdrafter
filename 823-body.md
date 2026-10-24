Closes OVD-874 (parent OVD-870). https://linear.app/optomachina/issue/OVD-874

Model: opus per Release

**Scope: the adapter import lint only, as Blaine asked.** The `CertifiedProviderId` branded type, `certify()` and the dispatch signature changes from the design are **not** in this PR.

## What changed
- `eslint.config.js` adds `no-restricted-imports` at **warn** (report mode). It blocks importing `worker/src/adapters/*` from anywhere except an explicit allowlist: the dispatch entry (`worker/src/index.ts`), the adapters' own files and tests, `worker/src/tools/`, and `recovery/comparison.ts`. Type-only imports are allowed. There is no behavior change, and the lint is clean today. With the allowlist removed, the rule flags 34 files, which confirms it matches the real imports.
- It also adds `no-restricted-syntax` at warn, banning `as CertifiedProviderId` casts. The type doesn't exist yet, so the rule is harmless for now.
- `scripts/eslint-adapter-import-boundary.test.mjs` has 6 vitest tests that run ESLint's Node API with the repo config. They check that a route-file adapter import is flagged, a dispatch import isn't, a type-only import isn't, and a cast is flagged.
- **Worth review:** `recovery/comparison.ts` and `tools/vendorWorkflowSmoke.ts` call the adapter registry outside dispatch, though off the request path. Both are allowlisted for now; they could be treated as offenders before switching to error.
- No `.github/` changes, no deps, no migrations. This touches a sensitive path (provider dispatch), so merging needs Blaine's OK.

## Checks
- `bash scripts/preflight.sh lint`: PASS. `bash scripts/preflight.sh typecheck`: PASS.
- `npx vitest run --maxWorkers=2`: 11,812 pass. The 3 failures are the expected OVD-417 docker-only ones.

## Card drafts (not in this PR)
1. After 1 week, switch both rules from `warn` to `error`.
2. Follow-up issue for the `CertifiedProviderId` branded type and `certify()`, which were left out of scope here.
