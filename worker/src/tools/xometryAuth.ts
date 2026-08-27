import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium as patchrightChromium } from "patchright";
import { launchOptions as camoufoxLaunchOptions } from "camoufox-js";
import {
  chromium as playwrightChromium,
  firefox as playwrightFirefox,
} from "playwright";
import { withXometryProfileInterprocessLock } from "../adapters/persistentProfileLock.js";
import { XOMETRY_LOCATORS } from "../adapters/xometryConstraints.js";
import {
  invalidateCamoufoxLaunchIdentity,
  loadCamoufoxLaunchIdentityForRecovery,
  saveCamoufoxLaunchIdentity,
} from "../camoufoxProfileIdentity.js";
import {
  launchPersistentCamoufox,
  withPersistentCamoufoxContext,
} from "../camoufoxPersistentContext.js";
import {
  requireAuthenticatedXometryColdRelaunch,
  requireAuthenticatedXometryDashboard,
  XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
} from "../xometryAuthProbe.js";
import { runVerifiedXometryCamoufoxRecovery } from "../xometryAuthRecovery.js";

type ChromiumEngineName = "patchright" | "playwright";

function parseBrowserTimeoutMs(value: string | undefined): number {
  const parsed = value === undefined ? 30_000 : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "PLAYWRIGHT_BROWSER_TIMEOUT_MS must be a positive integer.",
    );
  }
  return parsed;
}

function parseHeadless(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  throw new Error("PLAYWRIGHT_HEADLESS must be a boolean value.");
}

function resolveChromium(engine: ChromiumEngineName) {
  return (engine === "playwright"
    ? playwrightChromium
    : patchrightChromium) as unknown as typeof patchrightChromium;
}

function engineLabel(engine: ChromiumEngineName) {
  return engine === "playwright" ? "Playwright" : "Patchright";
}

function resolveStorageStatePath() {
  const cliArg = process.argv[2];
  const envPath = process.env.XOMETRY_STORAGE_STATE_PATH;
  const fallback = path.resolve(
    process.cwd(),
    "state/xometry-storage-state.json",
  );

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
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
}

async function bootstrapPersistent(
  userDataDir: string,
  engine: ChromiumEngineName,
) {
  const channel = resolveChannel();
  const chromium = resolveChromium(engine);
  return withXometryProfileInterprocessLock(
    userDataDir,
    { vendor: "xometry-auth" },
    async () => {
      await ensureDir(userDataDir);
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      console.log("");
      console.log(
        `Xometry ${engineLabel(engine)} Auth Bootstrap (persistent context)`,
      );
      console.log(`User data dir: ${userDataDir}`);
      console.log(`Browser channel: ${channel ?? "bundled Chromium"}`);
      console.log("");
      console.log("What to do:");
      console.log(`1. A ${channel ?? "Chromium"} window will open.`);
      console.log("2. Log in to Xometry manually.");
      console.log(
        "3. Open the instant quoting page and confirm you are authenticated.",
      );
      console.log("4. Return here and press Enter.");
      console.log("");

      const persistentLaunchOptions: Record<string, unknown> = {
        headless: false,
      };
      if (channel) persistentLaunchOptions.channel = channel;

      let context:
        | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
        | undefined;
      let url = "";
      try {
        context = await chromium.launchPersistentContext(
          userDataDir,
          persistentLaunchOptions as never,
        );
        const [existingPage] = context.pages();
        const page = existingPage ?? (await context.newPage());
        await page.goto("https://www.xometry.com/quoting/home/", {
          waitUntil: "domcontentloaded",
        });
        await rl.question(
          "Press Enter after the session is authenticated and ready...",
        );
        url = page.url();
      } finally {
        rl.close();
        await context?.close();
      }

      console.log("");
      console.log(`Saved Xometry persistent profile to: ${userDataDir}`);
      console.log(`Last page URL: ${url}`);
      console.log("");
      console.log("Next step:");
      console.log(
        `Export XOMETRY_USER_DATA_DIR="${userDataDir}" before running the worker in live mode.`,
      );
      if (channel) {
        console.log(
          `Export XOMETRY_BROWSER_CHANNEL="${channel}" before running the worker.`,
        );
      }
    },
  );
}

async function bootstrapStorageState(
  outputPath: string,
  engine: ChromiumEngineName,
) {
  const chromium = resolveChromium(engine);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log(
    `Xometry ${engineLabel(engine)} Auth Bootstrap (storage-state fallback)`,
  );
  console.log(`Storage state output: ${outputPath}`);
  console.log("");
  console.log(
    "Hint: set XOMETRY_USER_DATA_DIR to use a persistent Chrome profile, which is",
  );
  console.log(
    "recommended for anti-detection. Falling back to legacy storage-state mode.",
  );
  console.log("");
  console.log("What to do:");
  console.log("1. A Chromium window will open.");
  console.log("2. Log in to Xometry manually.");
  console.log(
    "3. Open the instant quoting page and confirm you are authenticated.",
  );
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

  await rl.question(
    "Press Enter after the session is authenticated and ready...",
  );

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
  console.log(
    `Export XOMETRY_STORAGE_STATE_PATH="${outputPath}" before running the worker in live mode.`,
  );
}

