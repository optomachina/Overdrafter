/**
 * OVD-779: deletes operator-local live-harness run directories older than the
 * 14-day retention window. Only directories named like harness run ids are
 * touched. The live harness applies the same cleanup at startup.
 *
 * Usage: node --import ./worker/node_modules/tsx/dist/esm/index.mjs scripts/cleanup-live-harness-artifacts.ts [--dry-run] [--root <dir>]
 * The root defaults to LIVE_HARNESS_ARTIFACT_ROOT or ~/overnight/artifacts.
 */
import process from "node:process";
import {
  cleanupExpiredLiveHarnessRuns,
  liveHarnessArtifactOptions,
} from "../worker/src/tools/liveHarnessArtifacts";

async function main(argv: string[]) {
  const dryRun = argv.includes("--dry-run");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : liveHarnessArtifactOptions(process.env).root;
  if (!root) throw new Error("--root requires a directory.");
  const { deleted, kept } = await cleanupExpiredLiveHarnessRuns({ root, dryRun });
  for (const runId of deleted) console.log(`${dryRun ? "would delete" : "deleted"} ${runId}`);
  console.log(`${deleted.length} expired, ${kept.length} kept${dryRun ? " (dry run)" : ""}.`);
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
