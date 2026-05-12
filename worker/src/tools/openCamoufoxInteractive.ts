/**
 * Interactive Camoufox window opener for Xometry — dev tool, not used by the
 * worker runtime. Opens a non-headless Camoufox session pointed at Xometry's
 * quoting home, logs URL changes to stdout, and stays alive until killed.
 *
 * Use when probing Xometry's UI flow without going through the auth bootstrap
 * (which requires Enter on stdin and so can't run in background).
 *
 * Persistent profile (recommended): set XOMETRY_USER_DATA_DIR.
 * Storage-state fallback: set XOMETRY_STORAGE_STATE_PATH.
 *
 * Example:
 *   XOMETRY_USER_DATA_DIR=$PWD/worker/state/xometry-camoufox-user-data \
 *     ./worker/node_modules/.bin/tsx worker/src/tools/openCamoufoxInteractive.ts
 */
import "dotenv/config";
import fs from "node:fs/promises";
import process from "node:process";
import { Camoufox, launchOptions } from "camoufox-js";
import { firefox } from "playwright";
import type { Browser, BrowserContext } from "playwright";

const userDataDir = process.env.XOMETRY_USER_DATA_DIR;
const storageStatePath = process.env.XOMETRY_STORAGE_STATE_PATH;

let browser: Browser | null = null;
let context: BrowserContext;

if (userDataDir) {
  await fs.mkdir(userDataDir, { recursive: true });
  console.log("[mode] Camoufox PERSISTENT profile");
  console.log("[user_data_dir]", userDataDir);
  context = (await Camoufox({
    headless: false,
    window: [1366, 900],
    humanize: true,
    geoip: true,
    user_data_dir: userDataDir,
  })) as unknown as BrowserContext;
} else {
  console.log("[mode] Camoufox storage-state");
  console.log("[storage_state]", storageStatePath ?? "(none)");
  const opts = await launchOptions({
    headless: false,
    window: [1366, 900],
    humanize: true,
    geoip: true,
  });
  browser = await firefox.launch(opts);
  context = await browser.newContext({
    storageState: storageStatePath ?? undefined,
    viewport: { width: 1366, height: 900 },
  });
}

const page = await context.newPage();
await page.goto("https://www.xometry.com/quoting/home/", { waitUntil: "domcontentloaded" });

console.log("Camoufox window open at:", page.url());
console.log("Log in if needed. The profile auto-saves. Kill this process when done.");

page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) {
    console.log("[nav]", new Date().toISOString(), frame.url());
  }
});

// Cleanly close the context/browser on SIGTERM so the persistent profile is
// flushed to disk before exit.
async function cleanupAndExit() {
  try {
    await context.close();
  } catch {
    // ignore
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

process.on("SIGTERM", cleanupAndExit);
process.on("SIGINT", cleanupAndExit);

await new Promise(() => {});
