import { refuseOshcutPortalAutomation } from "../adapters/oshcutPortalDisabled.js";
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { EXTENDED_VENDOR_WORKFLOWS, getExtendedVendorWorkflow } from "../adapters/extendedVendorWorkflows.js";
import { GEOMIQ_ALLOWED_HOSTS } from "../adapters/geomiqProductionPortal.js";
import { OSHCUT_ALLOWED_HOSTS } from "../adapters/oshcutProductionPortal.js";
import { buildPortalWorkflowDefinition, type PortalQuoteWorkflow } from "../adapters/portalWorkflow.js";
import { isAllowedProviderUrl, type CapturedSessionStorageOrigin } from "../adapters/providerPortalKernel.js";
import { QUICKPARTS_ALLOWED_HOSTS, QUICKPARTS_PRODUCTION_SELECTORS } from "../adapters/quickpartsPortal.js";
import { WEERG_ALLOWED_HOSTS } from "../adapters/weergPortal.js";
import type { LiveAutomationVendorName } from "../types.js";
import { writePrivateStorageState } from "./privateStorageState.js";
import { enabledPortalVendors } from "./enabledPortalVendors.js";

type AuthArgs = {
  vendors: LiveAutomationVendorName[];
  explicitOutputPath: string | null;
};

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Exact hosts of each reviewed production portal definition. */
const REVIEWED_SESSION_HOSTS: Partial<Record<LiveAutomationVendorName, readonly string[]>> = {
  quickparts: QUICKPARTS_ALLOWED_HOSTS,
  geomiq: GEOMIQ_ALLOWED_HOSTS,
  weerg: WEERG_ALLOWED_HOSTS,
  oshcut: OSHCUT_ALLOWED_HOSTS,
};

/** The hosts a saved session may keep; portals without a reviewed definition use their workflow's own hosts. */
export function sessionHostsFor(workflow: PortalQuoteWorkflow): readonly string[] {
  return REVIEWED_SESSION_HOSTS[workflow.vendor] ?? buildPortalWorkflowDefinition(workflow).allowedHosts;
}

/**
 * Keeps only cookies and origins on the provider's exact hosts (OVD-1059).
 * A login page also sets third-party analytics and CAPTCHA state, and the
 * portal kernel refuses any session that holds it, so an unscoped capture
 * could never be used.
 */
export function scopeStorageStateToHosts(state: StorageState, allowedHosts: readonly string[]): StorageState {
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return {
    ...state,
    cookies: state.cookies.filter((cookie) => allowed.has(cookie.domain.trim().toLowerCase().replace(/^\./, ""))),
    origins: state.origins.filter((entry) => isAllowedProviderUrl(entry.origin, allowedHosts)
      && new URL(entry.origin).origin === entry.origin),
  };
}

/** What proves a portal session is logged in and quote-ready before it is saved (OVD-1059). */
export type LoggedInSignal = {
  /** A control only the authenticated quoting surface renders. */
  uploadSelector: string;
  /** sessionStorage keys the portal's own login writes; Quickparts keeps its bearer token there. */
  sessionStorageKeys: readonly string[];
};

export const LOGGED_IN_SIGNALS: Partial<Record<LiveAutomationVendorName, LoggedInSignal>> = {
  quickparts: { uploadSelector: QUICKPARTS_PRODUCTION_SELECTORS.cadUpload, sessionStorageKeys: ["userToken"] },
};

type PageLike = Pick<Page, "url" | "evaluate">;

/** Reads sessionStorage from every open page on an allowed exact origin. Values are never logged. */
export async function captureSessionStorage(
  pages: readonly PageLike[],
  allowedHosts: readonly string[],
): Promise<CapturedSessionStorageOrigin[]> {
  const allowedPages: { origin: string; page: PageLike }[] = [];
  for (const page of pages) {
    let origin: string;
    try {
      origin = new URL(page.url()).origin;
    } catch {
      continue;
    }
    if (isAllowedProviderUrl(origin, allowedHosts)) allowedPages.push({ origin, page });
  }
  const captures = await Promise.all(allowedPages.map(async ({ origin, page }) => {
    const entries = await page.evaluate(() => {
      const items: { name: string; value: string }[] = [];
      for (let index = 0; index < globalThis.sessionStorage.length; index += 1) {
        const name = globalThis.sessionStorage.key(index);
        if (name !== null) items.push({ name, value: globalThis.sessionStorage.getItem(name) ?? "" });
      }
      return items;
    }).catch(() => [] as { name: string; value: string }[]);
    return { origin, sessionStorage: entries };
  }));
  const byOrigin = new Map<string, CapturedSessionStorageOrigin>();
  for (const capture of captures) {
    if (capture.sessionStorage.length > 0 && !byOrigin.has(capture.origin)) byOrigin.set(capture.origin, capture);
  }
  return [...byOrigin.values()];
}

/** Throws, naming only what is missing, unless the capture carries the portal's logged-in signal. */
export function assertLoggedInCapture(
  vendor: string,
  signal: LoggedInSignal,
  uploadControlPresent: boolean,
  captured: readonly CapturedSessionStorageOrigin[],
): void {
  const keys = new Set(captured.flatMap((entry) => entry.sessionStorage
    .filter((item) => item.value.length > 0).map((item) => item.name)));
  const missingKeys = signal.sessionStorageKeys.filter((key) => !keys.has(key));
  const problems = [
    ...(uploadControlPresent ? [] : [`upload control "${signal.uploadSelector}" not found on the current page`]),
    ...(missingKeys.length === 0 ? [] : [`sessionStorage key(s) missing: ${missingKeys.join(", ")}`]),
  ];
  if (problems.length > 0) {
    throw new Error(`Refusing to save the ${vendor} session: it is not logged in and quote-ready (${problems.join("; ")}). `
      + "Finish signing in, open the quote upload page, then rerun.");
  }
}

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
    return enabledPortalVendors(EXTENDED_VENDOR_WORKFLOWS.map((workflow) => workflow.vendor), true);
  }

  const supportedVendors: LiveAutomationVendorName[] = [];
  for (const vendor of requestedVendors) {
    const workflow = getExtendedVendorWorkflow(vendor);
    if (!workflow) {
      return null;
    }

    supportedVendors.push(workflow.vendor);
  }

  return supportedVendors.length > 0 ? enabledPortalVendors(supportedVendors) : null;
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

export async function bootstrapVendor(vendor: LiveAutomationVendorName, explicitOutputPath: string | null) {
  if (vendor === "oshcut") refuseOshcutPortalAutomation();
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

    const sessionHosts = sessionHostsFor(workflow);
    const sessionStorage = await captureSessionStorage(context.pages(), sessionHosts);
    const signal = LOGGED_IN_SIGNALS[workflow.vendor];
    if (signal) {
      const uploadControlPresent = await page.locator(signal.uploadSelector).first()
        .waitFor({ state: "attached", timeout: 20_000 }).then(() => true, () => false);
      assertLoggedInCapture(workflow.displayName, signal, uploadControlPresent, sessionStorage);
    }
    await writePrivateStorageState({
      storageState: async () => ({
        ...scopeStorageStateToHosts(await context.storageState(), sessionHosts),
        ...(sessionStorage.length > 0 ? { sessionStorage } : {}),
      }),
    }, outputPath);

    console.log("");
    console.log(`Saved ${workflow.displayName} storage state to: ${outputPath}`);
    console.log(`Kept only cookies, local storage and session storage for: ${sessionHosts.join(", ")}`);
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
