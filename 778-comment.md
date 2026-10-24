QA: FAIL on 56342b5f35776c43ed2ce0f250fceb9973d94c7b
- Docs check: the PR adds docs/runbooks/live-harness-artifact-cleanup.md and also changes scripts/cleanup-live-harness-artifacts.ts. That .ts change is only the usage comment. The script path exists, and tsx is a dependency in worker/package.json. Running the documented command with `--dry-run` works ("0 expired, 0 kept (dry run)."). The flags match the script, and it's true there is no npm script for this.
- FAIL: the CI `test` job is red. `supabase start` timed out on storage (127.0.0.1:54321) after migrations, which looks like an infra flake unrelated to the diff. A rerun is needed before this can pass. SonarCloud and the other checks are green.
CI: https://github.com/optomachina/Overdrafter/actions/runs/38838995171/job/116774806443
