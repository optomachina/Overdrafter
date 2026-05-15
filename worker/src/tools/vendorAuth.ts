import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { EXTENDED_VENDOR_WORKFLOWS, getExtendedVendorWorkflow } from "../adapters/extendedVendorWorkflows.js";
import type { LiveAutomationVendorName } from "../types.js";

type AuthArgs = {
  vendors: LiveAutomationVendorName[];
  explicitOutputPath: string | null;
};

function usage() {
  return [
    "Usage: npm --prefix worker run auth:vendor -- <vendor|all|vendor1,vendor2> [output-path]",
    "",
    "Vendors: oshcut, fabworks, ponoko, quickparts, rapiddirect, geomiq, weerg, protolabsnetwork",
    "",
    "The script opens the vendor login/signup page and saves Playwright storage state after you finish manually.",
  ].join("\n");
}

function parseVendors(rawVendor: string | undefined): LiveAutomationVendorName[] | null {
  if (!rawVendor) {
    return null;
  }

  const requestedVendors = rawVendor
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (requestedVendors.length === 1 && requestedVendors[0] === "all") {
    return EXTENDED_VENDOR_WORKFLOWS.map((workflow) => workflow.vendor);
  }

  const supportedVendors: LiveAutomationVendorName[] = [];
  for (const vendor of requestedVendors) {
    const workflow = getExtendedVendorWorkflow(vendor);
    if (!workflow) {
      return null;
    }

    supportedVendors.push(workflow.vendor);
  }

  return supportedVendors.length > 0 ? supportedVendors : null;
}

export function parseAuthArgs(argv: string[]): AuthArgs {
  const rawVendor = argv[0]?.trim().toLowerCase();
  if (!rawVendor || rawVendor === "--help" || rawVendor === "-h") {
    throw new Error(usage());
  }

  const vendors = parseVendors(rawVendor);
  if (!vendors) {
    throw new Error(`Unsupported vendor "${rawVendor}".\n\n${usage()}`);
  }

  const explicitOutputPath = argv[1] ? path.resolve(argv[1]) : null;
  if (explicitOutputPath && vendors.length > 1) {
    throw new Error("Explicit output-path is only supported for a single vendor session.");
  }

  return {
    vendors,
    explicitOutputPath,
  };
}

function resolveOutputPath(vendor: string, explicitOutputPath: string | null) {
  const dir = process.env.QUOTE_VENDOR_STORAGE_STATE_DIR
    ? path.resolve(process.env.QUOTE_VENDOR_STORAGE_STATE_DIR)
    : path.resolve(process.cwd(), "state/vendor-sessions");

  return path.resolve(explicitOutputPath || path.join(dir, `${vendor}-storage-state.json`));
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function bootstrapVendor(vendor: LiveAutomationVendorName, explicitOutputPath: string | null) {
  const workflow = getExtendedVendorWorkflow(vendor);
  if (!workflow) {
    throw new Error(`Unsupported vendor "${vendor}".\n\n${usage()}`);
  }

  const outputPath = resolveOutputPath(workflow.vendor, explicitOutputPath);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    console.log("");
    console.log(`${workflow.displayName} Playwright Session Bootstrap`);
    console.log(`Storage state output: ${outputPath}`);
    console.log("");
    console.log("What to do:");
    console.log("1. A Chromium window will open.");
    console.log(`2. Create or log in to the ${workflow.displayName} account manually.`);
    console.log("3. Open the quoting/upload surface and confirm it is authenticated.");
    console.log("4. Return here and press Enter.");
    console.log("");
    console.log("Do not paste shared passwords into source files or .env files.");
    console.log("");

    await ensureParentDir(outputPath);
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(workflow.loginUrl, { waitUntil: "domcontentloaded" });
    await rl.question("Press Enter after the session is authenticated and quote-ready...");

    await context.storageState({ path: outputPath });

    console.log("");
    console.log(`Saved ${workflow.displayName} storage state to: ${outputPath}`);
    console.log(`Last page URL: ${page.url()}`);
    console.log("");
    console.log("Next step:");
    console.log(`Set QUOTE_VENDOR_STORAGE_STATE_DIR="${path.dirname(outputPath)}"`);
    console.log(`Then include ${workflow.vendor} in WORKER_LIVE_ADAPTERS only when you want this hidden adapter to run.`);
  } finally {
    rl.close();
    await browser?.close();
  }
}

async function main() {
  const args = parseAuthArgs(process.argv.slice(2));

  for (const vendor of args.vendors) {
    await bootstrapVendor(vendor, args.explicitOutputPath);
  }
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsScript) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
