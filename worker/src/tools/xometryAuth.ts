import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";

function resolveOutputPath() {
  const cliArg = process.argv[2];
  const envPath = process.env.XOMETRY_STORAGE_STATE_PATH;
  const fallback = path.resolve(process.cwd(), "state/xometry-storage-state.json");

  return path.resolve(cliArg || envPath || fallback);
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function main() {
  const outputPath = resolveOutputPath();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log("Xometry Playwright Auth Bootstrap");
  console.log(`Storage state output: ${outputPath}`);
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

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
