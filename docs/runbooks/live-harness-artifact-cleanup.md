# Live harness artifact cleanup (OVD-779)

The live harness writes per-run artifacts to an operator-local directory and keeps them for 14 days. It prunes expired runs at startup. Run the cleanup script by hand to prune without starting the harness.

There is no npm script for this. Run the script directly from the repo root, after `npm ci` in `worker/`:

```bash
# Preview what would be deleted
node --import ./worker/node_modules/tsx/dist/esm/index.mjs scripts/cleanup-live-harness-artifacts.ts --dry-run

# Delete expired runs
node --import ./worker/node_modules/tsx/dist/esm/index.mjs scripts/cleanup-live-harness-artifacts.ts
```

- `--root <dir>` sets the artifact root. It defaults to `LIVE_HARNESS_ARTIFACT_ROOT`, or `~/overnight/artifacts` when that is unset.
- The script only touches directories named like harness run ids and older than 14 days.
