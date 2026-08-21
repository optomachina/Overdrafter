import "dotenv/config";
import fs from "node:fs/promises";
import process from "node:process";
import { chromium, type BrowserContext } from "playwright";
import { acquireXometryProfileLock } from "../adapters/persistentProfileLock.js";
import { XOMETRY_LOCATORS, XOMETRY_URLS } from "../adapters/xometryConstraints.js";
import { loadCamoufoxLaunchIdentity } from "../camoufoxProfileIdentity.js";
import { launchPersistentCamoufox } from "../camoufoxPersistentContext.js";
import { loadConfig } from "../config.js";
import {
  restoreXometryProfileSnapshot,
  withXometryProfileSnapshotLock,
} from "../xometryProfileSnapshot.js";
import {
  buildXometryAuthProbeEvidence,
  isReadOnlyProbeRequest,
  isSupportedXometryAuthProbeEngine,
  XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
} from "../xometryAuthProbe.js";

async function main() {
  const config = loadConfig({
    ...process.env,
    // The probe does not access Supabase. These schema-only placeholders keep
    // the Cloud Run job free of the production database credential.
    SUPABASE_URL: process.env.SUPABASE_URL ?? "https://probe.invalid",
    SUPABASE_SERVICE_ROLE_KEY:
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "not-used-by-auth-probe",
  });
  if (!isSupportedXometryAuthProbeEngine(config.xometryBrowserEngine)) {
    throw new Error(
      "The production authentication probe requires XOMETRY_BROWSER_ENGINE=playwright or camoufox.",
    );
  }
  if (!config.xometryProfileSnapshotBucket || !config.xometryProfileSnapshotObject) {
    throw new Error("The production authentication probe requires snapshot mode.");
  }

  const evidence = await withXometryProfileSnapshotLock(async () => {
    const restored = await restoreXometryProfileSnapshot(config);
    if (!restored.xometryUserDataDir || !restored.xometryProfileSnapshotGeneration) {
      throw new Error("The profile snapshot was not restored with generation ownership.");
    }
    if (!isSupportedXometryAuthProbeEngine(restored.xometryBrowserEngine)) {
      throw new Error("The restored profile uses an unsupported authentication probe engine.");
    }

    await fs.mkdir(restored.xometryUserDataDir, { recursive: true });
    let context: BrowserContext;
    if (restored.xometryBrowserEngine === "camoufox") {
      const identity = await loadCamoufoxLaunchIdentity(restored.xometryUserDataDir, {
        required: true,
      });
      ({ context } = await launchPersistentCamoufox({
        userDataDir: restored.xometryUserDataDir,
        headless: restored.playwrightHeadless,
        identityConfig: identity.config,
        launchOverrides: XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
      }));
    } else {
      await acquireXometryProfileLock(restored.xometryUserDataDir, {
        waitMs: restored.xometryProfileLockWaitMs,
        vendor: "xometry-auth-probe",
      });

      const launchArgs: string[] = [];
      if (restored.playwrightDisableSandbox) {
        launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
      }
      if (restored.playwrightDisableDevShmUsage) {
        launchArgs.push("--disable-dev-shm-usage");
      }

      context = await chromium.launchPersistentContext(restored.xometryUserDataDir, {
        headless: restored.playwrightHeadless,
        args: launchArgs,
        channel: restored.xometryBrowserChannel ?? undefined,
        serviceWorkers: "block",
      });
    }
    context.setDefaultTimeout(restored.browserTimeoutMs);
    context.setDefaultNavigationTimeout(restored.browserTimeoutMs);

    const blockedMethods = new Set<string>();
    await context.route("**/*", async (route) => {
      const method = route.request().method().toUpperCase();
      if (
        isReadOnlyProbeRequest({
          method,
          url: route.request().url(),
          postData: route.request().postData(),
        })
      ) {
        await route.continue();
        return;
      }
      blockedMethods.add(method);
      await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (webSocketRoute) => {
      webSocketRoute.close();
    });

    try {
      const page = await context.newPage();
      await page.goto(XOMETRY_URLS.quoteHome, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const bodyText = await page.locator("body").innerText();
      const dashboardUploadButtonVisible = await Promise.any(
        XOMETRY_LOCATORS.dashboardUploadButtons.map(async (selector) => {
          if (await page.locator(selector).first().isVisible()) return true;
          throw new Error("not visible");
        }),
      ).catch(() => false);
      const evidence = buildXometryAuthProbeEvidence({
        url: page.url(),
        bodyText,
        dashboardUploadButtonVisible,
        snapshotGeneration: restored.xometryProfileSnapshotGeneration,
        browserEngine: restored.xometryBrowserEngine,
        blockedNonReadMethods: blockedMethods,
      });
      if (!evidence.authenticated) {
        throw new Error(JSON.stringify(evidence));
      }

      return evidence;
    } finally {
      await context.close();
    }
  });

  console.log(JSON.stringify(evidence));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
