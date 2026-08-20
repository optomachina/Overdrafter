import "dotenv/config";
import path from "node:path";
import process from "node:process";
import { acquireXometryProfileLock } from "../adapters/persistentProfileLock.js";
import type { WorkerConfig } from "../types.js";
import { createXometryProfileArchive } from "../xometryProfileSnapshot.js";

async function main() {
  const userDataDir = process.env.XOMETRY_USER_DATA_DIR;
  const outputPath = process.argv[2];
  const browserEngine = process.env.XOMETRY_BROWSER_ENGINE ?? "playwright";
  if (!userDataDir || !outputPath) {
    throw new Error(
      "Usage: XOMETRY_USER_DATA_DIR=/path/to/profile npm run export:xometry-profile -- /path/to/profile.tgz",
    );
  }
  if (!["playwright", "patchright", "camoufox"].includes(browserEngine)) {
    throw new Error(`Unsupported XOMETRY_BROWSER_ENGINE: ${browserEngine}`);
  }

  const resolvedProfile = path.resolve(userDataDir);
  const resolvedOutput = path.resolve(outputPath);
  await acquireXometryProfileLock(resolvedProfile, {
    waitMs: 0,
    vendor: "xometry-profile-export",
  });
  await createXometryProfileArchive({
    userDataDir: resolvedProfile,
    browserEngine: browserEngine as WorkerConfig["xometryBrowserEngine"],
    outputPath: resolvedOutput,
  });
  console.log(`Created closed-browser Xometry profile snapshot: ${resolvedOutput}`);
  console.log("Treat this archive as a credential and delete the local copy after secure seeding.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
