import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium as patchrightChromium } from "patchright";
import { Camoufox, launchOptions as camoufoxLaunchOptions } from "camoufox-js";
import { chromium as playwrightChromium, firefox as playwrightFirefox } from "playwright";
import { acquireXometryProfileLock } from "../adapters/persistentProfileLock.js";

type ChromiumEngineName = "patchright" | "playwright";

function resolveChromium(engine: ChromiumEngineName) {
  return (engine === "playwright" ? playwrightChromium : patchrightChromium) as unknown as typeof patchrightChromium;
}

function engineLabel(engine: ChromiumEngineName) {
  return engine === "playwright" ? "Playwright" : "Patchright";
}

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
  return process.env.XOMETRY_BROWSER_CHANNEL ?? null;
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function bootstrapPersistent(userDataDir: string, engine: ChromiumEngineName) {
  const channel = resolveChannel();
  const chromium = resolveChromium(engine);
  await ensureDir(userDataDir);
  await acquireXometryProfileLock(userDataDir, { vendor: "xometry-auth" });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log(`Xometry ${engineLabel(engine)} Auth Bootstrap (persistent context)`);
  console.log(`User data dir: ${userDataDir}`);
  console.log(`Browser channel: ${channel ?? "bundled Chromium"}`);
  console.log("");
  console.log("What to do:");
  console.log(`1. A ${channel ?? "Chromium"} window will open.`);
  console.log("2. Log in to Xometry manually.");
  console.log("3. Open the instant quoting page and confirm you are authenticated.");
  console.log("4. Return here and press Enter.");
  console.log("");

  const persistentLaunchOptions: Record<string, unknown> = {
    headless: false,
  };
  if (channel) {
    persistentLaunchOptions.channel = channel;
  }

  const context = await chromium.launchPersistentContext(
    userDataDir,
    persistentLaunchOptions as never,
  );

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
  if (channel) {
    console.log(`Export XOMETRY_BROWSER_CHANNEL="${channel}" before running the worker.`);
  }
}

async function bootstrapStorageState(outputPath: string, engine: ChromiumEngineName) {
  const chromium = resolveChromium(engine);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log(`Xometry ${engineLabel(engine)} Auth Bootstrap (storage-state fallback)`);
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

async function bootstrapCamoufox(outputPath: string) {
  const userDataDir = resolveUserDataDir();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  if (userDataDir) {
    console.log("");
    console.log("Xometry Camoufox Auth Bootstrap (Firefox-based, PERSISTENT profile)");
    console.log(`User data dir: ${userDataDir}`);
    console.log("");
    console.log("What to do:");
    console.log("1. A Camoufox (Firefox) window will open with a persistent profile.");
    console.log("2. Log in to Xometry manually.");
    console.log("3. Confirm you are authenticated (you should see your dashboard).");
    console.log("4. Return here and press Enter — the profile is auto-saved.");
    console.log("");

    await fs.mkdir(userDataDir, { recursive: true });

    const context = await Camoufox({
      headless: false,
      window: [1366, 900],
      humanize: true,
      geoip: true,
      user_data_dir: userDataDir,
    });
    const page = await context.newPage();

    await page.goto("https://www.xometry.com/quoting/home/", { waitUntil: "domcontentloaded" });

    await rl.question("Press Enter after the session is authenticated and ready...");

    const url = page.url();
    await context.close();
    rl.close();

    console.log("");
    console.log(`Camoufox persistent profile saved at: ${userDataDir}`);
    console.log(`Last page URL: ${url}`);
    console.log("");
    console.log("Next step:");
    console.log(`Export XOMETRY_USER_DATA_DIR="${userDataDir}"`);
    console.log(`Export XOMETRY_BROWSER_ENGINE=camoufox before running the worker in live mode.`);
    return;
  }

  console.log("");
  console.log("Xometry Camoufox Auth Bootstrap (Firefox-based stealth, storage-state mode)");
  console.log(`Storage state output: ${outputPath}`);
  console.log("");
  console.log("Hint: set XOMETRY_USER_DATA_DIR to use a persistent Firefox profile.");
  console.log("Storage-state alone is invalidated by Cloudflare on each fresh Camoufox");
  console.log("launch — Xometry requires persistent profile for reliable auth.");
  console.log("");
  console.log("What to do:");
  console.log("1. A Camoufox (Firefox) window will open.");
  console.log("2. Log in to Xometry manually.");
  console.log("3. Open the instant quoting page and confirm you are authenticated.");
  console.log("4. Return here and press Enter.");
  console.log("");

  await ensureParentDir(outputPath);

  const opts = await camoufoxLaunchOptions({
    headless: false,
    window: [1366, 900],
    humanize: true,
    geoip: true,
  });
  const browser = await playwrightFirefox.launch(opts);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  await page.goto("https://www.xometry.com/quoting/home/", {
    waitUntil: "domcontentloaded",
  });

  await rl.question("Press Enter after the session is authenticated and ready...");

  await context.storageState({ path: outputPath });
  const url = page.url();

  await browser.close();
  rl.close();

  console.log("");
  console.log(`Saved Xometry Camoufox storage state to: ${outputPath}`);
  console.log(`Last page URL: ${url}`);
  console.log("");
  console.log("Next step:");
  console.log(`Export XOMETRY_STORAGE_STATE_PATH="${outputPath}"`);
  console.log(`Export XOMETRY_BROWSER_ENGINE=camoufox before running the worker in live mode.`);
}

async function main() {
  const engine = process.env.XOMETRY_BROWSER_ENGINE ?? "playwright";
  const userDataDir = resolveUserDataDir();

  if (engine === "camoufox") {
    const outputPath = resolveStorageStatePath();
    await bootstrapCamoufox(outputPath);
    return;
  }

  if (engine !== "patchright" && engine !== "playwright") {
    throw new Error(`Unsupported XOMETRY_BROWSER_ENGINE: ${engine}`);
  }

  if (userDataDir) {
    await bootstrapPersistent(userDataDir, engine);
  } else {
    const outputPath = resolveStorageStatePath();
    await bootstrapStorageState(outputPath, engine);
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