async function bootstrapCamoufox(outputPath: string) {
  const userDataDir = resolveUserDataDir();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  if (userDataDir) {
    try {
      return await withXometryProfileInterprocessLock(
        userDataDir,
        { vendor: "xometry-auth" },
        async () => {
          const browserTimeoutMs = parseBrowserTimeoutMs(
            process.env.PLAYWRIGHT_BROWSER_TIMEOUT_MS,
          );
          console.log("");
          console.log(
            "Xometry Camoufox Auth Bootstrap (Firefox-based, PERSISTENT profile)",
          );
          console.log(`User data dir: ${userDataDir}`);
          console.log("");
          console.log("What to do:");
          console.log(
            "1. A Camoufox (Firefox) window will open with a persistent profile.",
          );
          console.log("2. Log in to Xometry manually.");
          console.log(
            "3. Confirm you are authenticated (you should see your dashboard).",
          );
          console.log(
            "4. Return here and press Enter — the profile is auto-saved.",
          );
          console.log("");

          await ensureDir(userDataDir);
          const verified = await runVerifiedXometryCamoufoxRecovery({
            loadRecoveryIdentity: async () =>
              (await loadCamoufoxLaunchIdentityForRecovery(userDataDir))
                ?.config ?? null,
            invalidateIdentity: () =>
              invalidateCamoufoxLaunchIdentity(userDataDir),
            runInteractiveVerification: (identityConfig) =>
              withPersistentCamoufoxContext(
                {
                  userDataDir,
                  headless: false,
                  identityConfig: identityConfig ?? undefined,
                },
                async ({ context, identityConfig: generatedIdentity }) => {
                  const page = await context.newPage();
                  await page.goto("https://www.xometry.com/quoting/home/", {
                    waitUntil: "domcontentloaded",
                  });
                  await rl.question(
                    "Press Enter after the session is authenticated and ready...",
                  );
                  await page
                    .waitForLoadState("networkidle")
                    .catch(() => undefined);
                  const bodyText = await page.locator("body").innerText();
                  const dashboardUploadButtonVisible = await Promise.any(
                    XOMETRY_LOCATORS.dashboardUploadButtons.map(
                      async (selector) => {
                        if (await page.locator(selector).first().isVisible()) {
                          return true;
                        }
                        throw new Error("not visible");
                      },
                    ),
                  ).catch(() => false);
                  requireAuthenticatedXometryDashboard({
                    url: page.url(),
                    bodyText,
                    dashboardUploadButtonVisible,
                  });
                  return {
                    url: page.url(),
                    identity: generatedIdentity,
                  };
                },
              ),
            runColdRelaunchProof: (identityConfig) =>
              requireAuthenticatedXometryColdRelaunch({
                operationTimeoutMs: browserTimeoutMs * 2,
                launchContext: async () => {
                  const launched = await launchPersistentCamoufox({
                    userDataDir,
                    headless: parseHeadless(process.env.PLAYWRIGHT_HEADLESS),
                    identityConfig,
                    launchOverrides: XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
                  });
                  launched.context.setDefaultTimeout(browserTimeoutMs);
                  launched.context.setDefaultNavigationTimeout(
                    browserTimeoutMs,
                  );
                  return launched.context;
                },
              }),
            promoteIdentity: (identityConfig) =>
              saveCamoufoxLaunchIdentity(userDataDir, identityConfig),
          });
          console.log(
            `Cold-relaunch authentication: ${verified.coldEvidence.reason}`,
          );
          const url = verified.coldEvidence.url;

          console.log("");
          console.log(
            `Camoufox persistent profile verified and saved at: ${userDataDir}`,
          );
          console.log(`Last page URL: ${url}`);
          console.log("");
          console.log("Next step:");
          console.log(`Export XOMETRY_USER_DATA_DIR="${userDataDir}"`);
          console.log(
            `Export XOMETRY_BROWSER_ENGINE=camoufox before running the worker in live mode.`,
          );
        },
      );
    } finally {
      rl.close();
    }
  }

  console.log("");
  console.log(
    "Xometry Camoufox Auth Bootstrap (Firefox-based stealth, storage-state mode)",
  );
  console.log(`Storage state output: ${outputPath}`);
  console.log("");
  console.log(
    "Hint: set XOMETRY_USER_DATA_DIR to use a persistent Firefox profile.",
  );
  console.log(
    "Storage-state alone is invalidated by Cloudflare on each fresh Camoufox",
  );
  console.log(
    "launch — Xometry requires persistent profile for reliable auth.",
  );
  console.log("");
  console.log("What to do:");
  console.log("1. A Camoufox (Firefox) window will open.");
  console.log("2. Log in to Xometry manually.");
  console.log(
    "3. Open the instant quoting page and confirm you are authenticated.",
  );
  console.log("4. Return here and press Enter.");
  console.log("");

  await ensureParentDir(outputPath);

  const opts = await camoufoxLaunchOptions({
    headless: false,
    window: [1366, 900],
    humanize: true,
    geoip: false,
  });
  const browser = await playwrightFirefox.launch(opts);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  await page.goto("https://www.xometry.com/quoting/home/", {
    waitUntil: "domcontentloaded",
  });

  await rl.question(
    "Press Enter after the session is authenticated and ready...",
  );

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
  console.log(
    `Export XOMETRY_BROWSER_ENGINE=camoufox before running the worker in live mode.`,
  );
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
