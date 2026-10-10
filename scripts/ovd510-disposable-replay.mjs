/** Launch OVD570's complete rehearsal from committed, privately exported source. */
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withImmutableSource } from "./ovd510-immutable-source.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const execute = async (context) => {
  const { runReplay } = await import(pathToFileURL(join(context.root, "scripts/ovd510-replay-body.mjs")).href);
  return runReplay(context);
};
try {
  let publish;
  if (process.argv.includes("--ovd570-minimal-112") || process.argv.includes("--quote-selection-expiry") || process.argv.includes("--selection-publication-contract")) {
    publish = await withImmutableSource(repositoryRoot, execute, { cli: process.argv.includes("--ovd570-cli") });
  } else {
    // Other fixture modes retain their existing source-selection behavior.
    publish = await execute({ root: repositoryRoot });
  }
  // Publish only after final export verification and owned export cleanup finish.
  publish();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
