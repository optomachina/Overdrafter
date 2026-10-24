## Linear issue ID
- Issue: [OVD-842](https://linear.app/overdrafter/issue/OVD-842/create-the-verify-overdrafter-verification-skill) (child of OVD-840). Main PR for the issue; not a release-outcome parent.

## Summary
Adds the `verify-overdrafter` verification skill, generated with pstack `create-verification-skill`. It is structured as Launch / Doctor / Drive / Evidence / Cleanup, plus a feature map for the auth, quote and provider journeys. It drives the real app through Playwright in `fixture` mode (no DB) or `local` mode (local Supabase), and writes evidence to `artifacts/verify-overdrafter/<stamp>/`. That output is what the OVD-843 CI run builds on.

## Files changed
- `.agents/skills/verify-overdrafter/` contains SKILL.md, `features/{README,auth,quote,provider}.md`, `scripts/verify.sh` (`--mode`, `--features`, `--prepare`, `--doctor`, `--dry-run`) and `scripts/feature-specs.mjs`, which maps each feature to its e2e specs.
- `scripts/verify-overdrafter-skill.test.mjs` is a structure test: every feature, script and e2e spec the skill references must exist.
- `.gitignore` ignores the evidence dir. `.agents/` is gitignored, so the skill is force-added the same way the existing skills are.
- `AGENTS.md` adds the skill to the routing list. This is a governance file.

## Scope
Out of scope: the CI workflow (OVD-843), evals (OVD-860) and the weekly maintenance run (OVD-858). There are no workflow, migration or app code changes.

## Verification
- `bash scripts/preflight.sh lint`: PASS
- `bash scripts/preflight.sh typecheck`: PASS
- `npx vitest run --maxWorkers=2`: the only failures are the known OVD-417 docker ones (`qualify-ovd417-four-migration-suffix`). On the first pass, other files also failed because `worker/node_modules` was missing. After `npm ci` in `worker/`, I re-ran those 39 files and all passed (845 tests).
- `npx vitest run scripts/verify-overdrafter-skill.test.mjs`: 4/4 passed.
- `verify.sh --mode fixture --features quote` passed 12/12 and wrote an evidence dir. `--doctor` and `--dry-run` also work.
- Not run: `local` mode, which needs Docker and local Supabase.

## Migration notes
- [x] No migration impact

## Rollback / risk notes
This only adds docs and a script. To roll back, revert the PR.
