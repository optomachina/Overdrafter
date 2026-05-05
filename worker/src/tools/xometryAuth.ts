import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "patchright";

function resolveStorageStatePath() {
  const cliArg = process.argv[2];
  const envPath = process.env.XOMETRY_STORAGE_STATE_PATH;
  const fallback = path.resolve(process.cwd(), "state/xometry-storage-state.json");

  return path.resolve(cliArg || envPath || fallback);
}

function resolveUserDataDir() {
  const envPath = process.env.XOMETRY_USER_DATA_DIR;
  if (!envPath) return null;
  return path.resolve(envPath);
}

function resolveChannel() {
  return process.env.XOMETRY_BROWSER_CHANNEL ?? "chrome";
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function bootstrapPersistent(userDataDir: string) {
  const channel = resolveChannel();
  await ensureDir(userDataDir);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log("Xometry Patchright Auth Bootstrap (persistent context)");
  console.log(`User data dir: ${userDataDir}`);
  console.log(`Browser channel: ${channel}`);
  console.log("");
  console.log("What to do:");
  console.log(`1. A ${channel} window will open.`);
  console.log("2. Log in to Xometry manually.");
  console.log("3. Open the instant quoting page and confirm you are authenticated.");
  console.log("4. Return here and press Enter.");
  console.log("");

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel,
  });

  const [existingPage] = context.pages();
  const page = existingPage ?? (await context.newPage());

  await page.goto("https://www.xometry.com/quoting/home/", {
    waitUntil: "domcontentloaded",
  });

  await rl.question("Press Enter after the session is authenticated and ready...");

  const url = page.url();

  await context.close();
  rl.close();

  console.log("");
  console.log(`Saved Xometry persistent profile to: ${userDataDir}`);
  console.log(`Last page URL: ${url}`);
  console.log("");
  console.log("Next step:");
  console.log(`Export XOMETRY_USER_DATA_DIR="${userDataDir}" before running the worker in live mode.`);
  console.log(`(Optional) Export XOMETRY_BROWSER_CHANNEL="${channel}" to override the browser channel.`);
}

async function bootstrapStorageState(outputPath: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log("Xometry Patchright Auth Bootstrap (storage-state fallback)");
  console.log(`Storage state output: ${outputPath}`);
  console.log("");
  console.log("Hint: set XOMETRY_USER_DATA_DIR to use a persistent Chrome profile, which is");
  console.log("recommended for anti-detection. Falling back to legacy storage-state mode.");
  console.log("");
  console.log("What to do:");
  console.log("1. A Chromium window will open.");
  console.log("2. Log in to Xometry manually.");
  console.log("3. Open the instant quoting page and confirm you are authenticated.");
  console.log("4. Return here and press Enter.");
  console.log("");

  await ensureParentDir(outputPath);

  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.xometry.com/quoting/home/", {
    waitUntil: "domcontentloaded",
  });

  await rl.question("Press Enter after the session is authenticated and ready...");

  await context.storageState({
    path: outputPath,
  });

  const url = page.url();

  await browser.close();
  rl.close();

  console.log("");
  console.log(`Saved Xometry storage state to: ${outputPath}`);
  console.log(`Last page URL: ${url}`);
  console.log("");
  console.log("Next step:");
  console.log(`Export XOMETRY_STORAGE_STATE_PATH="${outputPath}" before running the worker in live mode.`);
}

async function main() {
  const userDataDir = resolveUserDataDir();

  if (userDataDir) {
    await bootstrapPersistent(userDataDir);
  } else {
    const outputPath = resolveStorageStatePath();
    await bootstrapStorageState(outputPath);
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
